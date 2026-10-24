// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { parseTable } from './csv.js';
import { NOTHING_TAKEN, resolveNames, type NamingSuggestion } from './naming.js';
import {
  IMPORT_FIELDS,
  importRequestSchema,
  type ImportPerson,
  type PlacementRule,
} from './schemas/userImport.js';
import { approvalKey } from './userCreation.js';
import {
  ALL_ROWS_BUCKET,
  bucketsOf,
  existingPerson,
  guessMapping,
  importRowRequest,
  importTemplateCsv,
  importValues,
  lookupsOf,
  mappingProblems,
  namingRequestOf,
  readStartDate,
  readUsageLocation,
  resolveManager,
  reviewImportRow,
  ruleFor,
  startingPlacement,
  type ImportRowContext,
  type ImportValues,
} from './userImport.js';

const NAMING = { pattern: '{first}.{last}', upnSuffix: 'corp.test' };
const OU = 'OU=Staff,DC=corp,DC=test';

const row = (over: Partial<ImportValues> = {}): ImportValues => ({
  ...(Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ''])) as ImportValues),
  first: 'Jane',
  last: 'Doe',
  ...over,
});

const person = (over: Partial<ImportPerson> = {}): ImportPerson => ({
  id: '11111111-1111-4111-8111-111111111111',
  distinguishedName: `CN=Jane Doe,${OU}`,
  samAccountName: 'jdoe',
  userPrincipalName: 'jdoe@corp.test',
  displayName: 'Jane Doe',
  employeeId: null,
  addresses: [],
  ...over,
});

function suggestionFor(values: ImportValues, taken = NOTHING_TAKEN): NamingSuggestion {
  return resolveNames([namingRequestOf(values, OU)!], NAMING, taken)[0]!;
}

const ctx = (values: ImportValues, over: Partial<ImportRowContext> = {}): ImportRowContext => ({
  suggestion: namingRequestOf(values, OU) ? suggestionFor(values) : null,
  approved: new Set(),
  people: [],
  manager: { kind: 'none' },
  phoneCountry: 'GB',
  ...over,
});

describe('guessMapping', () => {
  it.each([
    ['Last Name', 'last'],
    ['Surname', 'last'],
    ['sn', 'last'],
    ['given_name', 'first'],
    ['Forename', 'first'],
    ['E-mail', 'email'],
    ['Job Title', 'title'],
    ['Dept.', 'department'],
    ['Mobile Phone', 'mobile'],
    ['Line manager', 'manager'],
    ['Hire date', 'startDate'],
    ['Country', 'usageLocation'],
    ['Employee No.', 'employeeId'],
    ['Known as', 'preferredFirst'],
  ])('reads %j as %s', (header, field) => {
    expect(guessMapping([header])).toEqual([field]);
  });

  it('leaves a header it doesn’t know out, and gives each field to one column', () => {
    expect(guessMapping(['First', 'Shoe size', 'Surname', 'Last name'])).toEqual([
      'first',
      null,
      'last',
      null,
    ]);
  });

  it('maps every column of the template, with nothing to fix', () => {
    const { header } = parseTable(importTemplateCsv());
    const mapping = guessMapping(header);
    expect(mapping).toEqual([...IMPORT_FIELDS]);
    expect(mappingProblems(mapping)).toEqual([]);
  });
});

describe('mappingProblems', () => {
  it('needs the first and last name columns', () => {
    expect(mappingProblems(['first', 'email'])).toEqual(['Choose the last name column.']);
    expect(mappingProblems(['email'])).toEqual(['Choose the first name and last name column.']);
  });

  it('refuses two columns as one field', () => {
    expect(mappingProblems(['first', 'last', 'department', 'department'])).toEqual([
      'More than one column is Department. Pick one.',
    ]);
  });
});

describe('importValues', () => {
  it('reads cells by field, blank for what isn’t mapped', () => {
    const v = importValues(['Jane', 'x', 'Doe'], ['first', null, 'last']);
    expect(v.first).toBe('Jane');
    expect(v.last).toBe('Doe');
    expect(v.department).toBe('');
  });
});

