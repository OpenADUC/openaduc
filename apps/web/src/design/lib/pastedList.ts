// SPDX-License-Identifier: BUSL-1.1

const INVISIBLE = /[​-‍⁠﻿]/g;
const STRAY_SEPARATORS = /^[\s,;]+|[\s,;]+$/g;

/**
 * The entries in a pasted list of people, the way lists arrive from email,
 * Outlook recipient lines and spreadsheets: one per line, semicolons
 * always separating, and commas separating addresses. Any other entry
 * with commas goes to the server whole, which reads "Doe, Jane" as a name
 * and splits "jdoe, bsmith" only when the whole matches nobody.
 */
export function parsePastedList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .split(/\r\n|\r|\n/)) {
    for (const piece of splitOutside(pickCell(line), ';')) {
      const parts = piece.includes('@') ? keepNamesWhole(splitOutside(piece, ',')) : [piece];
      for (const part of parts) {
        const entry = part.replace(STRAY_SEPARATORS, '');
        if (!entry || seen.has(entry)) continue;
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out;
}

// A row copied from a spreadsheet: the cell most likely to name one
// account, so a Name / Email / Department row is matched by its email.
function pickCell(line: string): string {
  if (!line.includes('\t')) return line;
  const cells = line
    .split('\t')
    .map((c) => c.trim())
    .filter(Boolean);
  return (
    cells.find((c) => c.includes('@')) ??
    cells.find((c) => /^\S+$/.test(c) && /[\\._\-\d]/.test(c)) ??
    cells[0] ??
    ''
  );
}

function splitOutside(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let bracketed = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') bracketed = true;
    else if (ch === '>') bracketed = false;
    if (ch === sep && !quoted && !bracketed) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// "Doe, Jane <jane@x>" split on its comma: "Doe" is the start of the name
// in front of the address, not an entry of its own.
function keepNamesWhole(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const next = parts[i + 1];
    if (next !== undefined && !/[@<]/.test(part) && /^[^@<>]+<[^<>]*>$/.test(next.trim())) {
      out.push(`${part},${next}`);
      i++;
    } else out.push(part);
  }
  return out;
}
