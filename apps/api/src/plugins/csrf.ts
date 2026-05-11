// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import { Forbidden } from './errorHandler.js';
import { loadEnv } from '../config/env.js';

// Routes excluded from CSRF origin enforcement. These either don't have a
// session yet (login, setup) or are pure idempotent reads. Login/setup are
// still rate-limited and bind-protected — an attacker cross-site posting a
// guess at /api/auth/login can't escalate beyond what they could do without
// the browser session anyway.
const SAFE_PATHS = new Set<string>(['/api/health', '/api/auth/login']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.host;
  } catch {
    return null;
  }
}

function allowedHosts(): Set<string> {
  const env = loadEnv();
  const hosts = new Set<string>();
  for (const origin of env.API_CORS_ORIGIN) {
    const host = originHost(origin);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * Reject state-changing cookie-authenticated requests whose Origin (or
 * Referer, as a fallback) doesn't match an allowed CORS origin. SameSite=Lax
 * already blocks the simplest CSRF vectors but is not sufficient on its own
 * (top-level navigations, browser quirks). This is the belt to that
 * suspenders.
 */
export default fp(async (app) => {
  const hosts = allowedHosts();

  app.addHook('preHandler', async (req) => {
    const method = req.method.toUpperCase();
    if (SAFE_METHODS.has(method)) return;

    // Setup routes are public until the first directory is configured. They
    // run with no admin session, so cross-site CSRF is moot — there's no
    // identity to forge against. Skip them.
    const path = req.routeOptions?.url ?? req.url.split('?')[0];
    if (path && (path.startsWith('/api/setup') || SAFE_PATHS.has(path))) return;

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    const candidate =
      originHost(typeof origin === 'string' ? origin : undefined) ??
      originHost(typeof referer === 'string' ? referer : undefined);

    if (!candidate || !hosts.has(candidate)) {
      req.log.warn({ origin, referer, allowed: [...hosts] }, 'csrf: rejecting cross-origin write');
      throw Forbidden('cross-origin request rejected');
    }
  });
});
