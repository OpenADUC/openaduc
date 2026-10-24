// SPDX-License-Identifier: BUSL-1.1
import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMatchCandidate, UserMatchResponse } from '@openaduc/shared';

const match = vi.fn();
vi.mock('../../api/index.js', () => ({ api: { users: { match } } }));

const { usePastedListSelection } = await import('./usePastedListSelection.js');

const person = (id: string, over: Partial<UserMatchCandidate> = {}): UserMatchCandidate => ({
  id,
  samAccountName: id,
  userPrincipalName: `${id}@corp.example`,
  displayName: null,
  email: null,
  department: null,
  title: null,
  enabled: true,
  distinguishedName: `CN=${id},OU=Staff,DC=corp,DC=example`,
  ...over,
});

const response: UserMatchResponse = {
  results: [
    { entry: 'jdoe', status: 'matched', user: person('jdoe') },
    { entry: 'jane@example.com', status: 'matched', user: person('jdoe') },
    { entry: 'Bob Baker', status: 'matched', user: person('bbaker') },
    {
      entry: 'John Smith',
      status: 'ambiguous',
      candidates: [person('jsmith'), person('jsmith2')],
    },
    { entry: 'nobody', status: 'unmatched' },
  ],
};

function setup(selected: string[] = [], loaded = ['jdoe', 'bbaker', 'jsmith', 'jsmith2']) {
  const selectedIds = ref(new Set(selected));
  const isLoaded = (id: string) => loaded.includes(id);
  return { selectedIds, paste: usePastedListSelection({ selectedIds, isLoaded }) };
}

describe('selecting users from a pasted list', () => {
  beforeEach(() => {
    match.mockReset().mockResolvedValue(response);
  });

  it('matches the entries it reads from the paste, in one request', async () => {
    const { paste } = setup();
    paste.text.value = 'jdoe\njane@example.com\nBob Baker\nJohn Smith\nnobody\njdoe';
    expect(paste.entries.value).toHaveLength(5);

    await paste.match();

    expect(match).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledWith([
      'jdoe',
      'jane@example.com',
      'Bob Baker',
      'John Smith',
      'nobody',
    ]);
    expect(paste.phase.value).toBe('review');
  });

  it('lists matched, ambiguous and unmatched entries, counting each user once', async () => {
    const { paste } = setup();
    paste.text.value = 'anything';
    await paste.match();

    expect(paste.matched.value.map((r) => r.entry)).toEqual([
      'jdoe',
      'jane@example.com',
      'Bob Baker',
    ]);
    expect(paste.ambiguous.value.map((r) => r.entry)).toEqual(['John Smith']);
    expect(paste.unmatched.value.map((r) => r.entry)).toEqual(['nobody']);
    expect(paste.selection.value).toEqual(['jdoe', 'bbaker']);
  });

  it('adds the user picked for an ambiguous entry, and can take the pick back', async () => {
    const { paste } = setup();
    paste.text.value = 'anything';
    await paste.match();

    paste.pick('John Smith', 'jsmith2');
    expect(paste.selection.value).toEqual(['jdoe', 'bbaker', 'jsmith2']);
    expect(paste.unresolved.value).toBe(0);

    paste.pick('John Smith', null);
    expect(paste.selection.value).toEqual(['jdoe', 'bbaker']);
    expect(paste.unresolved.value).toBe(1);
  });

  it('counts the disabled users among the matches', async () => {
    match.mockResolvedValueOnce({
      results: [
        ...response.results,
        { entry: 'old.account', status: 'matched', user: person('old', { enabled: false }) },
      ],
    } satisfies UserMatchResponse);
    const { paste } = setup([], ['jdoe', 'bbaker', 'old']);
    paste.text.value = 'anything';
    await paste.match();

    expect(paste.disabled.value).toBe(1);
  });

  it("leaves out users the list hasn't loaded, and says how many", async () => {
    const { paste, selectedIds } = setup([], ['jdoe', 'jsmith']);
    paste.text.value = 'anything';
    await paste.match();
    paste.pick('John Smith', 'jsmith');

    expect(paste.notLoaded.value).toBe(1);
    paste.apply('replace');
    expect([...selectedIds.value]).toEqual(['jdoe', 'jsmith']);
  });

  it('makes the matched users the selection, replacing what was selected', async () => {
    const { paste, selectedIds } = setup(['someone-else']);
    paste.text.value = 'anything';
    await paste.match();
    paste.pick('John Smith', 'jsmith');

    paste.apply('replace');

    expect([...selectedIds.value]).toEqual(['jdoe', 'bbaker', 'jsmith']);
  });

  it('can add the matched users to the selection instead', async () => {
    const { paste, selectedIds } = setup(['someone-else', 'jdoe']);
    paste.text.value = 'anything';
    await paste.match();

    paste.apply('add');

    expect([...selectedIds.value]).toEqual(['someone-else', 'jdoe', 'bbaker']);
  });

  it('refuses a paste longer than one request can match, without sending it', async () => {
    const { paste } = setup();
    paste.text.value = Array.from({ length: 1001 }, (_, i) => `user${i}`).join('\n');

    expect(paste.tooMany.value).toBe(true);
    await paste.match();
    expect(match).not.toHaveBeenCalled();
    expect(paste.phase.value).toBe('editing');
  });

  it('keeps the paste and says why when matching fails', async () => {
    match.mockRejectedValueOnce(new Error('directory unavailable'));
    const { paste } = setup();
    paste.text.value = 'jdoe';

    await paste.match();

    expect(paste.phase.value).toBe('editing');
    expect(paste.error.value).toBe('directory unavailable');
    expect(paste.text.value).toBe('jdoe');
  });

  it('goes back to the paste to fix it, forgetting the old results', async () => {
    const { paste } = setup();
    paste.text.value = 'anything';
    await paste.match();
    paste.pick('John Smith', 'jsmith');

    paste.edit();
    expect(paste.phase.value).toBe('editing');
    expect(paste.text.value).toBe('anything');

    await paste.match();
    expect(paste.selection.value).toEqual(['jdoe', 'bbaker']);
  });
});
