// SPDX-License-Identifier: BUSL-1.1
import type { AuditBulkSummary, BulkJob, BulkJobAction } from '@openaduc/shared';

export const BULK_VERBS: Record<BulkJobAction, { verb: string; ing: string; ed: string }> = {
  'user.disable': { verb: 'Disable', ing: 'Disabling', ed: 'Disabled' },
  'user.enable': { verb: 'Enable', ing: 'Enabling', ed: 'Enabled' },
  'user.unlock': { verb: 'Unlock', ing: 'Unlocking', ed: 'Unlocked' },
};

export const accounts = (n: number): string => (n === 1 ? '1 account' : `${n} accounts`);

/** Rows the job has got through, whatever their outcome. */
const bulkJobDone = (job: BulkJob): number =>
  job.counts.succeeded + job.counts.failed + job.counts.skipped;

/** Still writing, or about to: worth polling. */
export const bulkJobActive = (job: BulkJob): boolean =>
  job.status === 'queued' || job.status === 'running' || job.counts.running > 0;

export type BulkJobControl = 'stop' | 'continue' | 'retry' | 'dismiss';

export interface BulkJobDescription {
  tone: 'info' | 'warn' | 'success';
  title: string;
  detail: string | null;
  /** Percent done, while the job has rows left. */
  progress: number | null;
  controls: BulkJobControl[];
}

/** What a bulk job's progress panel says, and which controls it offers. */
export function describeBulkJob(job: BulkJob): BulkJobDescription {
  const { ing, ed } = BULK_VERBS[job.action];
  const { total, succeeded, failed, skipped } = job.counts;
  const done = bulkJobDone(job);
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  const failedNote =
    failed === 0
      ? null
      : `${failed} failed. ${failed === 1 ? 'It’s' : 'They’re'} still selected, with the reason under each name.`;

  switch (job.status) {
    case 'queued':
    case 'running':
      return {
        tone: 'info',
        title: `${ing} ${accounts(total)}…`,
        detail: `${done} of ${total} done. You can leave this page; it carries on.`,
        progress,
        controls: ['stop'],
      };
    case 'paused':
      return {
        tone: 'warn',
        title: `Paused with ${done} of ${total} done`,
        detail:
          job.pauseReason === 'interrupted'
            ? 'OpenADUC restarted while it ran. Continue to run the rest.'
            : 'Your elevated session ended. Step up to continue.',
        progress,
        controls: ['continue', 'stop'],
      };
    case 'cancelled':
      return {
        tone: 'warn',
        title: `Stopped: ${ed.toLowerCase()} ${succeeded} of ${accounts(total)}`,
        detail:
          [skipped > 0 ? `${skipped} weren’t changed.` : null, failedNote]
            .filter(Boolean)
            .join(' ') || null,
        progress: null,
        controls: failed > 0 ? ['retry', 'dismiss'] : ['dismiss'],
      };
    case 'finished':
      return failed === 0
        ? {
            tone: 'success',
            title: `${ed} ${accounts(succeeded)}`,
            detail: null,
            progress: null,
            controls: ['dismiss'],
          }
        : {
            tone: 'warn',
            title: `${ed} ${succeeded} of ${accounts(total)}`,
            detail: failedNote,
            progress: null,
            controls: ['retry', 'dismiss'],
          };
  }
}

/** A bulk job's heading in the audit log, e.g. "Bulk disable by Jane Doe: 42 users". */
export function describeBulkEntry(
  bulk: AuditBulkSummary,
  actor: string | null,
): { title: string; outcome: string | null; tone: 'green' | 'amber' | 'red' | 'muted' } {
  const verb = bulk.action ? BULK_VERBS[bulk.action].verb.toLowerCase() : 'action';
  const users = bulk.total === 1 ? '1 user' : `${bulk.total} users`;
  const title = `Bulk ${verb}${actor ? ` by ${actor}` : ''}: ${users}`;
  const { succeeded, failed } = bulk;
  if (bulk.status === null || succeeded === null || failed === null) {
    return { title, outcome: null, tone: 'muted' };
  }
  const tally = `${succeeded} succeeded · ${failed} failed`;
  const tone = failed > 0 ? 'red' : 'green';
  switch (bulk.status) {
    case 'queued':
    case 'running':
      return {
        title,
        outcome: `Running: ${succeeded + failed} of ${bulk.total} done`,
        tone: 'amber',
      };
    case 'paused':
      return {
        title,
        outcome: `Paused: ${succeeded + failed} of ${bulk.total} done`,
        tone: 'amber',
      };
    case 'cancelled':
      return { title, outcome: `Stopped: ${tally}`, tone: failed > 0 ? 'red' : 'amber' };
    case 'finished':
      return { title, outcome: tally, tone };
  }
}
