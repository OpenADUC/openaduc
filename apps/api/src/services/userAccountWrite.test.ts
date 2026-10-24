// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from 'vitest';
import type { DirectoryProvider, DirectoryUser, MutationResult } from '../providers/types.js';
import type { AuditEventInput } from './audit.js';
import { DISABLE_USER, writeUserAccount } from './userAccountWrite.js';

const jane = {
  objectGuid: 'u1',
  distinguishedName: 'CN=Jane Doe,OU=Staff,DC=corp,DC=example',
} as DirectoryUser;
const writeCtx = {
  actorUserId: 'op',
  actorUsername: 'op',
  actorPassword: 'pw',
  correlationId: 'c1',
};

function setup(user: DirectoryUser | null, result: MutationResult) {
  const events: AuditEventInput[] = [];
  const services = {
    audit: { recordEvent: vi.fn(async (e: AuditEventInput) => void events.push(e)) },
    userLiveRefresh: { refresh: vi.fn(async () => (user ? ({ user } as never) : null)) },
  };
  const disableUser = vi.fn(async () => result);
  const provider = { id: 3, disableUser } as unknown as DirectoryProvider;
  const write = () =>
    writeUserAccount(services, provider, DISABLE_USER, 'u1', writeCtx, { bulkJobId: '7' });
  return { write, events, services, disableUser };
}

describe('writeUserAccount', () => {
  it('writes as the operator, audits the before and after, and refreshes the cache', async () => {
    const { write, events, services, disableUser } = setup(jane, {
      ok: true,
      before: { enabled: true },
      after: { enabled: false },
    });

    const written = await write();

    expect(written?.result).toMatchObject({ ok: true, after: { enabled: false } });
    expect(disableUser).toHaveBeenCalledWith({ kind: 'objectGuid', value: 'u1' }, writeCtx);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'user.disable',
        result: 'success',
        providerId: 3,
        targetId: 'u1',
        targetDn: jane.distinguishedName,
        before: { enabled: true },
        after: { enabled: false },
        bulkJobId: '7',
      }),
    ]);
    expect(services.userLiveRefresh.refresh).toHaveBeenCalledTimes(2);
  });

  it('audits a refusal with the directory’s reason, and leaves the cache', async () => {
    const { write, events, services } = setup(jane, {
      ok: false,
      reason: 'permission_denied',
      errorMessage: 'INSUFF_ACCESS_RIGHTS',
    });

    const written = await write();

    expect(written?.result).toMatchObject({ ok: false, errorCode: 'permission_denied' });
    expect(events).toEqual([
      expect.objectContaining({
        result: 'failure',
        errorCode: 'permission_denied',
        metadata: { errorMessage: 'INSUFF_ACCESS_RIGHTS' },
      }),
    ]);
    expect(services.userLiveRefresh.refresh).toHaveBeenCalledOnce();
  });

  it('writes and audits nothing for a user that isn’t there', async () => {
    const { write, events, disableUser } = setup(null, { ok: true });

    expect(await write()).toBeNull();
    expect(disableUser).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
