// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { checkPassword, generatePassword, type PasswordPolicy } from './password.js';

const complex: PasswordPolicy = { minPwdLength: 7, complexityRequired: true };
const jane = { samAccountName: 'jdoe', displayName: 'Jane Doe-Smith' };

const unmet = (password: string, policy: PasswordPolicy | null = complex) =>
  checkPassword(password, policy, jane)
    .filter((c) => !c.met)
    .map((c) => c.rule);

describe('checkPassword', () => {
  it('passes a long, mixed password that avoids the account’s names', () => {
    expect(unmet('Correct-Horse-9')).toEqual([]);
  });

  it('needs the domain’s minimum length, and never less than the API’s 8', () => {
    expect(unmet('Ab1-xyz')).toEqual(['length']);
    expect(unmet('Ab1-xyz9', { minPwdLength: 12, complexityRequired: true })).toEqual(['length']);
  });

  it('needs three kinds of character when the domain requires complexity', () => {
    expect(unmet('alllowercase')).toEqual(['categories']);
    expect(unmet('lowercase-123')).toEqual([]);
    expect(unmet('alllowercase', { minPwdLength: 7, complexityRequired: false })).toEqual([]);
  });

  it('refuses the logon name and display-name parts of three or more letters', () => {
    expect(unmet('Xx-JDOE-2024')).toEqual(['names']);
    expect(unmet('Smith-2024-xx')).toEqual(['names']);
    expect(unmet('Doe!2024-xyz')).toEqual(['names']);
  });

  it('assumes complexity when the domain’s policy couldn’t be read', () => {
    expect(unmet('alllowercase', null)).toEqual(['categories']);
  });
});

describe('generatePassword', () => {
  it('meets the policy it was generated for', () => {
    const policy = { minPwdLength: 20, complexityRequired: true };
    for (let i = 0; i < 200; i++) {
      const password = generatePassword(policy, jane);
      expect(password.length).toBeGreaterThanOrEqual(20);
      expect(checkPassword(password, policy, jane).every((c) => c.met)).toBe(true);
    }
  });

  it('meets complexity even when the policy doesn’t ask for it', () => {
    const password = generatePassword({ minPwdLength: 0, complexityRequired: false }, jane);
    expect(unmet(password)).toEqual([]);
  });
});
