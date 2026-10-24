// SPDX-License-Identifier: BUSL-1.1
import {
  IMPORT_JOB_ACTION,
  TAP_POLICY_OFF_MESSAGE,
  classPassReissueSchema,
  classPassRevealSchema,
  classRescheduleRequestSchema,
  classRescheduleSchema,
  classRosterSchema,
  classTapOptionsSchema,
  type ClassPassReissue,
  type ClassPassReveal,
  type ClassReschedule,
  type ClassRoster,
  type ClassTapOptions,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { TapNotEnabled, tenantTapPolicy } from '../services/temporaryAccessPass.js';
import { graphFailure } from './graphFailure.js';

// Class Temporary Access Passes (docs/adr/0003-class-taps-are-stored-until-they-expire.md):
// what the import's Options step may offer, and the class roster of an
// import that scheduled a class, which any operator who may issue a TAP
// can open, not only the import's own. Revealing a pass, reissuing one,
// rescheduling class and taking it over take step-up, and each is
// audited; a revealed value is in its response alone. With the feature
// off the roster still opens, to say so; nothing else does.

const jobParamSchema = z.object({ id: z.coerce.number().int().positive() });
const rowParamSchema = jobParamSchema.extend({ rowId: z.coerce.number().int().positive() });

export async function registerClassRosterRoutes(app: FastifyInstance): Promise<void> {
  /** An import of this directory's, whoever ran it; while the feature is on unless `evenOff`. */
  async function importJob(req: FastifyRequest, evenOff = false) {
    const { id } = jobParamSchema.parse(req.params);
    if (!evenOff && !(await app.services.graphClient.tapGraph(req.directoryId!))) {
      throw TapNotEnabled();
    }
    const job = await app.services.bulkJobs.findInDirectory(String(id), req.directoryId!);
    if (!job || job.action !== IMPORT_JOB_ACTION) throw NotFound('import not found');
    return job;
  }

  const actorOf = (req: FastifyRequest) => ({
    ...auditContextFromRequest(req),
    actorAuthMethod: 'ad-password' as const,
  });
  const issuing = {
    policy: { capability: 'write:user.issueTap', stepUp: true, directory: 'caller' },
  } as const;

  // ---- GET /api/users/import/class-taps ---------------------------------
  // What Issue TAPs for class may ask, by the tenant's policy.
  app.get('/api/users/import/class-taps', {
    config: { policy: { capability: 'write:user.issueTap', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<ClassTapOptions> => {
      const graph = await app.services.graphClient.tapGraph(req.directoryId!);
      if (!graph) return { status: 'unavailable', message: TapNotEnabled().message };
      const policy = await tenantTapPolicy(graph).catch(graphFailure);
      return classTapOptionsSchema.parse(
        policy
          ? { status: 'ready', policy }
          : { status: 'unavailable', message: TAP_POLICY_OFF_MESSAGE },
      );
    },
  });

  // ---- GET /api/users/import/jobs/:id/class-roster ----------------------
  // Each pass's status is read from Graph, a minute at most, so it's polled gently.
  app.get('/api/users/import/jobs/:id/class-roster', {
    config: {
      policy: { capability: 'write:user.issueTap', stepUp: false, directory: 'caller' },
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
    handler: async (req): Promise<ClassRoster> => {
      const job = await importJob(req, true);
      const roster = await app.services.classPasses
        .roster(job, req.actor!.session.actorUserId)
        .catch(graphFailure);
      return classRosterSchema.parse(roster);
    },
  });

  // ---- POST /api/users/import/jobs/:id/class-roster/:rowId/reveal -------
  app.post('/api/users/import/jobs/:id/class-roster/:rowId/reveal', {
    config: { ...issuing, rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply): Promise<ClassPassReveal> => {
      const { rowId } = rowParamSchema.parse(req.params);
      const job = await importJob(req);
      const revealed = await app.services.classPasses.reveal(job, String(rowId), actorOf(req));
      reply.header('Cache-Control', 'no-store');
      return classPassRevealSchema.parse(revealed);
    },
  });

  // ---- POST /api/users/import/jobs/:id/class-roster/:rowId/reissue ------
  app.post('/api/users/import/jobs/:id/class-roster/:rowId/reissue', {
    config: { ...issuing, rateLimit: { max: 30, timeWindow: '1 minute' } },
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
    config: issuing,
    handler: async (req): Promise<ClassReschedule> => {
      const body = classRescheduleRequestSchema.parse(req.body);
      const job = await importJob(req);
      return classRescheduleSchema.parse(
        await app.services.classPasses
          .reschedule(job, body.start, actorOf(req))
          .catch(graphFailure),
      );
    },
  });

  // ---- POST /api/users/import/jobs/:id/class-roster/take-over -----------
  // The class's passes are made on this operator's authority from now on.
  app.post('/api/users/import/jobs/:id/class-roster/take-over', {
    config: issuing,
    handler: async (req, reply) => {
      const job = await importJob(req);
      await app.services.classPasses.takeOver(job, actorOf(req));
      return reply.status(204).send();
    },
  });
}
