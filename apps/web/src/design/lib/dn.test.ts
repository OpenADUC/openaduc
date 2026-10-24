// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { dnName, dnPath, rdns } from './dn.js';

describe('rdns', () => {
  it('splits at unescaped commas and unescapes values', () => {
    expect(rdns('OU=Sales\\, East,DC=corp')).toEqual(['OU=Sales, East', 'DC=corp']);
  });

  it('treats an escaped backslash as a character, so the comma after it still splits', () => {
    expect(rdns('CN=Back\\\\,OU=Corp,DC=corp')).toEqual(['CN=Back\\', 'OU=Corp', 'DC=corp']);
  });
});

describe('dnPath', () => {
  it('reads domain first, then containers from the top down', () => {
    expect(dnPath(rdns('OU=Groups,OU=Corp,DC=corp,DC=example'))).toBe('corp.example/Corp/Groups');
    expect(dnPath(rdns('OU=A\\\\,OU=B\\, C,DC=x'), ' / ')).toBe('x / B, C / A\\');
  });
});

describe('dnName', () => {
  it('is the first RDN’s value, unescaped', () => {
    expect(dnName('CN=Doe\\, Jane,OU=Staff,DC=corp')).toBe('Doe, Jane');
    expect(dnName('CN=Jane Doe')).toBe('Jane Doe');
  });
});
