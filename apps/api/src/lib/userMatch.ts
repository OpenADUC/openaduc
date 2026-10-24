// SPDX-License-Identifier: BUSL-1.1
import type { UserMatchCandidate, UserMatchResult } from '@openaduc/shared';

export interface MatchableUser extends UserMatchCandidate {
  /** Logon name, UPN, email and SMTP proxy addresses, case-folded by `fold`. */
  identifierKeys: string[];
  displayNameKey: string | null;
}

const INVISIBLE = /[​-‍⁠﻿]/g;
const EDGES = /^[\s,;"'`‘’“”]+|[\s,;"'`‘’“”]+$/g;

/** An entry as written, without stray whitespace, quotes or separators. */
export function cleanEntry(entry: string): string {
  return entry.normalize('NFC').replace(INVISIBLE, '').replace(EDGES, '');
}

/**
 * What an entry is looked up by, before case-folding: "Jane Doe <jane@x>"
 * → the address, "CORP\jdoe" → the logon name. Null when nothing's left.
 */
export function normalizeEntry(entry: string): string | null {
  let s = cleanEntry(entry);
  const address = s.match(/^[^<>]*<([^<>]*)>$/);
  if (address) s = cleanEntry(address[1]!);
  s = s.replace(/^(mailto|smtp):/i, '');
  const domainSam = s.match(/^[^\\\s,]+\\([^\\\s,]+)$/);
  if (domainSam) s = domainSam[1]!;
  return s.length > 0 ? s : null;
}

/**
 * The fallbacks for an entry with commas that doesn't match as a whole:
 * "Doe, Jane" as the display name "Jane Doe", then each piece as an entry
 * of its own ("jdoe, bsmith").
 */
function commaFallbacks(whole: string): { reordered: string | null; pieces: string[] } {
  if (!whole.includes(',')) return { reordered: null, pieces: [] };
  const parts = whole.split(',').map((p) => p.trim());
  const reordered = parts.length === 2 && parts.every(Boolean) ? `${parts[1]} ${parts[0]}` : null;
  const pieces = parts.map(normalizeEntry).filter((p): p is string => p !== null);
  return { reordered, pieces: pieces.length > 1 ? pieces : [] };
}

/** Every string `matchEntries` may look up for these entries, to fold up front. */
export function lookupsFor(entries: string[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    const whole = normalizeEntry(entry);
    if (!whole) continue;
    out.add(whole);
    const { reordered, pieces } = commaFallbacks(whole);
    if (reordered) out.add(reordered);
    for (const p of pieces) out.add(p);
  }
  return [...out];
}

/**
 * One result per distinct entry, in the order pasted. Logon name, UPN and
 * email identify an account, so they win over a display name, which
 * several people can share. `fold` case-folds a lookup the way the users'
 * keys were folded.
 */
export function matchEntries(
  entries: string[],
  users: MatchableUser[],
  fold: (s: string) => string,
): UserMatchResult[] {
  const byIdentifier = new Map<string, MatchableUser[]>();
  const byDisplayName = new Map<string, MatchableUser[]>();
  const index = (map: Map<string, MatchableUser[]>, key: string | null, u: MatchableUser) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.includes(u)) list.push(u);
    map.set(key, list);
  };
  for (const u of users) {
    for (const key of u.identifierKeys) index(byIdentifier, key, u);
    index(byDisplayName, u.displayNameKey, u);
  }

  const seen = new Set<string>();
  const results: UserMatchResult[] = [];
  const resolve = (entry: string, whole: string) => {
    const key = fold(whole);
    if (seen.has(key)) return;
    seen.add(key);
    let found = byIdentifier.get(key) ?? byDisplayName.get(key);
    if (!found) {
      const { reordered, pieces } = commaFallbacks(whole);
      found = reordered ? byDisplayName.get(fold(reordered)) : undefined;
      if (!found && pieces.length > 0) {
        for (const piece of pieces) resolve(piece, piece);
        return;
      }
    }
    if (!found) results.push({ entry, status: 'unmatched' });
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
  };
  for (const raw of entries) {
    const whole = normalizeEntry(raw);
    if (whole) resolve(cleanEntry(raw), whole);
  }
  return results;
}

function candidate({
  identifierKeys: _keys,
  displayNameKey: _name,
  ...user
}: MatchableUser): UserMatchCandidate {
  return user;
}
