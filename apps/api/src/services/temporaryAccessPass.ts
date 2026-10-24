// SPDX-License-Identifier: BUSL-1.1
import {
  tapRequestProblem,
  type ExistingTap,
  type TapIssueResponse,
  type TapPolicy,
  type TapPreflight,
  type TapRefusalReason,
} from '@openaduc/shared';
import { z } from 'zod';
import { groupPrivilege, type GroupLike, type RoleGroup } from '../lib/groupPrivilege.js';
import type { GraphResponse } from './graphClient.js';

// Issuing a Temporary Access Pass to an AD user's Entra twin. Whoever holds
// a pass can sign in as the user, so a pass is never issued to anyone who
// administers AD, OpenADUC or Entra: that would let a helpdesk operator
// become one.
//
// The Entra user is found by the AD account's objectSid, which Connect Sync
// writes to onPremisesSecurityIdentifier. A UPN match would be unsafe: a
// cloud-only account can hold the UPN an AD account has been given.

export type TapGraph = {
  getJson<T>(path: string, opts?: { headers?: Record<string, string> }): Promise<GraphResponse<T>>;
  postJson<T>(path: string, body: unknown): Promise<GraphResponse<T>>;
};

export type TapGroup = GroupLike & { name: string | null };

export interface TapUser {
  sid: string | null;
  displayName: string | null;
  samAccountName: string | null;
}

export interface TapDeps {
  graph: TapGraph;
  /** The user's security groups, nested ones included; null when AD wouldn't say. */
  groups: () => Promise<TapGroup[] | null>;
  roleGroups: readonly RoleGroup[];
  now?: () => Date;
}

export interface TapPreflightResult {
  preflight: TapPreflight;
  entraUserId: string | null;
}

export type TapIssueCode =
  | 'privileged'
  | 'entra_admin_role'
  | 'membership_unknown'
  | 'policy_disabled'
  | 'unsynced'
  | 'outside_policy'
  | 'tap_exists';

export type TapIssueOutcome =
  | { ok: true; entraUserId: string; issued: TapIssueResponse }
  | { ok: false; code: TapIssueCode; message: string; existing?: ExistingTap };

const POLICY_PATH =
  '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/TemporaryAccessPass';
const passesPath = (entraUserId: string) =>
  `/users/${encodeURIComponent(entraUserId)}/authentication/temporaryAccessPassMethods`;
// Guards against a runaway nextLink chain; at 100 a page this is far more
// memberships than any real account has, and more than that fails closed.
const MAX_MEMBERSHIP_PAGES = 50;
const SID_PATTERN = /^S-1-\d+(-\d+)+$/;
const SPENT_REASONS = new Set(['Expired', 'OneTimeUsed', 'DisabledByPolicy']);

const REFUSAL_CODES: Record<TapRefusalReason, TapIssueCode> = {
  privileged: 'privileged',
  entraAdminRole: 'entra_admin_role',
  membershipUnknown: 'membership_unknown',
  policyDisabled: 'policy_disabled',
};

const policySchema = z.object({
  state: z.string(),
  defaultLifetimeInMinutes: z.number().int(),
  minimumLifetimeInMinutes: z.number().int(),
  maximumLifetimeInMinutes: z.number().int(),
  isUsableOnce: z.boolean(),
});

const passSchema = z.object({
  createdDateTime: z.string().nullish(),
  startDateTime: z.string().nullish(),
  lifetimeInMinutes: z.number().int().nullish(),
  isUsableOnce: z.boolean().nullish(),
  isUsable: z.boolean().nullish(),
  methodUsabilityReason: z.string().nullish(),
});

const createdPassSchema = z.object({
  temporaryAccessPass: z.string().min(1),
  createdDateTime: z.string().nullish(),
  startDateTime: z.string().nullish(),
  lifetimeInMinutes: z.number().int(),
  isUsableOnce: z.boolean(),
});

const listOf = <T extends z.ZodType>(item: T) =>
  z.object({ value: z.array(item), '@odata.nextLink': z.string().optional() });

