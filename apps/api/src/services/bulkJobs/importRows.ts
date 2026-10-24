// SPDX-License-Identifier: BUSL-1.1
// An import as a bulk job: one row per account to create, each run in
// IMPORT_STEPS' order, a row whose manager the import creates after that
// manager's row. What a row has done is kept in its after_json, so a
// retry runs only the steps still missing and never creates the account
// twice. Passwords are held in import_passwords, never in the rows.
import {
  IMPORT_JOB_ACTION,
  NEW_USER_ORGANISATION_FIELDS,
  PASSWORD_MODES,
  childDn,
  generatePassword,
  importPasswordSchema,
  remainingSteps,
  type ImportStep,
  type UserCreateStep,
} from '@openaduc/shared';
import { z } from 'zod';
import {
  DirectoryUnavailableError,
  type DirectoryProvider,
  type DirectoryUser,
  type UserCreateResult,
} from '../../providers/types.js';
import { withAudit } from '../auditContext.js';
import { findCachedGroupsById } from '../groupCache.js';
import { membershipRequirement } from '../groupMembershipWrite.js';
import { heldPassword, holdPassword, passwordsHoldable } from '../importPasswords.js';
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
  // Not written yet: kept on the row for the steps that will use them.
  usageLocation: text,
  startDate: text,
});
export type ImportPlanRow = z.infer<typeof importPlanRowSchema>;

export const importPlanSchema = z.object({
  rows: z.array(importPlanRowSchema).min(1),
  password: importPasswordSchema,
  enabled: z.boolean(),
});
export type ImportPlan = z.infer<typeof importPlanSchema>;

const rowInputSchema = importPlanRowSchema.omit({ managerRow: true }).extend({
  /** The row creating the manager, by its ordinal in the job. */
  managerOrdinal: z.number().int().nullable(),
  options: z.object({
    passwordMode: z.enum(PASSWORD_MODES),
    mustChange: z.boolean(),
    enabled: z.boolean(),
  }),
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

/** The account steps the provider runs, in AD's order, of the import's steps. */
const accountSteps = (enabled: boolean): UserCreateStep[] =>
  enabled ? ['create', 'password', 'enable'] : ['create', 'password'];

const STEP_FAILED: Record<'password' | 'enable', string> = {
  password: 'Password not set',
  enable: 'Not enabled',
};

export function importHandler(): BulkJobHandler<ImportPlan, RowInput, string | null> {
  return {
    action: IMPORT_JOB_ACTION,
    capability: 'write:user.create',
    request: importPlanSchema,
    rows(plan) {
      const order = managersFirst(plan.rows);
      const ordinal = new Map(order.map((i, at) => [i, at]));
      const options = {
        passwordMode: plan.password.mode,
        mustChange: plan.password.mode !== 'random' && plan.password.mustChange,
        enabled: plan.enabled,
      };
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
        import: {
          passwordMode: plan.password.mode,
          mustChange: plan.password.mode !== 'random' && plan.password.mustChange,
          enabled: plan.enabled,
        },
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
        ...[membershipRequirement('add', groups, roleGroups)].filter((r) => r !== null),
      ];
    },
    input: rowInputSchema,
    run: (row, ctx) => runImportRow(row, ctx),
  };
}

type Failure = { step: ImportStep; message: string; code: string };

async function runImportRow(
  row: {
    id: string;
    targetId: string | null;
    input: RowInput;
    after: Record<string, unknown> | null;
  },
  ctx: BulkRowContext,
): Promise<BulkRowOutcome> {
  const { input } = row;
  const { provider } = ctx;
  const earlier = progressOf(row.after);
  const failures: Failure[] = [];
  const planned = accountSteps(input.options.enabled);

  let progress: ImportRowProgress;
  let user: DirectoryUser | null;
  if (!earlier) {
    const created = await createAccount(row, input, planned, ctx);
    if (!created.ok) return created.outcome;
    ({ progress, user } = created);
    if (created.failure) failures.push(created.failure);
  } else {
    progress = { ...earlier, failed: [] };
    user = await findCreated(provider, progress);
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
      const finished = await finishAccount(row, input, user, left, planned, progress, ctx);
      progress.completed = mergeSteps(progress.completed, finished.completed);
      if (finished.failure) failures.push(finished.failure);
    }
  }

  // The cache shows the account at once, read with the service account.
  const live = user ? await ctx.services.userLiveRefresh.refresh(provider, user.objectGuid) : null;
  if (live) user = live.user;

  if (user && !progress.completed.includes('groups')) {
    if (input.groupIds.length === 0)
      progress.completed = mergeSteps(progress.completed, ['groups']);
    else {
      const done = new Set(
        progress.groups.filter((g) => g.isMember).map((g) => g.id.toLowerCase()),
      );
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
          message: added.message ?? 'Not added to its groups.',
        });
      }
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
    message: failures.map((f) => f.message).join(' '),
    partial: true,
    audited: true,
    ...fields,
  };
}

