// SPDX-License-Identifier: BUSL-1.1

/** The relative id: the last part of a SID, e.g. 512 for Domain Admins. */
export function ridOf(sid: string | null): number | null {
  if (!sid) return null;
  const last = sid.slice(sid.lastIndexOf('-') + 1);
  const rid = Number.parseInt(last, 10);
  return Number.isFinite(rid) ? rid : null;
}
