// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { describe, expect, it } from 'vitest';
import type { AuditEventRow } from '../../api/index.js';
import ActivityFeed from './ActivityFeed.vue';

const anEvent = (overrides: Partial<AuditEventRow>): AuditEventRow => ({
  id: '1',
  timestamp: '2026-01-01T00:00:00.000Z',
  actorUserId: null,
  actorDisplayName: 'OpenADUC Operator',
  actorAuthMethod: null,
  sourceIp: null,
  userAgent: null,
  sessionId: null,
  correlationId: null,
  providerId: 1,
  action: 'user.view',
  result: 'success',
  errorCode: null,
  targetType: null,
  targetId: null,
  targetDn: null,
  before: null,
  after: null,
  metadata: null,
  bulkJobId: null,
  bulk: null,
  ...overrides,
});

const feed = (events: AuditEventRow[]) =>
  mount(ActivityFeed, { props: { events }, global: { plugins: [PrimeVue] } });

describe('ActivityFeed', () => {
  it('names the fields an edit wrote, or says it changed nothing', () => {
    const page = feed([
      anEvent({ id: '1', action: 'user.update', metadata: { fields: ['department', 'title'] } }),
      anEvent({ id: '2', action: 'user.update', metadata: { unchanged: true } }),
      anEvent({ id: '3', action: 'user.update', metadata: { fields: [] } }),
    ]);

    const details = page.findAll('.af-detail').map((d) => d.text());
    expect(details).toEqual(['Fields: department, title', 'Already as asked; nothing changed']);
  });

  it('says which OU a user or computer was moved to', () => {
    const page = feed([
      anEvent({
        id: '1',
        action: 'user.move',
        metadata: { targetOuDn: 'OU=Staff,DC=corp', targetOuName: 'Staff' },
      }),
      anEvent({ id: '2', action: 'computer.move', metadata: { targetOuDn: 'OU=Labs,DC=corp' } }),
    ]);

    const details = page.findAll('.af-detail').map((d) => d.text());
    expect(details).toEqual(['To: Staff', 'To: OU=Labs,DC=corp']);
  });

  it('says a bulk account change left a user already as asked alone', () => {
    const page = feed([
      anEvent({
        id: '1',
        action: 'user.move',
        metadata: { targetOuName: 'Staff', unchanged: true },
      }),
      anEvent({ id: '2', action: 'user.passwordMustChange.set', metadata: { unchanged: true } }),
      anEvent({ id: '3', action: 'user.passwordNeverExpires.clear' }),
    ]);

    expect(page.findAll('.af-title').map((t) => t.text())).toEqual([
      'Moved to OU',
      'Must change password at next sign-in',
      'Password set to expire',
    ]);
    expect(page.findAll('.af-detail').map((d) => d.text())).toEqual([
      'Already as asked; nothing changed',
      'Already as asked; nothing changed',
    ]);
  });

  it('names the writes a revert makes', () => {
    const page = feed([
      anEvent({ id: '1', action: 'user.passwordMustChange.clear' }),
      anEvent({ id: '2', action: 'user.passwordNeverExpires.set' }),
    ]);

    expect(page.findAll('.af-title').map((t) => t.text())).toEqual([
      'No longer must change password',
      'Password set never to expire',
    ]);
  });

  it('names the computer actions', () => {
    const page = feed(
      ['computer.disable', 'computer.enable', 'computer.account.reset'].map((action, i) =>
        anEvent({ id: String(i), action }),
      ),
    );

    expect(page.findAll('.af-title').map((t) => t.text())).toEqual([
      'Computer disabled',
      'Computer enabled',
      'Computer account reset',
    ]);
  });

  it('says when an account was set to expire, or that it never will', () => {
    const page = feed([
      anEvent({
        id: '1',
        action: 'user.accountExpiry.set',
        metadata: { expiresAt: new Date(2031, 2, 1).toISOString() },
      }),
      anEvent({ id: '2', action: 'user.accountExpiry.set', metadata: { expiresAt: null } }),
    ]);

    expect(page.findAll('.af-title').map((t) => t.text())).toEqual([
      'Account expiry changed',
      'Account expiry changed',
    ]);
    expect(page.findAll('.af-detail').map((d) => d.text())).toEqual([
      `Expires at the end of ${new Date(2031, 1, 28).toLocaleDateString()}`,
      'Never expires',
    ]);
  });
});
