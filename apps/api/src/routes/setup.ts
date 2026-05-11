// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { meResponseSchema, type Capability } from '@openaduc/shared';
import { BadRequest, Unauthorized } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { buildEphemeralProvider } from '../services/directoryConfig.js';
import { loadEnv } from '../config/env.js';
import { SESSION_COOKIE_NAME } from '../plugins/auth.js';
import { composeBindUpn } from '../lib/usernameParser.js';
import type { SyncTaskKey } from '../services/syncTasks/types.js';
import { TASK_REGISTRY } from '../services/syncTasks/registry.js';

// Setup is a multi-step, first-run wizard. Step 1 (POST /api/setup/initialize)
// is intentionally PUBLIC — until at least one directory is configured the
// instance has nothing to authenticate against. Subsequent steps run while
// the operator is signed in (the auto-elevated session from step 1 carries
// them through the rest of the wizard) and are gated on
// `onboarding.completed_at IS NULL` so they can't be replayed afterwards.
//
// After onboarding completes, additional domains, service-account rotations
// and policy changes go through their normal authenticated routes.

const ONBOARDING_KEY = 'onboarding.completed_at';

// Tasks the wizard runs once, in priority order, to establish a baseline
// before turning the periodic scheduler back on. Delta runners need a
// successful full to compute `whenChanged>=`, and `users.locked` only makes
// sense after the user cache exists. Entra-side tasks are skipped because
// the integration isn't configured during first-run.
const ONBOARDING_TASK_SEQUENCE: SyncTaskKey[] = [
  'domain.policy',
  'ous.full',
  'users.full',
  'groups.full',
  'computers.full',
  'memberships.rebuild',
];

const directoryInputSchema = z.object({
  name: z.string().trim().min(1).max(64).default('default'),
  displayName: z.string().trim().max(128).optional(),
  domain: z.string().trim().min(1).max(255),
  baseDn: z.string().trim().min(1).max(512),
  ldapUrls: z.array(z.string().trim().min(1)).min(1).max(10),
  tlsMode: z.enum(['ldaps', 'starttls', 'plain']).default('ldaps'),
  adminUsername: z.string().trim().min(1).max(256),
  adminPassword: z.string().min(1).max(1024),
  tlsRejectUnauthorized: z.boolean().optional(),
  operationTimeoutMs: z.coerce.number().int().min(1000).max(120000).optional(),
});

type SetupBody = z.infer<typeof directoryInputSchema>;

const serviceAccountSchema = z.object({
  username: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1024),
});

const policySchema = z.object({
  passwordExpiringDays: z.number().int().min(1).max(365),
  staleLogonDays: z.number().int().min(1).max(3650),
});

interface InitialSyncTaskState {
  key: SyncTaskKey;
  label: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  stats: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface InitialSyncJob {
  directoryId: number;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  currentIdx: number;
  tasks: InitialSyncTaskState[];
  error: string | null;
}

// First-run wizard runs against a single directory. Keying by directoryId
// keeps the state module-local and trivially fetchable by the polling
// endpoint without a job-id round trip.
const initialSyncJobs = new Map<number, InitialSyncJob>();

function domainRootFromBaseDn(dn: string): string {
  return dn
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^dc=/i.test(part))
    .join(',');
}

