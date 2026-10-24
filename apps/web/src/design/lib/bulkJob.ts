// SPDX-License-Identifier: BUSL-1.1
import type {
  AuditBulkSummary,
  BulkJob,
  BulkJobAction,
  BulkJobCounts,
  BulkJobPauseReason,
  BulkJobStatus,
  BulkJobSubject,
} from '@openaduc/shared';

export const BULK_VERBS: Record<BulkJobAction, { verb: string; ing: string; ed: string }> = {
  'user.disable': { verb: 'Disable', ing: 'Disabling', ed: 'Disabled' },
  'user.enable': { verb: 'Enable', ing: 'Enabling', ed: 'Enabled' },
  'user.unlock': { verb: 'Unlock', ing: 'Unlocking', ed: 'Unlocked' },
  'user.group.add': { verb: 'Add', ing: 'Adding', ed: 'Added' },
  'user.group.remove': { verb: 'Remove', ing: 'Removing', ed: 'Removed' },
};

export const accounts = (n: number): string => (n === 1 ? '1 account' : `${n} accounts`);

/** Groups by name: "Sales", "Sales and HR", or "Sales and 3 other groups". */
export function groupNames(groups: readonly { name: string }[]): string {
  if (groups.length <= 2) return groups.map((g) => g.name).join(' and ');
  return `${groups[0]!.name} and ${groups.length - 1} other groups`;
}

/** Where a job's change goes, said after what it changes: " to Sales", or nothing. */
export function bulkJobTarget(action: BulkJobAction, subject: BulkJobSubject | null): string {
  if (!subject?.groups.length) return '';
  if (action === 'user.group.add') return ` to ${groupNames(subject.groups)}`;
  if (action === 'user.group.remove') return ` from ${groupNames(subject.groups)}`;
  return '';
}

/** Rows got through, whatever their outcome. */
const done = (c: BulkJobCounts): number => c.succeeded + c.failed + c.skipped;
const tally = (c: BulkJobCounts): string => `${c.succeeded} succeeded · ${c.failed} failed`;

/** Still writing, or about to: worth polling often. */
export const bulkJobActive = (job: BulkJob): boolean =>
  job.status === 'queued' || job.status === 'running' || job.counts.running > 0;

/**
 * How each status reads, wherever a job is shown: its label (none once
 * finished) and whether the job still has rows to run.
 */
const STATUS: Record<BulkJobStatus, { label: string | null; open: boolean }> = {
  queued: { label: 'Running', open: true },
  running: { label: 'Running', open: true },
  paused: { label: 'Paused', open: true },
  cancelled: { label: 'Stopped', open: false },
  finished: { label: null, open: false },
};

const PAUSED_BECAUSE: Record<BulkJobPauseReason, string> = {
  step_up_required: 'Your elevated session ended. Step up to continue.',
  interrupted: 'OpenADUC restarted while it ran. Continue to run the rest.',
  directory_unavailable: 'No domain controller could be reached. Continue once it’s back.',
};

/** A running job's own warning: it needs the elevated session to keep going. */
const PAUSES_WHEN =
  'It pauses if your elevated session ends (when idle, or at its time limit); then step up to continue.';

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
  const target = bulkJobTarget(job.action, job.subject);
  const { counts } = job;
  const { label, open } = STATUS[job.status];
  const progress = counts.total === 0 ? 0 : Math.round((done(counts) / counts.total) * 100);
  const failedNote =
    counts.failed === 0
      ? null
      : `${counts.failed} failed. ${counts.failed === 1 ? 'It’s' : 'They’re'} still selected, with the reason under each name.`;
  const afterwards: BulkJobControl[] = counts.failed > 0 ? ['retry', 'dismiss'] : ['dismiss'];

  if (job.status === 'paused') {
    return {
      tone: 'warn',
      title: `${label} with ${done(counts)} of ${counts.total} done`,
      detail: PAUSED_BECAUSE[job.pauseReason ?? 'step_up_required'],
      progress,
      controls: ['continue', 'stop'],
    };
  }
  if (open) {
    return {
      tone: 'info',
      title: `${ing} ${accounts(counts.total)}${target}…`,
      detail: `${done(counts)} of ${counts.total} done. You can leave this page; it carries on. ${PAUSES_WHEN}`,
      progress,
      controls: ['stop'],
    };
  }
  if (label) {
    const skipped = counts.skipped > 0 ? `${counts.skipped} weren’t changed.` : null;
    return {
      tone: 'warn',
      title: `${label}: ${ed.toLowerCase()} ${counts.succeeded} of ${accounts(counts.total)}${target}`,
      detail: [skipped, failedNote].filter(Boolean).join(' ') || null,
      progress: null,
      controls: afterwards,
    };
  }
  return {
    tone: counts.failed > 0 ? 'warn' : 'success',
    title:
      counts.failed > 0
        ? `${ed} ${counts.succeeded} of ${accounts(counts.total)}${target}`
        : `${ed} ${accounts(counts.succeeded)}${target}`,
    detail: failedNote,
    progress: null,
    controls: afterwards,
  };
}

/**
 * A bulk job's heading in the audit log, e.g. "Bulk disable by Jane Doe:
 * 42 users" or "Bulk add to Sales by Jane Doe: 42 users".
 */
export function describeBulkEntry(
  bulk: AuditBulkSummary,
  actor: string | null,
): { title: string; outcome: string | null; tone: 'green' | 'amber' | 'red' | 'muted' } {
  const verb = BULK_VERBS[bulk.action].verb.toLowerCase();
  const users = bulk.total === 1 ? '1 user' : `${bulk.total} users`;
  const target = bulkJobTarget(bulk.action, bulk.subject);
  const title = `Bulk ${verb}${target}${actor ? ` by ${actor}` : ''}: ${users}`;
  const { status, counts } = bulk;
  if (status === null || counts === null) return { title, outcome: null, tone: 'muted' };

  const { label, open } = STATUS[status];
  const failedTone = counts.failed > 0 ? 'red' : null;
  if (open) {
    return { title, outcome: `${label}: ${done(counts)} of ${counts.total} done`, tone: 'amber' };
  }
  return {
    title,
    outcome: label ? `${label}: ${tally(counts)}` : tally(counts),
    tone: failedTone ?? (label ? 'amber' : 'green'),
  };
}
