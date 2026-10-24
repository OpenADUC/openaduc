// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type RawBuilder, type Selectable } from 'kysely';
import {
  accountExpiryRequestSchema,
  bulkAccountPreviewRequestSchema,
  bulkAccountPreviewSchema,
  bulkGroupMembershipPreviewRequestSchema,
  bulkGroupMembershipPreviewSchema,
  bulkUserAttributesPreviewRequestSchema,
  bulkUserAttributesPreviewSchema,
  csvRow,
  moveRequestSchema,
  resetPasswordRequestSchema,
  userDetailSchema,
  userDeletePreflightRequestSchema,
  userDeleteRequestSchema,
  userMatchRequestSchema,
  userMatchResponseSchema,
  userRenameRequestSchema,
  userSearchQuerySchema,
  userSearchResponseSchema,
  userUpdateRequestSchema,
  type BulkAccountPreview,
  type BulkGroupMembershipPreview,
  type BulkUserAttributesPreview,
  type RecycleBinStatus,
  type UserDeletePreflightResponse,
  type UserDetail,
  type UserMatchResponse,
  type UserMatchResult,
  type UserSearchResponse,
} from '@openaduc/shared';
import { z } from 'zod';
import { describeDeleteBlock, userDeleteBlockReason } from '../lib/userDeletion.js';
import { lockoutDurationFor, lockoutEnd } from '../lib/lockout.js';
import { lookupsFor, matchEntries } from '../lib/userMatch.js';
import {
  AppError,
  BadRequest,
  Conflict,
  NotFound,
  StepUpRequired,
  Unauthorized,
} from '../plugins/errorHandler.js';
import { StepUpBindFailedError, type DirectoryProvider } from '../providers/types.js';
import { auditContextFromRequest, recordUserView, withAudit } from '../services/auditContext.js';
import { previewAccountChange } from '../services/bulkAccountChange.js';
import { previewAttributes } from '../services/bulkAttributes.js';
import { refuseBulkRequest } from '../services/bulkJobs/errors.js';
import { previewGroupMembership } from '../services/groupMembershipPreview.js';
import { findCachedOu, userMoveRefusal } from '../services/ouCache.js';
import { findCachedUser } from '../services/userCache.js';
import { UserAttributeRefusal, writeUserAttributes } from '../services/userAttributeWrite.js';
import {
  DISABLE_USER,
  ENABLE_USER,
  expireAccountAt,
  moveUserTo,
  UNLOCK_USER,
  writeUserAccount,
} from '../services/userAccountWrite.js';
import { rawArrayValues, rawAttributesFor, rawScalarValue } from '../lib/rawAttributes.js';
import { listFreshness } from '../services/listFreshness.js';
import type { UserCacheRecordsTable } from '../db/types.js';
import { directoryRefusal } from './directoryRefusal.js';
import { changeMembership } from './groupMembership.js';
import { ctx } from './writeContext.js';

const idParamSchema = z.object({ id: z.guid() });

