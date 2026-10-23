// SPDX-License-Identifier: BUSL-1.1
import { isSecretAttr } from '../providers/active-directory/normalize.js';

/**
 * The raw LDAP view for a caller holding `capabilities`: every attribute
 * with view:raw_attributes, otherwise null (fields the UI shows by name are
 * typed fields on the detail responses). Secrets are dropped either way;
 * normalization already strips them, and this also covers cache rows
 * written before it did.
 */
export function rawAttributesFor(
  capabilities: readonly string[] | undefined,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!capabilities?.includes('view:raw_attributes')) return null;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !isSecretAttr(k)));
}

/** Read a single string value from a raw LDAP attribute (last value wins). */
export function rawScalarValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return rawScalarValue(v[v.length - 1]);
  }
  if (typeof v === 'string') return v.length > 0 ? v : null;
  return String(v);
}

/** Read every string value from a raw LDAP attribute as an array. */
export function rawArrayValues(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x === 'string') {
      if (x.length > 0) out.push(x);
    } else if (x !== null && x !== undefined) {
      out.push(String(x));
    }
  }
  return out;
}

/** An LDAP boolean (`TRUE`/`FALSE`, last value wins) from a raw attribute. */
export function rawFlag(v: unknown): boolean {
  const value = Array.isArray(v) ? v[v.length - 1] : v;
  return typeof value === 'string' ? value.toUpperCase() === 'TRUE' : value === true;
}
