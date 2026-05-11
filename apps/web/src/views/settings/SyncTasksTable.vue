<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch, onMounted } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import Message from 'primevue/message';
import cronstrue from 'cronstrue';
import { useToast } from 'primevue/usetoast';
import {
  api,
  type MonthlyDay,
  type ScheduleKind,
  type SyncTaskKey,
  type SyncTaskPatch,
  type SyncTaskRun,
  type SyncTaskSummary,
} from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { fmtRelative } from '../../design/lib/format.js';

const props = defineProps<{ directoryId: number; canEdit: boolean }>();

const tasks = ref<SyncTaskSummary[]>([]);
const loading = ref(true);
const toast = useToast();

// Scheduler queue snapshot — `inFlight` is what's running right now
// across this directory; `queued` is what's been forced and is waiting
// for the next tick. Both refresh on every load() so the UI knows what
// the scheduler is doing without waiting for the task row's lastStatus
// to flip.
const queueInFlight = ref<Set<SyncTaskKey>>(new Set());
const queuePending = ref<Set<SyncTaskKey>>(new Set());

// One-shot post-click polling. When the operator clicks Run now we
// poll aggressively for ~30s so even a sub-second runner shows its
// running → finished transition. Distinct from the long-lived
// "anyRunning" poll because that one only kicks in once a row's
// lastStatus is already 'running'.
let burstPollHandle: ReturnType<typeof setInterval> | null = null;
let burstPollUntil = 0;

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [list, queue] = await Promise.all([
      api.directories.syncTasks.list(props.directoryId),
      api.directories.syncTasks.queue(props.directoryId).catch(() => ({
        // Queue endpoint might not be available on older API builds —
        // soft-fail so the table still loads.
        inFlight: [] as SyncTaskKey[],
        queued: [] as SyncTaskKey[],
      })),
    ]);
    tasks.value = list.tasks;
    queueInFlight.value = new Set(queue.inFlight);
    queuePending.value = new Set(queue.queued);
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not load sync tasks',
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  } finally {
    loading.value = false;
  }
}

const anyRunning = computed(
  () => tasks.value.some((t) => t.lastStatus === 'running') || queueInFlight.value.size > 0,
);
const anyQueued = computed(() => queuePending.value.size > 0);

let pollHandle: ReturnType<typeof setInterval> | null = null;
watch([anyRunning, anyQueued], ([running, queued]) => {
  const shouldPoll = running || queued;
  if (shouldPoll && pollHandle === null) {
    pollHandle = setInterval(() => void load(), 3000);
  } else if (!shouldPoll && pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
});

onMounted(load);
onUnmounted(() => {
  if (pollHandle !== null) clearInterval(pollHandle);
  if (burstPollHandle !== null) clearInterval(burstPollHandle);
});

function startBurstPoll(): void {
  // 1s cadence for 30s after a click. Catches sub-second runners that
  // would otherwise flicker too fast for the long-lived 3s poll.
  burstPollUntil = Date.now() + 30_000;
  if (burstPollHandle !== null) return;
  burstPollHandle = setInterval(() => {
    void load();
    if (Date.now() > burstPollUntil) {
      if (burstPollHandle !== null) {
        clearInterval(burstPollHandle);
        burstPollHandle = null;
      }
    }
  }, 1000);
}

// ---- Run / reset actions ----
const queuing = ref(new Set<SyncTaskKey>());

async function runNow(t: SyncTaskSummary): Promise<void> {
  if (queuing.value.has(t.taskKey)) return;
  queuing.value.add(t.taskKey);
  try {
    const r = await api.directories.syncTasks.run(props.directoryId, t.taskKey);
    toast.add({
      severity: r.queued ? 'success' : 'info',
      summary: r.queued ? 'Task queued' : 'Task already pending',
      detail: r.reason,
      life: 2500,
    });
    // Optimistically mark queued so the UI shows immediate feedback —
    // the scheduler wakes on triggerNow but the burst poll covers the
    // round-trip.
    if (r.queued) queuePending.value = new Set([...queuePending.value, t.taskKey]);
    startBurstPoll();
    void load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not queue task',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 5000,
    });
  } finally {
    queuing.value.delete(t.taskKey);
  }
}

