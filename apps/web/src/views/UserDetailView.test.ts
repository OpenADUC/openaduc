// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aUserDetail } from '../test/userDetail.js';
import { ApiError } from '../api/client.js';

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();

const user = aUserDetail({ title: 'Analyst' });
const COPY_SOURCE = {
  source: {
    id: 'u1',
    distinguishedName: 'CN=Jane Doe',
    samAccountName: 'jane.doe',
    displayName: 'Jane Doe',
  },
  ouDn: 'OU=Staff,DC=corp,DC=test',
  organisation: {
    title: 'Analyst',
    department: 'Finance',
    company: null,
    physicalDeliveryOfficeName: null,
    streetAddress: null,
    l: 'Leeds',
    st: null,
    postalCode: null,
    c: null,
    co: null,
    countryCode: null,
  },
  manager: { id: 'u2', distinguishedName: 'CN=Max Boss', displayName: 'Max Boss' },
  groups: [
    {
      id: 'g-admins',
      name: 'Domain Admins',
      distinguishedName: 'CN=Domain Admins',
      privilege: { reason: 'protected' },
    },
    { id: 'g-finance', name: 'Finance', distinguishedName: 'CN=Finance', privilege: null },
  ],
};

const api = {
  users: {
    get: vi.fn(async (_id: string) => ({ user })),
    activity: vi.fn(async () => ({ rows: [] })),
    update: vi.fn(async () => ({ user })),
    resetPassword: vi.fn(async () => ({})),
    tapPreflight: vi.fn(async () => ({ status: 'unsynced', lastSyncAt: null })),
    licenses: vi.fn(async () => ({ status: 'synced', licenses: [] })),
    unlock: vi.fn(async () => ({})),
    disable: vi.fn(async () => ({})),
    enable: vi.fn(async () => ({})),
    setAccountExpiry: vi.fn(async () => ({})),
    addGroup: vi.fn(async () => ({ ok: true })),
    removeGroup: vi.fn(async () => ({ ok: true })),
    copySource: vi.fn(async () => COPY_SOURCE),
    search: vi.fn(),
    previewAttributeEdit: vi.fn(),
  },
  bulkJobs: {
    startAttributeEdit: vi.fn(),
    get: vi.fn(),
    rows: vi.fn(async () => ({ rows: [] as unknown[] })),
  },
  directories: {
    naming: {
      get: vi.fn(async () => ({
        naming: { pattern: '{first}.{last}', upnSuffix: 'corp.test' },
        upnSuffixes: ['corp.test'],
      })),
      check: vi.fn(async () => ({ suggestions: [] })),
    },
    newUsers: {
      get: vi.fn(async () => ({
        newUsers: { mailFromUpn: true, passwordMode: 'random', phoneCountry: null },
      })),
    },
    policy: vi.fn(async () => ({ policy: null })),
  },
  ous: { list: vi.fn(async () => ({ ous: [] })) },
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
const { onShortcutKey, shortcuts } = await import('../design/composables/useShortcuts.js');

// Each page offers its shortcuts until it goes.
enableAutoUnmount(afterEach);

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
    attachTo: document.body,
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

  it('says on the Account tab which day the account works through', async () => {
    api.users.get.mockResolvedValue({
      user: aUserDetail({ accountExpiresAt: new Date(2031, 2, 2).toISOString() }),
    });
    const { page } = await openTab('account', ['read:user'], false);

    expect(page.text()).toContain(`At the end of ${new Date(2031, 2, 1).toLocaleDateString()}`);
  });
});

