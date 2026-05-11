// SPDX-License-Identifier: BUSL-1.1
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { loadEnv } from './config/env.js';
import { buildLoggerOptions } from './lib/logger.js';
import correlationId from './plugins/correlationId.js';
import errorHandler from './plugins/errorHandler.js';
import dbPlugin from './plugins/db.js';
import services from './plugins/services.js';
import authPlugin from './plugins/auth.js';
import csrfPlugin from './plugins/csrf.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerDeletedUserRoutes } from './routes/deletedUsers.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerDirectoryRoutes } from './routes/directories.js';
import { registerEntraIntegrationRoutes } from './routes/entraIntegrations.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerComputerRoutes } from './routes/computers.js';
import { registerDeletedComputerRoutes } from './routes/deletedComputers.js';
import { registerOuRoutes } from './routes/ous.js';
import { registerPolicyRoutes } from './routes/policies.js';

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({
    logger: buildLoggerOptions(env),
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(sensible);
  // CSP starts out report-only so deployment-specific violations surface in
  // logs without breaking the SPA. Flip to enforce by setting
  // `reportOnly: false` here once the report stream is clean for one release.
  // Note: the SPA itself is served from nginx in production — the canonical
  // CSP for the app belongs there. This API CSP is a defense-in-depth layer
  // for any HTML the API itself returns (currently: error pages from the
  // helmet/sensible defaults).
  await app.register(helmet, {
    contentSecurityPolicy: {
      reportOnly: true,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        connectSrc: ["'self'", ...env.API_CORS_ORIGIN],
      },
    },
    hsts:
      env.NODE_ENV === 'production'
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : false,
  });
  await app.register(cors, {
    origin: env.API_CORS_ORIGIN,
    credentials: true,
  });
  await app.register(cookie, { secret: env.SESSION_COOKIE_SECRET });
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
  });

  await app.register(correlationId);
  await app.register(errorHandler);
  await app.register(dbPlugin);
  await app.register(services);
  await app.register(authPlugin);
  // CSRF must come AFTER auth so we know the session shape, but BEFORE any
  // route registrations. Routes inherit the preHandler hook via Fastify's
  // request lifecycle.
  await app.register(csrfPlugin);

  await registerHealthRoutes(app);
  await registerSetupRoutes(app);
  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerDeletedUserRoutes(app);
  await registerAuditRoutes(app);
  await registerDirectoryRoutes(app);
  await registerEntraIntegrationRoutes(app);
  await registerSettingsRoutes(app);
  await registerGroupRoutes(app);
  await registerComputerRoutes(app);
  await registerDeletedComputerRoutes(app);
  await registerOuRoutes(app);
  await registerPolicyRoutes(app);

  return app;
}