// ---- History drawer ----
const historyOpen = ref(false);
const historyTask = ref<SyncTaskSummary | null>(null);
const historyRows = ref<SyncTaskRun[]>([]);
const historyLoading = ref(false);

async function openHistory(t: SyncTaskSummary): Promise<void> {
  historyTask.value = t;
  historyOpen.value = true;
  historyRows.value = [];
  historyLoading.value = true;
  try {
    const r = await api.directories.syncTasks.history(props.directoryId, t.taskKey, {
      limit: 50,
    });
    historyRows.value = r.runs;
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not load history',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 5000,
    });
  } finally {
    historyLoading.value = false;
  }
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

async function resetStuck(t: SyncTaskSummary): Promise<void> {
  try {
    await api.directories.syncTasks.reset(props.directoryId, t.taskKey);
    toast.add({ severity: 'success', summary: 'Task reset', life: 2500 });
    await load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not reset task',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 5000,
    });
  }
}

// ---- Edit-cadence dialog ----
//
// The form holds every field for every kind, and we render only the
// inputs relevant to the chosen kind. On save we normalise: 'interval'
// nulls anchor unless explicitly set; non-interval kinds null the
// interval and require a time.
const editOpen = ref(false);
const editTarget = ref<SyncTaskSummary | null>(null);

interface EditForm {
  enabled: boolean;
  kind: ScheduleKind;
  // For 'interval' — minutes (one of the dropdown divisors of 60)
  intervalMinutes: number;
  // For 'hourly' — number of hours (one of the dropdown divisors of 24)
  hourlyHours: number;
  // For 'hourly' — minute-of-hour (0-59)
  hourlyMinute: number;
  // For 'daily' / 'weekly' / 'monthly' — local "HH:MM"
  anchorTime: string;
  // For 'weekly' (0=Sun … 6=Sat)
  weekday: number;
  // For 'monthly' — '1'..'28' or 'last'
  monthlyDay: MonthlyDay;
  // For 'cron' — raw 5-field cron expression
  cronExpr: string;
}

const editForm = reactive<EditForm>({
  enabled: true,
  kind: 'interval',
  intervalMinutes: 5,
  hourlyHours: 1,
  hourlyMinute: 0,
  anchorTime: '',
  weekday: 0,
  monthlyDay: '1',
  cronExpr: '',
});

// Live cron interpretation. cronstrue is forgiving but we still want
// red/green feedback so the operator can tell their expression parses
// before they hit Save. Result is { ok, text, error }.
const cronInterpretation = computed<{ ok: boolean; text: string; error: string | null }>(() => {
  const expr = editForm.cronExpr.trim();
  if (!expr) return { ok: false, text: '', error: null };
  try {
    return { ok: true, text: cronstrue.toString(expr, { use24HourTimeFormat: true }), error: null };
  } catch (err) {
    return {
      ok: false,
      text: '',
      error: err instanceof Error ? err.message : 'invalid cron expression',
    };
  }
});
const editError = ref<string | null>(null);
const editSaving = ref(false);

const FREQUENCY_OPTIONS: { label: string; value: ScheduleKind }[] = [
  { label: 'Minutes', value: 'interval' },
  { label: 'Hourly', value: 'hourly' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Custom (cron)', value: 'cron' },
];

// Cadence dropdown options: divisors of 60 / 24 so the schedule lines
// up cleanly. The "(current) N min" / "(current) N hours" prefix
// option is added on open when the row's existing value isn't one of
// the standard divisors, so editing legacy schedules doesn't silently
// throw away the operator's prior choice.
const STANDARD_MINUTE_DIVISORS = [1, 2, 3, 4, 5, 10, 15, 30] as const;
const STANDARD_HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12] as const;

const minuteOptions = computed<{ label: string; value: number }[]>(() => {
  const opts = STANDARD_MINUTE_DIVISORS.map((v) => ({
    label: v === 1 ? 'Every 1 minute' : `Every ${v} minutes`,
    value: v,
  }));
  const cur = editForm.intervalMinutes;
  if (cur > 0 && !STANDARD_MINUTE_DIVISORS.includes(cur as 1)) {
    return [{ label: `(current) Every ${cur} minutes`, value: cur }, ...opts];
  }
  return opts;
});

