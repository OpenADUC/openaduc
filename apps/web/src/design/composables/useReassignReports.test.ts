// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkUserAttributesPreview, UserDetail, UserSummary } from '@openaduc/shared';

const MANAGER_ID = 'a0000000-0000-4000-8000-000000000001';
const NEW_MANAGER_ID = 'a0000000-0000-4000-8000-000000000002';

const report = (id: string, displayName: string | null, enabled: boolean | null = true) => ({
  id,
  distinguishedName: `CN=${displayName ?? id},OU=Staff,DC=corp,DC=example`,
  displayName,
  enabled,
});
const REPORTS: UserDetail['directReports'] = [
  report('r-cat', 'Cat Cole'),
  report('r-ann', 'Ann Abbot'),
  report('r-ben', 'Ben Baker', false),
  {
    id: null,
    distinguishedName: 'CN=Gone,OU=Staff,DC=corp,DC=example',
    displayName: null,
    enabled: null,
  },
];

const summary = (id: string, displayName: string) =>
  ({ id, displayName, samAccountName: displayName.toLowerCase() }) as UserSummary;

const aPreview = (more: Partial<BulkUserAttributesPreview> = {}): BulkUserAttributesPreview => ({
  current: {} as BulkUserAttributesPreview['current'],
  changed: { count: 0, offset: 0, users: [] },
  unchanged: { count: 0, users: [] },
  unread: { count: 0, users: [] },
  skipped: { count: 0, users: [] },
  fields: [],
  unknownCount: 0,
  previewToken: 'tok',
  ...more,
});

const search = vi.fn();
const previewAttributeEdit = vi.fn();
vi.mock('../../api/index.js', () => ({
  api: { users: { search, previewAttributeEdit } },
}));

const { useReassignReports } = await import('./useReassignReports.js');

function setup(reports = REPORTS) {
  const start = vi.fn();
  const selected = ref(new Set<string>());
  const flow = useReassignReports({
    manager: () => ({ id: MANAGER_ID, directReports: reports }),
    selected,
    start,
  });
  flow.open();
  return { flow, start, selected };
}

async function pickManager(flow: ReturnType<typeof setup>['flow'], user: UserSummary) {
  search.mockResolvedValueOnce({ rows: [user], total: 1 });
  flow.managerQuery.value = user.displayName!;
  await nextTick();
  await vi.advanceTimersByTimeAsync(200);
  flow.chooseManager(flow.managerResults.value[0]!);
}

describe('useReassignReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    previewAttributeEdit.mockResolvedValue(
      aPreview({ changed: { count: 1, offset: 0, users: [] } }),
    );
  });
  afterEach(() => vi.useRealTimers());

  it('lists the reports by name, saying which are disabled, all selected', () => {
    const { flow, selected } = setup();

    expect(flow.reports.value).toEqual([
      { id: 'r-ann', name: 'Ann Abbot', disabled: false },
      { id: 'r-ben', name: 'Ben Baker', disabled: true },
      { id: 'r-cat', name: 'Cat Cole', disabled: false },
    ]);
    expect(flow.notListed.value).toBe(1);
    expect([...selected.value].sort()).toEqual(['r-ann', 'r-ben', 'r-cat']);
    expect(flow.selectedCount.value).toBe(3);
    expect(flow.allSelected.value).toBe(true);
  });

  it('selects some, none or all of them', () => {
    const { flow } = setup();

    flow.toggle('r-cat');
    expect(flow.isSelected('r-cat')).toBe(false);
    expect(flow.allSelected.value).toBe(false);
    flow.selectNone();
    expect(flow.selectedCount.value).toBe(0);
    flow.selectAll();
    expect(flow.selectedCount.value).toBe(3);
  });

  it('keeps the reports a job left selected when it opens again', () => {
    const { flow, selected } = setup();
    flow.close();
    selected.value = new Set(['r-ben', 'someone-else']);

    flow.open();

    expect([...selected.value]).toEqual(['r-ben']);
  });

  it('can’t preview without a report selected and a new manager chosen', async () => {
    const { flow } = setup();
    expect(flow.canPreview.value).toBe(false);

    await pickManager(flow, summary(NEW_MANAGER_ID, 'Max Boss'));
    expect(flow.newManager.value).toEqual({ id: NEW_MANAGER_ID, name: 'Max Boss' });
    expect(flow.canPreview.value).toBe(true);

    flow.selectNone();
    expect(flow.canPreview.value).toBe(false);
  });

  it('doesn’t offer the departing manager as the new one', async () => {
    const { flow } = setup();
    search.mockResolvedValueOnce({
      rows: [summary(MANAGER_ID, 'Erin Evans'), summary(NEW_MANAGER_ID, 'Max Boss')],
      total: 2,
    });
    flow.managerQuery.value = 'e';
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);

    expect(flow.managerResults.value.map((u) => u.id)).toEqual([NEW_MANAGER_ID]);
  });

  it('previews and starts the job on the selected reports only, changing only the manager', async () => {
    const { flow, start } = setup();
    flow.toggle('r-cat');
    await pickManager(flow, summary(NEW_MANAGER_ID, 'Max Boss'));

    await flow.review();

    expect(previewAttributeEdit).toHaveBeenCalledExactlyOnceWith({
      ids: ['r-ann', 'r-ben'],
      changes: { manager: NEW_MANAGER_ID },
    });
    expect(flow.title.value).toBe('Reassign 2 direct reports?');
    expect(flow.confirmLabel.value).toBe('Reassign 1 report');

    flow.confirm();

    expect(start).toHaveBeenCalledExactlyOnceWith({
      ids: ['r-ann', 'r-ben'],
      changes: { manager: NEW_MANAGER_ID },
      previewToken: 'tok',
    });
    expect(flow.visible.value).toBe(false);
  });

  it('forgets the preview when the selection or the new manager changes', async () => {
    const { flow } = setup();
    await pickManager(flow, summary(NEW_MANAGER_ID, 'Max Boss'));
    await flow.review();
    expect(flow.preview.value).not.toBeNull();

    flow.toggle('r-ann');
    expect(flow.preview.value).toBeNull();

    await flow.review();
    await pickManager(flow, summary('a0000000-0000-4000-8000-000000000003', 'Ann Other'));
    expect(flow.preview.value).toBeNull();
  });
});
