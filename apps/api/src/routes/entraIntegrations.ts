// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import {
  ENTRA_FEATURE_KEYS,
  type EntraFeatureKey,
  type EntraIntegrationInput,
} from '../services/entraIntegration.js';
import { GraphClient } from '../services/graphClient.js';
import { ENTRA_TASK_KEYS } from '../services/syncTasks/registry.js';

// Per-directory Entra (Microsoft Graph) integration management. Mirrors
// the AD directory routes' shape — list / put / delete / test — and uses
// the same step-up gate for any change to a stored secret.
//
// Reads (GET integration, GET photo) require `read:user` so the photo on
// a user's detail card doesn't 403 for an operator who can read users
// but not configure the directory.

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const featuresSchema = z
  .object(
    Object.fromEntries(ENTRA_FEATURE_KEYS.map((k) => [k, z.boolean()])) as Record<
      EntraFeatureKey,
      z.ZodBoolean
    >,
  )
  .partial();

const putSchema = z
  .object({
    tenantId: z.string().uuid({ message: 'tenantId must be a GUID' }),
    clientId: z.string().trim().min(1).max(128),
    clientSecret: z.string().min(1).max(2048).optional(),
    enabled: z.boolean().optional(),
    features: featuresSchema.optional(),
    /**
     * Empty string clears the stored webhook URL; non-empty re-encrypts.
     * Validated as a URL so a typo doesn't get stored as the trigger.
     */
    teamsWebhookUrl: z
      .union([z.string().url({ message: 'teamsWebhookUrl must be a valid URL' }), z.literal('')])
      .optional(),
  })
  .refine(
    (v) => v.tenantId !== undefined && v.clientId !== undefined,
    'tenantId and clientId are required',
  );

