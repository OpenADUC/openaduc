// SPDX-License-Identifier: BUSL-1.1
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '../db/types.js';
import { GraphPermissionError, type GraphClient } from './graphClient.js';

// Local cache + query layer for Entra sign-in events. Two surfaces:
//
//   1. `syncRecent(...)` — called by the entra.signins.events runner.
//      Pulls events newer than a since cursor, paginating via Graph's
//      @odata.nextLink, and upserts with ON CONFLICT DO NOTHING so the
//      overlap window between runs doesn't produce duplicates.
//
//   2. `query(...)` / `getById(...)` — called by the SPA-facing routes.
//      Filters: userId (AD objectGuid), appId, dateRange, status,
//      free-text. Page-based pagination. Local matching is done by
//      user_object_guid which we resolve from UPN at insert time.
//
// Schema decision: promote the most-filtered fields out of detail_json
// into typed columns so SQL filtering is fast. Everything else stays in
// detail_json for the modal detail view, so adding a new Graph field
// to display doesn't need a migration.

export interface SyncResult {
  scanned: number;
  inserted: number;
  pages: number;
  /** True when MAX_PAGES_PER_RUN was hit and there's more to pull. */
  partial: boolean;
  /** True when Graph returned 401/403; surfaces in task stats. */
  denied: boolean;
}

export interface SignInEventQuery {
  // Explicit `| undefined` so Zod-parsed optional fields (which carry
  // `undefined` for unset values) plug in cleanly under
  // exactOptionalPropertyTypes.
  userId?: string | undefined; // AD objectGuid
  appId?: string | undefined;
  status?: 'success' | 'failure' | 'all' | undefined;
  fromIso?: string | undefined;
  toIso?: string | undefined;
  /** Free-text — matches against user_principal_name, user_display_name, ip_address, app_display_name. */
  search?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface ShapedSignInEvent {
  id: string; // local DB id (string for SPA stability)
  entraEventId: string;
  createdDateTime: string;
  userObjectGuid: string | null;
  entraUserId: string | null;
  userPrincipalName: string | null;
  userDisplayName: string | null;
  appId: string | null;
  appDisplayName: string | null;
  ipAddress: string | null;
  clientAppUsed: string | null;
  conditionalAccessStatus: string | null;
  isInteractive: boolean | null;
  status: {
    errorCode: number;
    failureReason: string | null;
  } | null;
  device: {
    os: string | null;
    browser: string | null;
    trustType: string | null;
  } | null;
  location: {
    city: string | null;
    state: string | null;
    countryOrRegion: string | null;
  } | null;
  authenticationMethods: string[];
  riskState: string | null;
  riskLevel: string | null;
}

export interface ShapedSignInEventDetail extends ShapedSignInEvent {
  /** Full Graph payload of fields not promoted to columns. Modal-only. */
  detail: Record<string, unknown>;
  fetchedAt: string;
}

const MAX_PAGES_PER_RUN = 30; // 30 * 100 = up to 3000 events per run
const PAGE_SIZE = 100;
// Overlap window — re-pull the last 5 minutes on each tick to absorb
// Graph's eventual-consistency lag without producing duplicates (ON
// CONFLICT DO NOTHING handles re-arrivals).
const OVERLAP_MS = 5 * 60_000;

export class SignInEventsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Pull every event since `since` and upsert. Returns sync stats for
   * the runner's last_stats_json.
   */
  async syncRecent(
    providerId: number,
    graph: GraphClient,
    since: Date | null,
  ): Promise<SyncResult> {
    // First-run ingest: no `since` → ask Graph for everything it'll
    // give us (Entra retains 30d on P1, 90d on P2). Graph's signIns
    // endpoint orders by createdDateTime desc by default.
    const sinceWithOverlap = since ? new Date(since.getTime() - OVERLAP_MS) : null;
    const filter = sinceWithOverlap ? `createdDateTime ge ${sinceWithOverlap.toISOString()}` : null;
    let nextLink: string | null =
      `/auditLogs/signIns?$top=${PAGE_SIZE}${filter ? `&$filter=${encodeURIComponent(filter)}` : ''}`;

    let pages = 0;
    let scanned = 0;
    let inserted = 0;
    let denied = false;

    type GraphSignInPage = { value: GraphSignIn[]; '@odata.nextLink'?: string };
    while (nextLink && pages < MAX_PAGES_PER_RUN) {
      let page: GraphSignInPage;
      try {
        const res = await graph.getJson<GraphSignInPage>(nextLink);
        page = res.data;
      } catch (err) {
        if (
          err instanceof GraphPermissionError &&
          (err.statusCode === 401 || err.statusCode === 403)
        ) {
          denied = true;
          this.log.warn(
            { hint: err.hint, status: err.statusCode },
            'sign-in events fetch denied — likely missing AuditLog.Read.All or P1',
          );
          break;
        }
        throw err;
      }
      pages++;

      // Bulk-resolve user_object_guid for this page's UPNs in one
      // round trip. Avoids N queries against user_cache_records.
      const upns = Array.from(
        new Set(
          (page.value ?? [])
            .map((e) => e.userPrincipalName)
            .filter((u): u is string => !!u)
            .map((u) => u.toLowerCase()),
        ),
      );
      const guidMap = upns.length
        ? new Map(
            (
              await this.db
                .selectFrom('user_cache_records')
                .select(['user_principal_name', 'object_guid'])
                .where('provider_id', '=', providerId)
                .where('deleted_at', 'is', null)
                .where(sql<string>`lower(user_principal_name)`, 'in', upns)
                .execute()
            ).map((r) => [r.user_principal_name?.toLowerCase() ?? '', r.object_guid]),
          )
        : new Map<string, string>();

      const rows: Array<Record<string, unknown>> = [];
      for (const ev of page.value ?? []) {
        scanned++;
        if (!ev.id || !ev.createdDateTime) continue;
        const upnLower = ev.userPrincipalName?.toLowerCase() ?? '';
        const userObjectGuid = upnLower ? (guidMap.get(upnLower) ?? null) : null;
        const authMethods = (ev.authenticationDetails ?? [])
          .filter((d) => d.succeeded !== false && d.authenticationMethod)
          .map((d) => d.authenticationMethod as string);

        // Anything we don't promote becomes the modal detail. Use
        // structuredClone-style copy so we don't drag references.
        const detail: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ev)) {
          if (PROMOTED_KEYS.has(k)) continue;
          detail[k] = v;
        }

        rows.push({
          provider_id: providerId,
          entra_event_id: ev.id,
          user_object_guid: userObjectGuid,
          entra_user_id: ev.userId ?? null,
          user_principal_name: ev.userPrincipalName ?? null,
          user_display_name: ev.userDisplayName ?? null,
          app_id: ev.appId ?? null,
          app_display_name: ev.appDisplayName ?? null,
          ip_address: ev.ipAddress ?? null,
          client_app_used: ev.clientAppUsed ?? null,
          conditional_access_status: ev.conditionalAccessStatus ?? null,
          is_interactive: ev.isInteractive ?? null,
          status_error_code: ev.status?.errorCode ?? null,
          status_failure_reason: ev.status?.failureReason ?? null,
          risk_state: ev.riskState ?? null,
          risk_level: ev.riskLevelAggregated ?? null,
          location_city: ev.location?.city ?? null,
          location_state: ev.location?.state ?? null,
          location_country: ev.location?.countryOrRegion ?? null,
          device_os: ev.deviceDetail?.operatingSystem ?? null,
          device_browser: ev.deviceDetail?.browser ?? null,
          device_trust_type: ev.deviceDetail?.trustType ?? null,
          auth_methods: JSON.stringify(authMethods),
          created_date_time: new Date(ev.createdDateTime),
          detail_json: JSON.stringify(detail),
        });
      }

