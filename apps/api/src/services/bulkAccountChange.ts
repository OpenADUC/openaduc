// SPDX-License-Identifier: BUSL-1.1
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type {
  BulkAccountChange,
  BulkAccountNote,
  BulkAccountPreview,
  BulkAccountPreviewUser,
  BulkJobSubject,
  PreviewUser,
} from '@openaduc/shared';
import type { DB } from '../db/types.js';
import { parentDn } from '../providers/active-directory/normalize.js';
import { BulkJobRequestError } from './bulkJobs/errors.js';
import { findCachedOu } from './ouCache.js';
import { previewList } from './previewList.js';
import {
  CLEAR_PASSWORD_NEVER_EXPIRES,
  expireAccountAt,
  moveUserTo,
  REQUIRE_PASSWORD_CHANGE,
  type AccountState,
  type AccountWrite,
} from './userAccountWrite.js';
import { cachedUserName } from './userCache.js';

/** An account change with what it names looked up: a move's OU as the cache has it. */
export type ResolvedAccountChange =
  | { op: 'move'; ou: { distinguished_name: string; name: string } }
  | { op: 'accountExpiry'; expiresAt: Date | null }
  | { op: 'mustChangePassword' }
  | { op: 'clearPasswordNeverExpires' };

/** Refuses a move to an OU the cache doesn't know. */
export async function resolveAccountChange(
  db: Kysely<DB>,
  providerId: number,
  change: BulkAccountChange,
): Promise<ResolvedAccountChange> {
  switch (change.op) {
    case 'move': {
      const ou = await findCachedOu(db, providerId, change.targetOuDn);
      if (!ou) throw new BulkJobRequestError('ou_not_found', 'OU not found');
      return { op: 'move', ou };
    }
    case 'accountExpiry':
      return {
        op: 'accountExpiry',
        expiresAt: change.expiresAt === null ? null : new Date(change.expiresAt),
      };
    default:
      return change;
  }
}

/** The single-user write the change makes to each user, the same as its route's. */
export function accountWrite(change: ResolvedAccountChange): AccountWrite {
  switch (change.op) {
    case 'move':
      return moveUserTo(change.ou);
    case 'accountExpiry':
      return expireAccountAt(change.expiresAt);
    case 'mustChangePassword':
      return REQUIRE_PASSWORD_CHANGE;
    case 'clearPasswordNeverExpires':
      return CLEAR_PASSWORD_NEVER_EXPIRES;
  }
}

/** What the job's audit entry and progress say it does. */
export function accountChangeSubject(change: ResolvedAccountChange): BulkJobSubject | null {
  if (change.op === 'move') return { ou: ouOf(change.ou) };
  if (change.op === 'accountExpiry') return { expiresAt: change.expiresAt?.toISOString() ?? null };
  return null;
}

/**
 * Names this change of these users, whatever their order or case, so the
 * job can check it runs on what the operator previewed. Not a secret: it
 * guards against a stale preview, not a forged one.
 */
export function accountPreviewToken(ids: readonly string[], change: BulkAccountChange): string {
  const users = [...ids.map((id) => id.toLowerCase())].sort().join(',');
  const target =
    change.op === 'move'
      ? change.targetOuDn.toLowerCase()
      : change.op === 'accountExpiry'
        ? String(change.expiresAt === null ? null : Date.parse(change.expiresAt))
        : '';
  return createHash('sha256')
    .update(`account\n${change.op}\n${users}\n${target}`)
    .digest('base64url');
}

/**
 * What changing these users' accounts would do, read from the cache
 * before anything is written: who it changes (with what each has now),
 * who is already as asked, and who deserves a second look. `offset` and
 * `limit` page through the users it changes.
 */
