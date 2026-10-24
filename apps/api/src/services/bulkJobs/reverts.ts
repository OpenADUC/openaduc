// SPDX-License-Identifier: BUSL-1.1
import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod';
import {
  BULK_JOB_CAPABILITIES,
  type BulkAttributeField,
  type BulkJobRevertPreview,
  type BulkRevertableAction,
  type BulkRevertChange,
  type BulkRevertField,
  type BulkRevertPreviewUser,
  type PreviewUser,
} from '@openaduc/shared';
import type { BulkJobsTable, DB } from '../../db/types.js';
import { isProtectedGroup } from '../../lib/groupPrivilege.js';
import { rawScalarValue } from '../../lib/rawAttributes.js';
import { leafRdnValue, parentDn } from '../../providers/active-directory/normalize.js';
import type {
  DirectoryObjectRef,
  DirectoryProvider,
  DirectoryUser,
} from '../../providers/types.js';
import {
  cachedValues,
  liveValues,
  namesByDn,
  sameValue,
  shownValue,
  snapshotValues,
  type AttributeValues,
} from '../bulkAttributes.js';
import { findCachedGroupsById } from '../groupCache.js';
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
  type AccountWrite,
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

/** Objects found live by GUID or DN, each asked for once. */
export interface DirectoryLookup {
  byGuid(guid: string): Promise<DirectoryObjectRef | null>;
  byDn(dn: string): Promise<DirectoryObjectRef | null>;
}

export function directoryLookup(provider: Pick<DirectoryProvider, 'findObject'>): DirectoryLookup {
  const guids = new Map<string, Promise<DirectoryObjectRef | null>>();
  const dns = new Map<string, Promise<DirectoryObjectRef | null>>();
  const once = (
    seen: Map<string, Promise<DirectoryObjectRef | null>>,
    key: string,
    find: () => Promise<DirectoryObjectRef | null>,
  ) => {
    if (!seen.has(key)) seen.set(key, find());
    return seen.get(key)!;
  };
  return {
    byGuid: (guid) =>
      once(guids, guid.toLowerCase(), () =>
        provider.findObject({ kind: 'objectGuid', value: guid }),
      ),
    byDn: (dn) =>
      once(dns, dn.toLowerCase(), () =>
        provider.findObject({ kind: 'distinguishedName', value: dn }),
      ),
  };
}

/**
 * An object a row names, an OU or a manager: by DN, and by GUID in rows
 * recorded since they kept it. By GUID it's the same object however it's
 * been renamed or moved.
 */
export interface Ref {
  dn: string | null;
  guid: string | null;
}

const refOf = (snapshot: Snapshot, dnKey: string, guidKey: string): Ref => ({
  dn: typeof snapshot[dnKey] === 'string' ? (snapshot[dnKey] as string) : null,
  guid: typeof snapshot[guidKey] === 'string' ? (snapshot[guidKey] as string).toLowerCase() : null,
});

export const sameRef = (a: unknown, b: unknown): boolean => {
  const x = a as Ref;
  const y = b as Ref;
  if (x.guid && y.guid) return x.guid === y.guid;
  return (x.dn?.toLowerCase() ?? null) === (y.dn?.toLowerCase() ?? null);
};

/** What a revert compares an account with: as just read live, or as the cache has it. */
export interface AccountNow {
  enabled: boolean;
  parent: Ref;
  accountExpiresAt: Date | null;
  passwordMustChange: boolean;
  passwordNeverExpires: boolean;
  attributes: AttributeValues;
  /** Undefined when the cache hasn't read it. */
  manager: Ref | undefined;
  /** Direct groups by id; null when not read (a membership write checks each group live). */
  groupIds: ReadonlySet<string> | null;
  uSNChanged: string | null;
}

/** How a facet's value is shown: OUs and managers as they're named now. */
export interface Display {
  ref(ref: Ref): DirectoryObjectRef | null;
  managerName(dn: string): string;
}

