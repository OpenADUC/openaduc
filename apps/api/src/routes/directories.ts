// SPDX-License-Identifier: BUSL-1.1
import {
  LDAP_TLS_MODES,
  type LdapTlsMode,
  ldapTransportProblem,
  rebindRequiredReason,
} from '@openaduc/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound, Unauthorized } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import {
  buildEphemeralProvider,
  type DirectoryProviderSummary,
} from '../services/directoryConfig.js';
import { loadEnv } from '../config/env.js';
import { composeBindUpn } from '../lib/usernameParser.js';
import { isKnownTaskKey } from '../services/syncTasks/registry.js';
import { validateCron } from '../services/syncTasks/cron.js';
import {
  SCHEDULE_KINDS,
  isMonthlyDay,
  type MonthlyDay,
  type ScheduleKind,
  type SyncTaskKey,
} from '../services/syncTasks/types.js';

// Adding a directory requires the caller to authenticate against it as an
// admin — same shape as initial setup. The bind is the only proof that the
// supplied configuration is real and that the operator has the rights they
// claim to have. We never persist those credentials; the bind only validates.

const directoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(128).optional(),
  domain: z.string().trim().min(1).max(255),
  baseDn: z.string().trim().min(1).max(512),
  ldapUrls: z.array(z.string().trim().min(1)).min(1).max(10),
  tlsMode: z.enum(LDAP_TLS_MODES).default('ldaps'),
  adminUsername: z.string().trim().min(1).max(256),
  adminPassword: z.string().min(1).max(1024),
  tlsRejectUnauthorized: z.boolean().optional(),
  operationTimeoutMs: z.coerce.number().int().min(1000).max(120000).optional(),
});

const directoryPatchFields = {
  name: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().max(128).nullable().optional(),
  domain: z.string().trim().min(1).max(255).optional(),
  baseDn: z.string().trim().min(1).max(512).optional(),
  ldapUrls: z.array(z.string().trim().min(1)).min(1).max(10).optional(),
  tlsMode: z.enum(LDAP_TLS_MODES).optional(),
  tlsRejectUnauthorized: z.boolean().optional(),
  operationTimeoutMs: z.coerce.number().int().min(1000).max(120000).optional(),
  // Sync service account. Empty strings clear the stored values.
  // Per-task cadences live on directory_sync_tasks (managed via the
  // sync-tasks endpoints), not here.
  syncBindUpn: z.string().trim().max(255).nullable().optional(),
  syncBindPassword: z.string().max(1024).optional(),
};

const directoryPatchSchema = z
  .object(directoryPatchFields)
  .refine((p) => Object.keys(p).length > 0, { message: 'patch must contain at least one field' });

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

function compactPatch<T extends Record<string, unknown>>(
  patch: T,
): Partial<{ [K in keyof T]: NonNullable<T[K]> | (null extends T[K] ? null : never) }> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<{
    [K in keyof T]: NonNullable<T[K]> | (null extends T[K] ? null : never);
  }>;
}

