// SPDX-License-Identifier: BUSL-1.1
// Every route declares who may call it (see RoutePolicy in plugins/auth.ts).
// This builds the real app, without starting it, and checks each declared
// policy against the rules below.
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authPlugin, { type RoutePolicyEntry } from '../plugins/auth.js';

// Known gaps, keyed by route. Each breaks a rule today; #72 closes them and
// empties this list. Don't add to it to get a new route past the test.
const ALLOWLIST: Record<string, string> = {
  // Writes without step-up.
};

// Signed-in writes exempt from step-up by design: they open and close the
// elevated session itself.
const STEP_UP_EXEMPT = new Set(['POST /api/auth/step-up', 'DELETE /api/auth/step-up']);

// Signed-in routes that act on no single directory (`directory: 'none'`) by
// design. Every other signed-in route must be scoped to the caller's.
const INSTALLATION_WIDE = new Set([
  // App settings are one set per installation; every operator's UI reads them.
  'GET /api/settings',
  'PATCH /api/settings',
  // Directory administration: adding, configuring and syncing any directory.
  'GET /api/directories',
  'POST /api/directories',
  'PATCH /api/directories/:id',
  'POST /api/directories/:id/test-sync-bind',
  'GET /api/directories/:id/sync-tasks',
  'PATCH /api/directories/:id/sync-tasks/:key',
  'POST /api/directories/:id/sync-tasks/:key/run',
  'GET /api/directories/:id/sync-tasks/:key/history',
  'GET /api/directories/:id/sync-tasks/queue',
  'POST /api/directories/:id/sync-tasks/:key/reset',
  'POST /api/directories/:id/sync/reset',
  'POST /api/directories/:id/sync',
  // First-run setup acts on the first configured directory.
  'POST /api/setup/service-account',
  'POST /api/setup/policy',
  'POST /api/setup/run-initial-sync',
  'GET /api/setup/initial-sync-status',
  'POST /api/setup/retry-task',
]);

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const keyOf = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

function problems(route: RoutePolicyEntry): string[] {
  const { method, url, policy } = route;
  if (!policy) return ['declares no policy'];
  if ('public' in policy) return [];
  const found: string[] = [];
  if (STATE_CHANGING.has(method) && !policy.stepUp && !STEP_UP_EXEMPT.has(keyOf(route))) {
    found.push('changes state without step-up');
  }
  if (policy.directory === 'none' && !INSTALLATION_WIDE.has(keyOf(route))) {
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
    const keys = routes.map(keyOf);
    expect(keys).toContain('GET /health/live');
    expect(keys).toContain('GET /api/policies/groups/:id');
  });

  it('every route declares a policy that follows the rules', () => {
    const broken = routes
      .filter((r) => !(keyOf(r) in ALLOWLIST))
      .flatMap((r) => problems(r).map((p) => `${keyOf(r)} ${p}`));
    expect(broken).toEqual([]);
  });

  it('allowlists only routes that still break a rule', () => {
    const stale = Object.keys(ALLOWLIST).filter((key) => {
      const route = routes.find((r) => keyOf(r) === key);
      return !route || problems(route).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it('exempts only routes that exist', () => {
    const keys = new Set(routes.map(keyOf));
    const missing = [...STEP_UP_EXEMPT, ...INSTALLATION_WIDE].filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });
});

describe('the policy check', () => {
  let bare: FastifyInstance;

  beforeAll(async () => {
    bare = Fastify();
    await bare.register(cookie);
    await bare.register(authPlugin);
    bare.get('/undeclared', async () => 'ok');
    bare.post(
      '/signed-in-write',
      { config: { policy: { capability: null, stepUp: false, directory: 'caller' } } },
      async () => 'ok',
    );
    bare.get(
      '/signed-in-unscoped',
      { config: { policy: { capability: null, stepUp: false, directory: 'none' } } },
      async () => 'ok',
    );
    await bare.ready();
  });

  afterAll(async () => {
    await bare?.close();
  });

  it('reports routes that break a rule', () => {
    const report = bare.routePolicies
      .filter((r) => r.method !== 'HEAD')
      .map((r) => [keyOf(r), problems(r)]);
    expect(report).toEqual([
      ['GET /undeclared', ['declares no policy']],
      ['POST /signed-in-write', ['changes state without step-up']],
      ['GET /signed-in-unscoped', ["isn't scoped to the caller's directory"]],
    ]);
  });

  it('refuses an undeclared route at runtime', async () => {
    const res = await bare.inject({ method: 'GET', url: '/undeclared' });
    expect(res.statusCode).toBe(403);
  });
});
