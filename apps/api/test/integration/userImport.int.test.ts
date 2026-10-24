// SPDX-License-Identifier: BUSL-1.1
import type {
  ImportCheckResponse,
  ImportLookupResponse,
  ImportRequest,
  ImportRow,
  PlacementRulesResponse,
  PlacementRulesSaveResponse,
} from '@openaduc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DC,
  asAdministrator,
  configureDirectory,
  setUserAttribute,
  startApi,
  type TestApi,
  type TestClient,
} from './harness.js';

const TEST_OU = 'OU=OpenADUC Test,DC=openaduc,DC=test';
const STAFF_OU = `OU=Staff,${TEST_OU}`;
const STARTERS_OU = `OU=Import Starters,${TEST_OU}`;

function row(sam: string, over: Partial<ImportRow> = {}): ImportRow {
  const [first, last] = sam.split('.').map((p) => p[0]!.toUpperCase() + p.slice(1)) as [
    string,
    string,
  ];
  return {
    line: 2,
    ouDn: STAFF_OU,
    givenName: first,
    surname: last,
    displayName: `${first} ${last}`,
    cn: `${first} ${last}`,
    samAccountName: sam,
    userPrincipalName: `${sam}@${DC.domain}`,
    ...over,
  };
}

const request = (rows: ImportRow[], over: Partial<ImportRequest> = {}): ImportRequest => ({
  rows,
  password: { mode: 'random' },
  enabled: true,
  mailFromUpn: true,
  ...over,
});

