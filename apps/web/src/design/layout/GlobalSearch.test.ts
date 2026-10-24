// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import { h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDetail } from '@openaduc/shared';
import { aUserDetail } from '../../test/userDetail.js';
import { ApiError } from '../../api/client.js';
import { atPhoneWidth } from '../../test/viewport.js';

const salesUsers = async () => ({
  rows: [
    { id: 'u1', displayName: 'Sam Sales', samAccountName: 'ssales', email: null },
    { id: 'u2', displayName: 'Sally Salt', samAccountName: 'ssalt', email: null },
  ],
});

const inFifteenMinutes = () => new Date(Date.now() + 15 * 60_000).toISOString();
const ELEVATED = () => ({
  active: true,
  idleExpiresAt: inFifteenMinutes(),
  absoluteExpiresAt: inFifteenMinutes(),
});
const NOT_ELEVATED = { active: false, idleExpiresAt: null, absoluteExpiresAt: null };

const api = {
  users: {
    search: vi.fn(salesUsers),
    get: vi.fn(),
    unlock: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    resetPassword: vi.fn(),
  },
  groups: {
    search: vi.fn(async () => ({
      rows: [{ id: 'g1', name: 'Sales Team', description: null, memberCount: 3 }],
    })),
  },
  computers: {
    search: vi.fn(async () => ({
      rows: [{ id: 'c1', name: 'SALES-PC01', dnsHostName: 'sales-pc01.corp.example' }],
    })),
  },
  ous: {
    list: vi.fn(async () => ({
      ous: [
        { distinguishedName: 'OU=Corp,DC=corp,DC=example', name: 'Corp', parentDn: null },
        {
          distinguishedName: 'OU=Sales,OU=Corp,DC=corp,DC=example',
          name: 'Sales',
          parentDn: 'OU=Corp,DC=corp,DC=example',
        },
        {
          distinguishedName: 'OU=Sales Team,OU=Sales\\, East,DC=corp,DC=example',
          name: 'Sales Team',
          parentDn: 'OU=Sales\\, East,DC=corp,DC=example',
        },
      ],
    })),
  },
  directories: { policy: vi.fn(async () => Promise.reject(new Error('no policy'))) },
  auth: { stepUp: vi.fn(async () => ({ elevated: ELEVATED() })) },
};
vi.mock('../../api/index.js', () => ({ api }));

const { default: GlobalSearch } = await import('./GlobalSearch.vue');
const { useAuthStore } = await import('../../stores/auth.js');

async function searchFor(text: string, capabilities: string[], elevated = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  // Only capabilities and elevation matter here.
  auth.actor = { capabilities, elevated: elevated ? ELEVATED() : NOT_ELEVATED } as never;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:any(.*)*', component: { render: () => h('p') } }],
  });
  await router.push('/');
  const search = mount(GlobalSearch, {
    global: { plugins: [pinia, router, PrimeVue, ToastService], stubs: { teleport: true } },
  });
  await search.find('.gs-trigger').trigger('click');
  await type(search, text);
  return { search, router, auth };
}

async function type(search: VueWrapper, text: string) {
  await search.find('input').setValue(text);
  await vi.advanceTimersByTimeAsync(250);
  await flushPromises();
}

const ALL = ['read:user', 'read:group', 'read:computer'];

