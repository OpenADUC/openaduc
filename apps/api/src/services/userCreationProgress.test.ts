// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { FINISH_WINDOW_MS, finishRefusal, type UnfinishedCreate } from './userCreationProgress.js';

const created = new Date('2026-10-23T10:00:00Z');
const account = {
  objectGuid: 'g1',
  whenCreated: '20261023100000.0Z',
  usnChanged: '4100',
  pwdLastSet: '0',
  lastLogonTimestamp: null,
};
const unfinished: UnfinishedCreate = {
  createCorrelationId: 'c1',
  createdAt: created,
  completed: ['create'],
  remaining: ['password', 'enable'],
  account,
};
const live = (over: Partial<typeof account & { enabled: boolean }> = {}) => ({
  ...account,
  enabled: false,
  ...over,
});
const soon = new Date(created.getTime() + 60_000);

describe('finishRefusal', () => {
  it('lets an unchanged account be finished within the window', () => {
    expect(finishRefusal(unfinished, live(), soon)).toBeNull();
  });

  it('refuses without an unfinished create', () => {
    expect(finishRefusal(null, live(), soon)).toMatch(/no unfinished create/);
    expect(finishRefusal({ ...unfinished, remaining: [] }, live(), soon)).toMatch(
      /no unfinished create/,
    );
  });

  it('refuses after the window', () => {
    const late = new Date(created.getTime() + FINISH_WINDOW_MS + 1);
    expect(finishRefusal(unfinished, live(), late)).toMatch(/24 hours/);
  });

  it('refuses an account changed since: a password, a sign-in, enabled, or recreated', () => {
    for (const changed of [
      live({ usnChanged: '4200', pwdLastSet: '134000000000000000' }),
      live({ usnChanged: '4200', lastLogonTimestamp: '134000000000000000' }),
      live({ enabled: true }),
      live({ whenCreated: '20261024100000.0Z' }),
      live({ objectGuid: 'g2' }),
    ]) {
      expect(finishRefusal(unfinished, changed, soon)).toMatch(/changed/);
    }
  });

  it('accepts a different uSNChanged, as another DC reports, while the account is untouched', () => {
    expect(finishRefusal(unfinished, live({ usnChanged: '9000' }), soon)).toBeNull();
    const enableLeft = { ...unfinished, completed: ['create', 'password'], remaining: ['enable'] };
    expect(
      finishRefusal(enableLeft as UnfinishedCreate, live({ usnChanged: '9000' }), soon),
    ).toMatch(/changed/);
  });

  it('refuses when the create couldn’t record how it left the account', () => {
    expect(finishRefusal({ ...unfinished, account: null }, live(), soon)).toMatch(/changed/);
  });
});
