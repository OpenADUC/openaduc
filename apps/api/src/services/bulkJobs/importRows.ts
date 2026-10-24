// SPDX-License-Identifier: BUSL-1.1
// An import as a bulk job: one row per account to create, each run in
// IMPORT_STEPS' order, a row whose manager the import creates after that
// manager's row. What a row has done is kept in its after_json, so a
// retry runs only the steps still missing and never creates the account
// twice: a run that stopped before recording the row is found from its
// audit row, or, failing that, by the account it left in the directory.
// Passwords are held in import_passwords (heldPasswords.ts), never in the
// rows.
import {
  IMPORT_JOB_ACTION,
  IMPORT_STEPS,
  NEW_USER_ORGANISATION_FIELDS,
  PASSWORD_MODES,
  USAGE_LOCATION_ATTRIBUTE,
  childDn,
  classTapRequestSchema,
  importPasswordSchema,
  remainingSteps,
  type ImportStep,
  type PasswordMode,
  type UserCreateStep,
} from '@openaduc/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DirectoryUnavailableError,
  type DirectoryProvider,
  type DirectoryUser,
  type UserCreateInput,
  type UserCreateResult,
} from '../../providers/types.js';
import { withAudit } from '../auditContext.js';
import { storeClass } from '../classPasses/service.js';
import { findCachedGroupsById } from '../groupCache.js';
import { membershipRequirements } from '../groupMembershipWrite.js';
import {
  handedOutPassword,
  heldPassword,
  holdPassword,
  passwordsHoldable,
} from '../heldPasswords.js';
import { randomPassword, readBack } from '../userCreate.js';
import { UserAttributeRefusal, writeUserAttributes } from '../userAttributeWrite.js';
import { BulkJobRequestError } from './errors.js';
import {
  membershipRow,
  type BulkJobHandler,
  type BulkRowContext,
  type BulkRowOutcome,
} from './handlers.js';

const text = z.string().nullable();

/** One account to create, as the import route resolved it from the checked request. */
export const importPlanRowSchema = z.object({
  line: z.number().int(),
  ouDn: z.string(),
  cn: z.string(),
  samAccountName: z.string(),
  userPrincipalName: z.string(),
  givenName: z.string(),
  surname: z.string(),
  displayName: z.string(),
  initials: text,
  mail: text,
  otherMailbox: text,
  mobile: text,
  telephoneNumber: text,
  employeeId: text,
  description: text,
  organisation: z.partialRecord(z.enum(NEW_USER_ORGANISATION_FIELDS), z.string()),
  /** A manager already in the directory, by objectGUID. */
  managerId: text,
  /** A manager this import creates: the index of their row in the plan. */
  managerRow: z.number().int().nullable(),
  /** The bucket's groups, by objectGUID. */
  groupIds: z.array(z.string()),
  /** Written to msExchUsageLocation when the schema has it. */
  usageLocation: text,
  /** When the onboarding class's passes start, if by each person's start date. */
  startDate: text,
});
export type ImportPlanRow = z.infer<typeof importPlanRowSchema>;

export const importPlanSchema = z.object({
  rows: z.array(importPlanRowSchema).min(1),
  password: importPasswordSchema,
  enabled: z.boolean(),
  /** Temporary Access Passes for the onboarding class, made once each account is in Entra. */
  classTap: classTapRequestSchema.optional(),
});
export type ImportPlan = z.infer<typeof importPlanSchema>;

const optionsSchema = z.object({
  passwordMode: z.enum(PASSWORD_MODES),
  mustChange: z.boolean(),
  enabled: z.boolean(),
});

/** How the import sets every account up: kept on its subject and on each row. */
const optionsOf = (plan: ImportPlan): z.infer<typeof optionsSchema> => ({
  passwordMode: plan.password.mode,
  mustChange: plan.password.mode !== 'random' && plan.password.mustChange,
  enabled: plan.enabled,
});

