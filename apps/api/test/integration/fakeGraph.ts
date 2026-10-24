// SPDX-License-Identifier: BUSL-1.1

// Pieces of a Microsoft Graph played behind a stubbed fetch, so the API's
// own Graph client, token request and all, talks to a test's fake.

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An access token whose `roles` claim grants these application permissions. */
export function token(roles: string[]): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ roles })}.sig`;
}

export const TAP_VALUE = 'Tap-Value-7Kq2';
export const TAP_PERMISSIONS_GRANTED = [
  'UserAuthMethod-TAP.ReadWrite.All',
  'Policy.Read.AuthenticationMethod',
  'User.Read.All',
  'RoleManagement.Read.Directory',
  'Organization.Read.All',
];

export interface FakeTap {
  id: string;
  createdDateTime: string;
  startDateTime: string;
  lifetimeInMinutes: number;
  isUsableOnce: boolean;
  /** Set by a test: the person has signed in with it. */
  used?: boolean;
}

/** Microsoft Graph as far as Temporary Access Passes and the connection test use it. */
export class FakeTapGraph {
  roles = [...TAP_PERMISSIONS_GRANTED];
  policy = {
    state: 'enabled',
    defaultLifetimeInMinutes: 60,
    minimumLifetimeInMinutes: 60,
    maximumLifetimeInMinutes: 480,
    isUsableOnce: false,
    includeTargets: [{ targetType: 'group', id: 'all_users' }],
  };
  lastSyncAt = '2026-10-24T11:30:00Z';
  /** Principals holding an Entra role. */
  roleHolders: string[] = [];
  /** Graph's answer to the next pass created, instead of creating it. */
  rejectNextPass: string | null = null;
  /** Requests whose path matches are answered 429 with this Retry-After, in seconds. */
  throttled: { path: RegExp; retryAfter: number } | null = null;
  /** AD objectSid → Entra object id, for the users Connect Sync has synced. */
  synced = new Map<string, string>();
  passes = new Map<string, FakeTap[]>();
  requests: { method: string; url: string; body: string | null }[] = [];
  /** Each pass's value, in the order they were made. */
  values: string[] = [];

  /** The passes created, in order, with what they were created with. */
  created(): { entraUserId: string; body: Record<string, unknown> }[] {
    return this.requests.flatMap((r) => {
      const m = /\/users\/([^/]+)\/authentication\/temporaryAccessPassMethods$/.exec(
        new URL(r.url).pathname,
      );
      return m && r.method === 'POST'
        ? [{ entraUserId: decodeURIComponent(m[1]!), body: JSON.parse(r.body ?? '{}') }]
        : [];
    });
  }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    this.requests.push({ method, url: url.toString(), body: (init.body as string) ?? null });
    if (url.hostname === 'login.microsoftonline.com') {
      return json({ access_token: token(this.roles), expires_in: 3600 });
    }
    const path = url.pathname.replace(/^\/v1\.0/, '');
    if (this.throttled?.path.test(path)) {
      return json({ error: { code: 'TooManyRequests', message: 'throttled' } }, 429, {
        'retry-after': String(this.throttled.retryAfter),
      });
    }
    if (path === '/organization') {
      return json({
        value: [{ displayName: 'Test Tenant', onPremisesLastSyncDateTime: this.lastSyncAt }],
      });
    }
    if (path.endsWith('/authenticationMethodConfigurations/TemporaryAccessPass')) {
      return json({ id: 'TemporaryAccessPass', ...this.policy });
    }
    if (path === '/users') {
      const sid = /onPremisesSecurityIdentifier eq '([^']+)'/.exec(
        url.searchParams.get('$filter') ?? '',
      )?.[1];
      const id = sid ? this.synced.get(sid) : undefined;
      return json({ value: id ? [{ id }] : [] });
    }
    const passes = /^\/users\/([^/]+)\/authentication\/temporaryAccessPassMethods$/.exec(path);
    if (passes) {
      const id = decodeURIComponent(passes[1]!);
      if (method === 'GET') return json({ value: (this.passes.get(id) ?? []).map(withUsability) });
      if (this.rejectNextPass) {
        const message = this.rejectNextPass;
        this.rejectNextPass = null;
        return json({ error: { code: 'badRequest', message } }, 400);
      }
      const body = JSON.parse(String(init.body)) as {
        startDateTime?: string;
        lifetimeInMinutes: number;
        isUsableOnce: boolean;
      };
      const made = this.values.length + 1;
      const created: FakeTap = {
        id: `tap-${made}`,
        createdDateTime: new Date().toISOString(),
        startDateTime: body.startDateTime ?? new Date().toISOString(),
        lifetimeInMinutes: body.lifetimeInMinutes,
        isUsableOnce: body.isUsableOnce,
      };
      this.passes.set(id, [created]);
      const value = made === 1 ? TAP_VALUE : `${TAP_VALUE}-${made}`;
      this.values.push(value);
      return json({ temporaryAccessPass: value, ...withUsability(created) }, 201);
    }
    if (path.startsWith('/roleManagement/directory/')) {
      return json({ value: this.roleHolders.map((principalId) => ({ principalId })) });
    }
    if (/^\/users\/[^/]+\/transitiveMemberOf$/.test(path)) {
      return json({ value: [{ '@odata.type': '#microsoft.graph.group', id: 'g1' }] });
    }
    return json({ error: { code: 'Request_ResourceNotFound', message: path } }, 404);
  };
}

/** A pass as Graph shows it: whether it can be used now, and why. */
function withUsability({ used, ...pass }: FakeTap) {
  const now = Date.now();
  const start = Date.parse(pass.startDateTime);
  const end = start + pass.lifetimeInMinutes * 60_000;
  const reason =
    used && pass.isUsableOnce
      ? 'OneTimeUsed'
      : end <= now
        ? 'Expired'
        : start > now
          ? 'NotYetValid'
          : 'EnabledByPolicy';
  return { ...pass, isUsable: reason === 'EnabledByPolicy', methodUsabilityReason: reason };
}
