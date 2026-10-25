// SPDX-License-Identifier: BUSL-1.1
import {
  importLookupRequestSchema,
  importRequestSchema,
  isDnWithin,
  parseDn,
  placementRulesSaveSchema,
  type ImportCheckResponse,
  type ImportLookupResponse,
  type PlacementRulesResponse,
  type PlacementRulesSaveResponse,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { findCachedGroupsById } from '../services/groupCache.js';
import { checkImport, loadPlacementRules, savePlacementRules } from '../services/userImport.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const lower = (v: string) => v.toLowerCase();

// Importing users from a spreadsheet. The wizard keeps its draft in the
// browser; the server answers lookups, runs the final check right before
// the run, and stores the placement rules when the import runs.
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

  // ---- POST /api/users/import/check -------------------------------------
  // Nothing is written, but it's the run's gate, so it takes what the run takes.
  app.post('/api/users/import/check', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'caller' } },
    handler: async (req): Promise<ImportCheckResponse> => {
      const body = importRequestSchema.parse(req.body);
      if (body.rows.some((r) => r.groups?.length)) {
        await app.requireCapability(req, 'write:group.membership');
      }
      const provider = await app.services.providers.buildForRequest(req);
      const directory = await app.services.directoryConfig.getById(provider.id);
      if (!directory) throw NotFound('directory not found');
      return checkImport(
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
    },
  });
}
