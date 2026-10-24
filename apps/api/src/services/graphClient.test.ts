// SPDX-License-Identifier: BUSL-1.1
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphClient, GraphThrottledError } from './graphClient.js';

const log = { warn: vi.fn(), child: () => log } as unknown as FastifyBaseLogger;
const creds = { tenantId: 't', clientId: 'c', clientSecret: 's', teamsWebhookUrl: null };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Graph answering each call to the API with the next response, after a token. */
function graphAnswering(...answers: Response[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url.includes('login.microsoftonline.com')) {
      return json({ access_token: 'token', expires_in: 3600 });
    }
    calls.push(`${init.method ?? 'GET'} ${url}`);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected ${url}`);
    return next;
  });
  return calls;
}

function client(maxWaitMs = 10_000) {
  const waits: number[] = [];
  const graph = new GraphClient(creds, log, {
    maxWaitMs,
    sleep: async (ms) => waits.push(ms),
  });
  return { graph, waits };
}

afterEach(() => vi.unstubAllGlobals());

describe('GraphClient throttling', () => {
  it('waits as long as Retry-After says, then retries', async () => {
    const calls = graphAnswering(
      json({ error: { code: 'TooManyRequests' } }, 429, { 'Retry-After': '2' }),
      json({ value: [] }, 503, { 'Retry-After': '1' }),
      json({ value: ['ok'] }),
    );
    const { graph, waits } = client();
    expect((await graph.getJson('/groups')).data).toEqual({ value: ['ok'] });
    expect(waits).toEqual([2000, 1000]);
    expect(calls).toHaveLength(3);
  });

  it('gives up once Graph asks for longer than it will wait', async () => {
    graphAnswering(json({}, 429, { 'Retry-After': '30' }));
    const { graph, waits } = client(10_000);
    const err = await graph.getJson('/groups').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphThrottledError);
    expect(err).toMatchObject({ statusCode: 429, retryAfterSeconds: 30 });
    expect(waits).toEqual([]);
  });

  it('stops after a few retries however short the waits', async () => {
    const busy = () => json({}, 429, { 'Retry-After': '0' });
    const calls = graphAnswering(busy(), busy(), busy(), busy(), busy());
    const { graph } = client();
    await expect(graph.getJson('/groups')).rejects.toBeInstanceOf(GraphThrottledError);
    expect(calls).toHaveLength(4);
  });

  it('doesn’t retry a write Graph answers 503 to, which may have gone through', async () => {
    const calls = graphAnswering(json({ error: { code: 'ServiceUnavailable' } }, 503));
    const { graph } = client();
    await expect(graph.postJson('/users/u/authentication/x', {})).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(calls).toHaveLength(1);
  });
});
