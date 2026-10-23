// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import {
  BACKGROUND_REQUEST_HEADER,
  ELEVATED_IDLE_END_HEADER,
  type Capability,
} from '@openaduc/shared';
import type { AdminSession, ElevatedSession } from '../services/sessions.js';
import { Forbidden, NotFound, SessionRequired, StepUpRequired } from './errorHandler.js';

export const SESSION_COOKIE_NAME = 'openaduc_sid';

/**
 * Who may call a route. `public` routes run without a session; the others
 * need one, plus `capability` when set (null: any signed-in operator) and a
 * live step-up when `stepUp` is true.
 *
 * `directory` says which directory the route acts on: `caller` (the
 * session's, via req.directoryId), `param` (the `:id` in the URL, which must
 * be the session's) or `none` (not one directory's data, e.g.
 * installation-wide configuration). Only `param` is enforced at runtime
 * (other ids get 404); `caller` and `none` are declarations that
 * routes/routePolicy.test.ts reasons about, and the handler must honour.
 */
export type RoutePolicy =
  | { public: true }
  | {
      capability: Capability | null;
      stepUp: boolean;
      directory: 'caller' | 'param' | 'none';
    };

export interface RoutePolicyEntry {
  method: string;
  url: string;
  policy: RoutePolicy | undefined;
}

export interface ResolvedActor {
  session: AdminSession;
  elevated: ElevatedSession | null;
  /**
   * Step-up bind password pulled from the in-memory CredentialCacheService.
   * Populated whenever an elevated session is active and the cache still has
   * the password for it. Writes use this to bind to AD as the operator
   * without re-prompting per request. Null when not elevated or when the
   * cache entry has been wiped (session ended, step-down, logout, restart).
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
     * Null only on public routes (login, setup, health). Throwing-on-null
     * at use-sites is intentional: the type system reminds you to give the
     * route a signed-in policy before reading this.
     */
    directoryId: number | null;
  }
  interface FastifyInstance {
    /** Every route registered after the auth plugin, with its declared policy. */
    routePolicies: readonly RoutePolicyEntry[];
  }
  interface FastifyContextConfig {
    policy?: RoutePolicy;
  }
}

export default fp(async (app) => {
  // ---- Resolve session on every request (no enforcement here) ------------
  // A request from an elevated operator is activity, unless it's marked as
  // background: it keeps the elevated session from ending idle.
  app.addHook('onRequest', async (req, reply) => {
    req.actor = null;
    req.directoryId = null;
    const cookieToken = req.cookies[SESSION_COOKIE_NAME];
    if (!cookieToken) return;
    try {
      const session = await app.services.sessions.resolve(cookieToken);
      if (!session) return;
      let elevated = await app.services.sessions.findActiveElevated(session.id);
      if (elevated && req.headers[BACKGROUND_REQUEST_HEADER] !== '1') {
        const before = elevated;
        // Failing to record activity shouldn't fail the request.
        elevated = await app.services.sessions.recordElevatedActivity(before).catch((err) => {
          req.log.warn({ err }, 'recording elevated-session activity failed');
          return before;
        });
        if (elevated) app.services.credentialCache.extend(elevated.id, elevated.idleExpiresAt);
      }
      if (elevated) reply.header(ELEVATED_IDLE_END_HEADER, elevated.idleExpiresAt.toISOString());
      const elevatedPassword = elevated ? app.services.credentialCache.get(elevated.id) : null;
      req.actor = { session, elevated, elevatedPassword };
      req.directoryId = session.directoryId;
    } catch (err) {
      req.log.warn({ err }, 'session resolve failed');
    }
  });

  // ---- Route policy ------------------------------------------------------
  // Every route declares a policy in its config; this hook puts one guard in
  // front of each route registered after this plugin. As the route's first
  // preHandler it runs after the global hooks (CSRF).
  const routePolicies: RoutePolicyEntry[] = [];
  app.decorate('routePolicies', routePolicies);

  app.addHook('onRoute', (route) => {
    const policy = route.config?.policy;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routePolicies.push({ method, url: route.url, policy });
    if (policy && 'public' in policy) return;
    const guard = policy ? policyGuard(policy) : undeclaredGuard;
    const own = route.preHandler ?? [];
    route.preHandler = [guard, ...(Array.isArray(own) ? own : [own])];
  });

  function policyGuard(policy: Exclude<RoutePolicy, { public: true }>) {
    return async (req: FastifyRequest): Promise<void> => {
      if (!req.actor) throw SessionRequired();
      if (policy.capability) await requireCapability(req, req.actor, policy.capability);
      if (policy.stepUp) requireStepUp(req.actor);
      if (policy.directory === 'param') requireCallersDirectory(req);
    };
  }

  async function undeclaredGuard(req: FastifyRequest): Promise<void> {
    req.log.error({ route: req.routeOptions.url }, 'route has no access policy');
    throw Forbidden('route has no access policy');
  }

  async function requireCapability(
    req: FastifyRequest,
    actor: ResolvedActor,
    capability: Capability,
  ): Promise<void> {
    if (app.services.authorization.has(actor.session.capabilities, capability)) return;
    // Audit the denial — Phase 5 wires this through the request middleware,
    // but for now record directly so denials never silently disappear.
    await app.services.audit
      .recordEvent({
        action: 'authz.deny',
        result: 'denied',
        actorUserId: actor.session.actorUserId,
        actorDisplayName: actor.session.actorDisplayName,
        actorAuthMethod: 'ad-password',
        sourceIp: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        sessionId: actor.session.id,
        correlationId: req.correlationId,
        providerId: actor.session.directoryId,
        targetType: 'system',
        metadata: { requiredCapability: capability, route: req.routeOptions.url ?? req.url },
      })
      .catch((err) => req.log.error({ err }, 'audit insert failed for authz.deny'));
    throw Forbidden('missing required capability');
  }

  function requireStepUp(actor: ResolvedActor): void {
    if (!actor.elevated) throw StepUpRequired();
    // The DB row says elevated, but our process restarted (or another
    // instance handled the step-up) and we don't have the bind password
    // cached. Treat it as "step-up required" so the client re-elevates.
    if (!actor.elevatedPassword) throw StepUpRequired();
  }

  // Coerces like the routes' idParamSchema; an id that isn't a positive
  // integer is left for the handler's own validation (400).
  function requireCallersDirectory(req: FastifyRequest): void {
    const id = Number((req.params as Record<string, unknown>).id);
    if (!Number.isInteger(id) || id <= 0) return;
    if (id !== req.directoryId) throw NotFound('directory not found');
  }
});
