// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulkUserAttributesPreview } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

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
const user = (id: string) => ({
  id,
  name: id,
  changes: [{ field: 'title' as const, before: 'Lead', after: null }],
});
const changed = (count: number, offset: number, ids: string[]) => ({
  changed: { count, offset, users: ids.map(user) },
});

const previewAttributeEdit = vi.fn();
vi.mock('../../api/index.js', () => ({ api: { users: { previewAttributeEdit } } }));

const { useAttributeEditPreview } = await import('./useAttributeEditPreview.js');

/** A promise and the function that settles it, to answer a request late. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useAttributeEditPreview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for the users and changes given, and holds what it would change', async () => {
    const step = useAttributeEditPreview();
    previewAttributeEdit.mockResolvedValueOnce(aPreview(changed(2, 0, ['a', 'b'])));

    const asked = step.review(['a', 'b'], { title: null });
    expect(step.previewing.value).toBe(true);
    await asked;

    expect(previewAttributeEdit).toHaveBeenCalledExactlyOnceWith({
      ids: ['a', 'b'],
      changes: { title: null },
    });
    expect(step.previewing.value).toBe(false);
    expect(step.preview.value?.changed.count).toBe(2);
    expect(step.canConfirm.value).toBe(true);
  });

  it('can confirm only when someone may change, counting users the cache hasn’t read', async () => {
    const step = useAttributeEditPreview();
    expect(step.canConfirm.value).toBe(false);

    previewAttributeEdit.mockResolvedValueOnce(aPreview({ unchanged: { count: 2, users: [] } }));
    await step.review(['a', 'b'], { title: null });
    expect(step.canConfirm.value).toBe(false);
    expect(step.request(['a', 'b'])).toBeNull();

    previewAttributeEdit.mockResolvedValueOnce(aPreview({ unread: { count: 1, users: [] } }));
    await step.review(['a', 'b'], { title: null });
    expect(step.mayChange.value).toBe(1);
    expect(step.canConfirm.value).toBe(true);
  });

  it('forgets the preview, and drops an answer that comes in after', async () => {
    const step = useAttributeEditPreview();
    const late = deferred<BulkUserAttributesPreview>();
    previewAttributeEdit.mockReturnValueOnce(late.promise);

    const asked = step.review(['a'], { title: null });
    step.forget();
    late.resolve(aPreview(changed(1, 0, ['a'])));
    await asked;

    expect(step.preview.value).toBeNull();
    expect(step.previewing.value).toBe(false);
    expect(step.request(['a'])).toBeNull();
  });

  it('keeps a failed preview’s reason until the next one', async () => {
    const step = useAttributeEditPreview();
    previewAttributeEdit.mockRejectedValueOnce(new ApiError(404, 'not_found', 'manager not found'));

    await step.review(['a'], { manager: 'x' });
    expect(step.previewError.value).toBe('manager not found');

    previewAttributeEdit.mockResolvedValueOnce(aPreview(changed(1, 0, ['a'])));
    await step.review(['a'], { title: null });
    expect(step.previewError.value).toBeNull();
  });

  it('pages through the users it changes, on what was previewed', async () => {
    const step = useAttributeEditPreview();
    previewAttributeEdit
      .mockResolvedValueOnce(aPreview(changed(3, 0, ['a'])))
      .mockResolvedValueOnce(aPreview(changed(3, 1, ['b', 'c'])));
    await step.review(['a', 'b', 'c'], { title: null });
    expect(step.hasMore.value).toBe(true);

    await step.showMore();

    expect(previewAttributeEdit).toHaveBeenLastCalledWith({
      ids: ['a', 'b', 'c'],
      changes: { title: null },
      offset: 1,
    });
    expect(step.preview.value?.changed.users.map((u) => u.id)).toEqual(['a', 'b', 'c']);
    expect(step.hasMore.value).toBe(false);
    expect(step.loadingMore.value).toBe(false);
  });

  it('says to preview again when the users changed between pages', async () => {
    const step = useAttributeEditPreview();
    previewAttributeEdit
      .mockResolvedValueOnce(aPreview(changed(3, 0, ['a'])))
      .mockResolvedValueOnce(aPreview({ ...changed(3, 1, ['b']), previewToken: 'other' }));
    await step.review(['a', 'b', 'c'], { title: null });

    await step.showMore();

    expect(step.preview.value).toBeNull();
    expect(step.previewError.value).toBe('The users changed since the preview. Preview it again.');
  });

  it('starts the job only on the users previewed, with its token', async () => {
    const step = useAttributeEditPreview();
    previewAttributeEdit.mockResolvedValueOnce(aPreview(changed(2, 0, ['a', 'b'])));
    await step.review(['a', 'b'], { title: null });

    // The order doesn't matter.
    expect(step.request(['b', 'a'])).toEqual({
      ids: ['a', 'b'],
      changes: { title: null },
      previewToken: 'tok',
    });
    expect(step.request(['a'])).toBeNull();
    expect(step.preview.value).toBeNull();
    expect(step.previewError.value).toBe(
      'The selection changed since the preview. Preview it again.',
    );
  });
});