function cookieOptions() {
  const env = loadEnv();
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
  };
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const tlsFallbacks = {
    tlsRejectUnauthorized: env.AD_TLS_REJECT_UNAUTHORIZED,
    operationTimeoutMs: env.AD_OPERATION_TIMEOUT_MS,
    tlsCaPath: env.AD_TLS_CA_PATH,
  };

  async function readOnboardingCompletedAt(): Promise<string | null> {
    return app.services.settings.get<string | null>(ONBOARDING_KEY, null);
  }

  async function ensureOnboardingActive(): Promise<void> {
    const completedAt = await readOnboardingCompletedAt();
    if (completedAt) {
      throw BadRequest('onboarding already complete');
    }
  }

  async function firstConfiguredDirectoryId(): Promise<number | null> {
    const directories = await app.services.directoryConfig.listAll();
    const configured = directories.find((d) => d.configured);
    return configured ? configured.id : null;
  }

  // ---- GET /api/setup/status ------------------------------------------
  // Surfaces every piece of state the wizard needs to resume on reload:
  // which step is done, what the operator already typed (no secrets), and
  // whether the whole flow has finished. The router consults this to
  // decide whether to keep forcing the operator into /setup.
  app.get('/api/setup/status', async () => {
    const directories = await app.services.directoryConfig.listAll();
    const firstConfigured = directories.find((d) => d.configured) ?? null;
    const onboardingCompletedAt = await readOnboardingCompletedAt();
    return {
      configured: !!firstConfigured,
      hasServiceAccount: firstConfigured
        ? !!firstConfigured.syncBindUpn && firstConfigured.hasSyncBindPassword
        : false,
      onboardingCompletedAt,
      existingDirectory: firstConfigured
        ? {
            id: firstConfigured.id,
            name: firstConfigured.name,
            domain: firstConfigured.domain,
            baseDn: firstConfigured.baseDn,
            ldapUrls: firstConfigured.ldapUrls,
            tlsMode: firstConfigured.tlsMode,
            tlsRejectUnauthorized: firstConfigured.tlsRejectUnauthorized,
            syncBindUpn: firstConfigured.syncBindUpn,
          }
        : null,
    };
  });

  // ---- POST /api/setup/initialize -------------------------------------
  // Step 1: test the directory connection by binding as the supplied
  // admin, persist the directory configuration on success, open a session
  // for that admin. The bind is the proof of admin authority — no separate
  // ACL or group check today; we trust whatever the directory's bind does.
  app.post('/api/setup/initialize', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      // Hard-stop if anyone has already configured a directory. Adding
      // additional domains uses POST /api/directories, which is auth-gated.
      if (await app.services.directoryConfig.anyConfigured()) {
        throw BadRequest(
          'setup is already complete; add additional domains via Settings → Directories',
        );
      }
      const body: SetupBody = directoryInputSchema.parse(req.body);
      const bindUsername = composeBindUpn(body.adminUsername, body.domain);
      const provider = buildEphemeralProvider(
        {
          ...toProviderInput(body),
          bindUpn: bindUsername,
          bindPassword: body.adminPassword,
        },
        tlsFallbacks,
      );
      const auth = await provider.authenticateUser({
        username: bindUsername,
        password: body.adminPassword,
      });

      const baseAudit = {
        ...auditContextFromRequest(req),
        action: 'setup.initialize',
        actorAuthMethod: 'ad-password' as const,
        targetType: 'config' as const,
      };

      if (!auth.ok || !auth.user) {
        await app.services.audit
          .recordEvent({
            ...baseAudit,
            result: 'failure',
            errorCode: auth.reason ?? 'unknown',
            metadata: {
              domain: body.domain,
              baseDn: body.baseDn,
              ldapUrls: body.ldapUrls,
              adminUsername: body.adminUsername,
              detail: auth.errorMessage,
            },
          })
          .catch(() => undefined);
        const detail =
          auth.errorMessage ?? 'could not bind as that admin against the supplied directory';
        if (auth.reason === 'directory_error') {
          throw app.httpErrors.badGateway(detail);
        }
        throw Unauthorized(detail);
      }

      const created = await app.services.directoryConfig.create(toProviderInput(body));

      const groupDns = auth.groupDns ?? auth.user.memberOfDns;
      let capabilities = await app.services.authorization.resolveCapabilities(groupDns);
      if (capabilities.length === 0) {
        const desiredAdminGroupDn = `CN=Domain Admins,CN=Users,${domainRootFromBaseDn(body.baseDn)}`;
        await app.db
          .updateTable('app_settings')
          .set({ value_json: JSON.stringify(desiredAdminGroupDn) })
          .where('key', '=', 'authz.admin_group_dn')
          .execute();
        app.services.settings.invalidate('authz.admin_group_dn');
        capabilities = await app.services.authorization.resolveCapabilities(groupDns);
      }
      if (capabilities.length === 0) {
        const { ROLE_CAPABILITIES } = await import('@openaduc/shared');
        capabilities = [...ROLE_CAPABILITIES.admin];
      }

      const { session, cookieToken } = await app.services.sessions.createAdminSession({
        directoryId: created.id,
        actorUserId: auth.user.objectGuid,
        actorDisplayName: auth.user.displayName,
        actorUsername: bindUsername,
        actorEmail: auth.user.email,
        actorDn: auth.user.distinguishedName,
        capabilities,
        sourceIp: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });

      const writeCaps: Capability[] = [
        'write:user.unlock',
        'write:user.resetPassword',
        'write:user.enableDisable',
        'write:user.attributes',
        'write:group.membership',
        'configure:directory',
        'configure:security',
      ];
      const elevatedCaps = writeCaps.filter((c) => (capabilities as Capability[]).includes(c));
      const elevated = await app.services.sessions.createElevatedSession({
        adminSessionId: session.id,
        actorUserId: auth.user.objectGuid,
        capabilities: elevatedCaps,
      });
      app.services.credentialCache.set(elevated.id, body.adminPassword, elevated.expiresAt);

      await app.services.audit
        .recordEvent({
          ...baseAudit,
          result: 'success',
          providerId: created.id,
          actorUserId: auth.user.objectGuid,
          actorDisplayName: auth.user.displayName,
          sessionId: session.id,
          targetId: String(created.id),
          metadata: {
            domain: created.domain,
            baseDn: created.baseDn,
            ldapUrls: created.ldapUrls,
            tlsMode: created.tlsMode,
          },
        })
        .catch(() => undefined);

      reply.setCookie(SESSION_COOKIE_NAME, cookieToken, {
        ...cookieOptions(),
        expires: session.expiresAt,
      });

      return {
        ok: true,
        directory: created,
        actor: meResponseSchema.parse({
          actorId: auth.user.objectGuid,
          displayName: auth.user.displayName ?? bindUsername,
          username: bindUsername,
          email: auth.user.email,
          capabilities,
          directoryId: created.id,
          directoryDomain: created.domain,
          elevated: { active: true, expiresAt: elevated.expiresAt.toISOString() },
        }),
      };
    },
  });

  // ---- POST /api/setup/service-account --------------------------------
  // Step 2: test the supplied service-account credentials against the
  // already-configured directory and, on success, encrypt + store them.
  // The same-account warning is computed and returned (non-blocking) —
  // the wizard surfaces it inline so the operator can choose.
  app.post('/api/setup/service-account', {
    preHandler: app.requireAuth,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (req) => {
      await ensureOnboardingActive();
      const body = serviceAccountSchema.parse(req.body);
      const directoryId = await firstConfiguredDirectoryId();
      if (!directoryId) {
        throw BadRequest('domain controller not configured yet');
      }
      const directory = await app.services.directoryConfig.getById(directoryId);
      if (!directory) throw BadRequest('domain controller not configured yet');

      const bindUpn = composeBindUpn(body.username, directory.domain);
      const provider = buildEphemeralProvider(
        {
          name: directory.name,
          type: 'active-directory',
          domain: directory.domain,
          baseDn: directory.baseDn,
          ldapUrls: directory.ldapUrls,
          tlsMode: directory.tlsMode as 'ldaps' | 'starttls' | 'plain',
          ...(directory.tlsRejectUnauthorized !== null
            ? { tlsRejectUnauthorized: directory.tlsRejectUnauthorized }
            : {}),
          bindUpn,
          bindPassword: body.password,
        },
        tlsFallbacks,
      );

      const auth = await provider.authenticateUser({
        username: bindUpn,
        password: body.password,
      });

      const baseAudit = {
        ...auditContextFromRequest(req),
        action: 'setup.service_account',
        actorAuthMethod: 'ad-password' as const,
        providerId: directoryId,
        targetType: 'config' as const,
        targetId: String(directoryId),
      };

      if (!auth.ok) {
        await app.services.audit
          .recordEvent({
            ...baseAudit,
            result: 'failure',
            errorCode: auth.reason ?? 'unknown',
            metadata: { username: bindUpn, detail: auth.errorMessage },
          })
          .catch(() => undefined);
        const detail = auth.errorMessage ?? 'service-account bind failed';
        if (auth.reason === 'directory_error') {
          throw app.httpErrors.badGateway(detail);
        }
        throw Unauthorized(detail);
      }

      await app.services.directoryConfig.update(directoryId, {
        syncBindUpn: bindUpn,
        syncBindPassword: body.password,
      });

      await app.services.audit
        .recordEvent({
          ...baseAudit,
          result: 'success',
          actorUserId: req.actor!.session.actorUserId,
          actorDisplayName: req.actor!.session.actorDisplayName,
          metadata: { username: bindUpn },
        })
        .catch(() => undefined);

      const adminUpn = req.actor!.session.actorUsername ?? null;
      const sameAsAdmin = !!adminUpn && adminUpn.toLowerCase() === bindUpn.toLowerCase();

      return {
        ok: true,
        username: bindUpn,
        sameAsAdmin,
      };
    },
  });

  // ---- POST /api/setup/policy -----------------------------------------
  // Step 3: write the three password-policy keys to app_settings. We
  // deliberately bypass the usual `configure:security` step-up gate
  // because the operator is mid-onboarding from a freshly-elevated
  // session — making them step up again to set defaults would be
  // theatre.
  app.post('/api/setup/policy', {
    preHandler: app.requireAuth,
    handler: async (req) => {
      await ensureOnboardingActive();
      const body = policySchema.parse(req.body);

      const updates: { key: string; value: unknown }[] = [
        {
          key: 'view.password_expiring_days',
          value: body.passwordExpiringDays,
        },
        {
          key: 'view.stale_logon_days',
          value: body.staleLogonDays,
        },
      ];

      const before = await app.db
        .selectFrom('app_settings')
        .select(['key', 'value_json'])
        .where(
          'key',
          'in',
          updates.map((u) => u.key),
        )
        .execute();
      const beforeMap = new Map(before.map((r) => [r.key, r.value_json]));

      const actorId = req.actor!.session.actorUserId;
      await app.db.transaction().execute(async (trx) => {
        for (const u of updates) {
          await trx
            .updateTable('app_settings')
            .set({
              value_json: JSON.stringify(u.value),
              updated_by_actor_id: actorId,
              updated_at: new Date(),
            })
            .where('key', '=', u.key)
            .execute();
        }
      });
      app.services.settings.invalidate();

      for (const u of updates) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: 'settings.update',
            result: 'success',
            actorAuthMethod: 'ad-password',
            targetType: 'config',
            targetId: u.key,
            metadata: { key: u.key, source: 'setup-wizard' },
            before: { value: beforeMap.get(u.key) ?? null },
            after: { value: u.value },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for setup.policy'));
      }

      return { ok: true };
    },
  });

  // ---- POST /api/setup/run-initial-sync -------------------------------
  // Step 4: kick off a sequential, one-off run of the AD-side full syncs
  // so the operator has a complete dataset before the periodic scheduler
  // takes over. Returns immediately with the initial job state; progress
  // is polled via GET /api/setup/initial-sync-status.
  //
  // We pause the periodic scheduler for the duration so its 60s tick can't
  // race the wizard for the per-directory slot. On the way out we re-arm
  // it — even on failure — so a partial onboarding doesn't leave sync
  // permanently disabled.
  app.post('/api/setup/run-initial-sync', {
    preHandler: app.requireAuth,
    handler: async (req) => {
      await ensureOnboardingActive();
      const directoryId = await firstConfiguredDirectoryId();
      if (!directoryId) {
        throw BadRequest('domain controller not configured yet');
      }
      const directory = await app.services.directoryConfig.getById(directoryId);
      if (!directory) throw BadRequest('domain controller not configured yet');
      if (!directory.syncBindUpn || !directory.hasSyncBindPassword) {
        throw BadRequest('service account not configured yet');
      }

      const existing = initialSyncJobs.get(directoryId);
      if (existing && existing.status === 'running') {
        return { job: existing };
      }

      const tasks: InitialSyncTaskState[] = ONBOARDING_TASK_SEQUENCE.map((key) => ({
        key,
        label: TASK_REGISTRY[key].label,
        status: 'pending',
        error: null,
        stats: null,
        startedAt: null,
        finishedAt: null,
      }));

      const job: InitialSyncJob = {
        directoryId,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        currentIdx: 0,
        tasks,
        error: null,
      };
      initialSyncJobs.set(directoryId, job);

      // Fire-and-forget. The browser polls /initial-sync-status; we don't
      // tie up the HTTP request for the (potentially multi-minute) full
      // sync.
      void runInitialSyncSequence(app, job).catch((err) => {
        req.log.error({ err, directoryId }, 'initial sync sequence threw');
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = new Date().toISOString();
      });

      return { job };
    },
  });

  // ---- GET /api/setup/initial-sync-status ------------------------------
  // Polled by the wizard while step 4 runs. If no job is in flight the
  // response is `{ job: null }` — the wizard treats that as "needs to
  // start" and will POST run-initial-sync.
  app.get('/api/setup/initial-sync-status', {
    preHandler: app.requireAuth,
    handler: async () => {
      const directoryId = await firstConfiguredDirectoryId();
      if (!directoryId) return { job: null };
      const job = initialSyncJobs.get(directoryId) ?? null;
      return { job };
    },
  });

  // ---- POST /api/setup/retry-task -------------------------------------
  // Step 4 stop-on-failure: when a task errors, the wizard surfaces it
  // and offers a retry button. We re-run JUST that task in place, leaving
  // earlier-succeeded tasks untouched, then resume the sequence from the
  // next pending task.
  app.post('/api/setup/retry-task', {
    preHandler: app.requireAuth,
    handler: async (req) => {
      await ensureOnboardingActive();
      const directoryId = await firstConfiguredDirectoryId();
      if (!directoryId) throw BadRequest('domain controller not configured yet');
      const job = initialSyncJobs.get(directoryId);
      if (!job) throw BadRequest('no initial sync in progress');
      if (job.status === 'running') return { job };

      // Find the failed task. Retrying resets its state and rewinds the
      // cursor so the sequence picks back up from there.
      const failedIdx = job.tasks.findIndex((t) => t.status === 'failed');
      if (failedIdx === -1) {
        // Nothing to retry — return current state unchanged.
        return { job };
      }
      job.tasks[failedIdx]!.status = 'pending';
      job.tasks[failedIdx]!.error = null;
      job.tasks[failedIdx]!.startedAt = null;
      job.tasks[failedIdx]!.finishedAt = null;
      job.currentIdx = failedIdx;
      job.status = 'running';
      job.error = null;
      job.finishedAt = null;

      void runInitialSyncSequence(app, job).catch((err) => {
        req.log.error({ err, directoryId }, 'initial sync retry threw');
        job.status = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = new Date().toISOString();
      });

      return { job };
    },
  });
}

