// SPDX-License-Identifier: BUSL-1.1

// Spreadsheet apps run a cell as a formula when it starts with one of
// these, so an attacker who can set a display name or department can make
// an administrator's spreadsheet fetch URLs or run DDE when they open an
// export. Prefixing a single quote makes the cell plain text (OWASP CSV
// injection guidance).
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One RFC 4180 cell: formula-like text neutralised, then quoted when it
 * contains a quote, comma or newline. Null/undefined render empty.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}
