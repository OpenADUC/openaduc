// SPDX-License-Identifier: BUSL-1.1
import type { LdapTlsMode } from '@openaduc/shared';

/** The port a domain controller normally listens on for each mode. */
export function defaultLdapPort(mode: LdapTlsMode): number {
  return mode === 'ldaps' ? 636 : 389;
}

/**
 * Turn what the operator typed for a domain controller into an LDAP URL.
 * A full ldap:// or ldaps:// URL is kept as typed (the mode check reports a
 * mismatch); a bare host gets the mode's scheme and the given port.
 */
export function ldapUrlFor(hostOrUrl: string, mode: LdapTlsMode, port: number): string {
  const h = hostOrUrl.trim();
  if (!h) return '';
  if (/^ldaps?:\/\//i.test(h)) return h;
  return `${mode === 'ldaps' ? 'ldaps' : 'ldap'}://${h}:${port}`;
}