const rowInputSchema = importPlanRowSchema.omit({ managerRow: true }).extend({
  /** The row creating the manager, by its ordinal in the job. */
  managerOrdinal: z.number().int().nullable(),
  options: optionsSchema,
});
type RowInput = z.infer<typeof rowInputSchema>;

/** What a row's runs have done, as its after_json keeps it. */
export interface ImportRowProgress {
  id: string | null;
  distinguishedName: string;
  /** The create's correlation id, which a finish of its steps records. */
  createCorrelationId: string | null;
  completed: ImportStep[];
  /** The groups added, as a membership row keeps them. */
  groups: { id: string; name: string; isMember: boolean }[];
  failed: { step: ImportStep; message: string }[];
  /**
   * Its password was set after the job's passwords were downloaded or
   * purged, so it's random and nobody knows it: the account needs a reset.
   */
  passwordFallback?: 'random';
  /** A retry found the account a run had created without recording it, and took it on. */
  adopted?: true;
}

export function progressOf(after: Record<string, unknown> | null): ImportRowProgress | null {
  return after && Array.isArray(after['completed'])
    ? (after as unknown as ImportRowProgress)
    : null;
}

/** The plan's rows in an order that puts each manager it creates before the people they manage. */
export function managersFirst(rows: readonly { managerRow: number | null }[]): number[] {
  const order: number[] = [];
  const placed = new Set<number>();
  const place = (i: number) => {
    if (placed.has(i)) return;
    // Placed before its manager, so a loop (which the request refuses) ends.
    placed.add(i);
    const manager = rows[i]!.managerRow;
    if (manager !== null) place(manager);
    order.push(i);
  };
  rows.forEach((_, i) => place(i));
  return order;
}

/** AD's GeneralizedTime (whenCreated), e.g. `20261025061234.0Z`. */
export function generalizedTime(value: string | null): Date | null {
  const m = value && /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, ...number[]];
  return new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, s!));
}

/**
 * Whether an account a retry finds holding a row's names is the one an
 * earlier run of the row created without recording it: exactly the
 * names planned, still disabled as a create leaves it, and created since
 * the job started. Anyone else's account fails the row as a name taken.
 */
export function adoptable(
  account: { samAccountName: string | null; userPrincipalName: string | null; enabled: boolean },
  whenCreated: string | null,
  planned: { samAccountName: string; userPrincipalName: string },
  jobStartedAt: Date,
): boolean {
  const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
  const created = generalizedTime(whenCreated);
  return (
    same(account.samAccountName, planned.samAccountName) &&
    same(account.userPrincipalName, planned.userPrincipalName) &&
    !account.enabled &&
    created !== null &&
    created.getTime() >= Math.floor(jobStartedAt.getTime() / 1000) * 1000
  );
}

/** The account steps the provider runs, in AD's order, of the import's steps. */
const accountSteps = (enabled: boolean): UserCreateStep[] =>
  enabled ? ['create', 'password', 'enable'] : ['create', 'password'];

const isAccountStep = (s: ImportStep): s is UserCreateStep =>
  s === 'create' || s === 'password' || s === 'enable';

/** Steps done, in IMPORT_STEPS' order whatever order they were done in. */
const mergeSteps = (done: readonly ImportStep[], more: readonly ImportStep[]): ImportStep[] =>
  IMPORT_STEPS.filter((s) => done.includes(s) || more.includes(s));

const NOT_DONE: Record<Exclude<ImportStep, 'create'>, string> = {
  password: 'Password not set',
  enable: 'Not enabled',
  groups: 'Not added to its groups',
  manager: 'Manager not set',
};