export async function registerDirectoryRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const tlsFallbacks = {
    tlsRejectUnauthorized: env.AD_TLS_REJECT_UNAUTHORIZED,
    operationTimeoutMs: env.AD_OPERATION_TIMEOUT_MS,
    tlsCaPath: env.AD_TLS_CA_PATH,
  };

  /** A provider bound as `bindUpn` against `dir`'s connection settings. */
  function serviceAccountProvider(
    dir: Pick<
      DirectoryProviderSummary,
      'name' | 'domain' | 'baseDn' | 'ldapUrls' | 'tlsMode' | 'tlsRejectUnauthorized'
    >,
    bindUpn: string,
    bindPassword: string,
  ) {
    return buildEphemeralProvider(
      {
        name: dir.name,
        type: 'active-directory',
        domain: dir.domain,
        baseDn: dir.baseDn,
        ldapUrls: dir.ldapUrls,
        tlsMode: dir.tlsMode,
        bindUpn,
        bindPassword,
        tlsRejectUnauthorized: dir.tlsRejectUnauthorized ?? env.AD_TLS_REJECT_UNAUTHORIZED,
      },
      tlsFallbacks,
    );
  }

  // ---- GET /api/directories/public -------------------------------------
  app.get('/api/directories/public', { config: { policy: { public: true } } }, async () => {
    const directories = await app.services.directoryConfig.listPublic();
    return { directories };
  });

  // ---- GET /api/directories --------------------------------------------
  app.get('/api/directories', {
    config: { policy: { capability: 'configure:directory', stepUp: false, directory: 'none' } },
    handler: async () => {
      const rows = await app.services.directoryConfig.listAll();
      return { directories: rows };
    },
  });

  // ---- GET /api/directories/:id/policy ---------------------------------
  // Surface the AD-side password / lockout policy. Available to anyone who
  // can read users — the same screens that show lockout state need this to
  // make sense of the timestamps. The provider caches results for 5min.
  app.get('/api/directories/:id/policy', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'param' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const provider = await app.services.providers.buildForRequest(req);
      const policy = await provider.getDomainPolicy();
      const minutes = (ms: number | null): number | null =>
        ms === null ? null : Math.round(ms / 60_000);
      const days = (ms: number | null): number | null =>
        ms === null ? null : Math.round(ms / 86_400_000);
      return {
        policy: {
          lockoutDurationMinutes: minutes(policy.lockoutDurationMs),
          lockoutThreshold: policy.lockoutThreshold,
          lockoutObservationMinutes: minutes(policy.lockoutObservationMs),
          maxPwdAgeDays: days(policy.maxPwdAgeMs),
          minPwdLength: policy.minPwdLength,
          pwdHistoryLength: policy.pwdHistoryLength,
          fetchedAt: new Date().toISOString(),
        },
      };
    },
  });

  // ---- POST /api/directories -------------------------------------------
  app.post('/api/directories', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
      policy: { capability: 'configure:directory', stepUp: true, directory: 'none' },
    },
    handler: async (req) => {
      const body = directoryCreateSchema.parse(req.body);
      const transportProblem = ldapTransportProblem(body.ldapUrls, body.tlsMode);
      if (transportProblem) throw BadRequest(transportProblem);
      // Same UPN normalization as setup — accept any AD-friendly form, send
      // `user@<domain>` to the bind.
      const bindUsername = composeBindUpn(body.adminUsername, body.domain);
      const provider = buildEphemeralProvider(
        {
          name: body.name,
          type: 'active-directory',
          domain: body.domain,
          baseDn: body.baseDn,
          ldapUrls: body.ldapUrls,
          tlsMode: body.tlsMode,
          bindUpn: bindUsername,
          bindPassword: body.adminPassword,
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          ...(body.tlsRejectUnauthorized !== undefined
            ? { tlsRejectUnauthorized: body.tlsRejectUnauthorized }
            : {}),
          ...(body.operationTimeoutMs !== undefined
            ? { operationTimeoutMs: body.operationTimeoutMs }
            : {}),
        },
        tlsFallbacks,
      );
      const auth = await provider.authenticateUser({
        username: bindUsername,
        password: body.adminPassword,
      });
      if (!auth.ok || !auth.user) {
        if (auth.reason === 'directory_error') {
          throw app.httpErrors.badGateway(auth.errorMessage ?? 'directory unreachable');
        }
        throw Unauthorized(
          auth.errorMessage ?? 'could not bind as that admin against the supplied directory',
        );
      }

      const created = await app.services.directoryConfig.create({
        name: body.name,
        type: 'active-directory',
        domain: body.domain,
        baseDn: body.baseDn,
        ldapUrls: body.ldapUrls,
        tlsMode: body.tlsMode,
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.tlsRejectUnauthorized !== undefined
          ? { tlsRejectUnauthorized: body.tlsRejectUnauthorized }
          : {}),
        ...(body.operationTimeoutMs !== undefined
          ? { operationTimeoutMs: body.operationTimeoutMs }
          : {}),
      });

      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.create',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: created.id,
          targetType: 'config',
          targetId: String(created.id),
          metadata: {
            domain: created.domain,
            baseDn: created.baseDn,
            ldapUrls: created.ldapUrls,
            tlsMode: created.tlsMode,
          },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for directory.create'));

      return { directory: created };
    },
  });

  // ---- PATCH /api/directories/:id --------------------------------------
  app.patch('/api/directories/:id', {
    config: { policy: { capability: 'configure:directory', stepUp: true, directory: 'none' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = directoryPatchSchema.parse(req.body);
      const before = await app.services.directoryConfig.getById(id);
      if (!before) throw NotFound('directory not found');

      if (body.ldapUrls !== undefined || body.tlsMode !== undefined) {
        const transportProblem = ldapTransportProblem(
          body.ldapUrls ?? before.ldapUrls,
          body.tlsMode ?? before.tlsMode,
        );
        if (transportProblem) throw BadRequest(transportProblem);
      }

      // Syncs send the stored service-account password to whatever these
      // settings point at, as whoever they name, and every sign-in sends an
      // operator's. Changing them needs that password typed in and a
      // working bind first.
      const effectiveTlsCheck = (v: boolean | null) => v ?? env.AD_TLS_REJECT_UNAUTHORIZED;
      const connectionOf = (d: {
        ldapUrls: readonly string[];
        tlsMode: LdapTlsMode;
        tlsRejectUnauthorized: boolean | null;
        syncBindUpn: string | null;
      }) => ({ ...d, tlsRejectUnauthorized: effectiveTlsCheck(d.tlsRejectUnauthorized) });
      const rebindReason = rebindRequiredReason(
        connectionOf(before),
        connectionOf({
          ldapUrls: body.ldapUrls ?? before.ldapUrls,
          tlsMode: body.tlsMode ?? before.tlsMode,
          tlsRejectUnauthorized:
            body.tlsRejectUnauthorized === undefined
              ? before.tlsRejectUnauthorized
              : body.tlsRejectUnauthorized,
          syncBindUpn: body.syncBindUpn === undefined ? before.syncBindUpn : body.syncBindUpn,
        }),
      );
      if (rebindReason) {
        if (!body.syncBindPassword) throw BadRequest(rebindReason);
        const syncBindUpn = body.syncBindUpn ?? before.syncBindUpn;
        if (!syncBindUpn) {
          throw BadRequest('Set a service account before changing how this domain is reached.');
        }
        const probe = await serviceAccountProvider(
          {
            ...before,
            ldapUrls: body.ldapUrls ?? before.ldapUrls,
            tlsMode: body.tlsMode ?? before.tlsMode,
            tlsRejectUnauthorized: body.tlsRejectUnauthorized ?? before.tlsRejectUnauthorized,
          },
          syncBindUpn,
          body.syncBindPassword,
        ).authenticateUser({ username: syncBindUpn, password: body.syncBindPassword });
        if (!probe.ok) {
          throw BadRequest(
            `Not saved: the service account couldn't sign in with the new settings (${probe.errorMessage ?? 'bind failed'}).`,
          );
        }
      }

      const updated = await app.services.directoryConfig.update(id, compactPatch(body));

      // Don't echo password material in metadata; record only that it changed.
      const changedFields = Object.keys(body).filter((k) => k !== 'syncBindPassword');
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.update',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          metadata: {
            changedFields,
            syncSecretRotated: body.syncBindPassword !== undefined,
            ...(rebindReason ? { connectionVerified: true } : {}),
          },
          before: {
            ldapUrls: before.ldapUrls,
            tlsMode: before.tlsMode,
            displayName: before.displayName,
            syncBindUpn: before.syncBindUpn,
          },
          after: {
            ldapUrls: updated.ldapUrls,
            tlsMode: updated.tlsMode,
            displayName: updated.displayName,
            syncBindUpn: updated.syncBindUpn,
          },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for directory.update'));

      return { directory: updated };
    },
  });

  // ---- POST /api/directories/:id/test-sync-bind ------------------------
  // Probe the directory with whatever sync service-account creds the
  // operator has in front of them — typed in the edit dialog before save,
  // or the stored ones for a quick "still works?" check. Returns a
  // pass/fail message so the operator finds out about a typo at the
  // moment of typing instead of after waiting for the next scheduled run.
  app.post('/api/directories/:id/test-sync-bind', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
      policy: { capability: 'configure:directory', stepUp: true, directory: 'none' },
    },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const bodySchema = z.object({
        syncBindUpn: z.string().trim().min(1).max(255),
        // Optional — when omitted, fall back to the stored password.
        // Useful for "did rotation work?" probes without re-typing.
        syncBindPassword: z.string().min(1).max(1024).optional(),
      });
      const body = bodySchema.parse(req.body);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');

      let password = body.syncBindPassword;
      if (!password) {
        const stored = await app.services.directoryConfig.getSyncBindCreds(id);
        if (!stored) {
          throw app.httpErrors.badRequest('no stored sync password — supply one or rotate first');
        }
        // The stored password only ever goes out as the stored account.
        if (body.syncBindUpn.toLowerCase() !== (directory.syncBindUpn ?? '').toLowerCase()) {
          throw BadRequest('to test a different account, enter its password');
        }
        password = stored.password;
      }

      const provider = serviceAccountProvider(directory, body.syncBindUpn, password);
      // Reuse the rich auth-classifier (returns specific reasons for
      // wrong-password / user-not-found / TLS / unreachable). For a SA
      // probe we don't need the full record — a successful bind is the
      // only thing being tested.
      const auth = await provider.authenticateUser({
        username: body.syncBindUpn,
        password,
      });
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.test_sync_bind',
          result: auth.ok ? 'success' : 'failure',
          actorAuthMethod: 'ad-password',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          ...(auth.ok ? {} : { errorCode: auth.reason ?? 'unknown' }),
        })
        .catch(() => undefined);
      return {
        ok: auth.ok,
        message: auth.ok
          ? `bound successfully as ${body.syncBindUpn}`
          : (auth.errorMessage ?? 'bind failed'),
        reason: auth.ok ? null : (auth.reason ?? null),
      };
    },
  });

  // ---- GET /api/directories/:id/sync-tasks -----------------------------
  // List per-task scheduler state. Calls `ensureSeeded` inline so a
  // freshly-created directory (or one that's never been ticked yet) shows
  // every registered task immediately, instead of leaving the operator
  // staring at an "awaiting first tick" empty state.
  app.get('/api/directories/:id/sync-tasks', {
    config: { policy: { capability: 'configure:directory', stepUp: false, directory: 'none' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const integration = await app.services.entraIntegration.getByProviderId(id);
      const hasEntra = !!integration && integration.enabled && integration.hasClientSecret;
      await app.services.syncTasks.ensureSeeded(id, { hasEntra });
      const tasks = await app.services.syncTasks.listForDirectory(id);
      return { tasks };
    },
  });

  // ---- PATCH /api/directories/:id/sync-tasks/:key ----------------------
  // Update cadence / anchor / enabled for a single task.
  app.patch('/api/directories/:id/sync-tasks/:key', {
    config: { policy: { capability: 'configure:directory', stepUp: true, directory: 'none' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const { key } = z.object({ key: z.string().min(1) }).parse(req.params);
      if (!isKnownTaskKey(key)) throw NotFound('unknown task');
      const body = z
        .object({
          enabled: z.boolean().optional(),
          scheduleKind: z.enum(SCHEDULE_KINDS as readonly [string, ...string[]]).optional(),
          intervalMinutes: z
            .union([z.coerce.number().int().min(1).max(43200), z.null()])
            .optional(),
          anchorAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional(),
          monthlyDay: z
            .union([
              z.string().refine(isMonthlyDay, "monthlyDay must be '1'..'28' or 'last'"),
              z.null(),
            ])
            .optional(),
          cronExpr: z.union([z.string().trim().min(1).max(255), z.null()]).optional(),
        })
        .parse(req.body);

      // Validate the cron expression upstream of the DB write so the
      // operator gets a clean 400 with the parse error instead of a
      // CHECK-constraint failure or — worse — a schedule that silently
      // never fires.
      if (body.cronExpr) {
        const v = validateCron(body.cronExpr);
        if (!v.ok) {
          throw app.httpErrors.badRequest(`invalid cron expression: ${v.error}`);
        }
      }

      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');

      const patch: {
        enabled?: boolean;
        scheduleKind?: ScheduleKind;
        intervalMinutes?: number | null;
        anchorAt?: Date | null;
        monthlyDay?: MonthlyDay | null;
        cronExpr?: string | null;
      } = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.scheduleKind !== undefined) patch.scheduleKind = body.scheduleKind as ScheduleKind;
      if (body.intervalMinutes !== undefined) patch.intervalMinutes = body.intervalMinutes;
      if (body.anchorAt !== undefined) {
        patch.anchorAt = body.anchorAt === null ? null : new Date(body.anchorAt);
      }
      if (body.monthlyDay !== undefined) patch.monthlyDay = body.monthlyDay;
      if (body.cronExpr !== undefined) patch.cronExpr = body.cronExpr;

      const updated = await app.services.syncTasks.update(id, key as SyncTaskKey, patch);
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.sync_task.update',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          metadata: { taskKey: key, ...body },
        })
        .catch(() => undefined);
      return { task: updated };
    },
  });

  // ---- POST /api/directories/:id/sync-tasks/:key/run -------------------
  app.post('/api/directories/:id/sync-tasks/:key/run', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
      policy: { capability: 'configure:directory', stepUp: false, directory: 'none' },
    },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const { key } = z.object({ key: z.string().min(1) }).parse(req.params);
      if (!isKnownTaskKey(key)) throw NotFound('unknown task');
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      if (!directory.syncBindUpn || !directory.hasSyncBindPassword) {
        throw app.httpErrors.badRequest(
          'sync service account is not configured for this directory',
        );
      }
      const result = app.services.sync.triggerNow(id, key as SyncTaskKey);
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.sync_task.trigger',
          result: result.queued ? 'success' : 'denied',
          actorAuthMethod: 'ad-password',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          metadata: { taskKey: key },
          ...(result.reason ? { errorCode: result.reason } : {}),
        })
        .catch(() => undefined);
      return result;
    },
  });

  // ---- GET /api/directories/:id/sync-tasks/:key/history ----------------
  // Recent runs of a single task. Powers the per-task history drawer in
  // the Tasks UI so the operator can see "ran 3× in the last 10 min, all
  // failed with X" rather than just the latest result.
  app.get('/api/directories/:id/sync-tasks/:key/history', {
    config: { policy: { capability: 'configure:directory', stepUp: false, directory: 'none' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const { key } = z.object({ key: z.string().min(1) }).parse(req.params);
      if (!isKnownTaskKey(key)) throw NotFound('unknown task');
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .parse((req.query as { limit?: string | number } | undefined)?.limit ?? 50);
      const runs = await app.services.syncTasks.listRecentRuns(id, key as SyncTaskKey, limit);
      return {
        runs: runs.map((r) => ({
          id: r.id,
          status: r.status,
          trigger: r.trigger,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
          durationMs: r.durationMs,
          error: r.error,
          stats: r.stats,
        })),
      };
    },
  });

  // ---- GET /api/directories/:id/sync-tasks/queue -----------------------
  // Snapshot of in-flight + queued tasks for a directory. Powers the
  // queue/pending indicator in the Tasks UI so the operator knows their
  // "Run now" click registered even when the runner finishes faster than
  // the UI's poll cadence.
  app.get('/api/directories/:id/sync-tasks/queue', {
    config: { policy: { capability: 'configure:directory', stepUp: false, directory: 'none' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const snap = app.services.sync.inspectQueue();
      return {
        inFlight: snap.inFlight.filter((x) => x.providerId === id).map((x) => x.taskKey),
        queued: snap.forced.filter((x) => x.providerId === id).map((x) => x.taskKey),
      };
    },
  });

  // ---- POST /api/directories/:id/sync-tasks/:key/reset -----------------
  // Operator escape hatch — flip a single stuck task out of `running`.
  app.post('/api/directories/:id/sync-tasks/:key/reset', {
    config: { policy: { capability: 'configure:directory', stepUp: false, directory: 'none' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const { key } = z.object({ key: z.string().min(1) }).parse(req.params);
      if (!isKnownTaskKey(key)) throw NotFound('unknown task');
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      await app.services.syncTasks.resetStuck(id, key as SyncTaskKey, 'reset by operator');
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.sync_task.reset',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          metadata: { taskKey: key },
        })
        .catch(() => undefined);
      return { ok: true };
    },
  });

  // ---- POST /api/directories/:id/sync/reset (legacy) -------------------
  // Pre-task-split clients called this to unstick "the sync". Map it to
  // resetting every stuck task for the directory. Removed in a future
  // release once the UI fully migrates.
  app.post('/api/directories/:id/sync/reset', {
    config: { policy: { capability: 'configure:directory', stepUp: false, directory: 'none' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      const tasks = await app.services.syncTasks.listForDirectory(id);
      for (const t of tasks) {
        if (t.lastStatus === 'running') {
          await app.services.syncTasks.resetStuck(id, t.taskKey, 'reset by operator');
        }
      }
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.sync.reset',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
        })
        .catch(() => undefined);
      return { ok: true };
    },
  });

  // ---- POST /api/directories/:id/sync (legacy alias) -------------------
  // Pre-task-split clients triggered "the sync"; map it to running the
  // users.full task. Removed in a future release once the UI cuts over.
  app.post('/api/directories/:id/sync', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
      policy: { capability: 'configure:directory', stepUp: false, directory: 'none' },
    },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const directory = await app.services.directoryConfig.getById(id);
      if (!directory) throw NotFound('directory not found');
      if (!directory.syncBindUpn || !directory.hasSyncBindPassword) {
        throw app.httpErrors.badRequest(
          'sync service account is not configured for this directory',
        );
      }
      const result = app.services.sync.triggerNow(id, 'users.full');
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.sync.trigger',
          result: result.queued ? 'success' : 'denied',
          actorAuthMethod: 'ad-password',
          providerId: id,
          targetType: 'config',
          targetId: String(id),
          ...(result.reason ? { errorCode: result.reason } : {}),
        })
        .catch(() => undefined);
      return { started: result.queued, reason: result.reason ?? undefined };
    },
  });
}
