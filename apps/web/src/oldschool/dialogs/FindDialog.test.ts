// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  users: {
    search: vi.fn(async () => ({
      rows: [{ id: 'u1', displayName: 'Sam Sales', samAccountName: 'ssales', email: null }],
    })),
  },
  groups: { search: vi.fn() },
  computers: { search: vi.fn() },
};
vi.mock('../../api/index.js', () => ({ api }));

const { default: FindDialog } = await import('./FindDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

async function find(text: string, capabilities = ['read:user', 'read:group', 'read:computer']) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = { capabilities } as never; // only capabilities matter here
  const oldSchool = useOldSchool();
  oldSchool.openDialog({ kind: 'find' });
  const dialog = mount(FindDialog, {
    props: { windowId: oldSchool.windows[0]!.id },
    global: { plugins: [pinia], stubs: { teleport: true } },
  });
  await dialog.get('#findName').setValue(text);
  await dialog
    .findAll('button')
    .find((b) => b.text() === 'Find Now')!
    .trigger('click');
  await flushPromises();
  return { dialog, oldSchool };
}

describe('the Old School Find dialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('finds users by name and opens the one double-clicked', async () => {
    const { dialog, oldSchool } = await find('sam');
    expect(api.users.search).toHaveBeenCalledWith({ q: 'sam', pageSize: 100 });
    await dialog.get('.os-listbox-row').trigger('dblclick');
    expect(oldSchool.windows.at(-1)).toMatchObject({
      dialog: { kind: 'user-properties', id: 'u1' },
    });
  });

  it('says the search failed rather than that nothing matched', async () => {
    api.users.search.mockRejectedValueOnce(new Error('boom'));
    const { dialog } = await find('sam');
    expect(dialog.text()).toContain('The search failed.');
    expect(dialog.text()).not.toContain('No matches');
  });

  it('offers only what the operator can read', async () => {
    const { dialog } = await find('sam', ['read:user', 'read:computer']);
    expect(dialog.findAll('#findKind option').map((o) => o.text())).toEqual(['Users', 'Computers']);
  });
});
