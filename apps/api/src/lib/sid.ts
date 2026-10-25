// SPDX-License-Identifier: BUSL-1.1

/** True for a SID in an AD domain (S-1-5-21-…), rather than a builtin or well-known one. */
export function isDomainSid(sid: string | null): boolean {
  return !!sid?.startsWith('S-1-5-21-');
}

/** The relative id: the last part of a SID, e.g. 512 for Domain Admins. */
export function ridOf(sid: string | null): number | null {
  if (!sid) return null;
  const last = sid.slice(sid.lastIndexOf('-') + 1);
  const rid = Number.parseInt(last, 10);
  return Number.isFinite(rid) ? rid : null;
}
