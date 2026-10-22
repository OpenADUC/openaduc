// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { ldapTransportProblem } from './ldapTransport.js';

describe('ldapTransportProblem', () => {
  it('accepts ldaps:// URLs in LDAPS mode', () => {
    expect(
      ldapTransportProblem(['ldaps://dc1:636', 'LDAPS://dc2.corp.example'], 'ldaps'),
    ).toBeNull();
  });

  it('accepts ldap:// URLs in StartTLS mode', () => {
    expect(ldapTransportProblem(['ldap://dc1:389', 'ldap://dc2'], 'starttls')).toBeNull();
  });

  it('rejects ldap:// in LDAPS mode, naming the URL and pointing at StartTLS', () => {
    const problem = ldapTransportProblem(['ldaps://dc1:636', 'ldap://dc2:389'], 'ldaps');
    expect(problem).toContain('ldap://dc2:389');
    expect(problem).toMatch(/StartTLS/);
  });

  it('rejects ldaps:// in StartTLS mode', () => {
    expect(ldapTransportProblem(['ldaps://dc1:636'], 'starttls')).toContain('ldaps://dc1:636');
  });

  it('rejects URLs that are not LDAP', () => {
    expect(ldapTransportProblem(['dc1.corp.example'], 'ldaps')).toContain('dc1.corp.example');
    expect(ldapTransportProblem(['https://dc1'], 'ldaps')).toContain('https://dc1');
  });

  it('requires at least one URL', () => {
    expect(ldapTransportProblem([], 'ldaps')).not.toBeNull();
  });
});
