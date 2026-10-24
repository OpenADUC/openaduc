// @vitest-environment happy-dom
// SPDX-License-Identifier: BUSL-1.1
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { describe, expect, it } from 'vitest';
import type { BulkJob, BulkJobCounts } from '@openaduc/shared';
import BulkJobPanel from './BulkJobPanel.vue';

function aJob(
  status: BulkJob['status'],
  counts: Partial<BulkJobCounts>,
  more: Partial<BulkJob> = {},
): BulkJob {
  return {
    id: '7',
    action: 'user.disable',
    status,
    pauseReason: null,
    actorDisplayName: 'OpenADUC Operator',
    createdAt: '2026-10-23T10:00:00.000Z',
    finishedAt: null,
    counts: { total: 42, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, ...counts },
    ...more,
  };
}

const panel = (job: BulkJob, failure: string | null = null) =>
  mount(BulkJobPanel, { props: { job, failure }, global: { plugins: [PrimeVue] } });

const text = (page: ReturnType<typeof panel>) => page.text().replace(/\s+/g, ' ');
const buttons = (page: ReturnType<typeof panel>) => page.findAll('button').map((b) => b.text());

describe('the bulk job panel', () => {
  it('shows a running job’s progress, says it carries on, and offers to stop it', async () => {
    const page = panel(aJob('running', { pending: 24, running: 4, succeeded: 12, failed: 2 }));

    expect(text(page)).toContain('Disabling 42 accounts…');
    expect(text(page)).toContain('14 of 42 done. You can leave this page; it carries on.');
    expect(page.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('33');
    expect(buttons(page)).toEqual(['Stop']);

    await page.get('button').trigger('click');
    expect(page.emitted('stop')).toHaveLength(1);
  });

  it('says why a paused job stopped, and offers to continue it', async () => {
    const stepUp = panel(
      aJob('paused', { pending: 30, succeeded: 12 }, { pauseReason: 'step_up_required' }),
    );
    expect(text(stepUp)).toContain('Paused with 12 of 42 done');
    expect(text(stepUp)).toContain('Your elevated session ended. Step up to continue.');
    expect(buttons(stepUp)).toEqual(['Continue', 'Stop']);
    await stepUp.findAll('button')[0]!.trigger('click');
    expect(stepUp.emitted('continue')).toHaveLength(1);

    const restarted = panel(
      aJob('paused', { pending: 30, succeeded: 11, failed: 1 }, { pauseReason: 'interrupted' }),
    );
    expect(text(restarted)).toContain('OpenADUC restarted while it ran.');
  });

  it('reports a result with failures, and offers to retry them', async () => {
    const page = panel(aJob('finished', { succeeded: 40, failed: 2 }));

    expect(text(page)).toContain('Disabled 40 of 42 accounts');
    expect(text(page)).toContain(
      '2 failed. They’re still selected, with the reason under each name.',
    );
    expect(page.find('[role="progressbar"]').exists()).toBe(false);
    expect(buttons(page)).toEqual(['Retry failed', 'Dismiss']);
    await page.findAll('button')[0]!.trigger('click');
    await page.findAll('button')[1]!.trigger('click');
    expect(page.emitted('retry')).toHaveLength(1);
    expect(page.emitted('dismiss')).toHaveLength(1);
  });

  it('reports a full success and a stopped job', () => {
    expect(text(panel(aJob('finished', { total: 1, succeeded: 1 })))).toContain(
      'Disabled 1 account',
    );

    const stopped = panel(aJob('cancelled', { succeeded: 17, skipped: 25 }));
    expect(text(stopped)).toContain('Stopped: disabled 17 of 42 accounts');
    expect(text(stopped)).toContain('25 weren’t changed.');
    expect(buttons(stopped)).toEqual(['Dismiss']);
  });

  it('shows why continuing, retrying or stopping failed', () => {
    expect(text(panel(aJob('paused', { pending: 42 }), 'the job has already stopped'))).toContain(
      'the job has already stopped',
    );
  });
});
