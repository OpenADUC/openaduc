// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { decodeCsv, isWorkbook } from './csvFile.js';

describe('decodeCsv', () => {
  it('reads UTF-8, its byte-order mark left for the parser', () => {
    expect(decodeCsv(new TextEncoder().encode('Zoë,Müller'))).toBe('Zoë,Müller');
  });

  it('reads a file that isn’t UTF-8 as Windows-1252, as Excel’s plain CSV is', () => {
    // "Zoë,Müller,€" in Windows-1252.
    const bytes = new Uint8Array([
      0x5a, 0x6f, 0xeb, 0x2c, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x2c, 0x80,
    ]);
    expect(decodeCsv(bytes)).toBe('Zoë,Müller,€');
  });
});

describe('isWorkbook', () => {
  it('knows a zip or OLE file by its first bytes', () => {
    expect(isWorkbook(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(true);
    expect(isWorkbook(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(true);
    expect(isWorkbook(new TextEncoder().encode('First,Last'))).toBe(false);
  });
});