describe('shortcuts on a user’s page', () => {
  const ACTIONS = [
    'read:user',
    'write:user.unlock',
    'write:user.resetPassword',
    'write:user.enableDisable',
    'write:user.move',
  ];

  beforeAll(() => window.addEventListener('keydown', onShortcutKey));
  afterAll(() => window.removeEventListener('keydown', onShortcutKey));
  beforeEach(() => {
    vi.clearAllMocks();
    api.users.get.mockResolvedValue({ user });
  });

  async function press(key: string, target: EventTarget = document.body) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await flushPromises();
  }
  const listed = () =>
    shortcuts.value
      .filter((s) => s.section === 'Actions')
      .map((s) =>
        s.unavailable ? `${s.key} ${s.label} (${s.unavailable})` : `${s.key} ${s.label}`,
      );

  it('unlocks a locked account on u, after the step-up it prompts', async () => {
    api.users.get.mockResolvedValue({ user: aUserDetail({ locked: true }) });
    const { auth } = await openTab('overview', ACTIONS, false);

    await press('u');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.unlock).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.unlock).toHaveBeenCalledWith('u1');
  });

  it('won’t unlock an account that isn’t locked, and says so', async () => {
    const { auth } = await openTab('overview', ACTIONS, true);
    await press('u');
    expect(auth.stepUpRequested).toBe(false);
    expect(api.users.unlock).not.toHaveBeenCalled();
    expect(listed()).toEqual([
      'u Unlock account (account isn’t locked)',
      'r Reset password…',
      'e Disable account',
      'm Move to OU…',
    ]);
  });

  it('disables an enabled account on e, and enables a disabled one', async () => {
    const enabled = await openTab('overview', ACTIONS, true);
    await press('e');
    expect(api.users.disable).toHaveBeenCalledWith('u1');
    enabled.page.unmount();

    api.users.get.mockResolvedValue({ user: aUserDetail({ enabled: false }) });
    await openTab('overview', ACTIONS, true);
    await press('e');
    expect(api.users.enable).toHaveBeenCalledWith('u1');
  });

  it('opens the reset password dialog on r and Move to OU on m', async () => {
    const reset = await openTab('overview', ACTIONS, true);
    await press('r');
    expect(reset.page.find('#reset-new-password').exists()).toBe(true);
    reset.page.unmount();

    const move = await openTab('overview', ACTIONS, true);
    await press('m');
    expect(move.page.text()).toContain('Move to OU');
  });

  it('opens Issue TAP on t when the directory’s Entra integration offers it', async () => {
    const tapUser = aUserDetail({
      entra: {
        lastSignInAt: null,
        lastNonInteractiveSignInAt: null,
        lastStatus: null,
        mfa: null,
        temporaryAccessPass: true,
        licenses: false,
      },
    });
    api.users.get.mockResolvedValue({ user: tapUser });
    const { page } = await openTab('overview', [...ACTIONS, 'write:user.issueTap'], true);
    expect(listed()).toContain('t Issue Temporary Access Pass…');
    await press('t');
    expect(api.users.tapPreflight).toHaveBeenCalledWith('u1');
    expect(page.text()).toContain('isn’t in Microsoft Entra yet');
    page.unmount();

    api.users.get.mockResolvedValue({
      user: { ...tapUser, entra: { ...tapUser.entra!, temporaryAccessPass: false } },
    });
    await openTab('overview', [...ACTIONS, 'write:user.issueTap'], true);
    expect(listed()).not.toContain('t Issue Temporary Access Pass…');
  });

  it('shows the user’s licenses on their own tab when the Entra integration reads them', async () => {
    const entra = {
      lastSignInAt: null,
      lastNonInteractiveSignInAt: null,
      lastStatus: null,
      mfa: null,
      temporaryAccessPass: false,
      licenses: true,
    };
    api.users.get.mockResolvedValue({ user: aUserDetail({ entra }) });
    const { page } = await openTab('licenses', ['read:user'], false);
    expect(api.users.licenses).toHaveBeenCalledWith('u1');
    expect(page.text()).toContain('has no licenses');
    page.unmount();

    api.users.get.mockResolvedValue({
      user: aUserDetail({ entra: { ...entra, licenses: false } }),
    });
    const off = await openTab('licenses', ['read:user'], false);
    expect(off.page.find('[role="tablist"]').text()).not.toContain('Licenses');
    off.page.unmount();
  });

  it('offers only the actions the operator has the capability for', async () => {
    await openTab('overview', ['read:user', 'write:user.resetPassword'], true);
    expect(listed()).toEqual(['r Reset password…']);
    await press('e');
    expect(api.users.disable).not.toHaveBeenCalled();
  });

  it('ignores keys typed into a field', async () => {
    const { page } = await openTab('organization', [...ACTIONS, 'write:user.attributes'], true);
    await press('e', titleField(page).element);
    expect(api.users.disable).not.toHaveBeenCalled();
  });

  it('ignores keys while a dialog is open', async () => {
    const { page } = await openTab('overview', ACTIONS, true);
    await press('r');
    expect(page.find('#reset-new-password').exists()).toBe(true);
    await press('e');
    expect(api.users.disable).not.toHaveBeenCalled();
  });
});

