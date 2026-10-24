// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAMING_PATTERN,
  type NamingDeviation,
  type NamingSettings,
  type TakenNames,
  namingLookups,
  namingPatternProblem,
  resolveNames,
  suggestNames,
} from './naming.js';

const settings: NamingSettings = { pattern: DEFAULT_NAMING_PATTERN, upnSuffix: 'example.com' };
const noneTaken: TakenNames = {
  samAccountNames: [],
  userPrincipalNames: [],
  mailAddresses: [],
  cns: [],
};
const kinds = (deviations: NamingDeviation[]) => deviations.map((d) => d.kind);

describe('suggestNames', () => {
  it('builds every name from the default pattern', () => {
    expect(suggestNames({ first: 'John', last: 'Smith' }, settings)).toEqual({
      samAccountName: 'john.smith',
      upnLocal: 'john.smith',
      upn: 'john.smith@example.com',
      mail: 'john.smith@example.com',
      cn: 'John Smith',
      displayName: 'John Smith',
      deviations: [],
    });
  });

  it('uses the legal first name for the username and the preferred one for display', () => {
    const s = suggestNames({ first: 'Robert', last: 'Jones', preferredFirst: 'Bob' }, settings);
    expect(s.samAccountName).toBe('robert.jones');
    expect(s.displayName).toBe('Bob Jones');
    expect(s.cn).toBe('Bob Jones');
  });

  it('renders each token with literal separators', () => {
    const name = { first: 'John', last: 'Smith', middleInitial: 'Q' };
    const sam = (pattern: string) => suggestNames(name, { ...settings, pattern }).samAccountName;
    expect(sam('{f}{last}')).toBe('jsmith');
    expect(sam('{last}{f}')).toBe('smithj');
    expect(sam('{first}_{l}')).toBe('john_s');
    expect(sam('{first}.{mi}.{last}')).toBe('john.q.smith');
    expect(sam('ext-{first}.{last}')).toBe('ext-john.smith');
  });

  it('closes up the separators around a missing middle initial', () => {
    const s = suggestNames(
      { first: 'John', last: 'Smith' },
      { ...settings, pattern: '{first}.{mi}.{last}' },
    );
    expect(s.samAccountName).toBe('john.smith');
  });

  it('takes the middle initial from a middle name or "Q."', () => {
    const pattern = { ...settings, pattern: '{f}{mi}{last}' };
    expect(
      suggestNames({ first: 'John', last: 'Smith', middleInitial: 'Quincy' }, pattern)
        .samAccountName,
    ).toBe('jqsmith');
    const dotted = suggestNames({ first: 'John', last: 'Smith', middleInitial: 'Q.' }, pattern);
    expect(dotted.samAccountName).toBe('jqsmith');
    expect(dotted.deviations).toEqual([]);
  });

  describe('normalization', () => {
    it('strips diacritics, including letters that do not decompose', () => {
      const cases: [string, string][] = [
        ['José', 'jose'],
        ['Zoë', 'zoe'],
        ['Strauß', 'strauss'],
        ['Søren', 'soren'],
        ['Ærø', 'aero'],
        ['Łukasz', 'lukasz'],
        ['Đorđe', 'dorde'],
        ['Þóra', 'thora'],
        ['Œuvre', 'oeuvre'],
      ];
      for (const [first, expected] of cases) {
        expect(suggestNames({ first, last: 'x' }, settings).samAccountName).toBe(`${expected}.x`);
      }
    });

    it('removes apostrophes, keeps hyphens and closes up multi-part surnames', () => {
      expect(suggestNames({ first: 'Sean', last: "O'Brien" }, settings).samAccountName).toBe(
        'sean.obrien',
      );
      expect(suggestNames({ first: 'Anna', last: 'O’Neill' }, settings).samAccountName).toBe(
        'anna.oneill',
      );
      expect(suggestNames({ first: 'Anna', last: 'van der Berg' }, settings).samAccountName).toBe(
        'anna.vanderberg',
      );
      expect(suggestNames({ first: 'Ann-Marie', last: 'Lee-Hall' }, settings).samAccountName).toBe(
        'ann-marie.lee-hall',
      );
    });

    it('reports each normalization with its reason, without asking for approval', () => {
      const s = suggestNames({ first: 'José', last: "D'Ávila de la Cruz" }, settings);
      expect(s.samAccountName).toBe('jose.daviladelacruz');
      expect(s.deviations).toEqual([
        {
          kind: 'normalized',
          field: 'first',
          rules: ['diacritics'],
          from: 'José',
          to: 'jose',
          approval: 'none',
          reason: 'Accents are removed: "José" becomes "jose".',
        },
        {
          kind: 'normalized',
          field: 'last',
          rules: ['diacritics', 'apostrophes', 'spaces'],
          from: "D'Ávila de la Cruz",
          to: 'daviladelacruz',
          approval: 'none',
          reason:
            'Accents, apostrophes and spaces are removed: "D\'Ávila de la Cruz" becomes "daviladelacruz".',
        },
      ]);
    });

    it('does not report lowercasing on its own', () => {
      expect(suggestNames({ first: 'JOHN', last: 'SMITH' }, settings).deviations).toEqual([]);
    });

    it('drops characters a username cannot hold, and asks for approval', () => {
      const s = suggestNames({ first: 'John', last: 'Smith, Jr. [3]' }, settings);
      expect(s.samAccountName).toBe('john.smithjr');
      const dropped = s.deviations.find((d) => d.kind === 'dropped');
      expect(dropped).toEqual({
        kind: 'dropped',
        field: 'last',
        characters: [',', '.', '[', '3', ']'],
        from: 'Smith, Jr. [3]',
        to: 'smithjr',
        approval: 'individual',
        reason: 'Characters a username can\'t use are dropped from "Smith, Jr. [3]": , . [ 3 ]',
      });
      // The spaces are a normalization, reported separately.
      expect(kinds(s.deviations)).toEqual(['normalized', 'dropped']);
    });

    it('drops every character sAMAccountName forbids, emoji and control characters', () => {
      const s = suggestNames({ first: 'A"/\\[]:;|=,+*?<>@b', last: 'C😀\u0007d' }, settings);
      expect(s.samAccountName).toBe('ab.cd');
      expect(s.deviations.filter((d) => d.kind === 'dropped')).toHaveLength(2);
    });

    it('cannot build a username from a name with no usable letters', () => {
      const s = suggestNames({ first: '李', last: '王' }, settings);
      expect(s.samAccountName).toBe('');
      expect(s.deviations.at(-1)).toMatchObject({ kind: 'unusable', approval: 'blocked' });
    });

    it('reports nothing for a name the pattern only takes an initial from', () => {
      const s = suggestNames(
        { first: 'Émile', last: 'Smith' },
        { ...settings, pattern: '{f}{last}' },
      );
      expect(s.samAccountName).toBe('esmith');
      expect(s.deviations).toEqual([]);
    });

    it('reports an initial lost to dropped characters', () => {
      const s = suggestNames({ first: '李', last: 'Smith' }, { ...settings, pattern: '{f}{last}' });
      expect(s.samAccountName).toBe('smith');
      expect(s.deviations).toEqual([expect.objectContaining({ kind: 'dropped', field: 'first' })]);
    });
  });

  describe('truncation', () => {
    it('trims only the sAMAccountName, keeping the full pattern in the UPN and mail', () => {
      const s = suggestNames({ first: 'Christopher', last: 'Vanderberg' }, settings);
      expect(s.samAccountName).toBe('christopher.vanderbe');
      expect(s.upnLocal).toBe('christopher.vanderberg');
      expect(s.upn).toBe('christopher.vanderberg@example.com');
      expect(s.mail).toBe('christopher.vanderberg@example.com');
      expect(s.deviations).toEqual([
        {
          kind: 'truncated',
          from: 'christopher.vanderberg',
          to: 'christopher.vanderbe',
          approval: 'together',
          reason:
            'sAMAccountName is limited to 20 characters, so "christopher.vanderberg" becomes "christopher.vanderbe". The UPN and email keep the full name.',
        },
      ]);
    });

    it('drops hyphenated surname parts from the right before trimming', () => {
      const s = suggestNames({ first: 'Christopher', last: 'Lee-Vanderberg-Smith' }, settings);
      expect(s.samAccountName).toBe('christopher.lee');
      expect(s.upnLocal).toBe('christopher.lee-vanderberg-smith');
    });

    it('keeps the first name when the surname comes first', () => {
      const s = suggestNames(
        { first: 'Christopher', last: 'Montgomery-Smith' },
        { ...settings, pattern: '{last}.{first}' },
      );
      expect(s.samAccountName).toBe('montgome.christopher');
    });

    it('trims the first name once the surname is down to its initial', () => {
      const s = suggestNames(
        { first: 'Bartholomewsonnnnnn', last: 'Smith' },
        { ...settings, pattern: '{first}.{last}' },
      );
      expect(s.samAccountName).toBe('bartholomewsonnnnn.s');
    });
  });
});

