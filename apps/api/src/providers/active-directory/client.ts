// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from 'node:fs';
import { Client, type ClientOptions, ResultCodeError } from 'ldapts';
import type { Env } from '../../config/env.js';

export interface ClientConfig {
  ldapUrls: readonly string[];
  tlsRejectUnauthorized: boolean;
  tlsCaPath?: string | undefined;
  operationTimeoutMs: number;
}

export function clientConfigFromEnv(env: Env): ClientConfig {
  const config: ClientConfig = {
    ldapUrls: env.AD_LDAP_URLS,
    tlsRejectUnauthorized: env.AD_TLS_REJECT_UNAUTHORIZED,
    operationTimeoutMs: env.AD_OPERATION_TIMEOUT_MS,
  };
  if (env.AD_TLS_CA_PATH) {
    config.tlsCaPath = env.AD_TLS_CA_PATH;
  }
  return config;
}

/**
 * Build a fresh ldapts Client. Connections are created per-operation rather
 * than pooled — we explicitly want short-lived binds so credentials never live
 * in long-running socket state. Failover walks the configured URLs in order.
 *
 * Pass `urlOverride` to pin a specific server (e.g. when retrying the same
 * server after a partial failure inside the same logical operation).
 */
export function createClient(config: ClientConfig, urlOverride?: string): Client {
  const url = urlOverride ?? config.ldapUrls[0];
  if (!url) throw new Error('no LDAP URLs configured');

  const opts: ClientOptions = {
    url,
    timeout: config.operationTimeoutMs,
    connectTimeout: config.operationTimeoutMs,
    tlsOptions: {
      rejectUnauthorized: config.tlsRejectUnauthorized,
    },
  };
  if (config.tlsCaPath && opts.tlsOptions) {
    opts.tlsOptions.ca = readFileSync(config.tlsCaPath);
  }
  return new Client(opts);
}

/**
 * True when `err` means the server never answered: connection refused,
 * timeout, TLS failure, dropped socket. Another domain controller may still
 * work. LDAP result errors (wrong password, insufficient access, …) are
 * answers, and another DC would give the same one.
 */
export function isDirectoryUnreachable(err: unknown): boolean {
  return !(err instanceof ResultCodeError);
}

/** Every configured domain controller was unreachable. */
export class DirectoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`no domain controller reachable: ${describeConnectionError(cause)}`, { cause });
    this.name = 'DirectoryUnavailableError';
  }
}

/** A readable reason for a connection failure; AggregateError has no message. */
export function describeConnectionError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const inner = err instanceof AggregateError ? err.errors[0] : undefined;
  return (
    err.message ||
    (inner instanceof Error ? inner.message : '') ||
    (typeof code === 'string' ? code : '') ||
    err.name
  );
}

/**
 * Run `fn` against each configured LDAP URL until one succeeds. Caller is
 * responsible for the bind+unbind inside `fn`. Throws the last error if all
 * servers fail.
 *
 * Only a throw moves on to the next server, so `fn` must let unreachable
 * errors from its bind propagate (see isDirectoryUnreachable) and return,
 * not throw, anything after it: a write that failed halfway is never
 * replayed against another DC.
 */
export async function withFailover<T>(
  config: ClientConfig,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const url of config.ldapUrls) {
    const client = createClient(config, url);
    try {
      return await fn(client);
    } catch (err) {
      lastError = err;
      // Best-effort tear-down before trying the next URL.
      try {
        await client.unbind();
      } catch {
        // ignore — likely already disconnected
      }
    }
  }
  if (isDirectoryUnreachable(lastError)) throw new DirectoryUnavailableError(lastError);
  throw lastError instanceof Error
    ? lastError
    : new Error('LDAP operation failed against all configured URLs');
}
