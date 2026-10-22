// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { planUserRename, type RenameCurrent } from './rename.js';

const current: RenameCurrent = {
  givenName: 'John',
  surname: 'Smith',
  displayName: 'John Smith',
  cn: 'John Smith',
  samAccountName: 'jsmith',
  userPrincipalName: 'jsmith@corp.example.com',
  email: 'john.smith@example.com',
  proxyAddresses: [
    'SMTP:john.smith@example.com',
    'smtp:jsmith@example.com',
    'X500:/o=Org/ou=Exchange/cn=Recipients/cn=jsmith',
  ],
};

describe('planUserRename', () => {
  it('maps every changed field to its AD attribute', () => {
    const plan = planUserRename(current, {
      givenName: 'John',
      surname: 'Doe',
      displayName: 'John Doe',
      cn: 'John Doe',
      samAccountName: 'jdoe',
      userPrincipalName: 'jdoe@corp.example.com',
      keepOldEmailAsAlias: true,
    });
    expect(plan.attributes).toEqual({
      sn: ['Doe'],
      displayName: ['John Doe'],
      sAMAccountName: ['jdoe'],
      userPrincipalName: ['jdoe@corp.example.com'],
    });
    expect(plan.newCn).toBe('John Doe');
    expect(plan.newSamAccountName).toBe('jdoe');
    expect(plan.newUserPrincipalName).toBe('jdoe@corp.example.com');
    expect(plan.newEmail).toBeNull();
  });

  it('promotes the new address and keeps the old one as an alias', () => {
    const plan = planUserRename(current, {
      email: 'john.doe@example.com',
      keepOldEmailAsAlias: true,
    });
    expect(plan.attributes['mail']).toEqual(['john.doe@example.com']);
    expect(plan.attributes['proxyAddresses']).toEqual([
      'SMTP:john.doe@example.com',
      'smtp:jsmith@example.com',
      'X500:/o=Org/ou=Exchange/cn=Recipients/cn=jsmith',
      'smtp:john.smith@example.com',
    ]);
    expect(plan.newEmail).toBe('john.doe@example.com');
  });

  it('drops the old address when asked to', () => {
    const plan = planUserRename(current, {
      email: 'john.doe@example.com',
      keepOldEmailAsAlias: false,
    });
    expect(plan.attributes['proxyAddresses']).toEqual([
      'SMTP:john.doe@example.com',
      'smtp:jsmith@example.com',
      'X500:/o=Org/ou=Exchange/cn=Recipients/cn=jsmith',
    ]);
  });

  it('promotes an existing alias instead of listing it twice', () => {
    const plan = planUserRename(current, {
      email: 'JSmith@example.com',
      keepOldEmailAsAlias: true,
    });
    expect(plan.attributes['proxyAddresses']).toEqual([
      'SMTP:JSmith@example.com',
      'X500:/o=Org/ou=Exchange/cn=Recipients/cn=jsmith',
      'smtp:john.smith@example.com',
    ]);
  });

  it('leaves proxyAddresses alone on accounts that have none', () => {
    const plan = planUserRename(
      { ...current, proxyAddresses: [] },
      { email: 'john.doe@example.com', keepOldEmailAsAlias: true },
    );
    expect(plan.attributes).toEqual({ mail: ['john.doe@example.com'] });
  });

  it('skips unchanged values and treats a case change as a change', () => {
    const plan = planUserRename(current, {
      givenName: 'John',
      cn: 'John Smith',
      samAccountName: 'JSmith',
      keepOldEmailAsAlias: true,
    });
    expect(plan.attributes).toEqual({ sAMAccountName: ['JSmith'] });
    expect(plan.newCn).toBeNull();
  });

  it('clears name parts and email when set to null or blank', () => {
    const plan = planUserRename(
      { ...current, proxyAddresses: [] },
      { givenName: '  ', email: null, keepOldEmailAsAlias: true },
    );
    expect(plan.attributes).toEqual({ givenName: [], mail: [] });
  });
});
