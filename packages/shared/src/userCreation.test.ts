// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { suggestNames, type NamingDeviation, type NamingSuggestion } from './naming.js';
import type { UserCopySource } from './schemas/userCreate.js';
import {
  RANDOM_MODE_MUST_CHANGE_NOTE,
  approvalKey,
  copyToForm,
  phonesToWrite,
  planNewUser,
  type NewUserForm,
  type NewUserPlanContext,
} from './userCreation.js';

const OU = 'OU=Staff,DC=example,DC=com';
const form = (over: Partial<NewUserForm> = {}): NewUserForm => ({
  ouDn: OU,
  first: 'Jane',
  last: 'Doe',
  middleInitial: '',
  preferredFirst: '',
  personalEmail: '',
  mobile: '',
  telephoneNumber: '',
  mailFromUpn: true,
  passwordMode: 'random',
  password: '',
  mustChange: true,
  enabled: true,
  ...over,
});
const jane = suggestNames(
  { first: 'Jane', last: 'Doe' },
  { pattern: '{first}.{last}', upnSuffix: 'example.com' },
);
const ctx = (over: Partial<NewUserPlanContext> = {}): NewUserPlanContext => ({
  suggestion: jane,
  approved: new Set(),
  policy: { minPwdLength: 8, complexityRequired: true },
  phoneCountry: 'GB',
  canAddGroups: true,
  ...over,
});
const withDeviation = (d: NamingDeviation): NamingSuggestion => ({ ...jane, deviations: [d] });
const collision: NamingDeviation = {
  kind: 'collision',
  source: 'directory',
  taken: ['samAccountName'],
  changed: ['samAccountName'],
  suffix: 2,
  from: 'jane.doe',
  to: 'jane.doe2',
  approval: 'individual',
  reason: 'taken',
};

describe('planNewUser', () => {
  it('builds the request from the form and the suggested names', () => {
    const plan = planNewUser(
      form({ personalEmail: ' jane@example.org ', mobile: '07400 123456' }),
      ctx(),
    );
    expect(plan.request).toEqual({
      ouDn: OU,
      givenName: 'Jane',
      surname: 'Doe',
      displayName: 'Jane Doe',
      cn: 'Jane Doe',
      samAccountName: 'jane.doe',
      userPrincipalName: 'jane.doe@example.com',
      mailFromUpn: true,
      personalEmail: 'jane@example.org',
      mobile: '+44 7400123456',
      telephoneNumber: null,
      keepPhonesAsTyped: [],
      password: { mode: 'random' },
      enabled: true,
    });
    expect(plan).toMatchObject({ incomplete: false, blockers: [], warnings: [] });
  });

  it('forces must-change off in random mode, saying why', () => {
    const plan = planNewUser(form({ mustChange: true }), ctx());
    expect(plan.mustChange).toBe(false);
    expect(plan.mustChangeNote).toBe(RANDOM_MODE_MUST_CHANGE_NOTE);
    expect(plan.passwordChecks).toEqual([]);
  });

  it('sends a typed or generated password with must-change once it meets the policy', () => {
    const weak = planNewUser(form({ passwordMode: 'set', password: 'short' }), ctx());
    expect(weak.request).toBeNull();
    expect(weak.incomplete).toBe(true);
    expect(weak.passwordChecks.filter((c) => !c.met).map((c) => c.rule)).toEqual([
      'length',
      'categories',
    ]);

    const named = planNewUser(form({ passwordMode: 'set', password: 'Jane.Doe-2024' }), ctx());
    expect(named.passwordChecks.find((c) => c.rule === 'names')?.met).toBe(false);

    const good = planNewUser(
      form({ passwordMode: 'generate', password: 'Gen3rated-Pass!x' }),
      ctx(),
    );
    expect(good.request?.password).toEqual({
      mode: 'generate',
      password: 'Gen3rated-Pass!x',
      mustChange: true,
    });
    expect(good.mustChangeNote).toBeNull();
  });

  it('waits for an OU, both names and the naming check', () => {
    for (const plan of [
      planNewUser(form({ ouDn: null }), ctx()),
      planNewUser(form({ last: ' ' }), ctx()),
      planNewUser(form(), ctx({ suggestion: null })),
    ]) {
      expect(plan).toMatchObject({ request: null, incomplete: true, blockers: [] });
    }
  });

  it('holds a deviation that needs approving until it’s approved', () => {
    const suggestion = withDeviation(collision);
    const waiting = planNewUser(form(), ctx({ suggestion }));
    expect(waiting.request).toBeNull();
    expect(waiting.unapproved).toEqual([collision]);

    const approved = planNewUser(
      form(),
      ctx({ suggestion, approved: new Set([approvalKey(collision)]) }),
    );
    expect(approved.unapproved).toEqual([]);
    expect(approved.request).not.toBeNull();
  });

  it('blocks on a blocked deviation, beside the field it’s about', () => {
    const plan = planNewUser(
      form(),
      ctx({
        suggestion: withDeviation({
          kind: 'taken',
          attribute: 'samAccountName',
          source: 'directory',
          value: 'jane.doe',
          approval: 'blocked',
          reason: 'The sAMAccountName "jane.doe" is already used in the directory.',
        }),
      }),
    );
    expect(plan.request).toBeNull();
    expect(plan.blockers).toEqual([
      {
        field: 'samAccountName',
        message: 'The sAMAccountName "jane.doe" is already used in the directory.',
      },
    ]);
  });

  it('blocks a personal email that isn’t one', () => {
    const plan = planNewUser(form({ personalEmail: 'jane at home' }), ctx());
    expect(plan.blockers).toEqual([
      { field: 'personalEmail', message: '“jane at home” isn’t an email address.' },
    ]);
  });

  it('writes phone numbers Entra’s way, and only warns about ones it can’t read', () => {
    const plan = planNewUser(
      form({ mobile: '020 7946 0958', telephoneNumber: 'ask reception' }),
      ctx(),
    );
    expect(plan.request).toMatchObject({
      mobile: '+44 2079460958',
      telephoneNumber: 'ask reception',
      keepPhonesAsTyped: ['telephoneNumber'],
    });
    expect(plan.warnings.map((w) => w.field)).toEqual(['mobile', 'telephoneNumber']);
    expect(plan.mobile.warning).toContain('landline');
  });
});

