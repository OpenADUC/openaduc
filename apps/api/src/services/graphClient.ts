// SPDX-License-Identifier: BUSL-1.1
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { EntraIntegrationCreds, EntraIntegrationService } from './entraIntegration.js';

// Microsoft Graph client built around the OAuth 2.0 client-credentials
// flow. We hand-roll the token POST instead of pulling in @azure/msal-node
// — the daemon use case is a single tenant, single audience, refresh-on-
// expiry, and that's about 30 lines. Adding MSAL would be a few MB of dep
// for caching we already do here.
//
// One factory per process; one client per provider_id, lazily built and
// cached. Tokens live in memory only; restarting the API forces a fresh
// `oauth2/v2.0/token` round trip — that's <1s and acceptable.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_HOST = 'https://login.microsoftonline.com';
// Graph permissions consent at the application level, so the only valid
// scope on a client_credentials flow is `<resource>/.default`.
const SCOPE = 'https://graph.microsoft.com/.default';

// 60-second buffer subtracted from the token's expiry — we'd rather refresh
// a hair early than 401 in the middle of a Graph call and have to retry.
const TOKEN_REFRESH_BUFFER_MS = 60_000;

export interface GraphResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  /** Raw Graph headers — useful for ETag-conditional fetches. */
  headers: Headers;
}

export interface GraphBinaryResponse {
  status: number;
  ok: boolean;
  bytes: Buffer;
  contentType: string;
  etag: string | null;
  headers: Headers;
}

export class GraphPermissionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly graphCode: string | null,
    public readonly hint: string | null,
  ) {
    super(message);
    this.name = 'GraphPermissionError';
  }
}

export class GraphClient {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  /**
   * In-flight token refresh — multiple concurrent Graph calls during a
   * cold start should share one token request, not race for it.
   */
  private inflightTokenFetch: Promise<string> | null = null;

  constructor(
    private readonly creds: EntraIntegrationCreds,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ---- Public surface --------------------------------------------------

  /**
   * Issue a JSON GET against Graph. Throws GraphPermissionError on 401/403
   * with a hint about the most likely missing permission so the operator
   * sees something more useful than "Forbidden".
   */
  async getJson<T = unknown>(path: string): Promise<GraphResponse<T>> {
    const res = await this.request(path, { method: 'GET' });
    return await readJson<T>(res, path);
  }

  /**
   * Issue a binary GET (photos). Returns bytes + ETag so the photo cache
   * can store both. 304 / 404 short-circuit before allocating buffers.
   */
  async getBinary(
    path: string,
    opts: { ifNoneMatch?: string | null } = {},
  ): Promise<GraphBinaryResponse> {
    const headers: Record<string, string> = {};
    if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
    const res = await this.request(path, { method: 'GET', headers });
    if (res.status === 304 || res.status === 404) {
      return {
        status: res.status,
        ok: false,
        bytes: Buffer.alloc(0),
        contentType: res.headers.get('content-type') ?? '',
        etag: res.headers.get('etag'),
        headers: res.headers,
      };
    }
    if (!res.ok) await raiseFromError(res, path);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      ok: true,
      bytes: buf,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      etag: res.headers.get('etag'),
      headers: res.headers,
    };
  }

  /** Quick liveness probe used by the test-connection route. */
  async testConnection(): Promise<{
    ok: boolean;
    error?: string;
    tenantDisplayName?: string | null;
  }> {
    try {
      const res = await this.getJson<{ value: Array<{ displayName?: string | null }> }>(
        '/organization?$select=displayName',
      );
      const displayName = res.data?.value?.[0]?.displayName ?? null;
      return { ok: true, tenantDisplayName: displayName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  // ---- Internals -------------------------------------------------------

  private async request(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string | URLSearchParams },
  ): Promise<Response> {
    const token = await this.getToken();
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
    const res = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });

    // One automatic retry on 401 — covers the rare race where the cached
    // token expired between our check and Graph's eval. After that,
    // surface as a permission error.
    if (res.status === 401 && this.cachedToken) {
      this.cachedToken = null;
      const fresh = await this.getToken();
      return await fetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${fresh}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    }

    return res;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS > now) {
      return this.cachedToken.value;
    }
    if (this.inflightTokenFetch) return this.inflightTokenFetch;

