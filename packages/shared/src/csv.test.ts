// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, parseTable } from './csv.js';

describe('csvCell', () => {
  it.each(['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])(
    'neutralises a leading formula character in %j',
    (value) => {
      const cell = csvCell(value);
      // A spreadsheet treats the cell as text once it starts with a quote.
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('leaves ordinary values alone', () => {
    expect(csvCell('Alice Anders')).toBe('Alice Anders');
    expect(csvCell('alice@corp.example')).toBe('alice@corp.example');
    expect(csvCell(true)).toBe('true');
    expect(csvCell(null)).toBe('');
    expect(csvCell(new Date('2026-10-22T00:00:00Z'))).toBe('2026-10-22T00:00:00.000Z');
  });

  it('still quotes per RFC 4180', () => {
    expect(csvCell('Anders, Alice')).toBe('"Anders, Alice"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
  });

  it('joins a row', () => {
    expect(csvRow(['a', '=b', null])).toBe("a,'=b,");
  });
});

describe('parseTable', () => {
  it('reads rows pasted from Excel, tab-separated', () => {
    const table = parseTable(
      'First name\tLast name\tDepartment\r\nJane\tDoe\tSales\r\nJohn\tRoe\t\r\n',
    );
    expect(table).toEqual({
      delimiter: '\t',
      header: ['First name', 'Last name', 'Department'],
      rows: [
        ['Jane', 'Doe', 'Sales'],
        ['John', 'Roe', ''],
      ],
      rowNumbers: [2, 3],
      problems: [],
    });
  });

  it.each([
    [',', 'First,Last,Dept\nJane,Doe,Sales'],
    [';', 'First;Last;Dept\nJane;Doe;Sales'],
    ['|', 'First|Last|Dept\nJane|Doe|Sales'],
  ])('detects %j from the header row', (delimiter, text) => {
    const table = parseTable(text);
    expect(table.delimiter).toBe(delimiter);
    expect(table.rows).toEqual([['Jane', 'Doe', 'Sales']]);
  });

  it('prefers the delimiter the header uses over one inside a cell', () => {
    expect(parseTable('"Doe, Jane";Dept\n"Roe, John";Sales').delimiter).toBe(';');
  });

  it('reads quoted fields: delimiters, doubled quotes and line breaks inside', () => {
    const table = parseTable(
      'Name,Description\n"Doe, Jane","Says ""hi"""\n"Roe, John","Two\nlines"\n',
    );
    expect(table.rows).toEqual([
      ['Doe, Jane', 'Says "hi"'],
      ['Roe, John', 'Two\nlines'],
    ]);
  });

  it('reads cells Excel quotes in a paste', () => {
    expect(parseTable('A\tB\n"one\ttab"\t"multi\nline"').rows).toEqual([
      ['one\ttab', 'multi\nline'],
    ]);
  });

  it('drops a byte-order mark, blank lines and padding, and trims cells', () => {
    const table = parseTable('﻿First , Last\n\n Jane ,Doe\n,\n');
    expect(table.header).toEqual(['First', 'Last']);
    expect(table.rows).toEqual([['Jane', 'Doe']]);
    // As the spreadsheet numbers them, blank rows included.
    expect(table.rowNumbers).toEqual([3]);
  });

  it('pads a short row and reports a row with more cells than the header', () => {
    const table = parseTable('First,Last,Dept\nJane,Doe\nJohn,Roe,Sales,Extra\nAmy,Ash,IT,');
    expect(table.rows).toEqual([
      ['Jane', 'Doe', ''],
      ['John', 'Roe', 'Sales'],
      ['Amy', 'Ash', 'IT'],
    ]);
    expect(table.problems).toEqual([
      'Row 3 has 4 cells but the header row has 3. Check its quotes and separators.',
    ]);
  });

  it('reports a quote left open', () => {
    expect(parseTable('A,B\n"open,x\n').problems).toEqual([
      'A quote opened in row 2 is never closed.',
    ]);
  });

  it('reads nothing from blank text', () => {
    expect(parseTable('  \n ')).toEqual({
      delimiter: ',',
      header: [],
      rows: [],
      rowNumbers: [],
      problems: [],
    });
  });
});

describe('parseTable, choosing the delimiter', () => {
  it('picks the delimiter that keeps the rows as wide as the header', () => {
    const table = parseTable('Name, first;Name, last\nJane;Doe\nJohn;Roe');
    expect(table.delimiter).toBe(';');
    expect(table.header).toEqual(['Name, first', 'Name, last']);
    expect(table.rows).toEqual([
      ['Jane', 'Doe'],
      ['John', 'Roe'],
    ]);
  });

  it('follows a sep= line, which the spreadsheet doesn’t count as a row', () => {
    const table = parseTable('sep=;\r\nFirst;Last,ish\r\nJane;Doe');
    expect(table.delimiter).toBe(';');
    expect(table.header).toEqual(['First', 'Last,ish']);
    expect(table.rowNumbers).toEqual([2]);
  });

  it('refuses characters a file’s encoding lost', () => {
    expect(parseTable('First,Last\nZo�,Doe\nAnn,Ash').problems).toEqual([
      'Row 2 has characters that couldn’t be read (shown as �). Save the sheet as “CSV UTF-8” and use that file.',
    ]);
  });
});