export function importHandler(): BulkJobHandler<ImportPlan, RowInput, string | null> {
  return {
    action: IMPORT_JOB_ACTION,
    capability: 'write:user.create',
    request: importPlanSchema,
    rows(plan) {
      const order = managersFirst(plan.rows);
      const ordinal = new Map(order.map((i, at) => [i, at]));
      const options = optionsOf(plan);
      return order.map((i) => {
        const { managerRow, ...row } = plan.rows[i]!;
        const managerOrdinal = managerRow === null ? null : ordinal.get(managerRow)!;
        return {
          targetId: null,
          targetName: row.displayName,
          input: { ...row, managerOrdinal, options },
          ...(managerOrdinal === null ? {} : { after: managerOrdinal }),
        };
      });
    },
    secret: (plan) => (plan.password.mode === 'set' ? plan.password.password : null),
    async stored(trx, jobId, plan) {
      if (plan.classTap) await storeClass(trx, jobId, plan.classTap);
    },
    async prepare(plan, { db, directoryId }) {
      const ids = [...new Set(plan.rows.flatMap((r) => r.groupIds.map((id) => id.toLowerCase())))];
      const found = await findCachedGroupsById(db, directoryId, ids);
      const groups = ids.map((id) => {
        const group = found.get(id);
        if (!group) throw new BulkJobRequestError('group_not_found', 'group not found');
        return {
          id: group.id.toLowerCase(),
          name: group.name,
          distinguishedName: group.distinguishedName,
        };
      });
      return {
        ...(groups.length > 0 ? { groups } : {}),
        import: { ...optionsOf(plan), ...(plan.classTap ? { classTap: plan.classTap } : {}) },
      };
    },
    requires(subject, roleGroups) {
      const groups = subject?.groups ?? [];
      if (groups.length === 0) return [];
      return [
        {
          capability: 'write:group.membership',
          reason:
            'Adding the new accounts to their groups takes the write:group.membership capability.',
        },
        ...membershipRequirements('add', groups, roleGroups),
      ];
    },
    input: rowInputSchema,
    run: (row, ctx) => runImportRow(row, ctx),
  };
}

type Failure = { step: ImportStep; message: string; code: string };
type Row = {
  id: string;
  attempts: number;
  input: RowInput;
  after: Record<string, unknown> | null;
};
type JobFacts = { id: string; created_at: Date; results_downloaded_at: Date | null };