/** One thing a row of the job changed: what it was before, what the job left, and what it is now. */
export interface Facet {
  field: BulkRevertField;
  group?: string;
  /** The group, for a membership. */
  groupId?: string;
  before: unknown;
  /** Undefined when the job's own re-read failed. */
  after: unknown;
  /** Undefined when it isn't known. */
  read(now: AccountNow): unknown;
  same(a: unknown, b: unknown): boolean;
  show(value: unknown, display: Display): string | boolean | null;
}

const revertInputSchema = z.object({
  /** The job reverted, whose own events (and its reverts') don't count as changes since. */
  jobId: z.string(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  /** When the job's row was written. */
  ranAt: z.string().nullable(),
  /** Revert it though it's changed since. */
  force: z.boolean(),
});
type RevertInput = z.infer<typeof revertInputSchema>;

interface RevertRow {
  targetId: string;
  input: RevertInput;
  before: Snapshot | null;
  after: Snapshot | null;
}

interface RevertCtx {
  db: Kysely<DB>;
  providerId: number;
  lookup: DirectoryLookup;
}

export interface RevertOp {
  facets(before: Snapshot, after: Snapshot): Facet[];
  /** The audit actions that change what the job changed, for telling it's been changed since. */
  auditActions: readonly string[];
  /** Why the row can't be put back, or null. */
  refusal?(before: Snapshot, ctx: RevertCtx): Promise<string | null>;
  /** Put the row's before-values back on `user`, as just read live. */
  restore(
    row: RevertRow,
    user: DirectoryUser,
    ctx: BulkRowContext,
    lookup: DirectoryLookup,
  ): Promise<BulkRowOutcome>;
}

const same = (a: unknown, b: unknown): boolean => a === b;
const sameTime = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' ? Date.parse(a) === Date.parse(b) : a === b;
const shown = (value: unknown): string | boolean | null =>
  typeof value === 'string' || typeof value === 'boolean' ? value : null;
const recorded = (snapshot: Snapshot, key: string): unknown =>
  key in snapshot ? (snapshot[key] ?? null) : undefined;

/** An on/off setting the job flipped, kept under `key`, and the writes that set it each way. */
function flagOp(
  field: BulkRevertField,
  key: string,
  read: (now: AccountNow) => boolean,
  writes: { on: AccountWrite; off: AccountWrite },
  auditActions: readonly string[],
): RevertOp {
  return {
    facets: (before, after) => [
      {
        field,
        before: before[key] === true,
        after: key in after ? after[key] === true : undefined,
        read,
        same,
        show: shown,
      },
    ],
    auditActions,
    restore: (row, _user, ctx) =>
      accountRow(row, ctx, row.input.before[key] === true ? writes.on : writes.off),
  };
}

const ENABLED = flagOp(
  'enabled',
  'enabled',
  (n) => n.enabled,
  { on: ENABLE_USER, off: DISABLE_USER },
  ['user.enable', 'user.disable'],
);

/**
 * Must-change is pwdLastSet 0, and AD takes only 0 or -1 for it: -1 stops
 * asking for a change by setting it to now, so the password's age
 * restarts rather than going back to when it was last set.
 */
const MUST_CHANGE = flagOp(
  'passwordMustChange',
  'passwordMustChange',
  (n) => n.passwordMustChange,
  { on: REQUIRE_PASSWORD_CHANGE, off: CLEAR_PASSWORD_MUST_CHANGE },
  ['user.passwordMustChange.set', 'user.passwordMustChange.clear', 'user.password.reset'],
);

const NEVER_EXPIRES = flagOp(
  'passwordNeverExpires',
  'passwordNeverExpires',
  (n) => n.passwordNeverExpires,
  { on: SET_PASSWORD_NEVER_EXPIRES, off: CLEAR_PASSWORD_NEVER_EXPIRES },
  ['user.passwordNeverExpires.set', 'user.passwordNeverExpires.clear'],
);

/** The OU a moved user came from, as it's named now, if they can be moved back there. */
async function originOu(
  before: Snapshot,
  { db, providerId, lookup }: RevertCtx,
): Promise<{ ou: CachedOu } | { refused: string }> {
  const from = refOf(before, 'parentDn', 'parentGuid');
  const name = from.dn ? (leafRdnValue(from.dn) ?? from.dn) : 'where they were';
  const notOu = { refused: `Can’t be moved back: ${name} isn’t an OU in the directory.` };
  let ou: CachedOu | null;
  if (from.guid) {
    const found = await lookup.byGuid(from.guid);
    if (!found?.isOu) return notOu;
    ou = {
      distinguished_name: found.distinguishedName,
      name: found.name,
      raw_attributes_json: { isCriticalSystemObject: found.isCriticalSystemObject ? 'TRUE' : '' },
    };
  } else {
    ou = from.dn ? await findCachedOu(db, providerId, from.dn) : null;
  }
  if (!ou) return notOu;
  const refused = userMoveRefusal(ou);
  return refused ? { refused } : { ou };
}

const MOVE: RevertOp = {
  facets: (before, after) => [
    {
      field: 'ou',
      before: refOf(before, 'parentDn', 'parentGuid'),
      after: refOf(after, 'parentDn', 'parentGuid'),
      read: (n) => n.parent,
      same: sameRef,
      show: (v, display) => {
        const ref = v as Ref;
        return display.ref(ref)?.distinguishedName ?? ref.dn;
      },
    },
  ],
  auditActions: ['user.move'],
  async refusal(before, ctx) {
    const origin = await originOu(before, ctx);
    return 'refused' in origin ? origin.refused : null;
  },
  async restore(row, _user, ctx, lookup) {
    const origin = await originOu(row.input.before, {
      db: ctx.db,
      providerId: ctx.provider.id,
      lookup,
    });
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
      after: recorded(after, 'accountExpiresAt'),
      read: (n) => n.accountExpiresAt?.toISOString() ?? null,
      same: sameTime,
      show: shown,
    },
  ],
  auditActions: ['user.accountExpiry.set'],
  restore(row, _user, ctx) {
    const at = row.input.before['accountExpiresAt'];
    return accountRow(row, ctx, expireAccountAt(typeof at === 'string' ? new Date(at) : null));
  },
};

