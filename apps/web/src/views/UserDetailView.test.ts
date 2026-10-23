// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aUserDetail } from '../test/userDetail.js';
import { ApiError } from '../api/client.js';

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();

const user = aUserDetail({ title: 'Analyst' });

const api = {
  users: {
    get: vi.fn(async () => ({ user })),
    activity: vi.fn(async () => ({ rows: [] })),
    update: vi.fn(async () => ({ user })),
    resetPassword: vi.fn(async () => ({})),
  },
  auth: {
    stepUp: vi.fn(async () => ({
      elevated: {
        active: true,
        idleExpiresAt: inFifteenMinutes(),
        absoluteExpiresAt: inFifteenMinutes(),
      },
    })),
  },
};
vi.mock('../api/index.js', () => ({ api }));

const { default: UserDetailView } = await import('./UserDetailView.vue');
const { useAuthStore } = await import('../stores/auth.js');

async function openTab(tab: string, capabilities: string[], elevated: boolean) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = {
    capabilities,
    elevated: elevated
      ? { active: true, idleExpiresAt: inFifteenMinutes(), absoluteExpiresAt: inFifteenMinutes() }
      : { active: false, idleExpiresAt: null, absoluteExpiresAt: null },
  } as never; // only these fields matter
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/users/:id', name: 'user-detail', component: UserDetailView, props: true }],
  });
  await router.push(`/users/u1?tab=${tab}`);
  const page = mount(RouterView, {
    global: {
      plugins: [pinia, router, PrimeVue, ToastService],
      directives: { tooltip: Tooltip },
      stubs: { teleport: true },
    },
  });
  await flushPromises();
  return { page, auth };
}

const openOrganizationTab = (capabilities: string[], elevated: boolean) =>
  openTab('organization', capabilities, elevated);

type Page = Awaited<ReturnType<typeof openTab>>['page'];

const titleField = (page: Page) => page.find('input[placeholder="Title"]');

async function click(page: Page, label: string) {
  const button = page.findAll('button').find((b) => b.text() === label);
  expect(button).toBeDefined();
  await button!.trigger('click');
  await flushPromises();
}

const clickSave = (page: Page) => click(page, 'Save changes');

describe('editing a user without an elevated session', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prompts step-up on save, then saves', async () => {
    const { page, auth } = await openOrganizationTab(['read:user', 'write:user.attributes'], false);

    await titleField(page).setValue('Engineer');
    await clickSave(page);
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledWith('u1', { patch: { title: 'Engineer' } });
  });

  it('says why a value can’t be saved, and won’t save it', async () => {
    const { page } = await openTab('contact', ['read:user', 'write:user.attributes'], false);

    await page.get('input[placeholder="Primary email"]').setValue('not an address');
    expect(page.text()).toContain('Not an email address');
    const save = page.findAll('button').find((b) => b.text() === 'Save changes')!;
    expect(save.attributes('disabled')).toBeDefined();
  });

  it('shows a read-only operator no editable fields', async () => {
    const { page } = await openOrganizationTab(['read:user'], true);

    expect(titleField(page).exists()).toBe(false);
    expect(page.text()).toContain('Analyst');
  });
});

describe('unsaved edits when the elevated session ends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the edits and saves them after the next step-up', async () => {
    const { page, auth } = await openOrganizationTab(['read:user', 'write:user.attributes'], true);
    await titleField(page).setValue('Engineer');

    vi.advanceTimersByTime(16 * 60_000);
    await flushPromises();
    expect(auth.elevated).toBe(false);
    expect((titleField(page).element as HTMLInputElement).value).toBe('Engineer');

    await clickSave(page);
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledWith('u1', { patch: { title: 'Engineer' } });
  });
});

describe('a dialog write without an elevated session', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens without step-up, then completes after the step-up its submit prompts', async () => {
    const { page, auth } = await openTab(
      'account',
      ['read:user', 'write:user.resetPassword'],
      false,
    );

    await click(page, 'Reset password');
    expect(auth.stepUpRequested).toBe(false);
    await page.get('#reset-new-password').setValue('N3w-passw0rd!');
    api.users.resetPassword.mockRejectedValueOnce(
      new ApiError(403, 'step_up_required', 'step-up required'),
    );
    await click(page, 'Reset');
    expect(page.text()).not.toContain('step-up required');

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.resetPassword).toHaveBeenCalledTimes(2);
    expect(api.users.resetPassword).toHaveBeenLastCalledWith('u1', {
      newPassword: 'N3w-passw0rd!',
      forceChangeAtNextLogin: true,
      unlock: false,
    });
    expect(page.find('#reset-new-password').exists()).toBe(false);
  });
});

describe('resetting a locked-out user’s password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.users.get.mockResolvedValue({ user });
  });

  async function openResetForLocked() {
    api.users.get.mockResolvedValue({ user: aUserDetail({ locked: true }) });
    const { page } = await openTab(
      'account',
      ['read:user', 'write:user.resetPassword', 'write:user.unlock'],
      true,
    );
    await click(page, 'Reset password');
    const unlock = page
      .findAll('label')
      .find((l) => l.text() === 'Also unlock the account')!
      .get('input');
    await page.get('#reset-new-password').setValue('N3w-passw0rd!');
    return { page, unlock };
  }

  it('unlocks the account in the same request', async () => {
    const { page, unlock } = await openResetForLocked();
    expect((unlock.element as HTMLInputElement).checked).toBe(true);

    await click(page, 'Reset');

    expect(api.users.resetPassword).toHaveBeenCalledOnce();
    expect(api.users.resetPassword).toHaveBeenCalledWith('u1', {
      newPassword: 'N3w-passw0rd!',
      forceChangeAtNextLogin: true,
      unlock: true,
    });
  });

  it('leaves the lockout when the operator unticks "Also unlock"', async () => {
    const { page, unlock } = await openResetForLocked();

    await unlock.setValue(false);
    await click(page, 'Reset');

    expect(api.users.resetPassword).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ unlock: false }),
    );
  });

  it('offers to unlock an account locked since the page loaded', async () => {
    api.users.get
      .mockResolvedValueOnce({ user })
      .mockResolvedValue({ user: aUserDetail({ locked: true }) });
    const { page } = await openTab(
      'account',
      ['read:user', 'write:user.resetPassword', 'write:user.unlock'],
      true,
    );

    await click(page, 'Reset password');
    expect(page.text()).toContain('Also unlock the account');
  });

  it('doesn’t offer to unlock an account that isn’t locked', async () => {
    const { page } = await openTab('account', ['read:user', 'write:user.resetPassword'], true);

    await click(page, 'Reset password');
    expect(page.text()).toContain('Force change at next sign-in');
    expect(page.text()).not.toContain('Also unlock the account');
  });
});
