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

/** What a directory's service account is sent to, and as whom. */
export interface DirectoryConnection {
  ldapUrls: readonly string[];
  tlsMode: LdapTlsMode;
  /** Effective value: the directory's own setting, else the server default. */
  tlsRejectUnauthorized: boolean;
  syncBindUpn: string | null;
}

/**
 * Why saving `next` over `before` needs the service-account password typed
 * in (and checked with a bind) first, or null when it doesn't. Syncs send
 * the stored password to wherever these settings point, as whoever they
 * name, so neither may change on the stored password alone.
 */
export function rebindRequiredReason(
  before: DirectoryConnection,
  next: DirectoryConnection,
): string | null {
  const connectionChanged =
    JSON.stringify(next.ldapUrls) !== JSON.stringify(before.ldapUrls) ||
    next.tlsMode !== before.tlsMode ||
    next.tlsRejectUnauthorized !== before.tlsRejectUnauthorized;
  if (connectionChanged) {
    return "Re-enter the service account password to change how OpenADUC connects to this domain. It's checked against the new settings before they're saved.";
  }
  const accountChanged =
    next.syncBindUpn !== null &&
    next.syncBindUpn.toLowerCase() !== (before.syncBindUpn ?? '').toLowerCase();
  if (accountChanged) {
    return "Enter the new service account's password. It's checked against the domain before it's saved.";
  }
  return null;
}
