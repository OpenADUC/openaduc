// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { describe, expect, it, vi } from 'vitest';
import type { DirectoryPolicy } from '@openaduc/shared';
import { aUserDetail } from '../../test/userDetail.js';
import { checkPassword } from '../lib/passwordPolicy.js';

const user = aUserDetail({ samAccountName: 'jdoe', displayName: 'Jane Doe' });
const policy: DirectoryPolicy = {
  lockoutDurationMinutes: 0,
  lockoutThreshold: 5,
  lockoutObservationMinutes: 30,
  maxPwdAgeDays: 42,
  minPwdLength: 20,
  pwdHistoryLength: 24,
  complexityRequired: true,
  fetchedAt: '2026-01-01T00:00:00.000Z',
};
const api = {
  users: { get: vi.fn(async () => ({ user })), resetPassword: vi.fn() },
  directories: { policy: vi.fn(async () => ({ policy })) },
};
vi.mock('../../api/index.js', () => ({ api }));

const { default: ResetPasswordDialog } = await import('./ResetPasswordDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');

describe('the reset password dialog', () => {
  it('generates a password that meets the domain’s policy, and shows it', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore().actor = {
      directoryId: 1,
      capabilities: ['read:user', 'write:user.resetPassword'],
      elevated: { active: true },
    } as never;
    const dialog = mount(ResetPasswordDialog, {
      props: { visible: true, user },
      global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
    });
    await flushPromises();

    await dialog
      .findAll('button')
      .find((b) => b.text() === 'Generate')!
      .trigger('click');

    const input = dialog.get('#reset-new-password').element as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value.length).toBeGreaterThanOrEqual(20);
    expect(checkPassword(input.value, policy, user).every((c) => c.met)).toBe(true);
    const checks = dialog.findAll('li');
    expect(checks.map((li) => li.text())).toEqual([
      'At least 20 characters',
      'Three of: uppercase, lowercase, digits, symbols',
      'Not the logon name or part of the display name',
    ]);
    expect(checks.every((li) => li.classes('met'))).toBe(true);
  });
});
