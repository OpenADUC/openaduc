// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { SHORTCUT_KEYS, SHORTCUT_PAGES } from './shortcutKeys.js';

describe('shortcut keys', () => {
  it.each(Object.entries(SHORTCUT_PAGES))('puts nothing on the %s page twice', (_, scopes) => {
    const keys = scopes.flatMap((scope) => Object.values(SHORTCUT_KEYS[scope]));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('uses lower-case letters, which is what the handler matches', () => {
    const keys = Object.values(SHORTCUT_KEYS).flatMap((scope) => Object.values(scope));
    expect(keys.filter((k) => k.length === 1 && k !== k.toLowerCase())).toEqual([]);
  });
});
