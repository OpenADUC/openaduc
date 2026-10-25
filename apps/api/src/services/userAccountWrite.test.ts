// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from 'vitest';
import type {
  DirectoryProvider,
  DirectoryUser,
  MutationResult,
  WriteContext,
} from '../providers/types.js';
import type { AuditEventInput } from './audit.js';
import {
  CLEAR_PASSWORD_NEVER_EXPIRES,
  DISABLE_USER,
  expireAccountAt,
  moveUserTo,
  REQUIRE_PASSWORD_CHANGE,
  writeUserAccount,
  type AccountState,
} from './userAccountWrite.js';

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

const STAFF = 'OU=Staff,DC=corp';
const LEAVERS = { distinguished_name: 'OU=Leavers,DC=corp', name: 'Leavers' };

const state = (more: Partial<AccountState> = {}): AccountState => ({
  distinguishedName: `CN=Ann Lee,${STAFF}`,
  accountExpiresAt: null,
  passwordMustChange: false,
  passwordNeverExpires: false,
  passwordLastSetAt: new Date('2026-01-01T00:00:00Z'),
  rawAttributes: { userAccountControl: '66048' },
  ...more,
});

function moveSetup(user: Partial<DirectoryUser>) {
  const recordEvent = vi.fn(async () => undefined);
  const refresh = vi.fn(
    async () =>
      (user ? { user: { objectGuid: 'u1', ...state(), ...user } as DirectoryUser } : null) as never,
  );
  const moveUser = vi.fn(async () => ({
    ok: true,
    before: { parentDn: STAFF },
    after: { parentDn: LEAVERS.distinguished_name },
  }));
  const provider = { id: 7, moveUser } as unknown as DirectoryProvider;
  const write = (account: Parameters<typeof writeUserAccount>[2]) =>
    writeUserAccount(
      { audit: { recordEvent }, userLiveRefresh: { refresh } },
      provider,
      account,
      'u1',
      {} as WriteContext,
      { actorUserId: 'op', metadata: { from: 'test' } },
    );
  return { write, recordEvent, refresh, moveUser };
}

describe('writeUserAccount, moving a user', () => {
  it('writes nothing for a user already as asked, and audits the no-op with them as they are', async () => {
    const { write, recordEvent, refresh, moveUser } = moveSetup({
      distinguishedName: 'CN=Ann Lee,ou=leavers,dc=corp',
    });

    const written = await write(moveUserTo(LEAVERS));

    expect(written).toMatchObject({ unchanged: true, result: { ok: true } });
    expect(moveUser).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    const snapshot = {
      distinguishedName: 'CN=Ann Lee,ou=leavers,dc=corp',
      parentDn: 'ou=leavers,dc=corp',
    };
    expect(recordEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'user.move',
        result: 'success',
        providerId: 7,
        targetId: 'u1',
        metadata: {
          from: 'test',
          targetOuDn: LEAVERS.distinguished_name,
          targetOuName: 'Leavers',
          unchanged: true,
        },
        before: snapshot,
        after: snapshot,
      }),
    );
  });

  it('makes the write otherwise, audits it with its metadata, and refreshes the user', async () => {
    const { write, recordEvent, refresh, moveUser } = moveSetup({});

    const written = await write(moveUserTo(LEAVERS));

    expect(written).toMatchObject({ unchanged: false, result: { ok: true } });
    expect(moveUser).toHaveBeenCalledWith(
      { kind: 'objectGuid', value: 'u1' },
      LEAVERS.distinguished_name,
      {},
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { from: 'test', targetOuDn: LEAVERS.distinguished_name, targetOuName: 'Leavers' },
        before: { parentDn: STAFF },
        after: { parentDn: LEAVERS.distinguished_name },
      }),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe('the account writes', () => {
  it('moveUserTo says which name a refused move clashed on', () => {
    const move = moveUserTo(LEAVERS);
    const user = { distinguishedName: `CN=Ann Lee,${STAFF}` } as DirectoryUser;
    expect(move.refused('conflict', user)).toBe(
      'An object named Ann Lee already exists in Leavers.',
    );
    expect(move.refused('permission_denied', user)).toBeNull();
    expect(move.asAsked(state())).toBeNull();
  });

  it('expireAccountAt matches an expiry to the millisecond, and never to never', () => {
    const at = new Date('2031-03-01T00:00:00.000Z');
    expect(expireAccountAt(at).asAsked(state({ accountExpiresAt: new Date(at) }))).toEqual({
      accountExpiresAt: at.toISOString(),
    });
    expect(
      expireAccountAt(at).asAsked(state({ accountExpiresAt: new Date(at.getTime() + 1) })),
    ).toBeNull();
    expect(expireAccountAt(at).asAsked(state())).toBeNull();
    expect(expireAccountAt(null).asAsked(state())).toEqual({ accountExpiresAt: null });
    expect(expireAccountAt(null).metadata).toEqual({ expiresAt: null });
  });

  it('the password flags are as asked when already set, or already cleared', () => {
    expect(REQUIRE_PASSWORD_CHANGE.asAsked(state())).toBeNull();
    expect(REQUIRE_PASSWORD_CHANGE.asAsked(state({ passwordMustChange: true }))).toEqual({
      passwordMustChange: true,
      passwordLastSetAt: '2026-01-01T00:00:00.000Z',
    });
    expect(CLEAR_PASSWORD_NEVER_EXPIRES.asAsked(state({ passwordNeverExpires: true }))).toBeNull();
    expect(
      CLEAR_PASSWORD_NEVER_EXPIRES.asAsked(state({ rawAttributes: { userAccountControl: '512' } })),
    ).toEqual({ passwordNeverExpires: false, userAccountControl: 512 });
  });
});
