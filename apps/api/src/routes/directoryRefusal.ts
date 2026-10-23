// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { NotFound } from '../plugins/errorHandler.js';

/**
 * The HTTP error for a write the directory refused, carrying AD's reason:
 * 403 when the operator lacks the right, 409 when the object's state or a
 * clash prevents it, 404 when it's gone, 502 for anything else.
 */
export function directoryRefusal(
  app: FastifyInstance,
  result: { errorCode?: string | null; errorMessage?: string | null },
  options: {
    /** What was refused, as in "cannot delete". */
    verb: string;
    notFound: string;
    /** Replaces "directory rejected the <verb>" for a 403. */
    forbidden?: string;
  },
): Error {
  const detail = result.errorMessage ? `: ${result.errorMessage}` : '';
  switch (result.errorCode) {
    case 'permission_denied':
      return app.httpErrors.forbidden(
        `${options.forbidden ?? `directory rejected the ${options.verb}`}${detail}`,
      );
    case 'conflict':
    case 'policy_violation':
      return app.httpErrors.conflict(`cannot ${options.verb}${detail}`);
    case 'not_found':
      return NotFound(options.notFound);
    default:
      return app.httpErrors.badGateway(`${options.verb} failed${detail}`);
  }
}
