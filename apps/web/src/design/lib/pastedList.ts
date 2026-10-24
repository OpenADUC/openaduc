// SPDX-License-Identifier: BUSL-1.1
// A pasted list of people split into entries for matching: one per line,
// or separated by commas or semicolons, the way lists arrive from email,
// Outlook's recipient lines and spreadsheets.

/**
 * The entries in `text`, trimmed, without blanks or repeats (ignoring
 * case). Semicolons always separate. Commas separate on a single line, or
 * between addresses, so a list of "Doe, Jane" display names one per line
 * stays whole. Rows copied from a spreadsheet give their first filled cell.
 */
export function parsePastedList(text: string): string[] {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map(firstCell)
    .filter((line) => line.trim() !== '');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const pieces = splitOutside(line, ';');
    const commaList = lines.length === 1 && pieces.length === 1;
    for (const piece of pieces) {
      const parts =
        commaList || piece.includes('@') ? keepNamesWhole(splitOutside(piece, ',')) : [piece];
      for (const part of parts) {
        const entry = part.trim();
        const key = entry.toLowerCase();
        if (!entry || seen.has(key)) continue;
        seen.add(key);
        out.push(entry);
      }
    }
  }
  return out;
}

function firstCell(line: string): string {
  if (!line.includes('\t')) return line;
  return line.split('\t').find((cell) => cell.trim() !== '') ?? '';
}

/** Split on `sep` outside double quotes and angle brackets. */
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
