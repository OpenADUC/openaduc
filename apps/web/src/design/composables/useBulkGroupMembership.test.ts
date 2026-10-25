// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BulkGroupMembershipPreview,
  BulkGroupPreviewGroup,
  GroupSummary,
} from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const aGroup = (id: string, name: string): GroupSummary => ({
  id,
  name,
  samAccountName: name,
  distinguishedName: `CN=${name},DC=corp,DC=example`,
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 0,
});
const SALES = aGroup('g1', 'Sales');
const ADMINS = aGroup('g2', 'Domain Admins');

/** Users as a preview lists them: these, of `count` in all. */
const listed = (names: string[], count = names.length) => ({
  count,
  users: names.map((name) => ({ id: name.toLowerCase(), name })),
});

const previewed = (
  id: string,
  name: string,
  more: Partial<BulkGroupPreviewGroup> = {},
): BulkGroupPreviewGroup => ({
  id,
  name,
  distinguishedName: `CN=${name},DC=corp,DC=example`,
  privilege: null,
  changes: 0,
  unchanged: listed([]),
  indirect: listed([]),
  ...more,
});

const aPreview = (
  op: BulkGroupMembershipPreview['op'],
  groups: BulkGroupPreviewGroup[],
): BulkGroupMembershipPreview => ({ op, groups, unknownCount: 0, previewToken: 'tok' });

const search = vi.fn();
const previewGroupChange = vi.fn();
vi.mock('../../api/index.js', () => ({
  api: { groups: { search }, users: { previewGroupChange } },
}));

const { describeGroupPreview, useBulkGroupMembership } =
  await import('./useBulkGroupMembership.js');

function setup(initial = ['u1', 'u2', 'u3', 'u4']) {
  let ids = initial;
  const start = vi.fn();
  const flow = useBulkGroupMembership({ ids: () => ids, start });
  return { flow, start, select: (next: string[]) => (ids = next) };
}

async function find(flow: ReturnType<typeof setup>['flow'], q: string) {
  flow.query.value = q;
  await nextTick();
  await vi.advanceTimersByTimeAsync(200);
}

