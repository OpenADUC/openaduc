// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  importTemplateCsv,
  resolveNames,
  type ClassTapOptions,
  type ImportCheckResponse,
  type ImportLookupRequest,
  type ImportPerson,
  type ImportRunRequest,
  type NamingCheckRequest,
  type PlacementRule,
  type PlacementRulesSave,
} from '@openaduc/shared';

const NAMING = { pattern: '{first}.{last}', upnSuffix: 'corp.test' };
const NOTHING = { samAccountNames: [], userPrincipalNames: [], mailAddresses: [], cns: [] };
const STAFF = 'OU=Staff,DC=corp,DC=test';
const SALES = 'OU=Sales,DC=corp,DC=test';

let taken = { ...NOTHING } as Parameters<typeof resolveNames>[2];
let people: ImportPerson[] = [];
let rules: PlacementRule[] = [];
const PASSED: ImportCheckResponse = {
  checkedAt: '2026-10-24T00:00:00.000Z',
  problems: [],
  warnings: [],
  protectedGroups: [],
};

const check = vi.fn(async (_id: number, body: NamingCheckRequest) => ({
  naming: NAMING,
  suggestions: resolveNames(
    body.names.map(({ ouDn, overrides, ...name }) => ({ name, ouDn, overrides })),
    NAMING,
    taken,
  ),
}));
const lookup = vi.fn(async (_body: ImportLookupRequest) => ({ people }));
const finalCheck = vi.fn(async () => PASSED);
const runImport = vi.fn(async (_body: ImportRunRequest) => ({ job: { id: '42' } }));
const TAP_POLICY = {
  defaultLifetimeMinutes: 60,
  minLifetimeMinutes: 60,
  maxLifetimeMinutes: 480,
  usableOnceOnly: false,
};
const classTaps = vi.fn(async (): Promise<ClassTapOptions> => ({
  status: 'ready',
  policy: TAP_POLICY,
}));
// Answers with every rule, as the API does.
const saveRules = vi.fn(async (_id: number, body: PlacementRulesSave) => ({
  rules: [...rules, ...body.rules].map((r) => ({
    column: r.column,
    value: r.value,
    ouDn: r.ouDn,
    groups: [],
    updatedAt: '2026-10-24T00:00:00.000Z',
    updatedBy: 'oa.operator',
  })),
  changed: body.rules.length,
}));
vi.mock('../../api/index.js', () => ({
  api: {
    directories: {
      naming: { get: async () => ({ naming: NAMING, upnSuffixes: ['corp.test'] }), check },
      newUsers: {
        get: async () => ({
          newUsers: { mailFromUpn: true, passwordMode: 'random', phoneCountry: 'GB' },
        }),
      },
      policy: async () => ({ policy: { minPwdLength: 8, complexityRequired: true } }),
      placementRules: { get: async () => ({ rules }), save: saveRules },
    },
    users: { import: { lookup, check: finalCheck, run: runImport, classTaps } },
    auth: { logout: async () => ({ ok: true }) },
    groups: { search: async () => ({ rows: [], total: 0 }) },
  },
}));

const { useUserImport } = await import('./useUserImport.js');
const { ApiError } = await import('../../api/client.js');
const { useAuthStore } = await import('../../stores/auth.js');

const SHEET = [
  'First Name\tSurname\tE-mail\tDept\tManager\tEmployee ID',
  'Jane\tDoe\tjane@corp.test\tSales\t\tE1',
  'John\tRoe\tjohn@corp.test\tSales\tjane@corp.test\tE2',
  'Ann\tAsh\tann@corp.test\t\t\tE3',
].join('\n');

const DRAFT_KEY = 'openaduc.userImport.1.u-operator';

function signedIn(capabilities = ['read:user', 'write:user.create', 'write:group.membership']) {
  setActivePinia(createPinia());
  const auth = useAuthStore();
  auth.actor = {
    directoryId: 1,
    actorId: 'u-operator',
    capabilities,
    elevated: { active: true },
  } as never;
  return useUserImport();
}

async function started(startOuDn: string | null = null) {
  const wizard = signedIn();
  await wizard.start(startOuDn);
  return wizard;
}

/** Let the review's debounced checks run and their answers arrive. */
const settled = () => vi.advanceTimersByTimeAsync(500);

