// SPDX-License-Identifier: BUSL-1.1
import {
  TAP_POLICY_OFF_MESSAGE,
  tapExpiresAt,
  tapRequestProblem,
  type ExistingTap,
  type TapIssueResponse,
  type TapPolicy,
  type TapPreflight,
  type TapRefusalReason,
} from '@openaduc/shared';
import { z } from 'zod';
import {
  groupPrivilege,
  privilegedSidName,
  type GroupLike,
  type RoleGroup,
} from '../lib/groupPrivilege.js';
import {
  allPages,
  findEntraUser,
  listOf,
  tenantLastSync,
  type GraphReader,
} from './entraLookup.js';
import { rawScalarValue } from '../lib/rawAttributes.js';
import { AppError } from '../plugins/errorHandler.js';
import type { DirectoryUser } from '../providers/types.js';
import { GraphPermissionError, type GraphResponse } from './graphClient.js';

// Issuing a Temporary Access Pass to an AD user's Entra twin. Whoever holds
// a pass can sign in as the user, so a pass is never issued to anyone who
// administers AD, OpenADUC or Entra: that would let a helpdesk operator
// become one. Every check that can't be completed refuses.

export type TapGraph = GraphReader & {
  postJson<T>(path: string, body: unknown): Promise<GraphResponse<T>>;
};

export type TapGroup = GroupLike & { name: string | null };

export interface TapUser {
  sid: string | null;
  displayName: string | null;
  samAccountName: string | null;
  /** AdminSDHolder has marked the account itself (adminCount=1). */
  protectedAccount: boolean;
}

export const TapNotEnabled = () =>
  new AppError({
    statusCode: 409,
    code: 'tap_not_enabled',
    message:
      'Temporary Access Pass isn’t turned on for this directory. An administrator turns it on in Settings → Integrations.',
  });

export const tapUserOf = (user: DirectoryUser): TapUser => ({
  sid: user.sid,
  displayName: user.displayName,
  samAccountName: user.samAccountName,
  protectedAccount: rawScalarValue(user.rawAttributes['adminCount']) === '1',
});

export interface TapDeps {
  graph: TapGraph;
  /**
   * The user's security groups, nested ones included: every SID, and the
   * groups found for them; null when AD wouldn't say.
   */
  tokenGroups: () => Promise<{ sids: string[]; groups: TapGroup[] } | null>;
  roleGroups: readonly RoleGroup[];
  now?: () => Date;
}

export interface TapPreflightResult {
  preflight: TapPreflight;
  entraUserId: string | null;
  /** The passes Entra lists for the user, spent ones included, when it was asked. */
  passes?: TapMethod[];
}

export type TapMethod = z.infer<typeof passSchema>;

export type TapIssueCode =
  | 'privileged'
  | 'entra_admin_role'
  | 'entra_roles_unknown'
  | 'membership_unknown'
  | 'policy_disabled'
  | 'unsynced'
  | 'outside_policy'
  | 'tap_exists';

export type TapIssueOutcome =
  | { ok: true; entraUserId: string; methodId: string | null; issued: TapIssueResponse }
  | { ok: false; code: TapIssueCode; message: string; existing?: ExistingTap };

const POLICY_PATH =
  '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/TemporaryAccessPass';
const ASSIGNMENTS_PATH = '/roleManagement/directory/roleAssignments?$select=principalId';
const ELIGIBILITIES_PATH =
  '/roleManagement/directory/roleEligibilityScheduleInstances?$select=principalId';
// Without an explicit language Node's fetch sends `Accept-Language: *`,
// which the role-management backend has been seen to refuse as an unknown
// culture (400 CultureNotFoundException).
const ROLE_HEADERS = { 'Accept-Language': 'en-US' };
const passesPath = (entraUserId: string) =>
  `/users/${encodeURIComponent(entraUserId)}/authentication/temporaryAccessPassMethods`;
