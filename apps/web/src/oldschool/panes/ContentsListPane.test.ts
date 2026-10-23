// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const STAFF = 'OU=Staff,DC=corp,DC=example';
const api = {
  ous: {
    contents: vi.fn(async () => ({
      users: [
        {
          id: 'u1',
          samAccountName: 'jdoe',
          displayName: 'Jane Doe',
          email: null,
          enabled: true,
          locked: false,
        },
      ],
      groups: [],
      computers: [],
    })),
  },
  users: { disable: vi.fn(async () => ({})), enable: vi.fn(async () => ({})) },
};
vi.mock('../../api/index.js', () => ({ api }));
const toast = { add: vi.fn() };
vi.mock('primevue/usetoast', () => ({ useToast: () => toast }));

const { default: ContentsListPane } = await import('./ContentsListPane.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

enableAutoUnmount(afterEach);

async function openStaff(capabilities = ['read:user', 'write:user.enableDisable']) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities,
    elevated: {
      active: true,
      idleExpiresAt: '2999-01-01T00:15:00.000Z',
      absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
    },
  } as never;
  const oldSchool = useOldSchool();
  oldSchool.selectNode({ kind: 'ou', dn: STAFF, label: 'Staff' });
  const pane = mount(ContentsListPane, {
    attachTo: document.body,
    global: { plugins: [pinia, PrimeVue] },
  });
  await flushPromises();
  return { pane, oldSchool };
}

async function choose(pane: Awaited<ReturnType<typeof openStaff>>['pane'], label: string) {
  await pane.get('.os-list-row').trigger('contextmenu');
  await pane
    .findAll('[role="menuitem"]')
    .find((i) => i.text() === label)!
    .trigger('click');
  await new Promise((r) => setTimeout(r, 0));
  await flushPromises();
}

describe('the Old School contents list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disables an account at once, and the toast’s Undo enables it again', async () => {
    const { pane } = await openStaff();

    await choose(pane, 'Disable Account');
    expect(api.users.disable).toHaveBeenCalledWith('u1');
    const done = toast.add.mock.calls.at(-1)![0] as { summary: string; undo: () => void };
    expect(done.summary).toBe('Object "Jane Doe" has been disabled.');

    done.undo();
    await flushPromises();
    expect(api.users.enable).toHaveBeenCalledWith('u1');
  });

  it('says in a message box why an account couldn’t be disabled', async () => {
    api.users.disable.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    const { pane, oldSchool } = await openStaff();

    await choose(pane, 'Disable Account');
    expect(oldSchool.windows.at(-1)!.dialog).toEqual({
      kind: 'message',
      title: 'Active Directory Domain Services',
      message: 'Windows cannot disable object Jane Doe because:\nDC unreachable',
    });
  });
});

describe('a group in the Old School contents list', () => {
  const engineering = {
    id: 'g1',
    name: 'Engineering',
    samAccountName: 'engineering',
    description: null,
    groupType: 'security',
    groupScope: 'global',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.ous.contents.mockResolvedValueOnce({
      users: [],
      groups: [engineering],
      computers: [],
    } as never);
  });

  it('opens the delete prompt for operators who may delete groups', async () => {
    const { pane, oldSchool } = await openStaff(['read:group', 'write:group.delete']);

    await choose(pane, 'Delete');

    expect(oldSchool.windows.at(-1)!.dialog).toEqual({
      kind: 'delete-group',
      id: 'g1',
      label: 'Engineering',
    });
  });

  it('keeps Delete disabled for everyone else', async () => {
    const { pane, oldSchool } = await openStaff(['read:group']);

    await choose(pane, 'Delete');

    expect(oldSchool.windows).toEqual([]);
  });
});
