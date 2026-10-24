// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { lookupsFor, matchEntries, normalizeEntry, type MatchableUser } from './userMatch.js';

const fold = (s: string) => s.toLowerCase();

function user(
  sam: string,
  over: { displayName?: string; email?: string; department?: string; proxies?: string[] } = {},
): MatchableUser {
  const upn = `${sam}@corp.example`;
  return {
    id: `id-${sam}`,
    samAccountName: sam,
    userPrincipalName: upn,
    displayName: over.displayName ?? null,
    email: over.email ?? null,
    department: over.department ?? null,
    title: null,
    enabled: true,
    distinguishedName: `CN=${sam},OU=Staff,DC=corp,DC=example`,
    identifierKeys: [sam, upn, over.email, ...(over.proxies ?? [])]
      .filter((k): k is string => !!k)
      .map(fold),
    displayNameKey: over.displayName ? fold(over.displayName) : null,
  };
}

const jane = user('jdoe', {
  displayName: 'Jane Doe',
  email: 'Jane.Doe@Example.com',
  proxies: ['jane@old.example'],
});
const john = user('jsmith', { displayName: 'John Smith', department: 'Sales' });
const john2 = user('jsmith2', { displayName: 'John Smith', department: 'Engineering' });
const bob = user('bbaker', { displayName: 'Baker, Bob' });
const users = [jane, john, john2, bob];

const all = (entries: string[], within = users) => matchEntries(entries, within, fold);
const one = (entry: string) => all([entry])[0];
const ids = (entries: string[]) =>
  all(entries).map((r) => (r.status === 'matched' ? r.user.id : `${r.entry}: ${r.status}`));

describe('normalizeEntry', () => {
  it.each([
    ['  jdoe ', 'jdoe'],
    ['"Jane Doe"', 'Jane Doe'],
    ["'jdoe'", 'jdoe'],
    ['jdoe,', 'jdoe'],
    ['; jdoe ;', 'jdoe'],
    ['Jane Doe <Jane.Doe@Example.com>', 'Jane.Doe@Example.com'],
    ['"Doe, Jane" <jane.doe@example.com>', 'jane.doe@example.com'],
    ['<jane.doe@example.com>', 'jane.doe@example.com'],
    ['mailto:jane.doe@example.com', 'jane.doe@example.com'],
    ['CORP\\jdoe', 'jdoe'],
    ['CORP\\jdoe, CORP\\bsmith', 'CORP\\jdoe, CORP\\bsmith'],
    ['﻿jdoe​', 'jdoe'],
    ['José', 'José'],
    ['', null],
    ['  "" ,', null],
  ])('%j → %j', (entry, normalized) => {
    expect(normalizeEntry(entry)).toBe(normalized);
  });
});

describe('matchEntries', () => {
  it('matches by logon name, case-insensitively', () => {
    expect(one('JDOE')).toEqual({
      entry: 'JDOE',
      status: 'matched',
      user: expect.objectContaining({ id: 'id-jdoe' }),
    });
  });

  it('matches by logon name with a domain prefix, UPN, email and SMTP proxy address', () => {
    expect(
      ids(['CORP\\jsmith', 'jsmith2@corp.example', 'jane.doe@example.com', 'jane@old.example']),
    ).toEqual(['id-jsmith', 'id-jsmith2', 'id-jdoe', 'id-jdoe']);
  });

  it('matches by display name, and "Name <email>" by the email', () => {
    expect(ids(['jane doe', 'Someone Else <Jane.Doe@example.com>'])).toEqual([
      'id-jdoe',
      'id-jdoe',
    ]);
  });

  it('matches an entry with invisible characters or another Unicode form', () => {
    const jose = user('jose', { displayName: 'José Diaz' });
    expect(matchEntries(['﻿José Diaz​'], [jose], fold)[0]).toMatchObject({
      status: 'matched',
    });
  });

  it('looks up with the fold it is given rather than its own', () => {
    const upper = (s: string) => s.toUpperCase();
    const u = { ...jane, identifierKeys: ['JDOE'], displayNameKey: null };
    expect(matchEntries(['jdoe'], [u], upper)[0]).toMatchObject({ status: 'matched' });
  });

  it('reports an entry nobody has', () => {
    expect(one('nobody@example.com')).toEqual({ entry: 'nobody@example.com', status: 'unmatched' });
  });

  it('reports every user a shared display name could mean', () => {
    const result = one('John Smith');
    expect(result?.status === 'ambiguous' && result.candidates.map((c) => c.id)).toEqual([
      'id-jsmith',
      'id-jsmith2',
    ]);
  });

  it("prefers a logon name, UPN or email over someone else's display name", () => {
    const named = user('other', { displayName: 'jdoe' });
    expect(matchEntries(['jdoe'], [...users, named], fold)[0]).toMatchObject({
      user: { id: 'id-jdoe' },
    });
  });

  describe('an entry with commas', () => {
    it('matches "Last, First" as the display name it is', () => {
      expect(ids(['Baker, Bob'])).toEqual(['id-bbaker']);
    });

    it('matches "Last, First" as "First Last"', () => {
      expect(ids(['Doe, Jane', 'Smith, John'])).toEqual(['id-jdoe', 'Smith, John: ambiguous']);
    });

    it("splits into entries only when the whole doesn't match", () => {
      expect(ids(['jdoe, jsmith ,nobody'])).toEqual(['id-jdoe', 'id-jsmith', 'nobody: unmatched']);
    });

    it('drops a stray trailing comma rather than splitting on it', () => {
      expect(ids(['Nobody, '])).toEqual(['Nobody: unmatched']);
    });
  });

  it('returns one result per distinct entry, in the order pasted, skipping blanks', () => {
    const results = all(['jdoe', ' JDOE ', '', 'nobody', 'Jdoe,', 'jdoe, nobody']);
    expect(results.map((r) => [r.entry, r.status])).toEqual([
      ['jdoe', 'matched'],
      ['nobody', 'unmatched'],
    ]);
  });
});

describe('lookupsFor', () => {
  it('lists the whole entry, its "First Last" form and its pieces', () => {
    expect(lookupsFor(['Doe, Jane', 'CORP\\jdoe', 'jdoe', '  '])).toEqual([
      'Doe, Jane',
      'Jane Doe',
      'Doe',
      'Jane',
      'jdoe',
    ]);
  });
});
