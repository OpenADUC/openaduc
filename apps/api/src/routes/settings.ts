// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';

// Settings exposed to the operator UI. Not every app_settings row is here —
// internal-only keys (e.g. `authz.*` group DNs) don't belong in a generic
// settings panel; they get their own dedicated route when we build that UI.
//
// Each entry declares the value type so the API can validate without
// per-key schemas exploding the route. The `min`/`max` bounds keep operators
// from typing in something that would crash the cron parser or wedge the UI.
const ALLOWED_SETTINGS: Record<
  string,
  {
    type: 'number' | 'number-nullable' | 'boolean' | 'string-nullable';
    min?: number;
    max?: number;
  }
> = {
  'view.password_expiring_days': { type: 'number', min: 1, max: 365 },
  'view.stale_logon_days': { type: 'number', min: 1, max: 3650 },
  'audit.account_view_enabled': { type: 'boolean' },
  'audit.search_enabled': { type: 'boolean' },
  'audit.retention_days': { type: 'number', min: -1, max: 36500 },
  'session.idle_timeout_minutes': { type: 'number', min: 1, max: 1440 },
  'session.absolute_timeout_hours': { type: 'number', min: 1, max: 168 },
  'stepup.ttl_minutes': { type: 'number', min: 1, max: 480 },
  'sync.cron': { type: 'string-nullable' },
};

function validateValue(key: string, value: unknown): unknown {
  const spec = ALLOWED_SETTINGS[key];
  if (!spec) throw BadRequest(`setting "${key}" is not editable here`);
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw BadRequest(`${key} must be boolean`);
    return value;
  }
  if (spec.type === 'string-nullable') {
    if (value === null) return null;
    if (typeof value !== 'string') throw BadRequest(`${key} must be string or null`);
    return value;
  }
  if (spec.type === 'number' || spec.type === 'number-nullable') {
    if (value === null) {
      if (spec.type === 'number-nullable') return null;
      throw BadRequest(`${key} must be a number`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw BadRequest(`${key} must be a number`);
    }
    if (spec.min !== undefined && value < spec.min) {
      throw BadRequest(`${key} must be >= ${spec.min}`);
    }
    if (spec.max !== undefined && value > spec.max) {
      throw BadRequest(`${key} must be <= ${spec.max}`);
    }
    return value;
  }
  throw BadRequest('unsupported setting type');
}

const patchBodySchema = z.record(z.string(), z.unknown());

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/settings ------------------------------------------------
  // Returns all settings the UI is allowed to edit. Read for any signed-in
  // user (the appearance page reads no settings, but the policy page does).
  // Not capability-gated because no sensitive material is exposed here.
  app.get('/api/settings', {
    preHandler: app.requireAuth,
    handler: async () => {
      const rows = await app.db
        .selectFrom('app_settings')
        .select(['key', 'value_json', 'description', 'updated_at'])
        .where('key', 'in', Object.keys(ALLOWED_SETTINGS))
        .execute();
      const settings: Record<
        string,
        { value: unknown; description: string | null; updatedAt: string }
      > = {};
      for (const row of rows) {
        settings[row.key] = {
          value: row.value_json,
          description: row.description ?? null,
          updatedAt:
            row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        };
      }
      return { settings };
    },
  });

  // ---- PATCH /api/settings ----------------------------------------------
  // Body shape: { "key1": value1, "key2": value2, ... }. Each key must be in
  // ALLOWED_SETTINGS or the whole patch is rejected. Capability gated and
  // audited per key.
  app.patch('/api/settings', {
    preHandler: app.requireCapability('configure:security'),
    handler: async (req) => {
      const body = patchBodySchema.parse(req.body);
      const updates = Object.entries(body);
      if (updates.length === 0) throw BadRequest('no settings provided');

      // Validate all values up-front so we don't half-apply a bad patch.
      const validated: { key: string; value: unknown }[] = updates.map(([key, value]) => ({
        key,
        value: validateValue(key, value),
      }));

      const before = await app.db
        .selectFrom('app_settings')
        .select(['key', 'value_json'])
        .where(
          'key',
          'in',
          validated.map((u) => u.key),
        )
        .execute();
      const beforeMap = new Map(before.map((r) => [r.key, r.value_json]));

      const actor = req.actor!;
      await app.db.transaction().execute(async (trx) => {
        for (const u of validated) {
          await trx
            .updateTable('app_settings')
            .set({
              value_json: JSON.stringify(u.value),
              updated_by_actor_id: actor.session.actorUserId,
              updated_at: new Date(),
            })
            .where('key', '=', u.key)
            .execute();
        }
      });

      // Drop the SettingsService TTL cache so subsequent reads see the new
      // values immediately rather than after the 5s window.
      app.services.settings.invalidate();

      // One audit row per key so the audit log isn't a single opaque blob.
      for (const u of validated) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: 'settings.update',
            result: 'success',
            actorAuthMethod: 'ad-password',
            targetType: 'config',
            targetId: u.key,
            metadata: { key: u.key },
            before: { value: beforeMap.get(u.key) ?? null },
            after: { value: u.value },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for settings.update'));
      }

      return { ok: true, updated: validated.map((u) => u.key) };
    },
  });
}