const isAccountStep = (s: ImportStep): s is UserCreateStep =>
  s === 'create' || s === 'password' || s === 'enable';

/** Steps done, in IMPORT_STEPS' order whatever order they were done in. */
function mergeSteps(done: readonly ImportStep[], more: readonly ImportStep[]): ImportStep[] {
  const all = new Set([...done, ...more]);
  return (['create', 'password', 'enable', 'groups', 'manager'] as const).filter((s) => all.has(s));
}

/** The account a row created, by id, or by DN if it couldn't be read back then. */
async function findCreated(
  provider: DirectoryProvider,
  progress: ImportRowProgress,
): Promise<DirectoryUser | null> {
  return progress.id
    ? provider.getUser({ kind: 'objectGuid', value: progress.id })
    : provider.getUser({ kind: 'distinguishedName', value: progress.distinguishedName });
}

/**
 * The row's password: in random mode one nobody sees; in set mode the one
 * held for every row; in generate mode the row's own, made and held before
 * it's set so the results CSV can hand it over. Once the job's passwords
 * have been downloaded or have expired, nothing more is held, and a row
 * still to get one gets a random one: its account needs a reset.
 */
async function passwordFor(
  row: { id: string },
  input: RowInput,
  ctx: BulkRowContext,
): Promise<string> {
  const account = { samAccountName: input.samAccountName, displayName: input.displayName };
  const mode = input.options.passwordMode;
  if (mode === 'random') return randomPassword(ctx.provider, account);
  const held = await heldPassword(ctx.db, ctx.jobId, row.id);
  if (held) return held;
  const job = await ctx.db
    .selectFrom('bulk_jobs')
    .select(['id', 'created_at', 'results_downloaded_at'])
    .where('id', '=', ctx.jobId)
    .executeTakeFirstOrThrow();
  if (mode === 'set' || !passwordsHoldable(job)) return randomPassword(ctx.provider, account);
  const policy = await ctx.provider.getDomainPolicy().catch(() => null);
  let password: string;
  // The results CSV would quote one starting like a formula, changing it.
  do password = generatePassword(policy, account);
  while (/^[=+\-@]/.test(password));
  await holdPassword(ctx.db, job, row.id, password);
  return password;
}

function createInput(input: RowInput, dn: string) {
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
  return { step, code: r.reason ?? 'directory_error', message: `${STEP_FAILED[step]}${reason}` };
}

/**
 * Create the account disabled, set its password and enable it if asked,
 * audited as the create route audits a create, with the job's id.
 */
async function createAccount(
  row: { id: string },
  input: RowInput,
  planned: UserCreateStep[],
  ctx: BulkRowContext,
): Promise<
  | { ok: true; progress: ImportRowProgress; user: DirectoryUser | null; failure: Failure | null }
  | { ok: false; outcome: BulkRowOutcome }
> {
  const { provider } = ctx;
  const dn = childDn('CN', input.cn, input.ouDn);
  const password = await passwordFor(row, input, ctx);
  const written = {
    distinguishedName: dn,
    mail: input.mail,
    ...(Object.keys(input.organisation).length > 0 ? { organisation: input.organisation } : {}),
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
        passwordMode: input.options.passwordMode,
        mustChange: input.options.mustChange,
        enabled: input.options.enabled,
        importLine: input.line,
      },
    },
    async () => {
      const r = await provider.createUser(
        createInput(input, dn),
        planned,
        { password, mustChange: input.options.mustChange, groups: [] },
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
  const failure = stepFailure(r);
  return {
    ok: true,
    user: r.user ?? null,
    failure,
    progress: {
      id: r.user?.objectGuid ?? r.fingerprint?.objectGuid ?? null,
      distinguishedName: r.user?.distinguishedName ?? dn,
      createCorrelationId: ctx.audit.correlationId ?? null,
      completed: r.completed,
      groups: [],
      failed: [],
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
  ctx: BulkRowContext,
): Promise<{ completed: UserCreateStep[]; failure: Failure | null }> {
  const { provider } = ctx;
  const password = steps.includes('password') ? await passwordFor(row, input, ctx) : '';
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
        ...(steps.includes('password')
          ? { passwordMode: input.options.passwordMode, mustChange: input.options.mustChange }
          : {}),
      },
    },
    async () => {
      const r = await provider.finishUserCreate(
        { kind: 'objectGuid', value: user.objectGuid },
        steps,
        { password, mustChange: input.options.mustChange, groups: [] },
        ctx.writeCtx,
      );
      const all = { ...r, completed: [...done, ...r.completed] };
      return stepsAudit(await readBack(provider, all, user.distinguishedName), planned, {
        distinguishedName: user.distinguishedName,
      });
    },
  );
  return { completed: result.created.completed, failure: stepFailure(result.created) };
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
    message: `Manager not set: ${why}`,
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