const WHY_NOT =
  'Whoever holds a Temporary Access Pass can sign in as them, so OpenADUC doesn’t issue one to an administrator.';

export async function tapPreflight(deps: TapDeps, user: TapUser): Promise<TapPreflightResult> {
  const who = user.displayName ?? user.samAccountName ?? 'This user';
  const refused = (reason: TapRefusalReason, message: string): TapPreflightResult => ({
    preflight: { status: 'refused', reason, message },
    entraUserId: null,
  });

  // AD first: a privileged account is refused without asking Graph anything.
  const groups = await deps.groups();
  if (!groups || !user.sid || !SID_PATTERN.test(user.sid)) {
    return refused(
      'membershipUnknown',
      `AD didn’t say which groups ${who} is in, so OpenADUC can’t check they aren’t an administrator.`,
    );
  }
  const privileged = privilegedMembership(groups, deps.roleGroups);
  if (privileged) {
    const name = privileged.group.name ?? privileged.group.distinguishedName;
    const why =
      privileged.via === 'protected'
        ? `${name}, which AD protects as an administrators’ group`
        : `${name}, which gives OpenADUC’s Admin role`;
    return refused('privileged', `${who} is a member of ${why}. ${WHY_NOT}`);
  }

  const { graph } = deps;
  const policy = policySchema.parse((await graph.getJson(POLICY_PATH)).data);
  if (policy.state !== 'enabled') {
    return refused(
      'policyDisabled',
      'Temporary Access Pass is turned off in the tenant’s authentication methods policy. Turn it on in the Microsoft Entra admin center first.',
    );
  }

  const entraUserId = await findEntraUser(graph, user.sid);
  if (!entraUserId) {
    return {
      preflight: { status: 'unsynced', lastSyncAt: await tenantLastSync(graph) },
      entraUserId: null,
    };
  }
  if (await holdsEntraRole(graph, entraUserId)) {
    return refused(
      'entraAdminRole',
      `${who} holds a Microsoft Entra administrator role. ${WHY_NOT}`,
    );
  }

  const passes = listOf(passSchema).parse((await graph.getJson(passesPath(entraUserId))).data);
  const now = deps.now?.() ?? new Date();
  const live = passes.value.find((p) => !isSpent(p, now));
  return {
    preflight: {
      status: 'ready',
      policy: {
        defaultLifetimeMinutes: policy.defaultLifetimeInMinutes,
        minLifetimeMinutes: policy.minimumLifetimeInMinutes,
        maxLifetimeMinutes: policy.maximumLifetimeInMinutes,
        usableOnceOnly: policy.isUsableOnce,
      } satisfies TapPolicy,
      existing: live ? toExisting(live) : null,
    },
    entraUserId,
  };
}

/**
 * Issue a pass, checking everything the preflight does again first. Graph
 * keeps one pass per user and replaces the old one itself, so a replace is
 * a plain create once the operator has been warned.
 */
export async function issueTap(
  deps: TapDeps,
  user: TapUser,
  request: {
    startsAt: string | null;
    lifetimeMinutes: number;
    isUsableOnce: boolean;
    replaceExisting: boolean;
  },
): Promise<TapIssueOutcome> {
  const { preflight, entraUserId } = await tapPreflight(deps, user);
  if (preflight.status === 'refused') {
    return { ok: false, code: REFUSAL_CODES[preflight.reason], message: preflight.message };
  }
  if (preflight.status === 'unsynced' || !entraUserId) {
    return {
      ok: false,
      code: 'unsynced',
      message: 'This user isn’t in Microsoft Entra yet: they appear after Connect Sync next runs.',
    };
  }
  const now = deps.now?.() ?? new Date();
  const problem = tapRequestProblem(preflight.policy, request, now);
  if (problem) return { ok: false, code: 'outside_policy', message: problem };
  if (preflight.existing && !request.replaceExisting) {
    return {
      ok: false,
      code: 'tap_exists',
      message: 'This user already has a Temporary Access Pass. Issuing another replaces it.',
      existing: preflight.existing,
    };
  }

  const created = createdPassSchema.parse(
    (
      await deps.graph.postJson(passesPath(entraUserId), {
        ...(request.startsAt ? { startDateTime: new Date(request.startsAt).toISOString() } : {}),
        lifetimeInMinutes: request.lifetimeMinutes,
        isUsableOnce: request.isUsableOnce,
      })
    ).data,
  );
  const startsAt = new Date(created.startDateTime ?? created.createdDateTime ?? now);
  return {
    ok: true,
    entraUserId,
    issued: {
      temporaryAccessPass: created.temporaryAccessPass,
      startsAt: startsAt.toISOString(),
      expiresAt: new Date(startsAt.getTime() + created.lifetimeInMinutes * 60_000).toISOString(),
      lifetimeMinutes: created.lifetimeInMinutes,
      isUsableOnce: created.isUsableOnce,
      replaced: preflight.existing !== null,
    },
  };
}

