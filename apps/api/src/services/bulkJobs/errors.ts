// SPDX-License-Identifier: BUSL-1.1
import { AppError, Conflict, NotFound } from '../../plugins/errorHandler.js';

/** A bulk job request (or its preview) that can't start as asked. */
export class BulkJobRequestError extends Error {
  constructor(
    readonly code:
      | 'check_failed'
      | 'group_not_found'
      | 'job_running'
      | 'manager_not_found'
      | 'nothing_to_revert'
      | 'not_revertible'
      | 'ou_not_found'
      | 'ou_refused'
      | 'preview_mismatch'
      | 'passwords_expired'
      | 'protected_unacknowledged'
      | 'results_downloaded'
      | 'revert_running',
    message: string,
  ) {
    super(message);
    this.name = 'BulkJobRequestError';
  }
}

/** A BulkJobRequestError as its HTTP error; anything else rethrown. */
export function refuseBulkRequest(err: unknown): never {
  if (err instanceof BulkJobRequestError) {
    switch (err.code) {
      case 'group_not_found':
      case 'manager_not_found':
      case 'ou_not_found':
        throw NotFound(err.message);
      case 'job_running':
      case 'preview_mismatch':
      case 'results_downloaded':
      case 'revert_running':
        throw Conflict(err.message);
      case 'passwords_expired':
        throw new AppError({ statusCode: 410, code: 'gone', message: err.message });
      case 'check_failed':
      case 'nothing_to_revert':
      case 'not_revertible':
      case 'ou_refused':
      case 'protected_unacknowledged':
        throw new AppError({
          statusCode: 422,
          code: 'unprocessable_entity',
          message: err.message,
        });
    }
  }
  throw err;
}