/**
 * Run the onboarding task sequence for a single directory. Drives the
 * `job` state in place so polled status reflects per-task progress.
 *
 * We pause the periodic scheduler for the entire sequence — without that,
 * the 60s tick could grab the per-directory slot between two of our
 * awaits and start a parallel/duplicate run. On the way out we always
 * resume it so a partial onboarding doesn't leave sync wedged off.
 */
async function runInitialSyncSequence(app: FastifyInstance, job: InitialSyncJob): Promise<void> {
  const wasRunning = app.services.sync.isRunning();
  if (wasRunning) app.services.sync.stop();

  try {
    for (let i = job.currentIdx; i < job.tasks.length; i++) {
      const task = job.tasks[i]!;
      job.currentIdx = i;
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      try {
        const result = await app.services.sync.runOnce(job.directoryId, task.key);
        task.finishedAt = new Date().toISOString();
        if (result.ok) {
          task.status = 'succeeded';
          task.stats = result.stats ?? null;
        } else {
          task.status = 'failed';
          task.error = result.error ?? 'task failed';
          job.status = 'failed';
          job.error = task.error;
          job.finishedAt = new Date().toISOString();
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        task.status = 'failed';
        task.error = message;
        task.finishedAt = new Date().toISOString();
        job.status = 'failed';
        job.error = message;
        job.finishedAt = new Date().toISOString();
        return;
      }
    }
    job.status = 'succeeded';
    job.finishedAt = new Date().toISOString();
    job.currentIdx = job.tasks.length;

    // Mark onboarding complete. Any later route that gates on
    // `onboarding.completed_at IS NULL` (service-account, policy, retry)
    // will start rejecting after this — the operator's done.
    await app.db
      .updateTable('app_settings')
      .set({ value_json: JSON.stringify(job.finishedAt) })
      .where('key', '=', 'onboarding.completed_at')
      .execute();
    app.services.settings.invalidate('onboarding.completed_at');
  } finally {
    if (wasRunning) app.services.sync.start();
  }
}

function toProviderInput(
  body: SetupBody,
): import('../services/directoryConfig.js').DirectoryProviderInput {
  const out: import('../services/directoryConfig.js').DirectoryProviderInput = {
    name: body.name,
    type: 'active-directory',
    domain: body.domain,
    baseDn: body.baseDn,
    ldapUrls: body.ldapUrls,
    tlsMode: body.tlsMode,
  };
  if (body.displayName !== undefined) out.displayName = body.displayName;
  if (body.tlsRejectUnauthorized !== undefined)
    out.tlsRejectUnauthorized = body.tlsRejectUnauthorized;
  if (body.operationTimeoutMs !== undefined) out.operationTimeoutMs = body.operationTimeoutMs;
  return out;
}
