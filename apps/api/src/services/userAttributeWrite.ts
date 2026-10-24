// SPDX-License-Identifier: BUSL-1.1
import type {
  DirectoryProvider,
  DirectoryUser,
  UserAttributePatch,
  WriteContext,
} from '../providers/types.js';
import type { AuditEventInput, AuditService } from './audit.js';
import { withAudit, type WriteOpResult } from './auditContext.js';
import type { UserLiveRefreshService } from './userLiveRefresh.js';

/**
 * Edit one user's attributes as the operator, audited as `user.update`,
 * then refresh the cache. `user` is the account as just read live, which
 * the caller does first (failing closed when the directory is
 * unreachable). The single-user route and the bulk edit both run this, so
 * a user edited either way is audited the same way.
 */
export async function writeUserAttributes(
  services: {
    audit: Pick<AuditService, 'recordEvent'>;
    userLiveRefresh: Pick<UserLiveRefreshService, 'refresh'>;
  },
  provider: DirectoryProvider,
  user: DirectoryUser,
  patch: UserAttributePatch,
  writeCtx: WriteContext,
  audit: Omit<AuditEventInput, 'action' | 'result' | 'providerId' | 'targetType'>,
): Promise<WriteOpResult> {
  const result = await withAudit(
    services.audit,
    {
      ...audit,
      action: 'user.update',
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: 'user',
      targetId: user.objectGuid,
      targetDn: user.distinguishedName,
      metadata: { ...audit.metadata, fields: Object.keys(patch) },
    },
    async () => {
      const r = await provider.updateUserAttributes(
        { kind: 'objectGuid', value: user.objectGuid },
        patch,
        writeCtx,
      );
      return {
        ok: r.ok,
        before: r.before ?? null,
        after: r.after ?? null,
        errorCode: r.reason ?? null,
        errorMessage: r.errorMessage ?? null,
      };
    },
  );
  if (result.ok) await services.userLiveRefresh.refresh(provider, user.objectGuid);
  return result;
}
