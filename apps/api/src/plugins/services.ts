// SPDX-License-Identifier: BUSL-1.1
import fp from 'fastify-plugin';
import { loadEnv } from '../config/env.js';
import { AuditService } from '../services/audit.js';
import { AuthorizationService } from '../services/authorization.js';
import { BulkJobService } from '../services/bulkJobs/service.js';
import { ClassPassService } from '../services/classPasses/service.js';
import { CredentialCacheService } from '../services/credentialCache.js';
import { DirectoryConfigService } from '../services/directoryConfig.js';
import { EntraIntegrationService } from '../services/entraIntegration.js';
import { GraphClientFactory } from '../services/graphClient.js';
import { LoginBackoffService } from '../services/loginBackoff.js';
import { PhotoCacheService } from '../services/photoCache.js';
import { SessionsService } from '../services/sessions.js';
import { SettingsService } from '../services/settings.js';
import { SignInEventsService } from '../services/signInEvents.js';
import { SyncTaskScheduler } from '../services/syncTasks/scheduler.js';
import { SyncTaskService } from '../services/syncTasks/service.js';
import { LoggingNotificationDispatcher } from '../services/syncTasks/notifications.js';
import { TeamsNotifierService } from '../services/teamsNotifier.js';
import { ComputerLiveRefreshService } from '../services/computerLiveRefresh.js';
import { UserLiveRefreshService } from '../services/userLiveRefresh.js';
import { ProviderFactory } from '../providers/registry.js';

declare module 'fastify' {
  interface FastifyInstance {
    services: {
      audit: AuditService;
      authorization: AuthorizationService;
      bulkJobs: BulkJobService;
      classPasses: ClassPassService;
      credentialCache: CredentialCacheService;
      directoryConfig: DirectoryConfigService;
      entraIntegration: EntraIntegrationService;
      graphClient: GraphClientFactory;
      loginBackoff: LoginBackoffService;
      photos: PhotoCacheService;
      sessions: SessionsService;
      settings: SettingsService;
      signInEvents: SignInEventsService;
      providers: ProviderFactory;
      sync: SyncTaskScheduler;
      syncTasks: SyncTaskService;
      teams: TeamsNotifierService;
      userLiveRefresh: UserLiveRefreshService;
      computerLiveRefresh: ComputerLiveRefreshService;
    };
  }
}

export default fp(async (app) => {
  const env = loadEnv();
  const settings = new SettingsService(app.db);
  const audit = new AuditService(app.db);
  const sessions = new SessionsService(app.db, settings);
  const authorization = new AuthorizationService(env, settings);
  const credentialCache = new CredentialCacheService();
  const loginBackoff = new LoginBackoffService();
  const directoryConfig = new DirectoryConfigService(app.db, env);
  const providers = new ProviderFactory(directoryConfig, env);
  const userLiveRefresh = new UserLiveRefreshService(app.db);
  const computerLiveRefresh = new ComputerLiveRefreshService(app.db);
  const syncTasks = new SyncTaskService(app.db);
  const notifier = new LoggingNotificationDispatcher(app.log);

  // Entra-side services. Independent of any single directory — each call
  // provides the providerId; the GraphClientFactory handles per-directory
  // token caching.
  const entraIntegration = new EntraIntegrationService(app.db);
  const graphClient = new GraphClientFactory(entraIntegration, app.log);
  const photos = new PhotoCacheService(app.db, app.log);
  const teams = new TeamsNotifierService(entraIntegration, app.log);
  const signInEvents = new SignInEventsService(app.db, app.log);

  const bulkJobs = new BulkJobService(
    app.db,
    { audit, sessions, credentialCache, providers, userLiveRefresh },
    app.log,
  );

  const classPasses = new ClassPassService({
    db: app.db,
    audit,
    entra: entraIntegration,
    graph: graphClient,
    providers,
    roleGroups: () => authorization.roleGroups(),
    logger: app.log,
  });

  const sync = new SyncTaskScheduler(
    app.db,
    app.pgLockPool,
    directoryConfig,
    providers,
    notifier,
    app.log,
    {
      integration: entraIntegration,
      graph: graphClient,
      photos,
      teams,
    },
  );

  app.decorate('services', {
    audit,
    authorization,
    bulkJobs,
    classPasses,
    credentialCache,
    directoryConfig,
    entraIntegration,
    graphClient,
    loginBackoff,
    photos,
    sessions,
    settings,
    signInEvents,
    providers,
    sync,
    syncTasks,
    teams,
    userLiveRefresh,
    computerLiveRefresh,
  });

  // Start the sync scheduler once the API is ready (after listen). Doing
  // this in `onReady` rather than at decorate-time keeps tests that build
  // and tear down the app instance from leaking timers.
  app.addHook('onReady', async () => {
    if (env.SYNC_SCHEDULER_ENABLED) sync.start();
    bulkJobs.start();
    classPasses.start();
  });

  app.addHook('onClose', async () => {
    // Before the credential cache is wiped, so rows in flight can finish.
    await bulkJobs.stop();
    await classPasses.stop();
    sync.stop();
    credentialCache.stop();
    loginBackoff.stop();
    audit.stopViewDedupeSweep();
  });
});