describe('readStartDate', () => {
  it.each([
    ['2026-11-03', '2026-11-03'],
    ['2026/11/3', '2026-11-03'],
    ['2026-11-03 00:00:00', '2026-11-03'],
    ['3 Nov 2026', '2026-11-03'],
    ['3rd November 2026', '2026-11-03'],
    ['Nov 3, 2026', '2026-11-03'],
    ['25/12/2026', '2026-12-25'],
    ['12/25/2026', '2026-12-25'],
    ['4/4/2026', '2026-04-04'],
    ['', null],
  ])('reads %j', (input, value) => {
    expect(readStartDate(input)).toEqual({ value, problem: null });
  });

  it('asks which date a day and month that could swap mean', () => {
    expect(readStartDate('03/04/2026')).toEqual({
      value: null,
      problem: '“03/04/2026” could be 3 April or 4 March. Write it as 2026-04-03 or 2026-03-04.',
    });
  });

  it.each(['soon', '2026-02-30', '13/13/2026'])('refuses %j', (input) => {
    expect(readStartDate(input).problem).toMatch(/isn’t a date/);
  });
});

describe('readUsageLocation', () => {
  it('takes a two-letter code or an English country name', () => {
    expect(readUsageLocation('gb').value).toBe('GB');
    expect(readUsageLocation('United Kingdom').value).toBe('GB');
    expect(readUsageLocation('Narnia').problem).toMatch(/isn’t a country/);
  });
});

describe('existingPerson', () => {
  const people = [
    person({ employeeId: 'E100' }),
    person({ id: '22222222-2222-4222-8222-222222222222', addresses: ['john.roe@corp.test'] }),
  ];

  it('matches by employee ID when the row has one, and only by it', () => {
    expect(existingPerson(row({ employeeId: 'e100' }), people)?.by).toBe('employeeId');
    expect(existingPerson(row({ employeeId: 'E200', email: 'john.roe@corp.test' }), people)).toBe(
      null,
    );
  });

  it('matches by email otherwise, against mail, proxy addresses and the UPN', () => {
    expect(existingPerson(row({ email: 'John.Roe@corp.test' }), people)?.person.id).toBe(
      people[1]!.id,
    );
    expect(existingPerson(row({ email: 'jdoe@corp.test' }), people)?.person.id).toBe(people[0]!.id);
  });

  it('asks for each row’s match key and each manager', () => {
    expect(
      lookupsOf([
        row({ employeeId: 'E1', email: 'a@x.test' }),
        row({ email: 'b@x.test', manager: 'boss' }),
      ]),
    ).toEqual({ employeeIds: ['E1'], identifiers: ['b@x.test', 'boss'] });
  });
});

describe('resolveManager', () => {
  const batch = [
    { index: 0, email: 'ann@corp.test', upn: 'ann.ash@corp.test', samAccountName: 'ann.ash' },
    { index: 1, email: null, upn: 'bo.bell@corp.test', samAccountName: 'bo.bell' },
  ];
  const boss = person({ samAccountName: 'boss', addresses: ['boss@corp.test'] });

  it('finds the manager in the import first, by email, UPN or sAMAccountName', () => {
    expect(resolveManager('ANN@corp.test', 1, batch, [])).toEqual({ kind: 'row', index: 0 });
    expect(resolveManager('bo.bell', 0, batch, [])).toEqual({ kind: 'row', index: 1 });
  });

  it('then in the directory', () => {
    expect(resolveManager('boss', 0, batch, [boss])).toEqual({ kind: 'directory', person: boss });
    expect(resolveManager('boss@corp.test', 0, batch, [boss])).toMatchObject({ kind: 'directory' });
  });

  it('warns about a manager nobody is, or more than one person is', () => {
    expect(resolveManager('ghost', 0, batch, [])).toMatchObject({
      kind: 'unresolved',
      message: expect.stringMatching(/^Nobody in this import or the directory is “ghost”/),
    });
    expect(resolveManager('boss', 0, batch, [boss, { ...boss, id: 'other' }])).toMatchObject({
      kind: 'unresolved',
      message: expect.stringMatching(/^More than one person/),
    });
    expect(resolveManager('ann.ash', 0, batch, [])).toMatchObject({ kind: 'unresolved' });
    expect(resolveManager('', 0, batch, [])).toEqual({ kind: 'none' });
  });
});

