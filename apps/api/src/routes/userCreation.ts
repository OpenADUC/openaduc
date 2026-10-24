// SPDX-License-Identifier: BUSL-1.1
import {
  NOTHING_TAKEN,
  childDn,
  generatePassword,
  phonesToWrite,
  plannedSteps,
  remainingSteps,
  resolveNames,
  userCreateFinishRequestSchema,
  userCreateRequestSchema,
  type CopiedGroup,
  type GroupPrivilege,
  type Role,
  type UserCopySource,
  type UserCreatePassword,
  type UserCreateResponse,
  type UserCreateStep,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isProtectedGroup } from '../lib/groupDeletion.js';
import { rawScalarValue } from '../lib/rawAttributes.js';
import { ridOf } from '../lib/sid.js';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../plugins/errorHandler.js';
import { parentDn } from '../providers/active-directory/normalize.js';
import type {
  DirectoryProvider,
  DirectoryUser,
  UserCreateFinish,
  UserCreateResult,
} from '../providers/types.js';
import type { AuditEventInput } from '../services/audit.js';
import { auditContextFromRequest, recordUserView, withAudit } from '../services/auditContext.js';
import { findCachedGroups, type CachedGroup } from '../services/groupCache.js';
import { findCachedOu } from '../services/ouCache.js';
import { directoryUpnSuffixes } from '../services/upnSuffixes.js';
import { findCachedUser, upsertUser } from '../services/userCache.js';
import { findUnfinishedCreate, finishRefusal } from '../services/userCreationProgress.js';
import { directoryRefusal } from './directoryRefusal.js';
import { ctx } from './writeContext.js';

const idParamSchema = z.object({ id: z.guid() });

// Long, because nobody types it: it only has to keep the account shut
// until the person sets their own in Entra.
const RANDOM_PASSWORD_LENGTH = 32;

const DOMAIN_USERS_RID = 513;

/** A group a create adds the account to, as the audit names it. */
type GroupToAdd = Pick<CachedGroup, 'id' | 'distinguishedName' | 'name'>;

