// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type {
  BulkAccountOp,
  BulkAccountPreview,
  BulkAccountPreviewUser,
  DirectoryOu,
} from '@openaduc/shared';

const listed = (names: string[], count = names.length) => ({
  count,
  users: names.map((name) => ({ id: name.toLowerCase(), name })),
});
const changing = (users: [string, string | null][], count = users.length, offset = 0) => ({
  count,
  offset,
  users: users.map(([name, from]): BulkAccountPreviewUser => ({
    id: name.toLowerCase(),
    name,
    from,
  })),
});
const aPreview = (more: Partial<BulkAccountPreview>): BulkAccountPreview => ({
  op: 'move',
  changed: changing([]),
  unchanged: listed([]),
  notes: [],
  ou: null,
  unknownCount: 0,
  previewToken: 'tok',
  ...more,
});
const ou = (name: string, parentDn: string | null = 'DC=corp'): DirectoryOu =>
  ({
    distinguishedName: `OU=${name},DC=corp`,
    name,
    parentDn,
    description: null,
    stale: false,
  }) as DirectoryOu;
const LEAVERS = ou('Leavers');

const previewAccountChange = vi.fn();
const listOus = vi.fn();
vi.mock('../../api/index.js', () => ({
  api: { users: { previewAccountChange }, ous: { list: listOus } },
}));

const { useBulkAccountChange } = await import('./useBulkAccountChange.js');

const ALL: BulkAccountOp[] = [
  'move',
  'accountExpiry',
  'mustChangePassword',
  'clearPasswordNeverExpires',
];

function setup(initial = ['ann', 'ben', 'cat'], allowed = ALL) {
  let ids = initial;
  const start = vi.fn();
  const flow = useBulkAccountChange({ ids: () => ids, start, allowed: () => allowed });
  return { flow, start, select: (next: string[]) => (ids = next) };
}

