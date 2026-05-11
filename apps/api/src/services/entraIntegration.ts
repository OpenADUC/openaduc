// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { decryptSecret, encryptSecret } from '../lib/encryption.js';

// Per-directory Microsoft Entra (Graph) integration. Sibling to
// DirectoryConfigService — same shape but for the optional Graph layer
// that augments an AD directory with photos, sign-in activity, and Teams
// notifications.
//
// Secrets (client_secret, teams_webhook_url) are AES-256-GCM enveloped at
// rest. Plaintext leaves this service only via the dedicated `getCreds`
// path, which the GraphClient and the test-connection route consume. The
// public summary type intentionally omits secret material.

export const ENTRA_FEATURE_KEYS = [
  'photos',
  'signInActivity',
  'signInEvents',
  'mfaRegistration',
  'teamsAdminWebhook',
  'passwordExpiryNotifications',
] as const;
export type EntraFeatureKey = (typeof ENTRA_FEATURE_KEYS)[number];

export type EntraFeatureFlags = Partial<Record<EntraFeatureKey, boolean>>;

export interface EntraIntegrationSummary {
  id: number;
  providerId: number;
  tenantId: string;
  clientId: string;
  /** True when a client secret is stored. Never returns the secret itself. */
  hasClientSecret: boolean;
  enabled: boolean;
  features: EntraFeatureFlags;
  /** True when an admin Teams webhook URL is stored. Never returns the URL. */
  hasTeamsWebhookUrl: boolean;
  lastTestAt: Date | null;
  lastTestStatus: 'success' | 'failure' | null;
  lastTestError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntraIntegrationInput {
  tenantId: string;
  clientId: string;
  /**
   * Plaintext client secret. Send only to set/rotate; omit to keep the
   * existing one. Empty string clears the stored secret.
   */
  clientSecret?: string;
  enabled?: boolean;
  features?: EntraFeatureFlags;
  /**
   * Plaintext Teams incoming webhook URL. Same set/clear/keep semantics
   * as clientSecret.
   */
  teamsWebhookUrl?: string;
}

export interface EntraIntegrationCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  teamsWebhookUrl: string | null;
}

