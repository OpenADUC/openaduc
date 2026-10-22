// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from 'node:fs';
import { type LdapTlsMode, ldapUrlScheme } from '@openaduc/shared';
import { BusyError, Client, type ClientOptions, ResultCodeError, UnavailableError } from 'ldapts';
import { DirectoryUnavailableError } from '../types.js';

export interface ClientConfig {
  ldapUrls: readonly string[];
  tlsMode: LdapTlsMode;
  tlsRejectUnauthorized: boolean;
  tlsCaPath?: string | undefined;
  operationTimeoutMs: number;
}

/**
 * How a connection to `url` starts. ldaps:// is TLS from the first byte;
 * ldap:// in StartTLS mode is upgraded before any bind. ldap:// under LDAPS
 * also means TLS from the first byte on that port: saves no longer allow
 * it, but older directories (e.g. ldap://dc:636) have always connected that
 * way and keep working. Nothing is ever sent in cleartext.
 */
export function transportFor(url: string, mode: LdapTlsMode): 'tls' | 'starttls' {
  return mode === 'starttls' && ldapUrlScheme(url) === 'ldap' ? 'starttls' : 'tls';
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
  };
  // ldapts opens TLS immediately whenever tlsOptions is set, even for
  // ldap:// URLs, so pass it only when the connection should start as TLS.
  // StartTLS connections get their options at upgrade time instead.
  if (transportFor(url, config.tlsMode) === 'tls') opts.tlsOptions = tlsOptionsFor(config);
  return new Client(opts);
}

function tlsOptionsFor(config: ClientConfig): NonNullable<ClientOptions['tlsOptions']> {
  const tls: NonNullable<ClientOptions['tlsOptions']> = {
    rejectUnauthorized: config.tlsRejectUnauthorized,
  };
  if (config.tlsCaPath) tls.ca = readFileSync(config.tlsCaPath);
  return tls;
}

// Node socket and DNS failures.
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);
// OpenSSL certificate verification failures, as Node reports them.
const CERT_ERROR_CODE = /^(ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|CERT_)/;
// ldapts's own timeouts and dropped connections are plain Errors.
const LDAPTS_CONNECTION_MESSAGE =
  /^Connection timeout$|Operation timed out$|^Connection closed before message response/;

/**
 * True when `err` means the server couldn't be reached or talked to:
 * connection refused, timeout, TLS failure, dropped socket, or the DC
 * saying it's busy or unavailable. Another domain controller may still
 * work. Other LDAP results (wrong password, insufficient access, …) are
 * answers another DC would repeat, and any other exception is a bug here,
 * not an outage.
 */
export function isDirectoryUnreachable(err: unknown): boolean {
  if (err instanceof BusyError || err instanceof UnavailableError) return true;
  if (err instanceof ResultCodeError) return false;
  // Node's multi-address connect reports one error per address tried.
  if (err instanceof AggregateError) return err.errors.some(isDirectoryUnreachable);
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (NETWORK_ERROR_CODES.has(code) || CERT_ERROR_CODE.test(code))) {
    return true;
  }
  return LDAPTS_CONNECTION_MESSAGE.test(err.message);
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
 * servers fail. In StartTLS mode the connection is upgraded before `fn`
 * runs, so no bind ever goes out unencrypted; if the upgrade fails, `fn`
 * isn't called for that server.
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
      if (transportFor(url, config.tlsMode) === 'starttls') {
        await client.startTLS(tlsOptionsFor(config));
      }
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
  if (isDirectoryUnreachable(lastError)) {
    throw new DirectoryUnavailableError(describeConnectionError(lastError), lastError);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('LDAP operation failed against all configured URLs');
}
