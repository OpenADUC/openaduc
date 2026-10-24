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

// ---- Reading ---------------------------------------------------------------

export const TABLE_DELIMITERS = ['\t', ',', ';', '|'] as const;
export type TableDelimiter = (typeof TABLE_DELIMITERS)[number];

/** A table pasted from a spreadsheet or read from a CSV file: a header row, then data rows. */
export interface ParsedTable {
  delimiter: TableDelimiter;
  header: string[];
  /** Each as long as the header, cells trimmed; blank rows left out. */
  rows: string[][];
  /** Each row's number as the spreadsheet shows it, the header being row 1. */
  rowNumbers: number[];
  /** What makes the table unreadable as it is. */
  problems: string[];
}

/**
 * The delimiter the header row uses, outside quotes: a tab when there is
 * one (Excel's paste), otherwise whichever of comma, semicolon (Excel's
 * CSV in locales with a decimal comma) or pipe it has most of.
 */
function detectDelimiter(text: string): TableDelimiter {
  const counts = new Map<TableDelimiter, number>(TABLE_DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if ([...counts.values()].some((n) => n > 0)) break;
    } else if (!quoted && counts.has(ch as TableDelimiter)) {
      counts.set(ch as TableDelimiter, counts.get(ch as TableDelimiter)! + 1);
    }
  }
  if (counts.get('\t')! > 0) return '\t';
  let best: TableDelimiter = ',';
  for (const d of [',', ';', '|'] as const) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** RFC 4180 records: a cell starting with a quote runs to its closing quote, "" inside being one. */
function readRecords(
  text: string,
  delimiter: TableDelimiter,
): { records: string[][]; unclosedAt: number | null } {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let quoteStart = 0;
  let cellStart = true;
  const endCell = () => {
    record.push(cell);
    cell = '';
    cellStart = true;
  };
  const endRecord = () => {
    endCell();
    records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cellStart) {
      quoted = true;
      quoteStart = records.length + 1;
      cellStart = false;
    } else if (ch === delimiter) endCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      cell += ch;
      cellStart = false;
    }
  }
  if (cell !== '' || record.length > 0 || quoted) endRecord();
  return { records, unclosedAt: quoted ? quoteStart : null };
}

export function parseTable(text: string): ParsedTable {
  const source = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(source);
  const { records, unclosedAt } = readRecords(source, delimiter);
  const problems: string[] = [];
  if (unclosedAt !== null) problems.push(`A quote opened in row ${unclosedAt} is never closed.`);

  let header: string[] | null = null;
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  records.forEach((record, i) => {
    const cells = record.map((c) => c.trim());
    if (cells.every((c) => c === '')) return;
    if (!header) {
      header = cells;
      return;
    }
    const width = header.length;
    if (cells.slice(width).some((c) => c !== '')) {
      problems.push(
        `Row ${i + 1} has ${cells.length} cells but the header row has ${width}. Check its quotes and separators.`,
      );
    }
    rows.push(Array.from({ length: width }, (_, k) => cells[k] ?? ''));
    rowNumbers.push(i + 1);
  });
  return { delimiter, header: header ?? [], rows, rowNumbers, problems };
}