async function runImportRow(row: Row, ctx: BulkRowContext): Promise<BulkRowOutcome> {
  const { input } = row;
  const { provider } = ctx;
  const job = await ctx.db
    .selectFrom('bulk_jobs')
    .select(['id', 'created_at', 'results_downloaded_at'])
    .where('id', '=', ctx.jobId)
    .executeTakeFirstOrThrow();
  const failures: Failure[] = [];
  const planned = accountSteps(input.options.enabled);

  let progress =
    progressOf(row.after) ??
    (await createdBefore(input, ctx)) ??
    (row.attempts > 1 ? await adopt(input, job, ctx) : null);
  let user: DirectoryUser | null;
  if (!progress) {
    const created = await createAccount(row, input, planned, job, ctx);
    if (!created.ok) return created.outcome;
    ({ progress, user } = created);
    if (created.failure) failures.push(created.failure);
  } else {
    progress = { ...progress, failed: [] };
    user = await findCreated(provider, progress, input);
    if (!user) {
      return {
        ok: false,
        errorCode: 'not_found',
        message: 'The account the import created is no longer in the directory.',
        audited: false,
        after: row.after,
      };
    }
    progress.id = user.objectGuid;
    progress.distinguishedName = user.distinguishedName;
    const left = remainingSteps(planned, progress.completed.filter(isAccountStep));
    if (left.length > 0) {
      const finished = await finishAccount(row, input, user, left, planned, progress, job, ctx);
      progress.completed = mergeSteps(progress.completed, finished.completed);
      if (finished.fallback) progress.passwordFallback = 'random';
      if (finished.failure) failures.push(finished.failure);
    }
  }

  // Steps with nothing to do are done, account or not.
  if (input.groupIds.length === 0) progress.completed = mergeSteps(progress.completed, ['groups']);
  if (!input.managerId && input.managerOrdinal === null) {
    progress.completed = mergeSteps(progress.completed, ['manager']);
  }

  // The cache shows the account at once, read with the service account.
  user ??= await findCreated(provider, progress, input);
  const live = user ? await ctx.services.userLiveRefresh.refresh(provider, user.objectGuid) : null;
  if (live) user = live.user;
  if (user) {
    progress.id = user.objectGuid;
    progress.distinguishedName = user.distinguishedName;
  }

  if (!user) {
    // Made, but neither read back nor found since: what's left waits for a retry.
    for (const step of IMPORT_STEPS) {
      if (step === 'create' || progress.completed.includes(step)) continue;
      if (failures.some((f) => f.step === step)) continue;
      failures.push({
        step,
        code: 'not_found',
        message: `${NOT_DONE[step]}: the new account couldn’t be read back. Retry once the directory answers.`,
      });
    }
  }

  if (user && !progress.completed.includes('groups')) {
    const done = new Set(progress.groups.filter((g) => g.isMember).map((g) => g.id.toLowerCase()));
    const added = await membershipRow(
      'add',
      { targetId: user.objectGuid, after: { groups: progress.groups } },
      input.groupIds.filter((id) => !done.has(id)),
      user,
      ctx,
    );
    const groups = added.after?.['groups'];
    if (Array.isArray(groups)) progress.groups = groups as ImportRowProgress['groups'];
    if (added.ok) progress.completed = mergeSteps(progress.completed, ['groups']);
    else {
      failures.push({
        step: 'groups',
        code: added.errorCode,
        message: added.message ?? `${NOT_DONE.groups}.`,
      });
    }
  }

  if (user && !progress.completed.includes('manager')) {
    const failure = await setManager(user, input, ctx);
    if (failure) failures.push(failure);
    else progress.completed = mergeSteps(progress.completed, ['manager']);
  }

  progress.failed = failures.map(({ step, message }) => ({ step, message }));
  const fields = {
    before: null,
    after: progress as unknown as Record<string, unknown>,
    targetDn: progress.distinguishedName,
    ...(progress.id ? { targetId: progress.id } : {}),
  };
  if (failures.length === 0) return { ok: true, ...fields };
  return {
    ok: false,
    errorCode: failures[0]!.code,
    message: [...new Set(failures.map((f) => f.message))].join(' '),
    partial: true,
    audited: true,
    ...fields,
  };
}

/**
 * What a run that stopped before recording the row (the process died, or
 * the row failed after the create) did, from its audit row: the account it
 * created, if it did, so the row isn't created twice.
 */
async function createdBefore(
  input: RowInput,
  ctx: BulkRowContext,
): Promise<ImportRowProgress | null> {
  const dn = childDn('CN', input.cn, input.ouDn);
  const create = await ctx.db
    .selectFrom('audit_events')
    .select(['target_id', 'target_dn', 'correlation_id', 'after_json'])
    .where('bulk_job_id', '=', ctx.jobId)
    .where('action', '=', 'user.create')
    .where(sql<string>`lower(target_dn)`, '=', dn.toLowerCase())
    .where(sql<boolean>`after_json->'completed' ? 'create'`)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!create) return null;
  const completed = create.after_json?.['completed'];
  return {
    id: create.target_id,
    distinguishedName: create.target_dn ?? dn,
    createCorrelationId: create.correlation_id,
    completed: Array.isArray(completed) ? (completed as ImportStep[]) : ['create'],
    groups: [],
    failed: [],
  };
}

/**
 * A retried row with no record of its create, whose account a run made
 * anyway (the create landed, then the process died before its audit row):
 * found by its planned names and taken on, its password and enabling run
 * again. Null when there's no such account, or it isn't the row's.
 */