const hourOptions = computed<{ label: string; value: number }[]>(() => {
  const opts = STANDARD_HOUR_DIVISORS.map((v) => ({
    label: v === 1 ? 'Every 1 hour' : `Every ${v} hours`,
    value: v,
  }));
  const cur = editForm.hourlyHours;
  if (cur > 0 && !STANDARD_HOUR_DIVISORS.includes(cur as 1)) {
    return [{ label: `(current) Every ${cur} hours`, value: cur }, ...opts];
  }
  return opts;
});

const WEEKDAY_OPTIONS = [
  { label: 'Sunday', value: 0 },
  { label: 'Monday', value: 1 },
  { label: 'Tuesday', value: 2 },
  { label: 'Wednesday', value: 3 },
  { label: 'Thursday', value: 4 },
  { label: 'Friday', value: 5 },
  { label: 'Saturday', value: 6 },
];

const MONTHLY_DAY_OPTIONS: { label: string; value: MonthlyDay }[] = [
  ...Array.from({ length: 28 }, (_, i) => ({
    label: `${i + 1}${ordinalSuffix(i + 1)}`,
    value: String(i + 1),
  })),
  { label: 'Last day of the month', value: 'last' },
];

function openEdit(t: SyncTaskSummary): void {
  editTarget.value = t;
  editError.value = null;
  editForm.enabled = t.enabled;
  editForm.kind = t.scheduleKind;
  editForm.intervalMinutes = t.intervalMinutes;
  // 'hourly' rows store interval_minutes = N*60 and anchor_at at 00:MM.
  // Decompose for the picker; default both to 1h/00 for non-hourly kinds
  // so switching to Hourly mid-edit lands on a sensible value.
  if (t.scheduleKind === 'hourly') {
    editForm.hourlyHours = Math.max(1, Math.round(t.intervalMinutes / 60));
    editForm.hourlyMinute = t.anchorAt ? new Date(t.anchorAt).getMinutes() : 0;
  } else {
    editForm.hourlyHours = 1;
    editForm.hourlyMinute = 0;
  }
  editForm.anchorTime = t.anchorAt
    ? toTimeOfDay(new Date(t.anchorAt))
    : defaultTimeForKind(t.scheduleKind);
  editForm.weekday = t.anchorAt ? new Date(t.anchorAt).getDay() : 0;
  editForm.monthlyDay = t.monthlyDay ?? '1';
  editForm.cronExpr = t.cronExpr ?? '';
  editOpen.value = true;
}

function resetToDefaults(): void {
  const t = editTarget.value;
  if (!t) return;
  editForm.kind = 'interval';
  editForm.intervalMinutes = t.defaultIntervalMinutes;
  editForm.hourlyHours = 1;
  editForm.hourlyMinute = 0;
  editForm.anchorTime = '';
  editForm.weekday = 0;
  editForm.monthlyDay = '1';
  editForm.cronExpr = '';
}

