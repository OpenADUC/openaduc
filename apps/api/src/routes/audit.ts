// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

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
});

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit-events', {
    preHandler: app.requireCapability('view:audit'),
    handler: async (req) => {
      const q = querySchema.parse(req.query);
      const offset = (q.page - 1) * q.pageSize;

      let baseQuery = app.db.selectFrom('audit_events');
      if (q.from) baseQuery = baseQuery.where('timestamp', '>=', new Date(q.from));
      if (q.to) baseQuery = baseQuery.where('timestamp', '<=', new Date(q.to));
      if (q.actorUserId) baseQuery = baseQuery.where('actor_user_id', '=', q.actorUserId);
      if (q.targetType) baseQuery = baseQuery.where('target_type', '=', q.targetType);
      if (q.targetId) baseQuery = baseQuery.where('target_id', '=', q.targetId);
      if (q.action) baseQuery = baseQuery.where('action', '=', q.action);
      if (q.result) baseQuery = baseQuery.where('result', '=', q.result);
      if (q.sourceIp) baseQuery = baseQuery.where('source_ip', '=', q.sourceIp);
      if (q.correlationId) baseQuery = baseQuery.where('correlation_id', '=', q.correlationId);

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
