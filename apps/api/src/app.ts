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
import authPlugin, { ELEVATED_IDLE_HEADER } from './plugins/auth.js';
import csrfPlugin from './plugins/csrf.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerDeletedUserRoutes } from './routes/deletedUsers.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerDirectoryRoutes } from './routes/directories.js';
import { registerEntraIntegrationRoutes } from './routes/entraIntegrations.js';
import { registerRoleMappingRoutes, registerSettingsRoutes } from './routes/settings.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerComputerRoutes } from './routes/computers.js';
import { registerDeletedComputerRoutes } from './routes/deletedComputers.js';
import { registerOuRoutes } from './routes/ous.js';
import { registerPolicyRoutes } from './routes/policies.js';

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv();
  const app = Fastify({
    logger: buildLoggerOptions(env),
    // Trust only the configured proxy hops: anything further left in
    // X-Forwarded-For was written by the client and would let it pick its
    // own IP for rate limits, login backoff and the audit log.
    // `hop` counts from the socket peer (0) outwards.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
  });

  await app.register(sensible);
  // The API returns JSON, so its CSP allows nothing. The SPA's own policy
  // is set by nginx (docker/nginx.conf), which serves it.
  await app.register(helmet, {
    contentSecurityPolicy: {
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
    exposedHeaders: [ELEVATED_IDLE_HEADER],
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
  await registerRoleMappingRoutes(app);
  await registerGroupRoutes(app);
  await registerComputerRoutes(app);
  await registerDeletedComputerRoutes(app);
  await registerOuRoutes(app);
  await registerPolicyRoutes(app);

  return app;
}
