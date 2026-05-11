// SPDX-License-Identifier: BUSL-1.1
import type { FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';
import { Unauthorized } from '../plugins/errorHandler.js';
import {
  ActiveDirectoryProvider,
  type ActiveDirectoryProviderConfig,
} from './active-directory/provider.js';
import type { DirectoryConfigService } from '../services/directoryConfig.js';

/**
 * Provider construction.
 *
 * Bind model:
 *   - Reads (search, browse, view) bind as the directory's service
 *     account. The SA password is encrypted at rest in
 *     `directory_providers.sync_bind_secret_encrypted` and decrypted on
 *     each request. This survives API restarts cleanly — there's no
 *     in-memory cache to lose.
 *   - Writes bind as the actual operator using the password they
 *     supplied at step-up time. The route layer passes that through as
 *     `WriteContext.actorPassword`; this factory has nothing to do
 *     with it.
 *   - Sync runs in-process and uses the same SA via the directory_id.
 *
 * Audit still records *who* triggered the read at the application
 * layer; only the LDAP-level bind identity is the SA. For reads, that
 * trade is fine — AD ACLs for reads are usually permissive, and the
 * "who did this" question is answered by the audit row, not the LDAP
 * connection.
 */
export class ProviderFactory {
  constructor(
    private readonly directoryConfig: DirectoryConfigService,
    private readonly env: Env,
  ) {}

  /**
   * Build a provider for a request that performs reads against AD. Uses
   * the active session's directory + that directory's service account.
   *
   * Throws a helpful error if the SA isn't configured yet — reads can't
   * happen without one, and the operator should be told to finish
   * Settings → Directory rather than seeing a generic LDAP error.
   */
  async buildForRequest(req: FastifyRequest): Promise<ActiveDirectoryProvider> {
    if (!req.actor) throw Unauthorized('authentication required');
    const directoryId = req.actor.session.directoryId;
    const creds = await this.directoryConfig.getSyncBindCreds(directoryId);
    if (!creds) {
      throw Unauthorized(
        'a sync service account is required to load directory data — set one in Settings → Directory',
      );
    }
    return this.buildWithCreds(directoryId, creds);
  }

  /**
   * Build a provider with explicit bind credentials. Used at login time (no
   * session yet) and during setup/add-domain (the test bind verifies the
   * supplied creds before we persist anything).
   */
  async buildWithCreds(
    directoryId: number,
    creds: { username: string; password: string },
  ): Promise<ActiveDirectoryProvider> {
    const meta = await this.directoryConfig.getById(directoryId);
    if (!meta) throw new Error(`directory ${directoryId} not found`);
    const cfg: ActiveDirectoryProviderConfig = {
      id: meta.id,
      name: meta.name,
      baseDn: meta.baseDn,
      ldapUrls: meta.ldapUrls,
      tlsRejectUnauthorized: meta.tlsRejectUnauthorized ?? this.env.AD_TLS_REJECT_UNAUTHORIZED,
      tlsCaPath: this.env.AD_TLS_CA_PATH,
      operationTimeoutMs: this.env.AD_OPERATION_TIMEOUT_MS,
      serviceAccountUpn: creds.username,
      serviceAccountPassword: creds.password,
    };
    return new ActiveDirectoryProvider(cfg);
  }
}