      if (rows.length > 0) {
        const result = await this.db
          .insertInto('entra_signin_events')
          .values(rows as never)
          .onConflict((oc) =>
            // (provider_id, entra_event_id) is the unique key. Re-pulls
            // of an overlap window are no-ops.
            oc.columns(['provider_id', 'entra_event_id']).doNothing(),
          )
          .executeTakeFirst();
        inserted += Number(result.numInsertedOrUpdatedRows ?? 0);
      }

      nextLink = page['@odata.nextLink'] ?? null;
    }

    return { pages, scanned, inserted, partial: !!nextLink, denied };
  }

  /**
   * Query the local cache. All filters are optional; default page size
   * is 50.
   */
  async query(
    providerId: number,
    q: SignInEventQuery,
  ): Promise<{
    events: ShapedSignInEvent[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));

    let base = this.db.selectFrom('entra_signin_events').where('provider_id', '=', providerId);

    if (q.userId) base = base.where('user_object_guid', '=', q.userId);
    if (q.appId) base = base.where('app_id', '=', q.appId);
    if (q.status === 'success') {
      base = base.where('status_error_code', '=', 0);
    } else if (q.status === 'failure') {
      // null status code shouldn't happen but treat as not-success.
      base = base.where((eb) =>
        eb.or([eb('status_error_code', '!=', 0), eb('status_error_code', 'is', null)]),
      );
    }
    if (q.fromIso) base = base.where('created_date_time', '>=', new Date(q.fromIso));
    if (q.toIso) base = base.where('created_date_time', '<=', new Date(q.toIso));
    if (q.search && q.search.trim()) {
      const needle = `%${q.search.trim().toLowerCase()}%`;
      base = base.where((eb) =>
        eb.or([
          eb(sql<string>`lower(coalesce(user_principal_name, ''))`, 'like', needle),
          eb(sql<string>`lower(coalesce(user_display_name, ''))`, 'like', needle),
          eb(sql<string>`lower(coalesce(app_display_name, ''))`, 'like', needle),
          eb(sql<string>`lower(coalesce(ip_address, ''))`, 'like', needle),
        ]),
      );
    }

    const [rows, totalRow] = await Promise.all([
      base
        .selectAll()
        .orderBy('created_date_time', 'desc')
        .orderBy('id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst(),
    ]);

    return {
      events: rows.map(shapeRow),
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  /**
   * Distinct app names for the audit-tab filter dropdown. Capped at
   * 200 to keep the dropdown manageable; tenants with more apps will
   * be filtered via the search box.
   */
  async distinctApps(
    providerId: number,
  ): Promise<Array<{ id: string; displayName: string | null }>> {
    const rows = await this.db
      .selectFrom('entra_signin_events')
      .select(['app_id', 'app_display_name'])
      .where('provider_id', '=', providerId)
      .where('app_id', 'is not', null)
      .groupBy(['app_id', 'app_display_name'])
      .orderBy('app_display_name', 'asc')
      .limit(200)
      .execute();
    return rows
      .filter((r) => r.app_id !== null)
      .map((r) => ({ id: r.app_id as string, displayName: r.app_display_name }));
  }

  async getById(providerId: number, id: number): Promise<ShapedSignInEventDetail | null> {
    const row = await this.db
      .selectFrom('entra_signin_events')
      .selectAll()
      .where('provider_id', '=', providerId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    const shaped = shapeRow(row);
    return {
      ...shaped,
      detail: parseDetail(row.detail_json),
      fetchedAt: new Date(row.fetched_at).toISOString(),
    };
  }
}

// Fields we promote into typed columns. The runner uses this to decide
// what NOT to put in detail_json. Keep in sync with the schema.
const PROMOTED_KEYS = new Set([
  'id',
  'createdDateTime',
  'userId',
  'userPrincipalName',
  'userDisplayName',
  'appId',
  'appDisplayName',
  'ipAddress',
  'clientAppUsed',
  'conditionalAccessStatus',
  'isInteractive',
  'status',
  'riskState',
  'riskLevelAggregated',
  'location',
  'deviceDetail',
  'authenticationDetails',
]);

interface GraphSignIn {
  id?: string;
  createdDateTime?: string;
  userDisplayName?: string | null;
  userPrincipalName?: string | null;
  userId?: string | null;
  appId?: string | null;
  appDisplayName?: string | null;
  ipAddress?: string | null;
  clientAppUsed?: string | null;
  conditionalAccessStatus?: string | null;
  isInteractive?: boolean | null;
  status?: {
    errorCode?: number | null;
    failureReason?: string | null;
    additionalDetails?: string | null;
  } | null;
  deviceDetail?: {
    deviceId?: string | null;
    displayName?: string | null;
    operatingSystem?: string | null;
    browser?: string | null;
    isCompliant?: boolean | null;
    isManaged?: boolean | null;
    trustType?: string | null;
  } | null;
  location?: {
    city?: string | null;
    state?: string | null;
    countryOrRegion?: string | null;
  } | null;
  authenticationDetails?: Array<{
    authenticationMethod?: string | null;
    succeeded?: boolean | null;
  }> | null;
  riskState?: string | null;
  riskLevelAggregated?: string | null;
}

function shapeRow(row: {
  id: number | string;
  entra_event_id: string;
  created_date_time: Date | string;
  user_object_guid: string | null;
  entra_user_id: string | null;
  user_principal_name: string | null;
  user_display_name: string | null;
  app_id: string | null;
  app_display_name: string | null;
  ip_address: string | null;
  client_app_used: string | null;
  conditional_access_status: string | null;
  is_interactive: boolean | null;
  status_error_code: number | null;
  status_failure_reason: string | null;
  risk_state: string | null;
  risk_level: string | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  device_os: string | null;
  device_browser: string | null;
  device_trust_type: string | null;
  auth_methods: unknown;
}): ShapedSignInEvent {
  return {
    id: String(row.id),
    entraEventId: row.entra_event_id,
    createdDateTime:
      row.created_date_time instanceof Date
        ? row.created_date_time.toISOString()
        : new Date(row.created_date_time).toISOString(),
    userObjectGuid: row.user_object_guid,
    entraUserId: row.entra_user_id,
    userPrincipalName: row.user_principal_name,
    userDisplayName: row.user_display_name,
    appId: row.app_id,
    appDisplayName: row.app_display_name,
    ipAddress: row.ip_address,
    clientAppUsed: row.client_app_used,
    conditionalAccessStatus: row.conditional_access_status,
    isInteractive: row.is_interactive,
    status:
      row.status_error_code !== null
        ? {
            errorCode: row.status_error_code,
            failureReason: row.status_failure_reason,
          }
        : null,
    device:
      row.device_os || row.device_browser || row.device_trust_type
        ? {
            os: row.device_os,
            browser: row.device_browser,
            trustType: row.device_trust_type,
          }
        : null,
    location:
      row.location_city || row.location_state || row.location_country
        ? {
            city: row.location_city,
            state: row.location_state,
            countryOrRegion: row.location_country,
          }
        : null,
    authenticationMethods: parseMethods(row.auth_methods),
    riskState: row.risk_state,
    riskLevel: row.risk_level,
  };
}

function parseMethods(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((m): m is string => typeof m === 'string');
  return [];
}

function parseDetail(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}
