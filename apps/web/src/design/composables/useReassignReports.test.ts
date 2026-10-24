// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkJob, BulkUserAttributesPreview, UserDetail, UserSummary } from '@openaduc/shared';

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

const aJob = (status: BulkJob['status'], counts: Partial<BulkJob['counts']> = {}): BulkJob => ({
  id: '9',
  action: 'user.update',
  subject: { attributes: [{ field: 'manager', value: 'Max Boss' }] },
  status,
  pauseReason: null,
  revertsJobId: null,
  actorDisplayName: 'OpenADUC Operator',
  createdAt: new Date().toISOString(),
  finishedAt: status === 'finished' ? new Date().toISOString() : null,
  counts: {
    total: 3,
    pending: 0,
    running: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    ...counts,
  },
});

const search = vi.fn();
const previewAttributeEdit = vi.fn();
const bulkJobs = { startAttributeEdit: vi.fn(), get: vi.fn(), rows: vi.fn() };
vi.mock('../../api/index.js', () => ({
  api: { users: { search, previewAttributeEdit }, bulkJobs },
}));

const { useReassignReports } = await import('./useReassignReports.js');
const { useAuthStore } = await import('../../stores/auth.js');

function setup(reports = REPORTS) {
  setActivePinia(createPinia());
  useAuthStore().actor = {
    capabilities: [],
    elevated: {
      active: true,
      idleExpiresAt: '2999-01-01T00:15:00.000Z',
      absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
    },
  } as never;
  const managerId = ref(MANAGER_ID);
  const reload = vi.fn(async () => {});
  const flow = useReassignReports({
    managerId: () => managerId.value,
    manager: () => ({ id: managerId.value, directReports: reports }),
    toast: { add: vi.fn() },
    reload,
  });
  flow.open();
  return { flow, managerId, reload };
}

const ticked = (flow: ReturnType<typeof setup>['flow']) =>
  flow.reports.value.filter((r) => flow.isSelected(r.id)).map((r) => r.id);

/** Preview a move of the ticked reports to Max Boss, then confirm it. */
async function reassignTicked(flow: ReturnType<typeof setup>['flow']) {
  await pickManager(flow, summary(NEW_MANAGER_ID, 'Max Boss'));
  await flow.review();
  flow.confirm();
  await flushPromises();
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
    localStorage.clear();
    vi.useFakeTimers();
    bulkJobs.rows.mockResolvedValue({ rows: [] });
    previewAttributeEdit.mockResolvedValue(
      aPreview({ changed: { count: 1, offset: 0, users: [] } }),
    );
  });
  afterEach(() => vi.useRealTimers());

  it('lists the reports by name, saying which are disabled, all selected', () => {
    const { flow } = setup();

    expect(flow.hasReports.value).toBe(true);
    expect(flow.reports.value).toEqual([
      { id: 'r-ann', name: 'Ann Abbot', disabled: false },
      { id: 'r-ben', name: 'Ben Baker', disabled: true },
      { id: 'r-cat', name: 'Cat Cole', disabled: false },
    ]);
    expect(flow.notListed.value).toBe(1);
    expect(ticked(flow)).toEqual(['r-ann', 'r-ben', 'r-cat']);
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

  it('says when the manager has reports but none of them is in the cache', () => {
    const { flow } = setup([REPORTS[3]!, { ...REPORTS[3]!, distinguishedName: 'CN=Also gone' }]);

    expect(flow.hasReports.value).toBe(true);
    expect(flow.reports.value).toEqual([]);
    expect(flow.notListed.value).toBe(2);
  });

  it('keeps the reports a job couldn’t change ticked, with why, when it opens again', async () => {
    const { flow } = setup();
    bulkJobs.startAttributeEdit.mockResolvedValueOnce({
      job: aJob('finished', { succeeded: 2, failed: 1 }),
    });
    bulkJobs.rows.mockImplementation(async (_id: string, status: string) => ({
      rows:
        status === 'failed'
          ? [{ targetId: 'r-ben', errorMessage: 'Access denied', errorCode: 'permission_denied' }]
          : [],
    }));
    await reassignTicked(flow);

    flow.open();

    expect(ticked(flow)).toEqual(['r-ben']);
    expect(flow.errors.value.get('r-ben')).toBe('Access denied');
  });

  it('leaves a running job behind on another user’s page, and shows it again on coming back', async () => {
    const { flow, managerId } = setup();
    bulkJobs.startAttributeEdit.mockResolvedValueOnce({ job: aJob('running', { pending: 3 }) });
    await reassignTicked(flow);
    expect(flow.job.value?.id).toBe('9');
    expect(flow.jobRunning.value).toBe(true);

    managerId.value = 'someone-else';
    await flushPromises();
    expect(flow.job.value).toBeNull();
    expect(flow.jobRunning.value).toBe(false);
    expect(flow.selectedCount.value).toBe(0);
    expect(flow.visible.value).toBe(false);
    expect(bulkJobs.get).not.toHaveBeenCalled();

    bulkJobs.get.mockResolvedValue({ job: aJob('running', { pending: 1, succeeded: 2 }) });
    managerId.value = MANAGER_ID;
    await flushPromises();
    expect(bulkJobs.get).toHaveBeenCalledWith('9');
    expect(flow.job.value?.counts.succeeded).toBe(2);
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
    const { flow } = setup();
    flow.toggle('r-cat');
    await pickManager(flow, summary(NEW_MANAGER_ID, 'Max Boss'));

    await flow.review();

    expect(previewAttributeEdit).toHaveBeenCalledExactlyOnceWith({
      ids: ['r-ann', 'r-ben'],
      changes: { manager: NEW_MANAGER_ID },
    });
    expect(flow.title.value).toBe('Reassign 2 reports?');
    expect(flow.confirmLabel.value).toBe('Reassign 1 report');

    bulkJobs.startAttributeEdit.mockResolvedValueOnce({ job: aJob('running', { pending: 2 }) });
    flow.confirm();
    await flushPromises();

    expect(bulkJobs.startAttributeEdit).toHaveBeenCalledExactlyOnceWith({
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