describe('quick search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.users.search.mockImplementation(salesUsers);
  });
  afterEach(() => vi.useRealTimers());

  it('groups results by type', async () => {
    const { search } = await searchFor('sal', ALL);
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Users', 'Groups', 'Computers', 'OUs']);
    expect(search.text()).toContain('SALES-PC01');
    // OU names match on the name, not the rest of the DN; the path under
    // each reads outermost first, with DN escapes undone.
    const ous = search.findAll('.gs-group')[3]!;
    expect(ous.findAll('.gs-row-primary').map((r) => r.text())).toEqual(['Sales', 'Sales Team']);
    expect(ous.findAll('.gs-row-secondary').map((r) => r.text())).toEqual([
      'corp.example / Corp',
      'corp.example / Sales, East',
    ]);
  });

  it('searches only what the operator can read', async () => {
    const { search } = await searchFor('sal', ['read:user']);
    expect(api.computers.search).not.toHaveBeenCalled();
    expect(api.groups.search).not.toHaveBeenCalled();
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Users', 'OUs']);
  });

  it('leaves out OUs, like users, for operators who cannot read users', async () => {
    const { search } = await searchFor('sal', ['read:computer']);
    expect(api.users.search).not.toHaveBeenCalled();
    expect(api.ous.list).not.toHaveBeenCalled();
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Computers']);
  });

  it('keeps the other results when one kind fails, and says which', async () => {
    api.computers.search.mockRejectedValueOnce(new Error('boom'));
    const { search } = await searchFor('sal', ALL);
    const labels = search.findAll('.gs-group-label').map((l) => l.text());
    expect(labels).toEqual(['Users', 'Groups', 'OUs']);
    expect(search.find('.gs-failed').text()).toBe("Couldn't search Computers.");
  });

  it('says the search failed rather than that nothing matched', async () => {
    api.users.search.mockRejectedValueOnce(new Error('boom'));
    api.ous.list.mockRejectedValueOnce(new Error('boom'));
    const { search } = await searchFor('sal', ['read:user']);
    expect(search.text()).toContain("Couldn't search Users or OUs.");
    expect(search.text()).not.toContain('No matches');
  });

  it('moves across groups with the arrow keys and opens the highlighted result', async () => {
    const { search, router } = await searchFor('sal', ALL);
    const input = search.find('input');
    // Two users, then the group, then the computer.
    for (let i = 0; i < 3; i++) await input.trigger('keydown', { key: 'ArrowDown' });
    expect(search.find('.gs-row.active').text()).toContain('SALES-PC01');

    await input.trigger('keydown', { key: 'ArrowUp' });
    expect(search.find('.gs-row.active').text()).toContain('Sales Team');

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/groups/g1');
  });

  it('walks on into the OUs, stops at the last result, and opens it', async () => {
    const { search, router } = await searchFor('sal', ALL);
    const input = search.find('input');
    for (let i = 0; i < 9; i++) await input.trigger('keydown', { key: 'ArrowDown' });
    expect(search.find('.gs-row.active').text()).toContain('Sales Team');

    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/browse');
    expect(router.currentRoute.value.query.ou).toBe(
      'OU=Sales Team,OU=Sales\\, East,DC=corp,DC=example',
    );
  });

  it('fetches the OU list once per opening, however the text changes', async () => {
    const { search } = await searchFor('sal', ALL);
    const input = search.find('input');
    for (const text of ['s', 'sa', 'sales']) {
      await input.setValue(text);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(api.ous.list).toHaveBeenCalledOnce();

    await search.find('.gs-close').trigger('click');
    await search.find('.gs-trigger').trigger('click');
    await search.find('input').setValue('sal');
    await vi.advanceTimersByTimeAsync(250);
    expect(api.ous.list).toHaveBeenCalledTimes(2);
  });

  it('drops a search that answers after the panel closed', async () => {
    let answer!: (v: unknown) => void;
    api.users.search.mockImplementationOnce(() => new Promise((r) => (answer = r)) as never);
    const { search, router } = await searchFor('sam', ['read:user']);
    await search.find('.gs-close').trigger('click');
    answer({ rows: [{ id: 'u9', displayName: 'Late Larry', samAccountName: 'll', email: null }] });
    await flushPromises();

    // Reopened and empty, Enter has nothing to open.
    await search.find('.gs-trigger').trigger('click');
    await search.find('input').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/');
  });

  it('opens the OU browser at a picked OU', async () => {
    const { search, router } = await searchFor('sal', ALL);
    const ou = search.findAll('.gs-group')[3]!.find('.gs-row');
    await ou.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/browse');
    expect(router.currentRoute.value.query.ou).toBe('OU=Sales,OU=Corp,DC=corp,DC=example');
  });
});

const WRITES = ['write:user.unlock', 'write:user.resetPassword', 'write:user.enableDisable'];
const OPERATOR = ['read:user', ...WRITES];

