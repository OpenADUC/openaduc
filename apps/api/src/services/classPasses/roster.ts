// SPDX-License-Identifier: BUSL-1.1
import {
  tapExpiresAt,
  type ClassAlerts,
  type ClassPassStatus,
  type ClassRosterRow,
} from '@openaduc/shared';
import { nearClass, timedPassStatus } from './rules.js';

// What the class roster says of each person and of the class, from
// class_passes and what Graph last said; no I/O.

/** Error codes a waiting pass keeps that aren't something gone wrong. */
export const WAITING_CODES = { unsynced: 'unsynced', notYet: 'not_yet' } as const;

export interface RosterPass {
  row_id: string;
  status: 'waiting' | 'issued' | 'refused' | 'failed';
  class_starts_at: Date | string | null;
  pass_starts_at: Date | string | null;
  expires_at: Date | string | null;
  error_code: string | null;
  message: string | null;
  row_status: string;
  target_id: string | null;
  input_json: Record<string, unknown> | null;
  error_message: string | null;
  held: boolean;
}

/** One person's line on the roster. `live` is what Graph says of an issued pass, when asked. */
export function rosterRow(
  p: RosterPass,
  ctx: {
    lifetimeMinutes: number;
    paused: boolean;
    live: { status: ClassPassStatus; message: string | null } | undefined;
    now: Date;
  },
): ClassRosterRow {
  const input = p.input_json ?? {};
  const classEnds = p.class_starts_at ? tapExpiresAt(p.class_starts_at, ctx.lifetimeMinutes) : null;
  const base = {
    rowId: String(p.row_id),
    line: Number(input['line']),
    displayName: String(input['displayName'] ?? ''),
    samAccountName: String(input['samAccountName'] ?? ''),
    personalEmail: (input['otherMailbox'] as string | null) ?? null,
    mobile: (input['mobile'] as string | null) ?? null,
    id: p.target_id,
    message: p.message,
    startsAt: p.class_starts_at ? new Date(p.class_starts_at).toISOString() : null,
    expiresAt: classEnds?.toISOString() ?? null,
    held: p.held,
  };
  if (p.status === 'issued') {
    const times = {
      startsAt: new Date(p.pass_starts_at ?? p.class_starts_at!),
      expiresAt: new Date(p.expires_at!),
    };
    const known = ctx.live ?? { status: timedPassStatus(times, ctx.now), message: null };
    return {
      ...base,
      ...known,
      startsAt: times.startsAt.toISOString(),
      expiresAt: times.expiresAt.toISOString(),
    };
  }
  if (p.status === 'refused') return { ...base, status: 'refused' };
  if (p.status === 'failed') {
    return { ...base, status: p.error_code === 'other_pass' ? 'otherPass' : 'failed' };
  }
  if (!p.target_id) {
    const coming = p.row_status === 'pending' || p.row_status === 'running';
    return {
      ...base,
      status: coming ? 'awaitingAccount' : 'notCreated',
      message: coming ? null : p.error_message,
    };
  }
  if (ctx.paused) return { ...base, status: 'paused', message: null };
  if (p.error_code === WAITING_CODES.notYet) return { ...base, status: 'scheduled' };
  return {
    ...base,
    status: p.error_code && p.error_code !== WAITING_CODES.unsynced ? 'retrying' : 'waitingForSync',
  };
}

/** What holds a class's passes back. */
export function classAlerts(
  passes: readonly Pick<
    RosterPass,
    'status' | 'class_starts_at' | 'target_id' | 'error_code' | 'message'
  >[],
  klass: {
    lifetimeMinutes: number;
    authority: { name: string | null; message: string } | null;
    off: string | null;
  },
  now: Date,
): ClassAlerts {
  const waiting = passes.filter(
    (p) =>
      p.status === 'waiting' &&
      p.target_id &&
      (!p.class_starts_at || tapExpiresAt(p.class_starts_at, klass.lifetimeMinutes) > now),
  );
  const starts = waiting.flatMap((p) => {
    if (p.error_code !== WAITING_CODES.unsynced || !p.class_starts_at) return [];
    const start = new Date(p.class_starts_at);
    return nearClass(start, now) ? [start.getTime()] : [];
  });
  const stuck = new Map<string, number>();
  for (const p of waiting) {
    if (!p.error_code || Object.values<string>(WAITING_CODES).includes(p.error_code)) continue;
    const why = p.message ?? p.error_code;
    stuck.set(why, (stuck.get(why) ?? 0) + 1);
  }
  const quiet = !!klass.off || !!klass.authority;
  return {
    unsynced:
      starts.length && !quiet
        ? { count: starts.length, startsAt: new Date(Math.min(...starts)).toISOString() }
        : null,
    stuck: quiet ? [] : [...stuck].map(([message, count]) => ({ message, count })),
    authority: klass.off ? null : klass.authority,
    off: klass.off,
  };
}
