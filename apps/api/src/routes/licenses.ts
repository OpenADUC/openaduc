// SPDX-License-Identifier: BUSL-1.1
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  groupLicensesSchema,
  licensedGroupsSchema,
  userLicensesSchema,
  type GroupLicenses,
  type LicensedGroups,
  type UserLicenses,
} from '@openaduc/shared';
import { z } from 'zod';
import { AppError, NotFound } from '../plugins/errorHandler.js';
import { groupLicenses, userLicenses } from '../services/entraLicenses.js';
import {
  adGroupsBySid,
  licensedAdGroups,
  licensedGroupsRefresh,
  storeLicensedGroup,
} from '../services/licenseCache.js';
import { graphFailure } from './graphFailure.js';

const idParamSchema = z.object({ id: z.guid() });

const NotEnabled = () =>
  new AppError({
    statusCode: 409,
    code: 'licenses_not_enabled',
    message:
      'Licenses aren’t turned on for this directory. An administrator turns them on in Settings → Integrations.',
  });

export async function registerLicenseRoutes(app: FastifyInstance): Promise<void> {
  async function graphFor(req: FastifyRequest) {
    const directoryId = req.directoryId!;
    if (!(await app.services.entraIntegration.isFeatureEnabled(directoryId, 'licenses'))) {
      throw NotEnabled();
    }
    const graph = await app.services.graphClient.build(directoryId);
    if (!graph) throw NotEnabled();
    return graph;
  }

  // ---- GET /api/users/:id/licenses -----------------------------------------
  app.get('/api/users/:id/licenses', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
      policy: { capability: 'read:user', stepUp: false, directory: 'caller' },
    },
    handler: async (req): Promise<UserLicenses> => {
      const { id } = idParamSchema.parse(req.params);
      const graph = await graphFor(req);
      const provider = await app.services.providers.buildForRequest(req);
      const user = await provider.getUser({ kind: 'objectGuid', value: id });
      if (!user) throw NotFound('user not found');
      if (!user.sid) return { status: 'unsynced', lastSyncAt: null };
      const licenses = await userLicenses(
        { graph, adGroupsBySid: (sids) => adGroupsBySid(app.db, provider.id, sids) },
        user.sid,
      ).catch(graphFailure);
      return userLicensesSchema.parse(licenses);
    },
  });

  // ---- GET /api/groups/licensed --------------------------------------------
  // From the cache alone, so every group picker can badge licensed groups
  // without waiting on Graph. Off, it answers that rather than refusing.
  app.get('/api/groups/licensed', {
    config: { policy: { capability: 'read:group', stepUp: false, directory: 'caller' } },
    handler: async (req): Promise<LicensedGroups> => {
      const directoryId = req.directoryId!;
      if (!(await app.services.entraIntegration.isFeatureEnabled(directoryId, 'licenses'))) {
        return { enabled: false, refreshedAt: null, refreshFailed: false, groups: [] };
      }
      const [groups, refresh] = await Promise.all([
        licensedAdGroups(app.db, directoryId),
        licensedGroupsRefresh(app.db, directoryId),
      ]);
      return licensedGroupsSchema.parse({
        enabled: true,
        refreshedAt: refresh.refreshedAt?.toISOString() ?? null,
        refreshFailed: refresh.failed,
        groups,
      });
    },
  });

  // ---- GET /api/groups/:id/licenses ----------------------------------------
  // Read live, and kept in the cache, so the group's badge in pickers
  // follows what its page last showed.
  app.get('/api/groups/:id/licenses', {
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
      policy: { capability: 'read:group', stepUp: false, directory: 'caller' },
    },
    handler: async (req): Promise<GroupLicenses> => {
      const { id } = idParamSchema.parse(req.params);
      const graph = await graphFor(req);
      const provider = await app.services.providers.buildForRequest(req);
      const group = await provider.getGroup({ kind: 'objectGuid', value: id });
      if (!group) throw NotFound('group not found');
      if (!group.sid) return { status: 'unsynced', lastSyncAt: null };
      const { licenses, entraGroup } = await groupLicenses({ graph }, group.sid).catch(
        graphFailure,
      );
      await storeLicensedGroup(app.db, provider.id, group.sid, entraGroup).catch((err) =>
        req.log.warn({ err }, 'licensed group cache update failed'),
      );
      return groupLicensesSchema.parse(licenses);
    },
  });
}
