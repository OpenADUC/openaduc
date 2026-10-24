// SPDX-License-Identifier: BUSL-1.1
// Matching a pasted list of people (emails, logon names, UPNs, display
// names) against cached users.
import type { UserMatchCandidate, UserMatchResult } from '@openaduc/shared';

export interface MatchableUser extends UserMatchCandidate {
  /** Raw proxyAddresses values, e.g. "SMTP:jane@x", "X500:…". */
  proxyAddresses: string[];
}

const QUOTES = /^["'`‘’“”]+|["'`‘’“”]+$/g;

/**
 * What an entry is looked up by, lowercased: "Jane Doe <jane@x>" → the
 * address, "CORP\jdoe" → the logon name, quotes and whitespace dropped.
 * Null for an entry with nothing left.
 */
export function matchKey(entry: string): string | null {
  let s = entry.trim().replace(QUOTES, '').trim();
  const address = s.match(/<([^<>]*)>$/);
  if (address) s = address[1]!.trim().replace(QUOTES, '').trim();
  s = s.replace(/^(mailto|smtp):/i, '');
  const slash = s.lastIndexOf('\\');
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

function smtpAddresses(proxyAddresses: string[]): string[] {
  return proxyAddresses.filter((v) => v.toLowerCase().startsWith('smtp:')).map((v) => v.slice(5));
}

/**
 * One result per distinct entry, in the order pasted. Logon name, UPN and
 * email (with SMTP proxy addresses) identify an account, so a match on any
 * of them wins over a display name, which several people can share.
 */
export function matchEntries(entries: string[], users: MatchableUser[]): UserMatchResult[] {
  const byIdentifier = new Map<string, MatchableUser[]>();
  const byDisplayName = new Map<string, MatchableUser[]>();
  const index = (map: Map<string, MatchableUser[]>, key: string | null, u: MatchableUser) => {
    if (!key) return;
    const k = key.toLowerCase();
    const list = map.get(k) ?? [];
    if (!list.includes(u)) list.push(u);
    map.set(k, list);
  };
  for (const u of users) {
    index(byIdentifier, u.samAccountName, u);
    index(byIdentifier, u.userPrincipalName, u);
    index(byIdentifier, u.email, u);
    for (const address of smtpAddresses(u.proxyAddresses)) index(byIdentifier, address, u);
    index(byDisplayName, u.displayName, u);
  }

  const seen = new Set<string>();
  const results: UserMatchResult[] = [];
  for (const raw of entries) {
    const key = matchKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = raw.trim();
    const found = byIdentifier.get(key) ?? byDisplayName.get(key) ?? [];
    if (found.length === 0) results.push({ entry, status: 'unmatched' });
    else if (found.length === 1)
      results.push({ entry, status: 'matched', user: candidate(found[0]!) });
    else {
      results.push({
        entry,
        status: 'ambiguous',
        candidates: found
          .map(candidate)
          .sort((a, b) => a.samAccountName.localeCompare(b.samAccountName)),
      });
    }
  }
  return results;
}

function candidate({ proxyAddresses: _, ...user }: MatchableUser): UserMatchCandidate {
  return user;
}
