// SPDX-License-Identifier: BUSL-1.1
import type { FastifyRequest } from 'fastify';
import type { WriteContext } from '../providers/types.js';

/**
 * Build the write-context object the AD provider expects. The bind password
 * comes from the in-process credential cache (populated by step-up). The
 * non-null assertions are safe because these routes require step-up.
 */
export function ctx(
  actor: NonNullable<FastifyRequest['actor']>,
  req: FastifyRequest,
): WriteContext {
  return {
    actorUserId: actor.session.actorUserId,
    actorUsername: actor.session.actorUsername!,
    actorPassword: actor.elevatedPassword!,
    correlationId: req.correlationId,
  };
}
