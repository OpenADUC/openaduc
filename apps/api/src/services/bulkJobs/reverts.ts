// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import {
  BULK_JOB_CAPABILITIES,
  type BulkAttributeField,
  type BulkJobAction,
  type BulkJobRevertPreview,
  type BulkRevertChange,
  type BulkRevertField,
  type BulkRevertPreviewUser,
  type PreviewUser,
} from '@openaduc/shared';
import type { BulkJobsTable, DB } from '../../db/types.js';
import { leafRdnValue, parentDn } from '../../providers/active-directory/normalize.js';
import type { DirectoryUser } from '../../providers/types.js';
import {
  cachedValues,
  liveValues,
  namesByDn,
  sameValue,
  shownValue,
  snapshotValues,
  type AttributeValues,
} from '../bulkAttributes.js';
import { membershipRequirement } from '../groupMembershipWrite.js';
import { findCachedOu, userMoveRefusal, type CachedOu } from '../ouCache.js';
import { previewList } from '../previewList.js';
import { previewToken } from '../previewToken.js';
import {
  CLEAR_PASSWORD_MUST_CHANGE,
  CLEAR_PASSWORD_NEVER_EXPIRES,
  DISABLE_USER,
  ENABLE_USER,
  expireAccountAt,
  moveUserTo,
  REQUIRE_PASSWORD_CHANGE,
  SET_PASSWORD_NEVER_EXPIRES,
} from '../userAccountWrite.js';
import { cachedUserName } from '../userCache.js';
import { BulkJobRequestError } from './errors.js';
import {
  accountRow,
  attributesRow,
  membershipRow,
  type BulkJobHandler,
  type BulkRowContext,
  type BulkRowOutcome,
} from './handlers.js';

type Snapshot = Record<string, unknown>;

/** What a revert compares an account with: as just read live, or as the cache has it. */
interface AccountNow {
  enabled: boolean;
  distinguishedName: string;
  accountExpiresAt: Date | null;
  passwordMustChange: boolean;
  passwordNeverExpires: boolean;
  attributes: AttributeValues;
  /** The groups they're directly in, by id; null when not read (a membership write reads it live). */
  groupIds: ReadonlySet<string> | null;
}

/** One thing a row of the job changed: what it was before, what the job left, and what it is now. */
interface Facet {
  field: BulkRevertField;
  group?: string;
  before: unknown;
  after: unknown;
  /** Undefined when it isn't known. */
  read(now: AccountNow): unknown;
  same(a: unknown, b: unknown): boolean;
  show(value: unknown, managerName: (dn: string) => string): string | boolean | null;
}

/** A revert row's input: what the job's row recorded, and whether to revert it if it's changed since. */
const revertInputSchema = z.object({
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  force: z.boolean(),
});
type RevertInput = z.infer<typeof revertInputSchema>;

interface RevertRow {
  targetId: string;
  input: RevertInput;
  before: Snapshot | null;
  after: Snapshot | null;
}

/** How one action's rows are put back. */
interface RevertOp {
  facets(before: Snapshot, after: Snapshot): Facet[];
  /** Why the row can't be put back, from the cache, or null. */
  refusal?(db: Kysely<DB>, providerId: number, before: Snapshot): Promise<string | null>;
  /** Put the row's before-values back on `user`, as just read live. */
  restore(row: RevertRow, user: DirectoryUser, ctx: BulkRowContext): Promise<BulkRowOutcome>;
}

const same = (a: unknown, b: unknown): boolean => a === b;
const sameDn = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameTime = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' ? Date.parse(a) === Date.parse(b) : a === b;
const shown = (value: unknown): string | boolean | null =>
  typeof value === 'string' || typeof value === 'boolean' ? value : null;

/** A flag the job turned on or off, kept in its row's snapshots under `key`. */
const flagFacets =
  (field: BulkRevertField, key: string, read: (now: AccountNow) => boolean) =>
  (before: Snapshot, after: Snapshot): Facet[] => [
    { field, before: before[key] === true, after: after[key] === true, read, same, show: shown },
  ];