describe('useBulkGroupMembership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    search.mockResolvedValue({ rows: [SALES, ADMINS], total: 2 });
  });
  afterEach(() => vi.useRealTimers());

  it('picks groups, previews what adding would do, and starts the job only on confirming', async () => {
    const { flow, start } = setup();
    previewGroupChange.mockResolvedValue(
      aPreview('add', [
        previewed('g1', 'Sales', {
          changes: 2,
          unchanged: listed(['Ann', 'Ben']),
          indirect: listed(['Cat']),
        }),
        previewed('g2', 'Domain Admins', { changes: 4, privilege: { reason: 'protected' } }),
      ]),
    );

    flow.open();
    expect(flow.title.value).toBe('Add 4 accounts to groups');
    await find(flow, 'sa');
    expect(search).toHaveBeenCalledWith({ q: 'sa', pageSize: 12 });
    flow.choose(SALES);
    flow.choose(ADMINS);
    flow.choose(SALES);
    expect(flow.chosen.value.map((g) => g.id)).toEqual(['g1', 'g2']);

    await flow.review();
    expect(previewGroupChange).toHaveBeenCalledExactlyOnceWith({
      op: 'add',
      ids: ['u1', 'u2', 'u3', 'u4'],
      groupIds: ['g1', 'g2'],
    });
    expect(flow.title.value).toBe('Add 4 accounts to Sales and Domain Admins?');
    expect(flow.confirmLabel.value).toBe('Add to 2 groups');
    expect(flow.lines.value.map((l) => [l.summary, l.indirect, l.warning])).toEqual([
      [
        '2 will be added · 2 are already members',
        '1 user is in it only through a nested group; they’ll be added directly.',
        null,
      ],
      [
        '4 will be added · 0 are already members',
        null,
        'Administrative group: its members get admin rights in AD.',
      ],
    ]);
    expect(start).not.toHaveBeenCalled();

    // Domain Admins is protected: confirming takes the operator's say-so.
    expect(flow.acknowledgement.value).toBe(
      'I understand these users gain admin rights in AD through Domain Admins.',
    );
    expect(flow.canConfirm.value).toBe(false);
    flow.confirm();
    expect(start).not.toHaveBeenCalled();
    flow.acknowledged.value = true;
    flow.confirm();
    expect(start).toHaveBeenCalledExactlyOnceWith({
      op: 'add',
      ids: ['u1', 'u2', 'u3', 'u4'],
      groupIds: ['g1', 'g2'],
      previewToken: 'tok',
      acknowledgeProtected: true,
    });
    expect(flow.visible.value).toBe(false);
  });

  it('won’t add members to a role group for an operator who can’t hand out roles', async () => {
    const start = vi.fn();
    const flow = useBulkGroupMembership({ ids: () => ['u1'], start, canGrantRoles: () => false });
    previewGroupChange.mockResolvedValue(
      aPreview('add', [
        previewed('g1', 'Operators', {
          changes: 1,
          privilege: { reason: 'role', role: 'operator' },
        }),
      ]),
    );
    flow.open();
    flow.choose(SALES);
    await flow.review();

    expect(flow.lines.value[0]!.blocked).toMatch(/configure:security/);
    expect(flow.canConfirm.value).toBe(false);
    flow.confirm();
    expect(start).not.toHaveBeenCalled();

    // Taking members out of it is fine.
    flow.setOp('remove');
    previewGroupChange.mockResolvedValue(
      aPreview('remove', [
        previewed('g1', 'Operators', {
          changes: 1,
          privilege: { reason: 'role', role: 'operator' },
        }),
      ]),
    );
    await flow.review();
    expect(flow.canConfirm.value).toBe(true);
  });

  it('won’t start on a selection that changed since the preview', async () => {
    const { flow, start, select } = setup(['u1', 'u2']);
    previewGroupChange.mockResolvedValue(
      aPreview('add', [previewed('g1', 'Sales', { changes: 2 })]),
    );
    flow.open();
    flow.choose(SALES);
    await flow.review();

    select(['u1', 'u2', 'u3']);
    flow.confirm();

    expect(start).not.toHaveBeenCalled();
    expect(flow.preview.value).toBeNull();
    expect(flow.previewError.value).toBe(
      'The selection changed since the preview. Preview it again.',
    );
  });

  it('asks again when the groups or the change are different from what it previewed', async () => {
    const { flow } = setup();
    previewGroupChange.mockResolvedValue(
      aPreview('add', [previewed('g1', 'Sales', { changes: 1 })]),
    );
    flow.open();
    flow.choose(SALES);
    await flow.review();
    expect(flow.preview.value).not.toBeNull();

    flow.setOp('remove');
    expect(flow.preview.value).toBeNull();
    expect(flow.title.value).toBe('Remove 4 accounts from groups');
    await flow.review();
    expect(previewGroupChange).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'remove' }));

    flow.unchoose('g1');
    expect(flow.preview.value).toBeNull();
    expect(flow.canPreview.value).toBe(false);
  });

  it('starts nothing when every user is already as asked', async () => {
    const { flow, start } = setup(['u1']);
    previewGroupChange.mockResolvedValue(
      aPreview('remove', [previewed('g1', 'Sales', { unchanged: listed(['Ann']) })]),
    );
    flow.open('remove');
    flow.choose(SALES);
    await flow.review();

    expect(flow.changes.value).toBe(0);
    flow.confirm();
    expect(start).not.toHaveBeenCalled();
  });

  it('says why the preview failed, and stays on the groups', async () => {
    const { flow } = setup();
    previewGroupChange.mockRejectedValue(new ApiError(404, 'not_found', 'group not found'));
    flow.open();
    flow.choose(SALES);
    await flow.review();

    expect(flow.preview.value).toBeNull();
    expect(flow.previewError.value).toBe('group not found');
  });

  it('describes a remove, who stays in through nesting, and who the preview doesn’t list', () => {
    const line = describeGroupPreview(
      'remove',
      previewed('g1', 'Staff', {
        changes: 1,
        unchanged: listed(['Ben', 'Cat'], 60),
        indirect: listed(['Ben', 'Cat']),
        privilege: { reason: 'role', role: 'operator' },
      }),
    );

    expect(line).toMatchObject({
      summary: '1 will be removed · 60 aren’t members',
      indirect:
        '2 users are in it through a nested group or as their primary group, and will stay in it.',
      warning: 'Gives its members OpenADUC’s Operator role.',
      unchangedLabel: 'Not members',
      unlisted: 58,
    });
  });
});
