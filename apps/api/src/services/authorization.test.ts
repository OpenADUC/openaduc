// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { AuthorizationService } from './authorization.js';
import type { SettingsService } from './settings.js';

// Minimal stub Env (only the field the service reads).
const env = {
  BOOTSTRAP_ADMIN_GROUP_DN: 'CN=Domain Admins,CN=Users,DC=example,DC=com',
} as unknown as Env;

function settingsStub(values: Record<string, unknown>): SettingsService {
  return {
    get: async <T>(key: string, fallback: T): Promise<T> =>
      values[key] !== undefined ? (values[key] as T) : fallback,
    invalidate: () => undefined,
  } as unknown as SettingsService;
}

describe('AuthorizationService.resolveCapabilities', () => {
  it('returns empty when user is in no configured groups and no bootstrap match', async () => {
    const svc = new AuthorizationService(env, settingsStub({}));
    const caps = await svc.resolveCapabilities(['CN=Random,CN=Users,DC=x,DC=y']);
    expect(caps).toEqual([]);
  });

  it('grants admin capabilities via bootstrap fallback when admin not configured', async () => {
    const svc = new AuthorizationService(env, settingsStub({}));
    const caps = await svc.resolveCapabilities(['CN=Domain Admins,CN=Users,DC=example,DC=com']);
    expect(caps).toContain('write:user.unlock');
    expect(caps).toContain('view:audit');
    expect(caps).toContain('configure:directory');
  });

  it('matches DN comparison case-insensitively', async () => {
    const svc = new AuthorizationService(env, settingsStub({}));
    const caps = await svc.resolveCapabilities(['cn=domain admins,cn=users,dc=example,dc=com']);
    expect(caps.length).toBeGreaterThan(0);
  });

  it('does not bootstrap when admin is configured (even if user is in env-bootstrap)', async () => {
    const svc = new AuthorizationService(
      env,
      settingsStub({ 'authz.admin_group_dn': 'CN=AppAdmins,CN=Users,DC=x,DC=y' }),
    );
    const caps = await svc.resolveCapabilities(['CN=Domain Admins,CN=Users,DC=example,DC=com']);
    expect(caps).toEqual([]);
  });

  it('grants operator capabilities when user is in the operator group', async () => {
    const svc = new AuthorizationService(
      env,
      settingsStub({
        'authz.operator_group_dn': 'CN=Operators,CN=Users,DC=x,DC=y',
      }),
    );
    const caps = await svc.resolveCapabilities(['CN=Operators,CN=Users,DC=x,DC=y']);
    expect(caps).toContain('write:user.unlock');
    expect(caps).not.toContain('configure:directory');
  });

  it('grants auditor capabilities when user is in the auditor group', async () => {
    const svc = new AuthorizationService(
      env,
      settingsStub({ 'authz.auditor_group_dn': 'CN=Auditors,CN=Users,DC=x,DC=y' }),
    );
    const caps = await svc.resolveCapabilities(['CN=Auditors,CN=Users,DC=x,DC=y']);
    expect(caps).toContain('view:audit');
    expect(caps).not.toContain('write:user.unlock');
  });

  it('unions capabilities across multiple matched roles', async () => {
    const svc = new AuthorizationService(
      env,
      settingsStub({
        'authz.operator_group_dn': 'CN=Operators,CN=Users,DC=x,DC=y',
        'authz.auditor_group_dn': 'CN=Auditors,CN=Users,DC=x,DC=y',
      }),
    );
    const caps = await svc.resolveCapabilities([
      'CN=Operators,CN=Users,DC=x,DC=y',
      'CN=Auditors,CN=Users,DC=x,DC=y',
    ]);
    expect(caps).toContain('write:user.unlock'); // operator
    expect(caps).toContain('view:audit'); // auditor
  });
});

describe('AuthorizationService.has / hasAny', () => {
  const svc = new AuthorizationService(env, settingsStub({}));
  it('has() checks single capability', () => {
    expect(svc.has(['read:user', 'view:audit'], 'view:audit')).toBe(true);
    expect(svc.has(['read:user'], 'view:audit')).toBe(false);
  });
  it('hasAny() returns true if any required is present', () => {
    expect(svc.hasAny(['read:user'], ['view:audit', 'read:user'])).toBe(true);
    expect(svc.hasAny(['read:user'], ['view:audit'])).toBe(false);
  });
});
