// SPDX-License-Identifier: BUSL-1.1

/**
 * The RDNs of a DN, unescaped: "OU=Sales\, East,DC=corp" → ["OU=Sales, East",
 * "DC=corp"]. A backslash escapes the next character, so "\\" is a literal
 * backslash and the comma after it still separates.
 */
export function rdns(dn: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < dn.length; i++) {
    const ch = dn[i]!;
    if (ch === '\\' && i + 1 < dn.length) cur += dn[++i];
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Where RDNs sit, the way ADUC writes it: the domain from the DC parts, then
 * the containers from the top down. ["OU=Groups", "OU=Corp", "DC=corp",
 * "DC=example"] → "corp.example/Corp/Groups".
 */
export function dnPath(rdnList: readonly string[], separator = '/'): string {
  const value = (rdn: string) => rdn.slice(rdn.indexOf('=') + 1);
  const isDc = (rdn: string) => /^DC=/i.test(rdn);
  const domain = rdnList.filter(isDc).map(value).join('.');
  const containers = rdnList
    .filter((r) => !isDc(r))
    .map(value)
    .reverse();
  return [domain, ...containers].filter(Boolean).join(separator);
}
