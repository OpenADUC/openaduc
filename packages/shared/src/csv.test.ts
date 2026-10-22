// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from './csv.js';

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
