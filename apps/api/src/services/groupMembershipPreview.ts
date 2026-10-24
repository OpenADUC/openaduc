// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type {
  BulkGroupMembershipPreview,
  BulkGroupMembershipPreviewRequest,
  BulkGroupPreviewUser,
} from '@openaduc/shared';
import type { DB } from '../db/types.js';
import { groupPrivilege, type RoleGroup } from '../lib/groupDeletion.js';
import { rawScalarValue } from '../lib/rawAttributes.js';
import { ridOf } from '../lib/sid.js';
import { findCachedGroups, type CachedGroup } from './groupCache.js';

/** How a user is in a group: in its member, as their primary group, or through a nested group. */
export type MembershipState = 'direct' | 'primary' | 'nested' | 'none';

/** True when `group` is the user's primary group, which their memberOf leaves out. */
export function isPrimaryGroup(
  group: Pick<CachedGroup, 'sid'>,
  primaryGroupId: string | null,
): boolean {
  const rid = ridOf(group.sid);
  return rid !== null && !!group.sid?.startsWith('S-1-5-21-') && primaryGroupId === String(rid);
}

/**
 * Whether a membership job leaves this user alone: an add skips members
 * already in it (a primary group's included, which AD won't add to
 * member), and a remove skips anyone not in its member.
 */
export function alreadyAsAsked(op: 'add' | 'remove', state: MembershipState): boolean {
  return op === 'add' ? state === 'direct' || state === 'primary' : state !== 'direct';
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
  const cached = await findCachedGroups(db, providerId, { ids: groupIds });
  const byGroupId = new Map(cached.map((g) => [g.id.toLowerCase(), g]));
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
  const roleOf = new Map(roleGroups.map((g) => [g.dn.toLowerCase(), g.role]));
  const known = users
    .map((u) => ({
      id: u.object_guid.toLowerCase(),
      name: u.display_name ?? u.sam_account_name ?? u.object_guid,
      primaryGroupId: rawScalarValue(u.primary_group_id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const knownIds = new Set(known.map((u) => u.id));

  return {
    op: request.op,
    unknownIds: request.ids.filter((id) => !knownIds.has(id.toLowerCase())),
    groups: groupIds.map((groupId) => {
      const group = byGroupId.get(groupId)!;
      const unchanged: BulkGroupPreviewUser[] = [];
      const indirect: BulkGroupPreviewUser[] = [];
      let changes = 0;
      for (const user of known) {
        const state: MembershipState = directSet.has(key(user.id, groupId))
          ? 'direct'
          : isPrimaryGroup(group, user.primaryGroupId)
            ? 'primary'
            : nestedSet.has(key(user.id, groupId))
              ? 'nested'
              : 'none';
        const entry = { id: user.id, name: user.name };
        if (alreadyAsAsked(request.op, state)) unchanged.push(entry);
        else changes++;
        if (state === 'nested' || (request.op === 'remove' && state === 'primary')) {
          indirect.push(entry);
        }
      }
      return {
        id: group.id,
        name: group.name,
        distinguishedName: group.distinguishedName,
        privilege: groupPrivilege(group, roleOf.get(group.distinguishedName.toLowerCase())),
        changes,
        unchanged,
        indirect,
      };
    }),
  };
}
