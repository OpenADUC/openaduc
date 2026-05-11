// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '../db/types.js';
import { GraphPermissionError, type GraphClient } from './graphClient.js';

// User photo cache backed by user_photos. Keyed by (provider_id, object_guid)
// — the AD objectGuid surfaces in user_cache_records and routes alike, so
// callers don't need to know about Entra's separate id space.
//
// Read path:
//   1. Look up the row by (provider, guid).
//   2. If it exists and is fresh, return cached bytes.
//   3. If it exists but is stale, fetch with `If-None-Match: <etag>` —
//      Graph returns 304 (extend TTL, no bytes copied) or 200 (replace).
//   4. If it doesn't exist, fetch fresh.
//   5. If Graph returns 404, mark `absent=true` so subsequent renders
//      skip the network call until the periodic refresh task runs.
//
// Write path is identical for the periodic refresh runner — it just walks
// every cached user. Both use this service.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Use /photo/$value (the user's default photo) rather than a sized
// variant like /photos/240x240/$value. Graph only generates the sized
// thumbnails when the source photo is at least that big, so requesting a
// specific size 404s for users who uploaded smaller originals — they
// have a photo, just not at 240x240. The default endpoint returns the
// original if one exists at all, regardless of dimensions.
const PHOTO_PATH = '/photo/$value';

export interface CachedPhoto {
  bytes: Buffer;
  contentType: string;
  etag: string | null;
  fetchedAt: Date;
  absent: boolean;
}

export interface PhotoFetchOptions {
  /** Override the cache TTL. Defaults to 24h. */
  ttlMs?: number;
  /** Skip the staleness check and force a refetch. Used by the refresh runner. */
  forceRefresh?: boolean;
}

export class PhotoCacheService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Read-through fetch. Returns null when no photo is available — either
   * the user has none in Entra (304/404) or the integration call failed
   * with a permission error (logged, not thrown).
   *
   * The user-resolution step (objectGuid + UPN) happens in the caller so
   * the photo route can fail fast on unknown users without doing a Graph
   * round-trip.
   */
  async getPhoto(
    providerId: number,
    objectGuid: string,
    userPrincipalName: string,
    graph: GraphClient | null,
    opts: PhotoFetchOptions = {},
  ): Promise<CachedPhoto | null> {
    const cached = await this.read(providerId, objectGuid);
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const isFresh =
      !!cached && Date.now() - cached.fetchedAt.getTime() < ttlMs && !opts.forceRefresh;

    if (cached && isFresh) {
      // Even an absent record is "fresh" — don't re-ask Graph until the
      // refresh runner pokes it.
      return cached.absent ? null : cached;
    }

    if (!graph) return cached && !cached.absent ? cached : null;

    try {
      const result = await graph.getBinary(
        `/users/${encodeURIComponent(userPrincipalName)}${PHOTO_PATH}`,
        { ifNoneMatch: cached?.etag ?? null },
      );
      if (result.status === 304 && cached) {
        // Bytes unchanged — slide the TTL window forward without
        // rewriting the BYTEA column.
        await this.touch(providerId, objectGuid);
        return cached.absent ? null : cached;
      }
      if (result.status === 404 || (!result.ok && result.status !== 304)) {
        await this.markAbsent(providerId, objectGuid);
        return null;
      }
      await this.upsert(providerId, objectGuid, {
        bytes: result.bytes,
        contentType: result.contentType,
        etag: result.etag,
      });
      return {
        bytes: result.bytes,
        contentType: result.contentType,
        etag: result.etag,
        fetchedAt: new Date(),
        absent: false,
      };
    } catch (err) {
      if (err instanceof GraphPermissionError) {
        this.log.warn(
          { err: err.message, hint: err.hint, providerId, objectGuid },
          'photo fetch denied by Graph',
        );
        // Return whatever we have on disk; permission errors shouldn't
        // wipe a previously-cached photo.
        return cached && !cached.absent ? cached : null;
      }
      this.log.warn({ err, providerId, objectGuid }, 'photo fetch failed');
      return cached && !cached.absent ? cached : null;
    }
  }

  /** Iterate every cached user-guid for this directory. Used by the refresh runner. */
  async listCachedGuids(providerId: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('user_photos')
      .select('object_guid')
      .where('provider_id', '=', providerId)
      .execute();
    return rows.map((r) => r.object_guid);
  }

  /**
   * Drop photo rows whose users no longer exist in user_cache_records or
   * have been tombstoned. Called periodically by the refresh runner.
   */
  async pruneOrphans(providerId: number): Promise<number> {
    const result = await this.db
      .deleteFrom('user_photos')
      .where('provider_id', '=', providerId)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('user_cache_records')
              .select('id')
              .whereRef('user_cache_records.provider_id', '=', 'user_photos.provider_id')
              .whereRef('user_cache_records.object_guid', '=', 'user_photos.object_guid')
              .where('user_cache_records.deleted_at', 'is', null),
          ),
        ),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  // ---- Internals -------------------------------------------------------

  private async read(providerId: number, objectGuid: string): Promise<CachedPhoto | null> {
    const row = await this.db
      .selectFrom('user_photos')
      .selectAll()
      .where('provider_id', '=', providerId)
      .where('object_guid', '=', objectGuid)
      .executeTakeFirst();
    if (!row) return null;
    return {
      bytes: row.bytes,
      contentType: row.content_type,
      etag: row.etag,
      fetchedAt: new Date(row.fetched_at),
      absent: row.absent,
    };
  }

  private async upsert(
    providerId: number,
    objectGuid: string,
    photo: { bytes: Buffer; contentType: string; etag: string | null },
  ): Promise<void> {
    await this.db
      .insertInto('user_photos')
      .values({
        provider_id: providerId,
        object_guid: objectGuid,
        content_type: photo.contentType,
        etag: photo.etag,
        bytes: photo.bytes,
        absent: false,
      })
      .onConflict((oc) =>
        oc.columns(['provider_id', 'object_guid']).doUpdateSet({
          content_type: photo.contentType,
          etag: photo.etag,
          bytes: photo.bytes,
          absent: false,
          fetched_at: new Date(),
        }),
      )
      .execute();
  }

  private async touch(providerId: number, objectGuid: string): Promise<void> {
    await this.db
      .updateTable('user_photos')
      .set({ fetched_at: new Date() })
      .where('provider_id', '=', providerId)
      .where('object_guid', '=', objectGuid)
      .execute();
  }

  private async markAbsent(providerId: number, objectGuid: string): Promise<void> {
    await this.db
      .insertInto('user_photos')
      .values({
        provider_id: providerId,
        object_guid: objectGuid,
        content_type: '',
        etag: null,
        bytes: Buffer.alloc(0),
        absent: true,
      })
      .onConflict((oc) =>
        oc.columns(['provider_id', 'object_guid']).doUpdateSet({
          content_type: '',
          etag: null,
          bytes: Buffer.alloc(0),
          absent: true,
          fetched_at: new Date(),
        }),
      )
      .execute();
  }
}