export async function previewAccountChange(
  db: Kysely<DB>,
  providerId: number,
  request: { ids: string[]; change: BulkAccountChange; offset: number; limit: number },
): Promise<BulkAccountPreview> {
  const ids = request.ids.map((id) => id.toLowerCase());
  const change = await resolveAccountChange(db, providerId, request.change);
  const write = accountWrite(change);
  const rows = await db
    .selectFrom('user_cache_records')
    .select([
      'object_guid',
      'distinguished_name',
      'display_name',
      'sam_account_name',
      'account_expires_at',
      'password_must_change',
      'password_never_expires',
      'password_last_set_at',
      'raw_attributes_json',
    ])
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`object_guid = ANY(${ids}::uuid[])`)
    .execute();
  const known = rows
    .map((u) => ({
      id: u.object_guid.toLowerCase(),
      name: cachedUserName(u, u.object_guid),
      state: {
        distinguishedName: u.distinguished_name,
        accountExpiresAt: u.account_expires_at ? new Date(u.account_expires_at) : null,
        passwordMustChange: u.password_must_change,
        passwordNeverExpires: u.password_never_expires,
        passwordLastSetAt: u.password_last_set_at ? new Date(u.password_last_set_at) : null,
        rawAttributes: u.raw_attributes_json,
      } satisfies AccountState,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const randomPassword =
    change.op === 'mustChangePassword' ? await randomPasswordUsers(db, providerId, ids) : null;
  const changed = previewList<BulkAccountPreviewUser>(request.offset, request.limit);
  const unchanged = previewList();
  const notes = new Map<BulkAccountNote, ReturnType<typeof previewList<PreviewUser>>>();
  const note = (kind: BulkAccountNote, user: { id: string; name: string }) => {
    if (!notes.has(kind)) notes.set(kind, previewList());
    notes.get(kind)!.add(user);
  };
  for (const user of known) {
    const entry = { id: user.id, name: user.name };
    if (write.asAsked?.(user.state)) {
      unchanged.add(entry);
      continue;
    }
    changed.add({ ...entry, from: from(change, user.state) });
    if (change.op === 'mustChangePassword') {
      if (user.state.passwordNeverExpires) note('never_expires', entry);
      if (randomPassword?.has(user.id)) note('random_password', entry);
    }
    if (change.op === 'clearPasswordNeverExpires' && user.state.passwordMustChange) {
      note('must_change', entry);
    }
  }

  const knownIds = new Set(known.map((u) => u.id));
  return {
    op: change.op,
    changed: { ...changed.list, offset: request.offset },
    unchanged: unchanged.list,
    notes: [...notes].map(([kind, list]) => ({ kind, ...list.list })),
    ou: change.op === 'move' ? ouOf(change.ou) : null,
    unknownCount: ids.filter((id) => !knownIds.has(id)).length,
    previewToken: accountPreviewToken(request.ids, request.change),
  };
}

const ouOf = (ou: { distinguished_name: string; name: string }) => ({
  distinguishedName: ou.distinguished_name,
  name: ou.name,
});

/** What the user has now that the change replaces, as the preview shows it. */
function from(change: ResolvedAccountChange, user: AccountState): string | null {
  if (change.op === 'move') return parentDn(user.distinguishedName);
  if (change.op === 'accountExpiry') return user.accountExpiresAt?.toISOString() ?? null;
  return null;
}

/**
 * The users whose password was last set here in random mode (a create
 * nobody saw the password of), not reset since: they set their own in
 * Entra.
 */
async function randomPasswordUsers(
  db: Kysely<DB>,
  providerId: number,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await sql<{ user_id: string; mode: string | null }>`
    SELECT DISTINCT ON (target_id) lower(target_id) AS user_id, metadata_json->>'passwordMode' AS mode
      FROM audit_events
     WHERE provider_id = ${providerId}
       AND result = 'success'
       AND target_id = ANY(${ids}::text[])
       AND (action = 'user.password.reset'
            OR (action IN ('user.create', 'user.create.finish') AND metadata_json ? 'passwordMode'))
     ORDER BY target_id, id DESC
  `.execute(db);
  return new Set(rows.filter((r) => r.mode === 'random').map((r) => r.user_id));
}
