// SPDX-License-Identifier: BUSL-1.1
import type { RunnerContext, RunnerResult } from '../types.js';

// Daily job: scan user_cache_records for accounts whose password is about
// to expire and post an Adaptive Card to the configured Teams admin
// webhook so an operator can act before the account is locked out of the
// network.
//
// Why this lives under entra rather than ad-side:
//   - The notification channel (Teams webhook) is configured per-Entra
//     integration; without it there's nowhere to send.
//   - Direct user notifications (the "tell the user themselves") would
//     also live here and use Graph chatMessage / activityFeed APIs once
//     RSC is in place. v1 only does admin-channel notifications.
//
// We dedupe by storing a "last notified bucket" cursor: a stringified
// list of `${guid}:${bucketDays}` pairs we've already sent today. The
// runner is idempotent if it runs multiple times in the same day —
// re-running won't re-send a notification.

const DEFAULT_BUCKET_DAYS = [3, 7, 14] as const;

interface CursorState {
  date: string; // YYYY-MM-DD in local TZ; resets the dedupe bucket each day.
  notified: string[]; // entries shaped as `${guid}:${bucket}`
}

export async function runEntraPasswordExpiryNotify(ctx: RunnerContext): Promise<RunnerResult> {
  if (!ctx.entra) {
    throw new Error('entra runtime missing — scheduler should have skipped this task');
  }
  if (!ctx.entra.integration.features.passwordExpiryNotifications) {
    return { stats: { skipped: 'passwordExpiryNotifications feature disabled' } };
  }
  if (
    !ctx.entra.integration.features.teamsAdminWebhook ||
    !ctx.entra.integration.hasTeamsWebhookUrl
  ) {
    return { stats: { skipped: 'teams webhook not configured' } };
  }

  const today = isoDate(new Date());
  const cursor = parseCursor(ctx.lastCursor, today);
  const sent = new Set(cursor.notified);

  const now = new Date();
  const horizonMs = Math.max(...DEFAULT_BUCKET_DAYS) * 86_400_000;
  const horizon = new Date(now.getTime() + horizonMs);

  // Look up everyone whose password is about to expire within the
  // largest bucket window. Skip accounts that are disabled, locked, or
  // configured to never expire — those don't need a heads-up.
  const candidates = await ctx.db
    .selectFrom('user_cache_records')
    .select([
      'object_guid',
      'display_name',
      'user_principal_name',
      'sam_account_name',
      'department',
      'password_expires_at',
    ])
    .where('provider_id', '=', ctx.providerId)
    .where('deleted_at', 'is', null)
    .where('enabled', '=', true)
    .where('password_never_expires', '=', false)
    .where('password_expires_at', 'is not', null)
    .where('password_expires_at', '<=', horizon)
    .where('password_expires_at', '>', now)
    .orderBy('password_expires_at', 'asc')
    .execute();

  let notifiedCount = 0;
  let sentCount = 0;
  for (const u of candidates) {
    if (!u.password_expires_at) continue;
    const expiresAt = new Date(u.password_expires_at);
    const daysOut = Math.ceil((expiresAt.getTime() - now.getTime()) / 86_400_000);
    const bucket = pickBucket(daysOut);
    if (!bucket) continue;
    const key = `${u.object_guid}:${bucket}`;
    if (sent.has(key)) continue;

    const result = await ctx.entra.teams.sendAdminMessage(ctx.providerId, {
      title: `Password expires in ${bucket} day${bucket === 1 ? '' : 's'}`,
      text: `${u.display_name ?? u.sam_account_name ?? 'A user'} will be locked out unless their password is rotated. Expires ${expiresAt.toISOString().slice(0, 10)}.`,
      severity: bucket <= 3 ? 'warning' : 'info',
      facts: [
        { name: 'Display name', value: u.display_name ?? '—' },
        { name: 'UPN', value: u.user_principal_name ?? '—' },
        { name: 'Department', value: u.department ?? '—' },
        { name: 'Expires', value: expiresAt.toISOString() },
      ],
    });
    if (result.ok) {
      sent.add(key);
      sentCount++;
    } else {
      ctx.log.warn(
        { reason: result.reason, guid: u.object_guid },
        'password-expiry teams send failed',
      );
    }
    notifiedCount++;
  }

  return {
    cursor: JSON.stringify({ date: today, notified: [...sent] }),
    stats: {
      candidates: candidates.length,
      attempted: notifiedCount,
      sent: sentCount,
    },
  };
}

function pickBucket(daysOut: number): number | null {
  // Match each user against the smallest bucket that still includes them.
  // Treats "expires in 2 days" as the 3-day bucket so we don't drop
  // anyone whose expiration falls between buckets.
  for (const b of DEFAULT_BUCKET_DAYS) {
    if (daysOut <= b) return b;
  }
  return null;
}

function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseCursor(raw: string | null, today: string): CursorState {
  if (!raw) return { date: today, notified: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<CursorState>;
    if (parsed.date === today && Array.isArray(parsed.notified)) {
      return { date: today, notified: parsed.notified.filter((s) => typeof s === 'string') };
    }
  } catch {
    /* fallthrough */
  }
  return { date: today, notified: [] };
}
