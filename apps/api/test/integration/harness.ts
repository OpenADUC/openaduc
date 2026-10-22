// SPDX-License-Identifier: BUSL-1.1
// Integration-test harness: a real API instance (in-process, driven with
// Fastify's inject) on its own freshly-migrated database, configured against
// the dev Samba DC the way the setup wizard does it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, HTTPMethods, InjectOptions, LightMyRequestResponse } from 'fastify';
import { Client as LdapClient } from 'ldapts';
import pg from 'pg';
import { inject } from 'vitest';
import { TEMPLATE_DB } from './globalSetup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dcDir = path.resolve(here, '../../../../dev/samba-dc');
const ORIGIN = 'http://localhost:5173';

// ---- Directory fixtures (see dev/samba-dc/README.md) -------------------

export const DC = {
  ldapsUrl: `ldaps://localhost:${process.env.DC_LDAPS_PORT ?? '10636'}`,
  caPath: path.join(dcDir, '.generated', 'ca.pem'),
  domain: 'openaduc.test',
  baseDn: 'DC=openaduc,DC=test',
  password: 'OpenADUC-dev-User1',
  /** Built-in Administrator, for test setup that changes the directory. */
  administratorPassword: 'OpenADUC-dev-Admin1',
  serviceAccount: 'svc-openaduc',
  groups: {
    operators: 'CN=OpenADUC Operators,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test',
    auditors: 'CN=OpenADUC Auditors,OU=Groups,OU=OpenADUC Test,DC=openaduc,DC=test',
  },
} as const;