const ENABLED: RevertOp = {
  facets: flagFacets('enabled', 'enabled', (n) => n.enabled),
  restore: (row, _user, ctx) =>
    accountRow(row, ctx, row.input.before['enabled'] === true ? ENABLE_USER : DISABLE_USER),
};

/** The OU a moved user came from, if they can be moved back there. */
async function originOu(
  db: Kysely<DB>,
  providerId: number,
  before: Snapshot,
): Promise<{ ou: CachedOu } | { refused: string }> {
  const from = typeof before['parentDn'] === 'string' ? before['parentDn'] : null;
  const ou = from ? await findCachedOu(db, providerId, from) : null;
  if (!ou) {
    const name = from ? (leafRdnValue(from) ?? from) : 'where they were';
    return { refused: `Can’t be moved back: ${name} isn’t an OU in the directory.` };
  }
  const refused = userMoveRefusal(ou);
  return refused ? { refused } : { ou };
}

const MOVE: RevertOp = {
  facets: (before, after) => [
    {
      field: 'ou',
      before: before['parentDn'] ?? null,
      after: after['parentDn'] ?? null,
      read: (n) => parentDn(n.distinguishedName),
      same: sameDn,
      show: shown,
    },
  ],
  async refusal(db, providerId, before) {
    const origin = await originOu(db, providerId, before);
    return 'refused' in origin ? origin.refused : null;
  },
  async restore(row, _user, ctx) {
    const origin = await originOu(ctx.db, ctx.provider.id, row.input.before);
    if ('refused' in origin) {
      return { ok: false, errorCode: 'not_found', message: origin.refused, audited: false };
    }
    return accountRow(row, ctx, moveUserTo(origin.ou));
  },
};

const EXPIRY: RevertOp = {
  facets: (before, after) => [
    {
      field: 'accountExpires',
      before: before['accountExpiresAt'] ?? null,
      after: after['accountExpiresAt'] ?? null,
      read: (n) => n.accountExpiresAt?.toISOString() ?? null,
      same: sameTime,
      show: shown,
    },
  ],
  restore(row, _user, ctx) {
    const at = row.input.before['accountExpiresAt'];
    return accountRow(row, ctx, expireAccountAt(typeof at === 'string' ? new Date(at) : null));
  },
};

/**
 * Must-change is pwdLastSet 0, and AD takes only 0 or -1 for it: -1 stops
 * asking for a change by setting it to now, so the password's age
 * restarts rather than going back to when it was last set.
 */
const MUST_CHANGE: RevertOp = {
  facets: flagFacets('passwordMustChange', 'passwordMustChange', (n) => n.passwordMustChange),
  restore: (row, _user, ctx) =>
    accountRow(
      row,
      ctx,
      row.input.before['passwordMustChange'] === true
        ? REQUIRE_PASSWORD_CHANGE
        : CLEAR_PASSWORD_MUST_CHANGE,
    ),
};

const NEVER_EXPIRES: RevertOp = {
  facets: flagFacets('passwordNeverExpires', 'passwordNeverExpires', (n) => n.passwordNeverExpires),
  restore: (row, _user, ctx) =>
    accountRow(
      row,
      ctx,
      row.input.before['passwordNeverExpires'] === true
        ? SET_PASSWORD_NEVER_EXPIRES
        : CLEAR_PASSWORD_NEVER_EXPIRES,
    ),
};

const ATTRIBUTES: RevertOp = {
  facets(before, after) {
    const was = snapshotValues(before);
    const left = snapshotValues(after);
    return (Object.keys(left) as BulkAttributeField[])
      .filter((f) => was[f] !== undefined)
      .map((f) => ({
        field: f,
        before: was[f],
        after: left[f],
        read: (n) => n.attributes[f],
        same: (a, b) => sameValue(f, a, b),
        show: (value, managerName) => shownValue(f, value, managerName),
      }));
  },
  restore: (row, user, ctx) =>
    attributesRow(row, user, ctx, async () => snapshotValues(row.input.before)),
};

