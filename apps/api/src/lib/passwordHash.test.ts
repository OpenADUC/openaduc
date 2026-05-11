// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwordHash.js';

describe('hashPassword / verifyPassword', () => {
  it('produces a self-describing scrypt envelope', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored.split('$').length).toBe(6);
  });

  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('rejects malformed envelopes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$not$an$envelope$xx$xx')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('refuses passwords under the minimum length on hash', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });

  it('two hashes of the same password are different (salt)', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery staple', a)).toBe(true);
    expect(await verifyPassword('correct horse battery staple', b)).toBe(true);
  });
}, 30_000);
