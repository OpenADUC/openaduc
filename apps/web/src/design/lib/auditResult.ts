// SPDX-License-Identifier: BUSL-1.1

/** The badge class for an audit event's result. */
export function resultBadge(result: string): string {
  if (result === 'success') return 'badge-green';
  if (result === 'failure' || result === 'denied') return 'badge-red';
  return 'badge-muted';
}
