// SPDX-License-Identifier: BUSL-1.1
// How a directory's LDAP connections are protected, and whether its URLs
// agree with that. Shared so the API and the directory forms apply the same
// rule. Unencrypted LDAP isn't offered: binds carry AD passwords.

export const LDAP_TLS_MODES = ['ldaps', 'starttls'] as const;
export type LdapTlsMode = (typeof LDAP_TLS_MODES)[number];

export function ldapUrlScheme(url: string): 'ldap' | 'ldaps' | null {
  const m = /^(ldaps?):\/\/[^/\s]+/i.exec(url.trim());
  return m ? (m[1]!.toLowerCase() as 'ldap' | 'ldaps') : null;
}

/**
 * Why `urls` don't fit `mode`, or null when they do. LDAPS needs ldaps://
 * URLs; StartTLS needs ldap:// URLs, which it upgrades to TLS before any
 * bind.
 */
export function ldapTransportProblem(urls: readonly string[], mode: LdapTlsMode): string | null {
  if (urls.length === 0) return 'At least one domain controller URL is required.';
  for (const url of urls) {
    const scheme = ldapUrlScheme(url);
    if (!scheme) {
      return `"${url}" isn't an LDAP URL. Use ldaps://host:636, or ldap://host:389 with StartTLS.`;
    }
    if (mode === 'ldaps' && scheme === 'ldap') {
      return `"${url}" uses ldap://, but LDAPS needs ldaps:// URLs. To start on the LDAP port and switch to TLS, choose StartTLS.`;
    }
    if (mode === 'starttls' && scheme === 'ldaps') {
      return `"${url}" uses ldaps://, but StartTLS needs ldap:// URLs. Choose LDAPS instead.`;
    }
  }
  return null;
}
