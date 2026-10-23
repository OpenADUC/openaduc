// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aUserDetail } from '../../test/userDetail.js';

const SALES = 'OU=Sales,DC=corp,DC=example';
const STAFF = 'OU=Staff,OU=Sales,DC=corp,DC=example';
const api = {
  users: {
    get: vi.fn(async () => ({
      user: aUserDetail({ distinguishedName: `CN=Jane Doe,${STAFF}` }),
    })),
    move: vi.fn(async () => ({ ok: true })),
  },
  ous: {
    list: vi.fn(async () => ({
      ous: [
        { distinguishedName: SALES, name: 'Sales', parentDn: null, stale: false },
        { distinguishedName: STAFF, name: 'Staff', parentDn: SALES, stale: false },
      ],
    })),
  },
  auth: {
    stepUp: vi.fn(async () => ({
      elevated: {
        active: true,
        idleExpiresAt: '2999-01-01T00:15:00.000Z',
        absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
      },
    })),
  },
};
vi.mock('../../api/index.js', () => ({ api }));
const toast = { add: vi.fn() };
vi.mock('primevue/usetoast', () => ({ useToast: () => toast }));

const { default: MoveDialog } = await import('./MoveDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

async function openMove() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.actor = {
    capabilities: ['read:user', 'write:user.move'],
    elevated: { active: false, idleExpiresAt: null, absoluteExpiresAt: null },
  } as never;
  const oldSchool = useOldSchool();
  oldSchool.openDialog({ kind: 'move', id: 'u1', label: 'Jane Doe' });
  const dialog = mount(MoveDialog, {
    props: { windowId: oldSchool.windows[0]!.id, id: 'u1', label: 'Jane Doe' },
    global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
  });
  await flushPromises();
  return { dialog, auth, oldSchool };
}

const ok = (dialog: Awaited<ReturnType<typeof openMove>>['dialog']) =>
  dialog.findAll('button').find((b) => b.text() === 'OK')!;

describe('the Old School move dialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens at the user’s current container, and won’t move them there', async () => {
    const { dialog } = await openMove();
    const selected = dialog.get('.os-listbox-row.selected');
    expect(selected.text()).toContain('Staff');
    expect(dialog.text()).toContain('Jane Doe is already in this container.');
    expect(ok(dialog).attributes('disabled')).toBeDefined();
  });

  it('moves after the step-up its OK prompts, then refreshes and closes', async () => {
    const { dialog, auth, oldSchool } = await openMove();
    const version = oldSchool.dataVersion;
    await dialog
      .findAll('.os-listbox-row')
      .find((r) => r.text().includes('Sales'))!
      .trigger('click');

    await ok(dialog).trigger('click');
    expect(auth.stepUpRequested).toBe(true);
    expect(api.users.move).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await flushPromises();
    expect(api.users.move).toHaveBeenCalledWith('u1', { targetOuDn: SALES });
    expect(oldSchool.dataVersion).toBe(version + 1);
    expect(dialog.emitted('close')).toHaveLength(1);
  });
});
