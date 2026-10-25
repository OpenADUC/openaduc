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

const CREATED = { ok: true, distinguishedName: FALCON.distinguishedName, group: FALCON };
const FREE = {
  nameTaken: false,
  samAccountNameTaken: false,
  nameTakenBy: null,
  samAccountNameTakenBy: null,
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
    nameCheck.mockReset().mockResolvedValue(FREE);
    create.mockReset().mockResolvedValue(CREATED);
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
      ...FREE,
      nameTaken: true,
      nameTakenBy: `CN=Engineering,${OU}`,
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
    expect(creation.taken.value).toEqual({
      name: `Already used in this OU by CN=Engineering,${OU}`,
      samAccountName: null,
    });
    expect(creation.canSubmit.value).toBe(false);
    creation.submit();
    expect(create).not.toHaveBeenCalled();
  });

  it('says a name is taken without saying by what when the server won’t', async () => {
    const { creation } = setup();
    nameCheck.mockResolvedValue({ ...FREE, samAccountNameTaken: true });

    creation.setName('Administrator');
    await checked();

    expect(creation.taken.value.samAccountName).toBe('Already used elsewhere in the domain');
    expect(creation.canSubmit.value).toBe(false);
  });

  it('forgets a check once the operator changes the name it was for', async () => {
    const { creation } = setup();
    nameCheck.mockResolvedValueOnce({
      ...FREE,
      nameTaken: true,
      nameTakenBy: `CN=Engineering,${OU}`,
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

  it('refuses control characters in either name', () => {
    const { creation } = setup();

    creation.setName('Sales\tEMEA');
    creation.setSamAccountName('sales\u0007');

    expect(creation.problems.value.name).toMatch(/control characters/);
    expect(creation.problems.value.samAccountName).toMatch(/control characters/);
  });

  it('warns, without refusing, about a pre-Windows 2000 name older clients can’t use', async () => {
    const { creation } = setup();

    creation.setName('Regional Sales Managers');
    await checked();

    expect(creation.samLegacyWarning.value).toMatch(/Longer than 20 characters/);
    expect(creation.canSubmit.value).toBe(true);
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
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED));
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