const jane = aUserDetail({
  id: 'u1',
  displayName: 'Jane Doe',
  samAccountName: 'jdoe',
  locked: true,
});
const john = aUserDetail({ id: 'u2', displayName: 'John Doe', samAccountName: 'jodoe' });
const jim = aUserDetail({
  id: 'u3',
  displayName: 'Jim Doe',
  samAccountName: 'jidoe',
  enabled: false,
});

// The directory as the API sees it: searches match names, reads return the
// account, and writes change it.
function directory(...users: UserDetail[]) {
  const state = new Map(users.map((u) => [u.id, u]));
  const change = (id: string, patch: Partial<UserDetail>) =>
    state.set(id, { ...state.get(id)!, ...patch });
  api.users.search.mockImplementation((async ({ q }: { q: string }) => ({
    rows: [...state.values()].filter((u) =>
      [u.displayName, u.samAccountName].some((n) => n?.toLowerCase().includes(q.toLowerCase())),
    ),
  })) as never);
  api.users.get.mockImplementation(async (id: string) => ({ user: state.get(id) }));
  api.users.unlock.mockImplementation(async (id: string) => change(id, { locked: false }));
  api.users.enable.mockImplementation(async (id: string) => change(id, { enabled: true }));
  api.users.disable.mockImplementation(async (id: string) => change(id, { enabled: false }));
  api.users.resetPassword.mockImplementation(async (id: string) =>
    change(id, { passwordMustChange: true }),
  );
}

type Search = Awaited<ReturnType<typeof searchFor>>['search'];

const rowOf = (search: Search, name: string) => {
  const row = search.findAll('.gs-row').find((r) => r.find('.gs-row-primary').text() === name);
  expect(row, name).toBeDefined();
  return row!;
};
const actionsOn = (search: Search, name: string) =>
  rowOf(search, name)
    .findAll('.gs-action')
    .map((b) => b.text());
const selected = (search: Search) => search.find('.gs-action.selected');
const footer = (search: Search) => search.find('.gs-foot').text();
const announced = (search: Search) => search.find('[aria-live="polite"]').text();

async function press(search: Search, key: string, init: KeyboardEventInit = {}) {
  await search.find('input').trigger('keydown', { key, ...init });
  await flushPromises();
}

async function click(search: Search, label: string, within: Search | DOMWrapper<Element> = search) {
  const button = within.findAll('button').find((b) => b.text() === label);
  expect(button, label).toBeDefined();
  await button!.trigger('click');
  await flushPromises();
}

