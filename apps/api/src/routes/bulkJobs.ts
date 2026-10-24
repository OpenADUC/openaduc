// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BULK_JOB_ACTIONS,
  bulkJobListResponseSchema,
  bulkJobPath,
  bulkJobResponseSchema,
  bulkJobRevertPreviewSchema,
  bulkJobRowsQuerySchema,
  bulkJobRowsResponseSchema,
  canRevert,
  type BulkJobSubject,
} from '@openaduc/shared';
import { NotFound, Unauthorized } from '../plugins/errorHandler.js';
import { refuseBulkRequest } from '../services/bulkJobs/errors.js';
import { revertRunner, type BulkRevertRunner } from '../services/bulkJobs/reverts.js';
import type { JobActor, JobRecord } from '../services/bulkJobs/service.js';

const jobParamSchema = z.object({ id: z.coerce.number().int().positive() });
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

/**
 * Bulk actions run as jobs (services/bulkJobs/). Starting one takes its
 * action's capability and step-up, as the single-object route does;
 * continuing or retrying one writes too, so takes them again, along with
 * whatever its subject takes (adding to a role group, configure:security).
 * A job is its operator's own: anyone else gets 404, and sees the job
 * through the audit log instead.
 *
 * Reverting a job starts a new job, the reverting operator's own, that
 * puts back what it changed. It takes the capability of the writes it
 * makes, and step-up, as the job did; reverting someone else's job also
 * takes view:audit, as that's where it's seen.
 */
export async function registerBulkJobRoutes(app: FastifyInstance): Promise<void> {
  const jobs = app.services.bulkJobs;

  for (const action of BULK_JOB_ACTIONS) {
    app.post(`/api${bulkJobPath(action)}`, {
      config: {
        policy: {
          capability: jobs.handlers[action].capability,
          stepUp: true,
          directory: 'caller',
        },
      },
      handler: async (req, reply) => {
        const id = await jobs
          .create(actorFrom(req), action, req.body, (subject) =>
            requireFor(req, jobs.handlers[action], subject),
          )
          .catch(refuseBulkRequest);
        return reply
          .status(202)
          .send(bulkJobResponseSchema.parse({ job: await jobs.describeOne(id) }));
      },
    });
  }

  app.get('/api/bulk-jobs', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const { limit } = listQuerySchema.parse(req.query);
      const list = await jobs.list(req.directoryId!, req.actor!.session.actorUserId, limit);
      return bulkJobListResponseSchema.parse({ jobs: list });
    },
  });

  // Polled while a job runs, so it gets more room than the global limit.
  app.get('/api/bulk-jobs/:id', {
    config: {
      policy: { capability: null, stepUp: false, directory: 'caller' },
      rateLimit: { max: 600, timeWindow: '1 minute' },
    },
    handler: async (req) => {
      const job = await ownJob(req);
      return bulkJobResponseSchema.parse({ job: await jobs.describeOne(job.id) });
    },
  });

  app.get('/api/bulk-jobs/:id/rows', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      const { status } = bulkJobRowsQuerySchema.parse(req.query);
      return bulkJobRowsResponseSchema.parse({ rows: await jobs.rows(job.id, status) });
    },
  });

  app.post('/api/bulk-jobs/:id/resume', {
    config: { policy: { capability: null, stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      await requireFor(req, jobs.runner(job), job.subject_json);
      if (!(await jobs.resume(job, actorFrom(req)))) {
        throw app.httpErrors.conflict('only a paused job can be continued');
      }
      return bulkJobResponseSchema.parse({ job: await jobs.describeOne(job.id) });
    },
  });

  app.post('/api/bulk-jobs/:id/retry', {
    config: { policy: { capability: null, stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      await requireFor(req, jobs.runner(job), job.subject_json);
      if (!(await jobs.retry(job, actorFrom(req)).catch(refuseBulkRequest))) {
        throw app.httpErrors.conflict('the job is still running, or has no failed rows');
      }
      return bulkJobResponseSchema.parse({ job: await jobs.describeOne(job.id) });
    },
  });

  // No step-up: stopping a job only prevents writes, and an operator whose
  // elevated session ended should be able to stop a paused job.
  app.post('/api/bulk-jobs/:id/cancel', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const job = await ownJob(req);
      if (!(await jobs.cancel(job, actorFrom(req)))) {
        throw app.httpErrors.conflict('the job has already stopped');
      }
      return bulkJobResponseSchema.parse({ job: await jobs.describeOne(job.id) });
    },
  });

  app.get('/api/bulk-jobs/:id/revert/preview', {
    config: { policy: { capability: null, stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const job = await revertedJob(req);
      const preview = await jobs.previewRevert(job).catch(refuseBulkRequest);
      return bulkJobRevertPreviewSchema.parse(preview);
    },
  });

  app.post('/api/bulk-jobs/:id/revert', {
    config: { policy: { capability: null, stepUp: true, directory: 'caller' } },
    handler: async (req, reply) => {
      const job = await revertedJob(req);
      const id = await jobs.revert(actorFrom(req), job, req.body).catch(refuseBulkRequest);
      return reply
        .status(202)
        .send(bulkJobResponseSchema.parse({ job: await jobs.describeOne(id) }));
    },
  });

  /** A job in this directory to revert, if the operator may revert it. */
  async function revertedJob(req: FastifyRequest): Promise<JobRecord> {
    const { id } = jobParamSchema.parse(req.params);
    const job = await jobs.findInDirectory(String(id), req.directoryId!);
    if (!job) throw NotFound('bulk job not found');
    if (job.actor_user_id !== req.actor!.session.actorUserId) {
      await app.requireCapability(req, 'view:audit');
    }
    if (job.reverts_job_id === null && canRevert(job.action)) {
      await requireFor(req, revertRunner(job.action), job.subject_json);
    }
    return job;
  }

  /** The job's capability, and what its subject takes beyond it, such as handing out a role. */
  async function requireFor(
    req: FastifyRequest,
    runner: Pick<BulkRevertRunner, 'capability' | 'requires'>,
    subject: BulkJobSubject | null,
  ): Promise<void> {
    await app.requireCapability(req, runner.capability);
    const needs = runner.requires?.(subject, await app.services.authorization.roleGroups());
    if (needs) await app.requireCapability(req, needs.capability, needs.reason);
  }

  async function ownJob(req: FastifyRequest) {
    const { id } = jobParamSchema.parse(req.params);
    const job = await jobs.find(String(id), req.directoryId!, req.actor!.session.actorUserId);
    if (!job) throw NotFound('bulk job not found');
    return job;
  }
}

function actorFrom(req: FastifyRequest): JobActor {
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