describe('copying the user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.users.get.mockResolvedValue({ user });
  });

  const groupBox = (page: Page, name: string) =>
    page
      .findAll('[aria-label="Groups to add the copy to"] label')
      .find((l) => l.text() === name)!
      .find('input').element as HTMLInputElement;

  it('opens New user prefilled from this user, privileged groups unticked and flagged', async () => {
    const { page } = await openTab(
      'overview',
      ['read:user', 'write:user.create', 'write:group.membership'],
      true,
    );

    await runAction(page, 'Copy…');

    expect(api.users.copySource).toHaveBeenCalledWith('u1');
    const dialog = page.find('[role="dialog"]');
    expect(dialog.text()).toContain('Copy user');
    expect(dialog.text()).toContain('Organisation, from Jane Doe');
    expect((dialog.find('#nu-org-department').element as HTMLInputElement).value).toBe('Finance');
    expect((dialog.find('#nu-org-title').element as HTMLInputElement).value).toBe('Analyst');
    expect(dialog.text()).toContain('Max Boss');
    expect((dialog.find('#nu-first').element as HTMLInputElement).value).toBe('');
    expect(groupBox(page, 'Finance').checked).toBe(true);
    expect(groupBox(page, 'Domain Admins').checked).toBe(false);
    expect(dialog.text()).toContain('Administrative group');
  });

  it('shows the groups but can’t tick them without group membership rights', async () => {
    const { page } = await openTab('overview', ['read:user', 'write:user.create'], true);

    await runAction(page, 'Copy…');

    expect(page.find('[role="dialog"]').text()).toContain('You can’t change group memberships');
    expect(groupBox(page, 'Finance').disabled).toBe(true);
    expect(groupBox(page, 'Finance').checked).toBe(false);
  });

  it('says so, with no form, when this user can’t be loaded to copy', async () => {
    api.users.copySource.mockRejectedValueOnce(new ApiError(404, 'not_found', 'user not found'));
    const { page } = await openTab('overview', ['read:user', 'write:user.create'], true);

    await runAction(page, 'Copy…');

    const dialog = page.find('[role="dialog"]');
    expect(dialog.text()).toContain('user not found');
    expect(dialog.find('#nu-first').exists()).toBe(false);
  });

  it('isn’t offered without the create capability', async () => {
    const { page } = await openTab('overview', ['read:user', 'write:user.enableDisable'], true);

    await click(page, 'Actions');

    expect(page.findAll('[role="menuitem"]').map((i) => i.text())).not.toContain('Copy…');
  });
});