/** Put the directory fixtures back (re-lock, re-disable, …). Takes a few seconds. */
export function reseedDirectory(): void {
  const r = spawnSync('node', [path.join(dcDir, 'dc.mjs'), 'seed'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`dc:seed failed:\n${r.stdout}\n${r.stderr}`);
}

/** Read a user straight from the DC as the service account, bypassing the API. */
export async function readDirectoryUser(
  samAccountName: string,
  attributes: string[],
): Promise<Record<string, unknown> | null> {
  const client = new LdapClient({ url: DC.ldapsUrl, tlsOptions: { ca: readFileSync(DC.caPath) } });
  try {
    await client.bind(`${DC.serviceAccount}@${DC.domain}`, DC.password);
    const { searchEntries } = await client.search(DC.baseDn, {
      scope: 'sub',
      filter: `(&(objectClass=user)(sAMAccountName=${samAccountName}))`,
      attributes,
    });
    return searchEntries[0] ?? null;
  } finally {
    await client.unbind();
  }
}

/**
 * Add a user to, or remove them from, a group, as the domain Administrator.
 * Tests that change memberships must undo them: `reseedDirectory` only adds.
 */
export async function setGroupMember(
  groupDn: string,
  samAccountName: string,
  member: boolean,
): Promise<void> {
  const client = new LdapClient({ url: DC.ldapsUrl, tlsOptions: { ca: readFileSync(DC.caPath) } });
  try {
    await client.bind(`Administrator@${DC.domain}`, DC.administratorPassword);
    const { searchEntries } = await client.search(DC.baseDn, {
      scope: 'sub',
      filter: `(sAMAccountName=${samAccountName})`,
      attributes: ['distinguishedName'],
    });
    const userDn = searchEntries[0]?.dn;
    if (!userDn) throw new Error(`no such user: ${samAccountName}`);
    const { Change, Attribute } = await import('ldapts');
    try {
      await client.modify(
        groupDn,
        new Change({
          operation: member ? 'add' : 'delete',
          modification: new Attribute({ type: 'member', values: [userDn] }),
        }),
      );
    } catch (err) {
      // Already in the requested state.
      const name = (err as Error).name;
      if (
        name !== 'AlreadyExistsError' &&
        name !== 'NoSuchAttributeError' &&
        name !== 'UnwillingToPerformError'
      )
        throw err;
    }
  } finally {
    await client.unbind();
  }
}

// ---- API instance ------------------------------------------------------

export interface TestApi {
  app: FastifyInstance;
  directoryId: number | null;
  /** A browser-like client with its own cookie jar and source address. */
  client(): TestClient;
  close(): Promise<void>;
}

let instanceCounter = 0;

/**
 * Build the API against a fresh database cloned from the migrated template.
 * Call once per test file (beforeAll); each file runs in its own module
 * graph, so env and caches don't leak between files.
 */
export async function startApi(): Promise<TestApi> {
  const adminUrl = inject('adminDatabaseUrl');
  const dbName = `openaduc_test_${process.pid}_${++instanceCounter}`;
  await withAdmin(adminUrl, (c) => c.query(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`));
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;

  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: dbUrl.toString(),
    DATABASE_POOL_MIN: '0',
    SESSION_COOKIE_SECRET: 'integration-test-cookie-secret-0123456789abcdef',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    API_CORS_ORIGIN: ORIGIN,
    AD_TLS_REJECT_UNAUTHORIZED: '1',
    AD_TLS_CA_PATH: DC.caPath,
    SYNC_SCHEDULER_ENABLED: '0',
    // Blank anything a developer's .env could contribute: the directory must
    // come from the setup flow under test, not from env bootstrap.
    AD_LDAP_URLS: '',
    AD_DOMAIN: '',
    AD_BASE_DN: '',
    AD_SERVICE_ACCOUNT_UPN: '',
    AD_SERVICE_ACCOUNT_PASSWORD: '',
    BOOTSTRAP_ADMIN_GROUP_DN: '',
  });

  const { buildApp } = await import('../../src/app.js');
  const app = await buildApp();
  await app.ready();

  let clientCounter = 0;
  return {
    app,
    directoryId: null,
    client: () => new TestClient(app, `10.99.0.${++clientCounter}`),
    async close() {
      await app.close();
      await withAdmin(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
    },
  };
}

async function withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Run first-time setup against the dev DC as `oa.admin` (directory, service
 * account, policy, initial sync), then map the operator and auditor roles to
 * the fixture groups. Leaves the admin client signed in and stepped up.
 */
export async function configureDirectory(api: TestApi): Promise<TestClient> {
  const admin = api.client();
  const init = await admin.post('/api/setup/initialize', {
    domain: DC.domain,
    baseDn: DC.baseDn,
    ldapUrls: [DC.ldapsUrl],
    tlsMode: 'ldaps',
    adminUsername: 'oa.admin',
    adminPassword: DC.password,
  });
  expectOk(init, 'setup/initialize');
  api.directoryId = init.json<{ directory: { id: number } }>().directory.id;

  expectOk(
    await admin.post('/api/setup/service-account', {
      username: DC.serviceAccount,
      password: DC.password,
    }),
    'setup/service-account',
  );
  expectOk(
    await admin.post('/api/setup/policy', { passwordExpiringDays: 14, staleLogonDays: 90 }),
    'setup/policy',
  );
  expectOk(await admin.post('/api/setup/run-initial-sync', {}), 'setup/run-initial-sync');
  for (let i = 0; ; i++) {
    const status = await admin.get('/api/setup/initial-sync-status');
    const job = status.json<{ job: { status: string; tasks: unknown[] } | null }>().job;
    if (job?.status === 'succeeded') break;
    if (job?.status === 'failed' || i > 120) {
      throw new Error(`initial sync did not succeed: ${status.body}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // No UI for mapping these yet (#89); write the settings directly.
  for (const [key, dn] of [
    ['authz.operator_group_dn', DC.groups.operators],
    ['authz.auditor_group_dn', DC.groups.auditors],
  ] as const) {
    await api.app.db
      .updateTable('app_settings')
      .set({ value_json: JSON.stringify(dn) })
      .where('key', '=', key)
      .execute();
    api.app.services.settings.invalidate(key);
  }
  return admin;
}

// ---- Client -------------------------------------------------------------

export class TestClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly app: FastifyInstance,
    /** Distinct per client so per-IP rate limits don't couple tests. */
    readonly remoteAddress: string,
  ) {}

  async request(
    method: HTTPMethods,
    url: string,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const options: InjectOptions = { method, url, headers, remoteAddress: this.remoteAddress };
    if (payload !== undefined) options.payload = payload as object;
    const res = await this.app.inject(options);
    for (const c of res.cookies) {
      if (!c.value || (c.expires && c.expires.getTime() <= Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.request('POST', url, body);
  }
  patch(url: string, body: unknown = {}) {
    return this.request('PATCH', url, body);
  }
  delete(url: string, body?: unknown) {
    return this.request('DELETE', url, body);
  }

  async signIn(api: TestApi, username: string, password: string = DC.password): Promise<void> {
    const res = await this.post('/api/auth/login', {
      directoryId: api.directoryId,
      username,
      password,
    });
    expectOk(res, `sign in as ${username}`);
  }

  async stepUp(password: string = DC.password): Promise<void> {
    expectOk(await this.post('/api/auth/step-up', { password }), 'step-up');
  }
}

export function expectOk(res: LightMyRequestResponse, what: string): void {
  if (res.statusCode >= 300) {
    throw new Error(`${what} failed: HTTP ${res.statusCode} ${res.body}`);
  }
}