describe('resolveNames', () => {
  const taken = (over: Partial<TakenNames>): TakenNames => ({ ...noneTaken, ...over });

  it('gives a name taken in the directory the lowest free suffix, everywhere', () => {
    const [s] = resolveNames(
      [{ name: { first: 'John', last: 'Smith' } }],
      settings,
      taken({
        samAccountNames: ['John.Smith', 'john.smith3'],
        mailAddresses: ['john.smith2@example.com'],
      }),
    );
    expect(s).toMatchObject({
      samAccountName: 'john.smith4',
      upnLocal: 'john.smith4',
      upn: 'john.smith4@example.com',
      mail: 'john.smith4@example.com',
    });
    expect(s!.deviations).toEqual([
      {
        kind: 'collision',
        source: 'directory',
        taken: ['samAccountName'],
        suffix: 4,
        from: 'john.smith',
        to: 'john.smith4',
        approval: 'individual',
        reason:
          'The sAMAccountName "john.smith" is already used in the directory. Adding 4 makes it unique; the UPN and email get the same suffix (john.smith4@example.com).',
      },
    ]);
  });

  it('suffixes a UPN or mail collision even when the sAMAccountName is free', () => {
    const [s] = resolveNames(
      [{ name: { first: 'John', last: 'Smith' } }],
      settings,
      taken({ userPrincipalNames: ['JOHN.SMITH@example.com'] }),
    );
    expect(s!.samAccountName).toBe('john.smith2');
    expect(s!.deviations[0]).toMatchObject({ kind: 'collision', taken: ['userPrincipalName'] });
  });

  it('ignores a UPN with another suffix', () => {
    const [s] = resolveNames(
      [{ name: { first: 'John', last: 'Smith' } }],
      settings,
      taken({ userPrincipalNames: ['john.smith@other.example'] }),
    );
    expect(s!.samAccountName).toBe('john.smith');
  });

  it('suffixes the second of two people in one batch', () => {
    const results = resolveNames(
      [
        { name: { first: 'John', last: 'Smith' } },
        { name: { first: 'Jane', last: 'Doe' } },
        { name: { first: 'John', last: 'Smith' } },
      ],
      settings,
      noneTaken,
    );
    expect(results.map((s) => s.samAccountName)).toEqual(['john.smith', 'jane.doe', 'john.smith2']);
    expect(results[2]!.deviations[0]).toMatchObject({
      kind: 'collision',
      source: 'batch',
      reason:
        'The sAMAccountName "john.smith", UPN "john.smith@example.com" and email "john.smith@example.com" are already taken by another person in this list. Adding 2 makes them unique; the UPN and email get the same suffix (john.smith2@example.com).',
    });
  });

  it('keeps a suffixed sAMAccountName within 20 characters', () => {
    const [s] = resolveNames(
      [{ name: { first: 'Christopher', last: 'Vanderberg' } }],
      settings,
      taken({ samAccountNames: ['christopher.vanderbe'] }),
    );
    expect(s!.samAccountName).toBe('christopher.vanderb2');
    expect(s!.upnLocal).toBe('christopher.vanderberg2');
    expect(kinds(s!.deviations)).toEqual(['truncated', 'collision']);
  });

  it('suffixes two names that differ only past the 20th character', () => {
    const results = resolveNames(
      [
        { name: { first: 'Christopher', last: 'Vanderberg' } },
        { name: { first: 'Christopher', last: 'Vanderbeek' } },
      ],
      settings,
      noneTaken,
    );
    expect(results.map((s) => [s.samAccountName, s.upnLocal])).toEqual([
      ['christopher.vanderbe', 'christopher.vanderberg'],
      ['christopher.vanderb2', 'christopher.vanderbeek2'],
    ]);
  });

  it('names a CN that collides in the target OU after its username, without blocking', () => {
    const ou = 'OU=Staff,DC=example,DC=com';
    const results = resolveNames(
      [
        { name: { first: 'John', last: 'Smith' }, ouDn: ou },
        { name: { first: 'John', last: 'Smith' }, ouDn: 'OU=Other,DC=example,DC=com' },
      ],
      settings,
      taken({
        samAccountNames: ['john.smith'],
        cns: [{ ouDn: ou.toUpperCase(), cn: 'john smith' }],
      }),
    );
    expect(results[0]).toMatchObject({ cn: 'John Smith (john.smith2)', displayName: 'John Smith' });
    expect(results[0]!.deviations.at(-1)).toEqual({
      kind: 'cn_collision',
      source: 'directory',
      from: 'John Smith',
      to: 'John Smith (john.smith2)',
      approval: 'none',
      reason:
        '"John Smith" already exists in this OU, so the account is named "John Smith (john.smith2)".',
    });
    expect(results[1]!.cn).toBe('John Smith');
  });

  it('catches a CN collision within the batch', () => {
    const ou = 'OU=Staff,DC=example,DC=com';
    const results = resolveNames(
      [
        { name: { first: 'John', last: 'Smith' }, ouDn: ou },
        { name: { first: 'John', last: 'Smith' }, ouDn: ou },
      ],
      settings,
      noneTaken,
    );
    expect(results.map((s) => s.cn)).toEqual(['John Smith', 'John Smith (john.smith2)']);
    expect(results[1]!.deviations.at(-1)).toMatchObject({ kind: 'cn_collision', source: 'batch' });
  });

  it('leaves an unusable name alone', () => {
    const [s] = resolveNames([{ name: { first: '李', last: '王' } }], settings, noneTaken);
    expect(s!.samAccountName).toBe('');
    expect(kinds(s!.deviations)).not.toContain('collision');
  });
});

