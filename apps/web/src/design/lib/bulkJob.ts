// SPDX-License-Identifier: BUSL-1.1
import {
  revertedAction,
  type AuditBulkSummary,
  type BulkJob,
  type BulkJobKind,
  type BulkJobCounts,
  type BulkJobPauseReason,
  type BulkJobStatus,
  type BulkJobSubject,
} from '@openaduc/shared';
import { expiryMoment } from './accountExpiry.js';
import { fieldNames } from './bulkAttributes.js';
import { fmtAbsolute } from './format.js';

export const BULK_VERBS: Record<BulkJobKind, { verb: string; ing: string; ed: string }> = {
  'user.disable': { verb: 'Disable', ing: 'Disabling', ed: 'Disabled' },
  'user.enable': { verb: 'Enable', ing: 'Enabling', ed: 'Enabled' },
  'user.unlock': { verb: 'Unlock', ing: 'Unlocking', ed: 'Unlocked' },
  'user.group.add': { verb: 'Add', ing: 'Adding', ed: 'Added' },
  'user.group.remove': { verb: 'Remove', ing: 'Removing', ed: 'Removed' },
  'user.update': { verb: 'Edit', ing: 'Editing', ed: 'Edited' },
  'user.move': { verb: 'Move', ing: 'Moving', ed: 'Moved' },
  'user.accountExpiry.set': {
    verb: 'Set expiry',
    ing: 'Setting the expiry of',
    ed: 'Set the expiry of',
  },
  'user.passwordMustChange.set': {
    verb: 'Require password change',
    ing: 'Requiring a password change for',
    ed: 'Required a password change for',
  },
  'user.passwordNeverExpires.clear': {
    verb: 'Clear “password never expires”',
    ing: 'Clearing “password never expires” for',
    ed: 'Cleared “password never expires” for',
  },
  'user.passwordMustChange.clear': {
    verb: 'Stop requiring a password change',
    ing: 'Stopping requiring a password change for',
    ed: 'Stopped requiring a password change for',
  },
  'user.passwordNeverExpires.set': {
    verb: 'Set “password never expires”',
    ing: 'Setting “password never expires” for',
    ed: 'Set “password never expires” for',
  },
};

export const accounts = (n: number): string => (n === 1 ? '1 account' : `${n} accounts`);

/** Groups by name: "Sales", "Sales and HR", or "Sales and 3 other groups". */
export function groupNames(groups: readonly { name: string }[]): string {
  if (groups.length <= 2) return groups.map((g) => g.name).join(' and ');
  return `${groups[0]!.name} and ${groups.length - 1} other groups`;
}

/**
 * Where a job's change goes, said after what it changes: " to Sales",
 * " (department and title)" for an edit, " to the end of 3/1/2031" for
 * an expiry, or nothing.
 */
export function bulkJobTarget(action: BulkJobKind, subject: BulkJobSubject | null): string {
  if (action === 'user.update' && subject?.attributes?.length) {
    return ` (${fieldNames(subject.attributes.map((a) => a.field))})`;
  }
  if (action === 'user.move' && subject?.ou) return ` to ${subject.ou.name}`;
  if (action === 'user.accountExpiry.set' && subject && subject.expiresAt !== undefined) {
    return subject.expiresAt === null ? ' to never' : ` to ${expiryMoment(subject.expiresAt)}`;
  }
  if (!subject?.groups?.length) return '';
  if (action === 'user.group.add') return ` to ${groupNames(subject.groups)}`;
  if (action === 'user.group.remove') return ` from ${groupNames(subject.groups)}`;
  return '';
}

/**
 * How a job's progress and result put what it does: "Disabling", " to
 * Sales". A revert says only that it reverts; its audit entry says what.
 */
export function bulkJobWords(job: Pick<BulkJob, 'action' | 'subject' | 'revertsJobId'>): {
  ing: string;
  ed: string;
  target: string;
} {
  if (job.revertsJobId !== null) return { ing: 'Reverting', ed: 'Reverted', target: '' };
  const { ing, ed } = BULK_VERBS[job.action];
  return { ing, ed, target: bulkJobTarget(job.action, job.subject) };
}

