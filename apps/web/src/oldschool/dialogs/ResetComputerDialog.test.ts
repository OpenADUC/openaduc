// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const api = { computers: { resetAccount: vi.fn(async () => ({ ok: true })) } };
vi.mock('../../api/index.js', () => ({ api }));
const toast = { add: vi.fn() };
vi.mock('primevue/usetoast', () => ({ useToast: () => toast }));

const { default: ResetComputerDialog } = await import('./ResetComputerDialog.vue');
const { useAuthStore } = await import('../../stores/auth.js');
const { useOldSchool } = await import('../stores/useOldSchool.js');

async function openReset() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAuthStore().actor = {
    capabilities: ['read:computer', 'write:computer.resetAccount'],
    elevated: {
      active: true,
      idleExpiresAt: '2999-01-01T00:15:00.000Z',
      absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
    },
  } as never;
  const oldSchool = useOldSchool();
  oldSchool.openDialog({ kind: 'reset-computer', id: 'c1', label: 'WS01' });
  const dialog = mount(ResetComputerDialog, {
    props: { windowId: oldSchool.windows[0]!.id, id: 'c1', label: 'WS01' },
    global: { plugins: [pinia, PrimeVue], stubs: { teleport: true } },
  });
  await flushPromises();
  return { dialog, oldSchool };
}

const button = (dialog: Awaited<ReturnType<typeof openReset>>['dialog'], label: string) =>
  dialog.findAll('button').find((b) => b.text() === label)!;

describe('the Old School reset computer prompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resets on Yes, closes, and says so', async () => {
    const { dialog, oldSchool } = await openReset();
    const version = oldSchool.dataVersion;

    await button(dialog, 'Yes').trigger('click');
    await flushPromises();

    expect(api.computers.resetAccount).toHaveBeenCalledWith('c1');
    expect(dialog.emitted('close')).toBeTruthy();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Account WS01 was successfully reset.' }),
    );
    expect(oldSchool.dataVersion).toBe(version + 1);
  });

  it('leaves the account alone on No', async () => {
    const { dialog } = await openReset();

    await button(dialog, 'No').trigger('click');
    await flushPromises();

    expect(api.computers.resetAccount).not.toHaveBeenCalled();
    expect(dialog.emitted('close')).toBeTruthy();
  });

  it('says in a message box why the reset failed', async () => {
    api.computers.resetAccount.mockRejectedValueOnce(
      new ApiError(403, 'forbidden', 'directory refused the reset'),
    );
    const { dialog, oldSchool } = await openReset();

    await button(dialog, 'Yes').trigger('click');
    await flushPromises();

    expect(oldSchool.windows.at(-1)!.dialog).toEqual({
      kind: 'message',
      title: 'Active Directory Domain Services',
      message: 'Windows cannot reset the account of WS01 because:\ndirectory refused the reset',
    });
  });
});
