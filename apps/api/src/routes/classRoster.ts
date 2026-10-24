// SPDX-License-Identifier: BUSL-1.1
import {
  IMPORT_JOB_ACTION,
  classPassReissueSchema,
  classPassRevealSchema,
  classRescheduleRequestSchema,
  classRosterSchema,
  classTapOptionsSchema,
  type ClassPassReissue,
  type ClassPassReveal,
  type ClassRoster,
  type ClassTapOptions,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { tenantTapPolicy } from '../services/temporaryAccessPass.js';
import { graphFailure } from './graphFailure.js';
import { TapNotEnabled } from './temporaryAccessPass.js';

// Class Temporary Access Passes (docs/adr/0003-class-taps-are-stored-until-they-expire.md):
// what the import's Options step may offer, and the class roster of an
// import that scheduled a class, which any operator who may issue a TAP
// can open, not only the import's own. Revealing a pass, reissuing one and
// rescheduling class take step-up, and each is audited; a revealed value
// is in its response alone.

const jobParamSchema = z.object({ id: z.coerce.number().int().positive() });
const rowParamSchema = jobParamSchema.extend({ rowId: z.coerce.number().int().positive() });

export async function registerClassRosterRoutes(app: FastifyInstance): Promise<void> {
  const tapOn = (directoryId: number) =>
    app.services.entraIntegration.isFeatureEnabled(directoryId, 'temporaryAccessPass');

  /** An import of this directory's with a class, whoever ran it. */
  async function importJob(req: FastifyRequest) {
    const { id } = jobParamSchema.parse(req.params);
    if (!(await tapOn(req.directoryId!))) throw TapNotEnabled();
    const job = await app.services.bulkJobs.findInDirectory(String(id), req.directoryId!);
    if (!job || job.action !== IMPORT_JOB_ACTION) throw NotFound('import not found');
    return job;
  }

  const actorOf = (req: FastifyRequest) => ({
    ...auditContextFromRequest(req),
    actorAuthMethod: 'ad-password' as const,
  });

  // ---- GET /api/users/import/class-taps ---------------------------------
  // What Issue TAPs for class may ask, by the tenant's policy.
  app.get('/api/users/import/class-taps', {
    config: { policy: { capability: 'write:user.issueTap', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<ClassTapOptions> => {
      const graph = (await tapOn(req.directoryId!))
        ? await app.services.graphClient.build(req.directoryId!)
        : null;
      if (!graph) return { status: 'unavailable', message: TapNotEnabled().message };
      const policy = await tenantTapPolicy(graph).catch(graphFailure);
      return classTapOptionsSchema.parse(
        policy
          ? { status: 'ready', policy }
          : {
              status: 'unavailable',
              message:
                'Temporary Access Pass is turned off in the tenant’s authentication methods policy. Turn it on in the Microsoft Entra admin center first.',
            },
      );
    },
  });

  // ---- GET /api/users/import/jobs/:id/class-roster ----------------------
  // Each pass's status is read from Graph, so this is polled gently.
  app.get('/api/users/import/jobs/:id/class-roster', {
    config: {
      policy: { capability: 'write:user.issueTap', stepUp: false, directory: 'caller' },
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
    handler: async (req): Promise<ClassRoster> => {
      const job = await importJob(req);
      const roster = await app.services.classPasses
        .roster(job, req.actor!.session.actorUserId)
        .catch(graphFailure);
      return classRosterSchema.parse(roster);
    },
  });

  // ---- POST /api/users/import/jobs/:id/class-roster/:rowId/reveal -------
  app.post('/api/users/import/jobs/:id/class-roster/:rowId/reveal', {
    config: {
      policy: { capability: 'write:user.issueTap', stepUp: true, directory: 'caller' },
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
    handler: async (req, reply): Promise<ClassPassReveal> => {
      const { rowId } = rowParamSchema.parse(req.params);
      const job = await importJob(req);
      const revealed = await app.services.classPasses.reveal(job, String(rowId), {
        ...auditContextFromRequest(req),
      });
      reply.header('Cache-Control', 'no-store');
      return classPassRevealSchema.parse(revealed);
    },
  });

  // ---- POST /api/users/import/jobs/:id/class-roster/:rowId/reissue ------
  app.post('/api/users/import/jobs/:id/class-roster/:rowId/reissue', {
    config: {
      policy: { capability: 'write:user.issueTap', stepUp: true, directory: 'caller' },
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
    handler: async (req): Promise<ClassPassReissue> => {
      const { rowId } = rowParamSchema.parse(req.params);
      const job = await importJob(req);
      return classPassReissueSchema.parse(
        await app.services.classPasses.reissue(job, String(rowId), actorOf(req)),
      );
    },
  });

  // ---- POST /api/users/import/jobs/:id/class-roster/reschedule ----------
  app.post('/api/users/import/jobs/:id/class-roster/reschedule', {
    config: { policy: { capability: 'write:user.issueTap', stepUp: true, directory: 'caller' } },
    handler: async (req, reply) => {
      const body = classRescheduleRequestSchema.parse(req.body);
      const job = await importJob(req);
      await app.services.classPasses.reschedule(job, body.start, actorOf(req)).catch(graphFailure);
      return reply.status(204).send();
    },
  });
}
