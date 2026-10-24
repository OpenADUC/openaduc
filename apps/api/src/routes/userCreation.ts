// SPDX-License-Identifier: BUSL-1.1
import {
  NEW_USER_ORGANISATION_FIELDS,
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
  type NewUserOrganisationField,
  type Role,
  type UserCopySource,
  type UserCreatePassword,
  type UserCreateResponse,
  type UserCreateStep,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { isProtectedGroup } from '../lib/groupDeletion.js';
import { rawScalarValue } from '../lib/rawAttributes.js';
import { ridOf } from '../lib/sid.js';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../plugins/errorHandler.js';
import { leafRdnValue, parentDn } from '../providers/active-directory/normalize.js';
import type {
  DirectoryProvider,
  DirectoryUser,
  UserCreateFinish,
  UserCreateResult,
} from '../providers/types.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';
import { findCachedOu } from '../services/ouCache.js';
import { directoryUpnSuffixes } from '../services/upnSuffixes.js';
import { upsertUser } from '../services/userCache.js';
import { findUnfinishedCreate, finishRefusal } from '../services/userCreationProgress.js';
import { directoryRefusal } from './directoryRefusal.js';
import { ctx } from './writeContext.js';

const idParamSchema = z.object({ id: z.guid() });

// Long, because nobody types it: it only has to keep the account shut
// until the person sets their own in Entra.
const RANDOM_PASSWORD_LENGTH = 32;

const DOMAIN_USERS_RID = 513;

/** A group a create adds the account to, as the cache knows it. */
interface GroupToAdd {
  id: string;
  distinguishedName: string;
  name: string;
}

export async function registerUserCreationRoutes(app: FastifyInstance): Promise<void> {
  // ---- POST /api/users (create in an OU) -------------------------------
  // One call runs AD's order: add the account disabled, set its password,
  // enable it. A step failing after the add leaves the account disabled;
  // the response says what's left, and finish-create runs it.
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
      const groups = await groupsToAdd(provider.id, body.groups ?? []);
      const managerId = body.organisation?.managerId;
      const manager = managerId ? await cachedUser(provider.id, managerId) : null;
      if (managerId && !manager) throw BadRequest('manager not found in directory cache');
      const copiedFrom = body.copiedFrom ? await cachedUser(provider.id, body.copiedFrom) : null;
      if (body.copiedFrom && !copiedFrom) {
        throw BadRequest('the user being copied isn’t in the directory cache');
      }
      const organisation: Partial<Record<NewUserOrganisationField, string>> = {};
      for (const field of NEW_USER_ORGANISATION_FIELDS) {
        const value = body.organisation?.[field];
        if (value) organisation[field] = value;
      }

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
      const finish = await finishFor(provider, body.password, body.enabled, groups, {
        samAccountName: body.samAccountName,
        displayName: body.displayName,
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
            ...(copiedFrom
              ? {
                  copiedFrom: {
                    id: copiedFrom.object_guid,
                    distinguishedName: copiedFrom.distinguished_name,
                    samAccountName: copiedFrom.sam_account_name,
                  },
                }
              : {}),
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
            finish,
            ctx(actor, req),
          );
          return auditOf(await readBack(provider, r, dn), planned, groups, written);
        },
      );
      if (!result.created.completed.includes('create')) {
        throw directoryRefusal(app, result, { verb: 'create', notFound: 'OU not found' });
      }
      await auditGroupAdds(req, provider.id, result, groups, dn);
      return respond(provider, result, dn, body.samAccountName);
    },
  });

  // ---- POST /api/users/:id/finish-create -------------------------------
  // Only for an account a create made in the last day and left with steps
  // to go, still as the create left it (see finishRefusal), so it can't
  // stand in for a password reset.
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
      const groups = steps.includes('groups')
        ? await groupsToAdd(provider.id, progress.groupsLeft)
        : [];
      const finish = await finishFor(provider, body.password, body.enabled, groups, live.user);

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
  // What a copy of the user starts from. Only what a copy takes: the
  // person's own names, email, phones, IDs and description stay out.
  app.get('/api/users/:id/copy', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<UserCopySource> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);
      const live = await app.services.userLiveRefresh.refresh(provider, id);
      if (!live) throw NotFound('user not found');
      const u = live.user;
      const raw = (k: string) => rawScalarValue(u.rawAttributes[k]);
      const parent = parentDn(u.distinguishedName);
      const ou = parent ? await findCachedOu(app.db, provider.id, parent) : null;
      const manager = u.managerDn ? await cachedUserByDn(provider.id, u.managerDn) : null;
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
    const dns = user.memberOfDns.map((dn) => dn.toLowerCase());
    if (dns.length === 0) return [];
    const [rows, roleGroups] = await Promise.all([
      app.db
        .selectFrom('group_cache_records')
        .select(['object_guid', 'name', 'distinguished_name', 'sid', 'raw_attributes_json'])
        .where('provider_id', '=', providerId)
        .where('deleted_at', 'is', null)
        .where(sql<string>`lower(distinguished_name)`, 'in', dns)
        .execute(),
      app.services.authorization.roleGroups(),
    ]);
    const primaryRid = Number(rawScalarValue(user.rawAttributes['primaryGroupID']));
    const roleOf = new Map(roleGroups.map((g) => [g.dn.toLowerCase(), g.role]));
    return rows
      .filter((g) => {
        const rid = ridOf(g.sid);
        const ownDomain = !!g.sid?.startsWith('S-1-5-21-');
        return !(ownDomain && (rid === DOMAIN_USERS_RID || rid === primaryRid));
      })
      .map((g) => ({
        id: g.object_guid,
        name: g.name ?? leafRdnValue(g.distinguished_name) ?? g.distinguished_name,
        distinguishedName: g.distinguished_name,
        privilege: privilegeOf(
          {
            distinguishedName: g.distinguished_name,
            sid: g.sid,
            rawAttributes: g.raw_attributes_json,
          },
          roleOf.get(g.distinguished_name.toLowerCase()),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The groups a create adds the account to, in the order asked; one the cache lacks is refused. */
  async function groupsToAdd(providerId: number, ids: readonly string[]): Promise<GroupToAdd[]> {
    if (ids.length === 0) return [];
    const rows = await app.db
      .selectFrom('group_cache_records')
      .select(['object_guid', 'name', 'distinguished_name'])
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .where('object_guid', 'in', [...ids])
      .execute();
    const byId = new Map(rows.map((r) => [r.object_guid.toLowerCase(), r]));
    return ids.map((id) => {
      const row = byId.get(id.toLowerCase());
      if (!row) throw BadRequest(`group ${id} not found in directory cache`);
      return {
        id: row.object_guid,
        distinguishedName: row.distinguished_name,
        name: row.name ?? leafRdnValue(row.distinguished_name) ?? row.distinguished_name,
      };
    });
  }

  const cachedUserColumns = [
    'object_guid',
    'distinguished_name',
    'sam_account_name',
    'display_name',
  ] as const;
  function cachedUser(providerId: number, id: string) {
    return app.db
      .selectFrom('user_cache_records')
      .select(cachedUserColumns)
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .where('object_guid', '=', id)
      .executeTakeFirst();
  }
  function cachedUserByDn(providerId: number, dn: string) {
    return app.db
      .selectFrom('user_cache_records')
      .select(cachedUserColumns)
      .where('provider_id', '=', providerId)
      .where('deleted_at', 'is', null)
      .where(sql<string>`lower(distinguished_name)`, '=', dn.toLowerCase())
      .executeTakeFirst();
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
      await app.services.audit.recordEvent({
        ...auditContextFromRequest(req),
        action: 'user.group.add',
        result: failure ? 'failure' : 'success',
        errorCode: failure?.reason ?? null,
        actorAuthMethod: 'ad-password',
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
 * The password and must-change the steps after the add use. Random mode's
 * password is made here and never leaves the server; must-change is off
 * in that mode (see userCreatePasswordSchema).
 */
async function finishFor(
  provider: DirectoryProvider,
  password: UserCreatePassword | undefined,
  enable: boolean,
  groups: readonly GroupToAdd[],
  account: { samAccountName: string | null; displayName: string | null },
): Promise<UserCreateFinish> {
  const groupDns = groups.map((g) => g.distinguishedName);
  if (password && password.mode !== 'random') {
    return {
      password: password.password,
      mustChange: password.mustChange,
      groups: groupDns,
      enable,
    };
  }
  const policy = await provider.getDomainPolicy().catch(() => null);
  return {
    password: generatePassword(policy, account, RANDOM_PASSWORD_LENGTH),
    mustChange: false,
    groups: groupDns,
    enable,
  };
}

/** What membership in a group grants: AD's protection first, as the bigger of the two. */
function privilegeOf(
  group: Parameters<typeof isProtectedGroup>[0],
  role: Role | undefined,
): GroupPrivilege | null {
  if (isProtectedGroup(group)) return { reason: 'protected' };
  return role ? { reason: 'role', role } : null;
}

type AuditedCreate = ReturnType<typeof auditOf>;

/**
 * The audit row's view of a create: what it wrote, what's left (the
 * groups still to add included), and how the account was left.
 */
function auditOf(
  r: UserCreateResult,
  planned: UserCreateStep[],
  groups: readonly GroupToAdd[],
  written: Record<string, unknown>,
) {
  const remaining = remainingSteps(planned, r.completed);
  const added = new Set((r.groups?.added ?? []).map((dn) => dn.toLowerCase()));
  const groupsLeft = remaining.includes('groups')
    ? groups.filter((g) => !added.has(g.distinguishedName.toLowerCase())).map((g) => g.id)
    : [];
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
          account: r.fingerprint ?? null,
        }
      : null,
    created: r,
    remaining,
  };
}
