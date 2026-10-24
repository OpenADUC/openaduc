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

/** Whether a spreadsheet would run this as a formula. */
export const startsLikeFormula = (value: string): boolean => FORMULA_START.test(value);

/**
 * A cell holding exactly `value`, always quoted and never neutralised: for
 * values that must stay as they are, such as passwords, which OpenADUC
 * makes sure never start like a formula (generated ones are made again,
 * typed ones refused).
 */
export function csvExactCell(value: string): string {
  if (startsLikeFormula(value))
    throw new Error('a value written exactly can’t start like a formula');
  return `"${value.replace(/"/g, '""')}"`;
}

/** A row of cells; an `{ exact }` cell is written by csvExactCell. */
export function csvRow(cells: unknown[]): string {
  return cells
    .map((c) =>
      typeof c === 'object' && c !== null && 'exact' in c
        ? csvExactCell(String((c as { exact: unknown }).exact))
        : csvCell(c),
    )
    .join(',');
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

/** Cells in a record, not counting empty ones at its end. */
function widthOf(record: string[]): number {
  let n = record.length;
  while (n > 0 && record[n - 1]!.trim() === '') n--;
  return n;
}

/**
 * The delimiter that reads the most rows as wide as the header row, the
 * header being at least two columns wide: so `Name, first;Name, last`
 * over semicolon-separated rows is read by its semicolons. On a tie a tab
 * (Excel's paste) wins, then a comma, a semicolon (Excel's CSV where the
 * decimal mark is a comma) and a pipe.
 */
function detectDelimiter(text: string): TableDelimiter {
  let best: { delimiter: TableDelimiter; score: number } | null = null;
  for (const delimiter of TABLE_DELIMITERS) {
    const widths = readRecords(text, delimiter)
      .records.map(widthOf)
      .filter((w) => w > 0);
    const header = widths[0] ?? 0;
    if (header < 2) continue;
    const score = widths.slice(1).filter((w) => w === header).length;
    if (!best || score > best.score) best = { delimiter, score };
  }
  return best?.delimiter ?? ',';
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

// Excel writes, and honours, a first line naming the delimiter.
const SEP_LINE = /^"?sep=(.)"?[ \t]*(\r\n|\r|\n)/i;

export function parseTable(text: string): ParsedTable {
  let source = text.replace(/^\uFEFF/, '');
  const sep = SEP_LINE.exec(source);
  const named = sep && TABLE_DELIMITERS.find((d) => d === sep[1]);
  if (sep) source = source.slice(sep[0].length);
  const delimiter = named ?? detectDelimiter(source);
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
  const unreadable = rowNumbers.filter((_, i) => rows[i]!.some((c) => c.includes('\uFFFD')));
  if ((header ?? ([] as string[])).some((c) => c.includes('\uFFFD'))) unreadable.unshift(1);
  if (unreadable.length > 0) {
    const where =
      unreadable.length === 1
        ? `Row ${unreadable[0]} has`
        : `Rows ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', …' : ''} have`;
    problems.push(
      `${where} characters that couldn’t be read (shown as \uFFFD). Save the sheet as “CSV UTF-8” and use that file.`,
    );
  }
  return { delimiter, header: header ?? [], rows, rowNumbers, problems };
}