async function saveEdit(): Promise<void> {
  if (!editTarget.value) return;
  editError.value = null;

  // Validation: time-of-day required for daily/weekly/monthly. Hourly
  // captures its own minute-of-hour input separately.
  if (
    (editForm.kind === 'daily' || editForm.kind === 'weekly' || editForm.kind === 'monthly') &&
    !editForm.anchorTime
  ) {
    editError.value = 'Please pick a time of day for this schedule.';
    return;
  }
  if (editForm.kind === 'hourly') {
    if (editForm.hourlyMinute < 0 || editForm.hourlyMinute > 59) {
      editError.value = 'Minute of the hour must be between 0 and 59.';
      return;
    }
    if (editForm.hourlyHours < 1) {
      editError.value = 'Pick how often the task runs.';
      return;
    }
  }
  if (editForm.kind === 'cron') {
    if (!editForm.cronExpr.trim()) {
      editError.value = 'Enter a cron expression.';
      return;
    }
    if (!cronInterpretation.value.ok) {
      editError.value = cronInterpretation.value.error ?? 'Cron expression is invalid.';
      return;
    }
  }

  editSaving.value = true;
  try {
    const t = editTarget.value;
    const patch: SyncTaskPatch = {};
    if (editForm.enabled !== t.enabled) patch.enabled = editForm.enabled;
    if (editForm.kind !== t.scheduleKind) patch.scheduleKind = editForm.kind;

    if (editForm.kind === 'interval') {
      const inputMinutes = Math.max(1, Math.min(43200, Math.floor(editForm.intervalMinutes)));
      const matchesDefault = inputMinutes === t.defaultIntervalMinutes;
      const desiredInterval = matchesDefault ? null : inputMinutes;
      const currentOverride = t.intervalIsOverride ? t.intervalMinutes : null;
      if (desiredInterval !== currentOverride || patch.scheduleKind === 'interval') {
        patch.intervalMinutes = desiredInterval;
      }
      // Interval kind doesn't need an anchor (today's behaviour). Clear
      // any existing one so switching kinds doesn't leave stale state.
      if (t.anchorAt !== null) patch.anchorAt = null;
      if (t.monthlyDay !== null) patch.monthlyDay = null;
    } else if (editForm.kind === 'hourly') {
      // Store as interval_minutes = N*60 + anchor at today 00:MM.
      const desiredMinutes = editForm.hourlyHours * 60;
      const currentMinutes =
        t.scheduleKind === 'hourly' && t.intervalIsOverride ? t.intervalMinutes : null;
      if (desiredMinutes !== currentMinutes || patch.scheduleKind === 'hourly') {
        patch.intervalMinutes = desiredMinutes;
      }
      const anchor = new Date();
      anchor.setHours(0, editForm.hourlyMinute, 0, 0);
      const currentAnchor = t.anchorAt ? new Date(t.anchorAt) : null;
      if (
        !currentAnchor ||
        currentAnchor.getMinutes() !== anchor.getMinutes() ||
        patch.scheduleKind === 'hourly'
      ) {
        patch.anchorAt = anchor.toISOString();
      }
      if (t.monthlyDay !== null) patch.monthlyDay = null;
    } else if (editForm.kind === 'cron') {
      const expr = editForm.cronExpr.trim();
      if (expr !== (t.cronExpr ?? '')) patch.cronExpr = expr;
      // Cron rows ignore anchor/monthly/interval fields. Clear any
      // stale state inherited from the previous kind.
      if (t.anchorAt !== null) patch.anchorAt = null;
      if (t.monthlyDay !== null) patch.monthlyDay = null;
      if (t.intervalIsOverride) patch.intervalMinutes = null;
    } else {
      // daily / weekly / monthly all use anchorAt for the time-of-day.
      // weekly additionally uses the date's weekday.
      const anchor = anchorForKind(editForm.kind, editForm.anchorTime, editForm.weekday);
      const currentAnchor = t.anchorAt ? new Date(t.anchorAt) : null;
      if (!anchorMatches(anchor, currentAnchor, editForm.kind)) {
        patch.anchorAt = anchor.toISOString();
      }
      if (editForm.kind === 'monthly') {
        if (editForm.monthlyDay !== t.monthlyDay) patch.monthlyDay = editForm.monthlyDay;
      } else if (t.monthlyDay !== null) {
        patch.monthlyDay = null;
      }
      if (t.intervalIsOverride) patch.intervalMinutes = null;
    }

    if (Object.keys(patch).length === 0) {
      editOpen.value = false;
      return;
    }
    await api.directories.syncTasks.update(props.directoryId, t.taskKey, patch);
    toast.add({ severity: 'success', summary: 'Task updated', life: 2500 });
    editOpen.value = false;
    await load();
  } catch (err) {
    editError.value = err instanceof ApiError ? err.message : 'Save failed';
  } finally {
    editSaving.value = false;
  }
}

