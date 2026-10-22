// SPDX-License-Identifier: BUSL-1.1
import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from the workspace root (../../../) when present, falling back to
// the api package directory, then to default cwd. Keeps dev convenient without
// requiring per-package .env files.
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, '../../../../.env'),
  path.resolve(here, '../../.env'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of candidates) {
  if (existsSync(p)) {
    dotenv.config({ path: p, quiet: true });
    break;
  }
}

const csv = (val: string) =>
  val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_CORS_ORIGIN: z.string().transform(csv).prefault('http://localhost:5173'),
  // Reverse proxies in front of the API whose X-Forwarded-For entries are
  // trusted, counted from the API outwards. 1 = the bundled nginx. Set 2 if
  // another proxy or load balancer sits in front of nginx, 0 if clients
  // reach the API directly. Too high lets clients choose their own IP.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  SESSION_COOKIE_SECRET: z.string().min(32),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(60),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).default(12),
  STEP_UP_TTL_MINUTES: z.coerce.number().int().min(1).default(60),

  DATABASE_URL: z.string().url().or(z.string().startsWith('postgres://')),
  DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),

  // AES-256 key for encrypting service-account credentials at rest. Must be
  // base64-encoded 32 bytes. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),

  // Active Directory env vars are now ALL optional. They serve as a bootstrap
  // path for ops who'd rather configure via env than the setup wizard. If a
  // configured directory_providers row exists in the DB, it wins over env.
  AD_LDAP_URLS: z
    .string()
    .transform(csv)
    .optional()
    .transform((v) => v ?? []),
  AD_DOMAIN: z.string().optional(),
  AD_BASE_DN: z.string().optional(),
  AD_SERVICE_ACCOUNT_UPN: z.string().optional(),
  AD_SERVICE_ACCOUNT_PASSWORD: z.string().optional(),
  AD_TLS_REJECT_UNAUTHORIZED: z
    .union([z.literal('0'), z.literal('1')])
    .default('1')
    .transform((v) => v === '1'),
  AD_TLS_CA_PATH: z.string().optional(),
  AD_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

  BOOTSTRAP_ADMIN_GROUP_DN: z.string().optional(),

  // Run scheduled directory sync tasks. Integration tests turn it off so
  // background syncs don't race the requests under test.
  SYNC_SCHEDULER_ENABLED: z
    .union([z.literal('0'), z.literal('1')])
    .default('1')
    .transform((v) => v === '1'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
