// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  type DirectoryConnection,
  ldapTransportProblem,
  rebindRequiredReason,
} from './ldapTransport.js';

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

describe('rebindRequiredReason', () => {
  const before: DirectoryConnection = {
    ldapUrls: ['ldaps://dc1:636'],
    tlsMode: 'ldaps',
    tlsRejectUnauthorized: true,
    syncBindUpn: 'svc@corp.example',
  };

  it('is null when nothing the password is sent to changes', () => {
    expect(rebindRequiredReason(before, { ...before })).toBeNull();
    expect(rebindRequiredReason(before, { ...before, syncBindUpn: 'SVC@corp.example' })).toBeNull();
    expect(rebindRequiredReason(before, { ...before, syncBindUpn: null })).toBeNull();
  });

  it('asks for the password when the connection changes', () => {
    expect(rebindRequiredReason(before, { ...before, ldapUrls: ['ldaps://evil:636'] })).toMatch(
      /Re-enter/,
    );
    expect(rebindRequiredReason(before, { ...before, tlsRejectUnauthorized: false })).toMatch(
      /Re-enter/,
    );
  });

  it('asks for the new account’s password when the account changes', () => {
    expect(rebindRequiredReason(before, { ...before, syncBindUpn: 'other@corp.example' })).toMatch(
      /new service account/,
    );
  });
});