type Row = {
  id: number | string;
  provider_id: number | string;
  tenant_id: string;
  client_id: string;
  client_secret_encrypted: string | null;
  enabled: boolean;
  features_json: unknown;
  teams_webhook_url_encrypted: string | null;
  last_test_at: Date | string | null;
  last_test_status: string | null;
  last_test_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export class EntraIntegrationService {
  constructor(private readonly db: Kysely<DB>) {}

  async getByProviderId(providerId: number): Promise<EntraIntegrationSummary | null> {
    const row = await this.db
      .selectFrom('directory_entra_integrations')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
    return row ? rowToSummary(row as Row) : null;
  }

  /**
   * True iff an integration row exists, is enabled, and has the named
   * feature opted-in. Used by scheduler / runners to gate work.
   */
  async isFeatureEnabled(providerId: number, feature: EntraFeatureKey): Promise<boolean> {
    const summary = await this.getByProviderId(providerId);
    if (!summary || !summary.enabled) return false;
    if (!summary.hasClientSecret) return false;
    return summary.features[feature] === true;
  }

  /**
   * Decrypt and return everything the GraphClient needs to make outbound
   * calls. Returns null when no integration is configured for the
   * directory or when the client secret has been cleared. Throws on
   * decryption failure (envelope mismatch / wrong key).
   */
  async getCreds(providerId: number): Promise<EntraIntegrationCreds | null> {
    const row = await this.db
      .selectFrom('directory_entra_integrations')
      .select(['tenant_id', 'client_id', 'client_secret_encrypted', 'teams_webhook_url_encrypted'])
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
    if (!row) return null;
    if (!row.client_secret_encrypted) return null;
    return {
      tenantId: row.tenant_id,
      clientId: row.client_id,
      clientSecret: decryptSecret(row.client_secret_encrypted),
      teamsWebhookUrl: row.teams_webhook_url_encrypted
        ? decryptSecret(row.teams_webhook_url_encrypted)
        : null,
    };
  }

  /**
   * Insert a new integration row. The PUT route also calls this for the
   * upsert-from-empty path; existing rows go through `update` instead.
   */
  async create(providerId: number, input: EntraIntegrationInput): Promise<EntraIntegrationSummary> {
    if (!input.clientSecret) {
      throw new Error('clientSecret is required when creating an Entra integration');
    }
    const features = sanitizeFeatures(input.features);
    const row = await this.db
      .insertInto('directory_entra_integrations')
      .values({
        provider_id: providerId,
        tenant_id: input.tenantId,
        client_id: input.clientId,
        client_secret_encrypted: encryptSecret(input.clientSecret),
        enabled: input.enabled ?? true,
        features_json: JSON.stringify(features),
        teams_webhook_url_encrypted: input.teamsWebhookUrl
          ? encryptSecret(input.teamsWebhookUrl)
          : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToSummary(row as Row);
  }

  async update(
    providerId: number,
    patch: Partial<EntraIntegrationInput>,
  ): Promise<EntraIntegrationSummary> {
    const row = await this.db
      .selectFrom('directory_entra_integrations')
      .selectAll()
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
    if (!row) throw new Error(`entra integration for directory ${providerId} not found`);

    const setClause: Record<string, unknown> = { updated_at: new Date() };
    if (patch.tenantId !== undefined) setClause.tenant_id = patch.tenantId;
    if (patch.clientId !== undefined) setClause.client_id = patch.clientId;
    if (patch.clientSecret !== undefined) {
      // Empty string clears the stored secret; non-empty re-encrypts.
      setClause.client_secret_encrypted = patch.clientSecret
        ? encryptSecret(patch.clientSecret)
        : null;
    }
    if (patch.enabled !== undefined) setClause.enabled = patch.enabled;
    if (patch.features !== undefined) {
      // Merge so partial UI updates don't blow away unrelated flags.
      const existing = parseFeatures(row.features_json);
      const merged = sanitizeFeatures({ ...existing, ...patch.features });
      setClause.features_json = JSON.stringify(merged);
    }
    if (patch.teamsWebhookUrl !== undefined) {
      setClause.teams_webhook_url_encrypted = patch.teamsWebhookUrl
        ? encryptSecret(patch.teamsWebhookUrl)
        : null;
    }

    const updated = await this.db
      .updateTable('directory_entra_integrations')
      .set(setClause)
      .where('provider_id', '=', providerId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToSummary(updated as Row);
  }

  /** Remove the integration entirely. Cascade clears photo/enrichment cache. */
  async deleteByProviderId(providerId: number): Promise<boolean> {
    const result = await this.db
      .deleteFrom('directory_entra_integrations')
      .where('provider_id', '=', providerId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async recordTestResult(
    providerId: number,
    result: { ok: boolean; error?: string | null },
  ): Promise<void> {
    await this.db
      .updateTable('directory_entra_integrations')
      .set({
        last_test_at: new Date(),
        last_test_status: result.ok ? 'success' : 'failure',
        last_test_error: result.ok ? null : (result.error ?? null),
        updated_at: new Date(),
      })
      .where('provider_id', '=', providerId)
      .execute();
  }
}

function parseFeatures(raw: unknown): EntraFeatureFlags {
  if (!raw || typeof raw !== 'object') return {};
  const out: EntraFeatureFlags = {};
  for (const k of ENTRA_FEATURE_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function sanitizeFeatures(input: EntraFeatureFlags | undefined): EntraFeatureFlags {
  if (!input) return {};
  const out: EntraFeatureFlags = {};
  for (const k of ENTRA_FEATURE_KEYS) {
    if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  return out;
}

function rowToSummary(row: Row): EntraIntegrationSummary {
  return {
    id: Number(row.id),
    providerId: Number(row.provider_id),
    tenantId: row.tenant_id,
    clientId: row.client_id,
    hasClientSecret: !!row.client_secret_encrypted,
    enabled: row.enabled,
    features: parseFeatures(row.features_json),
    hasTeamsWebhookUrl: !!row.teams_webhook_url_encrypted,
    lastTestAt: row.last_test_at ? new Date(row.last_test_at) : null,
    lastTestStatus:
      row.last_test_status === 'success' || row.last_test_status === 'failure'
        ? row.last_test_status
        : null,
    lastTestError: row.last_test_error,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