const CSV_COLUMNS = [
  'objectGuid',
  'samAccountName',
  'userPrincipalName',
  'displayName',
  'email',
  'department',
  'title',
  'enabled',
  'locked',
  'passwordNeverExpires',
  'passwordExpiresAt',
  'accountExpiresAt',
  'lastLogonAt',
  'distinguishedName',
] as const;

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/users/export.csv ---------------------------------------
  // Stream the current filtered cache to CSV. Same filter shape as the
  // search endpoint — `?q=&enabled=...` etc. Capped at 50k rows so an
  // overzealous export can't churn the DB; we return the cap-reached
  // signal in a header so the UI can warn the operator.
  app.get('/api/users/export.csv', {
    config: { policy: { capability: 'export:user', stepUp: false, directory: 'caller' } },
    handler: async (req, reply) => {
      const q = userSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const exportCap = 50_000;

      const maxAgeDays = await resolveMaxPwdAgeDays(provider);

      // Apply the same filter pipeline as the search endpoint. Inlined
      // because hoisting the predicate builder would require a refactor
      // we don't need today. If a future filter is added to search, it
      // needs to be added here too — both call sites are tagged with
      // `// EXPORT_FILTERS_SYNC` for grep-ability.
      // EXPORT_FILTERS_SYNC
      let baseQuery = app.db
        .selectFrom('user_cache_records')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null);

      if (q.q && q.q.trim().length > 0) {
        const needle = `%${q.q.trim().toLowerCase()}%`;
        baseQuery = baseQuery.where((eb) =>
          eb.or([
            eb(sql<string>`lower(coalesce(display_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(sam_account_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(user_principal_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(email, ''))`, 'like', needle),
          ]),
        );
      }
      if (q.enabled !== undefined) baseQuery = baseQuery.where('enabled', '=', q.enabled);
      if (q.locked !== undefined) baseQuery = baseQuery.where('locked', '=', q.locked);
      if (q.passwordNeverExpires !== undefined) {
        baseQuery = baseQuery.where('password_never_expires', '=', q.passwordNeverExpires);
      }
      if (q.ou) {
        const dn = q.ou.trim();
        if (dn) {
          if (q.includeSubOus !== false) {
            baseQuery = baseQuery.where('distinguished_name', 'ilike', `%,${dn}`);
          } else {
            baseQuery = baseQuery.where(
              sql<string>`substring(distinguished_name from position(',' in distinguished_name) + 1)`,
              '=',
              dn,
            );
          }
        }
      }
      if (q.department) {
        const dept = q.department.trim();
        if (dept) {
          baseQuery = baseQuery.where(
            sql<string>`lower(coalesce(department, ''))`,
            '=',
            dept.toLowerCase(),
          );
        }
      }
      if (q.managerId) {
        const managerRow = await app.db
          .selectFrom('user_cache_records')
          .where('provider_id', '=', provider.id)
          .where('object_guid', '=', q.managerId)
          .where('deleted_at', 'is', null)
          .select('distinguished_name')
          .executeTakeFirst();
        if (managerRow) {
          baseQuery = baseQuery.where('manager_dn', '=', managerRow.distinguished_name);
        } else {
          baseQuery = baseQuery.where(sql<boolean>`false`);
        }
      }
      if (q.inGroupId && q.inGroupId.length > 0) {
        for (const groupId of q.inGroupId) {
          baseQuery = baseQuery.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('user_group_memberships as m')
                .select('m.user_object_guid')
                .whereRef('m.user_object_guid', '=', 'user_cache_records.object_guid')
                .whereRef('m.provider_id', '=', 'user_cache_records.provider_id')
                .where('m.group_object_guid', '=', groupId),
            ),
          );
        }
      }

      const rows = await baseQuery
        .selectAll()
        .orderBy('display_name', 'asc')
        .orderBy('id', 'asc')
        .limit(exportCap + 1)
        .execute();

      const truncated = rows.length > exportCap;
      const out = rows.slice(0, exportCap);

      const lines: string[] = [csvRow([...CSV_COLUMNS])];
      for (const r of out) {
        lines.push(
          csvRow([
            r.object_guid,
            r.sam_account_name ?? '',
            r.user_principal_name ?? '',
            r.display_name ?? '',
            r.email ?? '',
            r.department ?? '',
            r.title ?? '',
            r.enabled,
            r.locked,
            r.password_never_expires,
            computeExpiresAt(
              r.password_never_expires,
              r.password_expires_at,
              r.password_expiry_computed,
              r.password_last_set_at,
              maxAgeDays,
            ),
            dateOrNull(r.account_expires_at),
            dateOrNull(r.last_logon_at),
            r.distinguished_name,
          ]),
        );
      }
      const body = lines.join('\r\n');

      const filename = `users-export-${new Date().toISOString().slice(0, 10)}.csv`;
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="${filename}"`);
      if (truncated) reply.header('x-export-truncated', String(exportCap));

      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'user.export',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          metadata: {
            rowCount: out.length,
            truncated,
            filters: {
              q: q.q,
              ou: q.ou,
              department: q.department,
              managerId: q.managerId,
              enabled: q.enabled,
              locked: q.locked,
              inGroupId: q.inGroupId,
            },
          },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for user.export'));

      return body;
    },
  });

  // ---- GET /api/users (cache search) -----------------------------------
  app.get('/api/users', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<UserSearchResponse> => {
      const q = userSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const offset = (q.page - 1) * q.pageSize;

      // Effective rotation age comes from AD's domain `maxPwdAge`. The
      // expiring-soon SQL filter and the user response both consume this
      // value so the page count and per-row date stay in sync.
      const maxAgeDays = await resolveMaxPwdAgeDays(provider);
      const expiry = effectiveExpirySql(maxAgeDays);

      let baseQuery = app.db
        .selectFrom('user_cache_records')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null);

      if (q.q && q.q.trim().length > 0) {
        const needle = `%${q.q.trim().toLowerCase()}%`;
        baseQuery = baseQuery.where((eb) =>
          eb.or([
            eb(sql<string>`lower(coalesce(display_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(sam_account_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(user_principal_name, ''))`, 'like', needle),
            eb(sql<string>`lower(coalesce(email, ''))`, 'like', needle),
          ]),
        );
      }
      if (q.enabled !== undefined) baseQuery = baseQuery.where('enabled', '=', q.enabled);
      if (q.locked !== undefined) baseQuery = baseQuery.where('locked', '=', q.locked);
      if (q.passwordNeverExpires !== undefined) {
        baseQuery = baseQuery.where('password_never_expires', '=', q.passwordNeverExpires);
      }

      // `issues=true`: combine all the "needs attention" predicates with OR.
      // The horizon for "expiring soon" defaults to 14d but the caller can
      // tighten it (e.g. ?issuesWithinDays=1 for "expiring today / overdue").
      // Applies the org-wide pwd policy override when set so the SQL horizon
      // matches what the response's computed passwordExpiresAt would say.
      //
      // Disabled accounts are excluded from "needs attention" entirely — an
      // operator can find them via the dedicated `enabled=false` filter, but
      // they shouldn't drown the daily-action list.
      //
      // The dashboard rechecks a row after fixing it with `needsAttention`
      // in apps/web/src/design/lib/attention.ts; keep the two in step.
      if (q.issues === true) {
        const horizonDays = q.issuesWithinDays ?? 14;
        const horizon = new Date(Date.now() + horizonDays * 24 * 60 * 60 * 1000);
        baseQuery = baseQuery.where('enabled', '=', true);
        baseQuery = baseQuery.where((eb) =>
          eb.or([
            eb('locked', '=', true),
            eb.and([
              eb('account_expires_at', 'is not', null),
              eb('account_expires_at', '<=', horizon),
            ]),
            eb('password_must_change', '=', true),
            // Password expiring or expired (excluding never-expires accounts).
            eb.and([
              eb('password_never_expires', '=', false),
              eb(expiry, 'is not', null),
              eb(expiry, '<=', horizon),
            ]),
          ]),
        );
      }

      // "Password expiring in ≤ N days" filter. Applies the org-wide override
      // when set so the SQL horizon matches what the response will report.
      // Excludes:
      //   - accounts with DONT_EXPIRE_PASSWORD set (no expiry to begin with)
      //   - disabled accounts (a disabled account's expiry is moot)
      //   - already-expired passwords (those belong in their own "expired"
      //     view; "expiring in N days" should mean "upcoming within N days")
      const now = new Date();
      if (q.passwordExpiringInDays !== undefined) {
        const horizon = new Date(now.getTime() + q.passwordExpiringInDays * 24 * 60 * 60 * 1000);
        baseQuery = baseQuery
          .where('password_never_expires', '=', false)
          .where('enabled', '=', true);
        baseQuery = baseQuery
          .where(expiry, 'is not', null)
          .where(expiry, '>=', now)
          .where(expiry, '<=', horizon);
      }

      // "Stale logon" filter — account hasn't logged in for ≥ N days, or never.
      if (q.staleSinceDays !== undefined) {
        const cutoff = new Date(Date.now() - q.staleSinceDays * 24 * 60 * 60 * 1000);
        baseQuery = baseQuery.where((eb) =>
          eb.or([eb('last_logon_at', 'is', null), eb('last_logon_at', '<', cutoff)]),
        );
      }

      // OU filter. `includeSubOus` defaults to true — operators usually mean
      // "everything under Sales," not "exactly the Sales OU and nothing
      // deeper." When false, we constrain to entries whose parent OU equals
      // exactly the chosen DN (DN ends with `,<ou>`).
      if (q.ou) {
        const dn = q.ou.trim();
        if (dn) {
          const includeSub = q.includeSubOus !== false;
          if (includeSub) {
            // Substring match against the DN suffix. The cache index on
            // distinguished_name is exact — we accept the seq scan for now;
            // the OU filter is an interactive use, not a hot path.
            baseQuery = baseQuery.where('distinguished_name', 'ilike', `%,${dn}`);
          } else {
            // Exact parent OU only. The user's RDN is the leftmost segment;
            // its parent is the rest. Use a regex anchor to avoid matching
            // grandchildren.
            baseQuery = baseQuery.where(
              sql<string>`substring(distinguished_name from position(',' in distinguished_name) + 1)`,
              '=',
              dn,
            );
          }
        }
      }

      // Department filter — case-insensitive equality.
      if (q.department) {
        const dept = q.department.trim();
        if (dept) {
          baseQuery = baseQuery.where(
            sql<string>`lower(coalesce(department, ''))`,
            '=',
            dept.toLowerCase(),
          );
        }
      }

      // Manager filter — query is by manager objectGUID, cache stores
      // manager_dn. Resolve the manager's DN once and join on it.
      if (q.managerId) {
        const managerRow = await app.db
          .selectFrom('user_cache_records')
          .where('provider_id', '=', provider.id)
          .where('object_guid', '=', q.managerId)
          .where('deleted_at', 'is', null)
          .select('distinguished_name')
          .executeTakeFirst();
        if (managerRow) {
          baseQuery = baseQuery.where('manager_dn', '=', managerRow.distinguished_name);
        } else {
          // No such manager — return zero rows.
          baseQuery = baseQuery.where(sql<boolean>`false`);
        }
      }

      // Group membership filter. Multiple values = must be a member of every
      // listed group (AND). Implemented via repeated EXISTS subqueries so
      // the subquery's index on (group_object_guid, user_object_guid) is hot.
      if (q.inGroupId && q.inGroupId.length > 0) {
        for (const groupId of q.inGroupId) {
          baseQuery = baseQuery.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('user_group_memberships as m')
                .select('m.user_object_guid')
                .whereRef('m.user_object_guid', '=', 'user_cache_records.object_guid')
                .whereRef('m.provider_id', '=', 'user_cache_records.provider_id')
                .where('m.group_object_guid', '=', groupId),
            ),
          );
        }
      }

      // sort field → column mapping. Anything not in the map falls back to
      // display_name so an unknown sort value can never become an injection.
      const SORT_MAP: Record<string, string> = {
        displayName: 'display_name',
        samAccountName: 'sam_account_name',
        userPrincipalName: 'user_principal_name',
        email: 'email',
        department: 'department',
        title: 'title',
        lastLogonAt: 'last_logon_at',
        passwordExpiresAt: 'password_expires_at',
        accountExpiresAt: 'account_expires_at',
        modifiedAtSource: 'modified_at_source',
      };
      const orderDir = q.sortDir === 'desc' ? 'desc' : 'asc';

      // `status` is a derived sort: order by a priority CASE in the order
      // the SPA ranks what stops sign-in (design/lib/signIn.ts), so the list
      // and each user's badge agree. The literal numbers are
      // safe (no user input reaches the SQL), and the rest of the search
      // remains parameterized.
      let orderedQuery;
      if (q.sort === 'status') {
        orderedQuery = baseQuery.selectAll().orderBy(
          sql<number>`
              case
                when not enabled then 1
                when locked then 2
                when not password_never_expires and not password_must_change
                  and ${expiry} <= now() then 3
                when account_expires_at <= now() then 4
                when password_must_change then 5
                when not password_never_expires
                  and ${expiry} <= now() + interval '14 days' then 6
                else 7
              end
            `,
          orderDir,
        );
      } else {
        const orderColumn = SORT_MAP[q.sort] ?? 'display_name';
        orderedQuery = baseQuery
          .selectAll()
          .orderBy(orderColumn === 'password_expires_at' ? expiry : sql.ref(orderColumn), orderDir);
      }

      const [rows, totalRow] = await Promise.all([
        orderedQuery
          // Stable secondary sort so paginated results don't shuffle when many
          // rows share an empty sort key (e.g. department=null).
          .orderBy('id', 'asc')
          .limit(q.pageSize)
          .offset(offset)
          .execute(),
        baseQuery.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst(),
      ]);

      // Resolve which rows have a cached Entra photo so the SPA can
      // render <img> only for those — without this, every avatar in a
      // 50-row table fires a 404 photo request when no photo is cached
      // for that user. One small SELECT keyed by the page's guids, so
      // search latency is unchanged at scale.
      const photoGuids = await (async (): Promise<Set<string>> => {
        if (rows.length === 0) return new Set();
        const result = await app.db
          .selectFrom('user_photos')
          .select('object_guid')
          .where('provider_id', '=', provider.id)
          .where('absent', '=', false)
          .where(
            'object_guid',
            'in',
            rows.map((r) => r.object_guid),
          )
          .execute();
        return new Set(result.map((r) => r.object_guid));
      })();

      const result: UserSearchResponse = {
        freshness: await listFreshness(app.db, provider.id, 'users'),
        rows: rows.map((r) => ({
          ...cachedUserIdentity(r),
          locked: r.locked,
          passwordNeverExpires: r.password_never_expires,
          passwordMustChange: r.password_must_change,
          passwordExpiresAt: computeExpiresAt(
            r.password_never_expires,
            r.password_expires_at,
            r.password_expiry_computed,
            r.password_last_set_at,
            maxAgeDays,
          ),
          accountExpiresAt: dateOrNull(r.account_expires_at),
          lastLogonAt: dateOrNull(r.last_logon_at),
          modifiedAtSource: dateOrNull(r.modified_at_source),
          hasPhoto: photoGuids.has(r.object_guid),
        })),
        total: Number(totalRow?.total ?? 0),
        page: q.page,
        pageSize: q.pageSize,
      };

      await recordSearchAudit(app, req, provider.id, {
        query: q,
        returned: result.rows.length,
        total: result.total,
      });

      return userSearchResponseSchema.parse(result);
    },
  });

  // ---- POST /api/users/match -------------------------------------------
  // A read sent as POST: a list of 1,000 entries doesn't fit a query string.
  app.post('/api/users/match', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<UserMatchResponse> => {
      const body = userMatchRequestSchema.parse(req.body);
      const provider = await app.services.providers.buildForRequest(req);
      const lookups = lookupsFor(body.entries);
      if (lookups.length > MAX_USER_MATCH_LOOKUPS) {
        throw BadRequest('Too many entries. Match up to 1,000 at a time.');
      }

      // Postgres folds case for both the lookups and the cached values, so
      // the two always agree (JS and Postgres lowercase some letters
      // differently).
      const folded = new Map(
        lookups.length === 0
          ? []
          : (
              await sql<{ lookup: string; key: string }>`
                select lookup, lower(lookup) as key from unnest(${lookups}::text[]) as lookup
              `.execute(app.db)
            ).rows.map((r) => [r.lookup, r.key]),
      );
      const keys = [...new Set(folded.values())];
      const smtpKeys = keys.filter((k) => k.includes('@')).map((k) => `smtp:${k}`);
      const proxies = sql`raw_attributes_json -> 'proxyAddresses'`;
      const proxyList = sql`jsonb_array_elements_text(
        case jsonb_typeof(${proxies})
          when 'array' then ${proxies}
          when 'string' then jsonb_build_array(${proxies})
          else '[]'::jsonb
        end
      )`;

      const rows =
        keys.length === 0
          ? []
          : await app.db
              .selectFrom('user_cache_records')
              .where('provider_id', '=', provider.id)
              .where('deleted_at', 'is', null)
              .where((eb) =>
                eb.or([
                  inKeys('sam_account_name', keys),
                  inKeys('user_principal_name', keys),
                  inKeys('email', keys),
                  inKeys('display_name', keys),
                  ...(smtpKeys.length > 0
                    ? [
                        sql<boolean>`exists (
                          select 1 from ${proxyList} as p(address)
                          where lower(p.address) = any(${smtpKeys}::text[])
                        )`,
                      ]
                    : []),
                ]),
              )
              .selectAll()
              .select([
                sql<string[]>`array_remove(array[
                  lower(sam_account_name), lower(user_principal_name), lower(email)
                ], null) || array(
                  select lower(substr(p.address, 6)) from ${proxyList} as p(address)
                  where lower(p.address) like 'smtp:%'
                )`.as('identifier_keys'),
                sql<string | null>`lower(display_name)`.as('display_name_key'),
              ])
              .execute();

      const results = matchEntries(
        body.entries,
        rows.map((r) => ({
          ...cachedUserIdentity(r),
          distinguishedName: r.distinguished_name,
          identifierKeys: r.identifier_keys,
          displayNameKey: r.display_name_key,
        })),
        (lookup) => folded.get(lookup)!,
      );

      const count = (status: UserMatchResult['status']) =>
        results.filter((r) => r.status === status).length;
      await recordSearchAudit(app, req, provider.id, {
        pastedEntries: body.entries.length,
        matched: count('matched'),
        ambiguous: count('ambiguous'),
        unmatched: count('unmatched'),
        matchedUserIds: [
          ...new Set(results.flatMap((r) => (r.status === 'matched' ? [r.user.id] : []))),
        ],
      });

      return userMatchResponseSchema.parse({ results });
    },
  });

  // ---- GET /api/users/:id (live refresh from AD) ------------------------
  app.get('/api/users/:id', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<{ user: UserDetail }> => {
      const { id } = idParamSchema.parse(req.params);
      const provider = await app.services.providers.buildForRequest(req);
      const refreshed = await app.services.userLiveRefresh.refresh(provider, id);
      if (!refreshed) throw NotFound('user not found');

      // Read group memberships from cache (sync builds these).
      const memberships = await app.db
        .selectFrom('user_group_memberships')
        .innerJoin('group_cache_records as g', (join) =>
          join
            .onRef('g.provider_id', '=', 'user_group_memberships.provider_id')
            .onRef('g.object_guid', '=', 'user_group_memberships.group_object_guid'),
        )
        .where('user_group_memberships.provider_id', '=', provider.id)
        .where('user_group_memberships.user_object_guid', '=', id)
        .select([
          'g.object_guid as id',
          'g.name as name',
          'g.distinguished_name as distinguishedName',
          'user_group_memberships.direct as direct',
        ])
        .execute();

      const maxAgeDays = await resolveMaxPwdAgeDays(provider);

      // Lockout policy: only fetch when the user is locked. The vast
      // majority of detail loads skip it.
      const lockoutFiletime = refreshed.user.lockedAt;
      let lockout: ReturnType<typeof lockoutEnd> = {
        autoUnlockAt: null,
        lockedUntilUnlocked: false,
      };
      if (refreshed.user.locked && lockoutFiletime) {
        try {
          const duration = await lockoutDurationFor(refreshed.user.resultantPsoDn, {
            domain: async () => (await provider.getDomainPolicy()).lockoutDurationMs,
            pso: (dn) => provider.getPsoLockoutDuration(dn),
          });
          lockout = lockoutEnd(lockoutFiletime, duration);
        } catch (err) {
          req.log.warn({ err }, 'failed to load lockout policy for autoUnlockAt');
        }
      }

      const raw = refreshed.user.rawAttributes;
      const emailAliases = deriveEmailAliases(raw['proxyAddresses']);
      const directReports = await resolveDirectReports(
        app,
        provider.id,
        rawArrayValues(raw['directReports']),
      );
      const manager = await resolveManager(app, provider.id, refreshed.user.managerDn);

      // Pull Entra enrichment + photo presence in parallel. Both are
      // optional — null when the integration isn't configured for the
      // directory or the user hasn't been visited by the relevant runner
      // yet. The photo bytes themselves are streamed via a separate
      // endpoint; here we only surface a `hasPhoto` boolean.
      const [entraEnrichment, photoRow, integration] = await Promise.all([
        app.db
          .selectFrom('user_entra_enrichment')
          .select([
            'last_sign_in_at',
            'last_non_interactive_sign_in_at',
            'last_status',
            'is_mfa_registered',
            'is_mfa_capable',
            'is_passwordless_capable',
            'mfa_methods_json',
            'default_mfa_method',
            'mfa_fetched_at',
            'mfa_last_status',
          ])
          .where('provider_id', '=', provider.id)
          .where('object_guid', '=', refreshed.user.objectGuid)
          .executeTakeFirst(),
        app.db
          .selectFrom('user_photos')
          .select(['absent'])
          .where('provider_id', '=', provider.id)
          .where('object_guid', '=', refreshed.user.objectGuid)
          .executeTakeFirst(),
        app.services.entraIntegration.getByProviderId(provider.id),
      ]);

      const detail: UserDetail = {
        id: refreshed.user.objectGuid,
        samAccountName: refreshed.user.samAccountName ?? '',
        userPrincipalName: refreshed.user.userPrincipalName,
        displayName: refreshed.user.displayName,
        email: refreshed.user.email,
        department: refreshed.user.department,
        title: refreshed.user.title,
        enabled: refreshed.user.enabled,
        locked: refreshed.user.locked,
        lockedAt: dateOrNull(refreshed.user.lockedAt),
        autoUnlockAt: dateOrNull(lockout.autoUnlockAt),
        lockedUntilUnlocked: lockout.lockedUntilUnlocked,
        badPasswordCount: refreshed.user.badPasswordCount,
        passwordNeverExpires: refreshed.user.passwordNeverExpires,
        passwordMustChange: refreshed.user.passwordMustChange,
        passwordExpiresAt: computeExpiresAt(
          refreshed.user.passwordNeverExpires,
          refreshed.user.passwordExpiresAt,
          refreshed.user.passwordExpiryComputed ?? false,
          refreshed.user.passwordLastSetAt,
          maxAgeDays,
        ),
        accountExpiresAt: dateOrNull(refreshed.user.accountExpiresAt),
        lastLogonAt: dateOrNull(refreshed.user.lastLogonAt),
        modifiedAtSource: dateOrNull(refreshed.user.modifiedAtSource),
        hasPhoto: !!photoRow && !photoRow.absent,
        lastBadPasswordAt: dateOrNull(refreshed.user.lastBadPasswordAt),
        givenName: refreshed.user.givenName,
        surname: refreshed.user.surname,
        phone: refreshed.user.phone,
        mobile: refreshed.user.mobile,
        managerDn: refreshed.user.managerDn,
        manager,
        distinguishedName: refreshed.user.distinguishedName,
        passwordLastSetAt: dateOrNull(refreshed.user.passwordLastSetAt),
        isPrivileged: rawScalarValue(raw['adminCount']) === '1',
        employeeID: rawScalarValue(raw['employeeID']),
        employeeNumber: rawScalarValue(raw['employeeNumber']),
        ipPhone: rawScalarValue(raw['ipPhone']),
        homePhone: rawScalarValue(raw['homePhone']),
        homePostalAddress: rawScalarValue(raw['homePostalAddress']),
        streetAddress: rawScalarValue(raw['streetAddress']),
        description: rawScalarValue(raw['description']),
        company: rawScalarValue(raw['company']),
        c: rawScalarValue(raw['c']),
        co: rawScalarValue(raw['co']),
        l: rawScalarValue(raw['l']),
        st: rawScalarValue(raw['st']),
        postalCode: rawScalarValue(raw['postalCode']),
        cn: rawScalarValue(raw['cn']),
        physicalDeliveryOfficeName: refreshed.user.office ?? null,
        postOfficeBox: rawScalarValue(raw['postOfficeBox']),
        profilePath: rawScalarValue(raw['profilePath']),
        scriptPath: rawScalarValue(raw['scriptPath']),
        homeDirectory: rawScalarValue(raw['homeDirectory']),
        pager: rawScalarValue(raw['pager']),
        facsimileTelephoneNumber: rawScalarValue(raw['facsimileTelephoneNumber']),
        info: rawScalarValue(raw['info']),
        primarySmtpAddress: primarySmtpAddress(raw['proxyAddresses']),
        otherMailbox: rawArrayValues(raw['otherMailbox']),
        otherHomePhone: rawArrayValues(raw['otherHomePhone']),
        otherMobile: rawArrayValues(raw['otherMobile']),
        emailAliases,
        directReports,
        groupMemberships: memberships.map((m) => ({
          id: m.id,
          name: m.name ?? '',
          distinguishedName: m.distinguishedName,
          direct: m.direct,
        })),
        freshness: {
          cachedAt: refreshed.cachedAt ? refreshed.cachedAt.toISOString() : null,
          liveRefreshedAt: refreshed.liveRefreshedAt.toISOString(),
          isStale: refreshed.isStale,
        },
        // entra is null when no integration is configured / enabled for
        // this directory — the UI uses null to skip rendering the field.
        // Photo presence lives on `hasPhoto` at the top level so the
        // search-list response can carry it too.
        entra:
          integration && integration.enabled
            ? {
                lastSignInAt: dateOrNull(
                  entraEnrichment?.last_sign_in_at
                    ? new Date(entraEnrichment.last_sign_in_at)
                    : null,
                ),
                lastNonInteractiveSignInAt: dateOrNull(
                  entraEnrichment?.last_non_interactive_sign_in_at
                    ? new Date(entraEnrichment.last_non_interactive_sign_in_at)
                    : null,
                ),
                lastStatus: parseEnrichmentStatus(entraEnrichment?.last_status),
                // MFA block. Null when the runner has never visited this
                // user — distinct from "user has no MFA" (mfa.isRegistered
                // === false) so the UI can show "not yet fetched" copy
                // instead of incorrectly claiming the user has nothing.
                mfa:
                  entraEnrichment?.mfa_fetched_at !== null &&
                  entraEnrichment?.mfa_fetched_at !== undefined
                    ? {
                        isRegistered: entraEnrichment.is_mfa_registered ?? null,
                        isCapable: entraEnrichment.is_mfa_capable ?? null,
                        isPasswordlessCapable: entraEnrichment.is_passwordless_capable ?? null,
                        methods: parseMfaMethods(entraEnrichment.mfa_methods_json),
                        defaultMethod: entraEnrichment.default_mfa_method ?? null,
                        fetchedAt: dateOrNull(
                          entraEnrichment.mfa_fetched_at
                            ? new Date(entraEnrichment.mfa_fetched_at)
                            : null,
                        ),
                        status: parseEnrichmentStatus(entraEnrichment.mfa_last_status),
                      }
                    : null,
              }
            : null,
        rawAttributes: rawAttributesFor(
          req.actor?.session.capabilities,
          refreshed.user.rawAttributes,
        ),
      };

      await recordUserView(app, req, provider.id, {
        id: detail.id,
        distinguishedName: detail.distinguishedName,
      });

      return { user: userDetailSchema.parse(detail) };
    },
  });

  // ---- PATCH /api/users/:id (write-as-user attribute update) -----------
  app.patch('/api/users/:id', {
    config: { policy: { capability: 'write:user.attributes', stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = userUpdateRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }
      const provider = await app.services.providers.buildForRequest(req);

      // Pre-write live refresh — fails closed if AD is unreachable.
      const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
      if (!beforeRefresh) throw NotFound('user not found');

      const result = await writeUserAttributes(
        app.services,
        provider,
        beforeRefresh.user,
        body.patch,
        ctx(actor, req),
        auditContextFromRequest(req),
      ).catch((err: unknown) => {
        if (err instanceof UserAttributeRefusal)
          throw app.httpErrors.unprocessableEntity(err.message);
        throw err;
      });

      if (!result.ok) {
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden('directory rejected the change');
        }
        throw app.httpErrors.badGateway(`update failed: ${result.errorCode ?? 'unknown'}`);
      }

      return {
        ok: true,
        before: result.before,
        after: result.after,
      };
    },
  });

  // ---- POST /api/users/:id/unlock --------------------------------------
  app.post('/api/users/:id/unlock', {
    config: { policy: { capability: 'write:user.unlock', stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const actor = req.actor!;
      if (!actor.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }
      const provider = await app.services.providers.buildForRequest(req);

      const written = await writeUserAccount(
        app.services,
        provider,
        UNLOCK_USER,
        id,
        ctx(actor, req),
        auditContextFromRequest(req),
      );
      if (!written) throw NotFound('user not found');
      const { result } = written;
      if (!result.ok) {
        throw app.httpErrors.badGateway(`unlock failed: ${result.errorCode ?? 'unknown'}`);
      }
      return { ok: true, before: result.before, after: result.after };
    },
  });

  // ---- POST /api/users/:id/disable + /enable ---------------------------
  // Both routes share the same write-as-user shape as unlock. Implementation
  // delegated to a small helper to avoid copy/paste.
  app.post('/api/users/:id/disable', {
    config: {
      policy: { capability: 'write:user.enableDisable', stepUp: true, directory: 'caller' },
    },
    handler: async (req) => toggleEnabled(req, app, true),
  });

  app.post('/api/users/:id/enable', {
    config: {
      policy: { capability: 'write:user.enableDisable', stepUp: true, directory: 'caller' },
    },
    handler: async (req) => toggleEnabled(req, app, false),
  });

  // ---- POST /api/users/:id/account-expiry ------------------------------
  // Expiry decides whether the account works, as enabling does: AD keeps
  // accountExpires and userAccountControl in the same property set
  // (Account Restrictions), so it takes the same capability.
  app.post('/api/users/:id/account-expiry', {
    config: {
      policy: { capability: 'write:user.enableDisable', stepUp: true, directory: 'caller' },
    },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = accountExpiryRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const written = await writeUserAccount(
        app.services,
        provider,
        expireAccountAt(body.expiresAt === null ? null : new Date(body.expiresAt)),
        id,
        ctx(actor, req),
        auditContextFromRequest(req),
      );
      if (!written) throw NotFound('user not found');
      const { result } = written;
      if (!result.ok) {
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden('directory rejected the change');
        }
        throw app.httpErrors.badGateway(
          `setting account expiry failed: ${result.errorCode ?? 'unknown'}`,
        );
      }
      return { ok: true, before: result.before, after: result.after };
    },
  });

  // ---- POST /api/users/:id/reset-password ------------------------------
  app.post('/api/users/:id/reset-password', {
    config: {
      policy: { capability: 'write:user.resetPassword', stepUp: true, directory: 'caller' },
    },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = resetPasswordRequestSchema.parse(req.body);
      if (body.unlock) await app.requireCapability(req, 'write:user.unlock');
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
      if (!beforeRefresh) throw NotFound('user not found');

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.password.reset',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: beforeRefresh.user.objectGuid,
          targetDn: beforeRefresh.user.distinguishedName,
          metadata: { forceChangeAtNextLogin: body.forceChangeAtNextLogin, unlock: body.unlock },
        },
        async () => {
          const r = await provider.resetPassword(
            { kind: 'objectGuid', value: id },
            {
              newPassword: body.newPassword,
              forceChangeAtNextLogin: body.forceChangeAtNextLogin,
              unlock: body.unlock,
            },
            ctx(actor, req),
          );
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
          };
        },
      );

      if (!result.ok) {
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden('directory rejected the change');
        }
        if (result.errorCode === 'policy_violation') {
          throw app.httpErrors.badRequest(
            'directory rejected the password (policy: complexity, length, history, etc.)',
          );
        }
        throw app.httpErrors.badGateway(`reset failed: ${result.errorCode ?? 'unknown'}`);
      }

      await app.services.userLiveRefresh.refresh(provider, id);
      return { ok: true };
    },
  });

  // ---- POST /api/users/:id/groups (add) + DELETE (remove) --------------
  // Body: { groupId }. The same change as /api/groups/:id/groups, for a
  // user.
  app.post('/api/users/:id/groups', {
    config: { policy: { capability: 'write:group.membership', stepUp: true, directory: 'caller' } },
    handler: async (req) => changeMembership(app, req, 'user', 'add'),
  });

  app.delete('/api/users/:id/groups', {
    config: { policy: { capability: 'write:group.membership', stepUp: true, directory: 'caller' } },
    handler: async (req) => changeMembership(app, req, 'user', 'remove'),
  });

  // ---- POST /api/users/bulk-groups/preview ------------------------------
  // What adding the selected users to groups, or removing them, would
  // change, from the cache, before the job starts. A read sent as POST:
  // 10,000 ids don't fit a query string.
  app.post('/api/users/bulk-groups/preview', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<BulkGroupMembershipPreview> => {
      const body = bulkGroupMembershipPreviewRequestSchema.parse(req.body);
      const preview = await previewGroupMembership(
        app.db,
        req.directoryId!,
        body,
        await app.services.authorization.roleGroups(),
      );
      if (!preview) throw NotFound('group not found');
      return bulkGroupMembershipPreviewSchema.parse(preview);
    },
  });

  // ---- POST /api/users/bulk-update/preview ------------------------------
  // What editing the selected users' attributes would change, and each
  // field's values across them, from the cache, before the job starts.
  app.post('/api/users/bulk-update/preview', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<BulkUserAttributesPreview> => {
      const body = bulkUserAttributesPreviewRequestSchema.parse(req.body);
      const preview = await previewAttributes(app.db, req.directoryId!, body).catch(
        refuseBulkRequest,
      );
      return bulkUserAttributesPreviewSchema.parse(preview);
    },
  });

  // ---- POST /api/users/bulk-account/preview -----------------------------
  // What moving the selected users, setting when their accounts expire,
  // making them change their password or clearing "password never
  // expires" would change, from the cache, before the job starts.
  app.post('/api/users/bulk-account/preview', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<BulkAccountPreview> => {
      const body = bulkAccountPreviewRequestSchema.parse(req.body);
      const preview = await previewAccountChange(app.db, req.directoryId!, body).catch(
        refuseBulkRequest,
      );
      return bulkAccountPreviewSchema.parse(preview);
    },
  });

  // ---- POST /api/users/:id/move (modifyDN to a new parent OU) ----------
  // Body: { targetOuDn }. The server validates that the OU exists for this
  // provider in the cache before issuing the modify; the AD provider then
  // re-checks via its own bind. Idempotent — a user already under the
  // requested OU isn't written, and the no-op is audited as `unchanged`.
  app.post('/api/users/:id/move', {
    config: { policy: { capability: 'write:user.move', stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = moveRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      // The AD bind would refuse an OU the sync hasn't seen too, but failing
      // here first gives a cleaner 400; a missing user is still a 404.
      const targetOu = await findCachedOu(app.db, provider.id, body.targetOuDn);
      if (!targetOu) {
        if (!(await app.services.userLiveRefresh.refresh(provider, id))) {
          throw NotFound('user not found');
        }
        throw app.httpErrors.badRequest('target OU not found in directory cache');
      }
      const refused = userMoveRefusal(targetOu);
      if (refused) {
        throw new AppError({ statusCode: 422, code: 'unprocessable_entity', message: refused });
      }

      const move = moveUserTo(targetOu);
      const written = await writeUserAccount(
        app.services,
        provider,
        move,
        id,
        ctx(actor, req),
        auditContextFromRequest(req),
      );
      if (!written) throw NotFound('user not found');
      const { result, user } = written;
      if (!result.ok) {
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden('directory rejected the move');
        }
        if (result.errorCode === 'conflict') {
          throw Conflict(move.refused('conflict', user) ?? 'the name is taken in that OU');
        }
        if (result.errorCode === 'not_found') {
          throw app.httpErrors.notFound('user not found in directory');
        }
        throw app.httpErrors.badGateway(`move failed: ${result.errorCode ?? 'unknown'}`);
      }
      return { ok: true, before: result.before, after: result.after };
    },
  });

  // ---- POST /api/users/:id/rename --------------------------------------
  // Name parts, RDN, logon names and primary email in one operation. Body
  // carries only the fields that change; see userRenameRequestSchema.
  app.post('/api/users/:id/rename', {
    config: { policy: { capability: 'write:user.rename', stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = userRenameRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
      if (!beforeRefresh) throw NotFound('user not found');

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.rename',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: beforeRefresh.user.objectGuid,
          targetDn: beforeRefresh.user.distinguishedName,
          metadata: {
            fields: Object.keys(body).filter((k) => k !== 'keepOldEmailAsAlias'),
            keepOldEmailAsAlias: body.keepOldEmailAsAlias,
          },
        },
        async () => {
          const r = await provider.renameUser(
            { kind: 'objectGuid', value: id },
            body,
            ctx(actor, req),
          );
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
            errorMessage: r.errorMessage ?? null,
          };
        },
      );

      if (!result.ok) {
        const detail = result.errorMessage ? `: ${result.errorMessage}` : '';
        if (result.errorCode === 'conflict') {
          throw app.httpErrors.conflict(result.errorMessage ?? 'name already in use');
        }
        if (result.errorCode === 'permission_denied') {
          throw app.httpErrors.forbidden(`directory rejected the rename${detail}`);
        }
        if (result.errorCode === 'not_found') throw NotFound('user not found');
        throw app.httpErrors.badGateway(`rename failed${detail}`);
      }

      await app.services.userLiveRefresh.refresh(provider, id);
      return { ok: true, before: result.before, after: result.after };
    },
  });

  // ---- POST /api/users/delete-preflight --------------------------------
  // What the delete dialog shows before the operator confirms: which of the
  // selected accounts can be deleted, why the rest can't, and whether the
  // Recycle Bin will let them be restored. Reads the cache; the delete
  // itself re-checks the live entry.
  app.post('/api/users/delete-preflight', {
    config: { policy: { capability: 'write:user.delete', stepUp: true, directory: 'caller' } },
    handler: async (req): Promise<UserDeletePreflightResponse> => {
      const body = userDeletePreflightRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const rows = await app.db
        .selectFrom('user_cache_records')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .where('object_guid', 'in', body.ids)
        .select([
          'object_guid',
          'sam_account_name',
          'display_name',
          'distinguished_name',
          'enabled',
          'sid',
          'raw_attributes_json',
        ])
        .execute();
      const byId = new Map(rows.map((r) => [r.object_guid, r]));

      // Recycle Bin state needs the operator's bind (Optional Features is
      // usually unreadable to a minimal service account). Not knowing it
      // shouldn't block a delete, so anything but a dead step-up session
      // degrades to null.
      let recycleBin: RecycleBinStatus | null = null;
      try {
        recycleBin = await provider.getRecycleBinStatus(ctx(actor, req));
      } catch (err) {
        if (err instanceof StepUpBindFailedError) {
          throw StepUpRequired('password_rejected');
        }
        req.log.warn({ err }, 'recycle bin status unavailable for delete preflight');
      }

      // What a tree delete would take with it. Read on the operator's bind,
      // like the delete itself; unreadable counts come back null.
      let childCounts = new Map<string, number | null>();
      try {
        childCounts = await provider.countChildObjects(
          rows.map((r) => r.distinguished_name),
          ctx(actor, req),
        );
      } catch (err) {
        if (err instanceof StepUpBindFailedError) {
          throw StepUpRequired('password_rejected');
        }
        req.log.warn({ err }, 'child object count unavailable for delete preflight');
      }

      return {
        recycleBin,
        users: body.ids.map((id) => {
          const row = byId.get(id);
          if (!row) {
            return {
              id,
              samAccountName: null,
              displayName: null,
              distinguishedName: null,
              enabled: null,
              privileged: false,
              childObjects: null,
              blockedReason: 'not_found' as const,
            };
          }
          const raw = row.raw_attributes_json ?? {};
          return {
            id,
            samAccountName: row.sam_account_name,
            displayName: row.display_name,
            distinguishedName: row.distinguished_name,
            enabled: row.enabled,
            privileged: rawScalarValue(raw['adminCount']) === '1',
            childObjects: childCounts.get(row.distinguished_name) ?? null,
            blockedReason: userDeleteBlockReason({
              enabled: row.enabled,
              sid: row.sid,
              rawAttributes: raw,
            }),
          };
        }),
      };
    },
  });

  // ---- DELETE /api/users/:id -------------------------------------------
  // Disabled accounts only. Body: { confirmSamAccountName }.
  app.delete('/api/users/:id', {
    config: { policy: { capability: 'write:user.delete', stepUp: true, directory: 'caller' } },
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = userDeleteRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
      if (!beforeRefresh) throw NotFound('user not found');
      const live = beforeRefresh.user;
      if (
        !live.samAccountName ||
        live.samAccountName.toLowerCase() !== body.confirmSamAccountName.trim().toLowerCase()
      ) {
        throw app.httpErrors.badRequest('confirmation does not match the account’s logon name');
      }
      // Refuse before writing an audit row: nothing was attempted. The
      // provider repeats this check on its own read right before the delete.
      const blocked = userDeleteBlockReason(live);
      if (blocked) throw app.httpErrors.conflict(`cannot delete: ${describeDeleteBlock(blocked)}`);

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.delete',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: live.objectGuid,
          targetDn: live.distinguishedName,
          metadata: {
            samAccountName: live.samAccountName,
            allowTreeDelete: body.allowTreeDelete === true,
          },
        },
        async () => {
          const r = await provider.deleteUser({ kind: 'objectGuid', value: id }, ctx(actor, req), {
            allowTreeDelete: body.allowTreeDelete === true,
          });
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
            errorMessage: r.errorMessage ?? null,
            treeDelete: r.treeDelete ?? false,
          };
        },
      );

      if (!result.ok) {
        throw directoryRefusal(app, result, {
          verb: 'delete',
          notFound: 'user not found',
          forbidden:
            'directory refused the delete — you may lack the Delete right, or the account is protected from accidental deletion',
        });
      }

      // Drop the account from list views now rather than at the next full
      // sync. A restore upserts the row, which clears deleted_at again.
      await app.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('user_cache_records')
          .set({ deleted_at: new Date().toISOString() })
          .where('provider_id', '=', provider.id)
          .where('object_guid', '=', live.objectGuid)
          .execute();
        await trx
          .deleteFrom('user_group_memberships')
          .where('provider_id', '=', provider.id)
          .where('user_object_guid', '=', live.objectGuid)
          .execute();
      });

      return { ok: true, treeDelete: result.treeDelete };
    },
  });
}

// ---- shared write helpers --------------------------------------------------

async function toggleEnabled(
  req: import('fastify').FastifyRequest,
  app: import('fastify').FastifyInstance,
  disable: boolean,
): Promise<{ ok: true; before: unknown; after: unknown }> {
  const { id } = idParamSchema.parse(req.params);
  const actor = req.actor!;
  if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
  const provider = await app.services.providers.buildForRequest(req);

  const written = await writeUserAccount(
    app.services,
    provider,
    disable ? DISABLE_USER : ENABLE_USER,
    id,
    ctx(actor, req),
    auditContextFromRequest(req),
  );
  if (!written) throw NotFound('user not found');
  const { result } = written;
  if (!result.ok) {
    if (result.errorCode === 'permission_denied') {
      throw app.httpErrors.forbidden('directory rejected the change');
    }
    throw app.httpErrors.badGateway(
      `${disable ? 'disable' : 'enable'} failed: ${result.errorCode ?? 'unknown'}`,
    );
  }
  return { ok: true, before: result.before, after: result.after };
}

// Splitting comma lists server-side can turn 1,000 entries into more
// lookups; this bounds the query's key array.
const MAX_USER_MATCH_LOOKUPS = 5_000;

/** `lower(column)` is one of `keys` (already lowercased by Postgres). */
function inKeys(column: string, keys: string[]): RawBuilder<boolean> {
  return sql<boolean>`lower(${sql.ref(column)}) = any(${keys}::text[])`;
}

/** The fields every user listing shares, from a cache row. */
function cachedUserIdentity(r: Selectable<UserCacheRecordsTable>) {
  return {
    id: r.object_guid,
    samAccountName: r.sam_account_name ?? '',
    userPrincipalName: r.user_principal_name,
    displayName: r.display_name,
    email: r.email,
    department: r.department,
    title: r.title,
    enabled: r.enabled,
  };
}

/** Records a user search when the `audit.search_enabled` setting is on. */
async function recordSearchAudit(
  app: FastifyInstance,
  req: FastifyRequest,
  providerId: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!(await app.services.settings.get<boolean>('audit.search_enabled', false))) return;
  await app.services.audit
    .recordEvent({
      ...auditContextFromRequest(req),
      action: 'user.search',
      result: 'success',
      actorAuthMethod: 'ad-password',
      providerId,
      targetType: 'user',
      metadata,
    })
    .catch((err) => req.log.error({ err }, 'audit insert failed for user.search'));
}

function dateOrNull(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseEnrichmentStatus(
  v: string | null | undefined,
): 'success' | 'p1_required' | 'forbidden' | 'not_found' | null {
  if (v === 'success' || v === 'p1_required' || v === 'forbidden' || v === 'not_found') {
    return v;
  }
  return null;
}

function parseMfaMethods(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((m): m is string => typeof m === 'string');
  }
  return [];
}

/**
 * Resolve the password-expires timestamp the API exposes to the UI.
 *
 * Precedence:
 *   1. DONT_EXPIRE_PASSWORD set → null (account never expires).
 *   2. AD's domain `maxPwdAge` is readable AND passwordLastSetAt is known →
 *      passwordLastSetAt + N days.
 *   3. Otherwise → null.
 *
 * `maxAgeDays` is supplied by the caller via `resolveMaxPwdAgeDays(provider)`
 * so the domain-policy lookup happens once per request rather than per row.
 */
/**
 * Compute email aliases from the proxyAddresses attribute.
 *
 * AD stores proxyAddresses as a multi-valued attribute with prefixes:
 *   - `SMTP:user@example.com` (uppercase) — the primary, mirrored to `mail`
 *   - `smtp:alias@example.com` (lowercase) — additional aliases
 *   - `X400:` / `sip:` / etc — other address types we ignore here
 *
 * Beyond the prefix filter, we also drop M365 system aliases ending in
 * `*.onmicrosoft.com` (and the routing variant `*.mail.onmicrosoft.com`)
 * — those are tenant-internal addresses the operator can't act on.
 */
/** The primary (`SMTP:`) proxy address, prefix stripped, or null. */
function primarySmtpAddress(v: unknown): string | null {
  const primary = rawArrayValues(v).find((entry) => entry.startsWith('SMTP:'));
  return primary ? primary.slice(5) : null;
}

function deriveEmailAliases(v: unknown): string[] {
  return rawArrayValues(v)
    .filter((entry) => !entry.startsWith('SMTP:'))
    .filter((entry) => entry.toLowerCase().startsWith('smtp:'))
    .map((entry) => entry.slice(5))
    .filter((addr) => !addr.toLowerCase().endsWith('.onmicrosoft.com'));
}

/**
 * Resolve directReports DNs against user_cache_records. Anything not in the
 * cache is returned with a null id so the UI can render the DN without a
 * link rather than silently dropping the entry.
 */
async function resolveDirectReports(
  app: import('fastify').FastifyInstance,
  providerId: number,
  dns: string[],
): Promise<{ id: string | null; distinguishedName: string; displayName: string | null }[]> {
  if (dns.length === 0) return [];
  const dnsLower = dns.map((d) => d.toLowerCase());
  const rows = await app.db
    .selectFrom('user_cache_records')
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<string>`lower(distinguished_name)`, 'in', dnsLower)
    .select(['object_guid', 'distinguished_name', 'display_name', 'sam_account_name'])
    .execute();
  const byDn = new Map<string, { id: string; displayName: string | null }>();
  for (const r of rows) {
    byDn.set(r.distinguished_name.toLowerCase(), {
      id: r.object_guid,
      displayName: r.display_name ?? r.sam_account_name ?? null,
    });
  }
  return dns.map((dn) => {
    const hit = byDn.get(dn.toLowerCase());
    return {
      id: hit?.id ?? null,
      distinguishedName: dn,
      displayName: hit?.displayName ?? null,
    };
  });
}

/**
 * Resolve a single manager DN against user_cache_records. Returns null when
 * the user has no manager set; otherwise returns an entry whose `id` is null
 * if the referenced manager is not in the cache (UI renders the DN without
 * a link).
 */
async function resolveManager(
  app: import('fastify').FastifyInstance,
  providerId: number,
  dn: string | null,
): Promise<{ id: string | null; distinguishedName: string; displayName: string | null } | null> {
  if (!dn) return null;
  const row = await findCachedUser(app.db, providerId, { dn });
  return {
    id: row?.object_guid ?? null,
    distinguishedName: dn,
    displayName: row?.display_name ?? row?.sam_account_name ?? null,
  };
}

function computeExpiresAt(
  passwordNeverExpires: boolean,
  cachedExpiresAt: Date | string | null,
  expiryComputed: boolean,
  passwordLastSetAt: Date | string | null,
  maxAgeDays: number | null,
): string | null {
  if (passwordNeverExpires) return null;
  // AD's own computation (stored by sync) respects fine-grained policies,
  // including ones that never expire (null).
  if (expiryComputed || cachedExpiresAt) return dateOrNull(cachedExpiresAt);
  // Rows synced before it was stored: derive from the domain policy.
  if (maxAgeDays && maxAgeDays > 0 && passwordLastSetAt) {
    const last =
      passwordLastSetAt instanceof Date ? passwordLastSetAt : new Date(passwordLastSetAt);
    if (Number.isNaN(last.getTime())) return dateOrNull(cachedExpiresAt);
    return new Date(last.getTime() + maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  }
  return dateOrNull(cachedExpiresAt);
}

/**
 * Resolve the effective password rotation age in days from the AD domain
 * policy. Returns null when the policy is unreadable, missing, or set to
 * "never expire" (maxPwdAge = 0) — in any of those cases per-user expiry
 * stays null and the UI shows "—" for the column.
 *
 * The provider caches the underlying domain policy for 5 minutes, so the
 * three call sites in this file (search, export, detail) hit the cache for
 * the typical concurrent request burst rather than re-querying the DC.
 *
 * Only a fallback now: sync stores AD's computed expiry, which already
 * accounts for fine-grained password policies (PSOs).
 */
/**
 * SQL for a user's password expiry, the same rule as computeExpiresAt: the
 * value AD computed (stored by sync; null when a fine-grained policy never
 * expires), or for rows synced before that was stored, pwdLastSet + the
 * domain's maximum age.
 */
function effectiveExpirySql(maxAgeDays: number | null) {
  return maxAgeDays && maxAgeDays > 0
    ? sql<Date | null>`case when password_expiry_computed then password_expires_at else coalesce(password_expires_at, password_last_set_at + (${maxAgeDays}::int * interval '1 day')) end`
    : sql<Date | null>`password_expires_at`;
}

async function resolveMaxPwdAgeDays(provider: DirectoryProvider): Promise<number | null> {
  try {
    const policy = await provider.getDomainPolicy();
    if (!policy.maxPwdAgeMs || policy.maxPwdAgeMs <= 0) return null;
    return Math.max(1, Math.round(policy.maxPwdAgeMs / 86_400_000));
  } catch {
    return null;
  }
}