describe('reviewImportRow', () => {
  it('is ready when nothing deviates', () => {
    const v = row();
    expect(reviewImportRow(v, ctx(v))).toMatchObject({
      status: 'ready',
      blockers: [],
      unapproved: [],
    });
  });

  it('waits for the naming check and the lookup', () => {
    const v = row();
    expect(reviewImportRow(v, ctx(v, { suggestion: null })).status).toBe('pending');
    expect(reviewImportRow(v, ctx(v, { people: null })).status).toBe('pending');
  });

  it('holds a truncation until it’s approved', () => {
    const v = row({ first: 'Maximiliana', last: 'Featherstonehaugh' });
    const c = ctx(v);
    const truncated = c.suggestion!.deviations.filter((d) => d.kind === 'truncated');
    expect(truncated).toHaveLength(1);
    expect(reviewImportRow(v, c)).toMatchObject({ status: 'unapproved', unapproved: truncated });
    const approved = new Set(truncated.map(approvalKey));
    expect(reviewImportRow(v, { ...c, approved }).status).toBe('ready');
  });

  it('holds a collision suffix until it’s approved', () => {
    const v = row();
    const c = ctx(v, {
      suggestion: suggestionFor(v, { ...NOTHING_TAKEN, samAccountNames: ['jane.doe'] }),
    });
    const [collision] = c.suggestion!.deviations;
    expect(collision).toMatchObject({ kind: 'collision', approval: 'individual' });
    expect(reviewImportRow(v, c).status).toBe('unapproved');
    expect(reviewImportRow(v, { ...c, approved: new Set([approvalKey(collision!)]) }).status).toBe(
      'ready',
    );
  });

  it('shows a normalization without holding the row', () => {
    const v = row({ first: 'Zoë' });
    const c = ctx(v);
    expect(c.suggestion!.deviations).toEqual([expect.objectContaining({ kind: 'normalized' })]);
    expect(reviewImportRow(v, c).status).toBe('ready');
  });

  it('blocks a CN taken along with its fallback', () => {
    const v = row();
    const c = ctx(v, {
      suggestion: suggestionFor(v, {
        ...NOTHING_TAKEN,
        cns: [
          { ouDn: OU, cn: 'Jane Doe' },
          { ouDn: OU, cn: 'Jane Doe (jane.doe)' },
        ],
      }),
    });
    expect(reviewImportRow(v, c)).toMatchObject({
      status: 'blocked',
      blockers: [expect.stringMatching(/both already exist in this OU/)],
    });
  });

  it('warns about a phone number it can’t read, and an unresolved manager, without holding the row', () => {
    const v = row({ mobile: '12', officePhone: '020 7946 0000' });
    const review = reviewImportRow(
      v,
      ctx(v, { manager: { kind: 'unresolved', message: 'No manager.' } }),
    );
    expect(review.status).toBe('ready');
    expect(review.warnings).toEqual([expect.stringMatching(/“12”/), 'No manager.']);
    expect(review.phones.telephoneNumber.value).toBe('+44 2079460000');
  });

  it('skips a row that is someone already in the directory', () => {
    const v = row({ employeeId: 'E100' });
    const review = reviewImportRow(v, ctx(v, { people: [person({ employeeId: 'E100' })] }));
    expect(review.status).toBe('skipped');
    expect(review.existing).toMatchObject({ by: 'employeeId', value: 'E100' });
  });

  it('blocks values AD can’t take', () => {
    const v = row({
      email: 'not-an-address',
      department: 'x'.repeat(65),
      usageLocation: 'Narnia',
      startDate: '03/04/2026',
    });
    expect(reviewImportRow(v, ctx(v)).blockers).toEqual([
      'Department is longer than AD allows (64 characters).',
      'Email “not-an-address” isn’t an email address.',
      expect.stringMatching(/“Narnia” isn’t a country/),
      expect.stringMatching(/could be 3 April or 4 March/),
    ]);
  });

  it('blocks a row without both names', () => {
    const v = row({ last: '' });
    expect(reviewImportRow(v, ctx(v))).toMatchObject({
      status: 'blocked',
      blockers: ['A first and a last name are both needed.'],
    });
  });
});

