// SPDX-License-Identifier: BUSL-1.1
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  type BulkGroupMembershipPreview,
  type BulkGroupMembershipPreviewRequest,
  type BulkMembershipOp,
} from '@openaduc/shared';
import type { DB } from '../db/types.js';
import { groupPrivilege, type RoleGroup } from '../lib/groupPrivilege.js';
import { rawScalarValue } from '../lib/rawAttributes.js';
import { findCachedGroupsById } from './groupCache.js';
import { previewList } from './previewList.js';
import { alreadyAsAsked, membershipState } from './membershipState.js';
import { cachedUserName } from './userCache.js';

/**
 * Names this op on these users and groups, whatever their order or case,
 * so the job can check it runs on what the operator previewed. Not a
 * secret: it guards against a stale preview, not a forged one.
 */
export function previewToken(
  op: BulkMembershipOp,
  ids: readonly string[],
  groupIds: readonly string[],
): string {
  const set = (xs: readonly string[]) => [...xs.map((x) => x.toLowerCase())].sort().join(',');
  return createHash('sha256')
    .update(`${op}\n${set(ids)}\n${set(groupIds)}`)
    .digest('base64url');
}

/**
 * What adding these users to these groups, or removing them, would change,
 * read from the cache before anything is written. Null when a group isn't
 * one the cache knows.
 */
export async function previewGroupMembership(
  db: Kysely<DB>,
  providerId: number,
  request: BulkGroupMembershipPreviewRequest,
  roleGroups: readonly RoleGroup[],
): Promise<BulkGroupMembershipPreview | null> {
  const ids = request.ids.map((id) => id.toLowerCase());
  const groupIds = request.groupIds.map((id) => id.toLowerCase());
  const byGroupId = await findCachedGroupsById(db, providerId, groupIds);
  if (groupIds.some((id) => !byGroupId.has(id))) return null;

  const users = await db
    .selectFrom('user_cache_records')
    .select([
      'object_guid',
      'display_name',
      'sam_account_name',
      sql<unknown>`raw_attributes_json -> 'primaryGroupID'`.as('primary_group_id'),
    ])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`object_guid = ANY(${ids}::uuid[])`)
    .execute();

  // Direct memberships, then those through groups nested (at any depth) in
  // the target groups; UNION stops at a nesting loop.
  const direct = await db
    .selectFrom('user_group_memberships')
    .select(['user_object_guid as user_id', 'group_object_guid as group_id'])
    .where('provider_id', '=', providerId)
    .where('direct', '=', true)
    .where(sql<boolean>`user_object_guid = ANY(${ids}::uuid[])`)
    .where(sql<boolean>`group_object_guid = ANY(${groupIds}::uuid[])`)
    .execute();
  const { rows: nested } = await sql<{ user_id: string; group_id: string }>`
    WITH RECURSIVE inside(group_id, member_id) AS (
      SELECT group_object_guid, member_group_object_guid
        FROM group_group_memberships
       WHERE provider_id = ${providerId} AND group_object_guid = ANY(${groupIds}::uuid[])
      UNION
      SELECT i.group_id, g.member_group_object_guid
        FROM inside i
        JOIN group_group_memberships g
          ON g.provider_id = ${providerId} AND g.group_object_guid = i.member_id
    )
    SELECT DISTINCT m.user_object_guid AS user_id, i.group_id
      FROM inside i
      JOIN user_group_memberships m
        ON m.provider_id = ${providerId} AND m.group_object_guid = i.member_id
     WHERE m.user_object_guid = ANY(${ids}::uuid[])
  `.execute(db);

  const key = (userId: string, groupId: string) =>
    `${userId.toLowerCase()} ${groupId.toLowerCase()}`;
  const directSet = new Set(direct.map((m) => key(m.user_id, m.group_id)));
  const nestedSet = new Set(nested.map((m) => key(m.user_id, m.group_id)));
  const known = users
    .map((u) => ({
      id: u.object_guid.toLowerCase(),
      name: cachedUserName(u, u.object_guid),
      primaryGroupId: rawScalarValue(u.primary_group_id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const knownIds = new Set(known.map((u) => u.id));

  return {
    op: request.op,
    unknownCount: request.ids.filter((id) => !knownIds.has(id.toLowerCase())).length,
    previewToken: previewToken(request.op, request.ids, request.groupIds),
    groups: groupIds.map((groupId) => {
      const group = byGroupId.get(groupId)!;
      const unchanged = previewList();
      const indirect = previewList();
      let changes = 0;
      for (const user of known) {
        const state = membershipState(group, {
          primaryGroupId: user.primaryGroupId,
          direct: directSet.has(key(user.id, groupId)),
          nested: nestedSet.has(key(user.id, groupId)),
        });
        const entry = { id: user.id, name: user.name };
        if (alreadyAsAsked(request.op, state)) unchanged.add(entry);
        else changes++;
        if (state === 'nested' || (request.op === 'remove' && state === 'primary')) {
          indirect.add(entry);
        }
      }
      return {
        id: group.id,
        name: group.name,
        distinguishedName: group.distinguishedName,
        privilege: groupPrivilege(group, roleGroups),
        changes,
        unchanged: unchanged.list,
        indirect: indirect.list,
      };
    }),
  };
}
