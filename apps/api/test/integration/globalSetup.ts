// SPDX-License-Identifier: BUSL-1.1
// Runs once per integration-test run: makes sure the dev Samba DC is up and
// seeded, starts a disposable Postgres (unless TEST_DATABASE_URL points at
// one), and migrates a template database that each test file clones.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '../..');
const dcScript = path.resolve(apiDir, '../../dev/samba-dc/dc.mjs');
export const TEMPLATE_DB = 'openaduc_test_template';

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  const id = run('docker', [
    'run', '-d', '--rm',
    '-e', 'POSTGRES_USER=openaduc_test',
    '-e', 'POSTGRES_PASSWORD=openaduc_test',
    '-p', '127.0.0.1::5432',
    'postgres:16-alpine',
  ]); // prettier-ignore
  const stop = () => void spawnSync('docker', ['rm', '-f', id]);
  try {
    const port = run('docker', ['port', id, '5432/tcp']).split(':').pop();
    const url = `postgres://openaduc_test:openaduc_test@127.0.0.1:${port}/postgres`;
    // pg_isready inside the container can pass before the host port
    // forwards, so wait for a real connection from here.
    for (let i = 0; ; i++) {
      const client = new pg.Client({ connectionString: url });
      try {
        await client.connect();
        await client.end();
        return { url, stop };
      } catch (err) {
        if (i > 60) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    stop();
    throw err;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  // Starts the DC if needed and re-applies fixtures; a no-op build when the
  // image is current.
  run('node', [dcScript, 'up']);

  const external = process.env.TEST_DATABASE_URL;
  const pgInstance = external ? { url: external, stop: () => {} } : await startPostgres();

  const admin = new pg.Client({ connectionString: pgInstance.url });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const templateUrl = new URL(pgInstance.url);
  templateUrl.pathname = `/${TEMPLATE_DB}`;
  execFileSync('pnpm', ['migrate:latest'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: templateUrl.toString() },
    stdio: 'pipe',
  });

  project.provide('adminDatabaseUrl', pgInstance.url);
  return pgInstance.stop;
}
