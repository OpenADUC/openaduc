// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import type { SettingsService } from './settings.js';

// ---- Public types -----------------------------------------------------------

export interface AdminSession {
  id: string;
  // The directory this session is scoped to. Every domain-scoped query on this
  // session is filtered by this id; switching domains = re-login.
  directoryId: number;
  actorUserId: string;
  actorDisplayName: string | null;
  actorUsername: string | null;
  actorEmail: string | null;
  actorDn: string | null;
  capabilities: string[];
  sourceIp: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface ElevatedSession {
  id: string;
  adminSessionId: string;
  actorUserId: string;
  authMethod: string;
  capabilities: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CreateSessionInput {
  directoryId: number;
  actorUserId: string;
  actorDisplayName: string | null;
  actorUsername: string | null;
  actorEmail: string | null;
  actorDn: string | null;
  capabilities: string[];
  sourceIp: string | null;
  userAgent: string | null;
}

export interface CreatedSession {
  session: AdminSession;
  /** Raw token to set in the cookie. Never persisted. */
  cookieToken: string;
}

// ---- Service ----------------------------------------------------------------

export class SessionsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly settings: SettingsService,
  ) {}

  // -- Admin sessions --------------------------------------------------------

  async createAdminSession(input: CreateSessionInput): Promise<CreatedSession> {
    const absoluteHours = await this.settings.get<number>('session.absolute_timeout_hours', 12);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + absoluteHours * 60 * 60 * 1000);
    const cookieToken = generateToken();
    const tokenHash = hashToken(cookieToken);

    const row = await this.db
      .insertInto('admin_sessions')
      .values({
        token_hash: tokenHash,
        directory_id: input.directoryId,
        actor_user_id: input.actorUserId,
        actor_display_name: input.actorDisplayName,
        actor_username: input.actorUsername,
        actor_email: input.actorEmail,
        actor_dn: input.actorDn,
        capabilities_json: JSON.stringify(input.capabilities),
        source_ip: input.sourceIp,
        user_agent: input.userAgent,
        expires_at: expiresAt.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { session: rowToSession(row), cookieToken };
  }

  /**
   * Resolve a session by its raw cookie token. Returns null if:
   *   - no row matches the hash
   *   - the row is revoked
   *   - the absolute expiry has passed
   *   - the idle timeout has elapsed since last_seen_at
   *
   * On success, last_seen_at is bumped (sliding session).
   */
  async resolve(cookieToken: string): Promise<AdminSession | null> {
    if (!cookieToken) return null;
    const tokenHash = hashToken(cookieToken);
    const row = await this.db
      .selectFrom('admin_sessions')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    if (!row) return null;
    if (row.revoked_at !== null) return null;

    const now = Date.now();
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt <= now) return null;

    const idleMinutes = await this.settings.get<number>('session.idle_timeout_minutes', 60);
    const lastSeenAt = new Date(row.last_seen_at).getTime();
    if (now - lastSeenAt > idleMinutes * 60 * 1000) return null;

    // Bump last_seen_at. Don't await; the resolve has succeeded — a failure to
    // record activity should not invalidate the request.
    void this.db
      .updateTable('admin_sessions')
      .set({ last_seen_at: new Date(now).toISOString() })
      .where('id', '=', row.id)
      .execute()
      .catch(() => undefined);

    return rowToSession(row);
  }

  /**
   * Revoke an admin session and any elevated sessions it owns. Returns the
   * IDs of revoked elevated sessions so callers can clear out related
   * process-memory caches (e.g. step-up bind passwords).
   */
  async revokeAdminSession(id: string): Promise<{ revokedElevatedIds: string[] }> {
    const now = new Date().toISOString();
    await this.db
      .updateTable('admin_sessions')
      .set({ revoked_at: now })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
    const elevated = await this.db
      .updateTable('elevated_sessions')
      .set({ revoked_at: now })
      .where('admin_session_id', '=', id)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute();
    return { revokedElevatedIds: elevated.map((r) => r.id) };
  }