async function adopt(
  input: RowInput,
  job: JobFacts,
  ctx: BulkRowContext,
): Promise<ImportRowProgress | null> {
  const found = await ctx.provider.getUser({
    kind: 'samAccountName',
    value: input.samAccountName,
  });
  if (!found) return null;
  const account = await ctx.provider.getAccountFingerprint({
    kind: 'objectGuid',
    value: found.objectGuid,
  });
  if (!adoptable(found, account?.whenCreated ?? null, input, new Date(job.created_at))) return null;
  return {
    id: found.objectGuid,
    distinguishedName: found.distinguishedName,
    createCorrelationId: null,
    completed: ['create'],
    groups: [],
    failed: [],
    adopted: true,
  };
}

/**
 * The account a row created: by id, else by DN, else by the logon name
 * and UPN just written (it may have been moved or renamed since, or not
 * read back at the time). Null when none answers.
 */
async function findCreated(
  provider: DirectoryProvider,
  progress: ImportRowProgress,
  input: RowInput,
): Promise<DirectoryUser | null> {
  if (progress.id) {
    const byId = await provider.getUser({ kind: 'objectGuid', value: progress.id });
    if (byId) return byId;
  }
  const byDn = await provider.getUser({
    kind: 'distinguishedName',
    value: progress.distinguishedName,
  });
  if (byDn) return byDn;
  const byName = await provider.getUser({ kind: 'samAccountName', value: input.samAccountName });
  return byName?.userPrincipalName?.toLowerCase() === input.userPrincipalName.toLowerCase()
    ? byName
    : null;
}

/**
 * The row's password, and whether it fell back to a random one: in random
 * mode one nobody sees; in set mode the one held for every row; in
 * generate mode the row's own, made and held before it's set so the
 * results CSV can hand it over. Once the job's passwords have been
 * downloaded, or the shared one has expired, a row still to get one gets
 * a random one instead, and its account needs a reset.
 */
async function passwordFor(
  row: { id: string },
  input: RowInput,
  job: JobFacts,
  ctx: BulkRowContext,
): Promise<{ password: string; mode: PasswordMode; mustChange: boolean; fallback: boolean }> {
  const account = { samAccountName: input.samAccountName, displayName: input.displayName };
  const { passwordMode: mode, mustChange } = input.options;
  const random = async (fallback: boolean) => ({
    password: await randomPassword(ctx.provider, account),
    mode: 'random' as const,
    mustChange: false,
    fallback,
  });
  if (mode === 'random') return random(false);
  if (!passwordsHoldable(job)) return random(true);
  const held = await heldPassword(ctx.db, ctx.jobId, row.id);
  if (held) return { password: held, mode, mustChange, fallback: false };
  if (mode === 'set') return random(true);
  const password = await handedOutPassword(ctx.provider, account);
  await holdPassword(ctx.db, ctx.jobId, row.id, password);
  return { password, mode, mustChange, fallback: false };
}

/** What the create writes: the row's attributes, its usage location only if the schema takes it. */
export function createInput(
  input: Omit<RowInput, 'options' | 'managerOrdinal'>,
  dn: string,
  usageLocationWritable: boolean,
): UserCreateInput {
  return {
    dn,
    cn: input.cn,
    samAccountName: input.samAccountName,
    userPrincipalName: input.userPrincipalName,
    givenName: input.givenName,
    surname: input.surname,
    displayName: input.displayName,
    mail: input.mail,
    otherMailbox: input.otherMailbox,
    mobile: input.mobile,
    telephoneNumber: input.telephoneNumber,
    organisation: input.organisation,
    // Set as its own step, once the manager exists.
    manager: null,
    initials: input.initials,
    employeeId: input.employeeId,
    description: input.description,
    usageLocation: usageLocationWritable ? input.usageLocation : null,
  };
}

