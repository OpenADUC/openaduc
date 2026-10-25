// SPDX-License-Identifier: BUSL-1.1

/**
 * What to tell the operator about a failed request: the API's message (an
 * ApiError is an Error), or another error's, such as a dropped connection;
 * `fallback` when there's none.
 */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