const managerRef = (snapshot: Snapshot): Ref => refOf(snapshot, 'managerDn', 'managerGuid');

const ATTRIBUTES: RevertOp = {
  facets(before, after) {
    const was = snapshotValues(before);
    const left = snapshotValues(after);
    return (Object.keys(left) as BulkAttributeField[])
      .filter((f) => was[f] !== undefined)
      .map((f): Facet => {
        if (f === 'manager') {
          return {
            field: f,
            before: managerRef(before),
            after: managerRef(after),
            read: (n) => n.manager,
            same: sameRef,
            show: (v, display) => {
              const ref = v as Ref;
              if (!ref.dn && !ref.guid) return null;
              const now = display.ref(ref);
              return now?.name ?? (ref.dn ? display.managerName(ref.dn) : null);
            },
          };
        }
        return {
          field: f,
          before: was[f],
          after: left[f],
          read: (n) => n.attributes[f],
          same: (a, b) => sameValue(f, a, b),
          show: (value, display) => shownValue(f, value, display.managerName),
        };
      });
  },
  auditActions: ['user.update'],
  restore: (row, user, ctx, lookup) =>
    attributesRow(row, user, ctx, async () => {
      const target = snapshotValues(row.input.before);
      const manager = managerRef(row.input.before);
      if (target.manager !== undefined && manager.guid) {
        const found = await lookup.byGuid(manager.guid);
        if (!found) throw new BulkJobRequestError('manager_not_found', 'manager not found');
        target.manager = found.distinguishedName;
      }
      return target;
    }),
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
        groupId: g.id.toLowerCase(),
        before: !g.isMember,
        after: g.isMember,
        read: (n) => n.groupIds?.has(g.id.toLowerCase()),
        same,
        show: shown,
      })),
    auditActions: ['user.group.add', 'user.group.remove'],
    // The membership write checks each group live, by its GUID.
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