/** Paste the sheet and go on to the review. */
async function reviewing(text = SHEET, startOuDn: string | null = STAFF) {
  const wizard = await started(startOuDn);
  wizard.paste(text);
  wizard.next();
  wizard.next();
  await settled();
  return wizard;
}

describe('useUserImport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    taken = { ...NOTHING };
    people = [];
    rules = [];
    check.mockClear();
    lookup.mockClear();
    finalCheck.mockReset().mockResolvedValue(PASSED);
    runImport.mockReset().mockResolvedValue({ job: { id: '42' } });
    saveRules.mockClear();
    classTaps.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('source and columns', () => {
    it('reads pasted rows and guesses each column from its header', async () => {
      const wizard = await started();
      wizard.paste(SHEET);

      expect(wizard.table.value?.delimiter).toBe('\t');
      expect(wizard.draft.mapping).toEqual([
        'first',
        'last',
        'email',
        'department',
        'manager',
        'employeeId',
      ]);
      expect(wizard.preview.value).toHaveLength(3);
      expect(wizard.canContinue.value).toBe(true);
    });

    it('reads a CSV file, and refuses a workbook', async () => {
      const wizard = await started();
      await wizard.readFile(new File(['First,Last\nJane,Doe\n'], 'starters.csv'));
      expect(wizard.table.value?.rows).toEqual([['Jane', 'Doe']]);
      expect(wizard.draft.fileName).toBe('starters.csv');

      await wizard.readFile(new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'starters.xlsx'));
      expect(wizard.sourceError.value).toMatch(/is a workbook. Save it as CSV first/);
    });

    it('takes the template with no column to fix', async () => {
      const wizard = await started();
      wizard.paste(`${importTemplateCsv()}Jane,Doe\n`);
      wizard.next();
      expect(wizard.columnProblems.value).toEqual([]);
      expect(wizard.canContinue.value).toBe(true);
    });

    it('refuses more than 500 rows', async () => {
      const wizard = await started();
      wizard.paste(['First,Last', ...Array.from({ length: 501 }, (_, i) => `A${i},B`)].join('\n'));
      expect(wizard.sourceProblems.value).toEqual([
        'Import up to 500 rows at a time; this has 501. Split it.',
      ]);
      expect(wizard.canContinue.value).toBe(false);
    });

    it('needs the first and last name columns, and gives a field to one column', async () => {
      const wizard = await started();
      wizard.paste(SHEET);
      wizard.next();
      wizard.setMapping(1, null);
      expect(wizard.columnProblems.value).toEqual(['Choose the last name column.']);
      expect(wizard.canContinue.value).toBe(false);

      wizard.setMapping(1, 'first');
      expect(wizard.draft.mapping.slice(0, 2)).toEqual([null, 'first']);
    });

    it('asks the directory nothing before the names are reviewed', async () => {
      const wizard = await started();
      wizard.paste(SHEET);
      wizard.next();
      await settled();
      expect(check).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('review', () => {
    it('checks every row’s names in one request, in its bucket’s OU', async () => {
      const wizard = await reviewing();
      expect(check).toHaveBeenCalledOnce();
      expect(check.mock.calls[0]![1].names).toEqual([
        expect.objectContaining({ first: 'Jane', ouDn: STAFF }),
        expect.objectContaining({ first: 'John', ouDn: STAFF }),
        expect.objectContaining({ first: 'Ann', ouDn: STAFF }),
      ]);
      expect(lookup).toHaveBeenCalledWith({
        employeeIds: ['E1', 'E2', 'E3'],
        identifiers: ['jane@corp.test', 'john@corp.test', 'ann@corp.test'],
      });
      expect(wizard.namesReady.value).toBe(true);
    });

    it('holds truncations until they’re approved, all at once', async () => {
      const wizard = await reviewing(
        ['First,Last', 'Maximiliana,Featherstonehaugh', 'Bartholomew,Montgomery-Smythe'].join('\n'),
      );
      expect(wizard.truncations.value).toHaveLength(2);
      expect(wizard.namesReady.value).toBe(false);

      wizard.approveAllTruncations();
      expect(wizard.unapprovedTruncations.value).toBe(0);
      expect(wizard.namesReady.value).toBe(true);
    });

    it('takes a typed value in place of a truncated one', async () => {
      const wizard = await reviewing('First,Last\nMaximiliana,Featherstonehaugh');
      wizard.setName(0, 'samAccountName', 'mfeather');
      await settled();
      // The UPN keeps the whole name, so nothing is cut any more.
      expect(wizard.truncations.value).toEqual([]);
      expect(wizard.nameValue(0, 'samAccountName')).toBe('mfeather');
      expect(wizard.namesReady.value).toBe(true);
      expect(check).toHaveBeenLastCalledWith(1, {
        names: [
          expect.objectContaining({
            overrides: expect.objectContaining({ samAccountName: 'mfeather' }),
          }),
        ],
      });
    });

    it('holds each collision suffix until it’s approved on its own', async () => {
      taken = { ...NOTHING, samAccountNames: ['jane.doe', 'john.roe'] };
      const wizard = await reviewing();
      expect(wizard.individual.value.map((d) => d.deviation.kind)).toEqual([
        'collision',
        'collision',
      ]);

      wizard.approve(0, wizard.individual.value[0]!.deviation);
      expect(wizard.namesReady.value).toBe(false);
      wizard.approve(1, wizard.individual.value[1]!.deviation);
      expect(wizard.namesReady.value).toBe(true);
    });

    it('shows normalizations without holding the import', async () => {
      const wizard = await reviewing('First,Last\nZoë,Doe');
      expect(wizard.normalizations.value.map((d) => d.deviation.kind)).toEqual(['normalized']);
      expect(wizard.namesReady.value).toBe(true);
    });

    it('skips and lists a row that is someone already in the directory', async () => {
      people = [
        {
          id: 'u-ann',
          distinguishedName: `CN=Ann Ash,${STAFF}`,
          samAccountName: 'ann.ash',
          userPrincipalName: 'ann.ash@corp.test',
          displayName: 'Ann Ash',
          employeeId: 'E3',
          addresses: [],
        },
      ];
      const wizard = await reviewing();
      expect(wizard.skipped.value).toEqual([
        expect.objectContaining({
          row: 2,
          line: 4,
          existing: expect.objectContaining({ by: 'employeeId' }),
        }),
      ]);
      expect(wizard.toCreate.value).toEqual([0, 1]);
    });

    it('blocks a row until it’s fixed or left out', async () => {
      const wizard = await reviewing('First,Last,Email\nJane,Doe,nope\nJohn,Roe,john@corp.test');
      expect(wizard.blockedRows.value).toEqual([
        expect.objectContaining({ line: 2, blockers: ['Email “nope” isn’t an email address.'] }),
      ]);
      expect(wizard.namesReady.value).toBe(false);

      wizard.exclude(0);
      await settled();
      expect(wizard.excludedRows.value).toEqual([expect.objectContaining({ line: 2 })]);
      expect(wizard.namesReady.value).toBe(true);
    });

    it('finds a manager among the rows before the directory', async () => {
      const wizard = await reviewing();
      wizard.next();
      wizard.next();
      expect(wizard.importRequest.value?.rows[1]).toMatchObject({ managerRow: 0 });
    });

    it('warns about a manager nobody is, without holding the row', async () => {
      const wizard = await reviewing('First,Last,Manager\nJane,Doe,ghost@corp.test');
      expect(wizard.warnedRows.value).toEqual([
        expect.objectContaining({ warnings: [expect.stringMatching(/^Nobody in this import/)] }),
      ]);
      expect(wizard.namesReady.value).toBe(true);
    });
  });

  describe('buckets', () => {
    it('groups by department, and needs an OU for the blank bucket too', async () => {
      const wizard = await reviewing(SHEET, null);
      wizard.next();
      expect(wizard.groupBy.value).toBe('department');
      expect(wizard.buckets.value.map((b) => [b.label, b.rows])).toEqual([
        ['Sales', [0, 1]],
        ['(blank)', [2]],
      ]);
      expect(wizard.bucketProblems.value).toEqual([
        'Pick an OU for Sales.',
        'Pick an OU for (blank).',
      ]);

      wizard.setBucketOu('sales', SALES);
      wizard.setBucketOu('', STAFF);
      // The names are checked again in their new OUs first.
      expect(wizard.canContinue.value).toBe(false);
      await settled();
      expect(wizard.canContinue.value).toBe(true);
    });

    it('starts each bucket in the OU the import was started from', async () => {
      const wizard = await reviewing(SHEET, STAFF);
      wizard.next();
      expect(wizard.buckets.value.map((b) => b.placement.ouDn)).toEqual([STAFF, STAFF]);
    });

    it('prefills a bucket from its placement rule', async () => {
      rules = [
        {
          column: 'department',
          value: 'sales',
          ouDn: SALES,
          groups: [{ id: 'g-sales', name: 'Sales team' }],
          updatedAt: '2026-10-01T00:00:00.000Z',
          updatedBy: 'oa.operator',
        },
      ];
      const wizard = await reviewing(SHEET, null);
      wizard.next();
      expect(wizard.buckets.value[0]).toMatchObject({
        label: 'Sales',
        placement: { ouDn: SALES, groups: [{ id: 'g-sales', name: 'Sales team' }] },
        rule: expect.objectContaining({ ouDn: SALES }),
      });
    });

    it('moves a row to another bucket, and checks its names in that OU', async () => {
      const wizard = await reviewing(SHEET, null);
      wizard.next();
      wizard.setBucketOu('sales', SALES);
      wizard.setBucketOu('', STAFF);
      wizard.moveRow(2, 'sales');
      await settled();
      expect(wizard.buckets.value.map((b) => b.rows)).toEqual([[0, 1, 2], []]);
      expect(check.mock.calls.at(-1)![1].names[2]).toMatchObject({ first: 'Ann', ouDn: SALES });
      expect(wizard.bucketProblems.value).toEqual([]);
    });

    it('groups by any mapped column, or not at all', async () => {
      const wizard = await reviewing();
      wizard.next();
      expect(wizard.groupByOptions.value.map((o) => o.value)).toEqual([
        null,
        'first',
        'last',
        'employeeId',
        'email',
        'department',
        'manager',
      ]);
      wizard.setGroupBy(null);
      expect(wizard.buckets.value).toEqual([
        expect.objectContaining({ label: 'All rows', rows: [0, 1, 2] }),
      ]);
    });
  });

  describe('final check', () => {
    async function checkable() {
      const wizard = await reviewing(SHEET, null);
      wizard.next();
      wizard.setBucketOu('sales', SALES);
      wizard.setBucketOu('', STAFF);
      await settled();
      wizard.next();
      wizard.next();
      return wizard;
    }

    it('checks the import against the directory, and saves no placement rules', async () => {
      const wizard = await checkable();
      expect(wizard.draft.step).toBe('check');
      wizard.runCheck();
      await settled();

      expect(finalCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          rows: [
            expect.objectContaining({ line: 2, samAccountName: 'jane.doe', ouDn: SALES }),
            expect.objectContaining({ line: 3, ouDn: SALES, managerRow: 0 }),
            expect.objectContaining({ line: 4, ouDn: STAFF }),
          ],
          password: { mode: 'random' },
          enabled: true,
          mailFromUpn: true,
        }),
      );
      expect(saveRules).not.toHaveBeenCalled();
      expect(wizard.ready.value).toBe(true);
    });

    it('runs the checked import, remembers where each bucket went, and is done with the draft', async () => {
      const wizard = await checkable();
      wizard.run();
      await settled();
      expect(runImport).not.toHaveBeenCalled();

      wizard.runCheck();
      await settled();
      wizard.run();
      await settled();

      expect(runImport).toHaveBeenCalledWith({
        import: wizard.importRequest.value,
        acknowledgeProtected: false,
      });
      expect(saveRules).toHaveBeenCalledWith(1, {
        rules: [
          { column: 'department', value: 'Sales', ouDn: SALES, groupIds: [] },
          { column: 'department', value: '', ouDn: STAFF, groupIds: [] },
        ],
      });
      expect(wizard.startedJobId.value).toBe('42');
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it('checks again when the run finds the directory changed, and saves no rules', async () => {
      const wizard = await checkable();
      wizard.runCheck();
      await settled();
      runImport.mockRejectedValue(
        new ApiError(422, 'unprocessable_entity', 'The import has changed since the final check'),
      );
      finalCheck.mockResolvedValue({
        ...PASSED,
        problems: [{ row: 1, kind: 'taken', message: 'The UPN is now used.' }],
      });
      wizard.run();
      await settled();

      expect(wizard.runError.value).toMatch(/changed since the final check/);
      expect(wizard.checkProblems.value).toEqual([expect.objectContaining({ line: 3 })]);
      expect(wizard.ready.value).toBe(false);
      expect(saveRules).not.toHaveBeenCalled();
      expect(wizard.startedJobId.value).toBeNull();
    });

    it('asks the directory again after a failing check, and any row can be left out', async () => {
      finalCheck.mockResolvedValue({
        ...PASSED,
        problems: [{ row: 1, kind: 'taken', message: 'The UPN is now used.' }],
      });
      const wizard = await checkable();
      const [names, lookups] = [check.mock.calls.length, lookup.mock.calls.length];
      wizard.runCheck();
      await settled();

      expect(check.mock.calls.length).toBe(names + 1);
      expect(lookup.mock.calls.length).toBe(lookups + 1);
      const [problem] = wizard.checkProblems.value;
      expect(problem).toMatchObject({ row: 1, line: 3, name: 'John Roe' });
      expect(wizard.reviews.value.get(1)?.review.status).toBe('ready');

      wizard.exclude(problem!.row!);
      await settled();
      expect(wizard.toCreate.value).toEqual([0, 2]);
      expect(wizard.checkStale.value).toBe(true);
      expect(wizard.checkProblems.value).toHaveLength(1);
    });

    it('lists what the check found, by spreadsheet row, and saves no rules', async () => {
      finalCheck.mockResolvedValue({
        ...PASSED,
        problems: [
          {
            row: 1,
            kind: 'taken',
            message: 'The sAMAccountName “john.roe” is now used in the directory.',
          },
        ],
      });
      const wizard = await checkable();
      wizard.runCheck();
      await settled();

      expect(wizard.checkProblems.value).toEqual([
        expect.objectContaining({ line: 3, name: 'John Roe', kind: 'taken' }),
      ]);
      expect(saveRules).not.toHaveBeenCalled();
      expect(wizard.ready.value).toBe(false);
    });

    it('waits for the operator to acknowledge a group AD protects', async () => {
      finalCheck.mockResolvedValue({
        ...PASSED,
        protectedGroups: [{ id: 'g', name: 'Domain Admins' }],
      });
      const wizard = await checkable();
      wizard.runCheck();
      await settled();
      expect(wizard.ready.value).toBe(false);
      wizard.acknowledgedProtected.value = true;
      expect(wizard.ready.value).toBe(true);
    });

    it('forgets the check when the import changes after it', async () => {
      const wizard = await checkable();
      wizard.runCheck();
      await settled();
      wizard.draft.options.enabled = false;
      expect(wizard.result.value).toBe(null);
      expect(wizard.ready.value).toBe(false);
    });

    it('needs a password that meets the policy in set mode', async () => {
      const wizard = await checkable();
      wizard.back();
      wizard.setPasswordMode('set');
      expect(wizard.canContinue.value).toBe(false);
      wizard.password.value = '=Brand-new-Start9';
      expect(wizard.canContinue.value).toBe(false);
      wizard.password.value = 'Brand-new-Start9';
      expect(wizard.canContinue.value).toBe(true);
    });
  });

  describe('class TAPs', () => {
    const TAPS = ['read:user', 'write:user.create', 'write:user.issueTap'];
    const day = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const SHEET_WITH_STARTS = [
      'First Name\tSurname\tStart date',
      `Jane\tDoe\t${day(5)}`,
      'John\tRoe\t',
    ].join('\n');

    async function atOptions(text = SHEET, capabilities = TAPS) {
      const wizard = signedIn(capabilities);
      await wizard.start(STAFF);
      wizard.paste(text);
      wizard.next();
      wizard.next();
      await settled();
      wizard.next();
      wizard.next();
      await settled();
      return wizard;
    }

    it('issues TAPs for class at one time for everyone, a class’s length and multi-use', async () => {
      const wizard = await atOptions();
      expect(wizard.draft.step).toBe('options');
      expect(wizard.classTapOptions.value).toEqual({ status: 'ready', policy: TAP_POLICY });
      wizard.setClassTap(true);
      expect(wizard.draft.options.classTap).toMatchObject({
        lifetimeMinutes: 240,
        isUsableOnce: false,
      });
      expect(wizard.classTapIssues.value).toEqual([
        { row: null, line: null, name: null, message: 'Choose when class starts.' },
      ]);
      expect(wizard.canContinue.value).toBe(false);

      wizard.draft.options.classTap!.date = day(3);
      wizard.draft.options.classTap!.time = '09:30';
      expect(wizard.classTapIssues.value).toEqual([]);
      expect(wizard.importRequest.value?.classTap).toEqual({
        start: { kind: 'fixed', startsAt: new Date(`${day(3)}T09:30`).toISOString() },
        lifetimeMinutes: 240,
        isUsableOnce: false,
      });

      wizard.draft.options.classTap!.lifetimeMinutes = 600;
      expect(wizard.classTapIssues.value[0]?.message).toContain('1 hour to 8 hours');
      expect(wizard.importRequest.value).toBeNull();
    });

    it('starts each person’s class on their start date, naming rows without one', async () => {
      const wizard = await atOptions(SHEET_WITH_STARTS);
      expect(wizard.startDateMapped.value).toBe(true);
      wizard.setClassTap(true);
      expect(wizard.draft.options.classTap?.byStartDate).toBe(true);
      expect(wizard.classTapIssues.value).toEqual([
        expect.objectContaining({
          line: 3,
          name: 'John Roe',
          message: expect.stringContaining('no start date'),
        }),
      ]);

      wizard.exclude(1);
      await settled();
      expect(wizard.importRequest.value?.classTap?.start).toEqual({
        kind: 'startDate',
        time: '09:00',
        timeZone: wizard.timeZone,
      });
    });

    it('makes every pass one-time when the tenant allows nothing else', async () => {
      classTaps.mockResolvedValueOnce({
        status: 'ready',
        policy: { ...TAP_POLICY, usableOnceOnly: true },
      });
      const wizard = await atOptions();
      wizard.setClassTap(true);
      wizard.draft.options.classTap!.date = day(3);
      wizard.draft.options.classTap!.isUsableOnce = false;
      expect(wizard.multiUseAllowed.value).toBe(false);
      expect(wizard.importRequest.value?.classTap?.isUsableOnce).toBe(true);
    });

    it('isn’t offered to an operator who may not issue a TAP', async () => {
      const wizard = await atOptions(SHEET, ['read:user', 'write:user.create']);
      expect(classTaps).not.toHaveBeenCalled();
      expect(wizard.classTapOptions.value).toBeNull();
      expect(wizard.importRequest.value?.classTap).toBeUndefined();
    });
  });

  describe('draft', () => {
    it('survives a reload, without the typed password', async () => {
      const first = await reviewing(SHEET, null);
      first.next();
      first.setBucketOu('sales', SALES);
      first.setPasswordMode('set');
      first.password.value = 'Brand-new-Start9';
      await settled();

      const again = await started();
      expect(again.draft.step).toBe('buckets');
      expect(again.table.value?.rows).toHaveLength(3);
      expect(again.buckets.value[0]!.placement.ouDn).toBe(SALES);
      expect(again.draft.options.passwordMode).toBe('set');
      expect(again.password.value).toBe('');
      expect(sessionStorage.getItem(DRAFT_KEY)).not.toContain('Brand-new-Start9');
    });

    it('starts afresh from an OU when nothing’s been pasted, and on Start over', async () => {
      const first = await started();
      first.paste(SHEET);
      first.startOver();
      await settled();
      expect(first.table.value).toBe(null);

      const fromOu = await started(SALES);
      expect(fromOu.draft.startOuDn).toBe(SALES);
    });
  });

  describe('review fixes', () => {
    it('blocks an email someone in the directory holds, though the row has an employee ID', async () => {
      people = [
        {
          id: 'u-bob',
          distinguishedName: `CN=Bob Baker,${STAFF}`,
          samAccountName: 'bob.baker',
          userPrincipalName: 'bob.baker@corp.test',
          displayName: 'Bob Baker',
          employeeId: 'E9',
          addresses: ['jane@corp.test'],
        },
      ];
      const wizard = await reviewing();
      expect(wizard.blockedRows.value).toEqual([
        expect.objectContaining({
          line: 2,
          blockers: ['The email “jane@corp.test” is already Bob Baker’s in the directory.'],
        }),
      ]);
    });

    it('blocks an email that is another row’s UPN', async () => {
      const wizard = await reviewing('First,Last,Email\nJane,Doe,\nJohn,Roe,jane.doe@corp.test');
      expect(wizard.blockedRows.value).toEqual([
        expect.objectContaining({
          line: 3,
          blockers: ['The email “jane.doe@corp.test” is row 2’s UPN too.'],
        }),
      ]);
    });

    it('blocks managers that go round in a loop', async () => {
      const wizard = await reviewing(
        'First,Last,Manager\nJane,Doe,john.roe\nJohn,Roe,jane.doe\nAnn,Ash,jane.doe',
      );
      expect(wizard.blockedRows.value.map((b) => b.line)).toEqual([2, 3]);
      expect(wizard.blockedRows.value[0]!.blockers).toEqual([
        'Its managers go round in a loop (rows 2 → 3 → 2). Change a manager, or leave a row out.',
      ]);
    });

    it('keeps a rule the start OU only started with, and replaces one the operator changed', async () => {
      rules = [
        {
          column: 'department',
          value: 'Sales',
          ouDn: SALES,
          groups: [],
          updatedAt: '2026-10-01T00:00:00.000Z',
          updatedBy: 'oa.operator',
        },
      ];
      const wizard = await reviewing(SHEET, STAFF);
      wizard.next();
      expect(wizard.buckets.value.map((b) => [b.label, b.placement.ouDn, b.remember])).toEqual([
        ['Sales', STAFF, 'keep'],
        ['(blank)', STAFF, 'new'],
      ]);
      await wizard.rememberPlacements();
      expect(saveRules).toHaveBeenLastCalledWith(1, {
        rules: [{ column: 'department', value: '', ouDn: STAFF, groupIds: [] }],
      });

      wizard.setBucketOu('sales', STAFF);
      expect(wizard.buckets.value[0]!.remember).toBe('update');
    });

    it('moves buckets not yet placed to the OU a resumed import is started from', async () => {
      const first = await reviewing(SHEET, STAFF);
      first.next();
      first.setBucketOu('sales', STAFF);
      await settled();

      const again = await started(SALES);
      expect(again.draft.startOuDn).toBe(SALES);
      expect(again.buckets.value.map((b) => b.placement.ouDn)).toEqual([STAFF, SALES]);
    });

    it('keeps only the mapped columns in the stored draft, and signing out drops it', async () => {
      const wizard = await started();
      wizard.paste('First,Last,Temp password\nJane,Doe,Secret-123');
      await settled();
      const stored = sessionStorage.getItem(DRAFT_KEY)!;
      expect(stored).toContain('Jane');
      expect(stored).not.toContain('Secret-123');
      expect(stored).not.toContain('Temp password');

      await useAuthStore().logout();
      expect(sessionStorage.getItem(DRAFT_KEY)).toBe(null);
    });

    it('keeps two operators’ drafts apart', async () => {
      const mine = await started();
      mine.paste(SHEET);
      await settled();
      setActivePinia(createPinia());
      const auth = useAuthStore();
      auth.actor = {
        directoryId: 1,
        actorId: 'u-other',
        capabilities: ['write:user.create'],
      } as never;
      const theirs = useUserImport();
      await theirs.start();
      expect(theirs.table.value).toBe(null);
    });

    it('reads a CSV saved in Windows-1252, and refuses characters a file lost', async () => {
      const wizard = await started();
      const bytes = new Uint8Array([
        ...new TextEncoder().encode('First,Last\n'),
        0x5a,
        0x6f,
        0xeb,
        0x2c,
        0x44,
        0x6f,
        0x65,
      ]);
      await wizard.readFile(new File([bytes], 'starters.csv'));
      expect(wizard.table.value?.rows).toEqual([['Zoë', 'Doe']]);

      wizard.paste('First,Last\nZo\uFFFD,Doe');
      expect(wizard.sourceProblems.value).toEqual([expect.stringMatching(/couldn’t be read/)]);
      expect(wizard.canContinue.value).toBe(false);
    });
  });
});
