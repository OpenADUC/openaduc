// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveNames,
  type NamingCheckRequest,
  type NamingDeviation,
  type NewUserSettings,
  type UserCreateResponse,
} from '@openaduc/shared';
import { ApiError } from '../../api/client.js';

const NAMING = { pattern: '{first}.{last}', upnSuffix: 'corp.test' };
const NOTHING = { samAccountNames: [], userPrincipalNames: [], mailAddresses: [], cns: [] };
const OU = 'OU=Staff,DC=corp,DC=test';

let taken = { ...NOTHING } as Parameters<typeof resolveNames>[2];
let newUsers: NewUserSettings = { mailFromUpn: true, passwordMode: 'random', phoneCountry: 'GB' };

// The server's check, run on the request the way the API runs it.
const check = vi.fn(async (_id: number, body: NamingCheckRequest) => ({
  naming: NAMING,
  suggestions: resolveNames(
    body.names.map(({ ouDn, overrides, ...name }) => ({ name, ouDn, overrides })),
    NAMING,
    taken,
    ['corp.test', 'corp.example'],
  ),
}));
const create = vi.fn();
const finishCreate = vi.fn();
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({
  api: {
    directories: {
      naming: {
        get: async () => ({ naming: NAMING, upnSuffixes: ['corp.test', 'corp.example'] }),
        check,
      },
      newUsers: { get: async () => ({ newUsers }) },
      policy: async () => ({ policy: { minPwdLength: 8, complexityRequired: true } }),
    },
    users: { create, finishCreate },
    auth: { stepUp },
  },
}));

const { useUserCreation } = await import('./useUserCreation.js');
const { useAuthStore } = await import('../../stores/auth.js');

const DONE: UserCreateResponse = {
  id: 'u1',
  distinguishedName: `CN=Jane Doe,${OU}`,
  samAccountName: 'jane.doe',
  completed: ['create', 'password', 'enable'],
  remaining: [],
  failure: null,
};

async function setup(elevated = true) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = {
    directoryId: 1,
    capabilities: ['read:user', 'write:user.create'],
    elevated: { active: elevated },
  } as never;
  const onCreated = vi.fn();
  const creation = useUserCreation({ onCreated });
  await creation.start({ ouDn: OU });
  return { creation, auth, onCreated };
}

/** Let the name check's debounce run and its answer arrive. */
async function checked(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500);
}

async function named(creation: Awaited<ReturnType<typeof setup>>['creation']) {
  creation.form.first = 'Jane';
  creation.form.last = 'Doe';
  await checked();
}

