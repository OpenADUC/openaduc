// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { parsePastedList } from './pastedList.js';

describe('parsePastedList', () => {
  it('reads one entry per line, whatever the line ending', () => {
    expect(parsePastedList('jdoe\r\nJane Doe\njane@example.com\r')).toEqual([
      'jdoe',
      'Jane Doe',
      'jane@example.com',
    ]);
  });

  it('splits a single line on commas', () => {
    expect(parsePastedList('jdoe, bsmith,cjones ,  ')).toEqual(['jdoe', 'bsmith', 'cjones']);
  });

  it('splits on semicolons, leaving commas to the names between them', () => {
    expect(parsePastedList('jdoe; bsmith;\ncjones')).toEqual(['jdoe', 'bsmith', 'cjones']);
    expect(parsePastedList('Doe, Jane; Smith, Bob')).toEqual(['Doe, Jane', 'Smith, Bob']);
  });

  it('keeps "Last, First" display names whole when there is one per line', () => {
    expect(parsePastedList('Doe, Jane\nSmith, Bob')).toEqual(['Doe, Jane', 'Smith, Bob']);
  });

  it('splits lines of addresses on commas', () => {
    expect(parsePastedList('a@example.com, b@example.com,\nc@example.com')).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
  });

  it('reads an Outlook recipient line', () => {
    expect(parsePastedList('Doe, Jane <jane@example.com>; Smith, Bob <bob@example.com>;')).toEqual([
      'Doe, Jane <jane@example.com>',
      'Smith, Bob <bob@example.com>',
    ]);
  });

  it('keeps a "Last, First <address>" whole in a comma-separated list', () => {
    expect(parsePastedList('Doe, Jane <jane@example.com>, bob@example.com')).toEqual([
      'Doe, Jane <jane@example.com>',
      'bob@example.com',
    ]);
  });

  it("doesn't split inside double quotes", () => {
    expect(parsePastedList('"Doe, Jane", bsmith')).toEqual(['"Doe, Jane"', 'bsmith']);
  });

  it('takes the first column of rows copied from a spreadsheet', () => {
    expect(parsePastedList('jdoe\tJane Doe\tSales\r\n\tbsmith\tBob Smith\r\n')).toEqual([
      'jdoe',
      'bsmith',
    ]);
  });

  it('drops blanks and repeats, ignoring case', () => {
    expect(parsePastedList('jdoe\n\n  \nJDOE\nbsmith\njdoe ')).toEqual(['jdoe', 'bsmith']);
  });

  it('reads nothing from an empty paste', () => {
    expect(parsePastedList(' \n\t\n')).toEqual([]);
  });
});
