// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely } from 'kysely';
import type {
  BulkAccountChange,
  BulkAccountNote,
  BulkAccountOp,
  BulkAccountPreview,
  BulkAccountPreviewUser,
  BulkJobSubject,
  PreviewUser,
} from '@openaduc/shared';
import type { DB } from '../db/types.js';
import { parentDn } from '../providers/active-directory/normalize.js';
import { BulkJobRequestError } from './bulkJobs/errors.js';
import { findCachedOu, type CachedOu } from './ouCache.js';
import { previewList } from './previewList.js';
import { previewToken } from './previewToken.js';
import {
  CLEAR_PASSWORD_NEVER_EXPIRES,
  expireAccountAt,
  moveUserTo,
  REQUIRE_PASSWORD_CHANGE,
  type AccountState,
  type AccountWrite,
} from './userAccountWrite.js';
import { cachedUserName } from './userCache.js';

/** A user a preview looks at, with their account as the cache has it. */
export interface PreviewCandidate {
  id: string;
  name: string;
  state: AccountState;
}

type Notes = (user: PreviewCandidate) => BulkAccountNote[];
type ChangeOf<K extends BulkAccountOp> = Extract<BulkAccountChange, { op: K }>;
const NO_NOTES: Notes = () => [];

/** How one account change finds what it acts with, writes, and previews. */
interface AccountOp<K extends BulkAccountOp, Target> {
  /** What the change acts with; throws BulkJobRequestError when it can't. */
  resolve(db: Kysely<DB>, providerId: number, change: ChangeOf<K>): Promise<Target>;
  write(target: Target): AccountWrite;
  /** What the job's audit entry and progress say it does. */
  subject(target: Target): BulkJobSubject | null;
  /** What the preview token names besides the op and the users. */
  token(change: ChangeOf<K>): unknown;
  /** What the user has now that the change replaces, as the preview shows it. */
  from(user: AccountState): string | null;
  /** What the preview says about the users it changes, looked up for them all at once. */
  notes(
    db: Kysely<DB>,
    providerId: number,
    target: Target,
    users: PreviewCandidate[],
  ): Promise<Notes>;
}

const OPS: { [K in BulkAccountOp]: AccountOp<K, never> } = {
  move: accountOp<'move', CachedOu>({
    async resolve(db, providerId, { targetOuDn }) {
      const ou = await findCachedOu(db, providerId, targetOuDn);
      if (!ou) throw new BulkJobRequestError('ou_not_found', 'OU not found');
      return ou;
    },
    write: moveUserTo,
    subject: (ou) => ({ ou: { distinguishedName: ou.distinguished_name, name: ou.name } }),
    token: ({ targetOuDn }) => targetOuDn.toLowerCase(),
    from: (user) => parentDn(user.distinguishedName),
    notes: async () => NO_NOTES,
  }),
  accountExpiry: accountOp<'accountExpiry', Date | null>({
    resolve: async (_db, _providerId, { expiresAt }) =>
      expiresAt === null ? null : new Date(expiresAt),
    write: expireAccountAt,
    subject: (at) => ({ expiresAt: at?.toISOString() ?? null }),
    token: ({ expiresAt }) => (expiresAt === null ? null : Date.parse(expiresAt)),
    from: (user) => user.accountExpiresAt?.toISOString() ?? null,
    notes: async () => NO_NOTES,
  }),
  mustChangePassword: accountOp<'mustChangePassword', null>({
    resolve: async () => null,
    write: () => REQUIRE_PASSWORD_CHANGE,
    subject: () => null,
    token: () => null,
    from: () => null,
    async notes(db, providerId, _target, users) {
      const random = await randomPasswordUsers(db, providerId, users);
      return (user) => [
        ...(user.state.passwordNeverExpires ? (['never_expires'] as const) : []),
        ...(random.has(user.id) ? (['random_password'] as const) : []),
      ];
    },
  }),
  clearPasswordNeverExpires: accountOp<'clearPasswordNeverExpires', null>({
    resolve: async () => null,
    write: () => CLEAR_PASSWORD_NEVER_EXPIRES,
    subject: () => null,
    token: () => null,
    from: () => null,
    notes: async () => (user) => (user.state.passwordMustChange ? ['must_change'] : []),
  }),
};

// Types each op's table entry by its own change and target.
function accountOp<K extends BulkAccountOp, Target>(op: AccountOp<K, Target>): AccountOp<K, never> {
  return op as unknown as AccountOp<K, never>;
}

/** An account change with what it acts with looked up. */
export interface ResolvedAccountChange {
  write: AccountWrite;
  subject: BulkJobSubject | null;
  from(user: AccountState): string | null;
  notes(users: PreviewCandidate[]): Promise<Notes>;
}

export async function resolveAccountChange(
  db: Kysely<DB>,
  providerId: number,
  change: BulkAccountChange,
): Promise<ResolvedAccountChange> {
  const op = OPS[change.op] as AccountOp<BulkAccountOp, unknown>;
  const target = await op.resolve(db, providerId, change as never);
  return {
    write: op.write(target),
    subject: op.subject(target),
    from: op.from,
    notes: (users) => op.notes(db, providerId, target, users),
  };
}

export function accountPreviewToken(ids: readonly string[], change: BulkAccountChange): string {
  const op = OPS[change.op] as AccountOp<BulkAccountOp, unknown>;
  return previewToken(`account:${change.op}`, ids, op.token(change as never));
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
  const known: PreviewCandidate[] = rows
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
      },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const changing = known.filter((u) => !change.write.asAsked?.(u.state));
  const notesOf = await change.notes(changing);
  const changed = previewList<BulkAccountPreviewUser>(request.offset, request.limit);
  const unchanged = previewList();
  const notes = new Map<BulkAccountNote, ReturnType<typeof previewList<PreviewUser>>>();
  for (const user of known) {
    const entry = { id: user.id, name: user.name };
    if (!changing.includes(user)) {
      unchanged.add(entry);
      continue;
    }
    changed.add({ ...entry, from: change.from(user.state) });
    for (const kind of notesOf(user)) {
      if (!notes.has(kind)) notes.set(kind, previewList());
      notes.get(kind)!.add(entry);
    }
  }

  const knownIds = new Set(known.map((u) => u.id));
  return {
    op: request.change.op,
    changed: { ...changed.list, offset: request.offset },
    unchanged: unchanged.list,
    notes: [...notes].map(([kind, list]) => ({ kind, ...list.list })),
    ou: change.subject?.ou ?? null,
    unknownCount: ids.filter((id) => !knownIds.has(id)).length,
    previewToken: accountPreviewToken(request.ids, request.change),
  };
}

/**
 * The users whose password was last set here in random mode (a create
 * nobody saw the password of), not reset since: they set their own in
 * Entra.
 */
async function randomPasswordUsers(
  db: Kysely<DB>,
  providerId: number,
  users: PreviewCandidate[],
): Promise<Set<string>> {
  if (users.length === 0) return new Set();
  const ids = users.map((u) => u.id);
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