describe('importRowRequest', () => {
  it('builds a row the import’s schema takes', () => {
    const v = row({
      middleInitial: 'Quentin',
      email: 'jane@corp.test',
      title: 'Engineer',
      department: 'Engineering',
      mobile: '07400 123456',
      usageLocation: 'gb',
      startDate: '3 Nov 2026',
      employeeId: 'E7',
    });
    const c = ctx(v);
    const request = importRowRequest({
      line: 2,
      values: v,
      review: reviewImportRow(v, c),
      suggestion: c.suggestion!,
      ouDn: OU,
      groups: ['33333333-3333-4333-8333-333333333333'],
      manager: { kind: 'directory', person: person() },
    });
    expect(request).toMatchObject({
      initials: 'Q',
      samAccountName: 'jane.doe',
      mobile: '+44 7400123456',
      usageLocation: 'GB',
      startDate: '2026-11-03',
      organisation: { title: 'Engineer', department: 'Engineering', managerId: person().id },
    });
    expect(
      importRequestSchema.safeParse({
        rows: [request],
        password: { mode: 'random' },
        enabled: true,
        mailFromUpn: true,
      }).success,
    ).toBe(true);
  });
});

describe('buckets', () => {
  const values = [
    row({ department: 'Sales' }),
    row({ department: '' }),
    row({ department: 'sales ' }),
    row({ department: 'Engineering' }),
  ];

  it('groups rows by a column’s value, blanks last', () => {
    expect(bucketsOf(values, [0, 1, 2, 3], 'department')).toEqual([
      { key: 'engineering', label: 'Engineering', rows: [3] },
      { key: 'sales', label: 'Sales', rows: [0, 2] },
      { key: '', label: '(blank)', rows: [1] },
    ]);
  });

  it('moves a row to another bucket, keeping the one it left', () => {
    expect(bucketsOf(values, [0, 1, 2, 3], 'department', { 3: 'sales', 1: 'nowhere' })).toEqual([
      { key: 'engineering', label: 'Engineering', rows: [] },
      { key: 'sales', label: 'Sales', rows: [0, 2, 3] },
      { key: '', label: '(blank)', rows: [1] },
    ]);
  });

  it('puts every row in one bucket when not grouped', () => {
    expect(bucketsOf(values, [0, 2], null)).toEqual([
      { key: ALL_ROWS_BUCKET, label: 'All rows', rows: [0, 2] },
    ]);
  });

  const rule: PlacementRule = {
    column: 'department',
    value: 'Sales',
    ouDn: 'OU=Sales,DC=corp,DC=test',
    groups: [{ id: 'g1', name: 'Sales team' }],
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: 'oa.operator',
  };

  it('finds the placement rule for a bucket’s value in the column grouped by', () => {
    expect(ruleFor([rule], 'department', { key: 'sales' })).toBe(rule);
    expect(ruleFor([rule], 'office', { key: 'sales' })).toBe(null);
    expect(ruleFor([rule], null, { key: 'sales' })).toBe(null);
  });

  it('starts a bucket where its rule says, or in the OU the import started from', () => {
    expect(startingPlacement(rule, null)).toEqual({ ouDn: rule.ouDn, groups: rule.groups });
    expect(startingPlacement(rule, OU)).toEqual({ ouDn: OU, groups: rule.groups });
    expect(startingPlacement(null, null)).toEqual({ ouDn: null, groups: [] });
  });
});

describe('namingRequestOf', () => {
  it('leaves out a row the check can’t take, which its values block anyway', () => {
    expect(namingRequestOf(row({ last: '' }), OU)).toBe(null);
    expect(namingRequestOf(row({ first: 'x'.repeat(65) }), OU)).toBe(null);
    const v = row({ first: 'x'.repeat(65) });
    expect(reviewImportRow(v, ctx(v)).status).toBe('blocked');
  });

  it('sends the display name column as typed', () => {
    expect(namingRequestOf(row({ displayName: 'Dr Jane Doe' }), OU)?.overrides).toMatchObject({
      displayName: 'Dr Jane Doe',
    });
  });
});