// The policy changes rarely; a pass checked against one a minute old is
// still checked again by Entra when it's created.
const POLICY_TTL_MS = 60_000;
const SID_PATTERN = /^S-1-\d+(-\d+)+$/;
const SPENT_REASONS = new Set(['Expired', 'OneTimeUsed', 'DisabledByPolicy']);
// DnsAdmins has no well-known SID; a group of that name where AD creates
// it is the best this can do.
const DNS_ADMINS = /^CN=DnsAdmins,CN=Users,DC=/i;

export const REFUSAL_CODES: Record<TapRefusalReason, TapIssueCode> = {
  privileged: 'privileged',
  entraAdminRole: 'entra_admin_role',
  entraRolesUnknown: 'entra_roles_unknown',
  membershipUnknown: 'membership_unknown',
  policyDisabled: 'policy_disabled',
};

const targetSchema = z.object({ id: z.string() });
const policySchema = z.object({
  state: z.string(),
  defaultLifetimeInMinutes: z.number().int(),
  minimumLifetimeInMinutes: z.number().int(),
  maximumLifetimeInMinutes: z.number().int(),
  isUsableOnce: z.boolean(),
  includeTargets: z.array(targetSchema).optional(),
  excludeTargets: z.array(targetSchema).optional(),
});
type GraphPolicy = z.infer<typeof policySchema>;

const passSchema = z.object({
  id: z.string().nullish(),
  createdDateTime: z.string().nullish(),
  startDateTime: z.string().nullish(),
  lifetimeInMinutes: z.number().int().nullish(),
  isUsableOnce: z.boolean().nullish(),
  isUsable: z.boolean().nullish(),
  methodUsabilityReason: z.string().nullish(),
});

const createdPassSchema = z.object({
  id: z.string().nullish(),
  temporaryAccessPass: z.string().min(1),
  createdDateTime: z.string().nullish(),
  startDateTime: z.string().nullish(),
  lifetimeInMinutes: z.number().int(),
  isUsableOnce: z.boolean(),
});

const membershipSchema = z.object({ id: z.string(), '@odata.type': z.string().optional() });
const principalSchema = z.object({ principalId: z.string() });

const WHY_NOT =
  'Whoever holds a Temporary Access Pass can sign in as them, so OpenADUC doesn’t issue one to an administrator.';

// Per Graph client, so new credentials (a new client) read it afresh.
const policyCache = new WeakMap<GraphReader, { policy: GraphPolicy; at: number }>();

/** The tenant's Temporary Access Pass policy, as far as OpenADUC heeds it; null when it's turned off. */
export async function tenantTapPolicy(
  graph: GraphReader,
  now: Date = new Date(),
): Promise<TapPolicy | null> {
  const policy = await readPolicy(graph, now);
  return policy.state === 'enabled' ? policyLimits(policy) : null;
}

const policyLimits = (policy: GraphPolicy): TapPolicy => ({
  defaultLifetimeMinutes: policy.defaultLifetimeInMinutes,
  minLifetimeMinutes: policy.minimumLifetimeInMinutes,
  maxLifetimeMinutes: policy.maximumLifetimeInMinutes,
  usableOnceOnly: policy.isUsableOnce,
});

