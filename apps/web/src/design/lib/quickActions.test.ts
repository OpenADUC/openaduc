// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import type { Capability } from '@openaduc/shared';
import { parseQuickQuery, quickActionsFor, type QuickAction } from './quickActions.js';

const WRITES: Capability[] = [
  'write:user.unlock',
  'write:user.resetPassword',
  'write:user.enableDisable',
];
const can =
  (...caps: Capability[]) =>
  (c: Capability) =>
    caps.includes(c);
const canAll = can(...WRITES);

describe('parseQuickQuery', () => {
  it.each<[string, QuickAction, string]>([
    ['unlock jdoe', 'unlock', 'jdoe'],
    ['reset jdoe', 'reset-password', 'jdoe'],
    ['pw jdoe', 'reset-password', 'jdoe'],
    ['enable jdoe', 'enable', 'jdoe'],
    ['disable jdoe', 'disable', 'jdoe'],
    ['UNLOCK Jane Doe', 'unlock', 'Jane Doe'],
    ['  Unlock    jdoe  ', 'unlock', 'jdoe'],
    ['unlock\tjdoe', 'unlock', 'jdoe'],
  ])('reads %j as %s on %j', (input, action, text) => {
    expect(parseQuickQuery(input, canAll)).toEqual({ action, text });
  });

  it('takes a verb alone as the action, with no name yet', () => {
    expect(parseQuickQuery('unlock', canAll)).toEqual({ action: 'unlock', text: '' });
    expect(parseQuickQuery('disable ', canAll)).toEqual({ action: 'disable', text: '' });
  });

  it.each([
    ['a name that starts with a verb', 'Enabled Smith'],
    ['a verb inside a word', 'unlocker'],
    ['a verb later in the query', 'jdoe unlock'],
    // Groups such as "Password Policy Admins" are searched for by name.
    ['a word that is only a synonym elsewhere', 'password policy'],
  ])('searches for %s as written', (_, input) => {
    expect(parseQuickQuery(input, canAll)).toEqual({ action: null, text: input });
  });

  it('searches for a quoted query as written, so a name can start with a verb', () => {
    expect(parseQuickQuery('"reset smith"', canAll)).toEqual({
      action: null,
      text: 'reset smith',
    });
    expect(parseQuickQuery(' "unlock', canAll)).toEqual({ action: null, text: 'unlock' });
  });

  it('searches for a verb the operator can’t perform as written', () => {
    const helpdesk = can('write:user.unlock');
    expect(parseQuickQuery('unlock jdoe', helpdesk)).toEqual({ action: 'unlock', text: 'jdoe' });
    expect(parseQuickQuery('disable jdoe', helpdesk)).toEqual({
      action: null,
      text: 'disable jdoe',
    });
    expect(parseQuickQuery('reset jdoe', helpdesk)).toEqual({ action: null, text: 'reset jdoe' });
  });

  it('isn’t fooled by words that are properties of every object', () => {
    expect(parseQuickQuery('constructor jdoe', canAll).action).toBeNull();
  });
});

describe('quickActionsFor', () => {
  const user = (state: { enabled?: boolean; locked?: boolean; passwordExpiresAt?: string }) => ({
    enabled: true,
    locked: false,
    ...state,
  });
  const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

  it('offers Unlock only for a locked account', () => {
    expect(quickActionsFor(user({ locked: false }), canAll)).not.toContain('unlock');
    expect(quickActionsFor(user({ locked: true }), canAll)).toContain('unlock');
  });

  it('offers Disable for an enabled account and Enable for a disabled one', () => {
    expect(quickActionsFor(user({ enabled: true }), canAll)).toEqual(['reset-password', 'disable']);
    expect(quickActionsFor(user({ enabled: false }), canAll)).toEqual(['enable', 'reset-password']);
  });

  it('offers only what the operator may do', () => {
    const locked = user({ locked: true });
    expect(quickActionsFor(locked, can('write:user.unlock'))).toEqual(['unlock']);
    expect(quickActionsFor(locked, can('write:user.enableDisable'))).toEqual(['disable']);
    expect(quickActionsFor(locked, can())).toEqual([]);
  });

  it('leads with the fix the user’s page leads with', () => {
    expect(quickActionsFor(user({ locked: true }), canAll)).toEqual([
      'unlock',
      'reset-password',
      'disable',
    ]);
    expect(quickActionsFor(user({ enabled: false, locked: true }), canAll)).toEqual([
      'enable',
      'unlock',
      'reset-password',
    ]);
    expect(quickActionsFor(user({ passwordExpiresAt: HOUR_AGO }), canAll)).toEqual([
      'reset-password',
      'disable',
    ]);
  });
});
