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
    unlock: vi.fn(async () => ({})),
    disable: vi.fn(async () => ({})),
    enable: vi.fn(async () => ({})),
    setAccountExpiry: vi.fn(async () => ({})),
    addGroup: vi.fn(async () => ({ ok: true })),
    removeGroup: vi.fn(async () => ({ ok: true })),
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
    routes: [
      { path: '/users/:id', name: 'user-detail', component: UserDetailView, props: true },
      { path: '/groups/:id', name: 'group-detail', component: { render: () => null } },
    ],
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
  return { page, auth, router };
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

  it('is clean again once the save lands', async () => {
    const { page } = await openOrganizationTab(['read:user', 'write:user.attributes'], true);

    await titleField(page).setValue('Engineer');
    api.users.get.mockResolvedValueOnce({ user: aUserDetail({ title: 'Engineer' }) });
    await clickSave(page);
    await flushPromises();
    expect(api.users.update).toHaveBeenCalledOnce();
    expect(page.text()).not.toContain('unsaved change');
    expect(page.findAll('button').some((b) => b.text() === 'Save changes')).toBe(false);
    expect((titleField(page).element as HTMLInputElement).value).toBe('Engineer');
  });

  it('forgets the edits of a user left behind, even when the next one fails to load', async () => {
    const { page, router } = await openOrganizationTab(
      ['read:user', 'write:user.attributes'],
      true,
    );
    await titleField(page).setValue('Engineer');

    api.users.get.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const leaving = router.push('/users/u2?tab=organization');
    await flushPromises();
    await click(page, 'Leave without saving');
    await leaving;
    await flushPromises();
    expect(page.text()).toContain('DC unreachable');

    void router.push('/users/u3?tab=organization');
    await flushPromises();
    expect(router.currentRoute.value.params['id']).toBe('u3');
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

  it('opens without step-up, prompts it on submit, then completes', async () => {
    const { page, auth } = await openTab(
      'account',
      ['read:user', 'write:user.resetPassword'],
      false,
    );

    await click(page, 'Reset password');
    expect(auth.stepUpRequested).toBe(false);
    await page.get('#reset-new-password').setValue('N3w-passw0rd!');
    await click(page, 'Reset');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.resetPassword).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.resetPassword).toHaveBeenCalledOnce();
    expect(api.users.resetPassword).toHaveBeenCalledWith('u1', {
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

describe('unlocking from the Account tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.users.get.mockResolvedValue({ user });
  });

  it('unlocks after the step-up its click prompts, then shows the account unlocked', async () => {
    api.users.get.mockResolvedValueOnce({ user: aUserDetail({ locked: true }) });
    const { page, auth } = await openTab('account', ['read:user', 'write:user.unlock'], false);

    await click(page, 'Unlock account');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.unlock).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.unlock).toHaveBeenCalledWith('u1');
    expect(api.users.get).toHaveBeenCalledTimes(2);
    expect(page.findAll('button').some((b) => b.text() === 'Not locked')).toBe(true);
  });
});

async function runAction(page: Page, label: string) {
  await click(page, 'Actions');
  const item = page.findAll('[role="menuitem"]').find((i) => i.text() === label);
  expect(item).toBeDefined();
  await item!.find('a').trigger('click');
  await flushPromises();
}

const inSales = aUserDetail({
  groupMemberships: [
    { id: 'g1', name: 'Sales', distinguishedName: 'CN=Sales', direct: true },
  ] as never,
});

describe('a single reversible change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.users.get.mockResolvedValue({ user });
  });

  it('disables the account without asking, and Undo enables it again', async () => {
    const { page } = await openTab('overview', ['read:user', 'write:user.enableDisable'], true);

    await runAction(page, 'Disable account');
    expect(api.users.disable).toHaveBeenCalledWith('u1');
    expect(page.find('[role="dialog"]').exists()).toBe(false);
    expect(page.text()).toContain('Disabled Jane Doe');

    await click(page, 'Undo');
    expect(api.users.enable).toHaveBeenCalledWith('u1');
    expect(page.text()).toContain('Enabled Jane Doe');
    expect(page.findAll('button').some((b) => b.text() === 'Undo')).toBe(false);
  });

  it('removes a group without asking, and Undo adds the user back', async () => {
    api.users.get.mockResolvedValue({ user: inSales });
    const { page } = await openTab('groups', ['read:user', 'write:group.membership'], true);

    await page.get('button[aria-label="Remove from Sales"]').trigger('click');
    await flushPromises();
    expect(api.users.removeGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(page.text()).toContain('Removed Jane Doe from Sales');

    await click(page, 'Undo');
    expect(api.users.addGroup).toHaveBeenCalledWith('u1', { groupId: 'g1' });
    expect(page.text()).toContain('Added Jane Doe to Sales');
  });
});