/** What the create's audit row records of how far the account steps got. */
function stepsAudit(
  r: UserCreateResult,
  planned: UserCreateStep[],
  written: Record<string, unknown>,
) {
  return {
    ok: r.ok,
    errorCode: r.reason ?? null,
    errorMessage: r.errorMessage ?? null,
    targetId: r.user?.objectGuid ?? r.fingerprint?.objectGuid ?? null,
    after: r.completed.includes('create')
      ? {
          ...written,
          completed: r.completed,
          remaining: remainingSteps(planned, r.completed),
          account: r.fingerprint ?? null,
        }
      : null,
    created: r,
  };
}

function stepFailure(r: UserCreateResult): Failure | null {
  const step = r.failedStep;
  if (step !== 'password' && step !== 'enable') return null;
  const reason = r.errorMessage ? `: ${r.errorMessage}` : '.';
  return { step, code: r.reason ?? 'directory_error', message: `${NOT_DONE[step]}${reason}` };
}

/** How the password step is audited: the mode used, which a fallback makes random. */
const passwordAudit = (used: Awaited<ReturnType<typeof passwordFor>>) => ({
  passwordMode: used.mode,
  mustChange: used.mustChange,
  ...(used.fallback ? { passwordFallback: true } : {}),
});

/**
 * Create the account disabled, set its password and enable it if asked,
 * audited as the create route audits a create, with the job's id.
 */
async function createAccount(
  row: { id: string },
  input: RowInput,
  planned: UserCreateStep[],
  job: JobFacts,
  ctx: BulkRowContext,
): Promise<
  | { ok: true; progress: ImportRowProgress; user: DirectoryUser | null; failure: Failure | null }
  | { ok: false; outcome: BulkRowOutcome }
> {
  const { provider } = ctx;
  const dn = childDn('CN', input.cn, input.ouDn);
  const used = await passwordFor(row, input, job, ctx);
  const create = createInput(
    input,
    dn,
    !!input.usageLocation && (await provider.hasSchemaAttribute(USAGE_LOCATION_ATTRIBUTE)),
  );
  const written = {
    distinguishedName: dn,
    mail: input.mail,
    ...(Object.keys(input.organisation).length > 0 ? { organisation: input.organisation } : {}),
    ...(create.usageLocation ? { usageLocation: create.usageLocation } : {}),
  };
  const result = await withAudit(
    ctx.services.audit,
    {
      ...ctx.audit,
      action: 'user.create',
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: 'user',
      targetDn: dn,
      metadata: {
        ouDn: input.ouDn,
        samAccountName: input.samAccountName,
        userPrincipalName: input.userPrincipalName,
        ...passwordAudit(used),
        enabled: input.options.enabled,
        importLine: input.line,
      },
    },
    async () => {
      const r = await provider.createUser(
        create,
        planned,
        { password: used.password, mustChange: used.mustChange, groups: [] },
        ctx.writeCtx,
      );
      return stepsAudit(await readBack(provider, r, dn), planned, written);
    },
  );
  const r = result.created;
  if (!r.completed.includes('create')) {
    return {
      ok: false,
      outcome: {
        ok: false,
        errorCode: r.reason ?? 'directory_error',
        message: createRefused(r),
        audited: true,
      },
    };
  }
  return {
    ok: true,
    user: r.user ?? null,
    failure: stepFailure(r),
    progress: {
      id: r.user?.objectGuid ?? r.fingerprint?.objectGuid ?? null,
      distinguishedName: r.user?.distinguishedName ?? dn,
      createCorrelationId: ctx.audit.correlationId ?? null,
      completed: r.completed,
      groups: [],
      failed: [],
      ...(used.fallback && r.completed.includes('password')
        ? { passwordFallback: 'random' as const }
        : {}),
    },
  };
}

function createRefused(r: UserCreateResult): string {
  const detail = r.errorMessage ? `: ${r.errorMessage}` : '.';
  switch (r.reason) {
    case 'conflict':
      return `Not created: its name is taken${detail}`;
    case 'not_found':
      return 'Not created: its OU is no longer in the directory.';
    case 'permission_denied':
      return `Not created: the directory refused it${detail}`;
    default:
      return `Not created${detail}`;
  }
}

