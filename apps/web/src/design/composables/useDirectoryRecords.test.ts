// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const users = { get: vi.fn() };
const groups = { get: vi.fn() };
const computers = { get: vi.fn() };
vi.mock('../../api/index.js', () => ({ api: { users, groups, computers } }));

const { useUserRecord, useGroupRecord, useComputerRecord } =
  await import('./useDirectoryRecords.js');

const kinds = [
  {
    kind: 'user',
    use: useUserRecord,
    get: users.get,
    answer: (id: string) => ({ user: { id } }),
    notFound: 'User not found',
  },
  {
    kind: 'group',
    use: useGroupRecord,
    get: groups.get,
    answer: (id: string) => ({ group: { id } }),
    notFound: 'Group not found',
  },
  {
    kind: 'computer',
    use: useComputerRecord,
    get: computers.get,
    answer: (id: string) => ({ computer: { id } }),
    notFound: 'Computer not found',
  },
] as const;

describe.each(kinds)('loading a $kind', ({ use, get, answer, notFound }) => {
  beforeEach(() => vi.clearAllMocks());

  it('loads it by id and hands it over', async () => {
    get.mockResolvedValueOnce(answer('x1'));
    const onLoaded = vi.fn();
    const detail = use({ id: () => 'x1', onLoaded });
    await detail.load();
    expect(get).toHaveBeenCalledWith('x1');
    expect(detail.record.value).toEqual({ id: 'x1' });
    expect(onLoaded).toHaveBeenCalledWith({ id: 'x1' });
  });

  it('says it is gone when the directory no longer has it', async () => {
    get.mockRejectedValueOnce(new ApiError(404, 'not_found', 'no such object'));
    const detail = use({ id: () => 'x1' });
    await detail.load();
    expect(detail.record.value).toBeNull();
    expect(detail.error.value).toBe(notFound);
  });
});
