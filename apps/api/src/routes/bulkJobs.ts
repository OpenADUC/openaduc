// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BULK_JOB_ACTIONS,
  BULK_JOB_CAPABILITY,
  bulkJobCreateRequestSchema,
  bulkJobRowsQuerySchema,
  type BulkJobAction,
} from '@openaduc/shared';
import { NotFound, Unauthorized } from '../plugins/errorHandler.js';
import type { BulkJobStarter } from '../services/bulkJobs.js';

const jobParamSchema = z.object({ id: z.coerce.number().int().positive() });
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

/**
 * Bulk actions over users run as jobs (services/bulkJobs.ts). Starting
 * one takes its action's capability and step-up, as the single-user
 * route does; continuing or retrying one writes too, so takes them again.
 * A job is its operator's own: anyone else gets 404, and sees the job
 * through the audit log instead.
 */
export async function registerBulkJobRoutes(app: FastifyInstance): Promise<void> {
  for (const action of BULK_JOB_ACTIONS) {
    app.post(`/api/users/bulk-${action.slice('user.'.length)}`, {
      config: {
        policy: { capability: BULK_JOB_CAPABILITY[action], stepUp: true, directory: 'caller' },
      },
      handler: async (req, reply) => {
        const { ids } = bulkJobCreateRequestSchema.parse(req.body);
        const id = await app.services.bulkJobs.create(starter(req), action, ids);
        return reply.status(202).send({ job: await app.services.bulkJobs.describeOne(id) });
      },
    });
  }

  app.get('/api/bulk-jobs', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const { limit } = listQuerySchema.parse(req.query);
      const actor = req.actor!;
      return {
        jobs: await app.services.bulkJobs.list(req.directoryId!, actor.session.actorUserId, limit),
      };
    },
  });

  app.get('/api/bulk-jobs/:id', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      return { job: await app.services.bulkJobs.describeOne(job.id) };
    },
  });

  app.get('/api/bulk-jobs/:id/rows', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      const { status } = bulkJobRowsQuerySchema.parse(req.query);
      return { rows: await app.services.bulkJobs.rows(job.id, status) };
    },
  });

  app.post('/api/bulk-jobs/:id/resume', {
    config: { policy: { capability: null, stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      await app.requireCapability(req, BULK_JOB_CAPABILITY[job.action as BulkJobAction]);
      if (!(await app.services.bulkJobs.resume(job, starter(req)))) {
        throw app.httpErrors.conflict('only a paused job can be continued');
      }
      return { job: await app.services.bulkJobs.describeOne(job.id) };
    },
  });

  app.post('/api/bulk-jobs/:id/retry', {
    config: { policy: { capability: null, stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      await app.requireCapability(req, BULK_JOB_CAPABILITY[job.action as BulkJobAction]);
      if (!(await app.services.bulkJobs.retry(job, starter(req)))) {
        throw app.httpErrors.conflict('the job is still running, or has no failed rows');
      }
      return { job: await app.services.bulkJobs.describeOne(job.id) };
    },
  });

  // No step-up: stopping a job only prevents writes, and an operator whose
  // elevated session ended should be able to stop a paused job.
  app.post('/api/bulk-jobs/:id/cancel', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      if (!(await app.services.bulkJobs.cancel(job, starter(req)))) {
        throw app.httpErrors.conflict('the job has already stopped');
      }
      return { job: await app.services.bulkJobs.describeOne(job.id) };
    },
  });

  async function ownJob(req: FastifyRequest) {
    const { id } = jobParamSchema.parse(req.params);
    const job = await app.services.bulkJobs.find(
      String(id),
      req.directoryId!,
      req.actor!.session.actorUserId,
    );
    if (!job) throw NotFound('bulk job not found');
    return job;
  }
}

function starter(req: FastifyRequest): BulkJobStarter {
  const { session } = req.actor!;
  if (!session.actorUsername) throw Unauthorized('session has no bind identity');
  return {
    directoryId: req.directoryId!,
    adminSessionId: session.id,
    actorUserId: session.actorUserId,
    actorDisplayName: session.actorDisplayName,
    actorUsername: session.actorUsername,
    sourceIp: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.correlationId,
  };
}
