// SPDX-License-Identifier: BUSL-1.1
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import type { DirectoryProvider, DirectoryUser } from '../providers/types.js';
import { upsertUser } from './userCache.js';

export interface UserLiveRefreshResult {
  user: DirectoryUser;
  cachedAt: Date | null;
  liveRefreshedAt: Date;
  isStale: boolean;
}

/**
 * Resolve a user from AD by objectGUID, upsert the cache, and return both
 * the live record and freshness metadata. Used by GET /api/users/:id and
 * (with `mustSucceed: true`) before any write.
 */
export class UserLiveRefreshService {
  constructor(private readonly db: Kysely<DB>) {}

  async refresh(
    provider: DirectoryProvider,
    objectGuid: string,
  ): Promise<UserLiveRefreshResult | null> {
    const live = await provider.getUser({ kind: 'objectGuid', value: objectGuid });
    if (!live) return null;
    await upsertUser(this.db, provider.id, live, { source: 'live-refresh' });
    const refreshedAt = new Date();
    return {
      user: live,
      cachedAt: refreshedAt,
      liveRefreshedAt: refreshedAt,
      isStale: false,
    };
  }

  /**
   * Reconcile the `direct=true` rows in `user_group_memberships` to match
   * the user's current `memberOf` list from AD. Called after a successful
   * add/remove so the UI sees the change immediately instead of waiting
   * for the next full sync.
   *
   * Only direct rows are touched. Nested-membership rows (`direct=false`)
   * are owned by the sync worker, which walks the group tree to compute
   * them. For groups present in `memberOfDns` but missing from
   * `group_cache_records`, we silently skip — the next full sync will
   * pick them up.
   */
  async reconcileDirectMemberships(
    providerId: number,
    userObjectGuid: string,
    memberOfDns: readonly string[],
  ): Promise<void> {
    const dnsLower = memberOfDns.map((d) => d.toLowerCase());
    const groups =
      dnsLower.length === 0
        ? []
        : await this.db
            .selectFrom('group_cache_records')
            .select(['object_guid', 'distinguished_name'])
            .where('provider_id', '=', providerId)
            .where(sql<string>`lower(distinguished_name)`, 'in', dnsLower)
            .execute();

    await this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('user_group_memberships')
        .where('provider_id', '=', providerId)
        .where('user_object_guid', '=', userObjectGuid)
        .where('direct', '=', true)
        .execute();
      if (groups.length === 0) return;
      await trx
        .insertInto('user_group_memberships')
        .values(
          groups.map((g) => ({
            provider_id: providerId,
            user_object_guid: userObjectGuid,
            group_object_guid: g.object_guid,
            direct: true,
          })),
        )
        // The PK is (provider_id, user_object_guid, group_object_guid).
        // A nested-membership row for the same group could already exist;
        // upsert keeps direct=true and refreshes synced_at without
        // duplicating.
        .onConflict((oc) =>
          oc
            .columns(['provider_id', 'user_object_guid', 'group_object_guid'])
            .doUpdateSet({ direct: true, synced_at: new Date() }),
        )
        .execute();
    });
  }
}
