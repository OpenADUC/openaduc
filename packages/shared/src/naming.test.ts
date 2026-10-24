// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NAMING_PATTERN,
  type NamingDeviation,
  type NamingRequest,
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
const taken = (over: Partial<TakenNames>): TakenNames => ({ ...noneTaken, ...over });
const kinds = (deviations: NamingDeviation[]) => deviations.map((d) => d.kind);
const reasons = (deviations: NamingDeviation[]) => deviations.map((d) => d.reason);
const sam = (first: string, last: string, pattern = DEFAULT_NAMING_PATTERN) =>
  suggestNames({ first, last }, { ...settings, pattern }).samAccountName;

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
    const render = (pattern: string) => suggestNames(name, { ...settings, pattern }).samAccountName;
    expect(render('{f}{last}')).toBe('jsmith');
    expect(render('{last}{f}')).toBe('smithj');
    expect(render('{first}_{l}')).toBe('john_s');
    expect(render('{first}.{mi}.{last}')).toBe('john.q.smith');
    expect(render('ext-{first}.{last}')).toBe('ext-john.smith');
  });

  it('closes up the separators around a missing middle initial', () => {
    expect(sam('John', 'Smith', '{first}.{mi}.{last}')).toBe('john.smith');
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
    it('strips accents, including from letters that do not decompose', () => {
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
      for (const [first, expected] of cases) expect(sam(first, 'X')).toBe(`${expected}.x`);
    });

    it('folds ligatures, digraphs and full-width letters to plain ones', () => {
      const ij = suggestNames({ first: 'Ĳsbrand', last: 'Ĳzerman' }, settings);
      expect(ij.samAccountName).toBe('ijsbrand.ijzerman');
      expect(reasons(ij.deviations)).toEqual([
        'Letter forms are simplified: "Ĳsbrand" becomes "IJsbrand".',
        'Letter forms are simplified: "Ĳzerman" becomes "IJzerman".',
      ]);
      expect(sam('ﬁona', 'Smith')).toBe('fiona.smith');
      const wide = suggestNames({ first: 'Ｊｏｈｎ', last: 'Ｓｍｉｔｈ' }, settings);
      expect(wide.samAccountName).toBe('john.smith');
      expect(wide.deviations[0]).toMatchObject({
        kind: 'normalized',
        rule: 'letterforms',
        approval: 'none',
      });
    });

    it('removes apostrophes, periods and spaces, and keeps hyphens', () => {
      expect(sam('Sean', "O'Brien")).toBe('sean.obrien');
      expect(sam('Anna', 'O’Neill')).toBe('anna.oneill');
      expect(sam('Anna', 'van der Berg')).toBe('anna.vanderberg');
      expect(sam('Ann-Marie', 'Lee-Hall')).toBe('ann-marie.lee-hall');
      expect(sam('J.', 'St. John')).toBe('j.stjohn');
    });

    it('reports each step with the values either side of it, without asking for approval', () => {
      const s = suggestNames({ first: 'José', last: "D'Ávila de la Cruz" }, settings);
      expect(s.samAccountName).toBe('jose.daviladelacruz');
      expect(s.deviations.map((d) => [d.kind, d.approval, d.reason])).toEqual([
        ['normalized', 'none', 'Accents are removed: "José" becomes "Jose".'],
        [
          'normalized',
          'none',
          'Accents are removed: "D\'Ávila de la Cruz" becomes "D\'Avila de la Cruz".',
        ],
        [
          'normalized',
          'none',
          'Apostrophes are removed: "D\'Avila de la Cruz" becomes "DAvila de la Cruz".',
        ],
        ['normalized', 'none', 'Spaces are removed: "DAvila de la Cruz" becomes "DAviladelaCruz".'],
      ]);
    });

    it('removes periods as a normalization: "J." and "Jr."', () => {
      const s = suggestNames({ first: 'J.', last: 'Smith Jr.' }, settings);
      expect(s.samAccountName).toBe('j.smithjr');
      expect(s.deviations).toEqual([
        expect.objectContaining({
          rule: 'periods',
          reason: 'Periods are removed: "J." becomes "J".',
        }),
        expect.objectContaining({ rule: 'periods', from: 'Smith Jr.', to: 'Smith Jr' }),
        expect.objectContaining({ rule: 'spaces', from: 'Smith Jr', to: 'SmithJr' }),
      ]);
      expect(s.deviations.every((d) => d.approval === 'none')).toBe(true);
    });

    it('removes invisible characters as a normalization', () => {
      const s = suggestNames({ first: 'Jo​hn', last: 'Smi­th' }, settings);
      expect(s.samAccountName).toBe('john.smith');
      expect(s.deviations.map((d) => [d.kind, d.approval, d.to])).toEqual([
        ['normalized', 'none', 'John'],
        ['normalized', 'none', 'Smith'],
      ]);
    });

    it('does not report lowercasing on its own', () => {
      expect(suggestNames({ first: 'JOHN', last: 'SMITH' }, settings).deviations).toEqual([]);
    });

    it('drops digits and punctuation a username cannot hold, and asks for approval', () => {
      const s = suggestNames({ first: 'John', last: 'Smith, Jr. [3]' }, settings);
      expect(s.samAccountName).toBe('john.smithjr');
      expect(s.deviations.at(-1)).toEqual({
        kind: 'dropped',
        field: 'last',
        what: 'characters',
        characters: [',', '[', '3', ']'],
        from: 'Smith,Jr[3]',
        to: 'SmithJr',
        approval: 'individual',
        reason: 'Characters a username can\'t use are dropped: "Smith,Jr[3]" becomes "SmithJr".',
      });
      expect(kinds(s.deviations)).toEqual(['normalized', 'normalized', 'dropped']);
    });

    it('drops every character sAMAccountName forbids, and emoji', () => {
      const s = suggestNames({ first: 'A"/\\[]:;|=,+*?<>@b', last: 'C😀\u0007d' }, settings);
      expect(s.samAccountName).toBe('ab.cd');
      expect(s.deviations.map((d) => [d.kind, d.approval])).toEqual([
        ['dropped', 'individual'],
        ['normalized', 'none'],
        ['dropped', 'individual'],
      ]);
    });

    it('drops letters outside the Latin alphabet and blocks a name left empty', () => {
      const s = suggestNames({ first: 'Γιώργος', last: 'Papadopoulos' }, settings);
      expect(s.deviations).toEqual([
        {
          kind: 'dropped',
          field: 'first',
          what: 'letters',
          characters: Array.from('Γιώργος'),
          from: 'Γιώργος',
          to: '',
          approval: 'individual',
          reason: 'Letters outside the Latin alphabet are dropped from "Γιώργος", leaving nothing.',
        },
        {
          kind: 'unusable',
          field: 'first',
          approval: 'blocked',
          reason:
            'Nothing is left of the first name "Γιώργος" to build a username from. Enter it in Latin letters.',
        },
      ]);
    });

    it('blocks a name part that is only punctuation', () => {
      const s = suggestNames({ first: "'", last: 'Smith' }, settings);
      expect(s.deviations.map((d) => [d.kind, d.approval, d.reason])).toEqual([
        ['normalized', 'none', 'Apostrophes are removed from "\'", leaving nothing.'],
        [
          'unusable',
          'blocked',
          'Nothing is left of the first name "\'" to build a username from. Enter it in Latin letters.',
        ],
      ]);
    });

    it('reports nothing for a name the pattern only takes an initial from', () => {
      const s = suggestNames(
        { first: 'Émile', last: 'Smith' },
        { ...settings, pattern: '{f}{last}' },
      );
      expect(s.samAccountName).toBe('esmith');
      expect(s.deviations).toEqual([]);
    });

    it('blocks an initial lost to dropped letters', () => {
      const s = suggestNames({ first: '李', last: 'Smith' }, { ...settings, pattern: '{f}{last}' });
      expect(s.deviations.map((d) => [d.kind, d.approval])).toEqual([
        ['dropped', 'individual'],
        ['unusable', 'blocked'],
      ]);
    });
  });

  describe('truncation', () => {
    it('cuts only the sAMAccountName, keeping the full pattern in the UPN and mail', () => {
      const s = suggestNames({ first: 'Christopher', last: 'Vanderberg' }, settings);
      expect(s.samAccountName).toBe('christopher.vanderbe');
      expect(s.upnLocal).toBe('christopher.vanderberg');
      expect(s.upn).toBe('christopher.vanderberg@example.com');
      expect(s.mail).toBe('christopher.vanderberg@example.com');
      expect(s.deviations).toEqual([
        {
          kind: 'truncated',
          attribute: 'samAccountName',
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
      expect(sam('Christopher', 'Montgomery-Smith', '{last}.{first}')).toBe('montgome.christopher');
    });

    it('trims the first name once the surname is down to its initial', () => {
      expect(sam('Bartholomewsonnnnnn', 'Smith')).toBe('bartholomewsonnnnn.s');
    });

    it('cuts a UPN past 64 characters, keeping UPN and mail the same', () => {
      const s = suggestNames(
        {
          first: 'Maximiliana-Alexandrina',
          last: 'Wolfeschlegelsteinhausen-Bergerdorff-Featherstonehaugh',
        },
        settings,
      );
      expect(s.upnLocal).toBe('maximiliana-alexandrina.wolfeschlegelsteinhausen-bergerdorff');
      expect(s.mail).toBe(s.upn);
      expect(s.samAccountName).toBe('maximiliana-alexan.w');
      expect(s.deviations.map((d) => [d.kind, d.approval, d.reason])).toEqual([
        [
          'truncated',
          'together',
          'sAMAccountName is limited to 20 characters, so "maximiliana-alexandrina.wolfeschlegelsteinhausen-bergerdorff-featherstonehaugh" becomes "maximiliana-alexan.w".',
        ],
        [
          'truncated',
          'together',
          'The UPN and email are limited to 64 characters before the @, so "maximiliana-alexandrina.wolfeschlegelsteinhausen-bergerdorff-featherstonehaugh" becomes "maximiliana-alexandrina.wolfeschlegelsteinhausen-bergerdorff".',
        ],
        [
          'truncated',
          'together',
          'The CN is limited to 64 characters, so "Maximiliana-Alexandrina Wolfeschlegelsteinhausen-Bergerdorff-Featherstonehaugh" becomes "Maximiliana-Alexandrina Wolfeschlegelsteinhausen-Bergerdorff-Fea". The display name keeps the full name.',
        ],
      ]);
      expect(s.cn).toHaveLength(64);
      expect(s.displayName).toBe(
        'Maximiliana-Alexandrina Wolfeschlegelsteinhausen-Bergerdorff-Featherstonehaugh',
      );
    });

    it('cuts a display name past 256 characters', () => {
      const s = suggestNames(
        { first: 'Bo', last: 'Smith', preferredFirst: 'B'.repeat(260) },
        settings,
      );
      expect(s.displayName).toBe('B'.repeat(256));
      expect(s.cn).toBe('B'.repeat(64));
      expect(s.deviations.map((d) => d.kind === 'truncated' && d.attribute)).toEqual([
        'displayName',
        'cn',
      ]);
    });
  });
});

describe('resolveNames', () => {
  it('suffixes only the sAMAccountName when only it is taken', () => {
    const [s] = resolveNames(
      [{ name: { first: 'John', last: 'Smith' } }],
      settings,
      taken({
        samAccountNames: ['John.Smith', 'john.smith3'],
        mailAddresses: ['john.smith2@example.com'],
      }),
    );
    expect(s).toMatchObject({
      samAccountName: 'john.smith2',
      upnLocal: 'john.smith',
      upn: 'john.smith@example.com',
      mail: 'john.smith@example.com',
    });
    expect(s!.deviations).toEqual([
      {
        kind: 'collision',
        source: 'directory',
        taken: ['samAccountName'],
        changed: ['samAccountName'],
        suffix: 2,
        from: 'john.smith',
        to: 'john.smith2',
        approval: 'individual',
        reason:
          'The sAMAccountName "john.smith" is already used in the directory. With 2 added it becomes "john.smith2"; the UPN and email are free and stay "john.smith@example.com".',
      },
    ]);
  });

  it('suffixes UPN and mail together when either is taken, and the sAMAccountName with them', () => {
    const [s] = resolveNames(
      [{ name: { first: 'John', last: 'Smith' } }],
      settings,
      taken({ userPrincipalNames: ['JOHN.SMITH@example.com'], samAccountNames: ['john.smith2'] }),
    );
    expect(s).toMatchObject({
      samAccountName: 'john.smith3',
      upn: 'john.smith3@example.com',
      mail: 'john.smith3@example.com',
    });
    expect(s!.deviations).toEqual([
      expect.objectContaining({
        taken: ['userPrincipalName'],
        changed: ['samAccountName', 'userPrincipalName', 'mail'],
        suffix: 3,
        from: 'john.smith',
        to: 'john.smith3',
        approval: 'individual',
        reason:
          'The UPN "john.smith@example.com" is already used in the directory. With 3 added, the UPN and email become "john.smith3@example.com" and the sAMAccountName "john.smith3".',
      }),
    ]);

    const [proxy] = resolveNames(
      [{ name: { first: 'John', last: 'Smith' } }],
      settings,
      taken({ mailAddresses: ['john.smith@example.com'] }),
    );
    expect(proxy).toMatchObject({ samAccountName: 'john.smith2', upn: 'john.smith2@example.com' });
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
    expect(results.map((s) => s.upn)).toEqual([
      'john.smith@example.com',
      'jane.doe@example.com',
      'john.smith2@example.com',
    ]);
    expect(results[2]!.deviations[0]).toMatchObject({
      kind: 'collision',
      source: 'batch',
      reason:
        'The sAMAccountName "john.smith", UPN "john.smith@example.com" and email "john.smith@example.com" are already taken by another person in this list. With 2 added, the UPN and email become "john.smith2@example.com" and the sAMAccountName "john.smith2".',
    });
  });

  it('keeps a suffixed sAMAccountName within 20 characters and the free UPN as it was', () => {
    const [s] = resolveNames(
      [{ name: { first: 'Christopher', last: 'Vanderberg' } }],
      settings,
      taken({ samAccountNames: ['christopher.vanderbe'] }),
    );
    expect(s!.samAccountName).toBe('christopher.vanderb2');
    expect(s!.upnLocal).toBe('christopher.vanderberg');
    expect(kinds(s!.deviations)).toEqual(['truncated', 'collision']);
  });

  it('suffixes the sAMAccountName of two names that differ only past the 20th character', () => {
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
      ['christopher.vanderb2', 'christopher.vanderbeek'],
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
    expect(results[0]).toMatchObject({
      cn: 'John Smith (john.smith2)',
      displayName: 'John Smith',
    });
    expect(results[0]!.deviations.at(-1)).toEqual({
      kind: 'cn_collision',
      source: 'directory',
      from: 'John Smith',
      to: 'John Smith (john.smith2)',
      approval: 'none',
      reason:
        '"John Smith" already exists in this OU, so the account is named "John Smith (john.smith2)".',
    });
    expect(results[1]).toMatchObject({ samAccountName: 'john.smith3', cn: 'John Smith' });
  });

  it('blocks when the bracketed CN is taken too', () => {
    const ou = 'OU=Staff,DC=example,DC=com';
    const [s] = resolveNames(
      [{ name: { first: 'John', last: 'Smith' }, ouDn: ou }],
      settings,
      taken({
        cns: [
          { ouDn: ou, cn: 'John Smith' },
          { ouDn: ou, cn: 'John Smith (john.smith)' },
        ],
      }),
    );
    expect(s!.deviations.at(-1)).toMatchObject({
      kind: 'cn_collision',
      approval: 'blocked',
      reason:
        '"John Smith" and "John Smith (john.smith)" both already exist in this OU. Enter a different name for the account.',
    });
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

  it('cuts a bracketed CN to 64 characters, keeping the brackets whole', () => {
    const ou = 'OU=Staff,DC=example,DC=com';
    const name = { first: 'Maximiliana-Alexandrina', last: 'Wolfeschlegelsteinhausen' };
    const [s] = resolveNames(
      [{ name, ouDn: ou }],
      settings,
      taken({ cns: [{ ouDn: ou, cn: 'Maximiliana-Alexandrina Wolfeschlegelsteinhausen' }] }),
    );
    expect(s!.cn).toBe('Maximiliana-Alexandrina Wolfeschlegelstei (maximiliana-alexan.w)');
    expect(s!.cn).toHaveLength(64);
    expect(s!.deviations.at(-1)).toMatchObject({
      kind: 'truncated',
      attribute: 'cn',
      approval: 'together',
      from: 'Maximiliana-Alexandrina Wolfeschlegelsteinhausen (maximiliana-alexan.w)',
    });
  });

  it('leaves a blocked name alone', () => {
    const [s] = resolveNames(
      [{ name: { first: '李', last: '王' } }],
      settings,
      taken({ samAccountNames: [''] }),
    );
    expect(kinds(s!.deviations)).not.toContain('collision');
    expect(s!.deviations.some((d) => d.approval === 'blocked')).toBe(true);
  });
});

describe('resolveNames with names the operator typed', () => {
  const john = { first: 'John', last: 'Smith' };
  const one = (
    overrides: NamingRequest['overrides'],
    over: Partial<TakenNames> = {},
    ouDn?: string,
  ) =>
    resolveNames([{ name: john, overrides, ...(ouDn ? { ouDn } : {}) }], settings, taken(over))[0]!;

  it('uses a typed sAMAccountName and UPN as they are, with mail following the UPN', () => {
    expect(
      one({ samAccountName: 'jsmith', userPrincipalName: 'john@other.example' }),
    ).toMatchObject({
      samAccountName: 'jsmith',
      upnLocal: 'john',
      upn: 'john@other.example',
      mail: 'john@other.example',
      deviations: [],
    });
  });

  it('takes the sAMAccountName from a typed UPN, cut to 20 characters', () => {
    const s = one({ userPrincipalName: 'john.smith-the-second@example.com' });
    expect(s.samAccountName).toBe('john.smith-the-secon');
    expect(s.deviations).toEqual([
      expect.objectContaining({
        kind: 'truncated',
        attribute: 'samAccountName',
        from: 'john.smith-the-second',
        to: 'john.smith-the-secon',
      }),
    ]);
  });

  it('blocks a typed name already in use instead of suffixing it', () => {
    const s = one(
      { samAccountName: 'jsmith', userPrincipalName: 'john.smith@example.com' },
      { samAccountNames: ['JSMITH'], mailAddresses: ['john.smith@example.com'] },
    );
    expect(s).toMatchObject({ samAccountName: 'jsmith', upn: 'john.smith@example.com' });
    expect(s.deviations).toEqual([
      {
        kind: 'taken',
        attribute: 'samAccountName',
        source: 'directory',
        value: 'jsmith',
        approval: 'blocked',
        reason: 'The sAMAccountName "jsmith" is already used in the directory.',
      },
      expect.objectContaining({
        kind: 'taken',
        attribute: 'mail',
        value: 'john.smith@example.com',
      }),
    ]);
  });

  it('still suffixes the UPN when only the sAMAccountName was typed', () => {
    const s = one({ samAccountName: 'jsmith' }, { userPrincipalNames: ['john.smith@example.com'] });
    expect(s).toMatchObject({ samAccountName: 'jsmith', upn: 'john.smith2@example.com' });
    expect(s.deviations).toEqual([
      expect.objectContaining({
        kind: 'collision',
        changed: ['userPrincipalName', 'mail'],
        reason:
          'The UPN "john.smith@example.com" is already used in the directory. With 2 added, the UPN and email become "john.smith2@example.com".',
      }),
    ]);
  });

  it('blocks names AD or Entra ID can’t hold', () => {
    const blocked = (overrides: NamingRequest['overrides']) =>
      one(overrides)
        .deviations.filter((d) => d.approval === 'blocked')
        .map((d) => d.reason);
    expect(blocked({ samAccountName: 'j[smith]' })).toEqual([
      expect.stringContaining('sAMAccountName "j[smith]" cannot contain'),
    ]);
    expect(blocked({ samAccountName: 'a-very-long-logon-name' })).toEqual([
      'The sAMAccountName "a-very-long-logon-name" is 22 characters; AD allows 20.',
    ]);
    expect(blocked({ userPrincipalName: 'john smith@example.com' })).toEqual([
      expect.stringContaining('Entra ID'),
    ]);
    expect(blocked({ userPrincipalName: 'no-suffix' })).toEqual([
      'The UPN "no-suffix" needs a suffix: name@domain.',
    ]);
  });

  it('blocks a typed UPN suffix the forest doesn’t have, when it’s known', () => {
    const request = [{ name: john, overrides: { userPrincipalName: 'john@elsewhere.example' } }];
    const [s] = resolveNames(request, settings, noneTaken, ['example.com', 'Other.example']);
    expect(s!.deviations).toEqual([
      expect.objectContaining({
        kind: 'unusable',
        attribute: 'userPrincipalName',
        reason:
          '"elsewhere.example" isn\'t one of this domain\'s UPN suffixes (example.com, Other.example).',
      }),
    ]);
    const ok = [{ name: john, overrides: { userPrincipalName: 'john@other.example' } }];
    expect(resolveNames(ok, settings, noneTaken, ['Other.example'])[0]!.deviations).toEqual([]);
  });

  it('drops the pattern’s complaints about a name it no longer builds', () => {
    const s = resolveNames(
      [
        {
          name: { first: '李', last: '王' },
          overrides: { userPrincipalName: 'li.wang@example.com' },
        },
      ],
      settings,
      noneTaken,
    )[0]!;
    expect(s.deviations).toEqual([]);
    expect(s.samAccountName).toBe('li.wang');
  });

  it('names the CN after a typed display name, bracketing the typed sAMAccountName', () => {
    const ou = 'OU=Staff,DC=example,DC=com';
    const s = one(
      { displayName: 'Johnny Smith', samAccountName: 'jsmith' },
      { cns: [{ ouDn: ou, cn: 'Johnny Smith' }] },
      ou,
    );
    expect(s).toMatchObject({ displayName: 'Johnny Smith', cn: 'Johnny Smith (jsmith)' });
  });

  it('catches a typed name another person in the batch already took', () => {
    const results = resolveNames(
      [
        { name: john },
        { name: { first: 'Jo', last: 'Smith' }, overrides: { samAccountName: 'john.smith' } },
      ],
      settings,
      noneTaken,
    );
    expect(results[1]!.deviations).toEqual([
      expect.objectContaining({ kind: 'taken', source: 'batch', attribute: 'samAccountName' }),
    ]);
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
    expect(lookups).toEqual({
      samAccountNamePrefixes: ['montg', 'smith.john'],
      upnLocalPrefixes: ['montgomery-smith.christopher', 'smith.john'],
      cns: [{ ouDn: 'OU=Staff,DC=x', cn: 'Christopher Montgomery-Smith' }],
      cnPrefixes: [{ ouDn: 'OU=Staff,DC=x', cn: 'Christopher Montgomery-Smith (' }],
    });
  });

  it('asks for typed names as typed, and the pattern’s only where it still applies', () => {
    const ouDn = 'OU=Staff,DC=x';
    const name = { first: 'John', last: 'Smith' };
    expect(
      namingLookups(
        [
          {
            name,
            ouDn,
            overrides: { userPrincipalName: 'jay@example.com', displayName: 'Jay Smith' },
          },
          { name, overrides: { samAccountName: 'jsmith' } },
        ],
        settings,
      ),
    ).toEqual({
      samAccountNamePrefixes: ['jay', 'jsmith'],
      upnLocalPrefixes: ['jay', 'john.smith'],
      cns: [{ ouDn, cn: 'Jay Smith' }],
      cnPrefixes: [{ ouDn, cn: 'Jay Smith (' }],
    });
  });

  it('asks for the shared start of a long name’s bracketed CN', () => {
    const lookups = namingLookups(
      [
        {
          name: { first: 'Maximiliana-Alexandrina', last: 'Wolfeschlegelsteinhausen' },
          ouDn: 'OU=Staff,DC=x',
        },
      ],
      settings,
    );
    expect(lookups.cnPrefixes).toEqual([
      { ouDn: 'OU=Staff,DC=x', cn: 'Maximiliana-Alexandrina Wolfeschlegelstei' },
    ]);
  });
});

describe('namingPatternProblem', () => {
  it('accepts the documented tokens with literal separators', () => {
    for (const p of ['{first}.{last}', '{f}{last}', '{first}.{mi}.{last}', 'ext-{f}_{l}']) {
      expect(namingPatternProblem(p), p).toBeNull();
    }
  });

  it('rejects unknown tokens, missing names and unusable separators', () => {
    expect(namingPatternProblem('{first}.{surname}')).toMatch(/\{surname\}/);
    expect(namingPatternProblem('{mi}')).toMatch(/first or last name/);
    expect(namingPatternProblem('{first} {last}')).toMatch(/letters, digits/);
    expect(namingPatternProblem('{first}.{last')).toMatch(/letters, digits/);
    expect(namingPatternProblem('')).toMatch(/first or last name/);
  });

  it('rejects separators in a row, and at either end', () => {
    expect(namingPatternProblem('{first}..{last}')).toMatch(/one separator at a time/);
    expect(namingPatternProblem('{first}.-{last}')).toMatch(/one separator at a time/);
    expect(namingPatternProblem('{first}.')).toMatch(/start or end with a separator/);
    expect(namingPatternProblem('_{last}')).toMatch(/start or end with a separator/);
  });

  it('rejects a trailing digit, which would run into a collision suffix', () => {
    expect(namingPatternProblem('{f}{last}1')).toBe(
      'The pattern can\'t end in a digit: a taken name gets a number on the end, so "smith1" would become "smith12".',
    );
  });
});
