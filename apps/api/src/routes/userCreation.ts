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
  type UserCreatePassword,
  type UserCreateResponse,
  type UserCreateStep,
} from '@openaduc/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../plugins/errorHandler.js';
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
      const provider = await app.services.providers.buildForRequest(req);
      const directory = await app.services.directoryConfig.getById(provider.id);
      if (!directory) throw NotFound('directory not found');
      const ou = await findCachedOu(app.db, provider.id, body.ouDn);
      if (!ou) throw BadRequest('OU not found in directory cache');

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
      const finish = await finishFor(provider, body.password, body.enabled, {
        samAccountName: body.samAccountName,
        displayName: body.displayName,
      });
      const planned = plannedSteps(body.enabled);

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
            },
            finish,
            ctx(actor, req),
          );
          return auditOf(await readBack(provider, r, dn), planned, { distinguishedName: dn, mail });
        },
      );
      if (!result.created.completed.includes('create')) {
        throw directoryRefusal(app, result, { verb: 'create', notFound: 'OU not found' });
      }
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
      const finish = await finishFor(provider, body.password, body.enabled, live.user);

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
          return auditOf(await readBack(provider, done, live.user.distinguishedName), planned, {
            distinguishedName: live.user.distinguishedName,
          });
        },
      );
      if (!result.ok && result.created.failedStep === undefined) {
        throw directoryRefusal(app, result, { verb: 'finish', notFound: 'user not found' });
      }
      return respond(provider, result, live.user.distinguishedName, live.user.samAccountName ?? '');
    },
  });

  /** The new account in the cache, so lists show it at once, and what's left. */
  async function respond(
    provider: DirectoryProvider,
    result: AuditedCreate,
    dn: string,
    samAccountName: string,
  ): Promise<UserCreateResponse> {
    const { user, completed, failedStep, errorMessage } = result.created;
    if (user) await upsertUser(app.db, provider.id, user, { source: 'live-refresh' });
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
  account: { samAccountName: string | null; displayName: string | null },
): Promise<UserCreateFinish> {
  if (password && password.mode !== 'random') {
    return { password: password.password, mustChange: password.mustChange, enable };
  }
  const policy = await provider.getDomainPolicy().catch(() => null);
  return {
    password: generatePassword(policy, account, RANDOM_PASSWORD_LENGTH),
    mustChange: false,
    enable,
  };
}

type AuditedCreate = ReturnType<typeof auditOf>;

/** The audit row's view of a create: what it wrote, what's left, and how the account was left. */
function auditOf(r: UserCreateResult, planned: UserCreateStep[], written: Record<string, unknown>) {
  const remaining = remainingSteps(planned, r.completed);
  return {
    ok: r.ok,
    errorCode: r.reason ?? null,
    errorMessage: r.errorMessage ?? null,
    targetId: r.user?.objectGuid ?? r.fingerprint?.objectGuid ?? null,
    after: r.completed.includes('create')
      ? { ...written, completed: r.completed, remaining, account: r.fingerprint ?? null }
      : null,
    created: r,
    remaining,
  };
}
