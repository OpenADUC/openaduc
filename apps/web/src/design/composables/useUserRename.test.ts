// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { aUserDetail } from '../../test/userDetail.js';

const rename = vi.fn();
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({ api: { users: { rename }, auth: { stepUp } } }));

const { useUserRename } = await import('./useUserRename.js');
const { useAuthStore } = await import('../../stores/auth.js');

const JANE = aUserDetail({
  givenName: 'Jane',
  surname: 'Doe',
  displayName: 'Jane Doe',
  cn: 'Jane Doe',
  samAccountName: 'jdoe',
  userPrincipalName: 'jdoe@corp.example',
});

function setup(elevated = true) {
  setActivePinia(createPinia());
  useAuthStore().actor = { capabilities: [], elevated: { active: elevated } } as never;
  const onRenamed = vi.fn();
  const workflow = useUserRename({ onRenamed });
  workflow.reset(JANE);
  return { workflow, onRenamed };
}

// The rename runs once any step-up is through, after the click returns.
const settled = () => new Promise((r) => setTimeout(r));

describe('useUserRename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rename.mockResolvedValue({ ok: true });
  });

  it('fills in the other names by the account’s pattern and sends only what changed', async () => {
    const { workflow, onRenamed } = setup();
    workflow.setName('surname', 'Smith');

    workflow.submit();
    await settled();

    expect(rename).toHaveBeenCalledWith('u1', {
      surname: 'Smith',
      displayName: 'Jane Smith',
      cn: 'Jane Smith',
      samAccountName: 'jsmith',
      userPrincipalName: 'jsmith@corp.example',
    });
    expect(onRenamed).toHaveBeenCalledOnce();
  });

  it('does nothing when nothing changed', async () => {
    const { workflow } = setup();
    workflow.submit();
    await settled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('prompts step-up before renaming, then renames', async () => {
    const { workflow, onRenamed } = setup(false);
    workflow.setName('surname', 'Smith');

    workflow.submit();
    await settled();
    expect(useAuthStore().stepUpRequested).toBe(true);
    expect(rename).not.toHaveBeenCalled();

    await useAuthStore().stepUp('pw');
    await vi.waitFor(() => expect(onRenamed).toHaveBeenCalledOnce());
    expect(rename).toHaveBeenCalledOnce();
  });

  it('finishes the rename after step-up when the server says the elevated session is gone', async () => {
    const { workflow, onRenamed } = setup();
    workflow.setName('surname', 'Smith');
    rename.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));

    workflow.submit();
    await settled();
    expect(workflow.error.value).toBeNull();
    expect(onRenamed).not.toHaveBeenCalled();

    await useAuthStore().stepUp('pw');
    await vi.waitFor(() => expect(onRenamed).toHaveBeenCalledOnce());
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('sends one rename however often it is submitted while one is under way', async () => {
    let answer!: (v: unknown) => void;
    rename.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const { workflow, onRenamed } = setup();
    workflow.setName('surname', 'Smith');

    workflow.submit();
    await settled();
    expect(workflow.submitting.value).toBe(true);
    workflow.submit();
    await settled();
    answer({ ok: true });
    await settled();

    expect(rename).toHaveBeenCalledOnce();
    expect(onRenamed).toHaveBeenCalledOnce();
    expect(workflow.submitting.value).toBe(false);
  });

  it('shows why the directory refused, until the form is reset', async () => {
    const { workflow, onRenamed } = setup();
    workflow.setName('surname', 'Smith');
    rename.mockRejectedValueOnce(new ApiError(409, 'conflict', 'jsmith is already taken'));

    workflow.submit();
    await settled();
    expect(workflow.error.value).toBe('jsmith is already taken');
    expect(onRenamed).not.toHaveBeenCalled();

    workflow.reset(JANE);
    expect(workflow.error.value).toBeNull();
  });
});
