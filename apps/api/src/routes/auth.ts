// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { meResponseSchema, stepUpRequestSchema, type Capability } from '@openaduc/shared';
import { loadEnv } from '../config/env.js';
import { BadRequest, Unauthorized } from '../plugins/errorHandler.js';
import { SESSION_COOKIE_NAME } from '../plugins/auth.js';
import { composeBindUpn } from '../lib/usernameParser.js';

// Capability subset that step-up should grant. Step-up is "you proved you
// can bind as yourself recently" — it doesn't elevate to capabilities you
// don't otherwise have. The bind password is cached in process memory
// (CredentialCacheService) keyed by elevated_session_id so subsequent
// write-as-user calls don't have to re-prompt.
const WRITE_CAPABILITIES: Capability[] = [
  'write:user.unlock',
  'write:user.resetPassword',
  'write:user.enableDisable',
  'write:user.attributes',
  'write:group.membership',
];

const loginRequestSchema = z.object({
  directoryId: z.coerce.number().int().positive(),
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1024),
});

function cookieOptions() {
  const env = loadEnv();
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ---- POST /api/auth/login --------------------------------------------
  app.post('/api/auth/login', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    handler: async (req, reply) => {
      const body = loginRequestSchema.parse(req.body);
      const directory = await app.services.directoryConfig.getById(body.directoryId);
      if (!directory || !directory.configured) {
        throw BadRequest('unknown directory');
      }
      // The dropdown is the source of truth for which domain to bind against.
      // Anything embedded in the username is stripped — if a user types
      // `jeff@otherdomain.com` while the dropdown is `corp.local`, we honor
      // the dropdown.
      const bindUsername = composeBindUpn(body.username, directory.domain);

      // Per-(IP, username) backoff. The global 5/min `rateLimit` config above
      // bounds the rate; this bounds the volume against any one identity from
      // any one source. Both apply.
      const backoffState = app.services.loginBackoff.check(req.ip ?? null, bindUsername);
      if (backoffState.locked) {
        const retryAfterSeconds = Math.max(1, Math.ceil(backoffState.retryAfterMs / 1000));
        reply.header('retry-after', retryAfterSeconds);
        throw app.httpErrors.tooManyRequests(
          `Too many failed sign-in attempts. Try again in ${formatRetry(retryAfterSeconds)}.`,
        );
      }

      const provider = await app.services.providers.buildWithCreds(directory.id, {
        username: bindUsername,
        password: body.password,
      });
      const result = await provider.authenticateUser({
        username: bindUsername,
        password: body.password,
      });

      const baseAudit = {
        sourceIp: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        correlationId: req.correlationId,
        providerId: directory.id,
        targetType: 'session' as const,
        actorAuthMethod: 'ad-password' as const,
      };

      if (!result.ok || !result.user) {
        // Don't count directory unreachable as a failure for backoff — it's
        // not a credential issue and we shouldn't punish a user when our
        // own infrastructure is down.
        if (result.reason !== 'directory_error') {
          app.services.loginBackoff.recordFailure(req.ip ?? null, bindUsername);
        }
        await app.services.audit
          .recordEvent({
            ...baseAudit,
            action: 'auth.login',
            result: 'failure',
            errorCode: result.reason ?? 'unknown',
            metadata: {
              username: bindUsername,
              directoryId: directory.id,
              detail: result.errorMessage,
            },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for auth.login failure'));
        if (result.reason === 'directory_error') {
          throw app.httpErrors.badGateway(result.errorMessage ?? 'directory unreachable');
        }
        if (result.reason === 'account_disabled' || result.reason === 'account_locked') {
          throw Unauthorized(result.errorMessage ?? 'account is not allowed to sign in');
        }
        throw Unauthorized(result.errorMessage ?? 'invalid username or password');
      }

      // Auth succeeded — clear any backoff state for this (ip, username).
      app.services.loginBackoff.recordSuccess(req.ip ?? null, bindUsername);

      const { user } = result;
      const groupDns = result.groupDns ?? user.memberOfDns;
      const capabilities = await app.services.authorization.resolveCapabilities(groupDns);

      if (capabilities.length === 0) {
        await app.services.audit
          .recordEvent({
            ...baseAudit,
            action: 'auth.login',
            result: 'denied',
            errorCode: 'no_capabilities',
            actorUserId: user.objectGuid,
            actorDisplayName: user.displayName,
            metadata: { username: bindUsername, directoryId: directory.id },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for auth.login deny'));
        throw Unauthorized('account is not authorized to use this application');
      }

      const { session, cookieToken } = await app.services.sessions.createAdminSession({
        directoryId: directory.id,
        actorUserId: user.objectGuid,
        actorDisplayName: user.displayName,
        actorUsername: bindUsername,
        actorEmail: user.email,
        actorDn: user.distinguishedName,
        capabilities,
        sourceIp: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });

      await app.services.audit
        .recordEvent({
          ...baseAudit,
          action: 'auth.login',
          result: 'success',
          actorUserId: user.objectGuid,
          actorDisplayName: user.displayName,
          sessionId: session.id,
          targetId: user.objectGuid,
          targetDn: user.distinguishedName,
          metadata: { capabilities, directoryId: directory.id },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for auth.login success'));

      reply.setCookie(SESSION_COOKIE_NAME, cookieToken, {
        ...cookieOptions(),
        expires: session.expiresAt,
      });
      return {
        actor: meResponse(session, null, directory.domain),
      };
    },
  });

  // ---- POST /api/auth/logout -------------------------------------------
  app.post('/api/auth/logout', async (req, reply) => {
    const actor = req.actor;
    if (actor) {
      const { revokedElevatedIds } = await app.services.sessions.revokeAdminSession(
        actor.session.id,
      );
      // Wipe step-up bind passwords held in process memory for any
      // elevated sessions this admin owned.
      app.services.credentialCache.deleteMany(revokedElevatedIds);
      await app.services.audit
        .recordEvent({
          action: 'auth.logout',
          result: 'success',
          actorUserId: actor.session.actorUserId,
          actorDisplayName: actor.session.actorDisplayName,
          actorAuthMethod: 'ad-password',
          sourceIp: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          sessionId: actor.session.id,
          correlationId: req.correlationId,
          providerId: actor.session.directoryId,
          targetType: 'session',
          targetId: actor.session.id,
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for auth.logout'));
    }
    reply.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
    return { ok: true };
  });

  // ---- GET /api/auth/me ------------------------------------------------
  app.get('/api/auth/me', { preHandler: app.requireAuth }, async (req) => {
    const directory = await app.services.directoryConfig.getById(req.actor!.session.directoryId);
    return {
      actor: meResponse(req.actor!.session, req.actor!.elevated, directory?.domain ?? null),
    };
  });

  // ---- POST /api/auth/step-up ------------------------------------------
  // Step-up rotates the admin session cookie. A fresh admin session is minted
  // and the old one (plus any prior elevated sessions and their cached bind
  // passwords) is revoked. This means a leaked pre-elevation cookie cannot
  // ride along after elevation — the only token that names the elevated
  // session has been replaced.
  app.post('/api/auth/step-up', {
    preHandler: app.requireAuth,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const body = stepUpRequestSchema.parse(req.body);
      const actor = req.actor!;
      const username = actor.session.actorUsername;
      if (!username) throw Unauthorized('session has no bind identity');

      // Backoff applies to step-up as well. Same brute-force concern: an
      // attacker who has a session cookie still needs to guess the password
      // to elevate, and we shouldn't let them probe indefinitely.
      const stepUpBackoff = app.services.loginBackoff.check(req.ip ?? null, username);
      if (stepUpBackoff.locked) {
        const retryAfterSeconds = Math.max(1, Math.ceil(stepUpBackoff.retryAfterMs / 1000));
        reply.header('retry-after', retryAfterSeconds);
        throw app.httpErrors.tooManyRequests(
          `Too many failed attempts. Try again in ${formatRetry(retryAfterSeconds)}.`,
        );
      }

      const provider = await app.services.providers.buildWithCreds(actor.session.directoryId, {
        username,
        password: body.password,
      });
      const result = await provider.authenticateUser({
        username,
        password: body.password,
      });

      const baseAudit = {
        sourceIp: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        sessionId: actor.session.id,
        correlationId: req.correlationId,
        actorUserId: actor.session.actorUserId,
        actorDisplayName: actor.session.actorDisplayName,
        actorAuthMethod: 'step-up' as const,
        providerId: actor.session.directoryId,
        targetType: 'session' as const,
      };

      if (!result.ok) {
        if (result.reason !== 'directory_error') {
          app.services.loginBackoff.recordFailure(req.ip ?? null, username);
        }
        await app.services.audit
          .recordEvent({
            ...baseAudit,
            action: 'auth.stepup',
            result: 'failure',
            errorCode: result.reason ?? 'unknown',
            metadata: { detail: result.errorMessage },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for auth.stepup failure'));
        // Surface the real reason — same pattern as login. "step-up failed"
        // alone is useless when the operator can't tell whether they
        // mistyped, the directory's down, or their account just got
        // disabled while they were sitting on the page.
        const detail = result.errorMessage ?? 'step-up failed';
        if (result.reason === 'directory_error') {
          throw app.httpErrors.badGateway(detail);
        }
        throw Unauthorized(detail);
      }

      // Step-up succeeded — clear backoff state.
      app.services.loginBackoff.recordSuccess(req.ip ?? null, username);

      const writes = actor.session.capabilities.filter((c): c is Capability =>
        WRITE_CAPABILITIES.includes(c as Capability),
      );

      const {
        admin: rotated,
        elevated,
        revokedElevatedIds,
      } = await app.services.sessions.rotateAndElevate({
        oldAdminSessionId: actor.session.id,
        seed: {
          directoryId: actor.session.directoryId,
          actorUserId: actor.session.actorUserId,
          actorDisplayName: actor.session.actorDisplayName,
          actorUsername: actor.session.actorUsername,
          actorEmail: actor.session.actorEmail,
          actorDn: actor.session.actorDn,
          capabilities: actor.session.capabilities,
          sourceIp: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
        elevatedCapabilities: writes,
      });

      // Old elevated sessions died with the old admin session — wipe their
      // cached passwords. Cache the bind password under the new id only.
      app.services.credentialCache.deleteMany(revokedElevatedIds);
      app.services.credentialCache.set(elevated.id, body.password, elevated.expiresAt);

      await app.services.audit
        .recordEvent({
          ...baseAudit,
          // Use the new session id in the audit context — the old one is
          // dead and any later "by-session" filter should track to here.
          sessionId: rotated.session.id,
          action: 'auth.stepup',
          result: 'success',
          targetId: elevated.id,
          metadata: {
            capabilities: writes,
            expiresAt: elevated.expiresAt.toISOString(),
            rotatedFromSessionId: actor.session.id,
          },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for auth.stepup success'));

      reply.setCookie(SESSION_COOKIE_NAME, rotated.cookieToken, {
        ...cookieOptions(),
        expires: rotated.session.expiresAt,
      });

      return { elevated: { active: true, expiresAt: elevated.expiresAt.toISOString() } };
    },
  });

  // ---- DELETE /api/auth/step-up ----------------------------------------
  app.delete('/api/auth/step-up', { preHandler: app.requireAuth }, async (req) => {
    const actor = req.actor!;
    const revokedIds = await app.services.sessions.revokeElevatedSessionsForAdmin(actor.session.id);
    app.services.credentialCache.deleteMany(revokedIds);
    if (revokedIds.length > 0) {
      await app.services.audit
        .recordEvent({
          action: 'auth.stepup.revoke',
          result: 'success',
          actorUserId: actor.session.actorUserId,
          actorDisplayName: actor.session.actorDisplayName,
          actorAuthMethod: 'ad-password',
          sourceIp: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          sessionId: actor.session.id,
          correlationId: req.correlationId,
          providerId: actor.session.directoryId,
          targetType: 'session',
          metadata: { revokedCount: revokedIds.length },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for auth.stepup.revoke'));
    }
    return { ok: true };
  });
}

// ---- Helpers ----------------------------------------------------------------

function meResponse(
  session: import('../services/sessions.js').AdminSession,
  elevated: import('../services/sessions.js').ElevatedSession | null,
  domainName: string | null,
) {
  const payload = {
    actorId: session.actorUserId,
    displayName: session.actorDisplayName ?? session.actorUsername ?? session.actorUserId,
    username: session.actorUsername ?? '',
    email: session.actorEmail,
    capabilities: session.capabilities,
    directoryId: session.directoryId,
    directoryDomain: domainName,
    elevated: {
      active: !!elevated,
      expiresAt: elevated ? elevated.expiresAt.toISOString() : null,
    },
  };
  return meResponseSchema.parse(payload);
}

function formatRetry(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