function defaultTimeForKind(kind: ScheduleKind): string {
  // 02:00 is a common off-hours pick; matches the typical operator
  // expectation of "run nightly". Only daily/weekly/monthly use this
  // anchor field — hourly captures its minute-of-hour separately and
  // interval has no anchor.
  if (kind === 'interval' || kind === 'hourly') return '';
  return '02:00';
}

function ordinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0]!;
}

/** Build an anchor Date for a daily/weekly/monthly schedule from form fields. */
function anchorForKind(kind: ScheduleKind, time: string, weekday: number): Date {
  const base = anchorTimeToDate(time);
  if (!base) throw new Error('time required');
  if (kind === 'weekly') {
    // Slide the date so its weekday matches the chosen weekday.
    const delta = (weekday - base.getDay() + 7) % 7;
    base.setDate(base.getDate() + delta);
  }
  return base;
}

/**
 * For non-interval kinds we only care about the time-of-day (and weekday for weekly).
 * The DB stores the full anchor Date but we don't want a save round-trip when only the
 * date part shifted (e.g. "today" rolled over).
 */
function anchorMatches(next: Date, current: Date | null, kind: ScheduleKind): boolean {
  if (current === null) return false;
  if (toTimeOfDay(next) !== toTimeOfDay(current)) return false;
  if (kind === 'weekly' && next.getDay() !== current.getDay()) return false;
  return true;
}

function statusLabel(t: SyncTaskSummary): string {
  if (t.lastStatus === 'running') return 'running';
  if (t.lastStatus === 'succeeded') return 'ok';
  if (t.lastStatus === 'failed') return `failed (${t.consecutiveFailures}×)`;
  if (!t.enabled) return 'disabled';
  return 'pending';
}

function statusTone(t: SyncTaskSummary): string {
  if (!t.enabled) return 'badge-muted';
  switch (t.lastStatus) {
    case 'succeeded':
      return 'badge-green';
    case 'failed':
      return 'badge-red';
    case 'running':
      return 'badge-amber';
    default:
      return 'badge-muted';
  }
}