describe('useBulkAccountChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOus.mockResolvedValue({ ous: [LEAVERS, ou('Staff')] });
  });
  afterEach(() => vi.useRealTimers());

  it('moves to the OU picked, after previewing who it moves and who is there already', async () => {
    const { flow, start } = setup();
    flow.open('move');
    await flushPromises();
    expect(listOus).toHaveBeenCalledOnce();
    expect(flow.ous.value.map((o) => o.name)).toEqual(['Leavers', 'Staff']);
    expect(flow.choices.value).toEqual([]);
    expect(flow.canPreview.value).toBe(false);
    expect(flow.title.value).toBe('Move 3 accounts to an OU');

    flow.setDestination(LEAVERS.distinguishedName);
    previewAccountChange.mockResolvedValue(
      aPreview({
        changed: changing([
          ['Ann', 'OU=Staff,DC=corp'],
          ['Ben', 'CN=Users,DC=corp'],
        ]),
        unchanged: listed(['Cat']),
        notes: [{ kind: 'name_taken', ...listed(['Ben']) }],
        ou: { distinguishedName: LEAVERS.distinguishedName, name: 'Leavers' },
      }),
    );
    await flow.review();

    expect(previewAccountChange).toHaveBeenCalledWith({
      ids: ['ann', 'ben', 'cat'],
      change: { op: 'move', targetOuDn: LEAVERS.distinguishedName },
    });
    expect(flow.title.value).toBe('Move 3 accounts to Leavers?');
    expect(flow.summary.value).toBe('2 will be moved · 1 is already in Leavers');
    expect(flow.notes.value.map((n) => n.text)).toEqual([
      '1 user has a name already taken in Leavers, or shared with another user being moved, so that move will fail. Rename them first.',
    ]);
    expect(flow.effect.value).toMatch(/group memberships and GUIDs stay the same/);
    expect(flow.confirmLabel.value).toBe('Move 2 accounts');
    expect(start).not.toHaveBeenCalled();

    flow.confirm();
    expect(start).toHaveBeenCalledExactlyOnceWith({
      ids: ['ann', 'ben', 'cat'],
      change: { op: 'move', targetOuDn: LEAVERS.distinguishedName },
      previewToken: 'tok',
    });
    expect(flow.visible.value).toBe(false);
  });

  it('expires the accounts at the end of the day picked, or never, and not on a day gone', async () => {
    vi.useFakeTimers({ now: new Date(2030, 5, 15, 12), toFake: ['Date'] });
    const { flow, start } = setup();
    flow.open('accountExpiry');
    expect(flow.change.value).toBeNull();

    flow.setEndOf(new Date(2030, 5, 14));
    expect(flow.canPreview.value).toBe(false);

    const endOfDay = new Date(2030, 6, 2).toISOString();
    flow.setEndOf(new Date(2030, 6, 1));
    expect(flow.change.value).toEqual({ op: 'accountExpiry', expiresAt: endOfDay });
    previewAccountChange.mockResolvedValue(
      aPreview({
        op: 'accountExpiry',
        changed: changing([
          ['Ann', null],
          ['Ben', new Date(2031, 0, 1).toISOString()],
        ]),
        unchanged: listed(['Cat']),
      }),
    );
    await flow.review();
    expect(flow.summary.value).toBe('2 will change · 1 already expires then');
    expect(flow.effect.value).toBe(
      `They can sign in until the end of ${new Date(2030, 6, 1).toLocaleDateString()}.`,
    );

    flow.setNever(true);
    expect(flow.preview.value).toBeNull();
    expect(flow.change.value).toEqual({ op: 'accountExpiry', expiresAt: null });
    previewAccountChange.mockResolvedValue(
      aPreview({
        op: 'accountExpiry',
        changed: changing([['Ben', endOfDay]]),
        unchanged: listed(['Ann', 'Cat']),
      }),
    );
    await flow.review();
    expect(flow.summary.value).toBe('1 will change · 2 already never expire');
    flow.confirm();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ change: { op: 'accountExpiry', expiresAt: null } }),
    );
  });

  it('offers only the account settings the operator may change, switching between them', async () => {
    const { flow } = setup(['ann'], ['move', 'mustChangePassword']);
    flow.open('mustChangePassword');
    expect(flow.choices.value).toEqual(['mustChangePassword']);
    flow.setOp('clearPasswordNeverExpires');
    expect(flow.op.value).toBe('mustChangePassword');

    const all = setup(['ann']).flow;
    all.open('accountExpiry');
    expect(all.choices.value).toEqual([
      'accountExpiry',
      'mustChangePassword',
      'clearPasswordNeverExpires',
    ]);
    all.setOp('mustChangePassword');
    expect(all.change.value).toEqual({ op: 'mustChangePassword' });
    expect(all.title.value).toBe('Make 1 account change their password');
  });

  it('says who must-change won’t reach: never-expires and random-password users', async () => {
    const { flow } = setup();
    flow.open('mustChangePassword');
    previewAccountChange.mockResolvedValue(
      aPreview({
        op: 'mustChangePassword',
        changed: changing([
          ['Ann', null],
          ['Ben', null],
        ]),
        unchanged: listed(['Cat']),
        notes: [
          { kind: 'never_expires', ...listed(['Ann']) },
          { kind: 'random_password', ...listed(['Ben', 'Dee']) },
        ],
      }),
    );
    await flow.review();

    expect(flow.summary.value).toBe('2 will have to change their password · 1 already has to');
    expect(flow.notes.value.map((n) => n.text)).toEqual([
      '1 user has a password that never expires. AD doesn’t ask for a change while that’s set, so clear “password never expires” for them too.',
      '2 users were created with a random password nobody saw, and sign in through Entra. Must-change stops a synced user signing in to Entra unless Connect Sync’s force-change option is on.',
    ]);
    expect(flow.confirmLabel.value).toBe('Require change for 2 accounts');
  });

  it('says clearing never-expires asks users already due to change at next sign-in', async () => {
    const { flow } = setup();
    flow.open('clearPasswordNeverExpires');
    previewAccountChange.mockResolvedValue(
      aPreview({
        op: 'clearPasswordNeverExpires',
        changed: changing([['Ann', null]]),
        unchanged: listed(['Ben', 'Cat']),
        notes: [{ kind: 'must_change', ...listed(['Ann']) }],
      }),
    );
    await flow.review();

    expect(flow.summary.value).toBe('1 will have a password that expires · 2 already do');
    expect(flow.notes.value[0]!.text).toMatch(/already has to change their password/);
    expect(flow.effect.value).toMatch(/older than its maximum age/);
  });

  it('pages through the users it changes, and starts over if they changed meanwhile', async () => {
    const { flow } = setup();
    flow.open('mustChangePassword');
    previewAccountChange.mockResolvedValueOnce(aPreview({ changed: changing([['Ann', null]], 3) }));
    await flow.review();
    expect(flow.hasMore.value).toBe(true);

    previewAccountChange.mockResolvedValueOnce(
      aPreview({ changed: changing([['Ben', null]], 3, 1) }),
    );
    await flow.showMore();
    expect(previewAccountChange).toHaveBeenLastCalledWith({
      ids: ['ann', 'ben', 'cat'],
      change: { op: 'mustChangePassword' },
      offset: 1,
    });
    expect(flow.preview.value!.changed.users.map((u) => u.name)).toEqual(['Ann', 'Ben']);

    previewAccountChange.mockResolvedValueOnce(
      aPreview({ changed: changing([['Cat', null]], 3, 2), previewToken: 'other' }),
    );
    await flow.showMore();
    expect(flow.preview.value).toBeNull();
    expect(flow.previewError.value).toMatch(/Preview it again/);
  });

  it('won’t start on a selection that changed since the preview, nor with nothing to change', async () => {
    const { flow, start, select } = setup();
    flow.open('mustChangePassword');
    previewAccountChange.mockResolvedValue(aPreview({ unchanged: listed(['Ann', 'Ben', 'Cat']) }));
    await flow.review();
    expect(flow.canConfirm.value).toBe(false);
    flow.confirm();
    expect(start).not.toHaveBeenCalled();

    previewAccountChange.mockResolvedValue(aPreview({ changed: changing([['Ann', null]]) }));
    await flow.review();
    select(['ann']);
    flow.confirm();
    expect(start).not.toHaveBeenCalled();
    expect(flow.previewError.value).toBe(
      'The selection changed since the preview. Preview it again.',
    );
  });
});
