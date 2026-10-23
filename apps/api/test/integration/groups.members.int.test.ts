// SPDX-License-Identifier: BUSL-1.1
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureDirectory, startApi, type TestApi, type TestClient } from './harness.js';

interface Member {
  kind: 'user' | 'group';
  id: string;
  samAccountName: string | null;
}

describe('changing a group’s members from the group page', () => {
  let api: TestApi;
  let operator: TestClient;
  let allStaff: string;
  let engineering: string;

  const groupId = async (name: string) =>
    (await operator.get(`/api/groups?q=${encodeURIComponent(name)}`))
      .json<{ rows: { id: string; name: string }[] }>()
      .rows.find((g) => g.name === name)!.id;
  const members = async (id: string) => {
    const res = await operator.get(`/api/groups/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json<{ group: { memberCount: number; members: Member[] } }>().group;
  };
  const listedCount = async (name: string) =>
    (await operator.get(`/api/groups?q=${encodeURIComponent(name)}`))
      .json<{ rows: { name: string; memberCount: number }[] }>()
      .rows.find((g) => g.name === name)!.memberCount;

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    allStaff = await groupId('All Staff');
    engineering = await groupId('Engineering');
  });

  afterAll(async () => {
    await api?.close();
  });

  it('lists groups nested in a group among its members', async () => {
    const group = await members(allStaff);

    expect(group.members).toContainEqual(
      expect.objectContaining({ kind: 'group', id: engineering, samAccountName: 'Engineering' }),
    );
    expect(group.members.map((m) => m.samAccountName).sort()).toEqual([
      'Engineering',
      'dave.diaz',
      'erin.evans',
    ]);
    expect(group.memberCount).toBe(3);
    expect(await listedCount('All Staff')).toBe(3);
  });
});
