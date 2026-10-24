// SPDX-License-Identifier: BUSL-1.1
// An import's class roster: each person with their contact details and
// how their Temporary Access Pass stands in Entra, for whoever runs the
// onboarding class to hand the passes out. Revealing a pass, reissuing a
// lost or burned one, and rescheduling class each take step-up and are
// audited; a revealed pass is held only until it's hidden, reissued or
// the page is left. Any operator who may issue a TAP can open it.

import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import type { ClassPassReveal, ClassRoster, ClassRosterRow, ClassStart } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { errorMessage } from '../lib/errorMessage.js';

/** Statuses come from Graph, a call per pass: refreshed gently. */
export const ROSTER_REFRESH_MS = 60_000;

/** Rows whose pass can be made again now: their account exists. */
const reissuable = (row: ClassRosterRow) => row.id !== null;

export function useClassRoster(opts: { writeClipboard?: (text: string) => Promise<void> } = {}) {
  const auth = useAuthStore();
  const writeClipboard =
    opts.writeClipboard ?? ((text: string) => navigator.clipboard.writeText(text));
  const roster = shallowRef<ClassRoster | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  /** The passes revealed on this page, by row. */
  const revealed = ref<Record<string, ClassPassReveal>>({});
  /** What a row's last reveal, copy or reissue said, by row. */
  const rowNotes = ref<Record<string, { tone: 'ok' | 'warn' | 'error'; text: string }>>({});
  const busyRow = ref<string | null>(null);
  const confirmingReissue = ref<string | null>(null);

  let id: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (getCurrentScope()) onScopeDispose(() => clearInterval(timer));

  async function load(background: boolean): Promise<void> {
    const current = id;
    if (!current) return;
    try {
      const next = await api.users.import.classRoster(current, { background });
      if (current !== id) return;
      roster.value = next;
      loadError.value = null;
    } catch (err) {
      if (current !== id || background) return;
      loadError.value = errorMessage(err, 'Couldn’t load the class roster');
    }
  }

  async function open(jobId: string): Promise<void> {
    id = jobId;
    roster.value = null;
    revealed.value = {};
    rowNotes.value = {};
    clearInterval(timer);
    loading.value = true;
    try {
      await load(false);
    } finally {
      loading.value = false;
    }
    timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) void load(true);
    }, ROSTER_REFRESH_MS);
  }

  const refresh = () => load(false);

  function note(rowId: string, tone: 'ok' | 'warn' | 'error', text: string | null): void {
    const next = { ...rowNotes.value };
    if (text) next[rowId] = { tone, text };
    else delete next[rowId];
    rowNotes.value = next;
  }

  function forget(rowId: string): void {
    const next = { ...revealed.value };
    delete next[rowId];
    revealed.value = next;
  }

  /** Make a write for a row after step-up, retrying after one if it lapsed meanwhile. */
  function rowWrite(rowId: string, call: () => Promise<void>, reason: string): void {
    const attempt = async (): Promise<void> => {
      busyRow.value = rowId;
      note(rowId, 'ok', null);
      try {
        await call();
      } catch (err) {
        if (auth.retryAfterStepUp(err, attempt)) return;
        note(rowId, 'error', errorMessage(err, 'That didn’t work'));
      } finally {
        busyRow.value = null;
      }
    };
    auth.requireStepUp(attempt, reason);
  }

  async function fetchPass(rowId: string): Promise<ClassPassReveal> {
    const pass = await api.users.import.revealClassPass(id!, rowId);
    revealed.value = { ...revealed.value, [rowId]: pass };
    return pass;
  }

  /** Show a row's pass. Each reveal is audited. */
  function reveal(rowId: string): void {
    if (!id) return;
    rowWrite(
      rowId,
      async () => {
        await fetchPass(rowId);
      },
      'Revealing a Temporary Access Pass requires step-up authentication.',
    );
  }

  function hide(rowId: string): void {
    forget(rowId);
  }

  /** Copy a row's pass, revealing it first if it isn't shown. */
  function copy(rowId: string): void {
    if (!id) return;
    const shown = revealed.value[rowId];
    const write = async (pass: ClassPassReveal) => {
      try {
        await writeClipboard(pass.temporaryAccessPass);
        note(rowId, 'ok', 'Copied.');
      } catch {
        note(rowId, 'warn', 'Couldn’t copy. Select the pass and copy it.');
      }
    };
    if (shown) {
      void write(shown);
      return;
    }
    rowWrite(
      rowId,
      async () => write(await fetchPass(rowId)),
      'Revealing a Temporary Access Pass requires step-up authentication.',
    );
  }

  function requestReissue(rowId: string): void {
    confirmingReissue.value = rowId;
  }
  function cancelReissue(): void {
    confirmingReissue.value = null;
  }

  /** Make the row's pass again: the one they have stops working. */
  function reissue(): void {
    const rowId = confirmingReissue.value;
    confirmingReissue.value = null;
    if (!id || !rowId) return;
    const jobId = id;
    rowWrite(
      rowId,
      async () => {
        const { outcome, message } = await api.users.import.reissueClassPass(jobId, rowId);
        forget(rowId);
        await load(false);
        if (outcome === 'issued') note(rowId, 'ok', 'Reissued. Reveal it to hand it over.');
        else if (message) note(rowId, outcome === 'waiting' ? 'warn' : 'error', message);
      },
      'Reissuing a Temporary Access Pass requires step-up authentication.',
    );
  }

  // ---- Reschedule class ---------------------------------------------------

  const rescheduling = ref(false);
  const rescheduleBusy = ref(false);
  const rescheduleError = ref<string | null>(null);
  /** The new start, as date and time inputs give it. */
  const newDate = ref('');
  const newTime = ref('09:00');
  /** Each person's start date at `newTime`, as the class was scheduled. */
  const byStartDate = computed(() => roster.value?.class.start.kind === 'startDate');
  /** The zone the new time is in: the class's, for each person's start date; else the operator's. */
  const timeZone = computed(() => {
    const start = roster.value?.class.start;
    return start?.kind === 'startDate'
      ? start.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  });

  function startReschedule(): void {
    const start = roster.value?.class.start;
    if (!start) return;
    rescheduleError.value = null;
    if (start.kind === 'startDate') newTime.value = start.time;
    else {
      const at = new Date(start.startsAt);
      const pad = (n: number) => String(n).padStart(2, '0');
      newDate.value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
      newTime.value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }
    rescheduling.value = true;
  }
  function cancelReschedule(): void {
    rescheduling.value = false;
  }

  const newStart = computed<ClassStart | null>(() => {
    if (!newTime.value) return null;
    if (byStartDate.value) {
      return { kind: 'startDate', time: newTime.value, timeZone: timeZone.value };
    }
    const at = new Date(`${newDate.value}T${newTime.value}`);
    return Number.isNaN(at.getTime()) ? null : { kind: 'fixed', startsAt: at.toISOString() };
  });

  /** Move class: every pass is made again for the new start, and the ones handed out stop working. */
  function reschedule(): void {
    const start = newStart.value;
    if (!id || !start || rescheduleBusy.value) return;
    const jobId = id;
    const attempt = async (): Promise<void> => {
      rescheduleBusy.value = true;
      rescheduleError.value = null;
      try {
        await api.users.import.rescheduleClass(jobId, { start });
        rescheduling.value = false;
        revealed.value = {};
        rowNotes.value = {};
        await load(false);
      } catch (err) {
        if (auth.retryAfterStepUp(err, attempt)) return;
        rescheduleError.value = errorMessage(err, 'Couldn’t reschedule class');
      } finally {
        rescheduleBusy.value = false;
      }
    };
    auth.requireStepUp(attempt, 'Rescheduling class requires step-up authentication.');
  }

  const rows = computed(() => roster.value?.rows ?? []);

  return {
    open,
    refresh,
    roster,
    rows,
    loading,
    loadError,
    revealed,
    rowNotes,
    busyRow,
    reveal,
    hide,
    copy,
    reissuable,
    confirmingReissue,
    requestReissue,
    cancelReissue,
    reissue,
    rescheduling,
    rescheduleBusy,
    rescheduleError,
    newDate,
    newTime,
    byStartDate,
    timeZone,
    newStart,
    startReschedule,
    cancelReschedule,
    reschedule,
  };
}
