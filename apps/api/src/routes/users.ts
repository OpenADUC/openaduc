// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  groupMembershipChangeSchema,
  resetPasswordRequestSchema,
  userDetailSchema,
  userMoveRequestSchema,
  userSearchQuerySchema,
  userSearchResponseSchema,
  userUpdateRequestSchema,
  type UserDetail,
  type UserSearchResponse,
} from '@openaduc/shared';
import { z } from 'zod';
import { NotFound, Unauthorized } from '../plugins/errorHandler.js';
import type { DirectoryProvider } from '../providers/types.js';
import { auditContextFromRequest, withAudit } from '../services/auditContext.js';

const idParamSchema = z.object({ id: z.string().uuid() });

// ---- CSV helpers --------------------------------------------------------
//
// Minimal RFC 4180 quoting: wrap in double quotes when the value contains
// quote, comma, or newline; double up internal quotes. Null/undefined render
// empty.
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

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
    preHandler: app.requireCapability('export:user'),
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
    preHandler: app.requireCapability('read:user'),
    handler: async (req): Promise<UserSearchResponse> => {
      const q = userSearchQuerySchema.parse(req.query);
      const provider = await app.services.providers.buildForRequest(req);
      const offset = (q.page - 1) * q.pageSize;

      // Effective rotation age comes from AD's domain `maxPwdAge`. The
      // expiring-soon SQL filter and the user response both consume this
      // value so the page count and per-row date stay in sync.
      const maxAgeDays = await resolveMaxPwdAgeDays(provider);

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
            // Password expiring or expired (excluding never-expires accounts).
            eb.and([
              eb('password_never_expires', '=', false),
              maxAgeDays && maxAgeDays > 0
                ? eb.and([
                    eb('password_last_set_at', 'is not', null),
                    eb(
                      sql<Date>`password_last_set_at + (${maxAgeDays}::int * interval '1 day')`,
                      '<=',
                      horizon,
                    ),
                  ])
                : eb.and([
                    eb('password_expires_at', 'is not', null),
                    eb('password_expires_at', '<=', horizon),
                  ]),
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
        if (maxAgeDays && maxAgeDays > 0) {
          // computed expiry = password_last_set_at + maxAgeDays
          const expiryExpr = sql<Date>`password_last_set_at + (${maxAgeDays}::int * interval '1 day')`;
          baseQuery = baseQuery
            .where('password_last_set_at', 'is not', null)
            .where(expiryExpr, '>=', now)
            .where(expiryExpr, '<=', horizon);
        } else {
          baseQuery = baseQuery
            .where('password_expires_at', 'is not', null)
            .where('password_expires_at', '>=', now)
            .where('password_expires_at', '<=', horizon);
        }
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

      // `status` is a derived sort: order by a priority CASE so locked
      // accounts come first, disabled second, etc. The literal numbers are
      // safe (no user input reaches the SQL), and the rest of the search
      // remains parameterized.
      let orderedQuery;
      if (q.sort === 'status') {
        orderedQuery = baseQuery.selectAll().orderBy(
          sql<number>`
              case
                when locked then 1
                when not enabled then 2
                when account_expires_at is not null and account_expires_at < now() then 3
                when password_never_expires then 6
                when password_expires_at is not null and password_expires_at < now() then 4
                when password_expires_at is not null and password_expires_at < now() + interval '14 days' then 5
                else 7
              end
            `,
          orderDir,
        );
      } else {
        const orderColumn = SORT_MAP[q.sort] ?? 'display_name';
        orderedQuery = baseQuery.selectAll().orderBy(sql.ref(orderColumn), orderDir);
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
        rows: rows.map((r) => ({
          id: r.object_guid,
          samAccountName: r.sam_account_name ?? '',
          userPrincipalName: r.user_principal_name,
          displayName: r.display_name,
          email: r.email,
          department: r.department,
          title: r.title,
          enabled: r.enabled,
          locked: r.locked,
          passwordNeverExpires: r.password_never_expires,
          passwordExpiresAt: computeExpiresAt(
            r.password_never_expires,
            r.password_expires_at,
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

      // Optional search auditing.
      if (await app.services.settings.get<boolean>('audit.search_enabled', false)) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: 'user.search',
            result: 'success',
            actorAuthMethod: 'ad-password',
            providerId: provider.id,
            targetType: 'user',
            metadata: { query: q, returned: result.rows.length, total: result.total },
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for user.search'));
      }

      return userSearchResponseSchema.parse(result);
    },
  });

  // ---- GET /api/users/:id (live refresh from AD) ------------------------
  app.get('/api/users/:id', {
    preHandler: app.requireCapability('read:user'),
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

      // Lockout policy: only fetch when there's a chance the user is or was
      // locked. The vast majority of detail loads return early with a null
      // policy fetch.
      const lockoutFiletime = refreshed.user.lockedAt;
      let autoUnlockAt: Date | null = null;
      if (refreshed.user.locked && lockoutFiletime) {
        try {
          const policy = await provider.getDomainPolicy();
          if (policy.lockoutDurationMs && policy.lockoutDurationMs > 0) {
            autoUnlockAt = new Date(lockoutFiletime.getTime() + policy.lockoutDurationMs);
          }
        } catch (err) {
          req.log.warn({ err }, 'failed to load domain policy for autoUnlockAt');
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
        autoUnlockAt: dateOrNull(autoUnlockAt),
        passwordNeverExpires: refreshed.user.passwordNeverExpires,
        passwordExpiresAt: computeExpiresAt(
          refreshed.user.passwordNeverExpires,
          refreshed.user.passwordExpiresAt,
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
        description: rawScalarValue(raw['description']),
        company: rawScalarValue(raw['company']),
        c: rawScalarValue(raw['c']),
        co: rawScalarValue(raw['co']),
        l: rawScalarValue(raw['l']),
        st: rawScalarValue(raw['st']),
        postalCode: rawScalarValue(raw['postalCode']),
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
        rawAttributes: refreshed.user.rawAttributes,
      };

      // Account view audit (configurable). Deduped per session+target on a
      // short window so reloads — including the post-write refresh — don't
      // pile up additional `user.view` rows next to the action they
      // followed. The first view per session per user still records.
      if (
        (await app.services.settings.get<boolean>('audit.account_view_enabled', true)) &&
        app.services.audit.shouldRecordView(req.actor?.session.id ?? null, 'user', detail.id)
      ) {
        await app.services.audit
          .recordEvent({
            ...auditContextFromRequest(req),
            action: 'user.view',
            result: 'success',
            actorAuthMethod: 'ad-password',
            providerId: provider.id,
            targetType: 'user',
            targetId: detail.id,
            targetDn: detail.distinguishedName,
          })
          .catch((err) => req.log.error({ err }, 'audit insert failed for user.view'));
      }

      return { user: userDetailSchema.parse(detail) };
    },
  });

  // ---- PATCH /api/users/:id (write-as-user attribute update) -----------
  app.patch('/api/users/:id', {
    preHandler: [app.requireCapability('write:user.attributes'), app.requireStepUp],
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

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.update',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: beforeRefresh.user.objectGuid,
          targetDn: beforeRefresh.user.distinguishedName,
          metadata: { fields: Object.keys(body.patch) },
        },
        async () => {
          const r = await provider.updateUserAttributes(
            { kind: 'objectGuid', value: id },
            body.patch,
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
        throw app.httpErrors.badGateway(`update failed: ${result.errorCode ?? 'unknown'}`);
      }

      // Refresh cache so subsequent reads show the new values.
      await app.services.userLiveRefresh.refresh(provider, id);

      return {
        ok: true,
        before: result.before,
        after: result.after,
      };
    },
  });

  // ---- POST /api/users/:id/unlock --------------------------------------
  app.post('/api/users/:id/unlock', {
    preHandler: [app.requireCapability('write:user.unlock'), app.requireStepUp],
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const actor = req.actor!;
      if (!actor.session.actorUsername) {
        throw Unauthorized('session has no bind identity');
      }
      const provider = await app.services.providers.buildForRequest(req);

      // Pre-write live refresh — fails closed if the directory is unreachable.
      const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
      if (!beforeRefresh) throw NotFound('user not found');

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.unlock',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: beforeRefresh.user.objectGuid,
          targetDn: beforeRefresh.user.distinguishedName,
        },
        async () => {
          const r = await provider.unlockUser({ kind: 'objectGuid', value: id }, ctx(actor, req));
          return {
            ok: r.ok,
            before: r.before ?? null,
            after: r.after ?? null,
            errorCode: r.reason ?? null,
          };
        },
      );

      if (!result.ok) {
        throw app.httpErrors.badGateway(`unlock failed: ${result.errorCode ?? 'unknown'}`);
      }

      // Refresh cache once more so subsequent reads show the unlocked state.
      await app.services.userLiveRefresh.refresh(provider, id);

      return {
        ok: true,
        before: result.before,
        after: result.after,
      };
    },
  });

  // ---- POST /api/users/:id/disable + /enable ---------------------------
  // Both routes share the same write-as-user shape as unlock. Implementation
  // delegated to a small helper to avoid copy/paste.
  app.post('/api/users/:id/disable', {
    preHandler: [app.requireCapability('write:user.enableDisable'), app.requireStepUp],
    handler: async (req) => toggleEnabled(req, app, true),
  });

  app.post('/api/users/:id/enable', {
    preHandler: [app.requireCapability('write:user.enableDisable'), app.requireStepUp],
    handler: async (req) => toggleEnabled(req, app, false),
  });

  // ---- POST /api/users/:id/reset-password ------------------------------
  app.post('/api/users/:id/reset-password', {
    preHandler: [app.requireCapability('write:user.resetPassword'), app.requireStepUp],
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = resetPasswordRequestSchema.parse(req.body);
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
          metadata: { forceChangeAtNextLogin: body.forceChangeAtNextLogin },
        },
        async () => {
          const r = await provider.resetPassword(
            { kind: 'objectGuid', value: id },
            {
              newPassword: body.newPassword,
              forceChangeAtNextLogin: body.forceChangeAtNextLogin,
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
  // Body: { password, groupId }. The server resolves the group's DN by
  // its objectGuid via the cache, then asks the provider to do the modify.
  app.post('/api/users/:id/groups', {
    preHandler: [app.requireCapability('write:group.membership'), app.requireStepUp],
    handler: async (req) => modifyMembership(req, app, 'add'),
  });

  app.delete('/api/users/:id/groups', {
    preHandler: [app.requireCapability('write:group.membership'), app.requireStepUp],
    handler: async (req) => modifyMembership(req, app, 'remove'),
  });

  // ---- POST /api/users/:id/move (modifyDN to a new parent OU) ----------
  // Body: { targetOuDn }. The server validates that the OU exists for this
  // provider in the cache before issuing the modify; the AD provider then
  // re-checks via its own bind. Idempotent — if the user is already under
  // the requested OU, the provider returns ok with a no-op.
  app.post('/api/users/:id/move', {
    preHandler: [app.requireCapability('write:user.move'), app.requireStepUp],
    handler: async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const body = userMoveRequestSchema.parse(req.body);
      const actor = req.actor!;
      if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
      const provider = await app.services.providers.buildForRequest(req);

      const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
      if (!beforeRefresh) throw NotFound('user not found');

      // Confirm the target OU is one we know about for this provider. This
      // gates against typos and against pointing the move at a container the
      // sync hasn't seen — the AD bind would refuse those anyway, but
      // failing fast here gives a cleaner 400.
      const targetOu = await app.db
        .selectFrom('directory_ous')
        .where('provider_id', '=', provider.id)
        .where('deleted_at', 'is', null)
        .where(sql<string>`lower(distinguished_name)`, '=', body.targetOuDn.toLowerCase())
        .select(['distinguished_name', 'name'])
        .executeTakeFirst();
      if (!targetOu) {
        throw app.httpErrors.badRequest('target OU not found in directory cache');
      }

      const result = await withAudit(
        app.services.audit,
        {
          ...auditContextFromRequest(req),
          action: 'user.move',
          actorAuthMethod: 'ad-password',
          providerId: provider.id,
          targetType: 'user',
          targetId: beforeRefresh.user.objectGuid,
          targetDn: beforeRefresh.user.distinguishedName,
          metadata: { targetOuDn: targetOu.distinguished_name, targetOuName: targetOu.name },
        },
        async () => {
          const r = await provider.moveUser(
            { kind: 'objectGuid', value: id },
            targetOu.distinguished_name,
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
          throw app.httpErrors.forbidden('directory rejected the move');
        }
        if (result.errorCode === 'not_found') {
          throw app.httpErrors.notFound('user not found in directory');
        }
        throw app.httpErrors.badGateway(`move failed: ${result.errorCode ?? 'unknown'}`);
      }

      // Refresh cache so the new distinguished_name lands in user_cache_records.
      await app.services.userLiveRefresh.refresh(provider, id);
      return { ok: true, before: result.before, after: result.after };
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

  const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
  if (!beforeRefresh) throw NotFound('user not found');

  const result = await withAudit(
    app.services.audit,
    {
      ...auditContextFromRequest(req),
      action: disable ? 'user.disable' : 'user.enable',
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: 'user',
      targetId: beforeRefresh.user.objectGuid,
      targetDn: beforeRefresh.user.distinguishedName,
    },
    async () => {
      const r = await (disable
        ? provider.disableUser({ kind: 'objectGuid', value: id }, ctx(actor, req))
        : provider.enableUser({ kind: 'objectGuid', value: id }, ctx(actor, req)));
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
    throw app.httpErrors.badGateway(
      `${disable ? 'disable' : 'enable'} failed: ${result.errorCode ?? 'unknown'}`,
    );
  }
  await app.services.userLiveRefresh.refresh(provider, id);
  return { ok: true, before: result.before, after: result.after };
}

async function modifyMembership(
  req: import('fastify').FastifyRequest,
  app: import('fastify').FastifyInstance,
  op: 'add' | 'remove',
): Promise<{ ok: true; before: unknown; after: unknown }> {
  const { id } = idParamSchema.parse(req.params);
  const body = groupMembershipChangeSchema.parse(req.body);
  const actor = req.actor!;
  if (!actor.session.actorUsername) throw Unauthorized('session has no bind identity');
  const provider = await app.services.providers.buildForRequest(req);

  const beforeRefresh = await app.services.userLiveRefresh.refresh(provider, id);
  if (!beforeRefresh) throw NotFound('user not found');

  // Validate the group id belongs to this provider before bothering AD.
  const groupRow = await app.db
    .selectFrom('group_cache_records')
    .select(['object_guid', 'distinguished_name', 'name'])
    .where('provider_id', '=', provider.id)
    .where('object_guid', '=', body.groupId)
    .executeTakeFirst();
  if (!groupRow) throw NotFound('group not found');

  const result = await withAudit(
    app.services.audit,
    {
      ...auditContextFromRequest(req),
      action: op === 'add' ? 'user.group.add' : 'user.group.remove',
      actorAuthMethod: 'ad-password',
      providerId: provider.id,
      targetType: 'user',
      targetId: beforeRefresh.user.objectGuid,
      targetDn: beforeRefresh.user.distinguishedName,
      metadata: {
        groupId: body.groupId,
        groupDn: groupRow.distinguished_name,
        groupName: groupRow.name,
      },
    },
    async () => {
      const r = await (op === 'add'
        ? provider.addUserToGroup(
            { kind: 'objectGuid', value: id },
            { kind: 'objectGuid', value: body.groupId },
            ctx(actor, req),
          )
        : provider.removeUserFromGroup(
            { kind: 'objectGuid', value: id },
            { kind: 'objectGuid', value: body.groupId },
            ctx(actor, req),
          ));
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
    if (result.errorCode === 'not_found') {
      throw app.httpErrors.notFound('user or group not found in directory');
    }
    throw app.httpErrors.badGateway(`group ${op} failed: ${result.errorCode ?? 'unknown'}`);
  }

  // Refresh the user's cache so memberOf reflects the change on next read,
  // and reconcile direct-membership rows so the GET response shows the
  // change without waiting for the next full sync.
  const after = await app.services.userLiveRefresh.refresh(provider, id);
  if (after) {
    await app.services.userLiveRefresh.reconcileDirectMemberships(
      provider.id,
      id,
      after.user.memberOfDns,
    );
  }
  return { ok: true, before: result.before, after: result.after };
}

/**
 * Build the write-context object the AD provider expects. The bind password
 * comes from the in-process credential cache (populated by step-up). The
 * non-null assertions are safe because requireStepUp gates these handlers.
 */
function ctx(
  actor: NonNullable<import('fastify').FastifyRequest['actor']>,
  req: import('fastify').FastifyRequest,
): { actorUserId: string; actorUsername: string; actorPassword: string; correlationId: string } {
  return {
    actorUserId: actor.session.actorUserId,
    actorUsername: actor.session.actorUsername!,
    actorPassword: actor.elevatedPassword!,
    correlationId: req.correlationId,
  };
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
/** Read a single string value from a raw LDAP attribute (last value wins). */
function rawScalarValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return rawScalarValue(v[v.length - 1]);
  }
  if (typeof v === 'string') return v.length > 0 ? v : null;
  return String(v);
}

/** Read every string value from a raw LDAP attribute as an array. */
function rawArrayValues(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x === 'string') {
      if (x.length > 0) out.push(x);
    } else if (x !== null && x !== undefined) {
      out.push(String(x));
    }
  }
  return out;
}

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
  const row = await app.db
    .selectFrom('user_cache_records')
    .where('provider_id', '=', providerId)
    .where('deleted_at', 'is', null)
    .where(sql<string>`lower(distinguished_name)`, '=', dn.toLowerCase())
    .select(['object_guid', 'display_name', 'sam_account_name'])
    .executeTakeFirst();
  return {
    id: row?.object_guid ?? null,
    distinguishedName: dn,
    displayName: row?.display_name ?? row?.sam_account_name ?? null,
  };
}

function computeExpiresAt(
  passwordNeverExpires: boolean,
  cachedExpiresAt: Date | string | null,
  passwordLastSetAt: Date | string | null,
  maxAgeDays: number | null,
): string | null {
  if (passwordNeverExpires) return null;
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
 * Known gap: this is the *domain default*. Fine-grained password policies
 * (PSOs) targeting specific users/groups override `maxPwdAge` at the user
 * level — those users will show the domain expiry, not their PSO expiry,
 * until PSO resolution lands.
 */
async function resolveMaxPwdAgeDays(provider: DirectoryProvider): Promise<number | null> {
  try {
    const policy = await provider.getDomainPolicy();
    if (!policy.maxPwdAgeMs || policy.maxPwdAgeMs <= 0) return null;
    return Math.max(1, Math.round(policy.maxPwdAgeMs / 86_400_000));
  } catch {
    return null;
  }
}