/** Run the account steps an earlier run left, audited as finishing a create. */
async function finishAccount(
  row: { id: string },
  input: RowInput,
  user: DirectoryUser,
  steps: UserCreateStep[],
  planned: UserCreateStep[],
  progress: ImportRowProgress,
  job: JobFacts,
  ctx: BulkRowContext,
): Promise<{ completed: UserCreateStep[]; failure: Failure | null; fallback: boolean }> {
  const { provider } = ctx;
  const used = steps.includes('password') ? await passwordFor(row, input, job, ctx) : null;
  const done = progress.completed.filter(isAccountStep);
  const result = await withAudit(
    ctx.services.audit,
    {
      ...ctx.audit,
      action: 'user.create.finish',
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: 'user',
      targetId: user.objectGuid,
      targetDn: user.distinguishedName,
      metadata: {
        createCorrelationId: progress.createCorrelationId,
        steps,
        ...(used ? passwordAudit(used) : {}),
        ...(progress.adopted ? { adopted: true } : {}),
      },
    },
    async () => {
      const r = await provider.finishUserCreate(
        { kind: 'objectGuid', value: user.objectGuid },
        steps,
        { password: used?.password ?? '', mustChange: used?.mustChange ?? false, groups: [] },
        ctx.writeCtx,
      );
      const all = { ...r, completed: [...done, ...r.completed] };
      return stepsAudit(await readBack(provider, all, user.distinguishedName), planned, {
        distinguishedName: user.distinguishedName,
      });
    },
  );
  const r = result.created;
  return {
    completed: r.completed,
    failure: stepFailure(r),
    fallback: !!used?.fallback && r.completed.includes('password'),
  };
}

/**
 * Set the manager: one already in the directory, found by GUID wherever
 * they are now (gone since the check, the account gets none, as the check
 * warned), or the one this import's earlier row created.
 */
async function setManager(
  user: DirectoryUser,
  input: RowInput,
  ctx: BulkRowContext,
): Promise<Failure | null> {
  const failed = (code: string, why: string): Failure => ({
    step: 'manager',
    code,
    message: `${NOT_DONE.manager}: ${why}`,
  });
  let managerId = input.managerId;
  if (input.managerOrdinal !== null) {
    const manager = await ctx.db
      .selectFrom('bulk_job_rows')
      .select(['target_id', 'target_name', 'input_json'])
      .where('job_id', '=', ctx.jobId)
      .where('ordinal', '=', input.managerOrdinal)
      .executeTakeFirst();
    const line = manager?.input_json?.['line'];
    const who = `${manager?.target_name ?? 'the manager'}${line ? ` (row ${String(line)})` : ''}`;
    if (!manager?.target_id) return failed('manager_not_created', `${who} wasn’t created.`);
    managerId = manager.target_id;
  }
  if (!managerId) return null;
  const manager = await ctx.provider.findObject({ kind: 'objectGuid', value: managerId });
  if (!manager) {
    return input.managerOrdinal === null
      ? null
      : failed('not_found', 'the manager’s account is no longer in the directory.');
  }
  if (user.managerDn?.toLowerCase() === manager.distinguishedName.toLowerCase()) return null;
  try {
    const result = await writeUserAttributes(
      ctx.services,
      ctx.provider,
      user,
      { managerDn: manager.distinguishedName },
      ctx.writeCtx,
      ctx.audit,
    );
    if (result.ok) return null;
    const code = result.errorCode ?? 'directory_error';
    return failed(
      code,
      result.errorMessage ? `${result.errorMessage}.` : 'the directory refused it.',
    );
  } catch (err) {
    if (err instanceof UserAttributeRefusal) return failed(err.code, err.message);
    if (err instanceof DirectoryUnavailableError) {
      return failed('directory_unavailable', 'no domain controller could be reached.');
    }
    throw err;
  }
}
