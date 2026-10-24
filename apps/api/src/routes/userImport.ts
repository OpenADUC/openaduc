// SPDX-License-Identifier: BUSL-1.1
import {
  IMPORT_JOB_ACTION,
  bulkJobResponseSchema,
  importJobResponseSchema,
  importLookupRequestSchema,
  importRequestSchema,
  importRunRequestSchema,
  isDnWithin,
  parseDn,
  placementRulesSaveSchema,
  type CheckedImportRequest,
  type ImportCheckResponse,
  type ImportJobResponse,
  type ImportLookupResponse,
  type PlacementRulesResponse,
  type PlacementRulesSaveResponse,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { findCachedGroupsById } from '../services/groupCache.js';
import { BulkJobRequestError, refuseBulkRequest } from '../services/bulkJobs/errors.js';
import { importJobView } from '../services/importResults.js';
import {
  checkImport,
  importPlan,
  loadPlacementRules,
  savePlacementRules,
} from '../services/userImport.js';
import { actorFrom, requireFor } from '../services/bulkJobs/requestContext.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const describeCheck = (problems: ImportCheckResponse['problems']) =>
  `The import has changed since the final check, or the directory has: ${problems
    .slice(0, 3)
    .map((p) => p.message)
    .join(
      ' ',
    )}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''} Run the final check again.`;

const lower = (v: string) => v.toLowerCase();

// Importing users from a spreadsheet. The wizard keeps its draft in the
// browser; the server answers lookups, runs the final check right before
// the run, and stores the placement rules when the import runs. Running
// it starts a bulk job (services/bulkJobs/importRows.ts) whose results
// page reads the job back, and whose results CSV hands out the passwords
// once (POST /api/bulk-jobs/:id/results).
export async function registerUserImportRoutes(app: FastifyInstance): Promise<void> {
  async function directoryOf(req: FastifyRequest) {
    const { id } = idParamSchema.parse(req.params);
    const directory = await app.services.directoryConfig.getById(id);
    if (!directory) throw NotFound('directory not found');
    return directory;
  }

  // ---- GET /api/directories/:id/placement-rules ------------------------
  app.get('/api/directories/:id/placement-rules', {
    config: { policy: { capability: 'write:user.create', stepUp: false, directory: 'param' } },
    handler: async (req): Promise<PlacementRulesResponse> => {
      const directory = await directoryOf(req);
      return { rules: await loadPlacementRules(app.db, directory.id) };
    },
  });

  // ---- PUT /api/directories/:id/placement-rules ------------------------
  // Each rule added or changed is audited with what it was and is now.
  app.put('/api/directories/:id/placement-rules', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'param' } },
    handler: async (req): Promise<PlacementRulesSaveResponse> => {
      const directory = await directoryOf(req);
      const body = placementRulesSaveSchema.parse(req.body);
      const groupIds = [...new Set(body.rules.flatMap((r) => r.groupIds.map(lower)))];
      if (groupIds.length > 0) await app.requireCapability(req, 'write:group.membership');
      const groups = await findCachedGroupsById(app.db, directory.id, groupIds);
      const unknown = groupIds.find((id) => !groups.has(id));
      if (unknown) throw BadRequest(`group ${unknown} not found in directory cache`);
      for (const { ouDn } of body.rules) {
        if (!parseDn(ouDn)) throw BadRequest(`"${ouDn}" isn't a distinguished name.`);
        if (!isDnWithin(ouDn, directory.baseDn)) {
          throw BadRequest(`"${ouDn}" isn't under this directory's base DN.`);
        }
      }

      const changes = await savePlacementRules(
        app.db,
        directory.id,
        body.rules.map((r) => ({
          ...r,
          groupIds: r.groupIds.map((id) => groups.get(lower(id))!.id),
        })),
        req.actor!.session.actorUsername,
      );
      const names = await findCachedGroupsById(app.db, directory.id, [
        ...new Set([...groupIds, ...changes.flatMap((c) => c.before?.group_ids ?? [])]),
      ]);
      const named = (ids: readonly string[]) =>
        ids.map((id) => ({ id, name: names.get(lower(id))?.name ?? null }));
      for (const { before, after } of changes) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: before ? 'import.placementRule.update' : 'import.placementRule.create',
            result: 'success',
            actorAuthMethod: 'ad-password',
            providerId: directory.id,
            targetType: 'config',
            targetId: String(directory.id),
            before: before && {
              column: before.grouping_column,
              value: before.value,
              ouDn: before.ou_dn,
              groups: named(before.group_ids),
            },
            after: {
              column: after.column,
              value: after.value,
              ouDn: after.ouDn,
              groups: named(after.groupIds),
            },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for import.placementRule'));
      }
      return { rules: await loadPlacementRules(app.db, directory.id), changed: changes.length };
    },
  });

  // ---- POST /api/users/import/lookup ------------------------------------
  // A read sent as POST: who in the directory holds an import's employee
  // IDs, emails and manager values, asked of AD rather than the cache so
  // someone added since the last sync isn't created twice.
  app.post('/api/users/import/lookup', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<ImportLookupResponse> => {
      const body = importLookupRequestSchema.parse(req.body);
      if (body.employeeIds.length + body.identifiers.length === 0) return { people: [] };
      const provider = await app.services.providers.buildForRequest(req);
      return { people: await provider.findPeople(body) };
    },
  });

  /** The final check, as the operator may run it: what the run takes, against the directory now. */
  async function finalCheck(req: FastifyRequest, body: CheckedImportRequest) {
    if (body.rows.some((r) => r.groups?.length)) {
      await app.requireCapability(req, 'write:group.membership');
    }
    const provider = await app.services.providers.buildForRequest(req);
    const directory = await app.services.directoryConfig.getById(provider.id);
    if (!directory) throw NotFound('directory not found');
    const result = await checkImport(
      {
        db: app.db,
        provider,
        directory,
        roleGroups: await app.services.authorization.roleGroups(),
        canGrantRoles: app.services.authorization.has(
          req.actor!.session.capabilities,
          'configure:security',
        ),
      },
      body,
    );
    return { result, directory };
  }

  // ---- POST /api/users/import/check -------------------------------------
  // Nothing is written, but it's the run's gate, so it takes what the run takes.
  app.post('/api/users/import/check', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'caller' } },
    handler: async (req): Promise<ImportCheckResponse> => {
      const body = importRequestSchema.parse(req.body);
      return (await finalCheck(req, body)).result;
    },
  });

  // ---- POST /api/users/import/run ---------------------------------------
  // The final check again, then the import as a job the operator can leave
  // and come back to. Refused, with nothing written, if the check finds
  // anything now.
  app.post('/api/users/import/run', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'caller' } },
    handler: async (req, reply) => {
      const body = importRunRequestSchema.parse(req.body);
      const { result, directory } = await finalCheck(req, body.import);
      const jobs = app.services.bulkJobs;
      const id = await (async () => {
        if (result.problems.length > 0) {
          throw new BulkJobRequestError('check_failed', describeCheck(result.problems));
        }
        const guarded = result.protectedGroups[0];
        if (guarded && !body.acknowledgeProtected) {
          throw new BulkJobRequestError(
            'protected_unacknowledged',
            `Adding users to ${guarded.name} gives them admin rights in AD. Confirm that they need them.`,
          );
        }
        return jobs.create(
          actorFrom(req),
          IMPORT_JOB_ACTION,
          importPlan(body.import, directory.newUsers.phoneCountry),
          (subject) => requireFor(app, req, jobs.handlers[IMPORT_JOB_ACTION], subject),
        );
      })().catch(refuseBulkRequest);
      return reply
        .status(202)
        .send(bulkJobResponseSchema.parse({ job: await jobs.describeOne(id) }));
    },
  });

  /** An import job of the operator's own, in this directory. */
  async function ownImport(req: FastifyRequest) {
    const { id } = idParamSchema.parse(req.params);
    const job = await app.services.bulkJobs.find(
      String(id),
      req.directoryId!,
      req.actor!.session.actorUserId,
    );
    if (!job || job.action !== IMPORT_JOB_ACTION) throw NotFound('import not found');
    return job;
  }

  // ---- GET /api/users/import/jobs/:id -----------------------------------
  // The import's results page, polled while it (or its password reset)
  // runs. Like any bulk job, it's its operator's own; others see it
  // through the audit log. Its CSV is POST /api/bulk-jobs/:id/results.
  app.get('/api/users/import/jobs/:id', {
    config: {
      policy: { capability: null, stepUp: false, directory: 'caller' },
      rateLimit: { max: 600, timeWindow: '1 minute' },
    },
    handler: async (req): Promise<ImportJobResponse> => {
      const job = await ownImport(req);
      const jobs = app.services.bulkJobs;
      return importJobResponseSchema.parse(
        await importJobView(app.db, (id) => jobs.describeOne(id), job),
      );
    },
  });
}
