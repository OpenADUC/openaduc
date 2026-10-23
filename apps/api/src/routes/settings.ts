// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  ROLE_MEMBERS_SHOWN,
  ROLES,
  rolesResponseSchema,
  rolesUpdateRequestSchema,
  type Role,
  type RoleMapping,
  type RolesResponse,
} from '@openaduc/shared';
import { z } from 'zod';
import { BadRequest, Conflict } from '../plugins/errorHandler.js';
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
  'stepup.idle_timeout_minutes': { type: 'number', min: 1, max: 480 },
  'stepup.absolute_lifetime_minutes': { type: 'number', min: 1, max: 1440 },
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
    config: { policy: { capability: null, stepUp: false, directory: 'none' } },
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
  // ALLOWED_SETTINGS or the whole patch is rejected. Needs step-up: these
  // settings can turn off view auditing and lengthen sessions. Audited per
  // key.
  app.patch('/api/settings', {
    config: { policy: { capability: 'configure:security', stepUp: true, directory: 'none' } },
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
            // One set of settings for every directory.
            providerId: null,
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

// ---- Role mapping ----------------------------------------------------------
//
// Each OpenADUC role (admin, operator, auditor) is granted to the direct
// members of one AD group, stored as authz.<role>_group_dn.

const roleKey = (role: Role) => `authz.${role}_group_dn`;

export async function registerRoleMappingRoutes(app: FastifyInstance): Promise<void> {
  async function currentMapping(): Promise<Record<Role, string | null>> {
    const rows = await app.db
      .selectFrom('app_settings')
      .select(['key', 'value_json'])
      .where(
        'key',
        'in',
        ROLES.map((r) => roleKey(r)),
      )
      .execute();
    const byKey = new Map(rows.map((r) => [r.key, r.value_json as string | null]));
    return Object.fromEntries(ROLES.map((r) => [r, byKey.get(roleKey(r)) ?? null])) as Record<
      Role,
      string | null
    >;
  }

  // Roles go to direct members only, so every count and check here
  // ignores memberships that come through nested groups.
  async function findGroup(providerId: number, dn: string) {
    return app.db
      .selectFrom('group_cache_records as g')
      .select((eb) => [
        'g.object_guid',
        'g.name',
        'g.distinguished_name',
        eb
          .selectFrom('user_group_memberships as m')
          .select((m) => m.fn.countAll<string>().as('n'))
          .whereRef('m.group_object_guid', '=', 'g.object_guid')
          .whereRef('m.provider_id', '=', 'g.provider_id')
          .where('m.direct', '=', true)
          .as('member_count'),
      ])
      .where('g.provider_id', '=', providerId)
      .where('g.deleted_at', 'is', null)
      .where(sql<string>`lower(g.distinguished_name)`, '=', dn.toLowerCase())
      .executeTakeFirst();
  }

  async function directMembers(providerId: number, groupGuid: string) {
    const rows = await app.db
      .selectFrom('user_group_memberships as m')
      .innerJoin('user_cache_records as u', (j) =>
        j
          .onRef('u.object_guid', '=', 'm.user_object_guid')
          .onRef('u.provider_id', '=', 'm.provider_id'),
      )
      .select(['u.object_guid', 'u.display_name', 'u.sam_account_name'])
      .where('m.provider_id', '=', providerId)
      .where('m.group_object_guid', '=', groupGuid)
      .where('m.direct', '=', true)
      .where('u.deleted_at', 'is', null)
      .orderBy(sql`lower(coalesce(u.display_name, u.sam_account_name))`)
      .limit(ROLE_MEMBERS_SHOWN)
      .execute();
    return rows.map((r) => ({
      id: r.object_guid,
      displayName: r.display_name,
      samAccountName: r.sam_account_name ?? '',
    }));
  }

  async function isDirectMember(providerId: number, groupGuid: string, userGuid: string) {
    return !!(await app.db
      .selectFrom('user_group_memberships')
      .select('user_object_guid')
      .where('provider_id', '=', providerId)
      .where('group_object_guid', '=', groupGuid)
      .where('user_object_guid', '=', userGuid)
      .where('direct', '=', true)
      .executeTakeFirst());
  }

  // ---- GET /api/settings/roles -------------------------------------------
  app.get('/api/settings/roles', {
    config: { policy: { capability: 'configure:security', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<RolesResponse> => {
      const mapping = await currentMapping();
      const providerId = req.actor!.session.directoryId;
      const roles = {} as Record<Role, RoleMapping>;
      for (const role of ROLES) {
        const dn = mapping[role];
        const group = dn ? await findGroup(providerId, dn) : undefined;
        roles[role] = {
          groupDn: dn,
          groupName: group?.name ?? null,
          memberCount: group ? Number(group.member_count ?? 0) : null,
          members: group ? await directMembers(providerId, group.object_guid) : [],
        };
      }
      return rolesResponseSchema.parse({ roles });
    },
  });

  // ---- PUT /api/settings/roles -------------------------------------------
  // Body: any of { admin, operator, auditor } as a group DN, or null to
  // unassign. Takes effect at each operator's next sign-in or step-up.
  app.put('/api/settings/roles', {
    config: { policy: { capability: 'configure:security', stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const body = rolesUpdateRequestSchema.parse(req.body);
      const actor = req.actor!;
      const providerId = actor.session.directoryId;
      const before = await currentMapping();
      const after = { ...before };
      for (const role of ROLES) {
        const dn = body[role];
        if (dn === undefined) continue;
        if (dn !== null && !(await findGroup(providerId, dn))) {
          throw BadRequest(`"${dn}" is not a group in this directory (or it hasn't synced yet)`);
        }
        after[role] = dn;
      }

      // Moving or clearing the admin role can lock the current admin out.
      const newAdmin = after.admin;
      if ((newAdmin ?? '').toLowerCase() !== (before.admin ?? '').toLowerCase()) {
        const group = newAdmin ? await findGroup(providerId, newAdmin) : undefined;
        const keepsAdmin = group
          ? await isDirectMember(providerId, group.object_guid, actor.session.actorUserId)
          : false;
        if (!keepsAdmin && !body.confirmAdminChange) {
          throw Conflict(
            newAdmin
              ? "You aren't a direct member of that group, so you'd lose admin rights at your next sign-in. Confirm to go ahead."
              : 'With no admin group, nobody (you included) gets admin rights at their next sign-in. Confirm to go ahead.',
          );
        }
      }

      await app.db.transaction().execute(async (trx) => {
        for (const role of ROLES) {
          if (after[role] === before[role]) continue;
          const change = {
            value_json: JSON.stringify(after[role]),
            updated_by_actor_id: actor.session.actorUserId,
            updated_at: new Date(),
          };
          await trx
            .insertInto('app_settings')
            .values({ key: roleKey(role), ...change })
            .onConflict((oc) => oc.column('key').doUpdateSet(change))
            .execute();
        }
      });
      for (const role of ROLES) app.services.settings.invalidate(roleKey(role));

      await app.services.audit.recordEvent({
        ...auditContextFromRequest(req),
        action: 'settings.roles.update',
        result: 'success',
        actorAuthMethod: 'ad-password',
        // The role mapping applies to every directory.
        providerId: null,
        targetType: 'config',
        targetId: 'roles',
        before,
        after,
      });
      return { ok: true };
    },
  });
}
