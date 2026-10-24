// SPDX-License-Identifier: BUSL-1.1
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

/** A provider write to one user account, as the operator. */
export interface AccountWrite {
  /** The audit action, e.g. `user.disable`. */
  action: string;
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
 * there's no such user; nothing is written or audited then.
 */
export async function writeUserAccount(
  services: {
    audit: Pick<AuditService, 'recordEvent'>;
    userLiveRefresh: Pick<UserLiveRefreshService, 'refresh'>;
  },
  provider: DirectoryProvider,
  { action, write }: AccountWrite,
  id: string,
  writeCtx: WriteContext,
  audit: Omit<AuditEventInput, 'action' | 'result' | 'providerId' | 'targetType'>,
): Promise<{ user: DirectoryUser; result: WriteOpResult } | null> {
  const before = await services.userLiveRefresh.refresh(provider, id);
  if (!before) return null;
  const result = await withAudit(
    services.audit,
    {
      ...audit,
      action,
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: 'user',
      targetId: before.user.objectGuid,
      targetDn: before.user.distinguishedName,
    },
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
  return { user: before.user, result };
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