export async function tapPreflight(deps: TapDeps, user: TapUser): Promise<TapPreflightResult> {
  const now = deps.now?.() ?? new Date();
  const who = user.displayName ?? user.samAccountName ?? 'This user';
  const refused = (reason: TapRefusalReason, message: string): TapPreflightResult => ({
    preflight: { status: 'refused', reason, message },
    entraUserId: null,
  });

  // AD first: a privileged account is refused without asking Graph anything.
  if (user.protectedAccount) {
    return refused(
      'privileged',
      `AD protects ${who}’s account as an administrator’s (adminCount). ${WHY_NOT}`,
    );
  }
  const token = await deps.tokenGroups();
  const privilege =
    token && user.sid && SID_PATTERN.test(user.sid)
      ? tokenPrivilege(token, deps.roleGroups)
      : ({ kind: 'unknown' } as const);
  if (privilege?.kind === 'privileged') {
    return refused('privileged', `${who} is a member of ${privilege.why}. ${WHY_NOT}`);
  }
  if (privilege?.kind === 'unknown') {
    return refused(
      'membershipUnknown',
      `AD didn’t say which groups ${who} is in, or named one OpenADUC can’t find, so it can’t check they aren’t an administrator.`,
    );
  }

  const { graph } = deps;
  const policy = await readPolicy(graph, now);
  if (policy.state !== 'enabled') {
    return refused('policyDisabled', TAP_POLICY_OFF_MESSAGE);
  }

  const entraUserId = await findEntraUser(graph, user.sid!);
  if (!entraUserId) {
    return {
      preflight: { status: 'unsynced', lastSyncAt: await tenantLastSync(graph) },
      entraUserId: null,
    };
  }
  const roles = await entraRoles(graph, entraUserId);
  if (roles.status === 'holds') {
    return refused(
      'entraAdminRole',
      `${who} holds, or is eligible for, a Microsoft Entra role. ${WHY_NOT}`,
    );
  }
  if (roles.status === 'unknown') {
    return refused(
      'entraRolesUnknown',
      `OpenADUC couldn’t check whether ${who} holds a Microsoft Entra role${roles.hint ? ` (${roles.hint})` : ''}, so it doesn’t issue a pass.`,
    );
  }

  const passes = listOf(passSchema).parse((await graph.getJson(passesPath(entraUserId))).data);
  const live = passes.value.find((p) => !isSpent(p, now));
  return {
    preflight: {
      status: 'ready',
      policy: policyLimits(policy),
      existing: live ? toExisting(live) : null,
      inPolicyScope: inScope(policy, roles.groupIds),
    },
    entraUserId,
    passes: passes.value,
  };
}

/**
 * Issue a pass, checking everything the preflight does again first. Graph
 * keeps one pass per user and replaces the old one itself, so a replace is
 * a plain create once the operator has been warned. `fitLifetime` brings
 * the lifetime within the policy's range rather than refusing it: a class
 * pass made after class started lasts until class ends, or the shortest
 * the tenant allows.
 */
export async function issueTap(
  deps: TapDeps,
  user: TapUser,
  asked: {
    startsAt: string | null;
    lifetimeMinutes: number;
    isUsableOnce: boolean;
    replaceExisting: boolean;
    fitLifetime?: boolean;
  },
): Promise<TapIssueOutcome> {
  const now = deps.now?.() ?? new Date();
  const { preflight, entraUserId } = await tapPreflight({ ...deps, now: () => now }, user);
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
  const { minLifetimeMinutes: min, maxLifetimeMinutes: max } = preflight.policy;
  const request = asked.fitLifetime
    ? { ...asked, lifetimeMinutes: Math.min(max, Math.max(min, asked.lifetimeMinutes)) }
    : asked;
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
    methodId: created.id ?? null,
    issued: {
      temporaryAccessPass: created.temporaryAccessPass,
      startsAt: startsAt.toISOString(),
      expiresAt: tapExpiresAt(startsAt, created.lifetimeInMinutes).toISOString(),
      lifetimeMinutes: created.lifetimeInMinutes,
      isUsableOnce: created.isUsableOnce,
      replaced: preflight.existing !== null,
    },
  };
}

type TokenPrivilege = { kind: 'privileged'; why: string } | { kind: 'unknown' } | null;

/**
 * What the user's token groups make them. The well-known SIDs need no
 * lookup, so they decide even for a group outside the base DN or in
 * another domain; adminCount and OpenADUC's role groups need the group,
 * and a SID with no group found can't be cleared.
 */
