// SPDX-License-Identifier: BUSL-1.1
// Translate a rename request into the attribute writes and RDN change it
// needs, given the account's current values. Kept free of LDAP I/O so the
// proxyAddresses handling can be tested on its own.

import type { UserRenameInput } from '../types.js';

export interface RenameCurrent {
  givenName: string | null;
  surname: string | null;
  displayName: string | null;
  cn: string | null;
  samAccountName: string | null;
  userPrincipalName: string | null;
  email: string | null;
  proxyAddresses: string[];
}

export interface RenamePlan {
  // AD attribute name → replacement values; an empty array deletes it.
  attributes: Record<string, string[]>;
  // New RDN value when cn changes, otherwise null.
  newCn: string | null;
  // Values that must be free in the directory before writing.
  newSamAccountName: string | null;
  newUserPrincipalName: string | null;
  newEmail: string | null;
}

const SCALARS = [
  ['givenName', 'givenName'],
  ['surname', 'sn'],
  ['displayName', 'displayName'],
  ['samAccountName', 'sAMAccountName'],
  ['userPrincipalName', 'userPrincipalName'],
] as const;

export function planUserRename(current: RenameCurrent, input: UserRenameInput): RenamePlan {
  const plan: RenamePlan = {
    attributes: {},
    newCn: null,
    newSamAccountName: null,
    newUserPrincipalName: null,
    newEmail: null,
  };

  for (const [field, attr] of SCALARS) {
    const next = clean(input[field]);
    if (next === undefined || next === current[field]) continue;
    plan.attributes[attr] = next === null ? [] : [next];
  }
  if (plan.attributes['sAMAccountName']) {
    plan.newSamAccountName = clean(input.samAccountName) ?? null;
  }
  if (plan.attributes['userPrincipalName']) {
    plan.newUserPrincipalName = clean(input.userPrincipalName) ?? null;
  }

  const cn = clean(input.cn);
  if (cn && cn !== current.cn) plan.newCn = cn;

  const email = clean(input.email);
  if (email !== undefined && email !== current.email) {
    plan.attributes['mail'] = email === null ? [] : [email];
    plan.newEmail = email;
    if (current.proxyAddresses.length > 0) {
      const proxies = nextProxyAddresses(current.proxyAddresses, email, input.keepOldEmailAsAlias);
      if (!sameList(proxies, current.proxyAddresses)) plan.attributes['proxyAddresses'] = proxies;
    }
  }

  return plan;
}

/**
 * The new address becomes the primary (`SMTP:`), the old primary becomes an
 * alias (`smtp:`) or is dropped, and any existing alias for the new address
 * is removed so it isn't listed twice. Non-SMTP entries (X500, SIP, ...)
 * are left alone.
 */
function nextProxyAddresses(
  current: string[],
  email: string | null,
  keepOldAsAlias: boolean,
): string[] {
  const newLower = email?.toLowerCase() ?? null;
  const primary = current.find((p) => p.startsWith('SMTP:'));
  const rest = current.filter((p) => {
    if (p === primary) return false;
    return !(isSmtp(p) && p.slice(5).toLowerCase() === newLower);
  });
  if (primary && keepOldAsAlias && primary.slice(5).toLowerCase() !== newLower) {
    rest.push(`smtp:${primary.slice(5)}`);
  }
  return email ? [`SMTP:${email}`, ...rest] : rest;
}

function isSmtp(p: string): boolean {
  return p.slice(0, 5).toLowerCase() === 'smtp:';
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((v, i) => v === sortedB[i]);
}

function clean(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  const t = v.trim();
  return t === '' ? null : t;
}
