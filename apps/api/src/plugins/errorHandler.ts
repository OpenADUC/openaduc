// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

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
export const Forbidden = (msg = 'Forbidden') =>
  new AppError({ statusCode: 403, code: 'forbidden', message: msg });
/**
 * 403 with a specific `step_up_required` code. The web client treats
 * this distinctly: it auto-clears stale local edit-mode state and
 * re-opens the step-up dialog, so the operator can re-authenticate in
 * one click rather than manually toggling editing off and on.
 */
export const StepUpRequired = (msg = 'editing session expired — please re-authenticate') =>
  new AppError({ statusCode: 403, code: 'step_up_required', message: msg });
export const NotFound = (msg = 'Not found') =>
  new AppError({ statusCode: 404, code: 'not_found', message: msg });
export const BadRequest = (msg: string, details?: unknown) =>
  new AppError({ statusCode: 400, code: 'bad_request', message: msg, details });

export default fp(async (app) => {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      req.log.info({ issues: err.issues }, 'validation error');
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Invalid request', issues: err.issues },
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
