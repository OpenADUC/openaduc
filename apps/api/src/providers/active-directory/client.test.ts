// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { transportFor } from './client.js';

describe('transportFor', () => {
  it('uses TLS from the start for ldaps:// URLs, whatever the mode', () => {
    expect(transportFor('ldaps://dc1:636', 'ldaps')).toBe('tls');
    expect(transportFor('ldaps://dc1:636', 'starttls')).toBe('tls');
  });

  it('upgrades ldap:// with StartTLS in StartTLS mode', () => {
    expect(transportFor('ldap://dc1:389', 'starttls')).toBe('starttls');
  });

  it('keeps an ldap:// URL in LDAPS mode on TLS rather than falling back to cleartext', () => {
    // Directories saved before URLs were validated: ldap://dc:636 under
    // LDAPS has always connected with TLS, and must keep doing so.
    expect(transportFor('ldap://dc1:636', 'ldaps')).toBe('tls');
  });
});
