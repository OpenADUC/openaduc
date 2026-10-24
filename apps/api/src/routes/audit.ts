// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { sql, type Expression, type SqlBool } from 'kysely';
import { z } from 'zod';
import type {
  AuditBulkSummary,
  BulkJobAction,
  BulkJobPauseReason,
  BulkJobStatus,
} from '@openaduc/shared';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  actorUserId: z.string().optional(),
  targetType: z.enum(['user', 'group', 'session', 'config', 'system']).optional(),
  targetId: z.string().optional(),
  action: z.string().optional(),
  result: z.enum(['success', 'failure', 'denied']).optional(),
  sourceIp: z.string().optional(),
  correlationId: z.string().optional(),
  bulkJobId: z.coerce.number().int().positive().optional(),
  // Fold each bulk job's events into the `bulk.create` event that heads it.
  groupBulk: z.enum(['0', '1']).optional(),
});

type Query = z.infer<typeof querySchema>;
type Filter = 'actorUserId' | 'targetType' | 'targetId' | 'action' | 'result' | 'sourceIp';
const FILTER_COLUMNS: Record<Filter, string> = {
  actorUserId: 'actor_user_id',
  targetType: 'target_type',
  targetId: 'target_id',
  action: 'action',
  result: 'result',
  sourceIp: 'source_ip',
};

/** The query's equality filters, on the audit_events row `table` names. */
function matches(q: Query, table: string): Expression<SqlBool>[] {
  const out: Expression<SqlBool>[] = [];
  for (const [key, column] of Object.entries(FILTER_COLUMNS) as [Filter, string][]) {
    const value = q[key];
    if (value) out.push(sql<SqlBool>`${sql.ref(`${table}.${column}`)} = ${value}`);
  }
  if (q.correlationId) {
    out.push(sql<SqlBool>`${sql.ref(`${table}.correlation_id`)} = ${q.correlationId}`);
  }
  return out;
}

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit-events', {
    config: { policy: { capability: 'view:audit', stepUp: false, directory: 'caller' } },
    handler: async (req) => {
      const q = querySchema.parse(req.query);
      const offset = (q.page - 1) * q.pageSize;
      const directoryId = req.directoryId!;

      // The caller's directory's rows, and installation-wide ones (no
      // directory, config target: settings changes, first-run setup).
      // Older authz.deny rows have no provider_id; attribute them via
      // their session's directory.
      let baseQuery = app.db.selectFrom('audit_events').where((eb) =>
        eb.or([
          eb('provider_id', '=', directoryId),
          eb.and([
            eb('provider_id', 'is', null),
            eb.or([
              eb('target_type', '=', 'config'),
              eb(
                'session_id',
                'in',
                eb
                  .selectFrom('admin_sessions')
                  .select(sql<string>`id::text`.as('id'))
                  .where('directory_id', '=', directoryId),
              ),
            ]),
          ]),
        ]),
      );
      if (q.from) baseQuery = baseQuery.where('timestamp', '>=', new Date(q.from));
      if (q.to) baseQuery = baseQuery.where('timestamp', '<=', new Date(q.to));
      if (q.bulkJobId) baseQuery = baseQuery.where('bulk_job_id', '=', String(q.bulkJobId));
      const own = matches(q, 'audit_events');
      if (q.groupBulk === '1') {
        // A job shows once, as its heading event, and matches a filter when
        // the heading or any of its events does.
        const child = matches(q, 'child');
        baseQuery = baseQuery.where((eb) =>
          eb.or([
            eb.and([eb('bulk_job_id', 'is', null), ...own]),
            eb.and([
              eb('action', '=', 'bulk.create'),
              own.length === 0
                ? sql<SqlBool>`true`
                : eb.or([
                    eb.and(own),
                    eb.exists(
                      eb
                        .selectFrom('audit_events as child')
                        .select(sql`1`.as('one'))
                        .whereRef('child.bulk_job_id', '=', 'audit_events.bulk_job_id')
                        .where((c) => c.and(child)),
                    ),
                  ]),
            ]),
          ]),
        );
      } else if (own.length > 0) {
        baseQuery = baseQuery.where((eb) => eb.and(own));
      }

      const [rows, totalRow] = await Promise.all([
        baseQuery
          .selectAll()
          .orderBy('timestamp', 'desc')
          .orderBy('id', 'desc')
          .limit(q.pageSize)
          .offset(offset)
          .execute(),
        baseQuery.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirst(),
      ]);

      const jobIds = [
        ...new Set(
          rows
            .filter((r) => r.action === 'bulk.create' && r.bulk_job_id)
            .map((r) => r.bulk_job_id!),
        ),
      ];
      const [jobs, counts] = await Promise.all([
        jobIds.length === 0
          ? []
          : app.db
              .selectFrom('bulk_jobs')
              .select(['id', 'action', 'status', 'pause_reason'])
              .where('id', 'in', jobIds)
              .execute(),
        app.services.bulkJobs.counts(jobIds),
      ]);
      const jobById = new Map(jobs.map((j) => [String(j.id), j]));
      const bulkSummary = (r: (typeof rows)[number]): AuditBulkSummary => {
        const job = r.bulk_job_id ? jobById.get(String(r.bulk_job_id)) : undefined;
        const jobCounts = r.bulk_job_id ? counts.get(String(r.bulk_job_id)) : undefined;
        const metadata = r.metadata_json as { action?: BulkJobAction; total?: number };
        return {
          action: (job?.action as BulkJobAction | undefined) ?? metadata.action ?? null,
          // Null once the job's record is gone; its events remain.
          status: (job?.status as BulkJobStatus | undefined) ?? null,
          pauseReason: (job?.pause_reason as BulkJobPauseReason | null | undefined) ?? null,
          total: jobCounts?.total ?? metadata.total ?? 0,
          succeeded: jobCounts?.succeeded ?? null,
          failed: jobCounts?.failed ?? null,
        };
      };

      return {
        rows: rows.map((r) => ({
          id: String(r.id),
          timestamp: toIso(r.timestamp),
          actorUserId: r.actor_user_id,
          actorDisplayName: r.actor_display_name,
          actorAuthMethod: r.actor_auth_method,
          sourceIp: r.source_ip,
          userAgent: r.user_agent,
          sessionId: r.session_id,
          correlationId: r.correlation_id,
          providerId: r.provider_id,
          targetType: r.target_type,
          targetId: r.target_id,
          targetDn: r.target_dn,
          action: r.action,
          result: r.result,
          errorCode: r.error_code,
          before: r.before_json,
          after: r.after_json,
          metadata: r.metadata_json,
          bulkJobId: r.bulk_job_id === null ? null : String(r.bulk_job_id),
          bulk: r.action === 'bulk.create' ? bulkSummary(r) : null,
        })),
        page: q.page,
        pageSize: q.pageSize,
        total: Number(totalRow?.total ?? 0),
      };
    },
  });
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