describe('reassigning the direct reports', () => {
  const MAX_ID = 'a0000000-0000-4000-8000-0000000000aa';
  const report = (id: string, displayName: string, enabled = true) => ({
    id,
    distinguishedName: `CN=${displayName},OU=Staff,DC=corp,DC=example`,
    displayName,
    enabled,
  });
  const manager = aUserDetail({
    directReports: [
      report('r-cat', 'Cat Cole'),
      report('r-ann', 'Ann Abbot'),
      report('r-ben', 'Ben Baker', false),
    ],
  });
  const managerChange = (id: string, name: string) => ({
    id,
    name,
    changes: [{ field: 'manager' as const, before: 'Jane Doe', after: 'Max Boss' }],
  });
  const aPreview = (more: Record<string, unknown> = {}) => ({
    current: {},
    changed: { count: 0, offset: 0, users: [] },
    unchanged: { count: 0, users: [] },
    unread: { count: 0, users: [] },
    skipped: { count: 0, users: [] },
    fields: [],
    unknownCount: 0,
    previewToken: 'tok',
    ...more,
  });
  const aJob = (counts: Record<string, number>) => ({
    id: '9',
    action: 'user.update',
    subject: { attributes: [{ field: 'manager', value: 'Max Boss' }] },
    status: 'finished',
    pauseReason: null,
    revertsJobId: null,
    revertible: false,
    revertedBy: null,
    actorDisplayName: 'OpenADUC Operator',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    counts: {
      total: 2,
      pending: 0,
      running: 0,
      succeeded: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      ...counts,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.users.get.mockResolvedValue({ user: manager });
    api.users.search.mockResolvedValue({
      rows: [{ id: MAX_ID, displayName: 'Max Boss', samAccountName: 'max.boss' }],
      total: 1,
    });
  });

  const dialog = (page: Page) => page.get('[role="dialog"]');
  const ticked = (page: Page) =>
    dialog(page)
      .findAll('li')
      .filter((li) => (li.find('input[type="checkbox"]').element as HTMLInputElement)?.checked)
      .map((li) => li.find('.rr-report-name').text());

  async function chooseNewManager(page: Page) {
    await dialog(page).get('input[aria-label="Search for the new manager"]').setValue('max');
    await new Promise((r) => setTimeout(r, 250));
    await flushPromises();
    await dialog(page)
      .findAll('button')
      .find((b) => b.text().includes('max.boss'))!
      .trigger('click');
  }

  it('moves only the ticked reports to the manager picked, after previewing each change', async () => {
    const { page, auth } = await openTab(
      'organization',
      ['read:user', 'write:user.attributes'],
      false,
    );

    await runAction(page, 'Reassign direct reports…');
    expect(ticked(page)).toEqual(['Ann Abbot', 'Ben Baker', 'Cat Cole']);
    const ben = dialog(page)
      .findAll('li')
      .find((li) => li.text().includes('Ben Baker'))!;
    expect(ben.text()).toContain('Disabled');

    await dialog(page).get('#rr-r-cat').trigger('change');
    expect(ticked(page)).toEqual(['Ann Abbot', 'Ben Baker']);
    await chooseNewManager(page);
    api.users.previewAttributeEdit.mockResolvedValueOnce(
      aPreview({
        changed: {
          count: 2,
          offset: 0,
          users: [managerChange('r-ann', 'Ann Abbot'), managerChange('r-ben', 'Ben Baker')],
        },
        fields: [{ field: 'manager', count: 2, unread: 0 }],
      }),
    );
    await click(page, 'Preview');

    expect(api.users.previewAttributeEdit).toHaveBeenCalledExactlyOnceWith({
      ids: ['r-ann', 'r-ben'],
      changes: { manager: MAX_ID },
    });
    const byUser = dialog(page).get('[aria-label="Changes by user"]').text();
    expect(byUser).toContain('Ann Abbot');
    expect(byUser).toContain('Ben Baker');
    expect(byUser).not.toContain('Cat Cole');
    expect(byUser).toContain('Jane Doe');
    expect(byUser).toContain('Max Boss');
    expect(api.bulkJobs.startAttributeEdit).not.toHaveBeenCalled();

    api.bulkJobs.startAttributeEdit.mockResolvedValueOnce({ job: aJob({ succeeded: 2 }) });
    await click(page, 'Reassign 2 reports');
    expect(auth.stepUpRequested).toBe(true);
    await auth.stepUp('pw');
    await flushPromises();

    expect(api.bulkJobs.startAttributeEdit).toHaveBeenCalledExactlyOnceWith({
      ids: ['r-ann', 'r-ben'],
      changes: { manager: MAX_ID },
      previewToken: 'tok',
    });
    // The page shows them gone.
    expect(api.users.get).toHaveBeenCalledTimes(2);
  });

  it('shows a report picked as the new manager as skipped in the preview', async () => {
    const { page } = await openTab('organization', ['read:user', 'write:user.attributes'], true);
    await runAction(page, 'Reassign direct reports…');
    await chooseNewManager(page);
    api.users.previewAttributeEdit.mockResolvedValueOnce(
      aPreview({
        changed: { count: 2, offset: 0, users: [managerChange('r-ann', 'Ann Abbot')] },
        skipped: {
          count: 1,
          users: [{ id: 'r-cat', name: 'Cat Cole', reason: 'would be their own manager' }],
        },
      }),
    );

    await click(page, 'Preview');

    expect(dialog(page).text()).toContain('Skipped (1)');
    expect(dialog(page).text()).toContain('Cat Cole: would be their own manager');
  });

  it('keeps a report the job couldn’t change ticked, with why', async () => {
    const { page } = await openTab('organization', ['read:user', 'write:user.attributes'], true);
    await runAction(page, 'Reassign direct reports…');
    await chooseNewManager(page);
    api.users.previewAttributeEdit.mockResolvedValueOnce(
      aPreview({ changed: { count: 3, offset: 0, users: [] } }),
    );
    await click(page, 'Preview');
    api.bulkJobs.startAttributeEdit.mockResolvedValueOnce({
      job: aJob({ total: 3, succeeded: 2, failed: 1 }),
    });
    api.bulkJobs.rows.mockResolvedValueOnce({
      rows: [{ targetId: 'r-ben', errorMessage: 'Access denied', errorCode: 'permission_denied' }],
    });

    await click(page, 'Reassign 3 reports');
    expect(page.text()).toContain('Edited 2 of 3 accounts (manager)');

    await runAction(page, 'Reassign direct reports…');
    expect(ticked(page)).toEqual(['Ben Baker']);
    expect(dialog(page).text()).toContain('Access denied');
  });

  it('leaves a running job on the manager’s page, and shows it again on coming back', async () => {
    const other = aUserDetail({ id: 'u2', displayName: 'Omar Other' });
    api.users.get.mockImplementation(async (id: string) => ({
      user: id === 'u2' ? other : manager,
    }));
    const { page, router } = await openTab(
      'organization',
      ['read:user', 'write:user.attributes'],
      true,
    );
    await runAction(page, 'Reassign direct reports…');
    await chooseNewManager(page);
    api.users.previewAttributeEdit.mockResolvedValueOnce(
      aPreview({ changed: { count: 3, offset: 0, users: [] } }),
    );
    await click(page, 'Preview');
    const running = { ...aJob({ total: 3, pending: 3 }), status: 'running', finishedAt: null };
    api.bulkJobs.startAttributeEdit.mockResolvedValueOnce({ job: running });
    await click(page, 'Reassign 3 reports');
    expect(page.text()).toContain('Editing 3 accounts (manager)…');

    await router.push('/users/u2?tab=organization');
    await flushPromises();
    expect(page.text()).toContain('Omar Other');
    expect(page.text()).not.toContain('Editing 3 accounts');

    api.bulkJobs.get.mockResolvedValue({ job: running });
    await router.push('/users/u1?tab=organization');
    await flushPromises();
    expect(api.bulkJobs.get).toHaveBeenCalledWith('9');
    expect(page.text()).toContain('Editing 3 accounts (manager)…');
  });

  it('says to sync when none of the reports is in the cache', async () => {
    api.users.get.mockResolvedValue({
      user: aUserDetail({
        directReports: [
          { id: null, distinguishedName: 'CN=Gone,DC=corp', displayName: null, enabled: null },
        ],
      }),
    });
    const { page } = await openTab('organization', ['read:user', 'write:user.attributes'], true);

    await runAction(page, 'Reassign direct reports…');

    expect(dialog(page).text()).toContain('isn’t in the cache, so it can’t be reassigned here');
    expect(dialog(page).text()).toContain('Run a directory sync');
  });

  it('is offered from the reporting structure too', async () => {
    const { page } = await openTab('organization', ['read:user', 'write:user.attributes'], true);

    await click(page, 'Reassign…');

    expect(dialog(page).text()).toContain('Jane Doe’s direct reports');
  });

  it('isn’t offered without the attribute-write capability, nor for a user with no reports', async () => {
    const readOnly = await openTab('organization', ['read:user', 'write:user.move'], true);
    await click(readOnly.page, 'Actions');
    expect(readOnly.page.findAll('[role="menuitem"]').map((i) => i.text())).not.toContain(
      'Reassign direct reports…',
    );
    expect(readOnly.page.findAll('button').map((b) => b.text())).not.toContain('Reassign…');
    readOnly.page.unmount();

    api.users.get.mockResolvedValue({ user: aUserDetail() });
    const noReports = await openTab(
      'organization',
      ['read:user', 'write:user.attributes', 'write:user.move'],
      true,
    );
    await click(noReports.page, 'Actions');
    expect(noReports.page.findAll('[role="menuitem"]').map((i) => i.text())).not.toContain(
      'Reassign direct reports…',
    );
  });
});
