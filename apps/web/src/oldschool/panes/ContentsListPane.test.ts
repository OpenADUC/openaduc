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
    list: vi.fn(async () => ({ ous: [] as unknown[] })),
    contents: vi.fn(async () => ({
      users: [
        {
          id: 'u1',
          samAccountName: 'jdoe',
          displayName: 'Jane Doe',
          email: null,
          description: null,
          enabled: true,
          locked: false,
        },
      ],
      groups: [],
      computers: [],
    })),
  },
  users: { disable: vi.fn(async () => ({})), enable: vi.fn(async () => ({})) },
  computers: { disable: vi.fn(async () => ({})), enable: vi.fn(async () => ({})) },
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

  it('copies a user into Copy Object - User, for operators who may create users', async () => {
    const { pane, oldSchool } = await openStaff(['read:user', 'write:user.create']);

    await choose(pane, 'Copy…');

    expect(oldSchool.windows.at(-1)!.dialog).toEqual({ kind: 'copy-user', id: 'u1' });
  });

  it('greys out Copy for operators who may not create users', async () => {
    const { pane } = await openStaff();

    await pane.get('.os-list-row').trigger('contextmenu');
    const copy = pane.findAll('[role="menuitem"]').find((i) => i.text() === 'Copy…');
    expect(copy?.classes()).toContain('disabled');
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

describe('a computer in the Old School contents list', () => {
  const ws01 = {
    id: 'c1',
    name: 'WS01',
    samAccountName: 'WS01$',
    dnsHostName: null,
    operatingSystem: null,
    enabled: true,
    writeBlock: null,
  };
  const ALL = [
    'read:computer',
    'write:computer.enableDisable',
    'write:computer.resetAccount',
    'write:computer.move',
  ];
  const menu = async (pane: Awaited<ReturnType<typeof openStaff>>['pane']) => {
    await pane.get('.os-list-row').trigger('contextmenu');
    return pane.findAll('[role="menuitem"]');
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.ous.contents.mockResolvedValueOnce({ users: [], groups: [], computers: [ws01] } as never);
  });

  it('disables the computer at once, and the toast’s Undo enables it again', async () => {
    const { pane } = await openStaff(ALL);

    await choose(pane, 'Disable Account');
    expect(api.computers.disable).toHaveBeenCalledWith('c1');
    const done = toast.add.mock.calls.at(-1)![0] as { summary: string; undo: () => void };
    expect(done.summary).toBe('Object "WS01" has been disabled.');

    done.undo();
    await flushPromises();
    expect(api.computers.enable).toHaveBeenCalledWith('c1');
    expect(api.users.enable).not.toHaveBeenCalled();
  });

  it('opens the reset prompt and the move dialog', async () => {
    const { pane, oldSchool } = await openStaff(ALL);

    await choose(pane, 'Reset Account');
    await choose(pane, 'Move…');

    expect(oldSchool.windows.map((w) => w.dialog)).toEqual([
      { kind: 'reset-computer', id: 'c1', label: 'WS01' },
      { kind: 'move', accountKind: 'computer', id: 'c1', label: 'WS01' },
    ]);
  });

  it('leaves out what the operator may not do', async () => {
    const { pane } = await openStaff(['read:computer']);

    const labels = (await menu(pane)).map((i) => i.text());
    for (const label of ['Disable Account', 'Reset Account', 'Move…']) {
      expect(labels, label).not.toContain(label);
    }
  });

  it('greys out disable, reset and move on a domain controller', async () => {
    api.ous.contents.mockReset();
    api.ous.contents.mockResolvedValueOnce({
      users: [],
      groups: [],
      computers: [{ ...ws01, name: 'DC1', writeBlock: 'domain_controller' }],
    } as never);
    const { pane } = await openStaff(ALL);

    const items = await menu(pane);
    for (const label of ['Disable Account', 'Reset Account', 'Move…']) {
      expect(items.find((i) => i.text() === label)?.classes(), label).toContain('disabled');
    }
  });
});

describe('a container in the Old School contents list', () => {
  const ou = (name: string, parent: string, description: string | null = null) => ({
    distinguishedName: `OU=${name},${parent}`,
    name,
    parentDn: parent,
    description,
    stale: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.ous.list.mockResolvedValue({
      ous: [
        ou('Staff', 'DC=corp,DC=example'),
        ou('Interns', STAFF, 'Summer intake'),
        ou('Contractors', STAFF),
      ],
    });
  });

  async function openStaffTree() {
    const opened = await openStaff();
    await opened.oldSchool.loadTree();
    await flushPromises();
    return opened;
  }

  const listed = (pane: Awaited<ReturnType<typeof openStaff>>['pane']) =>
    pane.findAll('.os-list-row').map((r) => r.findAll('td').map((td) => td.text()));

  it('lists its sub-OUs above its objects, with their descriptions', async () => {
    const { pane } = await openStaffTree();

    expect(listed(pane)).toEqual([
      ['Contractors', 'Organizational Unit', ''],
      ['Interns', 'Organizational Unit', 'Summer intake'],
      ['Jane Doe', 'User', ''],
    ]);
    await pane.findAll('th')[0]!.trigger('click');
    expect(listed(pane).map(([name]) => name)).toEqual(['Interns', 'Contractors', 'Jane Doe']);
  });

  it('opens a sub-OU on double-click', async () => {
    const { pane, oldSchool } = await openStaffTree();

    await pane.findAll('.os-list-row')[1]!.trigger('dblclick');

    expect(oldSchool.selectedNode).toEqual({
      kind: 'ou',
      dn: `OU=Interns,${STAFF}`,
      label: 'Interns',
    });
  });

  it('lists its sub-OUs while its objects load, and after they fail', async () => {
    api.ous.contents.mockReturnValueOnce(new Promise(() => {}) as never);
    const { pane } = await openStaffTree();

    expect(listed(pane).map(([name]) => name)).toEqual(['Contractors', 'Interns']);
    expect(pane.get('.os-list-status').text()).toBe('Loading…');

    api.ous.contents.mockRejectedValueOnce(
      new ApiError(503, 'directory_unavailable', 'AD is down'),
    );
    const { pane: failed } = await openStaffTree();

    expect(listed(failed).map(([name]) => name)).toEqual(['Contractors', 'Interns']);
    expect(failed.get('.os-error').text()).toBe('AD is down');
  });

  it('lists the domain’s containers and top-level OUs', async () => {
    const { pane, oldSchool } = await openStaffTree();

    oldSchool.selectNode({ kind: 'domain', dn: 'DC=corp,DC=example', label: 'corp.example' });
    await flushPromises();

    expect(listed(pane).map(([name, type]) => `${name}: ${type}`)).toEqual([
      'Builtin: builtinDomain',
      'Computers: Container',
      'ForeignSecurityPrincipals: Container',
      'Managed Service Accounts: Container',
      'Staff: Organizational Unit',
      'Users: Container',
      'Jane Doe: User',
    ]);
  });
});

describe('the Description column', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows an object’s description, not its email', async () => {
    api.ous.contents.mockResolvedValueOnce({
      users: [
        {
          id: 'u1',
          samAccountName: 'jdoe',
          displayName: 'Jane Doe',
          email: 'jane@corp.example',
          description: 'Front desk',
          enabled: true,
          locked: false,
        },
      ],
      groups: [],
      computers: [
        {
          id: 'c1',
          name: 'WS01',
          samAccountName: 'WS01$',
          dnsHostName: 'ws01.corp.example',
          operatingSystem: 'Windows 11 Pro',
          description: 'Reception PC',
          enabled: true,
          writeBlock: null,
        },
      ],
    } as never);
    const { pane } = await openStaff();

    expect(pane.findAll('.os-list-row').map((r) => r.findAll('td')[2]!.text())).toEqual([
      'Front desk',
      'Reception PC',
    ]);
  });
});
