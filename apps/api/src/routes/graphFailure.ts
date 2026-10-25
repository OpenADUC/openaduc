// SPDX-License-Identifier: BUSL-1.1
import { AppError } from '../plugins/errorHandler.js';
import { GraphPermissionError, GraphThrottledError } from '../services/graphClient.js';

/**
 * Graph refusing or failing: busy past what OpenADUC waits for, a request
 * it rejects (400) in its own words, anything else with the permission it
 * most likely wants.
 */
export function graphFailure(err: unknown): never {
  if (err instanceof GraphThrottledError) {
    throw new AppError({
      statusCode: 503,
      code: 'entra_throttled',
      message: 'Microsoft Graph is busy. Try again in a minute.',
      details: { retryAfterSeconds: err.retryAfterSeconds },
    });
  }
  if (err instanceof GraphPermissionError && err.statusCode === 400) {
    throw new AppError({
      statusCode: 422,
      code: 'entra_rejected',
      message: `Microsoft Entra refused: ${err.graphMessage ?? err.message}`,
    });
  }
  if (err instanceof GraphPermissionError) {
    throw new AppError({
      statusCode: 502,
      code: 'entra_error',
      message: err.hint ? `${err.message} (${err.hint})` : err.message,
    });
  }
  throw err;
}
