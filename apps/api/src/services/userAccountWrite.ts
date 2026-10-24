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

export type UserAccountAction = 'user.disable' | 'user.enable' | 'user.unlock';

const WRITES: Record<
  UserAccountAction,
  (
    p: DirectoryProvider,
    ref: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ) => Promise<MutationResult>
> = {
  'user.disable': (p, ref, ctx) => p.disableUser(ref, ctx),
  'user.enable': (p, ref, ctx) => p.enableUser(ref, ctx),
  'user.unlock': (p, ref, ctx) => p.unlockUser(ref, ctx),
};

/**
 * Disable, enable or unlock one user as the operator: read it live first
 * (which fails closed when the directory is unreachable), write and audit
 * it, then refresh the cache. The single-user routes and bulk jobs both
 * run this, so a user changed either way is audited the same way. Null
 * when there's no such user; nothing is written or audited then.
 */
export async function writeUserAccount(
  services: { audit: AuditService; userLiveRefresh: UserLiveRefreshService },
  provider: DirectoryProvider,
  action: UserAccountAction,
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
      const r = await WRITES[action](provider, { kind: 'objectGuid', value: id }, writeCtx);
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
