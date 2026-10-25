// SPDX-License-Identifier: BUSL-1.1
import { z } from 'zod';
import type { GraphResponse } from './graphClient.js';

// Finding an AD object's Entra twin and reading Graph lists, shared by the
// Entra features that act on one user or group.
//
// An AD object's Entra twin is found by its objectSid, which Connect Sync
// writes to onPremisesSecurityIdentifier. A name or UPN match would be
// unsafe: a cloud-only object can hold the name an AD object has been given.

export type GraphReader = {
  getJson<T>(path: string, opts?: { headers?: Record<string, string> }): Promise<GraphResponse<T>>;
};

// Guards against a runaway nextLink chain.
const MAX_PAGES = 50;

export const listOf = <T extends z.ZodType>(item: T) =>
  z.object({ value: z.array(item), '@odata.nextLink': z.string().optional() });

/** Every item across a nextLink chain; null past MAX_PAGES. */
export async function allPages<T extends z.ZodType>(
  graph: GraphReader,
  first: string,
  item: T,
  headers?: Record<string, string>,
): Promise<z.infer<T>[] | null> {
  const items: z.infer<T>[] = [];
  let next: string | undefined = first;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const page = listOf(item).parse(
      (await graph.getJson(next, headers ? { headers } : undefined)).data,
    );
    items.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return next ? null : items;
}

async function findBySid(graph: GraphReader, collection: string, sid: string) {
  // Filtering on onPremisesSecurityIdentifier is an advanced query.
  const res = await graph.getJson(
    `/${collection}?$filter=onPremisesSecurityIdentifier eq '${sid}'&$select=id&$count=true`,
    { headers: { ConsistencyLevel: 'eventual' } },
  );
  return listOf(z.object({ id: z.string() })).parse(res.data).value[0]?.id ?? null;
}

/** The Entra user synced from the AD user with this SID; null when there's none yet. */
export const findEntraUser = (graph: GraphReader, sid: string) => findBySid(graph, 'users', sid);

/** The Entra group synced from the AD group with this SID; null when there's none yet. */
export const findEntraGroup = (graph: GraphReader, sid: string) => findBySid(graph, 'groups', sid);

/** When the tenant last synced from AD; null when it never has or Graph won't say. */
export async function tenantLastSync(graph: GraphReader): Promise<string | null> {
  try {
    const res = await graph.getJson<{ value?: { onPremisesLastSyncDateTime?: string | null }[] }>(
      '/organization?$select=onPremisesLastSyncDateTime',
    );
    const at = res.data?.value?.[0]?.onPremisesLastSyncDateTime;
    return at ? new Date(at).toISOString() : null;
  } catch {
    return null;
  }
}
