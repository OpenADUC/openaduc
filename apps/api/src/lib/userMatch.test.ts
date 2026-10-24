// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { matchEntries, matchKey, type MatchableUser } from './userMatch.js';

function user(sam: string, over: Partial<MatchableUser> = {}): MatchableUser {
  return {
    id: `id-${sam}`,
    samAccountName: sam,
    userPrincipalName: `${sam}@corp.example`,
    displayName: null,
    email: null,
    department: null,
    title: null,
    enabled: true,
    distinguishedName: `CN=${sam},OU=Staff,DC=corp,DC=example`,
    proxyAddresses: [],
    ...over,
  };
}

const jane = user('jdoe', {
  displayName: 'Jane Doe',
  email: 'Jane.Doe@Example.com',
  proxyAddresses: ['SMTP:Jane.Doe@Example.com', 'smtp:jane@old.example', 'X500:/o=corp/cn=jdoe'],
});
const john = user('jsmith', { displayName: 'John Smith', department: 'Sales' });
const john2 = user('jsmith2', { displayName: 'John Smith', department: 'Engineering' });
const users = [jane, john, john2];

const one = (entry: string) => matchEntries([entry], users)[0];

describe('matchKey', () => {
  it.each([
    ['  jdoe ', 'jdoe'],
    ['"Jane Doe"', 'jane doe'],
    ["'jdoe'", 'jdoe'],
    ['Jane Doe <Jane.Doe@Example.com>', 'jane.doe@example.com'],
    ['"Doe, Jane" <jane.doe@example.com>', 'jane.doe@example.com'],
    ['<jane.doe@example.com>', 'jane.doe@example.com'],
    ['mailto:jane.doe@example.com', 'jane.doe@example.com'],
    ['CORP\\jdoe', 'jdoe'],
    ['', null],
    ['  "" ', null],
  ])('%j → %j', (entry, key) => {
    expect(matchKey(entry)).toBe(key);
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

  it('matches by logon name with a domain prefix', () => {
    expect(one('CORP\\jsmith')).toMatchObject({ status: 'matched', user: { id: 'id-jsmith' } });
  });

  it('matches by UPN', () => {
    expect(one('jsmith2@corp.example')).toMatchObject({
      status: 'matched',
      user: { id: 'id-jsmith2' },
    });
  });

  it('matches by email', () => {
    expect(one('jane.doe@example.com')).toMatchObject({
      status: 'matched',
      user: { id: 'id-jdoe' },
    });
  });

  it('matches by an SMTP proxy address, and only an SMTP one', () => {
    expect(one('jane@old.example')).toMatchObject({ status: 'matched', user: { id: 'id-jdoe' } });
    expect(one('/o=corp/cn=jdoe')).toMatchObject({ status: 'unmatched' });
  });

  it('matches by display name', () => {
    expect(one('jane doe')).toMatchObject({ status: 'matched', user: { id: 'id-jdoe' } });
  });

  it('matches "Name <email>" by the email', () => {
    expect(one('Someone Else <Jane.Doe@example.com>')).toMatchObject({
      status: 'matched',
      user: { id: 'id-jdoe' },
    });
  });

  it('reports an entry nobody has', () => {
    expect(one('nobody@example.com')).toEqual({ entry: 'nobody@example.com', status: 'unmatched' });
  });

  it('reports every user a shared display name could mean', () => {
    const result = one('John Smith');
    expect(result).toMatchObject({ status: 'ambiguous' });
    expect(result?.status === 'ambiguous' && result.candidates.map((c) => c.id)).toEqual([
      'id-jsmith',
      'id-jsmith2',
    ]);
  });

  it("prefers a logon name, UPN or email over someone else's display name", () => {
    const named = user('other', { displayName: 'jdoe' });
    expect(matchEntries(['jdoe'], [...users, named])[0]).toMatchObject({
      status: 'matched',
      user: { id: 'id-jdoe' },
    });
  });

  it('returns one result per distinct entry, in the order pasted, skipping blanks', () => {
    const results = matchEntries(['jdoe', ' JDOE ', '', 'nobody', 'Jdoe'], users);
    expect(results.map((r) => [r.entry, r.status])).toEqual([
      ['jdoe', 'matched'],
      ['nobody', 'unmatched'],
    ]);
  });
});
