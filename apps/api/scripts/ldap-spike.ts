// SPDX-License-Identifier: BUSL-1.1
/* eslint-disable no-console */
// LDAP spike — exercises the ActiveDirectoryProvider against whatever
// directory is configured by env. Used to validate that:
//   - LDAPS bind works
//   - Service account read works
//   - Account state decoding looks right
//   - Sync iterates without exploding
//   - Unlock works against a freshly-locked test user (only if --unlock=<user>)
//
// Usage:
//   pnpm --filter @openaduc/api ldap-spike
//   pnpm --filter @openaduc/api ldap-spike --user=openaduc-sync
//   pnpm --filter @openaduc/api ldap-spike --auth=alice --auth-pass=Passw0rd!
//   pnpm --filter @openaduc/api ldap-spike --unlock=alice --unlock-as=admin@example.com --unlock-as-pass='...'

import { loadEnv } from '../src/config/env.js';
import { ActiveDirectoryProvider } from '../src/providers/active-directory/provider.js';

interface Args {
  user?: string;
  auth?: string;
  authPass?: string;
  unlock?: string;
  unlockAs?: string;
  unlockAsPass?: string;
  syncLimit: number;
}

function parseArgs(): Args {
  const args: Args = { syncLimit: 5 };
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    switch (key) {
      case 'user':
        args.user = value;
        break;
      case 'auth':
        args.auth = value;
        break;
      case 'auth-pass':
        args.authPass = value;
        break;
      case 'unlock':
        args.unlock = value;
        break;
      case 'unlock-as':
        args.unlockAs = value;
        break;
      case 'unlock-as-pass':
        args.unlockAsPass = value;
        break;
      case 'sync-limit':
        args.syncLimit = Number(value) || 5;
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const args = parseArgs();
  if (
    env.AD_LDAP_URLS.length === 0 ||
    !env.AD_BASE_DN ||
    !env.AD_SERVICE_ACCOUNT_UPN ||
    !env.AD_SERVICE_ACCOUNT_PASSWORD
  ) {
    console.error(
      'spike requires AD_LDAP_URLS, AD_BASE_DN, AD_SERVICE_ACCOUNT_UPN, AD_SERVICE_ACCOUNT_PASSWORD env vars',
    );
    process.exit(1);
  }
  const provider = new ActiveDirectoryProvider({
    id: 0,
    name: 'spike',
    baseDn: env.AD_BASE_DN,
    ldapUrls: env.AD_LDAP_URLS,
    tlsRejectUnauthorized: env.AD_TLS_REJECT_UNAUTHORIZED,
    tlsCaPath: env.AD_TLS_CA_PATH,
    operationTimeoutMs: env.AD_OPERATION_TIMEOUT_MS,
    serviceAccountUpn: env.AD_SERVICE_ACCOUNT_UPN,
    serviceAccountPassword: env.AD_SERVICE_ACCOUNT_PASSWORD,
  });

  console.log('==> testConnection');
  const test = await provider.testConnection();
  console.log(JSON.stringify(test, null, 2));
  if (!test.ok) {
    console.error('connection test failed; aborting');
    process.exit(1);
  }

  if (args.user) {
    console.log(`\n==> getUser sAMAccountName="${args.user}"`);
    const user = await provider.getUser({ kind: 'samAccountName', value: args.user });
    console.log(user ? JSON.stringify(user, null, 2) : '(not found)');
  }

  console.log(`\n==> searchUsers (first ${args.syncLimit})`);
  const found = await provider.searchUsers({ pageSize: args.syncLimit });
  for (const u of found.slice(0, args.syncLimit)) {
    console.log(
      `  ${u.samAccountName ?? '<no-sam>'.padEnd(20)}  ${u.displayName ?? ''}  enabled=${u.enabled} locked=${u.locked}`,
    );
  }

  console.log('\n==> syncUsers (first few)');
  let count = 0;
  for await (const u of provider.syncUsers({ pageSize: 50 })) {
    if (count++ < args.syncLimit) {
      console.log(`  [sync] ${u.samAccountName ?? u.distinguishedName}`);
    }
  }
  console.log(`  total streamed: ${count}`);

  if (args.auth && args.authPass) {
    console.log(`\n==> authenticateUser ${args.auth}`);
    const r = await provider.authenticateUser({ username: args.auth, password: args.authPass });
    // Don't dump the full user — just the outcome.
    console.log({
      ok: r.ok,
      reason: r.reason,
      errorMessage: r.errorMessage,
      groupCount: r.groupDns?.length,
    });
  }

  if (args.unlock && args.unlockAs && args.unlockAsPass) {
    console.log(`\n==> unlockUser ${args.unlock} (acting as ${args.unlockAs})`);
    const r = await provider.unlockUser(
      { kind: 'samAccountName', value: args.unlock },
      {
        actorUserId: 'spike',
        actorUsername: args.unlockAs,
        actorPassword: args.unlockAsPass,
        correlationId: 'spike-' + Date.now(),
      },
    );
    console.log(JSON.stringify(r, null, 2));
  }

  console.log('\nspike done');
}

main().catch((err) => {
  console.error('spike failed:', err);
  process.exit(1);
});
