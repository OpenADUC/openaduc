// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { Env } from '../config/env.js';
import type { DB } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../lib/encryption.js';
import {
  ActiveDirectoryProvider,
  type ActiveDirectoryProviderConfig,
} from '../providers/active-directory/provider.js';

// Public-shape view of a directory_providers row. There are no bind
// credentials stored alongside the directory anymore — every operation
// binds as whichever real user is calling.
export interface DirectoryProviderSummary {
  id: number;
  name: string;
  displayName: string | null;
  type: string;
  domain: string;
  baseDn: string;
  ldapUrls: string[];
  tlsMode: string;
  /**
   * Per-directory TLS hardening setting. False = accept self-signed certs
   * (lab / on-prem dev DCs). The env var is the global default; this
   * column overrides it per directory so a single instance can mix
   * production-strict and lab-permissive directories.
   */
  tlsRejectUnauthorized: boolean | null;
  configured: boolean;
  /** Background-sync service account UPN. Null = sync not configured. */
  syncBindUpn: string | null;
  /** Whether a sync bind password is stored. Never returns the password. */
  hasSyncBindPassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DirectoryProviderInput {
  name: string;
  displayName?: string | null;
  type: 'active-directory';
  domain: string;
  baseDn: string;
  ldapUrls: string[];
  tlsMode: 'ldaps' | 'starttls' | 'plain';
  tlsRejectUnauthorized?: boolean;
  operationTimeoutMs?: number;
  /** Background-sync service-account UPN. Optional. */
  syncBindUpn?: string | null;
  /**
   * Background-sync service-account password. Encrypted at rest. Send only
   * when setting/rotating; omit to leave the existing one alone.
   */
  syncBindPassword?: string;
}

/**
 * Build an in-memory provider config without touching the DB. Used at
 * setup-time to test the supplied admin's credentials before we persist
 * the directory configuration.
 */
export function buildEphemeralProvider(
  input: DirectoryProviderInput & { bindUpn: string; bindPassword: string },
  fallbacks: {
    tlsRejectUnauthorized: boolean;
    operationTimeoutMs: number;
    tlsCaPath?: string | undefined;
  },
): ActiveDirectoryProvider {
  const cfg: ActiveDirectoryProviderConfig = {
    id: 0,
    name: input.name,
    baseDn: input.baseDn,
    ldapUrls: input.ldapUrls,
    tlsRejectUnauthorized: input.tlsRejectUnauthorized ?? fallbacks.tlsRejectUnauthorized,
    tlsCaPath: fallbacks.tlsCaPath,
    operationTimeoutMs: input.operationTimeoutMs ?? fallbacks.operationTimeoutMs,
    serviceAccountUpn: input.bindUpn,
    serviceAccountPassword: input.bindPassword,
  };
  return new ActiveDirectoryProvider(cfg);
}

export class DirectoryConfigService {
  constructor(
    private readonly db: Kysely<DB>,
    // env is unused now that bind credentials aren't stored, but kept on the
    // service for future per-directory env defaults (timeouts, etc.).
    _env: Env,
  ) {}

