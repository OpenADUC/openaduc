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

  it('keeps "Last, First" whole, alone or one per line', () => {
    expect(parsePastedList('Doe, Jane')).toEqual(['Doe, Jane']);
    expect(parsePastedList('Doe, Jane\nSmith, Bob')).toEqual(['Doe, Jane', 'Smith, Bob']);
  });

  it('leaves a comma list of names to the server, which splits it when the whole matches nobody', () => {
    expect(parsePastedList('jdoe, bsmith,cjones')).toEqual(['jdoe, bsmith,cjones']);
  });

  it('splits on semicolons, also between comma lists', () => {
    expect(parsePastedList('jdoe; bsmith;\ncjones')).toEqual(['jdoe', 'bsmith', 'cjones']);
    expect(parsePastedList('Doe, Jane; Smith, Bob')).toEqual(['Doe, Jane', 'Smith, Bob']);
    expect(parsePastedList('jdoe, bsmith; cjones')).toEqual(['jdoe, bsmith', 'cjones']);
  });

  it('strips stray commas and semicolons around entries', () => {
    expect(parsePastedList(',jdoe,\n;bsmith;;\n , ')).toEqual(['jdoe', 'bsmith']);
  });

  it('splits addresses on commas, also a list wrapped across lines', () => {
    expect(parsePastedList('a@example.com, b@example.com,\nc@example.com')).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
    expect(parsePastedList('jdoe, bsmith,\ncjones')).toEqual(['jdoe, bsmith', 'cjones']);
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

  it("doesn't split addresses inside double quotes", () => {
    expect(parsePastedList('"Doe, Jane" <jane@example.com>, bob@example.com')).toEqual([
      '"Doe, Jane" <jane@example.com>',
      'bob@example.com',
    ]);
  });

  describe('rows copied from a spreadsheet', () => {
    it('take the cell with an address', () => {
      expect(parsePastedList('Jane Doe\tSales\tjane@example.com\r\n')).toEqual([
        'jane@example.com',
      ]);
    });

    it('take a cell that looks like a logon name when there is no address', () => {
      expect(parsePastedList('Jane Doe\tSales\tCORP\\jdoe\nBob Smith\tb.smith\tSales')).toEqual([
        'CORP\\jdoe',
        'b.smith',
      ]);
    });

    it('take the first filled cell otherwise', () => {
      expect(parsePastedList('\tJane Doe\tSales\nBob Smith\tSales')).toEqual([
        'Jane Doe',
        'Bob Smith',
      ]);
    });
  });

  it('drops invisible characters and reads accents in one Unicode form', () => {
    expect(parsePastedList('﻿jdoe​\nJosé')).toEqual(['jdoe', 'José']);
  });

  it('drops blanks and exact repeats, leaving case to the server', () => {
    expect(parsePastedList('jdoe\n\n  \njdoe\nbsmith\njdoe \nJDOE')).toEqual([
      'jdoe',
      'bsmith',
      'JDOE',
    ]);
  });

  it('reads nothing from an empty paste', () => {
    expect(parsePastedList(' \n\t\n')).toEqual([]);
  });
});
