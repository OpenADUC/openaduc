// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { suggestRenamedIdentity, type RenameIdentity } from './rename.js';

const john: RenameIdentity = {
  givenName: 'John',
  surname: 'Smith',
  displayName: 'John Smith',
  cn: 'John Smith',
  samAccountName: 'jsmith',
  userPrincipalName: 'jsmith@corp.example.com',
  email: 'john.smith@example.com',
};

describe('suggestRenamedIdentity', () => {
  it('follows each field’s existing pattern', () => {
    const { values, unresolved } = suggestRenamedIdentity(john, {
      givenName: 'John',
      surname: 'Doe',
    });
    expect(values).toEqual({
      givenName: 'John',
      surname: 'Doe',
      displayName: 'John Doe',
      cn: 'John Doe',
      samAccountName: 'jdoe',
      userPrincipalName: 'jdoe@corp.example.com',
      email: 'john.doe@example.com',
    });
    expect(unresolved).toEqual([]);
  });

  it('keeps "Surname, Given" and extra words in full names', () => {
    const { values } = suggestRenamedIdentity(
      { ...john, displayName: 'Smith, John (Contractor)', cn: 'Smith, John' },
      { givenName: 'Jane', surname: 'Doe' },
    );
    expect(values.displayName).toBe('Doe, Jane (Contractor)');
    expect(values.cn).toBe('Doe, Jane');
  });

  it('does not replace a name twice when old and new names overlap', () => {
    const { values } = suggestRenamedIdentity(
      { ...john, givenName: 'Lee', surname: 'Grant', displayName: 'Lee Grant' },
      { givenName: 'Grant', surname: 'Lee' },
    );
    expect(values.displayName).toBe('Grant Lee');
  });

  it('carries capitalisation style over to identifiers', () => {
    const { values } = suggestRenamedIdentity(
      { ...john, samAccountName: 'John.Smith', userPrincipalName: 'JSMITH@CORP.EXAMPLE.COM' },
      { givenName: 'Jane', surname: 'Doe' },
    );
    expect(values.samAccountName).toBe('Jane.Doe');
    expect(values.userPrincipalName).toBe('JDOE@CORP.EXAMPLE.COM');
  });

  it('strips accents and punctuation and drops collision numbers', () => {
    const { values } = suggestRenamedIdentity(
      { ...john, samAccountName: 'smithj2' },
      { givenName: 'José', surname: "O'Brien" },
    );
    expect(values.samAccountName).toBe('obrienj');
  });

  it('caps sAMAccountName at 20 characters', () => {
    const { values } = suggestRenamedIdentity(
      { ...john, samAccountName: 'john.smith' },
      { givenName: 'Maximiliana', surname: 'Wolfeschlegelstein' },
    );
    expect(values.samAccountName).toBe('maximiliana.wolfesch');
  });

  it('leaves fields it cannot explain alone and reports them', () => {
    const { values, unresolved } = suggestRenamedIdentity(
      { ...john, samAccountName: 'u12345', email: 'helpdesk@example.com' },
      { givenName: 'Jane', surname: 'Doe' },
    );
    expect(values.samAccountName).toBe('u12345');
    expect(values.email).toBe('helpdesk@example.com');
    expect(unresolved).toEqual(['samAccountName', 'email']);
  });

  it('builds a full name when the field is empty', () => {
    const { values } = suggestRenamedIdentity(
      { ...john, displayName: null },
      { givenName: 'Jane', surname: 'Doe' },
    );
    expect(values.displayName).toBe('Jane Doe');
  });

  it('cannot infer anything when the account has no name parts', () => {
    const { unresolved } = suggestRenamedIdentity(
      { ...john, givenName: null, surname: null },
      { givenName: 'Jane', surname: 'Doe' },
    );
    expect(unresolved).toEqual([
      'displayName',
      'cn',
      'samAccountName',
      'userPrincipalName',
      'email',
    ]);
  });
});
