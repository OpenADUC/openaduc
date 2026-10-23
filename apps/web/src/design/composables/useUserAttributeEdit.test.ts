// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevatedSessionState } from '@openaduc/shared';
import { ApiError } from '../../api/client.js';
import { aUserDetail } from '../../test/userDetail.js';

const ELEVATED: ElevatedSessionState = {
  active: true,
  idleExpiresAt: '2999-01-01T00:15:00.000Z',
  absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
};
const NOT_ELEVATED: ElevatedSessionState = {
  active: false,
  idleExpiresAt: null,
  absoluteExpiresAt: null,
};

const update = vi.fn();
const stepUp = vi.fn(async () => ({ elevated: ELEVATED }));
const revokeStepUp = vi.fn(async () => ({}));
vi.mock('../../api/index.js', () => ({
  api: { users: { update }, auth: { stepUp, revokeStepUp } },
}));

const { useUserAttributeEdit } = await import('./useUserAttributeEdit.js');
const { useAuthStore } = await import('../../stores/auth.js');

function setup(user = aUserDetail(), elevated = NOT_ELEVATED) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = { capabilities: ['read:user', 'write:user.attributes'], elevated } as never;
  const onSaved = vi.fn();
  const onFailed = vi.fn();
  const edit = useUserAttributeEdit({ onSaved, onFailed });
  edit.reset(user);
  return { edit, auth, onSaved, onFailed };
}

