// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Capability } from '@openaduc/shared';
import type { AdminSession, ElevatedSession } from '../services/sessions.js';
import { Forbidden, StepUpRequired, Unauthorized } from './errorHandler.js';

export const SESSION_COOKIE_NAME = 'openaduc_sid';

export interface ResolvedActor {
  session: AdminSession;
  elevated: ElevatedSession | null;
  /**
   * Step-up bind password pulled from the in-memory CredentialCacheService.
   * Populated whenever an elevated session is active and the cache still has
   * the password for it. Writes use this to bind to AD as the operator
   * without re-prompting per request. Null when not elevated or when the
   * cache entry has been wiped (TTL expiry, step-down, logout).
   */
  elevatedPassword: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: ResolvedActor | null;
    /**
     * Directory the current session is scoped to. Routes that touch domain-
     * scoped data (users, groups, OUs, audit, settings) MUST pass this to
     * service-layer calls instead of accepting a directoryId from the body
     * or query — that's the multi-domain isolation guarantee.
     *
     * Null only on routes that don't use `requireAuth` (login, setup,
     * health). Throwing-on-null at use-sites is intentional: the type
     * system reminds you to put the route behind requireAuth before
     * reading this.
     */
    directoryId: number | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCapability: (
      capability: Capability,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireStepUp: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  // ---- Resolve session on every request (no enforcement here) ------------
  app.addHook('onRequest', async (req) => {
    req.actor = null;
    req.directoryId = null;
    const cookieToken = req.cookies[SESSION_COOKIE_NAME];
    if (!cookieToken) return;
    try {
      const session = await app.services.sessions.resolve(cookieToken);
      if (!session) return;
      const elevated = await app.services.sessions.findActiveElevated(session.id);
      const elevatedPassword = elevated ? app.services.credentialCache.get(elevated.id) : null;
      req.actor = { session, elevated, elevatedPassword };
      req.directoryId = session.directoryId;
    } catch (err) {
      req.log.warn({ err }, 'session resolve failed');
    }
  });

  // ---- Route guards ------------------------------------------------------

  app.decorate('requireAuth', async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.actor) throw Unauthorized('authentication required');
  });

  app.decorate(
    'requireCapability',
    (capability: Capability) =>
      async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        if (!req.actor) throw Unauthorized('authentication required');
        if (!app.services.authorization.has(req.actor.session.capabilities, capability)) {
          // Audit the denial — Phase 5 wires this through the request middleware,
          // but for now record directly so denials never silently disappear.
          await app.services.audit
            .recordEvent({
              action: 'authz.deny',
              result: 'denied',
              actorUserId: req.actor.session.actorUserId,
              actorDisplayName: req.actor.session.actorDisplayName,
              actorAuthMethod: 'ad-password',
              sourceIp: req.ip,
              userAgent: req.headers['user-agent'] ?? null,
              sessionId: req.actor.session.id,
              correlationId: req.correlationId,
              targetType: 'system',
              metadata: { requiredCapability: capability, route: req.routeOptions.url ?? req.url },
            })
            .catch((err) => req.log.error({ err }, 'audit insert failed for authz.deny'));
          throw Forbidden('missing required capability');
        }
      },
  );

  app.decorate('requireStepUp', async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.actor) throw Unauthorized('authentication required');
    if (!req.actor.elevated) throw StepUpRequired();
    // The DB row says elevated, but our process restarted (or another
    // instance handled the step-up) and we don't have the bind password
    // cached. Treat it as "step-up required" so the client re-elevates.
    if (!req.actor.elevatedPassword) {
      throw StepUpRequired();
    }
  });
});
