// SPDX-License-Identifier: BUSL-1.1

/**
 * A bulk job request that can't start as asked; the routes answer it
 * with the matching HTTP status.
 */
export class BulkJobRequestError extends Error {
  constructor(
    readonly code: 'group_not_found' | 'preview_mismatch' | 'protected_unacknowledged',
    message: string,
  ) {
    super(message);
    this.name = 'BulkJobRequestError';
  }
}
