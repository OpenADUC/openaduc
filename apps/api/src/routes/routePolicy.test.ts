// SPDX-License-Identifier: BUSL-1.1
// Every route declares who may call it (see RoutePolicy in plugins/auth.ts).
// This builds the real app, without starting it, and checks each declared
// policy against the rules below.
import type { FastifyInstance } from 'fastify';
import type { Capability } from '@openaduc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoutePolicyEntry } from '../plugins/auth.js';

// Known gaps, keyed by route. Each breaks a rule today; #72 closes them and
// empties this list. Don't add to it to get a new route past the test.
const ALLOWLIST: Record<string, string> = {
  // Cross-directory reads: an operator signed into one directory can read
  // another's Entra data by changing the id in the URL.
  'GET /api/directories/:id/entra': "reads any directory's Entra config, not just the caller's",
  'GET /api/directories/:id/signin-events': "reads any directory's sign-in events (IPs, apps)",
  'GET /api/directories/:id/signin-events/apps': "reads any directory's sign-in app list",
  'GET /api/directories/:id/signin-events/:eventId': "reads any directory's sign-in event",
  'GET /api/directories/:id/mfa-registration': "reads any directory's MFA registration state",
  'GET /api/directories/:id/mfa-registration/methods': "reads any directory's MFA method counts",
  'GET /api/directories/:id/users/:userId/photo': "reads any directory's user photos",
  'GET /api/audit-events': "returns every directory's audit rows; no directory filter",

  // Writes without step-up.
  'PATCH /api/settings':
    'can turn off view/search auditing, change retention and lengthen sessions',
  'POST /api/directories/:id/entra/test':
    'sends the stored client secret to Entra and records the result',
  'POST /api/directories/:id/sync': 'starts a full user sync',
  'POST /api/directories/:id/sync/reset': "resets every stuck sync task's state",
  'POST /api/directories/:id/sync-tasks/:key/run': 'starts a sync task',
  'POST /api/directories/:id/sync-tasks/:key/reset': "resets a sync task's state",
  // Setup wizard steps. Setup/initialize opens an elevated session, so
  // requiring step-up here shouldn't prompt the admin again.
  'POST /api/setup/service-account': 'stores the sync service account credentials',
  'POST /api/setup/policy': 'writes view settings',
  'POST /api/setup/run-initial-sync': 'starts the initial sync',
  'POST /api/setup/retry-task': 're-runs a failed initial sync task',
};

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Installation-wide administration: these routes may act on any directory
// (or none), so they needn't be scoped to the caller's.
const INSTALLATION_CAPABILITIES = new Set<Capability>([
  'configure:directory',
  'configure:security',
]);

function problems({ method, url, policy }: RoutePolicyEntry): string[] {
  if (!policy) return ['declares no policy'];
  if ('public' in policy) return [];
  const found: string[] = [];
  if (STATE_CHANGING.has(method) && policy.capability && !policy.stepUp) {
    found.push('changes state without step-up');
  }
  if (
    policy.capability &&
    policy.directory === 'none' &&
    !INSTALLATION_CAPABILITIES.has(policy.capability)
  ) {
    found.push("isn't scoped to the caller's directory");
  }
  if (policy.directory === 'param' && !url.includes('/:id')) {
    found.push('is scoped by :id but has no :id in its path');
  }
  return found;
}

let app: FastifyInstance;
let routes: RoutePolicyEntry[];

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    SESSION_COOKIE_SECRET: 'route-policy-test-cookie-secret-0123456789',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SYNC_SCHEDULER_ENABLED: '0',
  });
  const { buildApp } = await import('../app.js');
  app = await buildApp();
  // Fastify adds a HEAD route for each GET, carrying the GET's policy.
  routes = app.routePolicies.filter((r) => r.method !== 'HEAD');
});

afterAll(async () => {
  await app?.close();
});

describe('route policies', () => {
  it('sees routes from the first and last registered route files', () => {
    const keys = routes.map((r) => `${r.method} ${r.url}`);
    expect(keys).toContain('GET /health/live');
    expect(keys).toContain('GET /api/policies/groups/:id');
  });

  it('every route declares a policy that follows the rules', () => {
    const broken = routes
      .filter((r) => !(`${r.method} ${r.url}` in ALLOWLIST))
      .flatMap((r) => problems(r).map((p) => `${r.method} ${r.url} ${p}`));
    expect(broken).toEqual([]);
  });

  it('allowlists only routes that still break a rule', () => {
    const stale = Object.keys(ALLOWLIST).filter((key) => {
      const route = routes.find((r) => `${r.method} ${r.url}` === key);
      return !route || problems(route).length === 0;
    });
    expect(stale).toEqual([]);
  });
});