describe('importing users', () => {
  let api: TestApi;
  let operator: TestClient;
  let engineering: string;
  let rulesUrl: string;

  const check = async (body: ImportRequest) => {
    const res = await operator.post('/api/users/import/check', body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ImportCheckResponse>();
  };
  const ruleAudits = () =>
    api.app.db
      .selectFrom('audit_events')
      .select(['action', 'before_json', 'after_json', 'target_type'])
      .where('action', 'like', 'import.placementRule.%')
      .orderBy('id')
      .execute();

  beforeAll(async () => {
    api = await startApi();
    await configureDirectory(api);
    operator = api.client();
    await operator.signIn(api, 'oa.operator');
    await operator.stepUp();
    rulesUrl = `/api/directories/${api.directoryId}/placement-rules`;
    engineering = (await operator.get('/api/groups?q=Engineering'))
      .json<{ rows: { id: string; name: string }[] }>()
      .rows.find((g) => g.name === 'Engineering')!.id;
  });
  afterAll(async () => {
    await asAdministrator((client) => client.del(STARTERS_OU).catch(() => undefined));
    await setUserAttribute('alice.anders', 'employeeID', []).catch(() => undefined);
    await api?.close();
  });

  describe('placement rules', () => {
    it('saves a rule, prefills it, and audits each one added or changed', async () => {
      expect((await operator.get(rulesUrl)).json<PlacementRulesResponse>()).toEqual({ rules: [] });

      const save = async (rules: unknown[]) => {
        const res = await operator.put(rulesUrl, { rules });
        expect(res.statusCode, res.body).toBe(200);
        return res.json<PlacementRulesSaveResponse>();
      };
      const first = await save([
        { column: 'department', value: 'Engineering', ouDn: STAFF_OU, groupIds: [engineering] },
        { column: 'department', value: '', ouDn: STAFF_OU, groupIds: [] },
      ]);
      expect(first.changed).toBe(2);
      expect(first.rules).toEqual([
        expect.objectContaining({ column: 'department', value: '', groups: [] }),
        expect.objectContaining({
          column: 'department',
          value: 'Engineering',
          ouDn: STAFF_OU,
          groups: [{ id: engineering, name: 'Engineering' }],
          updatedBy: `oa.operator@${DC.domain}`,
        }),
      ]);

      // The same value in another case is the same rule; unchanged, it's not audited again.
      expect(
        (
          await save([
            {
              column: 'department',
              value: 'engineering ',
              ouDn: STAFF_OU,
              groupIds: [engineering],
            },
          ])
        ).changed,
      ).toBe(0);
      const moved = await save([
        { column: 'department', value: 'Engineering', ouDn: TEST_OU, groupIds: [] },
      ]);
      expect(moved.changed).toBe(1);
      expect(moved.rules.find((r) => r.value === 'Engineering')).toMatchObject({
        ouDn: TEST_OU,
        groups: [],
      });

      const audits = await ruleAudits();
      expect(audits.map((a) => a.action)).toEqual([
        'import.placementRule.create',
        'import.placementRule.create',
        'import.placementRule.update',
      ]);
      expect(audits[2]).toMatchObject({
        target_type: 'config',
        before_json: {
          column: 'department',
          value: 'Engineering',
          ouDn: STAFF_OU,
          groups: [{ id: engineering, name: 'Engineering' }],
        },
        after_json: { column: 'department', value: 'Engineering', ouDn: TEST_OU, groups: [] },
      });
    });

    it('takes step-up to save, and the create capability to read', async () => {
      const fresh = api.client();
      await fresh.signIn(api, 'oa.operator');
      const res = await fresh.put(rulesUrl, {
        rules: [{ column: 'department', value: 'Sales', ouDn: STAFF_OU, groupIds: [] }],
      });
      expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });

      const auditor = api.client();
      await auditor.signIn(api, 'oa.auditor');
      expect((await auditor.get(rulesUrl)).statusCode).toBe(403);
    });

    it('refuses a group the directory doesn’t have', async () => {
      const res = await operator.put(rulesUrl, {
        rules: [
          {
            column: 'department',
            value: 'Sales',
            ouDn: STAFF_OU,
            groupIds: ['00000000-0000-4000-8000-000000000000'],
          },
        ],
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('lookup', () => {
    it('finds people by employee ID, email, UPN or sAMAccountName, from AD', async () => {
      await setUserAttribute('alice.anders', 'employeeID', ['E-1001']);
      const res = await operator.post('/api/users/import/lookup', {
        employeeIds: ['E-1001'],
        identifiers: ['bob.baker', `nobody@${DC.domain}`],
      });
      expect(res.statusCode, res.body).toBe(200);
      const people = res.json<ImportLookupResponse>().people;
      expect(people.map((p) => p.samAccountName).sort()).toEqual(['alice.anders', 'bob.baker']);
      expect(people.find((p) => p.samAccountName === 'alice.anders')).toMatchObject({
        employeeId: 'E-1001',
        distinguishedName: expect.stringContaining('CN=Alice Anders'),
      });
    });
  });

  describe('final check', () => {
    it('passes an import whose names are free and whose OUs and groups exist', async () => {
      const result = await check(
        request([
          row('ivy.imported', { groups: [engineering] }),
          row('jon.imported', { line: 3, managerRow: 0 }),
        ]),
      );
      expect(result).toMatchObject({ problems: [], warnings: [], protectedGroups: [] });
    });

    it('catches a name taken since the review', async () => {
      // bob.baker exists; the review would have suffixed it.
      const result = await check(request([row('kit.imported'), row('bob.baker', { line: 3 })]));
      expect(result.problems).toEqual([
        expect.objectContaining({
          row: 1,
          kind: 'taken',
          message: 'The sAMAccountName “bob.baker” is now used in the directory.',
        }),
        expect.objectContaining({ row: 1, kind: 'taken', message: expect.stringContaining('UPN') }),
        expect.objectContaining({
          row: 1,
          kind: 'taken',
          message: '“Bob Baker” now exists in its OU.',
        }),
      ]);
    });

    it('catches an OU deleted since the review', async () => {
      await asAdministrator((client) =>
        client.add(STARTERS_OU, {
          objectClass: ['top', 'organizationalUnit'],
          ou: 'Import Starters',
        }),
      );
      const body = request([row('lou.imported', { ouDn: STARTERS_OU })]);
      expect((await check(body)).problems).toEqual([]);

      await asAdministrator((client) => client.del(STARTERS_OU));
      expect((await check(body)).problems).toEqual([
        {
          row: null,
          kind: 'ou_missing',
          message: `The OU “${STARTERS_OU}” no longer exists (1 row goes there).`,
        },
      ]);
    });

    it('catches a missing group, someone already there, and two rows with one name', async () => {
      const result = await check(
        request([
          row('max.imported', { groups: ['00000000-0000-4000-8000-000000000000'] }),
          row('max.imported', { line: 3 }),
          row('ned.imported', { line: 4, employeeId: 'E-1001' }),
        ]),
      );
      // Its sAMAccountName, UPN, email and CN.
      expect(result.problems.map((p) => [p.row, p.kind])).toEqual([
        [1, 'duplicate'],
        [1, 'duplicate'],
        [1, 'duplicate'],
        [1, 'duplicate'],
        [2, 'existing'],
        [null, 'group_missing'],
      ]);
    });

    it('takes step-up', async () => {
      const fresh = api.client();
      await fresh.signIn(api, 'oa.operator');
      const res = await fresh.post('/api/users/import/check', request([row('oz.imported')]));
      expect(res.json()).toMatchObject({ error: { code: 'step_up_required' } });
    });
  });
});