describe('copying a user', () => {
  const ALICE = '0b0f2a8e-1111-4c1d-9f00-00000000a11c';
  const BOB = '0b0f2a8e-1111-4c1d-9f00-0000000000b0';
  const ENGINEERING = '0b0f2a8e-2222-4c1d-9f00-0000000000e1';
  const ALL_STAFF = '0b0f2a8e-2222-4c1d-9f00-0000000000a5';
  const DOMAIN_ADMINS = '0b0f2a8e-2222-4c1d-9f00-0000000000da';
  const OPERATORS = '0b0f2a8e-2222-4c1d-9f00-00000000000b';
  const source: UserCopySource = {
    source: {
      id: ALICE,
      distinguishedName: `CN=Alice Anders,${OU}`,
      samAccountName: 'alice.anders',
      displayName: 'Alice Anders',
    },
    ouDn: OU,
    organisation: {
      title: 'Engineer',
      department: 'Engineering',
      company: 'OpenADUC Ltd',
      physicalDeliveryOfficeName: 'Leeds',
      streetAddress: '1 Park Row\r\nFloor 2',
      l: 'Leeds',
      st: null,
      postalCode: 'LS1 5AB',
      c: 'GB',
      co: 'United Kingdom',
    },
    manager: { id: BOB, distinguishedName: `CN=Bob Baker,${OU}`, displayName: 'Bob Baker' },
    groups: [
      {
        id: ENGINEERING,
        name: 'Engineering',
        distinguishedName: 'CN=Engineering',
        privilege: null,
      },
      { id: ALL_STAFF, name: 'All Staff', distinguishedName: 'CN=All Staff', privilege: null },
      {
        id: DOMAIN_ADMINS,
        name: 'Domain Admins',
        distinguishedName: 'CN=Domain Admins',
        privilege: { reason: 'protected' },
      },
      {
        id: OPERATORS,
        name: 'OpenADUC Operators',
        distinguishedName: 'CN=OpenADUC Operators',
        privilege: { reason: 'role', role: 'operator' },
      },
    ],
  };
  // The operator names the new person; everything else comes from the copy.
  const copyOf = (over: Partial<NewUserForm> = {}) =>
    form({
      personalEmail: '',
      mobile: '',
      telephoneNumber: '',
      ...copyToForm(source),
      ...over,
    });

  it('starts in the source’s OU, with its organisation and groups, and none of its own details', () => {
    const start = copyToForm(source);

    expect(start).toEqual({
      ouDn: OU,
      copiedFrom: ALICE,
      organisation: { ...source.organisation, managerId: BOB },
      groups: [ENGINEERING, ALL_STAFF],
    });
    // Names, email, phones, employee IDs and description are the new person's.
    for (const key of [
      'first',
      'last',
      'preferredFirst',
      'personalEmail',
      'mobile',
      'telephoneNumber',
      'password',
    ]) {
      expect(start).not.toHaveProperty(key);
    }
    expect(JSON.stringify(start)).not.toMatch(/alice|employee|description/i);
  });

  it('creates the copy with the organisation, the ticked groups and where it came from', () => {
    const plan = planNewUser(copyOf(), ctx());

    expect(plan.request).toMatchObject({
      ouDn: OU,
      givenName: 'Jane',
      surname: 'Doe',
      samAccountName: 'jane.doe',
      personalEmail: null,
      mobile: null,
      telephoneNumber: null,
      organisation: {
        title: 'Engineer',
        department: 'Engineering',
        company: 'OpenADUC Ltd',
        physicalDeliveryOfficeName: 'Leeds',
        streetAddress: '1 Park Row\r\nFloor 2',
        l: 'Leeds',
        postalCode: 'LS1 5AB',
        c: 'GB',
        co: 'United Kingdom',
        managerId: BOB,
      },
      groups: [ENGINEERING, ALL_STAFF],
      copiedFrom: ALICE,
    });
    // An attribute the source doesn't have isn't written at all.
    expect(plan.request?.organisation).not.toHaveProperty('st');
    expect(plan.groups).toEqual([ENGINEERING, ALL_STAFF]);
  });

  it('adds only the groups left ticked, privileged ones only when ticked on purpose', () => {
    const plan = planNewUser(copyOf({ groups: [ALL_STAFF, DOMAIN_ADMINS] }), ctx());
    expect(plan.request?.groups).toEqual([ALL_STAFF, DOMAIN_ADMINS]);

    const none = planNewUser(copyOf({ groups: [] }), ctx());
    expect(none.request).not.toHaveProperty('groups');
  });

  it('adds no groups for an operator who can’t change memberships, and says so', () => {
    const plan = planNewUser(copyOf(), ctx({ canAddGroups: false }));

    expect(plan.request).not.toBeNull();
    expect(plan.request).not.toHaveProperty('groups');
    expect(plan.groups).toEqual([]);
    expect(plan.warnings).toEqual([
      { field: 'groups', message: expect.stringContaining('group memberships') },
    ]);
  });

  it('leaves a plain create without organisation, groups or a source', () => {
    const plan = planNewUser(form(), ctx());
    expect(plan.request).not.toHaveProperty('organisation');
    expect(plan.request).not.toHaveProperty('groups');
    expect(plan.request).not.toHaveProperty('copiedFrom');
  });
});

describe('phonesToWrite', () => {
  it('writes readable numbers Entra’s way, landlines in a mobile included', () => {
    expect(phonesToWrite({ mobile: '020 7946 0958', telephoneNumber: '' }, [], 'GB')).toEqual({
      values: { mobile: '+44 2079460958', telephoneNumber: null },
      problems: [],
    });
  });

  it('refuses an unreadable number unless asked to keep it as typed', () => {
    const refused = phonesToWrite({ telephoneNumber: 'ask reception' }, [], 'GB');
    expect(refused.problems).toEqual([expect.objectContaining({ field: 'telephoneNumber' })]);
    expect(
      phonesToWrite({ telephoneNumber: ' ask reception ' }, ['telephoneNumber'], 'GB'),
    ).toEqual({ values: { mobile: null, telephoneNumber: 'ask reception' }, problems: [] });
  });
});
