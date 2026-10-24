// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BULK_ATTRIBUTE_FIELDS,
  type BulkAttributeValue,
  type BulkUserAttributesPreview,
  type UserSummary,
} from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const same = (value: string | null): BulkAttributeValue => ({ kind: 'same', value });

const CURRENT = {
  ...Object.fromEntries(BULK_ATTRIBUTE_FIELDS.map((f) => [f, same(null)])),
  department: { kind: 'multiple', count: 3 },
  company: same('Initech'),
} as BulkUserAttributesPreview['current'];

const aPreview = (more: Partial<BulkUserAttributesPreview> = {}): BulkUserAttributesPreview => ({
  current: CURRENT,
  changed: { count: 0, users: [] },
  unchanged: { count: 0, users: [] },
  fields: [],
  unknownCount: 0,
  previewToken: 'tok',
  ...more,
});

const ERIN_ID = '0d6c4a8e-1b2f-4c3d-8e9f-a0b1c2d3e4f5';
const ERIN = {
  id: ERIN_ID,
  displayName: 'Erin Evans',
  samAccountName: 'erin.evans',
} as UserSummary;

const search = vi.fn();
const previewAttributeEdit = vi.fn();
vi.mock('../../api/index.js', () => ({
  api: { users: { search, previewAttributeEdit } },
}));

const { MULTIPLE_VALUES, useBulkAttributeEdit } = await import('./useBulkAttributeEdit.js');

async function setup(initial = ['u1', 'u2', 'u3']) {
  let ids = initial;
  const start = vi.fn();
  const flow = useBulkAttributeEdit({ ids: () => ids, start });
  await flow.open();
  return { flow, start, select: (next: string[]) => (ids = next) };
}

describe('useBulkAttributeEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewAttributeEdit.mockResolvedValue(aPreview());
  });
  afterEach(() => vi.useRealTimers());

  it('shows each field’s value across the users, or that they hold several', async () => {
    const { flow } = await setup();

    expect(previewAttributeEdit).toHaveBeenCalledExactlyOnceWith({
      ids: ['u1', 'u2', 'u3'],
      changes: {},
    });
    expect(flow.title.value).toBe('Edit 3 accounts');
    expect(flow.shown('department')).toBe(MULTIPLE_VALUES);
    expect(flow.shown('company')).toBe('Initech');
    expect(flow.shown('physicalDeliveryOfficeName')).toBeNull();
  });

  it('leaves a field unchanged, sets it or clears it', async () => {
    const { flow } = await setup();
    expect(flow.changes.value).toEqual({});
    expect(flow.canPreview.value).toBe(false);

    flow.setMode('department', 'set');
    flow.setValue('department', '  Sales ');
    flow.setMode('physicalDeliveryOfficeName', 'clear');
    // Setting a value they all share starts from it.
    flow.setMode('company', 'set');
    expect(flow.values.company).toBe('Initech');
    flow.setValue('company', 'Globex');

    expect(flow.changes.value).toEqual({
      department: 'Sales',
      company: 'Globex',
      physicalDeliveryOfficeName: null,
    });
    flow.setMode('company', 'keep');
    expect(flow.changes.value).not.toHaveProperty('company');
    expect(flow.canPreview.value).toBe(true);
  });

  it('says what’s wrong with a value before the preview', async () => {
    const { flow } = await setup();
    flow.setMode('department', 'set');
    flow.setMode('company', 'set');
    flow.setValue('company', 'x'.repeat(65));
    flow.setMode('manager', 'set');

    expect(flow.problems.value).toEqual({
      department: 'Enter a value, or clear it',
      company: 'At most 64 characters',
      manager: 'Choose a manager',
    });
    expect(flow.canPreview.value).toBe(false);
  });

  it('sets the manager the operator picks', async () => {
    vi.useFakeTimers();
    search.mockResolvedValue({ rows: [ERIN], total: 1 });
    const { flow } = await setup();
    flow.setMode('manager', 'set');
    flow.managerQuery.value = 'erin';
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);
    expect(flow.managerResults.value).toEqual([ERIN]);

    flow.chooseManager(ERIN);

    expect(flow.manager.value).toEqual({ id: ERIN_ID, name: 'Erin Evans' });
    expect(flow.changes.value).toEqual({ manager: ERIN_ID });
    expect(flow.problems.value).toEqual({});
  });

  it('previews the change and starts the job on what was previewed only on confirming', async () => {
    const { flow, start } = await setup();
    flow.setMode('department', 'set');
    flow.setValue('department', 'Sales');
    previewAttributeEdit.mockResolvedValueOnce(
      aPreview({
        changed: {
          count: 2,
          users: [
            {
              id: 'u1',
              name: 'Ann',
              changes: [{ field: 'department', before: 'Engineering', after: 'Sales' }],
            },
            {
              id: 'u2',
              name: 'Ben',
              changes: [{ field: 'department', before: null, after: 'Sales' }],
            },
          ],
        },
        unchanged: { count: 1, users: [{ id: 'u3', name: 'Cat' }] },
        fields: [{ field: 'department', count: 2 }],
      }),
    );

    await flow.review();

    expect(previewAttributeEdit).toHaveBeenLastCalledWith({
      ids: ['u1', 'u2', 'u3'],
      changes: { department: 'Sales' },
    });
    expect(flow.title.value).toBe('Edit 3 accounts?');
    expect(flow.confirmLabel.value).toBe('Edit 2 accounts');
    expect(start).not.toHaveBeenCalled();

    flow.confirm();

    expect(start).toHaveBeenCalledExactlyOnceWith({
      ids: ['u1', 'u2', 'u3'],
      changes: { department: 'Sales' },
      previewToken: 'tok',
    });
    expect(flow.visible.value).toBe(false);
  });

  it('has nothing to confirm when every user is already as asked', async () => {
    const { flow } = await setup();
    flow.setMode('company', 'set');
    previewAttributeEdit.mockResolvedValueOnce(
      aPreview({ unchanged: { count: 3, users: [] }, fields: [{ field: 'company', count: 0 }] }),
    );
    await flow.review();

    expect(flow.canConfirm.value).toBe(false);
  });

  it('asks again after the fields or the selection change', async () => {
    const { flow, start, select } = await setup();
    flow.setMode('title', 'clear');
    previewAttributeEdit.mockResolvedValue(aPreview({ changed: { count: 3, users: [] } }));
    await flow.review();
    flow.setMode('l', 'clear');
    expect(flow.preview.value).toBeNull();

    await flow.review();
    select(['u1']);
    flow.confirm();

    expect(start).not.toHaveBeenCalled();
    expect(flow.previewError.value).toBe(
      'The selection changed since the preview. Preview it again.',
    );
  });

  it('keeps a failed preview’s reason', async () => {
    const { flow } = await setup();
    flow.setMode('title', 'clear');
    previewAttributeEdit.mockRejectedValueOnce(
      new ApiError(422, 'unprocessable_entity', 'The manager is one of the users edited'),
    );

    await flow.review();

    expect(flow.previewError.value).toBe('The manager is one of the users edited');
    expect(flow.preview.value).toBeNull();
  });
});
