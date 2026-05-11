// SPDX-License-Identifier: BUSL-1.1
import type { FastifyRequest } from 'fastify';
import type { AuditService, AuditEventInput } from './audit.js';

// Build the request-scoped audit fields once per route handler. Routes spread
// this into recordEvent calls so source_ip / user_agent / correlation_id /
// session_id / actor_* are uniformly captured.
export interface RequestAuditContext {
  sourceIp: string;
  userAgent: string | null;
  correlationId: string;
  sessionId: string | null;
  actorUserId: string | null;
  actorDisplayName: string | null;
}

export function auditContextFromRequest(req: FastifyRequest): RequestAuditContext {
  const actor = req.actor;
  return {
    sourceIp: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    correlationId: req.correlationId,
    sessionId: actor?.session.id ?? null,
    actorUserId: actor?.session.actorUserId ?? null,
    actorDisplayName: actor?.session.actorDisplayName ?? null,
  };
}

/**
 * Wrap a high-risk-write operation. The wrapper:
 *   1. Runs `op()`.
 *   2. Records an audit event reflecting the result (success or failure).
 *   3. If the audit insert itself fails, throws — callers must surface this
 *      as a 5xx so the operator sees that the write is not auditable. This
 *      enforces the "fail closed when audit persistence fails" rule from
 *      docs/architecture §20.4.
 *
 * `op` returns a result object describing what happened; the wrapper
 * derives the audit event from that. On exceptions thrown inside `op`,
 * the wrapper records a failure audit and re-throws.
 */
export async function withAudit<T extends WriteOpResult>(
  audit: AuditService,
  base: Omit<AuditEventInput, 'action' | 'result'> & {
    action: string;
    targetType?: AuditEventInput['targetType'];
  },
  op: () => Promise<T>,
): Promise<T> {
  let opResult: T | undefined;
  let opError: unknown;
  try {
    opResult = await op();
  } catch (err) {
    opError = err;
  }

  const result =
    opError !== undefined
      ? 'failure'
      : opResult?.ok === false
        ? 'failure'
        : opResult?.ok === true
          ? 'success'
          : 'success';

  const errorCode =
    opError instanceof Error
      ? (opError as Error).name
      : opResult && opResult.ok === false
        ? (opResult.errorCode ?? null)
        : null;

  const before = opResult?.before ?? null;
  const after = opResult?.after ?? null;

  await audit.recordEvent({
    ...base,
    result,
    errorCode,
    before,
    after,
  });

  if (opError !== undefined) throw opError;
  return opResult as T;
}

export interface WriteOpResult {
  ok: boolean;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  errorCode?: string | null;
}