function scheduleText(t: SyncTaskSummary): string {
  if (t.scheduleKind === 'interval') {
    const m = t.intervalMinutes;
    let text: string;
    if (m < 60) text = `every ${m}m`;
    else if (m % 1440 === 0) text = `every ${m / 1440}d`;
    else if (m % 60 === 0) text = `every ${m / 60}h`;
    else text = `every ${m}m`;
    return t.intervalIsOverride ? text : `${text} (default)`;
  }
  if (t.scheduleKind === 'hourly' && t.anchorAt) {
    const hours = Math.max(1, Math.round(t.intervalMinutes / 60));
    const mm = String(new Date(t.anchorAt).getMinutes()).padStart(2, '0');
    return hours === 1 ? `hourly at :${mm}` : `every ${hours}h at :${mm}`;
  }
  if (t.scheduleKind === 'daily' && t.anchorAt) {
    return `daily at ${toTimeOfDay(new Date(t.anchorAt))}`;
  }
  if (t.scheduleKind === 'weekly' && t.anchorAt) {
    const d = new Date(t.anchorAt);
    return `weekly on ${WEEKDAY_NAMES[d.getDay()]} at ${toTimeOfDay(d)}`;
  }
  if (t.scheduleKind === 'monthly' && t.anchorAt && t.monthlyDay) {
    const dayLabel =
      t.monthlyDay === 'last'
        ? 'last day'
        : `${t.monthlyDay}${ordinalSuffix(Number(t.monthlyDay))}`;
    return `monthly on the ${dayLabel} at ${toTimeOfDay(new Date(t.anchorAt))}`;
  }
  if (t.scheduleKind === 'cron' && t.cronExpr) {
    try {
      return cronstrue.toString(t.cronExpr, { use24HourTimeFormat: true }).toLowerCase();
    } catch {
      return `cron: ${t.cronExpr}`;
    }
  }
  return t.scheduleKind;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function durationText(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function toTimeOfDay(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Resolve a "HH:MM" picker value into a full Date by anchoring it to
 * today. The scheduler's slot math only cares about the time-of-day for
 * cadences shorter than a day; for week-scale tasks, today's
 * day-of-week becomes the recurring day. Empty string = no anchor.
 */
function anchorTimeToDate(value: string): Date | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}
</script>

<template>
  <div class="sync-tasks">
    <div class="head">
      <div class="title">Sync schedule</div>
      <Button
        label="Refresh"
        icon="pi pi-refresh"
        size="small"
        severity="secondary"
        outlined
        @click="load"
      />
    </div>
    <p v-if="loading && tasks.length === 0" class="hint">Loading tasks…</p>
    <p v-else-if="tasks.length === 0" class="hint">
      No tasks yet — the scheduler seeds them on its next tick (within a minute).
    </p>
    <table v-else class="task-table">
      <thead>
        <tr>
          <th>Task</th>
          <th>Cadence</th>
          <th>Last run</th>
          <th>Status</th>
          <th>Next due</th>
          <th class="actions"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in tasks" :key="t.taskKey">
          <td>
            <div class="task-label">{{ t.label }}</div>
            <div class="task-key mono">{{ t.taskKey }}</div>
          </td>
          <td>
            <div>{{ scheduleText(t) }}</div>
          </td>
          <td>
            <div v-if="t.lastStartedAt">{{ fmtRelative(t.lastStartedAt) }}</div>
            <div v-else class="hint">never</div>
            <div v-if="t.lastStartedAt && t.lastFinishedAt" class="hint">
              {{ durationText(t.lastStartedAt, t.lastFinishedAt) }}
            </div>
          </td>
          <td>
            <span class="badge" :class="statusTone(t)"
              ><span class="badge-dot" /> {{ statusLabel(t) }}</span
            >
            <span
              v-if="queuePending.has(t.taskKey) && t.lastStatus !== 'running'"
              class="badge badge-amber queued-badge"
              title="Queued — the scheduler will pick this up on its next tick."
              ><span class="badge-dot" /> queued</span
            >
            <span
              v-if="queueInFlight.has(t.taskKey) && t.lastStatus !== 'running'"
              class="badge badge-amber queued-badge"
              title="Currently running — the table will refresh shortly."
              ><span class="badge-dot" /> running…</span
            >
            <div v-if="t.lastStatus === 'failed' && t.lastError" class="task-error">
              {{ t.lastError }}
            </div>
          </td>
          <td>
            <span v-if="t.nextDueAt && t.enabled">{{ fmtRelative(t.nextDueAt) }}</span>
            <span v-else class="hint">—</span>
          </td>
          <td class="actions">
            <Button
              icon="pi pi-history"
              size="small"
              severity="secondary"
              outlined
              title="Show recent runs"
              @click="openHistory(t)"
            />
            <Button
              v-if="canEdit && t.lastStatus === 'running'"
              icon="pi pi-times"
              severity="secondary"
              outlined
              size="small"
              title="Reset stuck task"
              @click="resetStuck(t)"
            />
            <Button
              v-if="canEdit"
              icon="pi pi-play"
              size="small"
              severity="secondary"
              outlined
              title="Run now"
              :disabled="t.lastStatus === 'running' || queuing.has(t.taskKey)"
              @click="runNow(t)"
            />
            <Button
              v-if="canEdit"
              icon="pi pi-cog"
              size="small"
              severity="secondary"
              outlined
              title="Edit cadence"
              @click="openEdit(t)"
            />
          </td>
        </tr>
      </tbody>
    </table>

    <Dialog
      v-model:visible="editOpen"
      modal
      :closable="!editSaving"
      :header="`Edit cadence — ${editTarget?.label ?? ''}`"
      :style="{ width: 'min(420px, 95vw)' }"
    >
      <form class="edit-form" @submit.prevent="saveEdit">
        <label class="edit-check">
          <input v-model="editForm.enabled" type="checkbox" />
          <span>Enabled</span>
        </label>

        <div class="edit-field">
          <div class="edit-field-label">Frequency</div>
          <Select
            v-model="editForm.kind"
            :options="FREQUENCY_OPTIONS"
            option-label="label"
            option-value="value"
            class="edit-frequency-select"
          />
        </div>

        <!-- ── Minutes (interval) ── -->
        <div v-if="editForm.kind === 'interval'" class="edit-field">
          <div class="edit-field-label">Cadence</div>
          <Select
            v-model="editForm.intervalMinutes"
            :options="minuteOptions"
            option-label="label"
            option-value="value"
            class="edit-frequency-select"
          />
        </div>

        <!-- ── Hourly ── -->
        <div v-else-if="editForm.kind === 'hourly'" class="edit-field">
          <div class="edit-field-label">Cadence</div>
          <div class="edit-field-row">
            <Select
              v-model="editForm.hourlyHours"
              :options="hourOptions"
              option-label="label"
              option-value="value"
              class="edit-frequency-select"
            />
            <span class="edit-inline-label">at minute</span>
            <input
              v-model.number="editForm.hourlyMinute"
              type="number"
              min="0"
              max="59"
              step="5"
              class="edit-minute-input"
            />
          </div>
        </div>

        <!-- ── Daily ── -->
        <div v-else-if="editForm.kind === 'daily'" class="edit-field">
          <div class="edit-field-label">At</div>
          <input v-model="editForm.anchorTime" type="time" class="edit-time-input" />
        </div>

        <!-- ── Weekly ── -->
        <div v-else-if="editForm.kind === 'weekly'" class="edit-field">
          <div class="edit-field-label">On</div>
          <div class="edit-field-row">
            <Select
              v-model="editForm.weekday"
              :options="WEEKDAY_OPTIONS"
              option-label="label"
              option-value="value"
              class="edit-weekday-select"
            />
            <span class="edit-inline-label">at</span>
            <input v-model="editForm.anchorTime" type="time" class="edit-time-input" />
          </div>
        </div>

        <!-- ── Monthly ── -->
        <div v-else-if="editForm.kind === 'monthly'" class="edit-field">
          <div class="edit-field-label">On day</div>
          <div class="edit-field-row">
            <Select
              v-model="editForm.monthlyDay"
              :options="MONTHLY_DAY_OPTIONS"
              option-label="label"
              option-value="value"
              class="edit-monthlyday-select"
            />
            <span class="edit-inline-label">at</span>
            <input v-model="editForm.anchorTime" type="time" class="edit-time-input" />
          </div>
        </div>

        <!-- ── Custom cron ── -->
        <div v-else-if="editForm.kind === 'cron'" class="edit-field">
          <div class="edit-field-label">Cron expression</div>
          <input
            v-model="editForm.cronExpr"
            type="text"
            class="edit-cron-input"
            placeholder="e.g. 0 */6 * * 1-5"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          />
          <div
            v-if="editForm.cronExpr.trim()"
            class="edit-cron-feedback"
            :class="cronInterpretation.ok ? 'ok' : 'bad'"
          >
            <i
              :class="cronInterpretation.ok ? 'pi pi-check-circle' : 'pi pi-exclamation-triangle'"
            />
            <span v-if="cronInterpretation.ok">{{ cronInterpretation.text }}</span>
            <span v-else>{{ cronInterpretation.error }}</span>
          </div>
          <div v-else class="edit-cron-help">
            5 fields: <span class="mono">minute hour day-of-month month day-of-week</span>
          </div>
        </div>

        <Message v-if="editError" severity="error" :closable="false">{{ editError }}</Message>
      </form>
      <template #footer>
        <div class="edit-footer">
          <Button
            label="Reset to defaults"
            icon="pi pi-undo"
            severity="secondary"
            text
            size="small"
            type="button"
            :disabled="editSaving"
            @click="resetToDefaults"
          />
          <div class="edit-footer-right">
            <Button
              label="Cancel"
              severity="secondary"
              text
              :disabled="editSaving"
              @click="editOpen = false"
            />
            <Button label="Save" :loading="editSaving" @click="saveEdit" />
          </div>
        </div>
      </template>
    </Dialog>

    <!-- Recent runs drawer. Shows the last 50 runs newest-first with
         their trigger (forced/cadence), duration, and full error text.
         Useful for spotting "ran 3× in 2 min, all failed with same
         error" without crawling the audit log. -->
    <Dialog
      v-model:visible="historyOpen"
      modal
      :header="`Recent runs — ${historyTask?.label ?? ''}`"
      :style="{ width: 'min(720px, 95vw)' }"
    >
      <p v-if="historyLoading" class="hint">Loading…</p>
      <p v-else-if="historyRows.length === 0" class="hint">No runs recorded yet.</p>
      <table v-else class="history-table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Trigger</th>
            <th>Duration</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in historyRows" :key="r.id">
            <td>
              <div>{{ fmtRelative(r.startedAt) }}</div>
              <div class="hint mono">{{ new Date(r.startedAt).toLocaleString() }}</div>
            </td>
            <td>
              <span class="badge" :class="r.trigger === 'forced' ? 'badge-amber' : 'badge-muted'">
                <span class="badge-dot" /> {{ r.trigger }}
              </span>
            </td>
            <td>{{ fmtDuration(r.durationMs) }}</td>
            <td>
              <span
                class="badge"
                :class="
                  r.status === 'succeeded'
                    ? 'badge-green'
                    : r.status === 'running'
                      ? 'badge-amber'
                      : 'badge-red'
                "
              >
                <span class="badge-dot" /> {{ r.status }}
              </span>
            </td>
            <td class="history-detail">
              <div v-if="r.error" class="history-error">{{ r.error }}</div>
              <div v-else-if="r.stats" class="history-stats mono">{{ JSON.stringify(r.stats) }}</div>
              <div v-else class="hint">—</div>
            </td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <Button label="Close" text severity="secondary" @click="historyOpen = false" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.sync-tasks {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.task-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.task-table th {
  text-align: left;
  padding: 6px 8px;
  color: var(--text-3);
  font-weight: 500;
  border-bottom: 1px solid var(--border);
}

.task-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.task-table th.actions,
.task-table td.actions {
  text-align: right;
  width: 1%;
  white-space: nowrap;
}

.task-table td.actions :deep(button) {
  margin-left: 4px;
}

.task-label {
  font-weight: 500;
  color: var(--text);
}

.task-key {
  color: var(--text-3);
  font-size: 11.5px;
}

.task-error {
  color: var(--red);
  margin-top: 4px;
  font-size: 11.5px;
}

.queued-badge {
  margin-left: 6px;
}

.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.history-table th,
.history-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.history-table th {
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
  border-bottom-color: var(--border);
}

.history-detail {
  max-width: 320px;
}

.history-error {
  color: var(--red);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

.history-stats {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: pre-wrap;
  word-break: break-word;
}

.hint {
  color: var(--text-3);
  font-size: 11.5px;
}

/* ---- Edit-cadence modal ---- */
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
  font-size: 13px;
}

.edit-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text);
  font-weight: 500;
}

.edit-check input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.edit-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.edit-field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}