describe('useUserCreation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    taken = { ...NOTHING };
    newUsers = { mailFromUpn: true, passwordMode: 'random', phoneCountry: 'GB' };
    check.mockClear();
    create.mockReset().mockResolvedValue(DONE);
    finishCreate.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suggests the account’s names from the pattern, checked against the directory', async () => {
    taken = { ...NOTHING, samAccountNames: ['jane.doe'] };
    const { creation } = await setup();

    await named(creation);

    expect(check).toHaveBeenCalledOnce();
    expect(creation.names.value).toMatchObject({
      samAccountName: 'jane.doe2',
      upnLocal: 'jane.doe',
      upnSuffix: 'corp.test',
      displayName: 'Jane Doe',
      cn: 'Jane Doe',
    });
  });

  it('holds a collision until the operator approves it', async () => {
    taken = { ...NOTHING, samAccountNames: ['jane.doe'] };
    const { creation } = await setup();
    await named(creation);

    const [{ deviation, needsApproval }] = creation.deviations.value as [
      { deviation: NamingDeviation; needsApproval: boolean },
    ];
    expect([deviation.kind, needsApproval]).toEqual(['collision', true]);
    expect(creation.canSubmit.value).toBe(false);

    creation.approve(deviation);
    expect(creation.canSubmit.value).toBe(true);
  });

  it('checks names the operator typed as typed, and blocks one that’s taken', async () => {
    taken = { ...NOTHING, samAccountNames: ['jdoe'] };
    const { creation } = await setup();
    await named(creation);

    creation.setSamAccountName('jdoe');
    await checked();

    expect(check).toHaveBeenLastCalledWith(1, {
      names: [
        expect.objectContaining({
          first: 'Jane',
          ouDn: OU,
          overrides: { samAccountName: 'jdoe', userPrincipalName: null, displayName: null },
        }),
      ],
    });
    expect(creation.plan.value.blockers).toEqual([
      expect.objectContaining({ field: 'samAccountName' }),
    ]);
    expect(creation.canSubmit.value).toBe(false);

    creation.useSuggestedNames();
    await checked();
    expect(creation.canSubmit.value).toBe(true);
  });

  it('keeps the name before the @ when the operator picks another suffix', async () => {
    const { creation } = await setup();
    await named(creation);

    creation.setUpnSuffix('corp.example');
    creation.form.first = 'Janet';
    await checked();

    expect(creation.names.value).toMatchObject({
      upnLocal: 'jane.doe',
      upnSuffix: 'corp.example',
      samAccountName: 'jane.doe',
      displayName: 'Janet Doe',
    });
  });

  it('starts in the directory’s password mode, generating a password shown once', async () => {
    newUsers = { mailFromUpn: false, passwordMode: 'generate', phoneCountry: null };
    const { creation } = await setup();

    expect(creation.form.passwordMode).toBe('generate');
    expect(creation.form.mailFromUpn).toBe(false);
    expect(creation.form.password).toHaveLength(16);
    expect(creation.shown.value).toBe(true);
    expect(creation.form.mustChange).toBe(true);
  });

  it('sends no password in random mode, with must-change off and why', async () => {
    const { creation, onCreated } = await setup();
    await named(creation);

    creation.submit();
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(DONE));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ password: { mode: 'random' }, mailFromUpn: true }),
    );
    expect(creation.plan.value.mustChange).toBe(false);
    expect(creation.plan.value.mustChangeNote).toMatch(/Entra ID/);
  });

  it('checks a typed password against the policy before it can be sent', async () => {
    const { creation } = await setup();
    await named(creation);
    creation.setPasswordMode('set');

    creation.form.password = 'jane.doe-2024';
    expect(creation.plan.value.passwordChecks.filter((c) => !c.met).map((c) => c.rule)).toEqual([
      'names',
    ]);
    expect(creation.canSubmit.value).toBe(false);

    creation.form.password = 'Correct-Horse-9';
    expect(creation.canSubmit.value).toBe(true);
  });

  it('writes phone numbers Entra’s way, in the directory’s country', async () => {
    const { creation } = await setup();
    creation.form.mobile = '07400 123456';
    creation.form.telephoneNumber = 'ext 42';

    creation.tidyPhones();

    expect(creation.form.mobile).toBe('+44 7400123456');
    expect(creation.form.telephoneNumber).toBe('ext 42');
    expect(creation.plan.value.warnings).toEqual([
      expect.objectContaining({ field: 'telephoneNumber' }),
    ]);
  });

  it('prompts step-up before the first create', async () => {
    const { creation, auth, onCreated } = await setup(false);
    await named(creation);

    creation.submit();
    expect(auth.stepUpRequested).toBe(true);
    expect(create).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  });

  it('keeps an account a create left unfinished, and runs what’s left', async () => {
    const { creation, onCreated } = await setup();
    await named(creation);
    creation.setPasswordMode('set');
    creation.form.password = 'Correct-Horse-9';
    create.mockResolvedValue({
      ...DONE,
      completed: ['create'],
      remaining: ['password', 'enable'],
      failure: { step: 'password', message: 'the password is too short' },
    });

    creation.submit();
    await vi.waitFor(() => expect(creation.unfinished.value).not.toBeNull());

    expect(onCreated).not.toHaveBeenCalled();
    expect(creation.canSubmit.value).toBe(false);
    expect(creation.unfinishedSummary.value).toEqual({
      title: 'jane.doe exists, but it’s disabled.',
      failed: 'Couldn’t set its password: the password is too short',
      left: 'Still to do: set its password, then enable it.',
    });

    finishCreate.mockResolvedValue(DONE);
    creation.form.password = 'Longer-Correct-Horse-9';
    creation.finish();
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(DONE));
    expect(finishCreate).toHaveBeenCalledWith('u1', {
      password: { mode: 'set', password: 'Longer-Correct-Horse-9', mustChange: true },
      enabled: true,
    });
  });

  it('keeps a refused create on the form, with the directory’s reason', async () => {
    const { creation, onCreated } = await setup();
    await named(creation);
    create.mockRejectedValueOnce(new ApiError(409, 'conflict', 'the logon name is already used'));

    creation.submit();

    await vi.waitFor(() => expect(creation.error.value).toBe('the logon name is already used'));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('falls back to the pattern when the check fails, saying so', async () => {
    const { creation } = await setup();
    check.mockRejectedValueOnce(new ApiError(502, 'bad_gateway', 'directory unavailable'));

    await named(creation);

    expect(creation.checkError.value).toBe('directory unavailable');
    expect(creation.names.value.samAccountName).toBe('jane.doe');
    expect(creation.canSubmit.value).toBe(true);
  });
});