describe('a failed change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.users.get.mockResolvedValue({ user });
  });
  afterEach(() => vi.useRealTimers());

  it('stays under the Actions menu until retried', async () => {
    api.users.disable.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { page } = await openTab('overview', ['read:user', 'write:user.enableDisable'], true);

    await runAction(page, 'Disable account');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.get('.inline-failure').text()).toContain('Couldn’t disable Jane Doe');
    expect(page.get('.inline-failure').text()).toContain('DC unreachable');

    await click(page, 'Retry');
    expect(api.users.disable).toHaveBeenCalledTimes(2);
    expect(page.find('.inline-failure').exists()).toBe(false);
  });

  it('stays on the Groups tab until dismissed', async () => {
    api.users.get.mockResolvedValue({ user: inSales });
    api.users.removeGroup.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { page } = await openTab('groups', ['read:user', 'write:group.membership'], true);

    await page.get('button[aria-label="Remove from Sales"]').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.get('.inline-failure').text()).toContain('Couldn’t remove Jane Doe from Sales');

    await page.get('.inline-failure button[aria-label="Close"]').trigger('click');
    await flushPromises();
    expect(page.find('.inline-failure').exists()).toBe(false);
    expect(api.users.removeGroup).toHaveBeenCalledOnce();
  });

  it('doesn’t show on another user’s page, even when it comes in after the switch', async () => {
    let refuse!: (err: Error) => void;
    api.users.disable.mockImplementationOnce(() => new Promise((_, r) => (refuse = r)));
    const { page, router } = await openTab(
      'overview',
      ['read:user', 'write:user.enableDisable'],
      true,
    );

    await runAction(page, 'Disable account');
    await router.push('/users/u2?tab=overview');
    await flushPromises();
    refuse(new ApiError(500, 'ldap_error', 'DC unreachable'));
    await flushPromises();
    expect(page.find('.inline-failure').exists()).toBe(false);
  });
});

describe('why the user can’t sign in', () => {
  const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
  const ALL_FIXES = [
    'read:user',
    'write:user.enableDisable',
    'write:user.unlock',
    'write:user.resetPassword',
  ];

  beforeEach(() => vi.clearAllMocks());

  async function openWith(u: Parameters<typeof aUserDetail>[0], caps = ALL_FIXES, elevated = true) {
    api.users.get.mockResolvedValue({ user: aUserDetail(u) });
    return openTab('overview', caps, elevated);
  }
  const status = (page: Page) => page.get('.sign-in-status');
  const conditions = (page: Page) => page.findAll('.sign-in-condition-title').map((t) => t.text());
  const primary = (page: Page) => page.findAll('.detail-hero-primary button');

  it('says a user who can sign in can, and when they last did', async () => {
    const { page } = await openWith({ lastLogonAt: HOUR_AGO });

    expect(status(page).text()).toContain('Can sign in');
    expect(status(page).text()).toContain(`Last signed in ${new Date(HOUR_AGO).toLocaleString()}`);
    expect(primary(page)).toHaveLength(0);
  });

  it('says how a lockout came about and that it lasts until someone unlocks it', async () => {
    const { page } = await openWith({
      locked: true,
      lockedAt: HOUR_AGO,
      lockedUntilUnlocked: true,
      badPasswordCount: 5,
    });

    expect(conditions(page)).toEqual(['Locked']);
    expect(status(page).text()).toContain(`Since ${new Date(HOUR_AGO).toLocaleString()}`);
    expect(status(page).text()).toContain('5 bad passwords');
    expect(status(page).text()).toContain('Stays locked until someone unlocks it');
    expect(primary(page).map((b) => b.text())).toEqual(['Unlock']);
  });

  it('names the most severe condition first, and fixes that one', async () => {
    const { page } = await openWith({
      enabled: false,
      locked: true,
      passwordExpiresAt: HOUR_AGO,
      accountExpiresAt: HOUR_AGO,
    });

    expect(conditions(page)).toEqual(['Disabled', 'Locked', 'Password expired', 'Account expired']);
    expect(page.find('.detail-hero').find('.badge').text()).toBe('Disabled');
    await click(page, 'Enable');
    expect(api.users.enable).toHaveBeenCalledWith('u1');
    expect(api.users.unlock).not.toHaveBeenCalled();
  });

  it('unlocks after the step-up its click prompts', async () => {
    const { page, auth } = await openWith({ locked: true }, ALL_FIXES, false);

    await click(page, 'Unlock');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.unlock).not.toHaveBeenCalled();
    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.unlock).toHaveBeenCalledWith('u1');
  });

  it.each([
    ['an expired password', { passwordExpiresAt: HOUR_AGO }, 'Password expired'],
    [
      'a password that must change',
      { passwordMustChange: true },
      'Must change password at next sign-in',
    ],
  ])('offers a password reset for %s', async (_, u, condition) => {
    const { page } = await openWith(u);

    expect(conditions(page)).toEqual([condition]);
    await click(page, 'Reset password');
    expect(page.find('#reset-new-password').exists()).toBe(true);
  });

  it('extends an expired account', async () => {
    const { page } = await openWith({ accountExpiresAt: HOUR_AGO });

    expect(conditions(page)).toEqual(['Account expired']);
    await click(page, 'Extend expiry');
    const never = page.findAll('label').find((l) => l.text() === 'Never expires')!;
    await never.get('input').setValue(true);
    await click(page, 'Save');
    expect(api.users.setAccountExpiry).toHaveBeenCalledWith('u1', { expiresAt: null });
  });

  it('offers no fix the operator can’t make', async () => {
    const { page } = await openWith({ enabled: false, locked: true }, [
      'read:user',
      'write:user.unlock',
    ]);

    expect(conditions(page)).toEqual(['Disabled', 'Locked']);
    expect(primary(page)).toHaveLength(0);
  });

  it('says on the Account tab that a lockout with no duration lasts until someone unlocks it', async () => {
    api.users.get.mockResolvedValue({
      user: aUserDetail({ locked: true, lockedAt: HOUR_AGO, lockedUntilUnlocked: true }),
    });
    const { page } = await openTab('account', ['read:user'], false);

    const card = page.findAll('.kv-grid')[0]!;
    expect(card.text()).toContain('Stays locked until someone unlocks it');
    expect(card.text()).not.toContain('Auto-unlocks');
  });
});