    this.inflightTokenFetch = this.fetchToken().finally(() => {
      this.inflightTokenFetch = null;
    });
    return this.inflightTokenFetch;
  }

  private async fetchToken(): Promise<string> {
    const url = `${TOKEN_HOST}/${encodeURIComponent(this.creds.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      scope: SCOPE,
    });
    let lastErr: unknown = null;
    // Two retries on transient errors only (5xx + network). 4xx like
    // invalid_client throws on the first attempt — retrying invalid creds
    // would just lock us out faster.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (res.ok) {
          const json = (await res.json()) as { access_token: string; expires_in: number };
          this.cachedToken = {
            value: json.access_token,
            expiresAt: Date.now() + json.expires_in * 1000,
          };
          return json.access_token;
        }
        const errBody = await safeJson(res);
        if (res.status >= 400 && res.status < 500) {
          throw new GraphPermissionError(
            describeTokenError(errBody) ?? `token endpoint returned ${res.status}`,
            res.status,
            (errBody?.error as string) ?? null,
            tokenErrorHint(errBody),
          );
        }
        lastErr = new Error(`token endpoint ${res.status}`);
      } catch (err) {
        if (err instanceof GraphPermissionError) throw err;
        lastErr = err;
      }
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
    throw lastErr instanceof Error ? lastErr : new Error('token fetch failed');
  }
}

interface TokenErrorBody {
  error?: unknown;
  error_description?: unknown;
}

async function safeJson(res: Response): Promise<TokenErrorBody | null> {
  try {
    return (await res.json()) as TokenErrorBody;
  } catch {
    return null;
  }
}

function describeTokenError(body: TokenErrorBody | null): string | null {
  if (!body) return null;
  const parts: string[] = [];
  if (typeof body.error === 'string') parts.push(body.error);
  if (typeof body.error_description === 'string') parts.push(body.error_description);
  return parts.length ? parts.join(': ') : null;
}

function tokenErrorHint(body: TokenErrorBody | null): string | null {
  const desc = typeof body?.error_description === 'string' ? body.error_description : '';
  if (/AADSTS7000215/.test(desc)) return 'invalid client secret';
  if (/AADSTS90002/.test(desc)) return 'tenant not found';
  if (/AADSTS700016/.test(desc)) return 'application (client) not found in tenant';
  if (/AADSTS700027/.test(desc)) return 'client assertion / secret expired';
  return null;
}

async function readJson<T>(res: Response, path: string): Promise<GraphResponse<T>> {
  if (!res.ok) await raiseFromError(res, path);
  // Some Graph 2xx responses (e.g. 204) have no body.
  if (res.status === 204) {
    return { status: 204, ok: true, data: undefined as T, headers: res.headers };
  }
  const data = (await res.json()) as T;
  return { status: res.status, ok: true, data, headers: res.headers };
}

async function raiseFromError(res: Response, path: string): Promise<never> {
  let message = `Graph ${res.status} on ${path}`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) message = `${message}: ${body.error.message}`;
    if (body?.error?.code) code = body.error.code;
  } catch {
    /* fallthrough */
  }
  const hint = permissionHintForPath(res.status, path, code);
  throw new GraphPermissionError(message, res.status, code, hint);
}

function permissionHintForPath(status: number, path: string, code: string | null): string | null {
  if (status !== 401 && status !== 403) return null;
  if (code === 'Authorization_RequestDenied' || status === 403) {
    if (path.includes('signInActivity') || path.includes('auditLogs')) {
      return 'AuditLog.Read.All (Application) is required, plus an Entra ID P1 license on the tenant';
    }
    if (path.includes('/photo')) {
      return 'User.Read.All (Application) is required to read user photos';
    }
    if (path.includes('/organization')) {
      return 'Directory.Read.All (Application) is required for the /organization probe';
    }
    return 'check that admin consent has been granted for the requested permission';
  }
  return null;
}

// ---- Factory ---------------------------------------------------------
// Per-providerId cached client, rebuilt on credential change. The
// scheduler and routes both go through this factory so they share token
// cache; rebuild on `invalidate(providerId)` after a save.

export class GraphClientFactory {
  private readonly cache = new Map<number, GraphClient>();

  constructor(
    private readonly entra: EntraIntegrationService,
    private readonly log: FastifyBaseLogger,
  ) {}

  async build(providerId: number): Promise<GraphClient | null> {
    const existing = this.cache.get(providerId);
    if (existing) return existing;
    const creds = await this.entra.getCreds(providerId);
    if (!creds) return null;
    const client = new GraphClient(creds, this.log.child({ providerId, scope: 'graph' }));
    this.cache.set(providerId, client);
    return client;
  }

  invalidate(providerId: number): void {
    this.cache.delete(providerId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
