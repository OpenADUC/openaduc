// SPDX-License-Identifier: BUSL-1.1
// What a request that starts, continues or reads a bulk job brings to it:
// the operator it writes as, and the capabilities it takes.
import type { BulkJobSubject } from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Unauthorized } from '../../plugins/errorHandler.js';
import type { BulkRevertRunner } from './reverts.js';
import type { JobActor } from './service.js';

/** The job's capability, and what its subject takes beyond it, such as handing out a role. */
export async function requireFor(
  app: FastifyInstance,
  req: FastifyRequest,
  runner: Pick<BulkRevertRunner, 'capability' | 'requires'>,
  subject: BulkJobSubject | null,
): Promise<void> {
  await app.requireCapability(req, runner.capability);
  const roleGroups = await app.services.authorization.roleGroups();
  for (const needs of runner.requires?.(subject, roleGroups) ?? []) {
    await app.requireCapability(req, needs.capability, needs.reason);
  }
}

/** The operator a job writes as, from the request that starts or continues it. */
export function actorFrom(req: FastifyRequest): JobActor {
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
