// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';

// Phase 4 ships the minimum audit surface the auth flow needs.
// Phase 5 expands this with redaction helpers, withAudit() wrappers, and
// search/export routes. The recordEvent() signature here is forward-compatible.

export interface AuditEventInput {
  action: string;
  result: 'success' | 'failure' | 'denied';

  // Actor — null/unset if the event happens before authentication (e.g. failed login).
  actorUserId?: string | null;
  actorDisplayName?: string | null;
  actorAuthMethod?: 'ad-password' | 'sso' | 'system' | 'step-up' | 'local' | null;

  // Request metadata.
  sourceIp?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;

  // Provider + target.
  providerId?: number | null;
  targetType?: 'user' | 'group' | 'computer' | 'ou' | 'session' | 'config' | 'system' | null;
  targetId?: string | null;
  targetDn?: string | null;

  errorCode?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

// Sensitive keys that must never reach the audit log even if a caller
// accidentally puts them in metadata/before/after.
const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'pwd',
  'unicodepwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'set-cookie',
]);

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export class AuditService {
  // In-memory dedupe for "view" style audit events. Keyed by
  // `${sessionId}:${targetType}:${targetId}` → ms timestamp of the last
  // recorded view. Used by shouldRecordView() so the UI doesn't pile up a
  // fresh `user.view` row every time the detail page reloads (post-write
  // refresh, browser back-button, polling) within a short window.
  //
  // Lives in process memory only — losing this on restart just means one
  // extra audit row, never a missed write or compliance hole.
  private readonly recentViews = new Map<string, number>();
  private readonly viewSweepHandle: NodeJS.Timeout;
  private readonly viewDedupeWindowMs = 5 * 60_000;

  constructor(private readonly db: Kysely<DB>) {
    this.viewSweepHandle = setInterval(() => this.sweepRecentViews(), 60_000);
    this.viewSweepHandle.unref?.();
  }

  /**
   * Decide whether to emit a view audit row. Returns true the first time a
   * given (session, target) pair is seen, and again only after the dedupe
   * window has elapsed since the last seen-time. Subsequent reloads of the
   * same record within the window are suppressed.
   *
   * Sessionless callers (sessionId=null) are never deduped — those are
   * unauthenticated reads where we want to capture every hit.
   */
  shouldRecordView(
    sessionId: string | null,
    targetType: 'user' | 'group' | 'computer',
    targetId: string,
  ): boolean {
    if (!sessionId) return true;
    const key = `${sessionId}:${targetType}:${targetId}`;
    const now = Date.now();
    const last = this.recentViews.get(key);
    if (last !== undefined && now - last < this.viewDedupeWindowMs) {
      return false;
    }
    this.recentViews.set(key, now);
    return true;
  }

  stopViewDedupeSweep(): void {
    clearInterval(this.viewSweepHandle);
  }

  private sweepRecentViews(): void {
    const cutoff = Date.now() - this.viewDedupeWindowMs;
    for (const [k, ts] of this.recentViews) {
      if (ts < cutoff) this.recentViews.delete(k);
    }
  }

  /**
   * Insert an audit event. Throws on DB failure — high-risk-write callers
   * (Phase 5's withAudit wrapper) should propagate this so the corresponding
   * write fails closed.
   */
  async recordEvent(input: AuditEventInput): Promise<void> {
    const before = input.before ? (redact(input.before) as Record<string, unknown>) : null;
    const after = input.after ? (redact(input.after) as Record<string, unknown>) : null;
    const metadata = input.metadata ? (redact(input.metadata) as Record<string, unknown>) : {};

    await this.db
      .insertInto('audit_events')
      .values({
        action: input.action,
        result: input.result,
        actor_user_id: input.actorUserId ?? null,
        actor_display_name: input.actorDisplayName ?? null,
        actor_auth_method: input.actorAuthMethod ?? null,
        source_ip: input.sourceIp ?? null,
        user_agent: input.userAgent ?? null,
        session_id: input.sessionId ?? null,
        correlation_id: input.correlationId ?? null,
        provider_id: input.providerId ?? null,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        target_dn: input.targetDn ?? null,
        error_code: input.errorCode ?? null,
        before_json: before ? JSON.stringify(before) : null,
        after_json: after ? JSON.stringify(after) : null,
        metadata_json: JSON.stringify(metadata),
      })
      .execute();
  }
}
