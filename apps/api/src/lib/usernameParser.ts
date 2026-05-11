// SPDX-License-Identifier: BUSL-1.1
/**
 * Strip any embedded domain from a typed username. Accepts:
 *   - bare:    "jeff"            → "jeff"
 *   - UPN:     "jeff@corp.local" → "jeff"
 *   - DOMAIN\\user: "CORP\\jeff" → "jeff"
 * The chosen domain is decided by the directory dropdown, not by what the
 * user typed. We honor the dropdown so a user can't accidentally bind
 * against a different domain by writing an unexpected suffix.
 */
export function bareUsername(input: string): string {
  const trimmed = input.trim();
  // DOMAIN\user wins first (the @ in a UPN is a different separator).
  const backslashIdx = trimmed.indexOf('\\');
  if (backslashIdx >= 0) return trimmed.slice(backslashIdx + 1).trim();
  const atIdx = trimmed.indexOf('@');
  if (atIdx > 0) return trimmed.slice(0, atIdx).trim();
  return trimmed;
}

/**
 * Compose the UPN we send to LDAP. Bare username + the directory's
 * configured DNS domain. AD accepts UPN-form simple binds even when the
 * userPrincipalName attribute isn't populated, via implicit domain mapping.
 */
export function composeBindUpn(rawUsername: string, domainName: string): string {
  return `${bareUsername(rawUsername)}@${domainName}`;
}