const groupsOf = (snapshot: Snapshot): { id: string; name: string; isMember: boolean }[] => {
  const groups = snapshot['groups'];
  return Array.isArray(groups) ? (groups as { id: string; name: string; isMember: boolean }[]) : [];
};

/** Put back the groups a membership job changed: `op` is the opposite of the job's. */
function membership(op: 'add' | 'remove'): RevertOp {
  return {
    facets: (_before, after) =>
      groupsOf(after).map((g) => ({
        field: 'group',
        group: g.name,
        before: !g.isMember,
        after: g.isMember,
        read: (n) => n.groupIds?.has(g.id.toLowerCase()),
        same,
        show: shown,
      })),
    restore: (row, user, ctx) =>
      membershipRow(
        op,
        row,
        groupsOf(row.input.after).map((g) => g.id.toLowerCase()),
        user,
        ctx,
      ),
  };
}

/**
 * The actions a revert can put back. Unlock has none: AD can't lock an
 * account again.
 */
const REVERTS: Partial<Record<BulkJobAction, RevertOp>> = {
  'user.disable': ENABLED,
  'user.enable': ENABLED,
  'user.group.add': membership('remove'),
  'user.group.remove': membership('add'),
  'user.update': ATTRIBUTES,
  'user.move': MOVE,
  'user.accountExpiry.set': EXPIRY,
  'user.passwordMustChange.set': MUST_CHANGE,
  'user.passwordNeverExpires.clear': NEVER_EXPIRES,
};

export const canRevert = (action: BulkJobAction): boolean => REVERTS[action] !== undefined;

/**
 * Where a row stands now: `pending` holds what still has the job's value
 * (or isn't known), `drift` what has changed again since; anything else
 * is back as it was.
 */
function judge(
  facets: Facet[],
  now: AccountNow,
): { kind: 'revert' | 'modified' | 'unchanged'; pending: Facet[]; drift: Facet[] } {
  const pending: Facet[] = [];
  const drift: Facet[] = [];
  for (const f of facets) {
    const value = f.read(now);
    if (value === undefined) pending.push(f);
    else if (f.same(value, f.before)) continue;
    else if (f.same(value, f.after)) pending.push(f);
    else drift.push(f);
  }
  const kind = drift.length > 0 ? 'modified' : pending.length > 0 ? 'revert' : 'unchanged';
  return { kind, pending, drift };
}

const liveNow = (user: DirectoryUser): AccountNow => ({
  enabled: user.enabled,
  distinguishedName: user.distinguishedName,
  accountExpiresAt: user.accountExpiresAt,
  passwordMustChange: user.passwordMustChange,
  passwordNeverExpires: user.passwordNeverExpires,
  attributes: liveValues(user),
  groupIds: null,
});

const CHANGED_SINCE = {
  code: 'changed_since',
  message: 'Changed again since the job, so left as it is.',
};

/** What runs a revert's rows: each one put back as its single-object write would. */
export type BulkRevertRunner = Pick<BulkJobHandler, 'capability' | 'requires' | 'input' | 'run'>;

/**
 * A revert row reads the user live and compares what the job's row
 * changed with what they have now. One changed again since is skipped,
 * unless the operator included it; one already back as it was is skipped
 * too. Otherwise the row makes the write that puts the before-values back.
 */
export function revertRunner(action: BulkJobAction): BulkRevertRunner {
  const op = REVERTS[action];
  if (!op) throw new Error(`no revert for ${action}`);
  const runner: Pick<BulkJobHandler<unknown, RevertInput>, keyof BulkRevertRunner> = {
    capability: BULK_JOB_CAPABILITIES[action],
    ...(action === 'user.group.remove'
      ? {
          requires: (subject, roleGroups) =>
            membershipRequirement('add', subject?.groups ?? [], roleGroups),
        }
      : {}),
    input: revertInputSchema,
    async run(row, ctx) {
      const live = await ctx.services.userLiveRefresh.refresh(ctx.provider, row.targetId);
      if (!live) return { ok: false, errorCode: 'not_found', audited: false };
      const { kind } = judge(op.facets(row.input.before, row.input.after), liveNow(live.user));
      const kept = { before: row.before, after: row.after, targetDn: live.user.distinguishedName };
      if (kind === 'modified' && !row.input.force) {
        return { ok: true, unchanged: true, reason: CHANGED_SINCE, ...kept };
      }
      if (kind === 'unchanged') return { ok: true, unchanged: true, ...kept };
      return op.restore(row, live.user, ctx);
    },
  };
  return runner as BulkRevertRunner;
}

