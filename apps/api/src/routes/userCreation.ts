// SPDX-License-Identifier: BUSL-1.1
import {
  USER_CREATE_STEPS,
  childDn,
  generatePassword,
  resolveNames,
  userCreateFinishRequestSchema,
  userCreateRequestSchema,
  type UserCreatePassword,
  type UserCreateResponse,
  type UserCreateStep,
} from '@openaduc/shared';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { BadRequest, Conflict, NotFound, Unauthorized } from '../plugins/errorHandler.js';
import type { DirectoryProvider, UserCreateFinish, UserCreateResult } from '../providers/types.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';
import { findCachedOu } from '../services/ouCache.js';
import { upsertUser } from '../services/userCache.js';
import { directoryRefusal } from './directoryRefusal.js';
import { ctx } from './writeContext.js';

const idParamSchema = z.object({ id: z.guid() });

// Long, because nobody types it: it only has to keep the account shut
// until the person sets their own in Entra.
const RANDOM_PASSWORD_LENGTH = 32;

const NOTHING_TAKEN = { samAccountNames: [], userPrincipalNames: [], mailAddresses: [], cns: [] };

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
      const suffixes = [directory.domain, ...(await provider.getUpnSuffixes())];
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
              mobile: body.mobile,
              telephoneNumber: body.telephoneNumber,
            },
            finish,
            ctx(actor, req),
          );
          return auditOf(r, planned, { distinguishedName: dn, mail });
        },
      );
      if (!result.created.completed.includes('create')) {
        throw directoryRefusal(app, result, { verb: 'create', notFound: 'OU not found' });
      }
      return respond(provider, result.created, planned, dn, body.samAccountName);
    },
  });

  // ---- POST /api/users/:id/finish-create -------------------------------
  // Only for an account a create made and left disabled with steps to go,
  // so it can't stand in for a password reset.
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

      const last = await app.db
        .selectFrom('audit_events')
        .select('after_json')
        .where('provider_id', '=', provider.id)
        .where('target_id', '=', id)
        .where('action', 'in', ['user.create', 'user.create.finish'])
        .where(sql<boolean>`after_json ? 'remaining'`)
        .orderBy('id', 'desc')
        .executeTakeFirst();
      const progress = progressOf(last?.after_json);
      if (!progress || progress.remaining.length === 0) {
        throw Conflict('OpenADUC has no unfinished create of this account.');
      }
      if (live.user.enabled) {
        throw Conflict(
          'This account has been enabled since it was created. Reset its password instead.',
        );
      }

      const planned = [
        ...progress.completed,
        ...progress.remaining.filter((s) => s !== 'enable' || body.enabled),
      ];
      const steps = planned.filter((s) => !progress.completed.includes(s));
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
          metadata: steps.includes('password')
            ? { steps, passwordMode: body.password!.mode, mustChange: finish.mustChange }
            : { steps },
        },
        async () => {
          const r = await provider.finishUserCreate(
            { kind: 'objectGuid', value: id },
            steps,
            finish,
            ctx(actor, req),
          );
          return auditOf({ ...r, completed: [...progress.completed, ...r.completed] }, planned, {
            distinguishedName: live.user.distinguishedName,
          });
        },
      );
      if (!result.ok && result.created.failedStep === undefined) {
        throw directoryRefusal(app, result, { verb: 'finish', notFound: 'user not found' });
      }
      return respond(
        provider,
        result.created,
        planned,
        live.user.distinguishedName,
        live.user.samAccountName ?? '',
      );
    },
  });

  /** The new account in the cache, so lists show it at once, and what's left. */
  async function respond(
    provider: DirectoryProvider,
    r: UserCreateResult,
    planned: UserCreateStep[],
    dn: string,
    samAccountName: string,
  ): Promise<UserCreateResponse> {
    // If the operator's bind couldn't read it back, try the service
    // account; failing that, the next sync lists it.
    const user =
      r.user ??
      (await provider.getUser({ kind: 'distinguishedName', value: dn }).catch(() => null));
    if (user) await upsertUser(app.db, provider.id, user, { source: 'live-refresh' });
    return {
      id: user?.objectGuid ?? null,
      distinguishedName: user?.distinguishedName ?? dn,
      samAccountName: user?.samAccountName ?? samAccountName,
      completed: r.completed,
      remaining: planned.filter((s) => !r.completed.includes(s)),
      failure:
        r.failedStep !== undefined
          ? { step: r.failedStep, message: r.errorMessage ?? 'the directory refused it' }
          : null,
    };
  }
}

function plannedSteps(enabled: boolean): UserCreateStep[] {
  return USER_CREATE_STEPS.filter((s) => s !== 'enable' || enabled);
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

/** The audit row's view of a create: what it wrote and what's left. */
function auditOf(r: UserCreateResult, planned: UserCreateStep[], written: Record<string, unknown>) {
  const remaining = planned.filter((s) => !r.completed.includes(s));
  return {
    ok: r.ok,
    errorCode: r.reason ?? null,
    errorMessage: r.errorMessage ?? null,
    targetId: r.user?.objectGuid ?? null,
    after: r.completed.includes('create')
      ? { ...written, completed: r.completed, remaining }
      : null,
    created: r,
  };
}

function progressOf(
  after: Record<string, unknown> | null | undefined,
): { completed: UserCreateStep[]; remaining: UserCreateStep[] } | null {
  const steps = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((s): s is UserCreateStep => (USER_CREATE_STEPS as readonly unknown[]).includes(s))
      : null;
  const completed = steps(after?.completed);
  const remaining = steps(after?.remaining);
  return completed && remaining ? { completed, remaining } : null;
}
