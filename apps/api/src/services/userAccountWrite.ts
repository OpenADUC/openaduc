// SPDX-License-Identifier: BUSL-1.1
import { rawScalarValue } from '../lib/rawAttributes.js';
import { leafRdnValue, parentDn } from '../providers/active-directory/normalize.js';
import type {
  DirectoryObjectIdentifier,
  DirectoryProvider,
  DirectoryUser,
  MutationResult,
  WriteContext,
} from '../providers/types.js';
import type { AuditEventInput, AuditService } from './audit.js';
import { withAudit, type WriteOpResult } from './auditContext.js';
import type { UserLiveRefreshService } from './userLiveRefresh.js';

/** What an account write compares against: the account as just read live, or as the cache saw it. */
export type AccountState = Pick<
  DirectoryUser,
  | 'distinguishedName'
  | 'accountExpiresAt'
  | 'passwordMustChange'
  | 'passwordNeverExpires'
  | 'passwordLastSetAt'
  | 'rawAttributes'
>;

/** A provider write to one user account, as the operator. */
export interface AccountWrite {
  /** The audit action, e.g. `user.disable`. */
  action: string;
  metadata?: Record<string, unknown>;
  /**
   * What the account has now, when it's already as the write would leave
   * it: then nothing is written, and the no-op is audited with this as
   * before and after, marked `unchanged`. Null when there's a change to
   * make.
   */
  asAsked?: (user: AccountState) => Record<string, unknown> | null;
  /** What to tell the operator when the DC refuses with `code`, if more than the code says. */
  refused?: (code: string, user: DirectoryUser) => string | null;
  write: (
    provider: DirectoryProvider,
    user: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ) => Promise<MutationResult>;
}

/**
 * Change one user account as the operator: read it live first (which
 * fails closed when the directory is unreachable), write and audit it,
 * then refresh the cache. The single-user routes and bulk jobs both run
 * this, so a user changed either way is audited the same way. Null when
 * there's no such user; nothing is written or audited then. `unchanged`
 * when the account was already as asked (see AccountWrite.asAsked).
 */
export async function writeUserAccount(
  services: {
    audit: Pick<AuditService, 'recordEvent'>;
    userLiveRefresh: Pick<UserLiveRefreshService, 'refresh'>;
  },
  provider: DirectoryProvider,
  { action, metadata, asAsked, write }: AccountWrite,
  id: string,
  writeCtx: WriteContext,
  audit: Omit<AuditEventInput, 'action' | 'result' | 'providerId' | 'targetType'>,
): Promise<{ user: DirectoryUser; result: WriteOpResult; unchanged: boolean } | null> {
  const before = await services.userLiveRefresh.refresh(provider, id);
  if (!before) return null;
  const snapshot = asAsked?.(before.user) ?? null;
  const base = {
    ...audit,
    action,
    actorAuthMethod: 'ad-password' as const,
    providerId: provider.id,
    targetType: 'user' as const,
    targetId: before.user.objectGuid,
    targetDn: before.user.distinguishedName,
  };
  if (snapshot) {
    const result = await withAudit(
      services.audit,
      { ...base, metadata: { ...audit.metadata, ...metadata, unchanged: true } },
      async () => ({ ok: true, before: snapshot, after: snapshot }),
    );
    return { user: before.user, result, unchanged: true };
  }
  const result = await withAudit(
    services.audit,
    { ...base, ...(metadata ? { metadata: { ...audit.metadata, ...metadata } } : {}) },
    async () => {
      const r = await write(provider, { kind: 'objectGuid', value: id }, writeCtx);
      return {
        ok: r.ok,
        before: r.before ?? null,
        after: r.after ?? null,
        errorCode: r.reason ?? null,
        errorMessage: r.errorMessage ?? null,
      };
    },
  );
  if (result.ok) await services.userLiveRefresh.refresh(provider, id);
  return { user: before.user, result, unchanged: false };
}

export const DISABLE_USER = {
  action: 'user.disable',
  write: (p, user, ctx) => p.disableUser(user, ctx),
} as const satisfies AccountWrite;
export const ENABLE_USER = {
  action: 'user.enable',
  write: (p, user, ctx) => p.enableUser(user, ctx),
} as const satisfies AccountWrite;
export const UNLOCK_USER = {
  action: 'user.unlock',
  write: (p, user, ctx) => p.unlockUser(user, ctx),
} as const satisfies AccountWrite;

const sameDn = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Move the user into this OU, which must be one the cache knows. */
export function moveUserTo(ou: { distinguished_name: string; name: string }) {
  return {
    action: 'user.move',
    metadata: { targetOuDn: ou.distinguished_name, targetOuName: ou.name },
    asAsked: (user) => {
      const parent = parentDn(user.distinguishedName);
      return parent && sameDn(parent, ou.distinguished_name)
        ? { distinguishedName: user.distinguishedName, parentDn: parent }
        : null;
    },
    refused: (code, user) =>
      code === 'conflict'
        ? `An object named ${leafRdnValue(user.distinguishedName) ?? user.distinguishedName} already exists in ${ou.name}.`
        : null,
    write: (p, user, ctx) => p.moveUser(user, ou.distinguished_name, ctx),
  } satisfies AccountWrite;
}

export function expireAccountAt(expiresAt: Date | null) {
  const at = expiresAt?.toISOString() ?? null;
  return {
    action: 'user.accountExpiry.set',
    metadata: { expiresAt: at },
    asAsked: (user) =>
      (user.accountExpiresAt?.toISOString() ?? null) === at ? { accountExpiresAt: at } : null,
    write: (p, user, ctx) => p.setAccountExpiry(user, expiresAt, ctx),
  } satisfies AccountWrite;
}

export const REQUIRE_PASSWORD_CHANGE = {
  action: 'user.passwordMustChange.set',
  asAsked: (user) =>
    user.passwordMustChange
      ? {
          passwordMustChange: true,
          passwordLastSetAt: user.passwordLastSetAt?.toISOString() ?? null,
        }
      : null,
  write: (p, user, ctx) => p.setPasswordMustChange(user, true, ctx),
} as const satisfies AccountWrite;

/** Stop asking the user to change their password; AD restarts its age. */
export const CLEAR_PASSWORD_MUST_CHANGE = {
  action: 'user.passwordMustChange.clear',
  asAsked: (user) =>
    user.passwordMustChange
      ? null
      : {
          passwordMustChange: false,
          passwordLastSetAt: user.passwordLastSetAt?.toISOString() ?? null,
        },
  write: (p, user, ctx) => p.setPasswordMustChange(user, false, ctx),
} as const satisfies AccountWrite;

export const CLEAR_PASSWORD_NEVER_EXPIRES = {
  action: 'user.passwordNeverExpires.clear',
  asAsked: (user) =>
    user.passwordNeverExpires
      ? null
      : {
          passwordNeverExpires: false,
          userAccountControl:
            Number(rawScalarValue(user.rawAttributes['userAccountControl'])) || null,
        },
  write: (p, user, ctx) => p.setPasswordNeverExpires(user, false, ctx),
} as const satisfies AccountWrite;

export const SET_PASSWORD_NEVER_EXPIRES = {
  action: 'user.passwordNeverExpires.set',
  asAsked: (user) =>
    user.passwordNeverExpires
      ? {
          passwordNeverExpires: true,
          userAccountControl:
            Number(rawScalarValue(user.rawAttributes['userAccountControl'])) || null,
        }
      : null,
  write: (p, user, ctx) => p.setPasswordNeverExpires(user, true, ctx),
} as const satisfies AccountWrite;
