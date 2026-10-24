// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const get = vi.fn();
const update = vi.fn();
const stepUp = vi.fn(async () => ({
  elevated: {
    active: true,
    idleExpiresAt: '2999-01-01T00:15:00.000Z',
    absoluteExpiresAt: '2999-01-01T04:00:00.000Z',
  },
}));
vi.mock('../../api/index.js', () => ({
  api: { directories: { naming: { get, update } }, auth: { stepUp } },
}));

const { useNamingPattern } = await import('./useNamingPattern.js');
const { useAuthStore } = await import('../../stores/auth.js');

const SETTINGS = {
  naming: { pattern: '{first}.{last}', upnSuffix: 'corp.test' },
  upnSuffixes: ['corp.test', 'mail.corp.test'],
};

function setup(elevated = true) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = {
    capabilities: ['configure:directory'],
    elevated: { active: elevated },
  } as never;
  const onSaved = vi.fn();
  return { naming: useNamingPattern(7, { onSaved }), auth, onSaved };
}

describe('useNamingPattern', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue(SETTINGS);
    update.mockReset().mockImplementation(async (_id, naming) => ({ ...SETTINGS, naming }));
  });

  it('loads the directory’s pattern and the suffixes it can use', async () => {
    const { naming } = setup();
    await naming.load();

    expect(get).toHaveBeenCalledWith(7);
    expect(naming.form).toEqual({ pattern: '{first}.{last}', upnSuffix: 'corp.test' });
    expect(naming.upnSuffixes.value).toEqual(['corp.test', 'mail.corp.test']);
    expect(naming.changed.value).toBe(false);
  });

  it('previews the pattern on screen against sample names, long hyphenated one included', async () => {
    const { naming } = setup();
    await naming.load();
    naming.form.upnSuffix = 'mail.corp.test';

    const long = naming.preview.value.find((row) => row.name.last.includes('-'));
    expect(long?.suggestion).toMatchObject({
      samAccountName: 'christopher.lee',
      upn: 'christopher.lee-vanderberg-montgomery@mail.corp.test',
    });
    expect(long?.suggestion.deviations.map((d) => d.kind)).toEqual(['truncated']);

    naming.form.pattern = '{f}{last}';
    expect(naming.preview.value[0]!.suggestion.samAccountName).toBe('jdoe');
    expect(naming.changed.value).toBe(true);
  });

  it('says what’s wrong with a pattern instead of previewing or saving it', async () => {
    const { naming } = setup();
    await naming.load();
    naming.form.pattern = '{first}.{surname}';

    expect(naming.problem.value).toMatch(/\{surname\}/);
    expect(naming.preview.value).toEqual([]);
    naming.save();
    expect(update).not.toHaveBeenCalled();
  });

  it('prompts step-up before saving, then saves what’s on screen', async () => {
    const { naming, auth, onSaved } = setup(false);
    await naming.load();
    naming.form.pattern = ' {f}{last} ';

    naming.save();
    expect(auth.stepUpRequested).toBe(true);
    expect(update).not.toHaveBeenCalled();

    await auth.stepUp('pw');
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(7, { pattern: '{f}{last}', upnSuffix: 'corp.test' });
    expect(naming.changed.value).toBe(false);
  });

  it('keeps the server’s refusal beside the form', async () => {
    const { naming } = setup();
    await naming.load();
    naming.form.pattern = '{f}{last}';
    update.mockRejectedValueOnce(new ApiError(400, 'bad_request', 'not one of the suffixes'));

    naming.save();
    await vi.waitFor(() => expect(naming.error.value).toBe('not one of the suffixes'));
    expect(naming.saving.value).toBe(false);
  });
});
