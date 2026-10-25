// SPDX-License-Identifier: BUSL-1.1
// What creating a user takes besides the provider's add and steps, shared
// by the create route and an import's rows.
import { generatePassword } from '@openaduc/shared';
import type { DirectoryProvider, DirectoryUser, UserCreateResult } from '../providers/types.js';

// Long, because nobody types it: it only has to keep the account shut
// until the person sets their own in Entra.
const RANDOM_PASSWORD_LENGTH = 32;

/** A password nobody sees, made here: it never leaves the server. */
export async function randomPassword(
  provider: DirectoryProvider,
  account: { samAccountName: string | null; displayName: string | null },
): Promise<string> {
  const policy = await provider.getDomainPolicy().catch(() => null);
  return generatePassword(policy, account, RANDOM_PASSWORD_LENGTH);
}

/**
 * Fill in what the operator's bind couldn't read back with the service
 * account, so the audit row names the account and records how it was
 * left. Without that, finishing it later is refused.
 */
export async function readBack(
  provider: DirectoryProvider,
  r: UserCreateResult,
  dn: string,
): Promise<UserCreateResult> {
  if (!r.completed.includes('create') || (r.user && r.fingerprint)) return r;
  const id = { kind: 'distinguishedName', value: dn } as const;
  const user: DirectoryUser | null = r.user ?? (await provider.getUser(id).catch(() => null));
  const fingerprint = r.fingerprint ?? (await provider.getAccountFingerprint(id).catch(() => null));
  return { ...r, ...(user ? { user } : {}), ...(fingerprint ? { fingerprint } : {}) };
}
