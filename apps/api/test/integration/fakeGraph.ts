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