  /**
   * Rotate the admin session and create an elevated session against the new
   * one in a single step. Used by step-up: the old cookie is revoked and a
   * fresh one is issued, so any leaked pre-elevation token is unusable after
   * elevation.
   *
   * Returns the new admin session (with cookieToken to set), the revoked
   * elevated-session ids from the old admin session, and the freshly created
   * elevated session.
   */
  async rotateAndElevate(args: {
    oldAdminSessionId: string;
    seed: CreateSessionInput;
    elevatedCapabilities: string[];
    authMethod?: string;
  }): Promise<{
    admin: CreatedSession;
    elevated: ElevatedSession;
    revokedElevatedIds: string[];
  }> {
    const admin = await this.createAdminSession(args.seed);
    const elevated = await this.createElevatedSession({
      adminSessionId: admin.session.id,
      actorUserId: args.seed.actorUserId,
      capabilities: args.elevatedCapabilities,
      ...(args.authMethod !== undefined ? { authMethod: args.authMethod } : {}),
    });
    const { revokedElevatedIds } = await this.revokeAdminSession(args.oldAdminSessionId);
    return { admin, elevated, revokedElevatedIds };
  }

  // -- Elevated sessions -----------------------------------------------------

  async createElevatedSession(args: {
    adminSessionId: string;
    actorUserId: string;
    capabilities: string[];
    authMethod?: string;
  }): Promise<ElevatedSession> {
    const ttlMinutes = await this.settings.get<number>('stepup.ttl_minutes', 60);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    const row = await this.db
      .insertInto('elevated_sessions')
      .values({
        admin_session_id: args.adminSessionId,
        actor_user_id: args.actorUserId,
        capabilities_json: JSON.stringify(args.capabilities),
        auth_method: args.authMethod ?? 'ad-rebind',
        expires_at: expiresAt.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToElevated(row);
  }

  /**
   * Find the active elevated session for an admin session, if any. Active =
   * not revoked and not expired.
   */
  async findActiveElevated(adminSessionId: string): Promise<ElevatedSession | null> {
    const row = await this.db
      .selectFrom('elevated_sessions')
      .selectAll()
      .where('admin_session_id', '=', adminSessionId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? rowToElevated(row) : null;
  }

  /**
   * Revoke all active elevated sessions for an admin session. Returns the
   * IDs of revoked rows so callers can clear out related process-memory
   * caches (e.g. step-up bind passwords).
   */
  async revokeElevatedSessionsForAdmin(adminSessionId: string): Promise<string[]> {
    const rows = await this.db
      .updateTable('elevated_sessions')
      .set({ revoked_at: new Date().toISOString() })
      .where('admin_session_id', '=', adminSessionId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute();
    return rows.map((r) => r.id);
  }
}

// ---- Row mappers ------------------------------------------------------------

function rowToSession(row: {
  id: string;
  directory_id: number;
  actor_user_id: string;
  actor_display_name: string | null;
  actor_username: string | null;
  actor_email: string | null;
  actor_dn: string | null;
  capabilities_json: unknown;
  source_ip: string | null;
  user_agent: string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}): AdminSession {
  const caps = parseCapabilities(row.capabilities_json);
  return {
    id: row.id,
    directoryId: Number(row.directory_id),
    actorUserId: row.actor_user_id,
    actorDisplayName: row.actor_display_name,
    actorUsername: row.actor_username,
    actorEmail: row.actor_email,
    actorDn: row.actor_dn,
    capabilities: caps,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    createdAt: toDate(row.created_at),
    lastSeenAt: toDate(row.last_seen_at),
    expiresAt: toDate(row.expires_at),
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : null,
  };
}

function rowToElevated(row: {
  id: string;
  admin_session_id: string;
  actor_user_id: string;
  auth_method: string;
  capabilities_json: unknown;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}): ElevatedSession {
  return {
    id: row.id,
    adminSessionId: row.admin_session_id,
    actorUserId: row.actor_user_id,
    authMethod: row.auth_method,
    capabilities: parseCapabilities(row.capabilities_json),
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
    revokedAt: row.revoked_at ? toDate(row.revoked_at) : null,
  };
}

function parseCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}