function privilegedMembership(
  groups: readonly TapGroup[],
  roleGroups: readonly RoleGroup[],
): { group: TapGroup; via: 'protected' | 'adminRole' } | null {
  const adminGroups = roleGroups.filter((g) => g.role === 'admin');
  for (const group of groups) {
    const privilege = groupPrivilege(group, adminGroups);
    if (privilege?.reason === 'protected') return { group, via: 'protected' };
    if (privilege?.reason === 'role') return { group, via: 'adminRole' };
  }
  return null;
}

async function findEntraUser(graph: TapGraph, sid: string): Promise<string | null> {
  // Filtering on onPremisesSecurityIdentifier is an advanced query.
  const res = await graph.getJson(
    `/users?$filter=onPremisesSecurityIdentifier eq '${sid}'&$select=id,userPrincipalName&$count=true`,
    { headers: { ConsistencyLevel: 'eventual' } },
  );
  const users = listOf(z.object({ id: z.string() })).parse(res.data).value;
  return users[0]?.id ?? null;
}

// With User.Read.All, Graph returns a directory role among the memberships
// with only its type and id, which is all this needs.
async function holdsEntraRole(graph: TapGraph, entraUserId: string): Promise<boolean> {
  const page = listOf(z.object({ '@odata.type': z.string().optional() }).loose());
  let next: string | undefined = `/users/${encodeURIComponent(entraUserId)}/transitiveMemberOf`;
  for (let i = 0; next && i < MAX_MEMBERSHIP_PAGES; i++) {
    const res = page.parse((await graph.getJson(next)).data);
    if (res.value.some((m) => m['@odata.type'] === '#microsoft.graph.directoryRole')) return true;
    next = res['@odata.nextLink'];
  }
  return next !== undefined;
}

async function tenantLastSync(graph: TapGraph): Promise<string | null> {
  try {
    const res = await graph.getJson<{ value?: { onPremisesLastSyncDateTime?: string | null }[] }>(
      '/organization?$select=onPremisesLastSyncDateTime',
    );
    const at = res.data?.value?.[0]?.onPremisesLastSyncDateTime;
    return at ? new Date(at).toISOString() : null;
  } catch {
    return null;
  }
}

function isSpent(pass: z.infer<typeof passSchema>, now: Date): boolean {
  if (pass.methodUsabilityReason && SPENT_REASONS.has(pass.methodUsabilityReason)) return true;
  const start = pass.startDateTime ?? pass.createdDateTime;
  if (!start || !pass.lifetimeInMinutes) return false;
  return Date.parse(start) + pass.lifetimeInMinutes * 60_000 <= now.getTime();
}

function toExisting(pass: z.infer<typeof passSchema>): ExistingTap {
  return {
    createdAt: pass.createdDateTime ?? null,
    startsAt: pass.startDateTime ?? null,
    lifetimeMinutes: pass.lifetimeInMinutes ?? null,
    isUsableOnce: pass.isUsableOnce ?? null,
    isUsable: pass.isUsable ?? null,
    usabilityReason: pass.methodUsabilityReason ?? null,
  };
}
