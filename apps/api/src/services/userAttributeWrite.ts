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

/** An edit refused before anything is written or audited. */
export class UserAttributeRefusal extends Error {
  constructor(
    readonly code: 'self_manager' | 'manager_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'UserAttributeRefusal';
  }
}

export const SELF_MANAGER_MESSAGE = 'Not changed: they can’t be their own manager.';

/**
 * Edit one user's attributes as the operator, audited as `user.update`,
 * then refresh the cache. `user` is the account as just read live, which
 * the caller does first (failing closed when the directory is
 * unreachable). The single-user route and the bulk edit both run this, so
 * a user edited either way is audited the same way. An empty patch writes
 * nothing and is audited as a no-op, before and after alike. Throws
 * UserAttributeRefusal for a manager that isn't a user in the directory,
 * or is the user itself.
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
): Promise<WriteOpResult & { refreshed: DirectoryUser | null }> {
  if (patch.managerDn) {
    if (patch.managerDn.toLowerCase() === user.distinguishedName.toLowerCase()) {
      throw new UserAttributeRefusal('self_manager', SELF_MANAGER_MESSAGE);
    }
    const manager = await provider.getUser({ kind: 'distinguishedName', value: patch.managerDn });
    if (!manager) {
      throw new UserAttributeRefusal(
        'manager_not_found',
        'The manager isn’t a user in the directory.',
      );
    }
  }
  const fields = Object.keys(patch);
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
      metadata: fields.length > 0 ? { fields } : { unchanged: true },
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
  const refreshed =
    result.ok && fields.length > 0
      ? await services.userLiveRefresh.refresh(provider, user.objectGuid)
      : null;
  return { ...result, refreshed: refreshed?.user ?? null };
}
