// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { StepUpRequiredReason } from '@openaduc/shared';
import { DirectoryUnavailableError } from '../providers/types.js';
import { auditContextFromRequest, wasAudited } from '../services/auditContext.js';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(opts: { statusCode: number; code: string; message: string; details?: unknown }) {
    super(opts.message);
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    this.details = opts.details;
  }
}

export const Unauthorized = (msg = 'Unauthorized') =>
  new AppError({ statusCode: 401, code: 'unauthorized', message: msg });
/**
 * 401 for a request with no valid session. The web client signs the
 * operator out only on this code; other 401s (a rejected password typed
 * into a form) leave the session alone.
 */
export const SessionRequired = (msg = 'authentication required') =>
  new AppError({ statusCode: 401, code: 'session_required', message: msg });
export const Forbidden = (msg = 'Forbidden') =>
  new AppError({ statusCode: 403, code: 'forbidden', message: msg });
const STEP_UP_REQUIRED_MESSAGES: Record<StepUpRequiredReason, string> = {
  not_elevated: 'step-up required — confirm your password to continue',
  password_rejected: 'the directory rejected your step-up password — step up again',
};

/**
 * 403 with a specific `step_up_required` code. The web client treats
 * this distinctly: it clears stale local elevated state and opens the
 * step-up dialog, then retries the write once the operator steps up.
 * `details.reason` says why, for the dialog to explain.
 */
export const StepUpRequired = (reason: StepUpRequiredReason = 'not_elevated') =>
  new AppError({
    statusCode: 403,
    code: 'step_up_required',
    message: STEP_UP_REQUIRED_MESSAGES[reason],
    details: { reason },
  });
export const NotFound = (msg = 'Not found') =>
  new AppError({ statusCode: 404, code: 'not_found', message: msg });
export const Conflict = (msg: string) =>
  new AppError({ statusCode: 409, code: 'conflict', message: msg });
export const BadRequest = (msg: string, details?: unknown) =>
  new AppError({ statusCode: 400, code: 'bad_request', message: msg, details });

/** What callers hear about an outage, whatever its cause. */
export const DIRECTORY_UNAVAILABLE_MESSAGE =
  'The directory is unavailable right now. Try again shortly or contact your administrator.';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A write that the outage stopped before it reached withAudit (its
 * pre-write directory read failed) still gets an audit row saying why.
 */
async function auditUnstartedWrite(req: FastifyRequest, err: Error): Promise<void> {
  if (!req.actor || READ_METHODS.has(req.method) || wasAudited(err)) return;
  await req.server.services.audit
    .recordEvent({
      ...auditContextFromRequest(req),
      action: 'directory.unavailable',
      result: 'failure',
      errorCode: 'directory_unavailable',
      targetType: 'system',
      providerId: req.actor.session.directoryId,
      metadata: { method: req.method, route: req.routeOptions.url ?? req.url, params: req.params },
    })
    .catch((auditErr) => req.log.error({ err: auditErr }, 'audit insert failed'));
}

export default fp(async (app) => {
  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ZodError) {
      req.log.info({ issues: err.issues }, 'validation error');
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Invalid request', issues: err.issues },
      });
    }
    if (err instanceof DirectoryUnavailableError) {
      // Which hosts and ports failed, and how, goes to the log only: the
      // response is the same for every caller, as for sign-in.
      req.log.error({ err }, err.message);
      await auditUnstartedWrite(req, err);
      return reply.status(502).send({
        error: {
          code: 'directory_unavailable',
          message: DIRECTORY_UNAVAILABLE_MESSAGE,
        },
      });
    }
    if (err instanceof AppError) {
      const level = err.statusCode >= 500 ? 'error' : 'info';
      req.log[level]({ err }, err.message);
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    // Fastify validation error (from JSON schema)
    const validation = (err as { validation?: unknown }).validation;
    if (validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: err instanceof Error ? err.message : 'Validation failed',
          details: validation,
        },
      });
    }
    // @fastify/sensible's httpErrors — treat any thrown HttpError as a
    // deliberate HTTP response rather than an uncaught crash. This covers
    // both 4xx (400 / 403 / 404 …) and 5xx (502 / 503 …): a route that
    // throws `app.httpErrors.badGateway('unlock failed: directory_error')`
    // is making a *deliberate* upstream-failure response, and the message
    // is meaningful to the operator. Without this branch the message
    // gets replaced by a generic "Internal server error" in the UI.
    //
    // We still log 5xx at error level (4xx at info) so the on-call view
    // of the logs still distinguishes "we rejected a request" from
    // "we couldn't talk to AD".
    const httpStatus = (err as { statusCode?: number }).statusCode;
    if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 600) {
      const httpCode = (err as { code?: string }).code ?? `http_${httpStatus}`;
      const httpMessage = err instanceof Error ? err.message : 'request failed';
      const level = httpStatus >= 500 ? 'error' : 'info';
      req.log[level]({ err, statusCode: httpStatus }, httpMessage);
      return reply.status(httpStatus).send({
        error: { code: httpCode, message: httpMessage },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });
});
