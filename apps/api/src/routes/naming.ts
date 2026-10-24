// SPDX-License-Identifier: BUSL-1.1
import {
  isDnWithin,
  parseDn,
  type NamingCheckResponse,
  type NamingSettingsResponse,
  namingCheckRequestSchema,
  namingLookups,
  namingPatternProblem,
  namingSettingsSchema,
  resolveNames,
} from '@openaduc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../plugins/errorHandler.js';
import { auditContextFromRequest } from '../services/auditContext.js';
import { findCachedOu } from '../services/ouCache.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

// The naming pattern turns a person's name into a new account's names. The
// settings live with the directory; the check answers what a create or an
// import would name each person, against the directory as it is now.
export async function registerNamingRoutes(app: FastifyInstance): Promise<void> {
  async function directoryOf(req: FastifyRequest) {
    const { id } = idParamSchema.parse(req.params);
    const directory = await app.services.directoryConfig.getById(id);
    if (!directory) throw NotFound('directory not found');
    return directory;
  }

  async function upnSuffixes(req: FastifyRequest, domain: string): Promise<string[]> {
    const provider = await app.services.providers.buildForRequest(req);
    const all = [domain, ...(await provider.getUpnSuffixes())].map((s) => s.toLowerCase());
    return [...new Set(all)];
  }

  // ---- GET /api/directories/:id/naming ---------------------------------
  // Read by anyone who can see users: the create and import workflows
  // preview names with it.
  app.get('/api/directories/:id/naming', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'param' } },
    handler: async (req): Promise<NamingSettingsResponse> => {
      const directory = await directoryOf(req);
      return {
        naming: directory.naming,
        upnSuffixes: await upnSuffixes(req, directory.domain),
      };
    },
  });

  // ---- PUT /api/directories/:id/naming ---------------------------------
  // Applies to accounts created from now on; existing names don't change.
  app.put('/api/directories/:id/naming', {
    config: { policy: { capability: 'configure:directory', stepUp: true, directory: 'param' } },
    handler: async (req): Promise<NamingSettingsResponse> => {
      const directory = await directoryOf(req);
      const body = namingSettingsSchema.parse(req.body);
      const problem = namingPatternProblem(body.pattern);
      if (problem) throw BadRequest(problem);
      const suffixes = await upnSuffixes(req, directory.domain);
      if (!suffixes.includes(body.upnSuffix)) {
        throw BadRequest(
          `"${body.upnSuffix}" isn't one of this domain's UPN suffixes (${suffixes.join(', ')}).`,
        );
      }

      const updated = await app.services.directoryConfig.updateNaming(directory.id, body);
      await app.services.audit
        .recordEvent({
          ...auditContextFromRequest(req),
          action: 'directory.naming.update',
          result: 'success',
          actorAuthMethod: 'ad-password',
          providerId: directory.id,
          targetType: 'config',
          targetId: String(directory.id),
          before: { ...directory.naming },
          after: { ...updated.naming },
        })
        .catch((err) => req.log.error({ err }, 'audit insert failed for directory.naming.update'));
      return { naming: updated.naming, upnSuffixes: suffixes };
    },
  });

  // ---- POST /api/directories/:id/naming/check --------------------------
  // A read sent as POST: an import checks up to 500 names at once.
  app.post('/api/directories/:id/naming/check', {
    config: { policy: { capability: 'read:user', stepUp: false, directory: 'param' } },
    handler: async (req): Promise<NamingCheckResponse> => {
      const directory = await directoryOf(req);
      const body = namingCheckRequestSchema.parse(req.body);
      const ous = new Map<string, string>();
      for (const ouDn of new Set(body.names.flatMap((n) => (n.ouDn ? [n.ouDn] : [])))) {
        if (!parseDn(ouDn)) throw BadRequest(`"${ouDn}" isn't a distinguished name.`);
        if (!isDnWithin(ouDn, directory.baseDn)) {
          throw BadRequest(`"${ouDn}" isn't under this directory's base DN.`);
        }
        // A container such as CN=Users isn't in the OU cache; it's still a
        // place accounts are created, and its search stays under the base.
        const cached = await findCachedOu(app.db, directory.id, ouDn);
        ous.set(ouDn, cached?.distinguished_name ?? ouDn);
      }
      const requests = body.names.map(({ ouDn, overrides, ...name }) => ({
        name,
        ouDn: ouDn ? ous.get(ouDn) : undefined,
        overrides,
      }));
      const provider = await app.services.providers.buildForRequest(req);
      const taken = await provider.findTakenNames(namingLookups(requests, directory.naming));
      const typedUpn = requests.some((r) => r.overrides?.userPrincipalName?.trim());
      return {
        naming: directory.naming,
        suggestions: resolveNames(
          requests,
          directory.naming,
          taken,
          typedUpn ? await upnSuffixes(req, directory.domain) : undefined,
        ),
      };
    },
  });
}
