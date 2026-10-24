// SPDX-License-Identifier: BUSL-1.1
// What a date input and a time input mean together: an instant in the
// browser's time zone, the zone the operator reads and types times in.

const pad = (n: number) => String(n).padStart(2, '0');

/** The instant a date input's and a time input's values mean; null when they don't make one. */
export function fromLocalInputs(date: string, time: string): string | null {
  if (!date || !time) return null;
  const at = new Date(`${date}T${time}`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** An instant as a date input and a time input show it. */
export function toLocalInputs(iso: string): { date: string; time: string } {
  const at = new Date(iso);
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}
