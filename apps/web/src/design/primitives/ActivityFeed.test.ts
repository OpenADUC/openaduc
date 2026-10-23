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
  ...overrides,
});

const feed = (events: AuditEventRow[]) =>
  mount(ActivityFeed, { props: { events }, global: { plugins: [PrimeVue] } });

describe('ActivityFeed', () => {
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
});
