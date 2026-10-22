// SPDX-License-Identifier: BUSL-1.1
import { readFileSync } from 'node:fs';
import { type LdapTlsMode, ldapUrlScheme } from '@openaduc/shared';
import { Client, type ClientOptions } from 'ldapts';

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

/**
 * Run `fn` against each configured LDAP URL until one succeeds. Caller is
 * responsible for the bind+unbind inside `fn`. Throws the last error if all
 * servers fail. In StartTLS mode the connection is upgraded before `fn`
 * runs, so no bind ever goes out unencrypted; if the upgrade fails, `fn`
 * isn't called for that server.
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
  throw lastError instanceof Error
    ? lastError
    : new Error('LDAP operation failed against all configured URLs');
}