type JobRecord = Pick<Selectable<BulkJobsTable>, 'id' | 'provider_id' | 'action'>;

interface PlannedRow {
  targetId: string;
  name: string;
  ordinal: number;
  before: Snapshot;
  after: Snapshot;
}

interface JudgedRow extends PlannedRow {
  now: AccountNow;
  /** What the preview shows: what it puts back, or what changed since. */
  shown: Facet[];
}

/** How each of a job's rows would be reverted, judged against the cache. */
export interface RevertPlan {
  revert: JudgedRow[];
  modified: JudgedRow[];
  unchanged: PlannedRow[];
  notRevertible: (PlannedRow & { reason: string })[];
  excluded: number;
  /** Names the plan, for the revert to check it starts on what was previewed. */
  token: string;
}

/**
 * Judge each row the job changed (succeeded or partly) against what the
 * cache has now. The job's other rows changed nothing, so are excluded.
 */
export async function planRevert(db: Kysely<DB>, job: JobRecord): Promise<RevertPlan> {
  const op = REVERTS[job.action];
  if (!op) {
    throw new BulkJobRequestError(
      'not_revertible',
      'An unlock can’t be reverted: AD can’t lock an account again.',
    );
  }
  const providerId = job.provider_id;
  const rows = await db
    .selectFrom('bulk_job_rows')
    .select(['ordinal', 'target_id', 'target_name', 'status', 'before_json', 'after_json'])
    .where('job_id', '=', job.id)
    .orderBy('ordinal')
    .execute();
  const changed = rows.filter(
    (r) => (r.status === 'succeeded' || r.status === 'partial') && r.before_json && r.after_json,
  );
  const ids = changed.map((r) => r.target_id.toLowerCase());
  const cached =
    ids.length === 0
      ? []
      : await db
          .selectFrom('user_cache_records')
          .select([
            'object_guid',
            'distinguished_name',
            'display_name',
            'sam_account_name',
            'enabled',
            'account_expires_at',
            'password_must_change',
            'password_never_expires',
            'title',
            'department',
            'manager_dn',
            'office',
            'office_read',
            'raw_attributes_json',
          ])
          .where('provider_id', '=', providerId)
          .where('deleted_at', 'is', null)
          .where(sql<boolean>`object_guid = ANY(${ids}::uuid[])`)
          .execute();
  const users = new Map(cached.map((u) => [u.object_guid.toLowerCase(), u]));
  const groupIds = await directGroups(db, providerId, ids, job.action);
  const refusals = new Map<string, Promise<string | null>>();

  const plan: RevertPlan = {
    revert: [],
    modified: [],
    unchanged: [],
    notRevertible: [],
    excluded: rows.length - changed.length,
    token: '',
  };
  for (const r of changed) {
    const targetId = r.target_id.toLowerCase();
    const user = users.get(targetId);
    const row: PlannedRow = {
      targetId,
      name: user ? cachedUserName(user, targetId) : (r.target_name ?? targetId),
      ordinal: r.ordinal,
      before: r.before_json!,
      after: r.after_json!,
    };
    if (!user) {
      plan.notRevertible.push({ ...row, reason: 'No longer in the directory.' });
      continue;
    }
    const now: AccountNow = {
      enabled: user.enabled,
      distinguishedName: user.distinguished_name,
      accountExpiresAt: user.account_expires_at ? new Date(user.account_expires_at) : null,
      passwordMustChange: user.password_must_change,
      passwordNeverExpires: user.password_never_expires,
      attributes: cachedValues(user),
      groupIds: groupIds ? (groupIds.get(targetId) ?? new Set()) : null,
    };
    const verdict = judge(op.facets(row.before, row.after), now);
    if (verdict.kind === 'unchanged') {
      plan.unchanged.push(row);
      continue;
    }
    if (op.refusal) {
      // Rows moved from the same place share their answer.
      const key = JSON.stringify(row.before['parentDn'] ?? null).toLowerCase();
      if (!refusals.has(key)) refusals.set(key, op.refusal(db, providerId, row.before));
      const reason = await refusals.get(key)!;
      if (reason) {
        plan.notRevertible.push({ ...row, reason });
        continue;
      }
    }
    if (verdict.kind === 'modified') plan.modified.push({ ...row, now, shown: verdict.drift });
    else plan.revert.push({ ...row, now, shown: verdict.pending });
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  plan.revert.sort(byName);
  plan.modified.sort(byName);
  plan.unchanged.sort(byName);
  plan.notRevertible.sort(byName);
  plan.token = previewToken(
    `revert:${job.id}`,
    plan.revert.map((r) => r.targetId),
    plan.modified.map((r) => r.targetId).sort(),
  );
  return plan;
}

/** For a membership job, the groups each of these users is directly in, as the cache has it. */
async function directGroups(
  db: Kysely<DB>,
  providerId: number,
  userIds: string[],
  action: BulkJobAction,
): Promise<Map<string, Set<string>> | null> {
  if (action !== 'user.group.add' && action !== 'user.group.remove') return null;
  const out = new Map<string, Set<string>>();
  if (userIds.length === 0) return out;
  const rows = await db
    .selectFrom('user_group_memberships')
    .select(['user_object_guid', 'group_object_guid'])
    .where('provider_id', '=', providerId)
    .where('direct', '=', true)
    .where(sql<boolean>`user_object_guid = ANY(${userIds}::uuid[])`)
    .execute();
  for (const r of rows) {
    const id = r.user_object_guid.toLowerCase();
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(r.group_object_guid.toLowerCase());
  }
  return out;
}

/** The plan as the operator sees it before confirming. */
export async function revertPreview(
  db: Kysely<DB>,
  providerId: number,
  plan: RevertPlan,
): Promise<BulkJobRevertPreview> {
  const judged = [...plan.revert, ...plan.modified];
  const managerDns = new Set<string>();
  for (const row of judged) {
    for (const f of row.shown) {
      if (f.field !== 'manager') continue;
      for (const v of [f.before, f.after, f.read(row.now)]) {
        if (typeof v === 'string') managerDns.add(v);
      }
    }
  }
  const names = await namesByDn(db, providerId, [...managerDns]);
  const managerName = (dn: string) => names.get(dn.toLowerCase()) ?? dn;
  const show = (f: Facet, v: unknown) => (v === undefined ? null : f.show(v, managerName));
  const user = (row: JudgedRow): BulkRevertPreviewUser => ({
    id: row.targetId,
    name: row.name,
    changes: row.shown.map((f): BulkRevertChange => ({
      field: f.field,
      ...(f.group !== undefined ? { group: f.group } : {}),
      job: show(f, f.after),
      now: show(f, f.read(row.now)),
      restore: show(f, f.before),
    })),
  });

  const revert = previewList<BulkRevertPreviewUser>();
  for (const row of plan.revert) revert.add(user(row));
  const modified = previewList<BulkRevertPreviewUser>();
  for (const row of plan.modified) modified.add(user(row));
  const unchanged = previewList<PreviewUser>();
  for (const row of plan.unchanged) unchanged.add({ id: row.targetId, name: row.name });
  const notRevertible = previewList<PreviewUser & { reason: string }>();
  for (const row of plan.notRevertible) {
    notRevertible.add({ id: row.targetId, name: row.name, reason: row.reason });
  }
  return {
    revert: revert.list,
    modified: modified.list,
    unchanged: unchanged.list,
    notRevertible: notRevertible.list,
    excluded: plan.excluded,
    previewToken: plan.token,
  };
}