export function tokenPrivilege(
  token: { sids: readonly string[]; groups: readonly TapGroup[] },
  roleGroups: readonly RoleGroup[],
): TokenPrivilege {
  const bySid = new Map(token.groups.map((g) => [g.sid, g]));
  for (const sid of token.sids) {
    const wellKnown = privilegedSidName(sid);
    if (wellKnown) return { kind: 'privileged', why: bySid.get(sid)?.name ?? wellKnown };
  }
  const adminGroups = roleGroups.filter((g) => g.role === 'admin');
  for (const group of token.groups) {
    const name = group.name ?? group.distinguishedName;
    const privilege = groupPrivilege(group, adminGroups);
    if (privilege?.reason === 'protected') {
      return { kind: 'privileged', why: `${name}, which AD protects as an administrators’ group` };
    }
    if (DNS_ADMINS.test(group.distinguishedName)) {
      return { kind: 'privileged', why: `${name}, which can run code on domain controllers` };
    }
    if (privilege?.reason === 'role') {
      return { kind: 'privileged', why: `${name}, which gives OpenADUC’s Admin role` };
    }
  }
  return token.sids.every((sid) => bySid.has(sid)) ? null : { kind: 'unknown' };
}

async function readPolicy(graph: GraphReader, now: Date): Promise<GraphPolicy> {
  const cached = policyCache.get(graph);
  if (cached && now.getTime() - cached.at < POLICY_TTL_MS) return cached.policy;
  const policy = policySchema.parse((await graph.getJson(POLICY_PATH)).data);
  policyCache.set(graph, { policy, at: now.getTime() });
  return policy;
}

type EntraRoles =
  | { status: 'none'; groupIds: Set<string> }
  | { status: 'holds' }
  | { status: 'unknown'; hint: string | null };

/**
 * Whether the user holds or is eligible for any Entra role, directly or
 * through a group, at any scope (custom and administrative-unit roles
 * included). Assignments are listed tenant-wide and matched against the
 * user and their groups, as Graph can't filter by transitive principal.
 */
async function entraRoles(graph: TapGraph, entraUserId: string): Promise<EntraRoles> {
  try {
    const principals = new Set([entraUserId]);
    const groupIds = new Set<string>();
    const memberships = await allPages(
      graph,
      `/users/${encodeURIComponent(entraUserId)}/transitiveMemberOf`,
      membershipSchema,
    );
    if (!memberships) return { status: 'unknown', hint: null };
    for (const m of memberships) {
      if (m['@odata.type'] === '#microsoft.graph.directoryRole') return { status: 'holds' };
      principals.add(m.id);
      if (m['@odata.type'] === '#microsoft.graph.group') groupIds.add(m.id);
    }
    const assigned = await allPages(graph, ASSIGNMENTS_PATH, principalSchema, ROLE_HEADERS);
    const eligible = await allPages(graph, ELIGIBILITIES_PATH, principalSchema, ROLE_HEADERS).catch(
      (err: unknown) => {
        // A tenant without Entra ID P2 or Governance has no PIM, so nothing
        // can be eligible; Graph says so with this 400 rather than an empty list.
        if (err instanceof GraphPermissionError && err.graphCode === 'AadPremiumLicenseRequired') {
          return [];
        }
        throw err;
      },
    );
    if (!assigned || !eligible) return { status: 'unknown', hint: null };
    if ([...assigned, ...eligible].some((a) => principals.has(a.principalId))) {
      return { status: 'holds' };
    }
    return { status: 'none', groupIds };
  } catch (err) {
    if (err instanceof GraphPermissionError) return { status: 'unknown', hint: err.hint };
    throw err;
  }
}

function inScope(policy: GraphPolicy, groupIds: Set<string>): boolean | null {
  if (!policy.includeTargets) return null;
  const included = policy.includeTargets.some((t) => t.id === 'all_users' || groupIds.has(t.id));
  const excluded = (policy.excludeTargets ?? []).some((t) => groupIds.has(t.id));
  return included && !excluded;
}

function isSpent(pass: z.infer<typeof passSchema>, now: Date): boolean {
  if (pass.methodUsabilityReason && SPENT_REASONS.has(pass.methodUsabilityReason)) return true;
  const start = pass.startDateTime ?? pass.createdDateTime;
  if (!start || !pass.lifetimeInMinutes) return false;
  return tapExpiresAt(start, pass.lifetimeInMinutes) <= now;
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