describe('namingLookups', () => {
  it('asks for every value a suffixed candidate could take', () => {
    const lookups = namingLookups(
      [
        { name: { first: 'Christopher', last: 'Montgomery-Smith' }, ouDn: 'OU=Staff,DC=x' },
        { name: { first: 'John', last: 'Smith' } },
      ],
      { ...settings, pattern: '{last}.{first}' },
    );
    // Shorter budgets drop the hyphenated part, so only the shared start is safe.
    expect(lookups.samAccountNamePrefixes).toEqual(['montg', 'smith.john']);
    expect(lookups.upnLocalPrefixes).toEqual(['montgomery-smith.christopher', 'smith.john']);
    expect(lookups.cns).toEqual([{ ouDn: 'OU=Staff,DC=x', cn: 'Christopher Montgomery-Smith' }]);
  });
});

describe('namingPatternProblem', () => {
  it('accepts the documented tokens with literal separators', () => {
    for (const p of ['{first}.{last}', '{f}{last}', '{first}.{mi}.{last}', 'ext-{f}_{l}']) {
      expect(namingPatternProblem(p)).toBeNull();
    }
  });

  it('rejects unknown tokens, missing names and unusable separators', () => {
    expect(namingPatternProblem('{first}.{surname}')).toMatch(/\{surname\}/);
    expect(namingPatternProblem('{mi}')).toMatch(/first or last name/);
    expect(namingPatternProblem('{first} {last}')).toMatch(/letters, digits/);
    expect(namingPatternProblem('{first}.{last')).toMatch(/letters, digits/);
    expect(namingPatternProblem('')).toMatch(/first or last name/);
  });
});
