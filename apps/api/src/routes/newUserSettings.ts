// SPDX-License-Identifier: BUSL-1.1
import { newUserSettingsSchema, type NewUserSettingsResponse } from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

// What a new user gets unless the operator changes it: whether `mail` is the
// UPN, the password mode, and the country for phone numbers without one.
export async function registerNewUserSettingsRoutes(app: FastifyInstance): Promise<void> {
  async function directoryOf(req: FastifyRequest) {
    const { id } = idParamSchema.parse(req.params);
    const directory = await app.services.directoryConfig.getById(id);
    if (!directory) throw NotFound('directory not found');
    return directory;
  }

  // ---- GET /api/directories/:id/new-users ------------------------------
  // Read by anyone who can see users, as the naming pattern is: the create
  // and import workflows start from it.
  app.get('/api/directories/:id/new-users', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'param' } },
    handler: async (req): Promise<NewUserSettingsResponse> => ({
      newUsers: (await directoryOf(req)).newUsers,
    }),
  });

  // ---- PUT /api/directories/:id/new-users ------------------------------
  app.put('/api/directories/:id/new-users', {
    config: { policy: { capability: 'configure:directory', stepUp: true, directory: 'param' } },
    handler: async (req): Promise<NewUserSettingsResponse> => {
      const directory = await directoryOf(req);
      const body = newUserSettingsSchema.parse(req.body);
      const updated = await app.services.directoryConfig.updateNewUsers(directory.id, body);
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.newUsers.update',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: directory.id,
          targetType: 'config',
          targetId: String(directory.id),
          before: { ...directory.newUsers },
          after: { ...updated.newUsers },
        })
        .catch((err) =>
          req.log.error({ err }, 'audit insert failed for directory.newUsers.update'),
        );
      return { newUsers: updated.newUsers };
    },
  });
}