export async function registerUserCreationRoutes(app: FastifyInstance): Promise<void> {
  // ---- POST /api/users (create in an OU) -------------------------------
  // One call runs AD's order: add the account disabled, set its password,
  // add it to its groups, enable it. A step failing after the add leaves
  // the account disabled; the response says what's left, and
  // finish-create runs it.
  app.post('/api/users', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'caller' } },
    handler: async (req): Promise<UserCreateResponse> => {
      const body = userCreateRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      if (body.groups?.length) await app.requireCapability(req, 'write:group.membership');
      const provider = await app.services.providers.buildForRequest(req);
      const directory = await app.services.directoryConfig.getById(provider.id);
      if (!directory) throw NotFound('directory not found');
      const ou = await findCachedOu(app.db, provider.id, body.ouDn);
      if (!ou) throw BadRequest('OU not found in directory cache');
      const { found: groups, missing } = await cachedGroups(provider.id, body.groups ?? []);
      if (missing[0]) throw BadRequest(`group ${missing[0]} not found in directory cache`);
      const managerId = body.organisation?.managerId;
      const manager = managerId
        ? await findCachedUser(app.db, provider.id, { id: managerId })
        : null;
      if (managerId && !manager) throw BadRequest('manager not found in directory cache');
      const source = body.copiedFrom
        ? await findCachedUser(app.db, provider.id, { id: body.copiedFrom })
        : null;
      if (body.copiedFrom && !source) {
        throw BadRequest('the user being copied isn’t in the directory cache');
      }
      const organisation = body.organisation?.attributes ?? {};

      // The names as the naming check would judge them typed, so a client
      // can't write what the create form wouldn't allow. Whether they're
      // free is checked again on the operator's bind.
      const suffixes = await directoryUpnSuffixes(provider, directory.domain);
      const [judged] = resolveNames(
        [
          {
            name: { first: body.givenName, last: body.surname },
            overrides: {
              samAccountName: body.samAccountName,
              userPrincipalName: body.userPrincipalName,
              displayName: body.displayName,
            },
          },
        ],
        directory.naming,
        NOTHING_TAKEN,
        suffixes,
      );
      const unusable = judged!.deviations.find((d) => d.approval === 'blocked');
      if (unusable) throw BadRequest(unusable.reason);
      const phones = phonesToWrite(
        body,
        body.keepPhonesAsTyped ?? [],
        directory.newUsers.phoneCountry,
      );
      if (phones.problems[0]) throw BadRequest(phones.problems[0].message);

      const dn = childDn('CN', body.cn, ou.distinguished_name);
      const mail = body.mailFromUpn ? body.userPrincipalName : null;
      const finish = await finishFor(provider, {
        password: body.password,
        groups,
        account: { samAccountName: body.samAccountName, displayName: body.displayName },
      });
      const planned = plannedSteps(body.enabled, groups.length > 0);
      const written = {
        distinguishedName: dn,
        mail,
        ...(Object.keys(organisation).length > 0 || manager
          ? {
              organisation: {
                ...organisation,
                ...(manager ? { manager: manager.distinguished_name } : {}),
              },
            }
          : {}),
      };
      const copiedFrom = source && {
        id: source.object_guid,
        distinguishedName: source.distinguished_name,
        samAccountName: source.sam_account_name,
      };

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.create',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetDn: dn,
          metadata: {
            ouDn: ou.distinguished_name,
            samAccountName: body.samAccountName,
            userPrincipalName: body.userPrincipalName,
            passwordMode: body.password.mode,
            mustChange: finish.mustChange,
            enabled: body.enabled,
            ...(copiedFrom ? { copiedFrom } : {}),
            ...(groups.length > 0 ? { groups } : {}),
          },
        },
        async () => {
          const r = await provider.createUser(
            {
              dn,
              cn: body.cn,
              samAccountName: body.samAccountName,
              userPrincipalName: body.userPrincipalName,
              givenName: body.givenName,
              surname: body.surname,
              displayName: body.displayName,
              mail,
              otherMailbox: body.personalEmail ?? null,
              mobile: phones.values.mobile,
              telephoneNumber: phones.values.telephoneNumber,
              organisation,
              manager: manager?.distinguished_name ?? null,
            },
            planned,
            finish,
            ctx(actor, req),
          );
          return auditOf(await readBack(provider, r, dn), planned, groups, [], written);
        },
      );
      if (!result.created.completed.includes('create')) {
        throw directoryRefusal(app, result, { verb: 'create', notFound: 'OU not found' });
      }
      await auditGroupAdds(req, provider.id, result, groups, dn);
      if (copiedFrom) {
        // The source's history shows the copy too.
        await recordAfterWrite(req, {
          action: 'user.copied',
          result: 'success',
          providerId: provider.id,
          targetType: 'user',
          targetId: copiedFrom.id,
          targetDn: copiedFrom.distinguishedName,
          metadata: {
            copyId: result.targetId,
            copyDn: dn,
            copySamAccountName: body.samAccountName,
          },
        });
      }
      return respond(provider, result, dn, body.samAccountName);
    },
  });

  // ---- POST /api/users/:id/finish-create -------------------------------
  // Only for an account a create made in the last day and left with steps
  // to go, still as the create left it (see finishRefusal), so it can't
  // stand in for a password reset. A group still to add that no longer
  // exists is left out rather than holding the account back.
  app.post('/api/users/:id/finish-create', {
    config: { policy: { capability: 'write:user.create', stepUp: true, directory: 'caller' } },
    handler: async (req): Promise<UserCreateResponse> => {
      const { id } = idParamSchema.parse(req.params);
      const body = userCreateFinishRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);
      const live = await app.services.userLiveRefresh.refresh(provider, id);
      if (!live) throw NotFound('user not found');

      const unfinished = await findUnfinishedCreate(app.db, provider.id, id);
      const account = await provider.getAccountFingerprint({ kind: 'objectGuid', value: id });
      const refusal = account
        ? finishRefusal(unfinished, { ...account, enabled: live.user.enabled }, new Date())
        : 'user not found';
      if (refusal) throw Conflict(refusal);
      const progress = unfinished!;

      const planned = [
        ...progress.completed,
        ...progress.remaining.filter((s) => s !== 'enable' || body.enabled),
      ];
      const steps = remainingSteps(planned, progress.completed);
      if (steps.includes('password') && !body.password) {
        throw BadRequest('The account has no password yet: say which one it gets.');
      }
      if (steps.includes('groups')) await app.requireCapability(req, 'write:group.membership');
      const { found: groups, missing: gone } = steps.includes('groups')
        ? await cachedGroups(provider.id, progress.groupsLeft)
        : { found: [], missing: [] };
      const finish = await finishFor(provider, {
        password: body.password,
        groups,
        account: live.user,
      });

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.create.finish',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: id,
          targetDn: live.user.distinguishedName,
          metadata: {
            createCorrelationId: progress.createCorrelationId,
            steps,
            ...(steps.includes('password')
              ? { passwordMode: body.password!.mode, mustChange: finish.mustChange }
              : {}),
            ...(groups.length > 0 ? { groups } : {}),
          },
        },
        async () => {
          const r = await provider.finishUserCreate(
            { kind: 'objectGuid', value: id },
            steps,
            finish,
            ctx(actor, req),
          );
          const done = { ...r, completed: [...progress.completed, ...r.completed] };
          return auditOf(
            await readBack(provider, done, live.user.distinguishedName),
            planned,
            groups,
            gone,
            { distinguishedName: live.user.distinguishedName },
          );
        },
      );
      if (!result.ok && result.created.failedStep === undefined) {
        throw directoryRefusal(app, result, { verb: 'finish', notFound: 'user not found' });
      }
      await auditGroupAdds(req, provider.id, result, groups, live.user.distinguishedName);
      return respond(provider, result, live.user.distinguishedName, live.user.samAccountName ?? '');
    },
  });

  // ---- GET /api/users/:id/copy ----------------------------------------
  // What a copy of the user starts from, for the create form: only what a
  // copy takes, so the person's own names, email, phones, IDs and
  // description stay out. It says which groups map to OpenADUC roles, so
  // it's for those who may create users.
  app.get('/api/users/:id/copy', {
    config: { policy: { capability: 'write:user.create', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<UserCopySource> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);
      const live = await app.services.userLiveRefresh.refresh(provider, id);
      if (!live) throw NotFound('user not found');
      const u = live.user;
      const raw = (k: string) => rawScalarValue(u.rawAttributes[k]);
      const parent = parentDn(u.distinguishedName);
      const ou = parent ? await findCachedOu(app.db, provider.id, parent) : null;
      const manager = u.managerDn
        ? await findCachedUser(app.db, provider.id, { dn: u.managerDn })
        : null;
      const countryCode = raw('countryCode');
      await recordUserView(app, req, provider.id, {
        id: u.objectGuid,
        distinguishedName: u.distinguishedName,
      });
      return {
        source: {
          id: u.objectGuid,
          distinguishedName: u.distinguishedName,
          samAccountName: u.samAccountName ?? '',
          displayName: u.displayName,
        },
        ouDn: ou?.distinguished_name ?? null,
        organisation: {
          title: u.title,
          department: u.department,
          company: raw('company'),
          physicalDeliveryOfficeName: u.office ?? null,
          streetAddress: raw('streetAddress'),
          l: raw('l'),
          st: raw('st'),
          postalCode: raw('postalCode'),
          c: raw('c'),
          co: raw('co'),
          // 0 is AD's "no country".
          countryCode: countryCode === '0' ? null : countryCode,
        },
        manager: manager
          ? {
              id: manager.object_guid,
              distinguishedName: manager.distinguished_name,
              displayName: manager.display_name ?? manager.sam_account_name,
            }
          : null,
        groups: await copiedGroups(provider.id, u),
      };
    },
  });

  /**
   * The groups `user` is directly in that a copy can be added to, each
   * with what membership grants. memberOf leaves out the primary group;
   * Domain Users is left out too, as every new account's primary group.
   */
  async function copiedGroups(providerId: number, user: DirectoryUser): Promise<CopiedGroup[]> {
    const [groups, roleGroups] = await Promise.all([
      findCachedGroups(app.db, providerId, { dns: user.memberOfDns }),
      app.services.authorization.roleGroups(),
    ]);
    const primaryRid = Number(rawScalarValue(user.rawAttributes['primaryGroupID']));
    const roleOf = new Map(roleGroups.map((g) => [g.dn.toLowerCase(), g.role]));
    return groups
      .filter((g) => {
        const rid = ridOf(g.sid);
        const ownDomain = !!g.sid?.startsWith('S-1-5-21-');
        return !(ownDomain && (rid === DOMAIN_USERS_RID || rid === primaryRid));
      })
      .map((g) => ({
        id: g.id,
        name: g.name,
        distinguishedName: g.distinguishedName,
        privilege: privilegeOf(g, roleOf.get(g.distinguishedName.toLowerCase())),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The groups asked for, in the order asked, and the ids the cache doesn't have. */
  async function cachedGroups(
    providerId: number,
    ids: readonly string[],
  ): Promise<{ found: GroupToAdd[]; missing: string[] }> {
    const byId = new Map(
      (await findCachedGroups(app.db, providerId, { ids })).map((g) => [g.id.toLowerCase(), g]),
    );
    const found: GroupToAdd[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const g = byId.get(id.toLowerCase());
      if (g) found.push({ id: g.id, distinguishedName: g.distinguishedName, name: g.name });
      else missing.push(id);
    }
    return { found, missing };
  }

  /**
   * An audit row written after the write it follows: the write stands, so
   * a row that can't be recorded is logged rather than failing the request.
   */
  async function recordAfterWrite(
    req: FastifyRequest,
    event: Omit<AuditEventInput, 'actorAuthMethod'>,
  ): Promise<void> {
    await app.services.audit
      .recordEvent({ ...auditContextFromRequest(req), actorAuthMethod: 'ad-password', ...event })
      .catch((err) => req.log.error({ err }, `audit insert failed for ${event.action}`));
  }

  /**
   * One `user.group.add` row per group the groups step tried, in the
   * create's or finish's correlation, so the account's and the group's
   * history both show them.
   */
  async function auditGroupAdds(
    req: FastifyRequest,
    providerId: number,
    result: AuditedCreate,
    groups: readonly GroupToAdd[],
    dn: string,
  ): Promise<void> {
    const tried = result.created.groups;
    if (!tried) return;
    const added = new Set(tried.added.map((g) => g.toLowerCase()));
    const failed = new Map(tried.failed.map((f) => [f.dn.toLowerCase(), f]));
    const account = result.created.user;
    for (const g of groups) {
      const key = g.distinguishedName.toLowerCase();
      const failure = failed.get(key);
      if (!failure && !added.has(key)) continue;
      await recordAfterWrite(req, {
        action: 'user.group.add',
        result: failure ? 'failure' : 'success',
        errorCode: failure?.reason ?? null,
        providerId,
        targetType: 'user',
        targetId: account?.objectGuid ?? result.targetId,
        targetDn: account?.distinguishedName ?? dn,
        metadata: {
          groupId: g.id,
          groupDn: g.distinguishedName,
          groupName: g.name,
          ...(failure ? { errorMessage: failure.errorMessage } : {}),
        },
      });
    }
  }

  /** The new account in the cache, so lists show it at once, and what's left. */
  async function respond(
    provider: DirectoryProvider,
    result: AuditedCreate,
    dn: string,
    samAccountName: string,
  ): Promise<UserCreateResponse> {
    const { user, completed, failedStep, errorMessage } = result.created;
    if (user) {
      await upsertUser(app.db, provider.id, user, { source: 'live-refresh' });
      if (result.created.groups) {
        await app.services.userLiveRefresh.reconcileDirectMemberships(
          provider.id,
          user.objectGuid,
          user.memberOfDns,
        );
      }
    }
    return {
      id: user?.objectGuid ?? null,
      distinguishedName: user?.distinguishedName ?? dn,
      samAccountName: user?.samAccountName ?? samAccountName,
      completed,
      remaining: result.remaining,
      ...(result.groupsSkipped.length > 0 ? { groupsSkipped: result.groupsSkipped } : {}),
      failure:
        failedStep !== undefined
          ? { step: failedStep, message: errorMessage ?? 'the directory refused it' }
          : null,
    };
  }
}

/**
 * Fill in what the operator's bind couldn't read back with the service
 * account, so the audit row names the account and records how it was
 * left. Without that, finishing it later is refused.
 */
async function readBack(
  provider: DirectoryProvider,
  r: UserCreateResult,
  dn: string,
): Promise<UserCreateResult> {
  if (!r.completed.includes('create') || (r.user && r.fingerprint)) return r;
  const id = { kind: 'distinguishedName', value: dn } as const;
  const user: DirectoryUser | null = r.user ?? (await provider.getUser(id).catch(() => null));
  const fingerprint = r.fingerprint ?? (await provider.getAccountFingerprint(id).catch(() => null));
  return { ...r, ...(user ? { user } : {}), ...(fingerprint ? { fingerprint } : {}) };
}

/**
 * What the steps after the add use. Random mode's password is made here
 * and never leaves the server; must-change is off in that mode (see
 * userCreatePasswordSchema).
 */
async function finishFor(
  provider: DirectoryProvider,
  options: {
    password: UserCreatePassword | undefined;
    groups: readonly GroupToAdd[];
    account: { samAccountName: string | null; displayName: string | null };
  },
): Promise<UserCreateFinish> {
  const groups = options.groups.map((g) => g.distinguishedName);
  const { password } = options;
  if (password && password.mode !== 'random') {
    return { password: password.password, mustChange: password.mustChange, groups };
  }
  const policy = await provider.getDomainPolicy().catch(() => null);
  return {
    password: generatePassword(policy, options.account, RANDOM_PASSWORD_LENGTH),
    mustChange: false,
    groups,
  };
}

/** What membership in a group grants: AD's protection first, as the bigger of the two. */
function privilegeOf(group: CachedGroup, role: Role | undefined): GroupPrivilege | null {
  if (isProtectedGroup(group)) return { reason: 'protected' };
  return role ? { reason: 'role', role } : null;
}

type AuditedCreate = ReturnType<typeof auditOf>;

/**
 * The audit row's view of a create: what it wrote, what's left (the
 * groups still to add included), the groups left out because they no
 * longer exist, and how the account was left.
 */
function auditOf(
  r: UserCreateResult,
  planned: UserCreateStep[],
  groups: readonly GroupToAdd[],
  gone: readonly string[],
  written: Record<string, unknown>,
) {
  const remaining = remainingSteps(planned, r.completed);
  const idOf = new Map(groups.map((g) => [g.distinguishedName.toLowerCase(), g.id]));
  const ids = (dns: readonly string[] | undefined) =>
    (dns ?? []).map((dn) => idOf.get(dn.toLowerCase())!);
  const settled = new Set([...ids(r.groups?.added), ...ids(r.groups?.missing)]);
  const groupsLeft = remaining.includes('groups')
    ? groups.filter((g) => !settled.has(g.id)).map((g) => g.id)
    : [];
  const groupsSkipped = [...gone, ...ids(r.groups?.missing)];
  return {
    ok: r.ok,
    errorCode: r.reason ?? null,
    errorMessage: r.errorMessage ?? null,
    targetId: r.user?.objectGuid ?? r.fingerprint?.objectGuid ?? null,
    after: r.completed.includes('create')
      ? {
          ...written,
          completed: r.completed,
          remaining,
          ...(groupsLeft.length > 0 ? { groupsLeft } : {}),
          ...(groupsSkipped.length > 0 ? { groupsSkipped } : {}),
          account: r.fingerprint ?? null,
        }
      : null,
    created: r,
    remaining,
    groupsSkipped,
  };
}
