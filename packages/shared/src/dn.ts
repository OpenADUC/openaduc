// SPDX-License-Identifier: BUSL-1.1
// Distinguished names (RFC 4514), as far as building and checking them goes.

/**
 * Strict RFC 4514 §2.4 escaping of an RDN value: `, + " \ < > ; =` and NUL
 * are escaped anywhere, `#` or a space at the start and a space at the end.
 * Spaces in the middle are not: AD's modify DN refuses a value escaped more
 * than that.
 */
export function escapeRdnValueRfc(value: string): string {
  if (!value) return value;
  let out = '';
  for (const ch of value) {
    out += ',+"\\<>;=\x00'.includes(ch) ? `\\${ch}` : ch;
  }
  if (out.startsWith('#') || out.startsWith(' ')) out = `\\${out}`;
  if (out.length > 1 && out.endsWith(' ') && !out.endsWith('\\ ')) out = `${out.slice(0, -1)}\\ `;
  return out;
}

/** The DN of a new child, e.g. `childDn('CN', 'Smith, John', ou)` → `CN=Smith\, John,<ou>`. */
export function childDn(attribute: string, value: string, parent: string): string {
  return `${attribute}=${escapeRdnValueRfc(value)},${parent}`;
}

export interface Rdn {
  type: string;
  /** Unescaped. */
  value: string;
}

const ATTRIBUTE_TYPE = /^(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)*)$/;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

/**
 * Parse a DN into its RDNs, leftmost first, or null when it isn't one.
 * Multi-valued RDNs (`+`) are kept whole in `value`, which is enough to
 * compare DNs; nothing here builds one.
 */
export function parseDn(dn: string): Rdn[] | null {
  try {
    return parseRdns(dn);
  } catch {
    // Hex escapes that aren't UTF-8.
    return null;
  }
}

function parseRdns(dn: string): Rdn[] | null {
  if (!dn.trim()) return null;
  const rdns: Rdn[] = [];
  let i = 0;
  while (i <= dn.length) {
    const eq = dn.indexOf('=', i);
    if (eq < 0) return null;
    const type = dn.slice(i, eq).trim();
    if (!ATTRIBUTE_TYPE.test(type)) return null;
    let value = '';
    // Hex escapes are UTF-8 bytes; a character may take several.
    let bytes = '';
    const flush = () => {
      if (bytes) value += decodeURIComponent(bytes);
      bytes = '';
    };
    let j = eq + 1;
    for (; j < dn.length && dn[j] !== ','; j++) {
      const ch = dn[j]!;
      if (ch === '\\') {
        const pair = dn.slice(j + 1, j + 3);
        if (HEX_PAIR.test(pair)) {
          bytes += `%${pair}`;
          j += 2;
          continue;
        }
        if (j + 1 >= dn.length) return null;
        flush();
        value += dn[++j];
      } else if (ch === '"' || ch === ';' || ch === '<' || ch === '>') {
        return null;
      } else {
        flush();
        value += ch;
      }
    }
    flush();
    value = value.trim();
    if (!value) return null;
    rdns.push({ type, value });
    if (j >= dn.length) break;
    i = j + 1;
  }
  return rdns;
}

const rdnKey = (r: Rdn) => `${r.type.toLowerCase()}=${r.value.toLowerCase()}`;

/** Whether `dn` is `base` or somewhere under it. False when either isn't a DN. */
export function isDnWithin(dn: string, base: string): boolean {
  const inner = parseDn(dn);
  const outer = parseDn(base);
  if (!inner || !outer || inner.length < outer.length) return false;
  const tail = inner.slice(inner.length - outer.length);
  return tail.every((r, k) => rdnKey(r) === rdnKey(outer[k]!));
}