describe('useUserAttributeEdit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockResolvedValue({ ok: true });
  });

  it('tracks which attributes the draft changes, and forgets an edit undone', () => {
    const { edit } = setup(aUserDetail({ title: 'Analyst', otherMobile: ['+1 555 0100'] }));
    expect(edit.dirty.value).toBe(false);
    expect(edit.draft.title).toBe('Analyst');
    expect(edit.draft.otherMobile).toBe('+1 555 0100');

    edit.draft.title = 'Lead Analyst';
    edit.draft.otherMobile = '+1 555 0100\n+1 555 0101';
    expect(edit.dirty.value).toBe(true);
    expect(edit.changes.value).toEqual([
      { key: 'title', from: 'Analyst', to: 'Lead Analyst' },
      { key: 'otherMobile', from: ['+1 555 0100'], to: ['+1 555 0100', '+1 555 0101'] },
    ]);
    expect(edit.changed('title')).toBe(true);
    expect(edit.changed('department')).toBe(false);

    edit.draft.title = 'Analyst';
    edit.draft.otherMobile = '+1 555 0100';
    expect(edit.dirty.value).toBe(false);
  });

  it('doesn’t count surrounding whitespace as a change', () => {
    const { edit } = setup(aUserDetail({ title: 'Analyst ', otherMailbox: [' a@home.example'] }));
    expect(edit.dirty.value).toBe(false);

    edit.draft.title = '  Analyst';
    edit.draft.department = '   ';
    edit.draft.otherMailbox = 'a@home.example\n\n';
    expect(edit.dirty.value).toBe(false);
  });

  it('saves only the changed attributes, trimmed, clearing emptied ones', async () => {
    const { edit, onSaved } = setup(
      aUserDetail({ title: 'Analyst', department: 'Finance', otherHomePhone: ['555 0199'] }),
      ELEVATED,
    );
    edit.draft.title = ' Lead Analyst ';
    edit.draft.department = '';
    edit.draft.otherHomePhone = '';
    edit.draft.otherMobile = ' 555 0100 \n\n555 0101';
    edit.draft.streetAddress = '1 Main Street\nSuite 200';

    edit.save();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith('u1', {
      patch: {
        title: 'Lead Analyst',
        department: null,
        otherHomePhone: null,
        streetAddress: '1 Main Street\nSuite 200',
        otherMobile: ['555 0100', '555 0101'],
      },
    });
    expect(onSaved).toHaveBeenCalledWith(5);
  });

  it('refuses what the directory would refuse, without prompting step-up', async () => {
    const { edit, auth } = setup();
    edit.draft.email = 'not an address';
    edit.draft.c = 'TOOLONGCODE';
    edit.draft.description = 'x'.repeat(1025);
    edit.draft.title = 'Fine';
    expect(edit.valid.value).toBe(false);
    expect(edit.problems.value).toEqual({
      email: 'Not an email address',
      c: 'At most 8 characters',
      description: 'At most 1024 characters',
    });

    edit.save();
    expect(auth.stepUpRequested).toBe(false);
    expect(update).not.toHaveBeenCalled();

    edit.draft.email = 'jane@corp.example';
    edit.draft.c = 'NZ';
    edit.draft.description = 'Fine';
    expect(edit.valid.value).toBe(true);
  });

  it('prompts step-up on the first save, then saves', async () => {
    const { edit, auth, onSaved } = setup();
    edit.draft.title = 'Lead Analyst';

    edit.save();
    expect(auth.stepUpRequested).toBe(true);
    expect(update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith('u1', { patch: { title: 'Lead Analyst' } });
  });

  it('saves after step-up when the server says the elevated session is gone', async () => {
    const { edit, auth, onSaved, onFailed } = setup(aUserDetail(), ELEVATED);
    update.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    edit.draft.title = 'Lead Analyst';
    const after = vi.fn();

    edit.save(after);
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(edit.saving.value).toBe(false));
    expect(onFailed).not.toHaveBeenCalled();
    expect(edit.draft.title).toBe('Lead Analyst');

    expect(after).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(onSaved).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith('u1', { patch: { title: 'Lead Analyst' } });
  });

  it('keeps unsaved edits when the elevated session ends', async () => {
    const { edit, auth, onSaved } = setup(aUserDetail(), ELEVATED);
    edit.draft.title = 'Lead Analyst';

    await auth.revokeStepUp();
    expect(auth.elevated).toBe(false);
    expect(edit.draft.title).toBe('Lead Analyst');
    expect(edit.dirty.value).toBe(true);

    edit.save();
    expect(auth.stepUpRequested).toBe(true);
    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith('u1', { patch: { title: 'Lead Analyst' } });
  });

  it('reports a refused save and keeps the draft', async () => {
    const { edit, onSaved, onFailed } = setup(aUserDetail(), ELEVATED);
    update.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'constraint violation'));
    edit.draft.title = 'Lead Analyst';

    edit.save();
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith('constraint violation'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(edit.saving.value).toBe(false);
    expect(edit.dirty.value).toBe(true);
  });

  it('keeps a failed save until the next save, a reset or a dismiss', async () => {
    const { edit, onSaved } = setup(aUserDetail(), ELEVATED);
    update.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    edit.draft.title = 'Lead Analyst';

    edit.save();
    await vi.waitFor(() => expect(edit.failure.value).toBe('DC unreachable'));
    edit.save();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(edit.failure.value).toBeNull();

    update.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    edit.save();
    await vi.waitFor(() => expect(edit.failure.value).not.toBeNull());
    edit.dismiss();
    expect(edit.failure.value).toBeNull();

    update.mockRejectedValueOnce(new ApiError(500, 'ldap_error', 'DC unreachable'));
    edit.save();
    await vi.waitFor(() => expect(edit.failure.value).not.toBeNull());
    edit.reset(aUserDetail());
    expect(edit.failure.value).toBeNull();
  });

  it('starts over from the account it’s given', () => {
    const { edit } = setup(aUserDetail({ title: 'Analyst' }));
    edit.draft.title = 'Lead Analyst';

    edit.reset(aUserDetail({ title: 'Lead Analyst' }));
    expect(edit.draft.title).toBe('Lead Analyst');
    expect(edit.dirty.value).toBe(false);

    edit.draft.title = 'Analyst';
    edit.reset(null);
    expect(edit.draft.title).toBe('');
    expect(edit.dirty.value).toBe(false);
  });
});
