#!/usr/bin/env node
// pnpm dc:up | dc:seed | dc:down | dc:status — the development Samba AD DC.
// See README.md in this directory for what the fixtures contain.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const compose = ['compose', '-f', join(here, 'compose.yml')];
const ldapsPort = process.env.DC_LDAPS_PORT ?? '10636';
const ldapPort = process.env.DC_LDAP_PORT ?? '10389';

function docker(args) {
  const r = spawnSync('docker', [...compose, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const seed = () => docker(['exec', '-T', 'dc', 'seed.sh']);

const commands = {
  up() {
    mkdirSync(join(here, '.generated'), { recursive: true });
    docker(['up', '-d', '--build', '--wait']);
    seed();
    console.log(`
Dev DC ready (OPENADUC.TEST):
  LDAPS     ldaps://localhost:${ldapsPort}
  StartTLS  ldap://localhost:${ldapPort}
  CA        ${join(here, '.generated', 'ca.pem')}
  Base DN   DC=openaduc,DC=test
  Fixtures  dev/samba-dc/README.md`);
  },
  seed,
  down() {
    docker(['down', '-v', '--remove-orphans']);
    rmSync(join(here, '.generated'), { recursive: true, force: true });
  },
  status() {
    docker(['ps']);
  },
};

const cmd = commands[process.argv[2]];
if (!cmd) {
  console.error(`usage: dc.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
cmd();