  /** True iff at least one configured directory_providers row exists. */
  async anyConfigured(): Promise<boolean> {
    const row = await this.db
      .selectFrom('directory_providers')
      .select('id')
      .where('configured', '=', true)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Public, unauthenticated view of configured directories used by the login
   * page's domain dropdown.
   */
  async listPublic(): Promise<
    { id: number; name: string; displayName: string | null; domain: string }[]
  > {
    const rows = await this.db
      .selectFrom('directory_providers')
      .select(['id', 'name', 'display_name', 'domain_name'])
      .where('configured', '=', true)
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      displayName: row.display_name,
      domain: row.domain_name,
    }));
  }

  async getById(id: number): Promise<DirectoryProviderSummary | null> {
    const row = await this.db
      .selectFrom('directory_providers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToSummary(row) : null;
  }

  /**
   * Insert a new configured directory. Per-session reads bind as the
   * logged-in admin, so we do NOT store any user-facing bind credentials.
   * The optional sync service account (used by the background scheduler
   * only) is encrypted at rest when supplied.
   */
  async create(input: DirectoryProviderInput): Promise<DirectoryProviderSummary> {
    const row = await this.db
      .insertInto('directory_providers')
      .values({
        name: input.name,
        display_name: input.displayName ?? null,
        type: input.type,
        domain_name: input.domain,
        base_dn: input.baseDn,
        ldap_urls: input.ldapUrls,
        tls_mode: input.tlsMode,
        config_json: JSON.stringify({
          tlsRejectUnauthorized: input.tlsRejectUnauthorized,
          operationTimeoutMs: input.operationTimeoutMs,
        }),
        configured: true,
        sync_bind_upn: input.syncBindUpn ?? null,
        sync_bind_secret_encrypted: input.syncBindPassword
          ? encryptSecret(input.syncBindPassword)
          : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToSummary(row);
  }

  /**
   * Decrypt and return the sync service account credentials for a
   * directory. Used only by the SyncService — never reaches a route.
   * Returns null when sync hasn't been configured for this directory.
   */
  async getSyncBindCreds(id: number): Promise<{ username: string; password: string } | null> {
    const row = await this.db
      .selectFrom('directory_providers')
      .select(['sync_bind_upn', 'sync_bind_secret_encrypted'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || !row.sync_bind_upn || !row.sync_bind_secret_encrypted) return null;
    return {
      username: row.sync_bind_upn,
      password: decryptSecret(row.sync_bind_secret_encrypted),
    };
  }

  async update(
    id: number,
    patch: Partial<DirectoryProviderInput>,
  ): Promise<DirectoryProviderSummary> {
    const row = await this.db
      .selectFrom('directory_providers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new Error(`directory provider ${id} not found`);

    const existingConfig = (row.config_json as Record<string, unknown> | null) ?? {};
    const nextConfig = {
      ...existingConfig,
      ...(patch.tlsRejectUnauthorized !== undefined
        ? { tlsRejectUnauthorized: patch.tlsRejectUnauthorized }
        : {}),
      ...(patch.operationTimeoutMs !== undefined
        ? { operationTimeoutMs: patch.operationTimeoutMs }
        : {}),
    };

    const setClause: Record<string, unknown> = {
      updated_at: new Date(),
      config_json: JSON.stringify(nextConfig),
    };
    if (patch.name !== undefined) setClause.name = patch.name;
    if (patch.displayName !== undefined) setClause.display_name = patch.displayName;
    if (patch.domain !== undefined) setClause.domain_name = patch.domain;
    if (patch.baseDn !== undefined) setClause.base_dn = patch.baseDn;
    if (patch.ldapUrls !== undefined) setClause.ldap_urls = patch.ldapUrls;
    if (patch.tlsMode !== undefined) setClause.tls_mode = patch.tlsMode;
    if (patch.syncBindUpn !== undefined) {
      setClause.sync_bind_upn = patch.syncBindUpn;
    }
    if (patch.syncBindPassword !== undefined) {
      // Empty string clears the stored secret; any other value re-encrypts.
      setClause.sync_bind_secret_encrypted = patch.syncBindPassword
        ? encryptSecret(patch.syncBindPassword)
        : null;
    }

    const updated = await this.db
      .updateTable('directory_providers')
      .set(setClause)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return rowToSummary(updated);
  }

  async listAll(): Promise<DirectoryProviderSummary[]> {
    const rows = await this.db
      .selectFrom('directory_providers')
      .selectAll()
      .orderBy('configured', 'desc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(rowToSummary);
  }
}

function parseTlsRejectUnauthorized(config: unknown): boolean | null {
  if (!config || typeof config !== 'object') return null;
  const v = (config as { tlsRejectUnauthorized?: unknown }).tlsRejectUnauthorized;
  return typeof v === 'boolean' ? v : null;
}

function rowToSummary(row: {
  id: number | string;
  name: string;
  display_name: string | null;
  type: string;
  domain_name: string;
  base_dn: string;
  ldap_urls: string[];
  tls_mode: string;
  config_json: unknown;
  configured: boolean;
  sync_bind_upn?: string | null;
  sync_bind_secret_encrypted?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): DirectoryProviderSummary {
  return {
    id: Number(row.id),
    name: row.name,
    displayName: row.display_name,
    type: row.type,
    domain: row.domain_name,
    baseDn: row.base_dn,
    ldapUrls: row.ldap_urls,
    tlsMode: row.tls_mode,
    tlsRejectUnauthorized: parseTlsRejectUnauthorized(row.config_json),
    configured: row.configured,
    syncBindUpn: row.sync_bind_upn ?? null,
    hasSyncBindPassword: !!row.sync_bind_secret_encrypted,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