describe('quick search actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    directory(jane, john, jim);
  });
  afterEach(() => vi.useRealTimers());

  it('reads a leading verb as that action on the users the rest of the query finds', async () => {
    const { search } = await searchFor('  Unlock   doe ', [...OPERATOR, 'read:group']);

    expect(api.users.search).toHaveBeenCalledExactlyOnceWith({ q: 'doe', pageSize: 6 });
    expect(api.groups.search).not.toHaveBeenCalled();
    expect(api.ous.list).not.toHaveBeenCalled();
    expect(search.find('.gs-verb').text()).toBe('unlock');
    expect(actionsOn(search, 'Jane Doe')).toEqual(['Unlock account']);
    expect(actionsOn(search, 'John Doe')).toEqual([]);
    expect(rowOf(search, 'John Doe').text()).toContain('Not locked');
  });

  it('asks for a name after a verb alone, and says which verbs act and how to skip them', async () => {
    const { search } = await searchFor('', OPERATOR);
    expect(search.text()).toContain('Start with unlock, reset, pw, enable or disable');
    expect(search.text()).toContain('Start with " to search for those words as written.');

    await type(search, 'unlock ');
    expect(api.users.search).not.toHaveBeenCalled();
    expect(search.text()).toContain('Type the name of a user to unlock.');
    expect(announced(search)).toBe('Type the name of a user to unlock.');

    await type(search, 'pw');
    expect(search.find('.gs-verb').text()).toBe('reset password');
    expect(search.text()).toContain('Type the name of a user to give a new password.');
  });

  it('searches a quoted query as written', async () => {
    const { search } = await searchFor('"unlock jane', OPERATOR);

    expect(api.users.search).toHaveBeenCalledExactlyOnceWith({ q: 'unlock jane', pageSize: 6 });
    expect(search.find('.gs-verb').exists()).toBe(false);
  });

  it('searches for a verb the operator can’t perform as written', async () => {
    const { search } = await searchFor('unlock doe', ['read:user', 'write:user.resetPassword']);

    expect(api.users.search).toHaveBeenCalledExactlyOnceWith({ q: 'unlock doe', pageSize: 6 });
    expect(search.find('.gs-verb').exists()).toBe(false);
    await type(search, '');
    expect(search.text()).toContain('Start with reset or pw to act on a user.');
  });

  it('unlocks on Enter after the step-up it prompts, with the user page’s call', async () => {
    const { search, auth } = await searchFor('unlock jane', OPERATOR, false);
    expect(selected(search).text()).toBe('Unlock account');
    expect(footer(search)).toContain('↵ unlock');
    expect(announced(search)).toBe('Unlock account, Jane Doe. Press Enter.');

    await press(search, 'Enter');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.unlock).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    // The same call the user's page makes, so it's audited the same way.
    expect(api.users.unlock).toHaveBeenCalledExactlyOnceWith('u1');
    expect(search.text()).toContain('Unlocked Jane Doe');
    // Still open, with Jane read again.
    expect(rowOf(search, 'Jane Doe').text()).toContain('Not locked');
    expect(actionsOn(search, 'Jane Doe')).toEqual([]);
  });

  it('retries after the step-up the server asks for when the session ended meanwhile', async () => {
    api.users.disable.mockRejectedValueOnce(
      new ApiError(403, 'step_up_required', 'Step-up required'),
    );
    const { search, auth } = await searchFor('disable john', OPERATOR);

    await press(search, 'Enter');
    expect(api.users.disable).toHaveBeenCalledOnce();
    expect(search.text()).not.toContain('Couldn’t disable');

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.disable).toHaveBeenCalledTimes(2);
    expect(search.text()).toContain('Disabled John Doe');
  });

  it('offers Undo on the toast, which makes the inverse write', async () => {
    const { search } = await searchFor('disable john', OPERATOR);

    await press(search, 'Enter');
    expect(api.users.disable).toHaveBeenCalledExactlyOnceWith('u2');
    await click(search, 'Undo');
    expect(api.users.enable).toHaveBeenCalledExactlyOnceWith('u2');
    expect(search.text()).toContain('Enabled John Doe');
  });

  it('opens the reset password dialog for reset, and resets after step-up', async () => {
    const { search, auth } = await searchFor('reset john', OPERATOR, false);

    await press(search, 'Enter');
    expect(auth.stepUpRequested).toBe(false);
    expect(search.text()).toContain('Set a new password for John Doe');
    await search.get('#reset-new-password').setValue('N3w-passw0rd!');
    await click(search, 'Reset');
    expect(auth.stepUpRequested).toBe(true);

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.resetPassword).toHaveBeenCalledExactlyOnceWith('u2', {
      newPassword: 'N3w-passw0rd!',
      forceChangeAtNextLogin: true,
      unlock: false,
    });
    expect(search.find('#reset-new-password').exists()).toBe(false);
    expect(search.text()).toContain('Password reset');
  });

  it('offers a highlighted user the actions that fit, the fix first, on → or Tab', async () => {
    const { search } = await searchFor('doe', OPERATOR);
    // Only the highlighted user shows its actions, none chosen until asked.
    expect(actionsOn(search, 'Jane Doe')).toEqual([
      'Unlock account',
      'Reset password…',
      'Disable account',
    ]);
    expect(actionsOn(search, 'John Doe')).toEqual([]);
    expect(selected(search).exists()).toBe(false);
    expect(footer(search)).toContain('→ / tab actions');
    expect(footer(search)).toContain('↵ open');

    await press(search, 'ArrowRight');
    expect(selected(search).text()).toBe('Unlock account');
    await press(search, 'ArrowRight');
    expect(selected(search).text()).toBe('Reset password…');
    expect(footer(search)).toContain('↵ reset password');
    expect(footer(search)).toContain('esc back');
    await press(search, 'Tab', { shiftKey: true });
    expect(selected(search).exists()).toBe(false);

    // Esc backs out of the actions before it closes the panel.
    await press(search, 'Tab');
    expect(selected(search).text()).toBe('Unlock account');
    await press(search, 'Escape');
    expect(selected(search).exists()).toBe(false);
    expect(search.find('.gs-panel').exists()).toBe(true);

    await press(search, 'ArrowDown');
    await press(search, 'ArrowDown');
    await press(search, 'Tab');
    expect(actionsOn(search, 'Jim Doe')).toEqual(['Enable account', 'Reset password…']);
    await press(search, 'Enter');
    expect(api.users.enable).toHaveBeenCalledExactlyOnceWith('u3');
  });

  // Nothing hovers on a phone, and tapping a row opens the user's page.
  it('offers every user its actions at phone width', async () => {
    atPhoneWidth();
    const { search } = await searchFor('doe', OPERATOR);

    expect(actionsOn(search, 'John Doe')).toEqual(['Reset password…', 'Disable account']);
    expect(actionsOn(search, 'Jim Doe')).toEqual(['Enable account', 'Reset password…']);
    await rowOf(search, 'Jim Doe')
      .findAll('.gs-action')
      .find((a) => a.text() === 'Enable account')!
      .trigger('click');
    await flushPromises();
    expect(api.users.enable).toHaveBeenCalledExactlyOnceWith('u3');
  });

  it('is a combobox over a listbox, its actions options of their own', async () => {
    const { search } = await searchFor('doe', OPERATOR);
    const input = () => search.find('input');
    const listbox = search.find('[role="listbox"]');
    expect(input().attributes('role')).toBe('combobox');
    expect(input().attributes('aria-expanded')).toBe('true');
    expect(input().attributes('aria-controls')).toBe(listbox.attributes('id'));
    const active = () =>
      search.find(`#${CSS.escape(input().attributes('aria-activedescendant')!)}`);
    expect(active().text()).toContain('Jane Doe');
    expect(active().attributes('role')).toBe('option');

    await press(search, 'ArrowRight');
    expect(active().attributes('aria-label')).toBe('Unlock account, Jane Doe');
    expect(active().attributes('aria-selected')).toBe('true');
    // No option holds another control.
    for (const option of search.findAll('[role="option"]')) {
      expect(option.findAll('button, [role="option"]')).toHaveLength(0);
    }
  });

  it('leaves Tab to leave the box once in the actions, or where there are none', async () => {
    const { search } = await searchFor('unlock doe', OPERATOR);
    const tab = async () => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
      search.find('input').element.dispatchEvent(e);
      await flushPromises();
      return e.defaultPrevented;
    };

    // Unlock is already selected for Jane; John has nothing to offer.
    expect(await tab()).toBe(false);
    await press(search, 'ArrowDown');
    expect(await tab()).toBe(false);
  });

  it('leaves → to the text while the caret isn’t at its end', async () => {
    const { search } = await searchFor('doe', OPERATOR);
    (search.find('input').element as HTMLInputElement).setSelectionRange(0, 0);

    await press(search, 'ArrowRight');
    expect(selected(search).exists()).toBe(false);
  });

  it('offers only what the operator may do', async () => {
    const { search } = await searchFor('doe', ['read:user', 'write:user.unlock']);

    await press(search, 'Tab');
    expect(actionsOn(search, 'Jane Doe')).toEqual(['Unlock account']);
    await press(search, 'Escape');
    await press(search, 'ArrowDown');
    expect(footer(search)).not.toContain('actions');
    await press(search, 'Tab');
    expect(actionsOn(search, 'John Doe')).toEqual([]);
  });

  it('offers no actions to an operator who can’t write', async () => {
    const { search } = await searchFor('doe', ['read:user']);

    await press(search, 'Tab');
    expect(search.findAll('.gs-action')).toHaveLength(0);
    await press(search, 'Enter');
    expect(api.users.unlock).not.toHaveBeenCalled();
  });

  it('runs an action clicked on a row, keeping focus in the search box', async () => {
    const { search } = await searchFor('doe', OPERATOR);

    await rowOf(search, 'John Doe').trigger('mouseenter');
    const disable = rowOf(search, 'John Doe')
      .findAll('.gs-action')
      .find((a) => a.text() === 'Disable account')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    disable.element.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await disable.trigger('click');
    await flushPromises();
    expect(api.users.disable).toHaveBeenCalledExactlyOnceWith('u2');
  });

  it('waits for the results of what was typed before Enter acts', async () => {
    const { search } = await searchFor('disable jane', OPERATOR);
    expect(selected(search).text()).toBe('Disable account');

    // Within the debounce, the results are still Jane's.
    await search.find('input').setValue('disable john');
    await press(search, 'Enter');
    expect(api.users.disable).not.toHaveBeenCalled();
    // Enter sent the search at once.
    expect(api.users.search).toHaveBeenLastCalledWith({ q: 'john', pageSize: 6 });

    await press(search, 'Enter');
    expect(api.users.disable).toHaveBeenCalledExactlyOnceWith('u2');
  });

  it('waits while a search for the new text is still answering', async () => {
    const { search } = await searchFor('disable jane', OPERATOR);
    let answer!: () => void;
    const searchDirectory = api.users.search.getMockImplementation() as (q: unknown) => unknown;
    api.users.search.mockImplementationOnce((async (q: unknown) => {
      await new Promise<void>((r) => (answer = r));
      return searchDirectory(q);
    }) as never);
    await type(search, 'disable john');
    expect(search.find('.gs-row-primary').text()).toBe('Jane Doe');

    await press(search, 'Enter');
    expect(api.users.disable).not.toHaveBeenCalled();
    expect(announced(search)).toBe(
      'Still searching for “john”. Press Enter again once the results show.',
    );

    answer();
    await flushPromises();
    expect(search.text()).not.toContain('Still searching');
    await press(search, 'Enter');
    expect(api.users.disable).toHaveBeenCalledExactlyOnceWith('u2');
  });

  it('ignores a held Enter', async () => {
    const { search } = await searchFor('disable john', OPERATOR);

    await press(search, 'Enter', { repeat: true });
    expect(api.users.disable).not.toHaveBeenCalled();
  });

  it('keeps the highlight on the user acted on, wherever it has moved since', async () => {
    let finish!: () => void;
    api.users.unlock.mockImplementationOnce(
      async () => new Promise<void>((r) => (finish = r)) as never,
    );
    const { search } = await searchFor('doe', OPERATOR);
    await press(search, 'Tab');
    await press(search, 'Enter');

    await press(search, 'ArrowDown');
    await press(search, 'ArrowDown');
    finish();
    await flushPromises();
    expect(search.find('.gs-row.active').text()).toContain('Jane Doe');
  });

  it('keeps a failure in the panel, flagged on the trigger while closed, until retried', async () => {
    api.users.unlock.mockRejectedValueOnce(new Error('DC unreachable'));
    const { search } = await searchFor('unlock jane', OPERATOR);

    await press(search, 'Enter');
    const failure = search.find('.gs-failure');
    expect(failure.text()).toContain('Couldn’t unlock Jane Doe');
    expect(failure.text()).toContain('DC unreachable');

    await press(search, 'Escape');
    expect(search.find('.gs-trigger-failed').exists()).toBe(true);
    expect(search.find('.gs-trigger').attributes('aria-label')).toBe(
      'Search the directory. An action from quick search failed.',
    );
    await search.find('.gs-trigger').trigger('click');
    await click(search, 'Retry', search.find('.gs-failure'));
    expect(api.users.unlock).toHaveBeenCalledTimes(2);
    expect(search.find('.gs-failure').exists()).toBe(false);
    expect(search.find('.gs-trigger-failed').exists()).toBe(false);
    expect(search.find('.gs-trigger').attributes('aria-label')).toBe('Search the directory');
  });
});