export const REVERTS: Record<BulkRevertableAction, RevertOp> = {
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

export interface Verdict {
  kind: 'revert' | 'modified' | 'unchanged';
  /** What still has the job's value, or isn't known. */
  pending: Facet[];
  /** What has changed to something else since. */
  drift: Facet[];
  /** Why it counts as changed since when its values are as the job left them. */
  changedSince: string | null;
}

/**
 * Where a row stands now. Anything back as it was before is done. A row
 * with something changed to another value since, or `touched` (written
 * again since, even if changed back), is modified; one with something
 * still as the job left it, or unknown, is reverted.
 */
export function judge(facets: Facet[], now: AccountNow, touched: string | null): Verdict {
  const pending: Facet[] = [];
  const drift: Facet[] = [];
  for (const f of facets) {
    const value = f.read(now);
    if (value === undefined) pending.push(f);
    else if (f.same(value, f.before)) continue;
    else if (f.after === undefined || f.same(value, f.after)) pending.push(f);
    else drift.push(f);
  }
  if (drift.length > 0) return { kind: 'modified', pending, drift, changedSince: null };
  if (pending.length === 0) return { kind: 'unchanged', pending, drift, changedSince: null };
  if (touched) return { kind: 'modified', pending, drift, changedSince: touched };
  return { kind: 'revert', pending, drift, changedSince: null };
}

const USN_CHANGED =
  'Changed in the directory since the job, though what the job set is as it left it: it may have been changed and changed back, or something else about the account changed.';

async function liveNow(user: DirectoryUser, lookup: DirectoryLookup): Promise<AccountNow> {
  const parent = parentDn(user.distinguishedName);
  const attributes = liveValues(user);
  return {
    enabled: user.enabled,
    parent: { dn: parent, guid: parent ? ((await lookup.byDn(parent))?.objectGuid ?? null) : null },
    accountExpiresAt: user.accountExpiresAt,
    passwordMustChange: user.passwordMustChange,
    passwordNeverExpires: user.passwordNeverExpires,
    attributes,
    manager: await managerNow(attributes.manager, lookup),
    groupIds: null,
    uSNChanged: rawScalarValue(user.rawAttributes['uSNChanged']),
  };
}

async function managerNow(
  dn: string | null | undefined,
  lookup: DirectoryLookup,
): Promise<Ref | undefined> {
  if (dn === undefined) return undefined;
  if (dn === null) return { dn: null, guid: null };
  return { dn, guid: (await lookup.byDn(dn))?.objectGuid ?? null };
}

/** A row as `touchedSince` checks it. */
interface TouchedRow {
  targetId: string;
  after: Snapshot;
  ranAt: string | null;
  facets: Facet[];
}

/**
 * Why each row counts as written again since the job's row ran, even if
 * changed back, or nothing. Rows that kept the account's uSNChanged
 * compare it (per domain controller: from another, it differs, so the
 * row counts as changed); memberships, which don't change the account,
 * and rows from before uSNChanged was kept, look for OpenADUC's own
 * events since, not the job's or its reverts'.
 */
async function touchedSince(
  db: Kysely<DB>,
  providerId: number,
  jobId: string,
  op: RevertOp,
  rows: (TouchedRow & { uSNChanged: string | null })[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byAudit: TouchedRow[] = [];
  for (const row of rows) {
    const usn = row.after['uSNChanged'];
    if (typeof usn === 'string') {
      if (row.uSNChanged !== null && row.uSNChanged !== usn) out.set(row.targetId, USN_CHANGED);
    } else if (row.ranAt) {
      byAudit.push(row);
    }
  }
  if (byAudit.length === 0) return out;
  const since = byAudit.map((r) => r.ranAt!).sort()[0]!;
  const { rows: events } = await sql<{
    target_id: string;
    action: string;
    actor_display_name: string | null;
    timestamp: Date;
    group_id: string | null;
  }>`
    SELECT target_id, action, actor_display_name, timestamp, metadata_json->>'groupId' AS group_id
      FROM audit_events
     WHERE provider_id = ${providerId}
       AND target_type = 'user'
       AND target_id = ANY(${byAudit.map((r) => r.targetId)}::text[])
       AND result = 'success'
       AND action = ANY(${[...op.auditActions]}::text[])
       AND timestamp > ${new Date(since)}
       AND COALESCE(metadata_json->>'unchanged', 'false') <> 'true'
       AND (bulk_job_id IS NULL OR bulk_job_id NOT IN (
             SELECT id FROM bulk_jobs WHERE id = ${jobId} OR reverts_job_id = ${jobId}))
     ORDER BY timestamp
  `.execute(db);
  for (const row of byAudit) {
    const groups = new Set(row.facets.flatMap((f) => (f.groupId ? [f.groupId] : [])));
    const event = events.find(
      (e) =>
        e.target_id.toLowerCase() === row.targetId &&
        new Date(e.timestamp).getTime() > Date.parse(row.ranAt!) &&
        (groups.size === 0 || (e.group_id !== null && groups.has(e.group_id.toLowerCase()))),
    );
    if (event) {
      const by = event.actor_display_name ? ` by ${event.actor_display_name}` : '';
      out.set(
        row.targetId,
        `Changed again through OpenADUC since the job (${event.action}${by}), though what the job set is as it left it.`,
      );
    }
  }
  return out;
}

const CHANGED_SINCE = {
  code: 'changed_since',
  message: 'Changed again since the job, so left as it is.',
};

/** What runs a revert's rows: each one put back as its single-object write would. */
export type BulkRevertRunner = Pick<
  BulkJobHandler<unknown, unknown, string | null>,
  'capability' | 'requires' | 'input' | 'run'
>;

/**
 * A revert row reads the user live and judges it as the preview did,
 * skipping one changed since unless the operator included it, or already
 * back as it was; otherwise it makes the write that puts the
 * before-values back.
 */
export function revertRunner(action: BulkRevertableAction): BulkRevertRunner {
  const op = REVERTS[action];
  const runner: Pick<BulkJobHandler<unknown, RevertInput>, keyof BulkRevertRunner> = {
    capability: BULK_JOB_CAPABILITIES[action],
    ...(action === 'user.group.remove'
      ? {
          requires: (subject, roleGroups) =>
            [membershipRequirement('add', subject?.groups ?? [], roleGroups)].filter(
              (r) => r !== null,
            ),
        }
      : {}),
    input: revertInputSchema,
    async run(row, ctx) {
      const live = await ctx.services.userLiveRefresh.refresh(ctx.provider, row.targetId);
      if (!live) return { ok: false, errorCode: 'not_found', audited: false };
      const lookup = directoryLookup(ctx.provider);
      const now = await liveNow(live.user, lookup);
      const { input } = row;
      const facets = op.facets(input.before, input.after);
      const touched = await touchedSince(ctx.db, ctx.provider.id, input.jobId, op, [
        {
          targetId: row.targetId,
          after: input.after,
          ranAt: input.ranAt,
          facets,
          uSNChanged: now.uSNChanged,
        },
      ]);
      const { kind } = judge(facets, now, touched.get(row.targetId) ?? null);
      const kept = { before: row.before, after: row.after, targetDn: live.user.distinguishedName };
      if (kind === 'modified' && !input.force) {
        return { ok: true, unchanged: true, reason: CHANGED_SINCE, ...kept };
      }
      if (kind === 'unchanged') return { ok: true, unchanged: true, ...kept };
      return op.restore(row, live.user, ctx, lookup);
    },
  };
  return runner as BulkRevertRunner;
}

type JobRecord = Pick<Selectable<BulkJobsTable>, 'id' | 'provider_id' | 'subject_json'>;

interface PlannedRow {
  targetId: string;
  name: string;
  ordinal: number;
  before: Snapshot;
  after: Snapshot;
  ranAt: string | null;
}

export interface JudgedRow extends PlannedRow {
  now: AccountNow;
  /** What the preview shows: what it puts back, or what changed since. */
  shown: Facet[];
  changedSince: string | null;
  /** The groups it puts the user back in. */
  readds: string[];
}

/** How each of a job's rows would be reverted, judged against the cache. */
export interface RevertPlan {
  revert: JudgedRow[];
  modified: JudgedRow[];
  unchanged: PlannedRow[];
  notRevertible: (PlannedRow & { reason: string })[];
  excluded: number;
  /** Groups AD protects that some row puts users back in, by id. */
  protectedGroups: Map<string, string>;
  lookup: DirectoryLookup;
  /** Names the plan, for the revert to check it starts on what was previewed. */
  token: string;
}

/**
 * Judge each row the job changed (succeeded or partly) against the cache,
 * the OUs and managers it names looked up live by GUID. The job's other
 * rows changed nothing, so are excluded.
 */
export async function planRevert(
  db: Kysely<DB>,
  job: JobRecord,
  action: BulkRevertableAction,
  lookup: DirectoryLookup,
): Promise<RevertPlan> {
  const op = REVERTS[action];
  const providerId = job.provider_id;
  const rows = await db
    .selectFrom('bulk_job_rows')
    .select([
      'ordinal',
      'target_id',
      'target_name',
      'status',
      'before_json',
      'after_json',
      'finished_at',
    ])
    .where('job_id', '=', job.id)
    .orderBy('ordinal')
    .execute();
  // Only a bulk action's rows, which always have a target, are reverted.
  const changed = rows.flatMap((r) =>
    (r.status === 'succeeded' || r.status === 'partial') &&
    r.before_json &&
    r.after_json &&
    r.target_id !== null
      ? [{ ...r, target_id: r.target_id }]
      : [],
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
  const membershipJob = action === 'user.group.add' || action === 'user.group.remove';
  const groupIds = membershipJob ? await directGroups(db, providerId, ids) : null;
  const ctx: RevertCtx = { db, providerId, lookup };
  const refusals = new Map<string, Promise<string | null>>();

  const candidates: (PlannedRow & { now: AccountNow; facets: Facet[] })[] = [];
  const notRevertible: RevertPlan['notRevertible'] = [];
  for (const r of changed) {
    const targetId = r.target_id.toLowerCase();
    const user = users.get(targetId);
    const row: PlannedRow = {
      targetId,
      name: user ? cachedUserName(user, targetId) : (r.target_name ?? targetId),
      ordinal: r.ordinal,
      before: r.before_json!,
      after: r.after_json!,
      ranAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    };
    if (!user) {
      notRevertible.push({ ...row, reason: 'No longer in the directory.' });
      continue;
    }
    const parent = parentDn(user.distinguished_name);
    const attributes = cachedValues(user);
    const now: AccountNow = {
      enabled: user.enabled,
      parent: {
        dn: parent,
        guid: parent ? ((await lookup.byDn(parent))?.objectGuid ?? null) : null,
      },
      accountExpiresAt: user.account_expires_at ? new Date(user.account_expires_at) : null,
      passwordMustChange: user.password_must_change,
      passwordNeverExpires: user.password_never_expires,
      attributes,
      manager: await managerNow(attributes.manager, lookup),
      groupIds: groupIds ? (groupIds.get(targetId) ?? new Set()) : null,
      uSNChanged: rawScalarValue(user.raw_attributes_json['uSNChanged']),
    };
    candidates.push({ ...row, now, facets: op.facets(row.before, row.after) });
  }
  const touched = await touchedSince(
    db,
    providerId,
    String(job.id),
    op,
    candidates.map((c) => ({ ...c, uSNChanged: c.now.uSNChanged })),
  );

  const plan: RevertPlan = {
    revert: [],
    modified: [],
    unchanged: [],
    notRevertible,
    excluded: rows.length - changed.length,
    protectedGroups: new Map(),
    lookup,
    token: '',
  };
  for (const { facets, ...row } of candidates) {
    const verdict = judge(facets, row.now, touched.get(row.targetId) ?? null);
    if (verdict.kind === 'unchanged') {
      plan.unchanged.push(row);
      continue;
    }
    if (op.refusal) {
      // Rows moved from the same place share their answer.
      const from = refOf(row.before, 'parentDn', 'parentGuid');
      const key = (from.guid ?? from.dn ?? '').toLowerCase();
      if (!refusals.has(key)) refusals.set(key, op.refusal(row.before, ctx));
      const reason = await refusals.get(key)!;
      if (reason) {
        plan.notRevertible.push({ ...row, reason });
        continue;
      }
    }
    const readds =
      action === 'user.group.remove'
        ? verdict.pending.flatMap((f) => (f.groupId ? [f.groupId] : []))
        : [];
    const judged: JudgedRow = {
      ...row,
      shown:
        verdict.kind === 'modified' && verdict.drift.length > 0 ? verdict.drift : verdict.pending,
      changedSince: verdict.changedSince,
      readds,
    };
    (verdict.kind === 'modified' ? plan.modified : plan.revert).push(judged);
  }
  if (action === 'user.group.remove') {
    const readded = [...new Set([...plan.revert, ...plan.modified].flatMap((r) => r.readds))];
    const groups = await findCachedGroupsById(db, providerId, readded);
    for (const g of groups.values()) {
      if (isProtectedGroup(g)) plan.protectedGroups.set(g.id.toLowerCase(), g.name);
    }
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

/** The groups each of these users is directly in, as the cache has it. */
async function directGroups(
  db: Kysely<DB>,
  providerId: number,
  userIds: string[],
): Promise<Map<string, Set<string>>> {
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

/** The revert row of a row in the plan. */
export const revertInput = (jobId: string, row: JudgedRow, force: boolean): RevertInput => ({
  jobId,
  before: row.before,
  after: row.after,
  ranAt: row.ranAt,
  force,
});

/** The plan as the operator sees it before confirming. */
export async function revertPreview(
  db: Kysely<DB>,
  providerId: number,
  plan: RevertPlan,
): Promise<BulkJobRevertPreview> {
  const judged = [...plan.revert, ...plan.modified];
  const managerDns = new Set<string>();
  const guids = new Set<string>();
  for (const row of judged) {
    for (const f of row.shown) {
      for (const v of [f.before, f.after, f.read(row.now)]) {
        if (f.field === 'ou' || f.field === 'manager') {
          const ref = v as Ref | undefined;
          if (ref?.guid) guids.add(ref.guid);
          if (f.field === 'manager' && ref?.dn) managerDns.add(ref.dn);
        }
      }
    }
  }
  const names = await namesByDn(db, providerId, [...managerDns]);
  const found = new Map(
    await Promise.all([...guids].map(async (g) => [g, await plan.lookup.byGuid(g)] as const)),
  );
  const display: Display = {
    ref: (ref) => (ref.guid ? (found.get(ref.guid) ?? null) : null),
    managerName: (dn) => names.get(dn.toLowerCase()) ?? dn,
  };
  const show = (f: Facet, v: unknown) => (v === undefined ? null : f.show(v, display));
  const user = (row: JudgedRow): BulkRevertPreviewUser => ({
    id: row.targetId,
    name: row.name,
    changes: row.shown.map((f): BulkRevertChange => ({
      field: f.field,
      ...(f.group !== undefined ? { group: f.group } : {}),
      job: show(f, f.after),
      now: show(f, f.read(row.now)),
      restore: show(f, f.before),
      ...(f.after === undefined ? { unverified: true } : {}),
    })),
    ...(row.changedSince ? { changedSince: row.changedSince } : {}),
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
    protectedGroups: [...plan.protectedGroups].map(([id, name]) => ({ id, name })),
    previewToken: plan.token,
  };
}
