// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const nameCheck = vi.fn();
const create = vi.fn();
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({
  api: { groups: { nameCheck, create }, auth: { stepUp } },
}));

const { useGroupCreation } = await import('./useGroupCreation.js');
const { useAuthStore } = await import('../../stores/auth.js');

const OU = 'OU=Groups,DC=corp,DC=test';
const FALCON = {
  id: 'g1',
  name: 'Project Falcon',
  samAccountName: 'Project Falcon',
  distinguishedName: `CN=Project Falcon,${OU}`,
  description: null,
  groupType: 'security',
  groupScope: 'global',
  memberCount: 0,
};

function setup(elevated = true) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = {
    capabilities: ['read:group', 'write:group.create'],
    elevated: { active: elevated },
  } as never;
  const onCreated = vi.fn();
  const creation = useGroupCreation({ onCreated });
  creation.reset(OU);
  return { creation, auth, onCreated };
}

/** Let the name check's debounce run and its answer arrive. */
async function checked(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

describe('useGroupCreation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nameCheck.mockReset().mockResolvedValue({ nameTakenBy: null, samAccountNameTakenBy: null });
    create.mockReset().mockResolvedValue({ ok: true, group: FALCON });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills the pre-Windows 2000 name from the name until the operator edits it', () => {
    const { creation } = setup();

    creation.setName('Project Falcon');
    expect(creation.form.samAccountName).toBe('Project Falcon');

    creation.setSamAccountName('falcon');
    creation.setName('Project Falcon Team');
    expect(creation.form.samAccountName).toBe('falcon');
  });

  it('says which names are taken before submit, and won’t submit them', async () => {
    const { creation } = setup();
    nameCheck.mockResolvedValue({
      nameTakenBy: `CN=Engineering,${OU}`,
      samAccountNameTakenBy: null,
    });

    creation.setName('Engineering');
    expect(creation.checking.value).toBe(true);
    await checked();

    expect(nameCheck).toHaveBeenCalledWith({
      parentDn: OU,
      name: 'Engineering',
      samAccountName: 'Engineering',
    });
    expect(creation.checking.value).toBe(false);
    expect(creation.taken.value).toEqual({ name: `CN=Engineering,${OU}`, samAccountName: null });
    expect(creation.canSubmit.value).toBe(false);
    creation.submit();
    expect(create).not.toHaveBeenCalled();
  });

  it('forgets a check once the operator changes the name it was for', async () => {
    const { creation } = setup();
    nameCheck.mockResolvedValueOnce({
      nameTakenBy: `CN=Engineering,${OU}`,
      samAccountNameTakenBy: null,
    });
    creation.setName('Engineering');
    await checked();

    creation.setName('Engineering Leads');

    expect(creation.taken.value).toEqual({ name: null, samAccountName: null });
    expect(creation.canSubmit.value).toBe(false);
    await checked();
    expect(creation.canSubmit.value).toBe(true);
  });

  it('doesn’t check names that break AD’s rules; it says what’s wrong instead', async () => {
    const { creation } = setup();

    creation.setName('Sales, EMEA');
    await checked();

    expect(nameCheck).not.toHaveBeenCalled();
    expect(creation.problems.value.name).toMatch(/can’t contain/);
    expect(creation.canSubmit.value).toBe(false);
  });

  it('prompts step-up before the first create, then creates with the form’s values', async () => {
    const { creation, auth, onCreated } = setup(false);
    creation.setName('Project Falcon');
    creation.form.description = '  Falcon team ';
    creation.form.scope = 'universal';
    creation.form.type = 'distribution';
    await checked();

    creation.submit();
    expect(auth.stepUpRequested).toBe(true);
    expect(create).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(FALCON));
    expect(create).toHaveBeenCalledWith({
      parentDn: OU,
      name: 'Project Falcon',
      samAccountName: 'Project Falcon',
      description: 'Falcon team',
      scope: 'universal',
      type: 'distribution',
    });
  });

  it('creates after step-up when the server says the elevated session is gone', async () => {
    const { creation, auth, onCreated } = setup();
    create.mockRejectedValueOnce(new ApiError(403, 'step_up_required', 'step-up required'));
    creation.setName('Project Falcon');
    await checked();

    creation.submit();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(creation.error.value).toBeNull();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('keeps a refused create on the form, with the directory’s reason', async () => {
    const { creation, onCreated } = setup();
    create.mockRejectedValueOnce(
      new ApiError(409, 'conflict', 'the name "Project Falcon" is already used in this OU'),
    );
    creation.setName('Project Falcon');
    await checked();

    creation.submit();

    await vi.waitFor(() =>
      expect(creation.error.value).toBe('the name "Project Falcon" is already used in this OU'),
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(creation.submitting.value).toBe(false);
  });
});
