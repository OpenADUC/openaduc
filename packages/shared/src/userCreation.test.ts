// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from 'vitest';
import { suggestNames, type NamingDeviation, type NamingSuggestion } from './naming.js';
import {
  RANDOM_MODE_MUST_CHANGE_NOTE,
  approvalKey,
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
    });
    expect(plan.warnings.map((w) => w.field)).toEqual(['mobile', 'telephoneNumber']);
    expect(plan.mobile.warning).toContain('landline');
  });
});
