// SPDX-License-Identifier: BUSL-1.1
// Small formatting helpers used across the design layer. Kept dependency-free
// so they can be unit-tested without DOM/PrimeVue overhead.

export function fmtRelative(
  input: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!input) return '';
  const date = typeof input === 'string' ? new Date(input) : input;
  const ms = now.getTime() - date.getTime();
  if (Number.isNaN(ms)) return '';
  const abs = Math.abs(ms);
  const sign = ms >= 0 ? '' : 'in ';
  const suffix = ms >= 0 ? ' ago' : '';
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (abs < 30 * SEC) return 'just now';
  if (abs < MIN) return `${sign}${Math.floor(abs / SEC)}s${suffix}`;
  if (abs < HOUR) return `${sign}${Math.floor(abs / MIN)}m${suffix}`;
  if (abs < DAY) return `${sign}${Math.floor(abs / HOUR)}h${suffix}`;
  if (abs < 30 * DAY) return `${sign}${Math.floor(abs / DAY)}d${suffix}`;
  if (abs < 365 * DAY) return `${sign}${Math.floor(abs / (30 * DAY))}mo${suffix}`;
  return `${sign}${Math.floor(abs / (365 * DAY))}y${suffix}`;
}

export function fmtAbsolute(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function fmtDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

export function initialsFor(name: string | null | undefined): string {
  if (!name) return '?';
  const cleaned = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Stable hash → 0..n. Used to pick a stable avatar color from a name.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #38bdf8, #0ea5e9)',
  'linear-gradient(135deg, #a78bfa, #7c3aed)',
  'linear-gradient(135deg, #34d399, #059669)',
  'linear-gradient(135deg, #fb7185, #e11d48)',
  'linear-gradient(135deg, #fbbf24, #d97706)',
  'linear-gradient(135deg, #60a5fa, #2563eb)',
  'linear-gradient(135deg, #f472b6, #db2777)',
  'linear-gradient(135deg, #22d3ee, #0891b2)',
];

export function avatarGradientFor(seed: string | null | undefined): string {
  const idx = hashString(seed ?? '?') % AVATAR_GRADIENTS.length;
  return AVATAR_GRADIENTS[idx]!;
}

export type UserStatusKind =
  | 'active'
  | 'disabled'
  | 'locked'
  | 'pwd-expired'
  | 'pwd-expiring'
  | 'expired';

export interface UserStatusInput {
  enabled?: boolean | null;
  locked?: boolean | null;
  accountExpiresAt?: string | null;
  passwordExpiresAt?: string | null;
  passwordNeverExpires?: boolean | null;
}

export function userStatus(u: UserStatusInput, now: Date = new Date()): UserStatusKind {
  if (u.locked) return 'locked';
  if (u.enabled === false) return 'disabled';
  if (u.accountExpiresAt && new Date(u.accountExpiresAt).getTime() < now.getTime())
    return 'expired';
  if (!u.passwordNeverExpires && u.passwordExpiresAt) {
    const expiresMs = new Date(u.passwordExpiresAt).getTime() - now.getTime();
    const days = expiresMs / (24 * 60 * 60 * 1000);
    if (days <= 0) return 'pwd-expired';
    if (days <= 14) return 'pwd-expiring';
  }
  return 'active';
}

export function userStatusLabel(kind: UserStatusKind): string {
  return {
    active: 'Active',
    disabled: 'Disabled',
    locked: 'Locked',
    'pwd-expired': 'Password expired',
    'pwd-expiring': 'Expires soon',
    expired: 'Expired',
  }[kind];
}

// Truncate a long string in the middle, keeping head and tail. Useful for DNs.
export function truncMid(input: string, head = 24, tail = 18): string {
  if (input.length <= head + tail + 1) return input;
  return `${input.slice(0, head)}…${input.slice(-tail)}`;
}