export async function registerEntraIntegrationRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/directories/:id/entra ----------------------------------
  // Returns the integration summary (no secrets). Used by the settings
  // UI on initial load and by the user-detail page to decide whether to
  // show the photo + sign-in fields.
  app.get('/api/directories/:id/entra', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const integration = await app.services.entraIntegration.getByProviderId(id);
      return { integration };
    },
  });

  // ---- PUT /api/directories/:id/entra ----------------------------------
  // Upsert. First-time call requires clientSecret (caught at the
  // service); subsequent updates may omit it to keep the existing one,
  // or send empty string to clear it.
  app.put('/api/directories/:id/entra', {
    preHandler: [app.requireCapability('configure:directory'), app.requireStepUp],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = putSchema.parse(req.body);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');

      const existing = await app.services.entraIntegration.getByProviderId(id);
      // Zod's `.partial()` produces a type where every key is `T |
      // undefined`; with exactOptionalPropertyTypes the service expects
      // `T` for present keys. Strip undefined values so the shape lines
      // up.
      const features = body.features
        ? (Object.fromEntries(
            Object.entries(body.features).filter(([, v]) => v !== undefined),
          ) as Record<string, boolean>)
        : undefined;
      const input: EntraIntegrationInput = {
        tenantId: body.tenantId,
        clientId: body.clientId,
        ...(body.clientSecret !== undefined ? { clientSecret: body.clientSecret } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(features !== undefined ? { features } : {}),
        ...(body.teamsWebhookUrl !== undefined ? { teamsWebhookUrl: body.teamsWebhookUrl } : {}),
      };

      let integration;
      if (existing) {
        integration = await app.services.entraIntegration.update(id, input);
      } else {
        if (!body.clientSecret) {
          throw app.httpErrors.badRequest(
            'clientSecret is required when first configuring an Entra integration',
          );
        }
        integration = await app.services.entraIntegration.create(id, input);
      }

      // Drop the cached Graph client so the next call picks up the new
      // creds (tenant, client_id, secret).
      app.services.graphClient.invalidate(id);

      // Backfill Entra task rows now that the integration is configured.
      // The seeder treats Entra tasks as opt-in based on integration
      // state, so a fresh-install directory has no Entra rows in the
      // Tasks UI until this point.
      if (integration.enabled && integration.hasClientSecret) {
        await app.services.syncTasks
          .ensureSeeded(id, { hasEntra: true })
          .catch((err) => req.log.warn({ err, providerId: id }, 'entra task seeding failed'));
      }

      const changedFields = Object.keys(body).filter((k) => k !== 'clientSecret');
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: existing ? 'directory.entra.update' : 'directory.entra.create',
          result: 'success',
          actorAuthMethod: 'step-up',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          metadata: {
            changedFields,
            secretRotated: body.clientSecret !== undefined,
            webhookSet: body.teamsWebhookUrl !== undefined && body.teamsWebhookUrl !== '',
          },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for directory.entra change'));

      return { integration };
    },
  });

  // ---- DELETE /api/directories/:id/entra -------------------------------
  app.delete('/api/directories/:id/entra', {
    preHandler: [app.requireCapability('configure:directory'), app.requireStepUp],
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const removed = await app.services.entraIntegration.deleteByProviderId(id);
      app.services.graphClient.invalidate(id);
      // Drop entra-gated task rows alongside the integration so the
      // Tasks UI doesn't keep showing rows the operator can't run.
      await app.services.syncTasks
        .removeTasks(id, ENTRA_TASK_KEYS)
        .catch((err) => req.log.warn({ err, providerId: id }, 'entra task cleanup failed'));
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.entra.delete',
          // 'success' even when no row existed — the operator-facing
          // intent (no integration after this call) was achieved.
          result: 'success',
          actorAuthMethod: 'step-up',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          metadata: { existed: removed },
        })
        .catch(() => undefined);
      return { ok: removed };
    },
  });

  // ---- POST /api/directories/:id/entra/test ----------------------------
  // Probe the configured creds — token acquire + GET /organization. The
  // result is recorded on the integration row so the UI doesn't need a
  // separate "last test" endpoint.
  app.post('/api/directories/:id/entra/test', {
    preHandler: app.requireCapability('configure:directory'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const integration = await app.services.entraIntegration.getByProviderId(id);
      if (!integration) {
        throw app.httpErrors.badRequest('entra integration not configured');
      }
      if (!integration.hasClientSecret) {
        throw app.httpErrors.badRequest('no client secret stored — set one before testing');
      }

      // Bypass the factory cache for this probe — operators expect the
      // freshly-saved creds to be tested, not whatever was cached before
      // the save. Build a one-shot client with current creds.
      const creds = await app.services.entraIntegration.getCreds(id);
      if (!creds) {
        throw app.httpErrors.badRequest('entra creds unavailable');
      }
      const client = new GraphClient(creds, req.log);
      const result = await client.testConnection();
      await app.services.entraIntegration.recordTestResult(id, {
        ok: result.ok,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
      // Refresh the factory cache so subsequent reads see the new creds.
      app.services.graphClient.invalidate(id);

      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.entra.test',
          result: result.ok ? 'success' : 'failure',
          actorAuthMethod: 'step-up',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          ...(result.ok ? {} : { errorCode: 'graph_test_failed' }),
        })
        .catch(() => undefined);

      return {
        ok: result.ok,
        message: result.ok
          ? `connected${result.tenantDisplayName ? ` to ${result.tenantDisplayName}` : ''}`
          : (result.error ?? 'unknown error'),
        tenantDisplayName: result.tenantDisplayName ?? null,
      };
    },
  });

  // ---- GET /api/directories/:id/signin-events --------------------------
  // Query the local entra_signin_events cache, populated by the
  // entra.signins.events runner. Filters: userId (AD objectGuid),
  // appId, status (success|failure|all), date range (fromIso/toIso),
  // free-text (matches against user UPN/display, app name, IP).
  // Pagination is page-based (table-style) because the SPA renders
  // them in DataTable / "Load more" patterns.
  app.get('/api/directories/:id/signin-events', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const querySchema = z.object({
        userId: z.string().uuid().optional(),
        appId: z.string().min(1).max(128).optional(),
        status: z.enum(['success', 'failure', 'all']).optional(),
        fromIso: z.string().datetime({ offset: true }).optional(),
        toIso: z.string().datetime({ offset: true }).optional(),
        search: z.string().max(256).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      });
      const q = querySchema.parse(req.query);

      const integration = await app.services.entraIntegration.getByProviderId(id);
      if (!integration || !integration.enabled) {
        return reply.code(404).send({ error: 'entra integration not configured' });
      }

      return await app.services.signInEvents.query(id, q);
    },
  });

  // ---- GET /api/directories/:id/signin-events/apps ---------------------
  // Distinct app list for the audit-tab filter dropdown.
  app.get('/api/directories/:id/signin-events/apps', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const apps = await app.services.signInEvents.distinctApps(id);
      return { apps };
    },
  });

  // ---- GET /api/directories/:id/signin-events/:eventId -----------------
  // Full event detail including everything not promoted to columns.
  // Powers the row-click modal; the list endpoint omits detail_json to
  // keep the wire size small.
  app.get('/api/directories/:id/signin-events/:eventId', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { eventId } = z
        .object({ eventId: z.coerce.number().int().positive() })
        .parse(req.params);
      const event = await app.services.signInEvents.getById(id, eventId);
      if (!event) return reply.code(404).send({ error: 'event not found' });
      return { event };
    },
  });

  // ---- GET /api/directories/:id/mfa-registration -----------------------
  // Snapshot of MFA registration state across users. Backed by
  // user_entra_enrichment (populated by entra.mfa.registration). The
  // audit-side MFA tab uses this to surface "who has MFA, who doesn't,
  // who's using which method" without forcing the operator to open
  // every user individually.
  //
  // Filters:
  //   status — 'registered' | 'capable_not_registered' | 'not_capable' | 'all'
  //   method — exact method name (mobilePhone, microsoftAuthenticatorPush, …)
  //   search — substring match on UPN / displayName
  app.get('/api/directories/:id/mfa-registration', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const querySchema = z.object({
        status: z
          .enum(['all', 'registered', 'capable_not_registered', 'not_capable'])
          .default('all'),
        method: z.string().min(1).max(64).optional(),
        search: z.string().max(256).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      });
      const q = querySchema.parse(req.query);

      const integration = await app.services.entraIntegration.getByProviderId(id);
      if (!integration || !integration.enabled) {
        return reply.code(404).send({ error: 'entra integration not configured' });
      }

      // Inner-join user_cache_records so we always have a current
      // display name + UPN + department to render. Rows where the
      // enrichment exists but the AD user is gone (cloud-only or
      // tombstoned) get filtered — no useful row to render.
      let base = app.db
        .selectFrom('user_entra_enrichment as e')
        .innerJoin('user_cache_records as u', (j) =>
          j
            .onRef('u.provider_id', '=', 'e.provider_id')
            .onRef('u.object_guid', '=', 'e.object_guid'),
        )
        .where('e.provider_id', '=', id)
        .where('u.deleted_at', 'is', null)
        // Only show users the runner has actually visited — null
        // mfa_fetched_at means "we don't know yet" rather than "no MFA".
        .where('e.mfa_fetched_at', 'is not', null);

      if (q.status === 'registered') {
        base = base.where('e.is_mfa_registered', '=', true);
      } else if (q.status === 'capable_not_registered') {
        base = base.where('e.is_mfa_registered', '=', false).where('e.is_mfa_capable', '=', true);
      } else if (q.status === 'not_capable') {
        base = base.where('e.is_mfa_capable', '=', false);
      }

      if (q.method) {
        // jsonb @> '["x"]' = "the methods array contains x". Cheaper
        // and clearer than unnest+filter.
        base = base.where('e.mfa_methods_json', '@>', JSON.stringify([q.method]) as never);
      }

      if (q.search && q.search.trim()) {
        const needle = `%${q.search.trim().toLowerCase()}%`;
        base = base.where((eb) =>
          eb.or([
            eb(eb.fn('lower', ['u.user_principal_name']), 'like', needle),
            eb(eb.fn('lower', ['u.display_name']), 'like', needle),
            eb(eb.fn('lower', ['u.sam_account_name']), 'like', needle),
          ]),
        );
      }

      const offset = (q.page - 1) * q.pageSize;
      const [rows, totalRow] = await Promise.all([
        base
          .select([
            'e.object_guid as user_object_guid',
            'u.user_principal_name',
            'u.display_name',
            'u.sam_account_name',
            'u.department',
            'e.is_mfa_registered',
            'e.is_mfa_capable',
            'e.is_passwordless_capable',
            'e.mfa_methods_json',
            'e.default_mfa_method',
            'e.mfa_fetched_at',
          ])
          .orderBy(
            // Surface the most interesting (capable-but-unregistered) at the top
            // when the operator hasn't filtered explicitly. Sub-order by name
            // for stability.
            (eb) =>
              eb
                .case()
                .when(
                  eb.and([
                    eb('e.is_mfa_registered', '=', false),
                    eb('e.is_mfa_capable', '=', true),
                  ]),
                )
                .then(0)
                .when('e.is_mfa_registered', '=', false)
                .then(1)
                .else(2)
                .end(),
            'asc',
          )
          .orderBy('u.display_name', 'asc')
          .limit(q.pageSize)
          .offset(offset)
          .execute(),
        base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst(),
      ]);

      return {
        rows: rows.map((r) => ({
          userObjectGuid: r.user_object_guid,
          userPrincipalName: r.user_principal_name,
          userDisplayName: r.display_name,
          samAccountName: r.sam_account_name,
          department: r.department,
          isMfaRegistered: r.is_mfa_registered,
          isMfaCapable: r.is_mfa_capable,
          isPasswordlessCapable: r.is_passwordless_capable,
          methods: parseStringArray(r.mfa_methods_json),
          defaultMethod: r.default_mfa_method,
          fetchedAt: r.mfa_fetched_at ? new Date(r.mfa_fetched_at).toISOString() : null,
        })),
        total: Number(totalRow?.total ?? 0),
        page: q.page,
        pageSize: q.pageSize,
      };
    },
  });

  // ---- GET /api/directories/:id/mfa-registration/methods ---------------
  // Distinct method names actually seen in this tenant — used to power
  // the audit-tab method dropdown. Pulls from the JSONB column via
  // jsonb_array_elements_text and dedupes.
  app.get('/api/directories/:id/mfa-registration/methods', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const rows = await app.db
        // Raw SQL because Kysely doesn't have a first-class
        // jsonb_array_elements helper and the cleaner expression
        // builder routes don't support it without escapes.
        .selectFrom(
          sql<{ method: string }>`(
            SELECT DISTINCT jsonb_array_elements_text(mfa_methods_json) AS method
            FROM user_entra_enrichment
            WHERE provider_id = ${id} AND mfa_methods_json IS NOT NULL
          )`.as('m'),
        )
        .selectAll()
        .orderBy('method', 'asc')
        .execute();
      return { methods: rows.map((r) => r.method) };
    },
  });

  // ---- GET /api/directories/:id/users/:userId/photo --------------------
  // Streams cached photo bytes; lazy-fetches from Graph on miss/stale.
  // 404 short-circuits with a "no-photo" header so the SPA can fall back
  // to the initials avatar without retrying.
  app.get('/api/directories/:id/users/:userId/photo', {
    preHandler: app.requireCapability('read:user'),
    handler: async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const { userId } = z
        .object({ userId: z.string().uuid({ message: 'userId must be a GUID' }) })
        .parse(req.params);

      // Resolve user → UPN here so a missing user 404s before we touch Graph.
      const user = await app.db
        .selectFrom('user_cache_records')
        .select(['user_principal_name', 'object_guid'])
        .where('provider_id', '=', id)
        .where('object_guid', '=', userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!user || !user.user_principal_name) {
        return reply.code(404).send({ error: 'user not found or has no UPN' });
      }

      const graph = await app.services.graphClient.build(id);
      const photo = await app.services.photos.getPhoto(
        id,
        user.object_guid,
        user.user_principal_name,
        graph,
      );

      if (!photo) {
        // Use a custom header so the SPA can distinguish "no photo on
        // file" from "user not found" — both are 404 to the browser but
        // the latter retries are wasted.
        reply.header('X-Photo-Status', 'absent');
        return reply.code(404).send();
      }

      reply.header('Content-Type', photo.contentType);
      reply.header('Cache-Control', 'private, max-age=600');
      if (photo.etag) reply.header('ETag', photo.etag);
      return reply.send(photo.bytes);
    },
  });
}

function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}