/** Rows got through, whatever their outcome. */
const done = (c: BulkJobCounts): number => c.succeeded + c.partial + c.failed + c.skipped;
const tally = (c: BulkJobCounts): string =>
  [
    `${c.succeeded} succeeded`,
    c.partial > 0 ? `${c.partial} partly` : null,
    `${c.failed} failed`,
    c.skipped > 0 ? `${c.skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** Rows that still have changes to make: the ones a retry runs again. */
export const bulkJobProblems = (c: BulkJobCounts): number => c.failed + c.partial;

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

export type BulkJobControl = 'stop' | 'continue' | 'retry' | 'revert' | 'dismiss';

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
  const { ing, ed, target } = bulkJobWords(job);
  const { counts } = job;
  const { label, open } = STATUS[job.status];
  const progress = counts.total === 0 ? 0 : Math.round((done(counts) / counts.total) * 100);
  const problems = bulkJobProblems(counts);
  const failedNote =
    problems === 0
      ? null
      : `${[
          counts.partial > 0
            ? `${counts.partial} ${counts.partial === 1 ? 'was' : 'were'} only partly changed`
            : null,
          counts.failed > 0 ? `${counts.failed} failed` : null,
        ]
          .filter(Boolean)
          .join(' and ')}. ${
          job.revertsJobId === null
            ? `${problems === 1 ? 'It’s' : 'They’re'} still selected, with the reason under each name.`
            : 'The revert’s entry below lists why.'
        }`;
  const afterwards: BulkJobControl[] = [
    ...(problems > 0 ? (['retry'] as const) : []),
    ...(job.revertible ? (['revert'] as const) : []),
    'dismiss',
  ];

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
  // A finished job's skipped rows needed no change (a user already in the group).
  const unchanged = counts.skipped > 0 ? `${counts.skipped} needed no change.` : null;
  return {
    tone: problems > 0 ? 'warn' : 'success',
    title:
      counts.succeeded === counts.total
        ? `${ed} ${accounts(counts.succeeded)}${target}`
        : `${ed} ${counts.succeeded} of ${accounts(counts.total)}${target}`,
    detail: [unchanged, failedNote].filter(Boolean).join(' ') || null,
    progress: null,
    controls: afterwards,
  };
}

/** Whether a revert has got anywhere, as the reverted job's entry says it. */
function revertedNote(revert: NonNullable<AuditBulkSummary['revertedBy']>): string {
  const by = revert.actorDisplayName ? ` by ${revert.actorDisplayName}` : '';
  const on = fmtAbsolute(revert.createdAt);
  if (revert.status === 'cancelled') return `Revert${by} on ${on} was stopped`;
  if (STATUS[revert.status].open) return `Being reverted${by}, since ${on}`;
  return `Reverted${by} on ${on}`;
}

/**
 * A job's heading, e.g. "Bulk disable by Jane Doe: 42 users", "Bulk add to
 * Sales by Jane Doe: 42 users", or "Revert of bulk disable by Jane Doe: 40
 * users".
 */
export function bulkJobTitle(
  job: { action: BulkJobKind; subject: BulkJobSubject | null; revertsJobId: string | null },
  total: number,
  actor: string | null,
): string {
  const action = job.revertsJobId === null ? job.action : revertedAction(job.action);
  const verb = BULK_VERBS[action].verb.toLowerCase();
  const users = total === 1 ? '1 user' : `${total} users`;
  const what = job.revertsJobId === null ? 'Bulk' : 'Revert of bulk';
  return `${what} ${verb}${bulkJobTarget(action, job.subject)}${actor ? ` by ${actor}` : ''}: ${users}`;
}

/** A bulk job's entry in the audit log: its heading, how it went, and whether it's been reverted. */
export function describeBulkEntry(
  bulk: AuditBulkSummary,
  actor: string | null,
): {
  title: string;
  outcome: string | null;
  tone: 'green' | 'amber' | 'red' | 'muted';
  reverted: string | null;
} {
  const title = bulkJobTitle(bulk, bulk.total, actor);
  const reverted = bulk.revertedBy ? revertedNote(bulk.revertedBy) : null;
  const { status, counts } = bulk;
  if (status === null || counts === null) {
    return { title, outcome: null, tone: 'muted', reverted };
  }

  const { label, open } = STATUS[status];
  const failedTone = counts.failed > 0 ? 'red' : null;
  if (open) {
    return {
      title,
      outcome: `${label}: ${done(counts)} of ${counts.total} done`,
      tone: 'amber',
      reverted,
    };
  }
  return {
    title,
    outcome: label ? `${label}: ${tally(counts)}` : tally(counts),
    tone: failedTone ?? (label ? 'amber' : 'green'),
    reverted,
  };
}