.edit-field-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.edit-field-row > * {
  min-width: 0;
}

.edit-time-input {
  width: 140px;
  padding: 8px 10px;
  background: var(--surface-2, var(--surface));
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
}

.edit-time-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 30%, transparent);
}

.edit-frequency-select,
.edit-weekday-select,
.edit-monthlyday-select {
  min-width: 160px;
}

.edit-minute-input {
  width: 72px;
  padding: 8px 4px 8px 10px;
  background: var(--surface-2, var(--surface));
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
}

.edit-minute-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 30%, transparent);
}

.edit-cron-input {
  width: 100%;
  padding: 8px 10px;
  background: var(--surface-2, var(--surface));
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  letter-spacing: 0.02em;
}

.edit-cron-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent) 30%, transparent);
}

.edit-cron-feedback {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.45;
  margin-top: 2px;
}

.edit-cron-feedback i {
  margin-top: 2px;
  font-size: 12px;
}

.edit-cron-feedback.ok {
  color: var(--green, #4ade80);
}

.edit-cron-feedback.bad {
  color: var(--red, #f87171);
}

.edit-cron-help {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.45;
  margin-top: 2px;
}

.edit-cron-help .mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.edit-inline-label {
  color: var(--text-3);
  font-size: 12px;
}

.edit-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}

.edit-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
