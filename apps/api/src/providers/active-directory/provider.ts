// SPDX-License-Identifier: BUSL-1.1
import { Attribute, Change, EqualityFilter, type Client, type Entry, type Filter } from 'ldapts';
import type {
  AuthResult,
  AuthenticateInput,
  ConnectionTestResult,
  DeletedComputerSearchInput,
  DeletedUserSearchInput,
  DirectoryComputer,
  DirectoryComputerSearchQuery,
  DirectoryDeletedComputer,
  DirectoryDeletedUser,
  DirectoryDomainPolicy,
  DirectoryGroup,
  DirectoryGroupPolicy,
  DirectoryGroupPolicyLink,
  DirectoryObjectIdentifier,
  DirectoryOu,
  DirectoryProvider,
  DirectoryGroupSearchQuery,
  DirectoryUser,
  DirectoryUserSearchQuery,
  MutationResult,
  OuAttributePatch,
  RecycleBinStatus,
  ResetPasswordInput,
  RestoreResult,
  RestoreUserInput,
  SyncInput,
  UserAttributePatch,
  WriteContext,
} from '../types.js';
import { StepUpBindFailedError } from '../types.js';
import { type ClientConfig, withFailover } from './client.js';
import { ShowDeletedControl, deletedObjectControls } from './controls.js';
import {
  BINARY_ATTRS,
  COMPUTER_ATTRS,
  COMPUTER_ATTRS_FULL,
  DELETED_COMPUTER_ATTRS,
  DELETED_USER_ATTRS,
  GPLINK_SCAN_ATTRS,
  GPO_ATTRS,
  GROUP_ATTRS,
  OU_ATTRS,
  USER_ATTRS,
  USER_ATTRS_FULL,
  asString,
  asStringArray,
  leafRdn,
  normalizeComputer,
  normalizeDeletedComputer,
  normalizeDeletedUser,
  normalizeGroup,
  normalizeGroupPolicy,
  normalizeOu,
  normalizeUser,
  parentDn,
  parseGpLinkValue,
} from './normalize.js';
import {
  adDurationToMs,
  encodeUnicodePassword,
  escapeLdapFilter,
  isLocked,
  objectGuidFromString,
  UAC,
} from './utils.js';

const USER_FILTER_BASE = '(&(objectCategory=person)(objectClass=user)(!(objectClass=computer)))';
const GROUP_FILTER_BASE = '(objectClass=group)';
const OU_FILTER_BASE = '(objectClass=organizationalUnit)';
// Computer accounts in AD use objectClass=computer (which derives from
// `user`); the explicit objectCategory disambiguates from the user filter.
const COMPUTER_FILTER_BASE = '(&(objectCategory=computer)(objectClass=computer))';
// GPC entries always live at `CN={guid},CN=Policies,CN=System,<baseDn>`. We
// search the whole domain naming context rather than the policies container
// directly so the route doesn't need to know how to build that DN — the
// objectClass filter is already exact enough.
const GPO_FILTER_BASE = '(objectClass=groupPolicyContainer)';

/**
 * All inputs the AD provider needs at runtime. Built either from a
 * directory_providers DB row (production path) or from env vars (legacy /
 * bootstrap path).
 */
export interface ActiveDirectoryProviderConfig {
  id: number;
  name: string;
  baseDn: string;
  ldapUrls: readonly string[];
  tlsRejectUnauthorized: boolean;
  tlsCaPath?: string | undefined;
  operationTimeoutMs: number;
  serviceAccountUpn: string;
  serviceAccountPassword: string;
}

// (The NotImplementedError class was used while these write methods were
// stubbed; all methods now have implementations.)

export class ActiveDirectoryProvider implements DirectoryProvider {
  readonly id: number;
  readonly name: string;
  readonly type = 'active-directory' as const;

  private readonly config: ActiveDirectoryProviderConfig;
  private readonly clientConfig: ClientConfig;
  private domainPolicyCache: { policy: DirectoryDomainPolicy; expiresAt: number } | null = null;
  private static readonly DOMAIN_POLICY_TTL_MS = 5 * 60 * 1000;

  constructor(config: ActiveDirectoryProviderConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.clientConfig = {
      ldapUrls: config.ldapUrls,
      tlsRejectUnauthorized: config.tlsRejectUnauthorized,
      tlsCaPath: config.tlsCaPath,
      operationTimeoutMs: config.operationTimeoutMs,
    };
  }

  // ---- Connection / auth -------------------------------------------------

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      return await withFailover(this.clientConfig, async (client) => {
        await client.bind(this.config.serviceAccountUpn, this.config.serviceAccountPassword);
        try {
          // Reading the rootDSE is the cheapest "are you alive" probe.
          const { searchEntries } = await client.search('', {
            scope: 'base',
            filter: '(objectClass=*)',
            attributes: [
              'namingContexts',
              'defaultNamingContext',
              'dnsHostName',
              'supportedLDAPVersion',
            ],
          });
          const dse = searchEntries[0] ?? {};
          return {
            ok: true,
            message: `bound as ${this.config.serviceAccountUpn}`,
            details: dse,
          };
        } finally {
          await client.unbind();
        }
      });
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'directory error',
      };
    }
  }

  async authenticateUser(input: AuthenticateInput): Promise<AuthResult> {
    // Step 1: bind as the user. AD accepts UPN, sAMAccountName, or DN.
    const username = input.username.trim();
    if (!username || !input.password) {
      return { ok: false, reason: 'invalid_credentials', errorMessage: 'missing credentials' };
    }
    try {
      return await withFailover(this.clientConfig, async (client) => {
        try {
          await client.bind(username, input.password);
        } catch (bindErr) {
          // Surface the actual reason. AD encodes a subcode in the error
          // text (e.g. "data 52e") that distinguishes wrong-password from
          // user-not-found / disabled / expired / locked. Network or TLS
          // failures look different at the JS error level (no LDAP code).
          return classifyBindError(bindErr);
        }
        try {
          // Step 2: look up the user record (now bound as them).
          // AD accepts UPN-form binds even when the account has no
          // userPrincipalName attribute (using the implicit domain mapping),
          // so we may need to fall back to sAMAccountName lookup.
          const upn = looksLikeUpn(username);
          const candidates: string[] = [];
          if (upn) {
            candidates.push(`(userPrincipalName=${escapeLdapFilter(username)})`);
            const samPart = username.split('@', 1)[0];
            if (samPart) candidates.push(`(sAMAccountName=${escapeLdapFilter(samPart)})`);
          } else {
            candidates.push(`(sAMAccountName=${escapeLdapFilter(username)})`);
          }
          let entry: Entry | null = null;
          for (const filter of candidates) {
            entry = await this.searchOne(
              client,
              this.config.baseDn,
              `(&${USER_FILTER_BASE}${filter})`,
              USER_ATTRS,
            );
            if (entry) break;
          }
          if (!entry) {
            return {
              ok: false,
              reason: 'directory_error' as const,
              errorMessage: 'authenticated but user record not found',
            };
          }
          const user = normalizeUser(entry);
          if (!user.enabled) {
            return { ok: false, reason: 'account_disabled', errorMessage: 'account disabled' };
          }
          // Don't gate login on user.locked. AD's lockoutTime attribute is not
          // cleared when the lockout duration auto-expires or in some manual
          // unlock paths — so a previously-locked account that AD has just
          // accepted a bind for can still show non-zero lockoutTime, producing
          // a false "account locked" rejection. The successful client.bind()
          // above is the authoritative signal that AD considers the account
          // signable-in right now.
          return {
            ok: true,
            user,
            groupDns: user.memberOfDns,
          };
        } finally {
          await client.unbind();
        }
      });
    } catch (err) {
      return {
        ok: false,
        reason: 'directory_error',
        errorMessage: err instanceof Error ? err.message : 'directory error',
      };
    }
  }

  // ---- Domain policy -----------------------------------------------------

  /**
   * Read the domain root for the lockout / password policy attributes.
   * Cached in-memory for 5 minutes so high-traffic UI views (user search,
   * dashboard) don't hammer the DC for a value that changes once a quarter
   * if that.
   *
   * Falls back to a fully-null policy on any LDAP error rather than
   * throwing — user detail rendering shouldn't break because we couldn't
   * read maxPwdAge.
   */
  async getDomainPolicy(): Promise<DirectoryDomainPolicy> {
    const now = Date.now();
    if (this.domainPolicyCache && this.domainPolicyCache.expiresAt > now) {
      return this.domainPolicyCache.policy;
    }
    try {
      const policy = await this.withServiceBind(async (client) => {
        const { searchEntries } = await client.search(this.config.baseDn, {
          scope: 'base',
          filter: '(objectClass=*)',
          attributes: [
            'lockoutDuration',
            'lockoutThreshold',
            'lockOutObservationWindow',
            'maxPwdAge',
            'minPwdLength',
            'pwdHistoryLength',
          ],
        });
        const root: Entry = searchEntries[0] ?? ({} as Entry);
        const intAttr = (v: unknown): number | null => {
          const s = asString(v);
          if (s === null) return null;
          const n = Number.parseInt(s, 10);
          return Number.isFinite(n) ? n : null;
        };
        return {
          lockoutDurationMs: adDurationToMs(asString(root['lockoutDuration'])),
          lockoutThreshold: intAttr(root['lockoutThreshold']),
          lockoutObservationMs: adDurationToMs(asString(root['lockOutObservationWindow'])),
          maxPwdAgeMs: adDurationToMs(asString(root['maxPwdAge'])),
          minPwdLength: intAttr(root['minPwdLength']),
          pwdHistoryLength: intAttr(root['pwdHistoryLength']),
        } satisfies DirectoryDomainPolicy;
      });
      this.domainPolicyCache = {
        policy,
        expiresAt: now + ActiveDirectoryProvider.DOMAIN_POLICY_TTL_MS,
      };
      return policy;
    } catch {
      // Don't cache the failure — let the next call retry.
      return {
        lockoutDurationMs: null,
        lockoutThreshold: null,
        lockoutObservationMs: null,
        maxPwdAgeMs: null,
        minPwdLength: null,
        pwdHistoryLength: null,
      };
    }
  }

  // ---- Reads -------------------------------------------------------------

  async getUser(identifier: DirectoryObjectIdentifier): Promise<DirectoryUser | null> {
    return this.withServiceBind(async (client) => {
      // Detail reads pull '*' so the Identity / Raw LDAP views can render
      // every populated attribute without a follow-up query.
      const entry = await this.findUserEntry(client, identifier, USER_ATTRS_FULL);
      return entry ? normalizeUser(entry) : null;
    });
  }

  async searchUsers(query: DirectoryUserSearchQuery): Promise<DirectoryUser[]> {
    const filter = this.buildUserFilter(query);
    return this.withServiceBind(async (client) => {
      const { searchEntries } = await client.search(query.searchBase ?? this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes: USER_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
        sizeLimit: query.pageSize ?? 200,
        paged: { pageSize: query.pageSize ?? 200 },
      });
      return searchEntries.map(normalizeUser);
    });
  }

  async getGroup(identifier: DirectoryObjectIdentifier): Promise<DirectoryGroup | null> {
    return this.withServiceBind(async (client) => {
      const entry = await this.findGroupEntry(client, identifier);
      return entry ? normalizeGroup(entry) : null;
    });
  }

  async searchGroups(query: DirectoryGroupSearchQuery): Promise<DirectoryGroup[]> {
    const filter = query.text
      ? `(&${GROUP_FILTER_BASE}(|(cn=*${escapeLdapFilter(query.text)}*)(sAMAccountName=*${escapeLdapFilter(query.text)}*)(description=*${escapeLdapFilter(query.text)}*)))`
      : GROUP_FILTER_BASE;
    return this.withServiceBind(async (client) => {
      const { searchEntries } = await client.search(query.searchBase ?? this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes: GROUP_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
        paged: { pageSize: query.pageSize ?? 200 },
      });
      return searchEntries.map(normalizeGroup);
    });
  }

  async getUserGroups(userId: DirectoryObjectIdentifier): Promise<DirectoryGroup[]> {
    return this.withServiceBind(async (client) => {
      const entry = await this.findUserEntry(client, userId);
      if (!entry) return [];
      const user = normalizeUser(entry);
      if (user.memberOfDns.length === 0) return [];
      // Fan out via filter: (|(distinguishedName=...)(distinguishedName=...))
      const filter = `(&${GROUP_FILTER_BASE}(|${user.memberOfDns
        .map((dn) => `(distinguishedName=${escapeLdapFilter(dn)})`)
        .join('')}))`;
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes: GROUP_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
      });
      return searchEntries.map(normalizeGroup);
    });
  }

  async getGroupMembers(groupId: DirectoryObjectIdentifier): Promise<DirectoryUser[]> {
    return this.withServiceBind(async (client) => {
      const entry = await this.findGroupEntry(client, groupId);
      if (!entry) return [];
      const group = normalizeGroup(entry);
      if (group.memberDns.length === 0) return [];
      const filter = `(&${USER_FILTER_BASE}(|${group.memberDns
        .map((dn) => `(distinguishedName=${escapeLdapFilter(dn)})`)
        .join('')}))`;
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes: USER_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
      });
      return searchEntries.map(normalizeUser);
    });
  }

  async getComputer(identifier: DirectoryObjectIdentifier): Promise<DirectoryComputer | null> {
    return this.withServiceBind(async (client) => {
      const entry = await this.findComputerEntry(client, identifier, COMPUTER_ATTRS_FULL);
      return entry ? normalizeComputer(entry) : null;
    });
  }

  async searchComputers(query: DirectoryComputerSearchQuery): Promise<DirectoryComputer[]> {
    const filter = this.buildComputerFilter(query);
    return this.withServiceBind(async (client) => {
      const { searchEntries } = await client.search(query.searchBase ?? this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes: COMPUTER_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
        sizeLimit: query.pageSize ?? 200,
        paged: { pageSize: query.pageSize ?? 200 },
      });
      return searchEntries.map(normalizeComputer);
    });
  }

  async getComputerGroups(computerId: DirectoryObjectIdentifier): Promise<DirectoryGroup[]> {
    return this.withServiceBind(async (client) => {
      const entry = await this.findComputerEntry(client, computerId);
      if (!entry) return [];
      const computer = normalizeComputer(entry);
      if (computer.memberOfDns.length === 0) return [];
      const filter = `(&${GROUP_FILTER_BASE}(|${computer.memberOfDns
        .map((dn) => `(distinguishedName=${escapeLdapFilter(dn)})`)
        .join('')}))`;
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes: GROUP_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
      });
      return searchEntries.map(normalizeGroup);
    });
  }

  // ---- Group Policy ------------------------------------------------------
  // Live-LDAP. GPOs are typically a small set per domain (dozens), so we
  // skip the cache+sync machinery used for users/groups/computers. The
  // policy *settings* themselves live in SYSVOL — these methods only see the
  // GPC half (the AD object).

  async searchGroupPolicies(): Promise<DirectoryGroupPolicy[]> {
    return this.withServiceBind(async (client) => {
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter: GPO_FILTER_BASE,
        attributes: GPO_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
        // 200 is well above the realistic GPO count for any single domain;
        // paged in case someone has unusual scale.
        paged: { pageSize: 200 },
      });
      return searchEntries.map(normalizeGroupPolicy);
    });
  }

  async getGroupPolicy(
    identifier: DirectoryObjectIdentifier,
  ): Promise<DirectoryGroupPolicy | null> {
    return this.withServiceBind(async (client) => {
      const filter = identifierToFilter(identifier, GPO_FILTER_BASE);
      const entry = await this.searchOne(client, this.config.baseDn, filter, GPO_ATTRS);
      return entry ? normalizeGroupPolicy(entry) : null;
    });
  }

  /**
   * Find every `gPLink` association across the domain naming context.
   * Returns one entry per individual link (a single OU with three GPOs
   * linked yields three rows). Sites also support `gPLink`; they live under
   * the configuration NC which we don't search here — the cost is that
   * site-scoped policy links aren't shown. Worth revisiting if anyone uses
   * site-linked GPOs in practice.
   */
  async getGroupPolicyLinks(): Promise<DirectoryGroupPolicyLink[]> {
    return this.withServiceBind(async (client) => {
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter: '(gPLink=*)',
        attributes: GPLINK_SCAN_ATTRS,
        explicitBufferAttributes: BINARY_ATTRS,
        paged: { pageSize: 500 },
      });
      const out: DirectoryGroupPolicyLink[] = [];
      for (const entry of searchEntries) {
        const dn = asString(entry.distinguishedName);
        if (!dn) continue;
        out.push(...parseGpLinkValue(dn, asString(entry.gPLink)));
      }
      return out;
    });
  }

  // ---- Sync (paged async iterables) --------------------------------------

  async *syncUsers(input: SyncInput): AsyncIterable<DirectoryUser> {
    const filter = input.modifiedSince
      ? `(&${USER_FILTER_BASE}(whenChanged>=${formatGeneralizedTime(input.modifiedSince)}))`
      : USER_FILTER_BASE;
    // Sync pulls '*' so cached rawAttributes match what the detail view
    // returns when AD is reachable.
    yield* this.streamSearch(filter, USER_ATTRS_FULL, input.pageSize ?? 500, normalizeUser);
  }

  async *syncGroups(input: SyncInput): AsyncIterable<DirectoryGroup> {
    const filter = input.modifiedSince
      ? `(&${GROUP_FILTER_BASE}(whenChanged>=${formatGeneralizedTime(input.modifiedSince)}))`
      : GROUP_FILTER_BASE;
    yield* this.streamSearch(filter, GROUP_ATTRS, input.pageSize ?? 500, normalizeGroup);
  }

  async *syncComputers(input: SyncInput): AsyncIterable<DirectoryComputer> {
    const filter = input.modifiedSince
      ? `(&${COMPUTER_FILTER_BASE}(whenChanged>=${formatGeneralizedTime(input.modifiedSince)}))`
      : COMPUTER_FILTER_BASE;
    // '*' so the cache + Raw view see every populated attribute, same as users/groups.
    yield* this.streamSearch(filter, COMPUTER_ATTRS_FULL, input.pageSize ?? 500, normalizeComputer);
  }

  async *syncOus(input: SyncInput): AsyncIterable<DirectoryOu> {
    const filter = input.modifiedSince
      ? `(&${OU_FILTER_BASE}(whenChanged>=${formatGeneralizedTime(input.modifiedSince)}))`
      : OU_FILTER_BASE;
    yield* this.streamSearch(filter, OU_ATTRS, input.pageSize ?? 500, normalizeOu);
  }

  // ---- Writes (vertical slice: unlock only) ------------------------------

  async unlockUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult> {
    // Write-as-user model: bind as the operator using the password they
    // re-supplied for this action, perform the modify, then drop the bind.
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return {
          ok: false,
          reason: 'permission_denied',
          errorMessage: 'step-up bind failed',
        };
      }
      try {
        // Resolve the target's DN. Service bind would also work; using the
        // operator bind keeps the entire operation in one identity.
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const beforeUser = normalizeUser(target);
        // Idempotent: if not locked, return success-no-op.
        if (!beforeUser.locked) {
          return {
            ok: true,
            before: { lockoutTime: target.lockoutTime ?? '0' },
            after: { lockoutTime: '0' },
          };
        }
        // The unlock primitive is "set lockoutTime to 0". Some AD docs suggest
        // deleting the attribute, which Samba and AD both treat equivalently.
        await client.modify(
          beforeUser.distinguishedName,
          new Change({
            operation: 'replace',
            modification: new Attribute({ type: 'lockoutTime', values: ['0'] }),
          }),
        );
        // Verify by re-reading.
        const afterEntry = await this.findUserEntry(client, userId);
        const after = afterEntry ? normalizeUser(afterEntry) : null;
        return {
          ok: true,
          before: { lockoutTime: target.lockoutTime ?? '0', locked: true },
          after: { lockoutTime: '0', locked: after?.locked ?? false },
        };
      } catch (err) {
        return {
          ok: false,
          reason: 'directory_error',
          errorMessage: err instanceof Error ? err.message : 'modify failed',
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Set `unicodePwd` to a new value. AD requires this to be a UTF-16LE
   * encoding of the password wrapped in double quotes, transmitted over
   * LDAPS (the cleartext-on-the-wire requirement is enforced by AD itself).
   *
   * If `forceChangeAtNextLogin` is true, also set `pwdLastSet=0`. AD treats
   * that as "needs to change on next sign-in".
   */
  async resetPassword(
    userId: DirectoryObjectIdentifier,
    input: ResetPasswordInput,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);

        const changes: Change[] = [
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'unicodePwd',
              values: [encodeUnicodePassword(input.newPassword)],
            }),
          }),
        ];
        if (input.forceChangeAtNextLogin) {
          changes.push(
            new Change({
              operation: 'replace',
              modification: new Attribute({ type: 'pwdLastSet', values: ['0'] }),
            }),
          );
        }

        await client.modify(before.distinguishedName, changes);

        const afterEntry = await this.findUserEntry(client, userId);
        const after = afterEntry ? normalizeUser(afterEntry) : null;
        return {
          ok: true,
          // Don't echo passwords back; record only the operation shape so the
          // audit row carries the "what" without the "how".
          before: {
            passwordLastSetAt: before.passwordLastSetAt?.toISOString() ?? null,
          },
          after: {
            passwordLastSetAt: after?.passwordLastSetAt?.toISOString() ?? null,
            forceChangeAtNextLogin: input.forceChangeAtNextLogin,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'modify failed';
        const isPolicy = /policy|complexity|length|history/i.test(message);
        return {
          ok: false,
          reason: isPolicy ? 'policy_violation' : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  enableUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult> {
    return this.toggleAccountDisable(userId, ctx, false);
  }

  disableUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult> {
    return this.toggleAccountDisable(userId, ctx, true);
  }

  /**
   * Flip the ACCOUNTDISABLE bit (0x2) of `userAccountControl`. Reads the
   * current UAC value from the live entry so we don't clobber other bits
   * (DONT_EXPIRE_PASSWORD, etc).
   */
  private async toggleAccountDisable(
    userId: DirectoryObjectIdentifier,
    ctx: WriteContext,
    disable: boolean,
  ): Promise<MutationResult> {
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);
        const currentUacRaw = (target as { userAccountControl?: string | string[] })
          .userAccountControl;
        const currentUac = Array.isArray(currentUacRaw)
          ? currentUacRaw[currentUacRaw.length - 1]
          : currentUacRaw;
        const uacNum = currentUac ? Number.parseInt(String(currentUac), 10) : 0;
        if (!Number.isFinite(uacNum)) {
          return {
            ok: false,
            reason: 'directory_error',
            errorMessage: 'unparseable userAccountControl',
          };
        }
        const nextUac = disable ? uacNum | UAC.ACCOUNTDISABLE : uacNum & ~UAC.ACCOUNTDISABLE;
        if (nextUac === uacNum) {
          // Idempotent no-op.
          return {
            ok: true,
            before: { enabled: before.enabled, userAccountControl: uacNum },
            after: { enabled: before.enabled, userAccountControl: uacNum },
          };
        }

        await client.modify(
          before.distinguishedName,
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'userAccountControl',
              values: [String(nextUac)],
            }),
          }),
        );

        const afterEntry = await this.findUserEntry(client, userId);
        const after = afterEntry ? normalizeUser(afterEntry) : null;
        return {
          ok: true,
          before: { enabled: before.enabled, userAccountControl: uacNum },
          after: {
            enabled: after?.enabled ?? !disable,
            userAccountControl: nextUac,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'modify failed';
        const isAuthz = /no write|insuff/i.test(message);
        return {
          ok: false,
          reason: isAuthz ? 'permission_denied' : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }
  /**
   * Replace a small allowlist of mutable user attributes. Follows the same
   * write-as-user model as `unlockUser`: bind as the operator, resolve the
   * target, apply replace/delete modifications, re-read for verification.
   *
   * For each patch field:
   *   - undefined: not in the patch, do nothing.
   *   - null:      caller wants the AD attribute removed (delete operation).
   *   - string:    replace with the trimmed value (or delete if it trims empty).
   */
  async updateUserAttributes(
    userId: DirectoryObjectIdentifier,
    patch: UserAttributePatch,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return {
          ok: false,
          reason: 'permission_denied',
          errorMessage: 'step-up bind failed',
        };
      }
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);

        const changes = buildAttributeChanges(patch);
        if (changes.length === 0) {
          // Idempotent no-op: nothing changed.
          return { ok: true, before: snapshotForAudit(before), after: snapshotForAudit(before) };
        }

        await client.modify(before.distinguishedName, changes);

        // Re-read so the route can return the actual post-write state.
        const afterEntry = await this.findUserEntry(client, userId);
        const after = afterEntry ? normalizeUser(afterEntry) : null;
        return {
          ok: true,
          before: snapshotForAudit(before),
          after: after ? snapshotForAudit(after) : {},
        };
      } catch (err) {
        // AD will reject writes the operator isn't authorized for with
        // 0x32 (50) or 0x10 (16). Surface as permission_denied so the route
        // can map to a 403 and the audit row gets the right error_code.
        const message = err instanceof Error ? err.message : 'modify failed';
        const isAuthz = /no write|insuff/i.test(message);
        return {
          ok: false,
          reason: isAuthz ? 'permission_denied' : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }
  addUserToGroup(
    userId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.modifyGroupMembership(userId, groupId, ctx, 'add');
  }

  removeUserFromGroup(
    userId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.modifyGroupMembership(userId, groupId, ctx, 'delete');
  }

  /**
   * Add or remove a user's DN from a group's `member` attribute. Same write-
   * as-user pattern as the other writes; idempotent (no-op if already in the
   * desired state).
   */
  private async modifyGroupMembership(
    userId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
    op: 'add' | 'delete',
  ): Promise<MutationResult> {
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        const userEntry = await this.findUserEntry(client, userId);
        if (!userEntry) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const groupEntry = await this.findGroupEntry(client, groupId);
        if (!groupEntry) return { ok: false, reason: 'not_found', errorMessage: 'group not found' };
        const user = normalizeUser(userEntry);
        const group = normalizeGroup(groupEntry);
        const userDnLc = user.distinguishedName.toLowerCase();
        const isMember = group.memberDns.some((dn) => dn.toLowerCase() === userDnLc);

        if (op === 'add' && isMember) {
          return {
            ok: true,
            before: { isMember: true },
            after: { isMember: true },
          };
        }
        if (op === 'delete' && !isMember) {
          return {
            ok: true,
            before: { isMember: false },
            after: { isMember: false },
          };
        }

        await client.modify(
          group.distinguishedName,
          new Change({
            operation: op,
            modification: new Attribute({
              type: 'member',
              values: [user.distinguishedName],
            }),
          }),
        );

        return {
          ok: true,
          before: { isMember, group: group.distinguishedName, user: user.distinguishedName },
          after: {
            isMember: op === 'add',
            group: group.distinguishedName,
            user: user.distinguishedName,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'modify failed';
        const isAuthz = /no write|insuff/i.test(message);
        return {
          ok: false,
          reason: isAuthz ? 'permission_denied' : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Move a user to a different OU. AD permits this via modifyDN: keep the
   * user's existing RDN (the CN=…) but change its parent to `targetOuDn`.
   * ldapts accepts a full new DN as the second argument and translates it
   * into the wire-level Modify DN request (with `newSuperior` set to the
   * target OU).
   *
   * Idempotent: if the user is already directly under `targetOuDn`, returns
   * `ok: true` with a no-op snapshot so the caller doesn't have to special-
   * case the case where someone clicked "Move" without changing the value.
   *
   * `objectGuid` survives a move, so cached IDs (memberships, audit
   * targetId) remain valid — only the DN changes, which `userLiveRefresh`
   * will pick up at the route layer.
   */
  async moveUser(
    userId: DirectoryObjectIdentifier,
    targetOuDn: string,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    const trimmedTarget = targetOuDn.trim();
    if (!trimmedTarget) {
      return { ok: false, reason: 'directory_error', errorMessage: 'empty target OU' };
    }
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);
        const currentParent = parentDn(before.distinguishedName);
        // Compare case-insensitively — AD treats DN components as case-
        // insensitive even though it preserves the casing on writes.
        if (currentParent && currentParent.toLowerCase() === trimmedTarget.toLowerCase()) {
          return {
            ok: true,
            before: { distinguishedName: before.distinguishedName, parentDn: currentParent },
            after: { distinguishedName: before.distinguishedName, parentDn: currentParent },
          };
        }

        const rdn = leafRdn(before.distinguishedName);
        const newDn = `${rdn},${trimmedTarget}`;
        await client.modifyDN(before.distinguishedName, newDn);

        return {
          ok: true,
          before: {
            distinguishedName: before.distinguishedName,
            parentDn: currentParent,
          },
          after: {
            distinguishedName: newDn,
            parentDn: trimmedTarget,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'modify failed';
        const isAuthz = /no write|insuff|access/i.test(message);
        return {
          ok: false,
          reason: isAuthz ? 'permission_denied' : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Create an organizationalUnit directly under `parentDn`. Same write-as-
   * user pattern as the other writes — the operator's bind owns the new
   * object's ACL trail. Returns the resulting OU so the cache can be
   * updated without waiting for the next sync.
   *
   * The DN is computed as `OU=<escaped-name>,<parentDn>`. The route layer
   * is responsible for validating that `parentDn` exists in our cache; we
   * trust it here.
   */
  async createOu(
    parentDn: string,
    name: string,
    description: string | null,
    ctx: WriteContext,
  ): Promise<MutationResult & { ou?: DirectoryOu }> {
    const cleanName = name.trim();
    if (!cleanName) {
      return { ok: false, reason: 'directory_error', errorMessage: 'empty OU name' };
    }
    const cleanParent = parentDn.trim();
    if (!cleanParent) {
      return { ok: false, reason: 'directory_error', errorMessage: 'empty parent DN' };
    }
    const escapedName = escapeRdnValue(cleanName);
    const newDn = `OU=${escapedName},${cleanParent}`;

    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        const attrs: Record<string, string | string[]> = {
          objectClass: ['top', 'organizationalUnit'],
          ou: cleanName,
        };
        if (description && description.trim()) {
          attrs.description = description.trim();
        }
        await client.add(newDn, attrs);

        const ou: DirectoryOu = {
          distinguishedName: newDn,
          name: cleanName,
          parentDn: cleanParent,
          rawAttributes: {
            objectClass: ['top', 'organizationalUnit'],
            ou: cleanName,
            ...(description && description.trim() ? { description: description.trim() } : {}),
          },
        };
        return {
          ok: true,
          after: { distinguishedName: newDn, name: cleanName, parentDn: cleanParent },
          ou,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'add failed';
        // 68 = entryAlreadyExists. Surface as a clean conflict reason so the
        // route can map it to a 409 instead of a generic 502.
        const isExists = /already exists|entryAlreadyExists/i.test(message);
        const isAuthz = /no write|insuff|access/i.test(message);
        return {
          ok: false,
          reason: isExists ? 'policy_violation' : isAuthz ? 'permission_denied' : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Delete an OU. The route already verified the OU is empty in our cache,
   * but AD will independently refuse to delete a non-empty container — if
   * a stale cache lets us through here, the LDAP layer becomes the
   * authoritative gate and we surface that as policy_violation.
   */
  async deleteOu(dn: string, ctx: WriteContext): Promise<MutationResult> {
    const cleanDn = dn.trim();
    if (!cleanDn) {
      return { ok: false, reason: 'directory_error', errorMessage: 'empty DN' };
    }
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        await client.del(cleanDn);
        return {
          ok: true,
          before: { distinguishedName: cleanDn },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'del failed';
        // 66 = notAllowedOnNonLeaf. AD returns this when the OU still has
        // children. 53 = unwillingToPerform — what AD returns for the
        // "Protect from accidental deletion" flag (a deny ACE on the OU
        // that blocks the delete primitive). Surface both as policy
        // violations so the operator sees the actual reason rather than a
        // generic 502.
        const isNonLeaf = /not.?allowed on non.?leaf|65|66/i.test(message);
        const isProtected = /unwilling|access denied|insufficient/i.test(message);
        const isAuthz = /no write|insuff/i.test(message);
        return {
          ok: false,
          reason:
            isNonLeaf || isProtected
              ? 'policy_violation'
              : isAuthz
                ? 'permission_denied'
                : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Update mutable OU attributes. Same write-as-user pattern as the user
   * attribute writes. Today only `description` is supported — the patch
   * type leaves room for additional fields without changing the call shape.
   *
   * Patch semantics match `updateUserAttributes`:
   *   undefined → skip
   *   null      → delete the attribute
   *   string    → replace (or delete if it trims to empty)
   */
  async updateOuAttributes(
    dn: string,
    patch: OuAttributePatch,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    const cleanDn = dn.trim();
    if (!cleanDn) {
      return { ok: false, reason: 'directory_error', errorMessage: 'empty DN' };
    }
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        const changes: Change[] = [];

        if (patch.description !== undefined) {
          if (patch.description === null || patch.description.trim() === '') {
            changes.push(
              new Change({
                operation: 'delete',
                modification: new Attribute({ type: 'description', values: [] }),
              }),
            );
          } else {
            changes.push(
              new Change({
                operation: 'replace',
                modification: new Attribute({
                  type: 'description',
                  values: [patch.description.trim()],
                }),
              }),
            );
          }
        }

        if (changes.length === 0) {
          // Idempotent no-op — nothing to write.
          return {
            ok: true,
            before: { distinguishedName: cleanDn },
            after: { distinguishedName: cleanDn },
          };
        }

        await client.modify(cleanDn, changes);
        return {
          ok: true,
          before: { distinguishedName: cleanDn },
          after: {
            distinguishedName: cleanDn,
            description: patch.description === null ? null : (patch.description?.trim() ?? null),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'modify failed';
        const isAuthz = /no write|insuff|access/i.test(message);
        return {
          ok: false,
          reason: isAuthz ? 'permission_denied' : 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  // ---- Deleted users (Recycle Bin / tombstones) ---------------------------
  //
  // All four methods bind as the OPERATOR (write-as-user model), not the
  // service account. Rationale:
  //   1. The Deleted Objects container is restricted to Domain Admins by
  //      default. Letting AD's own ACLs decide who can read it means we
  //      don't have to grant the service account special access via
  //      `dsacls` — operators with the right see, others don't.
  //   2. Reanimate Tombstones is an extended right typically granted to
  //      Domain Admins only. Restore-as-operator means a Helpdesk-tier
  //      admin who lacks the right gets a clean LDAP error instead of
  //      the service account doing it on their behalf.
  //   3. The audit trail at the directory layer reflects the actual
  //      operator's identity, not "service account did it".
  //
  // The route layer enforces step-up before calling these so the
  // operator's bind password is in the credential cache. Bind failure
  // throws `StepUpBindFailedError`, which the route maps to a 401/403
  // prompting re-elevation.

  async getRecycleBinStatus(ctx: WriteContext): Promise<RecycleBinStatus> {
    return this._withOperatorBind(ctx, async (client) => {
      const { searchEntries: dseEntries } = await client.search('', {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['configurationNamingContext', 'defaultNamingContext'],
      });
      const dse = dseEntries[0] ?? {};
      const configNc = asString((dse as Record<string, unknown>).configurationNamingContext);
      const defaultNc = asString((dse as Record<string, unknown>).defaultNamingContext);
      const deletedObjectsContainer = defaultNc ? `CN=Deleted Objects,${defaultNc}` : null;

      if (!configNc) {
        return {
          recycleBinEnabled: false,
          deletedObjectsContainer,
          message: 'rootDSE did not return configurationNamingContext',
        };
      }
      const featureDn = `CN=Recycle Bin Feature,CN=Optional Features,CN=Directory Service,CN=Windows NT,CN=Services,${configNc}`;
      try {
        const { searchEntries: feature } = await client.search(featureDn, {
          scope: 'base',
          filter: '(objectClass=*)',
          attributes: ['msDS-EnabledFeatureBL', 'cn'],
        });
        const entry = feature[0];
        if (!entry) {
          return { recycleBinEnabled: false, deletedObjectsContainer, message: null };
        }
        const enabledOn = asStringArray(
          (entry as Record<string, unknown>)['msDS-EnabledFeatureBL'],
        );
        return { recycleBinEnabled: enabledOn.length > 0, deletedObjectsContainer, message: null };
      } catch (err) {
        // NoSuchObject (32) when the feature object hasn't been
        // provisioned. InsufficientAccess (50) when the operator lacks
        // read on the Optional Features container. Authenticated Users
        // can usually read it; if they can't we surface it as
        // "verification failed" so the UI banner doesn't lie about state.
        const message = err instanceof Error ? err.message : 'feature lookup failed';
        return { recycleBinEnabled: false, deletedObjectsContainer, message };
      }
    });
  }

  /**
   * Search the Deleted Objects container as the operator. AD's ACLs
   * decide what comes back — operators without read on that container
   * see an empty list (LDAP returns no entries rather than erroring).
   *
   * Excludes `isRecycled=TRUE` entries — those have crossed the
   * deleted-object lifetime, AD has stripped them down to tombstone
   * form, and reanimation is no longer possible.
   */
  async searchDeletedUsers(
    query: DeletedUserSearchInput,
    ctx: WriteContext,
  ): Promise<DirectoryDeletedUser[]> {
    return this._withOperatorBind(ctx, async (client) => {
      const containerDn = await this._resolveDeletedObjectsContainer(client);
      if (!containerDn) return [];
      const baseClauses: string[] = [
        '(isDeleted=TRUE)',
        '(!(isRecycled=TRUE))',
        '(objectClass=user)',
        '(!(objectClass=computer))',
      ];
      if (query.text) {
        const t = escapeLdapFilter(query.text);
        baseClauses.push(
          `(|(displayName=*${t}*)(sAMAccountName=*${t}*)(userPrincipalName=*${t}*)(mail=*${t}*)(cn=*${t}*))`,
        );
      }
      const filter = `(&${baseClauses.join('')})`;
      const { searchEntries } = await client.search(
        containerDn,
        {
          scope: 'sub',
          filter,
          attributes: DELETED_USER_ATTRS,
          explicitBufferAttributes: BINARY_ATTRS,
          paged: { pageSize: query.pageSize ?? 200 },
        },
        deletedObjectControls(),
      );
      return searchEntries.map(normalizeDeletedUser);
    });
  }

  async getDeletedUser(
    objectGuid: string,
    ctx: WriteContext,
  ): Promise<DirectoryDeletedUser | null> {
    return this._withOperatorBind(ctx, async (client) => {
      const containerDn = await this._resolveDeletedObjectsContainer(client);
      if (!containerDn) return null;
      const filter = new EqualityFilter({
        attribute: 'objectGUID',
        value: objectGuidFromString(objectGuid),
      });
      const { searchEntries } = await client.search(
        containerDn,
        {
          scope: 'sub',
          filter,
          attributes: DELETED_USER_ATTRS,
          explicitBufferAttributes: BINARY_ATTRS,
          sizeLimit: 1,
        },
        deletedObjectControls(),
      );
      const entry = searchEntries[0];
      return entry ? normalizeDeletedUser(entry) : null;
    });
  }

  /**
   * Search the Deleted Objects container for tombstoned computer accounts.
   * Same operator-bind / write-as-user model as `searchDeletedUsers`.
   * Excludes recycled entries (same rationale: AD has stripped them past
   * the point of useful display).
   */
  async searchDeletedComputers(
    query: DeletedComputerSearchInput,
    ctx: WriteContext,
  ): Promise<DirectoryDeletedComputer[]> {
    return this._withOperatorBind(ctx, async (client) => {
      const containerDn = await this._resolveDeletedObjectsContainer(client);
      if (!containerDn) return [];
      const baseClauses: string[] = [
        '(isDeleted=TRUE)',
        '(!(isRecycled=TRUE))',
        '(objectClass=computer)',
      ];
      if (query.text) {
        const t = escapeLdapFilter(query.text);
        baseClauses.push(
          `(|(cn=*${t}*)(sAMAccountName=*${t}*)(dNSHostName=*${t}*)(operatingSystem=*${t}*))`,
        );
      }
      const filter = `(&${baseClauses.join('')})`;
      const { searchEntries } = await client.search(
        containerDn,
        {
          scope: 'sub',
          filter,
          attributes: DELETED_COMPUTER_ATTRS,
          explicitBufferAttributes: BINARY_ATTRS,
          paged: { pageSize: query.pageSize ?? 200 },
        },
        deletedObjectControls(),
      );
      return searchEntries.map(normalizeDeletedComputer);
    });
  }

  async getDeletedComputer(
    objectGuid: string,
    ctx: WriteContext,
  ): Promise<DirectoryDeletedComputer | null> {
    return this._withOperatorBind(ctx, async (client) => {
      const containerDn = await this._resolveDeletedObjectsContainer(client);
      if (!containerDn) return null;
      const filter = new EqualityFilter({
        attribute: 'objectGUID',
        value: objectGuidFromString(objectGuid),
      });
      const { searchEntries } = await client.search(
        containerDn,
        {
          scope: 'sub',
          filter,
          attributes: DELETED_COMPUTER_ATTRS,
          explicitBufferAttributes: BINARY_ATTRS,
          sizeLimit: 1,
        },
        deletedObjectControls(),
      );
      const entry = searchEntries[0];
      return entry ? normalizeDeletedComputer(entry) : null;
    });
  }

  /**
   * Reanimate a deleted user via the AD reanimation primitive: a single
   * modify request against the deleted DN containing
   *   1. delete `isDeleted` (no values)
   *   2. replace `distinguishedName` with the target DN
   * with the show-deleted control attached. AD recognizes this exact
   * shape as a tombstone reanimation (MS-ADTS §3.1.1.5.5.6).
   *
   * Target DN composition:
   *   - Strip the `\nADEL:<guid>` suffix from the deleted entry's leftmost
   *     RDN to recover the original CN.
   *   - Combine with the operator-supplied targetParentDn, falling back
   *     to lastKnownParent.
   *
   * Failure surface:
   *   - Recycled entries return policy_violation — AD will reject; we
   *     short-circuit with a clearer reason.
   *   - Missing parent (deleted, never existed, or operator typo) returns
   *     policy_violation with a message pointing at the parent DN.
   *   - Insufficient rights (no Reanimate Tombstones extended right) maps
   *     to permission_denied so the route can return 403 with a clear
   *     "your account is missing the extended right" message.
   */
  async restoreDeletedUser(
    objectGuid: string,
    input: RestoreUserInput,
    ctx: WriteContext,
  ): Promise<RestoreResult> {
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        return { ok: false, reason: 'permission_denied', errorMessage: 'step-up bind failed' };
      }
      try {
        const containerDn = await this._resolveDeletedObjectsContainer(client);
        if (!containerDn) {
          return {
            ok: false,
            reason: 'directory_error',
            errorMessage: 'could not locate Deleted Objects container',
          };
        }
        const filter = new EqualityFilter({
          attribute: 'objectGUID',
          value: objectGuidFromString(objectGuid),
        });
        const { searchEntries } = await client.search(
          containerDn,
          {
            scope: 'sub',
            filter,
            attributes: DELETED_USER_ATTRS,
            explicitBufferAttributes: BINARY_ATTRS,
            sizeLimit: 1,
          },
          deletedObjectControls(),
        );
        const entry = searchEntries[0];
        if (!entry) {
          return { ok: false, reason: 'not_found', errorMessage: 'deleted user not found' };
        }
        const before = normalizeDeletedUser(entry);
        if (before.recycled) {
          return {
            ok: false,
            reason: 'policy_violation',
            errorMessage: 'entry is recycled and cannot be reanimated',
          };
        }

        const targetParent = input.targetParentDn?.trim() || before.lastKnownParent;
        if (!targetParent) {
          return {
            ok: false,
            reason: 'policy_violation',
            errorMessage:
              'no lastKnownParent on entry and no targetParentDn supplied — specify a parent OU',
          };
        }
        const cn = before.cn ?? '';
        if (!cn) {
          return {
            ok: false,
            reason: 'directory_error',
            errorMessage: 'deleted entry has no recoverable CN',
          };
        }
        // RFC 4514 strict escape — escapes commas/equals/etc. in the CN
        // but leaves interior spaces alone. AD's reanimation primitive is
        // strict about the new DN format and rejects over-escaped values
        // (e.g. "CN=John\ Doe,...") with unwillingToPerform.
        const newDn = `CN=${escapeRdnValueRfc(cn)},${targetParent}`;

        // Send only ShowDeleted on the modify, not ShowRecycled. The
        // reanimation primitive requires ShowDeleted (the modify-of-
        // deleted-object semantics it triggers); ShowRecycled is for
        // operating on already-recycled entries (which can't be
        // reanimated) and some AD versions reject the combination on a
        // non-recycled tombstone with data 8349 (DECODING_ERROR).
        try {
          await client.modify(
            before.deletedDn,
            [
              new Change({
                operation: 'delete',
                modification: new Attribute({ type: 'isDeleted', values: [] }),
              }),
              new Change({
                operation: 'replace',
                modification: new Attribute({
                  type: 'distinguishedName',
                  values: [newDn],
                }),
              }),
            ],
            new ShowDeletedControl(),
          );
        } catch (modifyErr) {
          // 50 = insufficient rights (operator lacks Reanimate Tombstones).
          // 53 = unwillingToPerform (modify shape rejected, missing
          //      parent, etc.).
          // 68 = entryAlreadyExists (another object lives at target DN).
          // Surface the diagnostic context — operators chasing a
          // reanimation failure need to see the exact DNs we sent so
          // they can verify the parent OU is right and rule out CN
          // escaping issues.
          const message = modifyErr instanceof Error ? modifyErr.message : 'modify failed';
          const isAuthz = /no write|insuff|access denied|0000.{0,4}50/i.test(message);
          const isExists = /already exists|entryAlreadyExists|0000.{0,4}68/i.test(message);
          const isUnwilling = /unwilling|0000.{0,4}53/i.test(message);
          return {
            ok: false,
            reason: isAuthz
              ? 'permission_denied'
              : isExists || isUnwilling
                ? 'policy_violation'
                : 'directory_error',
            errorMessage: `${message} | newDn="${newDn}" | deletedDn="${before.deletedDn}"`,
          };
        }

        return {
          ok: true,
          before: {
            deletedDn: before.deletedDn,
            lastKnownParent: before.lastKnownParent,
            cn: before.cn,
          },
          after: {
            distinguishedName: newDn,
            parentDn: targetParent,
          },
          restoredDn: newDn,
        };
      } catch (err) {
        // Errors from the prep phase (rootDSE read, deleted-entry search,
        // normalization). The modify itself has its own catch above.
        const message = err instanceof Error ? err.message : 'restore failed';
        return {
          ok: false,
          reason: 'directory_error',
          errorMessage: message,
        };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  // ---- Helpers -----------------------------------------------------------

  /**
   * Run `fn` against an LDAP client bound as the operator (write-as-user).
   * Used by reads that intentionally route through the operator's ACLs
   * (deleted-objects browsing) so AD's own access control decides
   * visibility — see the deleted-users section header for rationale.
   *
   * Bind failure throws `StepUpBindFailedError` so the route can map it
   * to a 401/403 prompting re-elevation, distinct from a generic 502
   * directory_error.
   */
  private async _withOperatorBind<T>(
    ctx: WriteContext,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    return withFailover(this.clientConfig, async (client) => {
      try {
        await client.bind(ctx.actorUsername, ctx.actorPassword);
      } catch {
        throw new StepUpBindFailedError();
      }
      try {
        return await fn(client);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Read the rootDSE for `defaultNamingContext` and derive the
   * `CN=Deleted Objects,<defaultNC>` DN. The rootDSE is anonymously
   * readable on AD so this never fails for permission reasons; returns
   * null only when the rootDSE itself didn't include the attribute,
   * which would indicate a non-AD or badly misconfigured directory.
   */
  private async _resolveDeletedObjectsContainer(client: Client): Promise<string | null> {
    const { searchEntries } = await client.search('', {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['defaultNamingContext'],
    });
    const dse = searchEntries[0];
    const defaultNc = dse ? asString((dse as Record<string, unknown>).defaultNamingContext) : null;
    return defaultNc ? `CN=Deleted Objects,${defaultNc}` : null;
  }

  private async withServiceBind<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    return withFailover(this.clientConfig, async (client) => {
      await client.bind(this.config.serviceAccountUpn, this.config.serviceAccountPassword);
      try {
        return await fn(client);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  private async searchOne(
    client: Client,
    base: string,
    filter: string | Filter,
    attributes: string[],
  ): Promise<Entry | null> {
    const { searchEntries } = await client.search(base, {
      scope: 'sub',
      filter,
      attributes,
      explicitBufferAttributes: BINARY_ATTRS,
      sizeLimit: 1,
    });
    return searchEntries[0] ?? null;
  }

  private async findUserEntry(
    client: Client,
    identifier: DirectoryObjectIdentifier,
    attributes: readonly string[] = USER_ATTRS,
  ): Promise<Entry | null> {
    const filter = identifierToFilter(identifier, USER_FILTER_BASE);
    return this.searchOne(client, this.config.baseDn, filter, [...attributes]);
  }

  private async findGroupEntry(
    client: Client,
    identifier: DirectoryObjectIdentifier,
  ): Promise<Entry | null> {
    const filter = identifierToFilter(identifier, GROUP_FILTER_BASE);
    return this.searchOne(client, this.config.baseDn, filter, GROUP_ATTRS);
  }

  private async findComputerEntry(
    client: Client,
    identifier: DirectoryObjectIdentifier,
    attributes: readonly string[] = COMPUTER_ATTRS,
  ): Promise<Entry | null> {
    const filter = identifierToFilter(identifier, COMPUTER_FILTER_BASE);
    return this.searchOne(client, this.config.baseDn, filter, [...attributes]);
  }

  private buildComputerFilter(query: DirectoryComputerSearchQuery): string {
    const clauses: string[] = [COMPUTER_FILTER_BASE];
    if (query.text) {
      const t = escapeLdapFilter(query.text);
      clauses.push(`(|(cn=*${t}*)(sAMAccountName=*${t}*)(dNSHostName=*${t}*)(description=*${t}*))`);
    }
    if (query.enabled === true) {
      clauses.push('(!(userAccountControl:1.2.840.113556.1.4.803:=2))');
    } else if (query.enabled === false) {
      clauses.push('(userAccountControl:1.2.840.113556.1.4.803:=2)');
    }
    if (query.operatingSystem) {
      clauses.push(`(operatingSystem=${escapeLdapFilter(query.operatingSystem)})`);
    }
    return clauses.length === 1 ? clauses[0]! : `(&${clauses.join('')})`;
  }

  private buildUserFilter(query: DirectoryUserSearchQuery): string {
    const clauses: string[] = [USER_FILTER_BASE];
    if (query.text) {
      const t = escapeLdapFilter(query.text);
      clauses.push(
        `(|(displayName=*${t}*)(sAMAccountName=*${t}*)(userPrincipalName=*${t}*)(mail=*${t}*))`,
      );
    }
    if (query.enabled === true) {
      // Enabled = userAccountControl bit 2 (ACCOUNTDISABLE) NOT set.
      // LDAP_MATCHING_RULE_BIT_AND OID = 1.2.840.113556.1.4.803.
      clauses.push('(!(userAccountControl:1.2.840.113556.1.4.803:=2))');
    } else if (query.enabled === false) {
      clauses.push('(userAccountControl:1.2.840.113556.1.4.803:=2)');
    }
    if (query.locked === true) {
      // Cheap server-side approximation: lockoutTime present and non-zero.
      // The cache layer applies the strict isLocked() check on read.
      clauses.push('(&(lockoutTime=*)(!(lockoutTime=0)))');
    } else if (query.locked === false) {
      clauses.push('(|(!(lockoutTime=*))(lockoutTime=0))');
    }
    return clauses.length === 1 ? clauses[0]! : `(&${clauses.join('')})`;
  }

  private async *streamSearch<T>(
    filter: string,
    attributes: string[],
    pageSize: number,
    map: (e: Entry) => T,
  ): AsyncIterable<T> {
    // ldapts paged search returns all entries together (it manages the
    // cookie internally). For very large directories a true streaming API
    // would help; for MVP scale (low tens of thousands) batching is fine.
    yield* await this.withServiceBind(async (client) => {
      const { searchEntries } = await client.search(this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes,
        explicitBufferAttributes: BINARY_ATTRS,
        paged: { pageSize },
      });
      return searchEntries.map(map);
    });
  }
}

// ---- Module-private helpers ---------------------------------------------

function looksLikeUpn(s: string): boolean {
  return s.includes('@') && !s.includes('=');
}

/**
 * Map an LDAP bind failure to an AuthResult with a useful reason + message.
 *
 * Three families of errors land here:
 *   1. Network / TLS failures (e.g. self-signed cert with reject_unauthorized,
 *      ECONNREFUSED, hostname mismatch). These have a Node `code` like
 *      `ECONNREFUSED` / `CERT_*` and no LDAP `code`. Return `directory_error`
 *      so the route can return 502 instead of misleading 401.
 *   2. LDAP credential errors (code 49). AD encodes a subcode in the message
 *      text — pull it out so operators see "wrong password" vs "user not
 *      found" vs "account disabled" vs "password expired" instead of a
 *      generic "invalid credentials".
 *   3. Anything else (e.g. server-side timeout, protocol error). Surface
 *      the message verbatim so the operator can see what AD said.
 */
function classifyBindError(err: unknown): AuthResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown }).code;
  const name = (err as { name?: string }).name ?? '';

  // Network / TLS failures — Node error codes are strings, never the LDAP 49.
  if (typeof code === 'string') {
    return {
      ok: false,
      reason: 'directory_error',
      errorMessage: `cannot reach directory: ${message}`,
    };
  }

  const isLdap49 = code === 49 || name === 'InvalidCredentialsError';

  // AD subcodes appear as "data XXX" in the diagnostic message of a 49.
  // The hex codes are documented at MS-ADTS §3.1.1.5.5 (ERROR_*).
  const sub = /data\s+([0-9a-f]+)/i.exec(message)?.[1]?.toLowerCase();

  if (isLdap49 || sub) {
    switch (sub) {
      case '525':
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'user not found in this directory',
        };
      case '52e':
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'wrong password',
        };
      case '530':
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'this account is not allowed to sign in at this time',
        };
      case '531':
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'this account is not allowed to sign in from this host',
        };
      case '532':
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'password expired — change it on a Windows machine first',
        };
      case '533':
        return {
          ok: false,
          reason: 'account_disabled',
          errorMessage: 'account is disabled',
        };
      case '701':
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'account has expired',
        };
      case '773':
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'password must be changed before signing in',
        };
      case '775':
        return {
          ok: false,
          reason: 'account_locked',
          errorMessage: 'account is locked out',
        };
      default:
        return {
          ok: false,
          reason: 'invalid_credentials',
          errorMessage: 'invalid username or password',
        };
    }
  }

  // Catch-all: surface what we got rather than pretending it's a credential
  // problem. Operators chasing a misconfigured DC need to see the real cause.
  return {
    ok: false,
    reason: 'directory_error',
    errorMessage: `bind failed: ${message}`,
  };
}

/**
 * Escape a value for use inside an RDN (e.g. the `<value>` in `OU=<value>`).
 * Per RFC 4514, these characters must be backslash-escaped: comma, plus,
 * less-than, greater-than, semicolon, double-quote, equals, backslash, and
 * the null byte. Leading/trailing space and a leading `#` also need escaping
 * — the route layer trims, but a name like "  Foo" or "#Bar" would still
 * need handling. The route's name regex already rejects these characters,
 * but escape here too as defense-in-depth so a future relaxation of that
 * regex can't produce a malformed DN.
 *
 * NOTE: this function escapes every space inside the value. That's
 * over-aggressive vs. RFC 4514 (which only requires leading/trailing
 * space escaping). AD accepts the over-escaped form for object creation
 * but rejects it for tombstone reanimation — see `escapeRdnValueRfc`
 * below for the strict version used by restoreDeletedUser.
 */
function escapeRdnValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- NUL is intentionally escaped per RFC 4514 §2.4
  return value.replace(/[,+<>;"=\\ ]/g, (m) => `\\${m}`);
}

/**
 * Strict RFC 4514 §2.4 RDN value escaping. Used for tombstone
 * reanimation, where AD's modify primitive validates the new DN
 * strictly: comma/equals/etc. inside a CN must be escaped, but spaces
 * in the middle of the value must NOT be escaped. The general-purpose
 * `escapeRdnValue` above is over-aggressive for that case.
 */
function escapeRdnValueRfc(value: string): string {
  if (!value) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (
      ch === ',' ||
      ch === '+' ||
      ch === '"' ||
      ch === '\\' ||
      ch === '<' ||
      ch === '>' ||
      ch === ';' ||
      ch === '=' ||
      ch === '\x00'
    ) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  if (out.startsWith('#') || out.startsWith(' ')) out = '\\' + out;
  if (out.length > 1 && out.endsWith(' ')) out = out.slice(0, -1) + '\\ ';
  return out;
}

/**
 * Build the search filter for a target identifier.
 *
 * For `objectGuid` we return an EqualityFilter with the value as a Buffer.
 * Two reasons:
 *   1. ldapts's string filter parser does not interpret `\xx` byte-escape
 *      sequences the way LDAP servers do, so a string filter for binary
 *      attributes silently matches nothing.
 *   2. objectGUID is unique across the directory, so we don't need to AND
 *      with the user/group base filter — uniqueness already disambiguates.
 *
 * For string-valued identifiers a string filter is fine and reads more
 * naturally in logs.
 */
function identifierToFilter(
  identifier: DirectoryObjectIdentifier,
  baseFilter: string,
): string | Filter {
  switch (identifier.kind) {
    case 'objectGuid':
      return new EqualityFilter({
        attribute: 'objectGUID',
        value: objectGuidFromString(identifier.value),
      });
    case 'distinguishedName':
      return `(&${baseFilter}(distinguishedName=${escapeLdapFilter(identifier.value)}))`;
    case 'samAccountName':
      return `(&${baseFilter}(sAMAccountName=${escapeLdapFilter(identifier.value)}))`;
    case 'userPrincipalName':
      return `(&${baseFilter}(userPrincipalName=${escapeLdapFilter(identifier.value)}))`;
  }
}

function formatGeneralizedTime(date: Date): string {
  // YYYYMMDDhhmmss.0Z — what AD expects for whenChanged comparisons.
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    '.0Z'
  );
}

// Silence the unused-import lint for `isLocked` — kept available for future use.
void isLocked;

// ---------------------------------------------------------------------------
// Attribute-update helpers

/** Map our scalar patch field name → the AD attribute name we write to. */
const PATCH_ATTRIBUTE_MAP: Record<string, string> = {
  displayName: 'displayName',
  givenName: 'givenName',
  surname: 'sn',
  email: 'mail',
  phone: 'telephoneNumber',
  mobile: 'mobile',
  title: 'title',
  department: 'department',
  employeeID: 'employeeID',
  employeeNumber: 'employeeNumber',
  ipPhone: 'ipPhone',
  homePhone: 'homePhone',
  homePostalAddress: 'homePostalAddress',
  description: 'description',
  company: 'company',
  c: 'c',
  co: 'co',
  l: 'l',
  st: 'st',
  postalCode: 'postalCode',
};

/** Map our multi-valued patch field name → the AD attribute name. */
const PATCH_MULTI_ATTRIBUTE_MAP: Record<string, string> = {
  otherMailbox: 'otherMailbox',
  otherHomePhone: 'otherHomePhone',
  otherMobile: 'otherMobile',
};

/**
 * Translate a `UserAttributePatch` into a set of LDAP `Change` ops.
 *
 * Scalar fields (PATCH_ATTRIBUTE_MAP):
 *   - `undefined` ⇒ field absent, skip
 *   - `null` or empty string ⇒ delete the AD attribute
 *   - anything else ⇒ replace with the trimmed value
 *
 * Multi-valued fields (PATCH_MULTI_ATTRIBUTE_MAP):
 *   - `undefined` ⇒ skip
 *   - `null` or empty array ⇒ delete the AD attribute
 *   - non-empty array ⇒ replace with all (trimmed, non-empty) values
 *
 * Returns an empty array if every field was undefined.
 */
function buildAttributeChanges(patch: UserAttributePatch): Change[] {
  const changes: Change[] = [];
  const data = patch as Record<string, unknown>;
  for (const [patchKey, attrName] of Object.entries(PATCH_ATTRIBUTE_MAP)) {
    const raw = data[patchKey];
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      changes.push(
        new Change({
          operation: 'delete',
          modification: new Attribute({ type: attrName, values: [] }),
        }),
      );
      continue;
    }
    if (typeof raw === 'string') {
      changes.push(
        new Change({
          operation: 'replace',
          modification: new Attribute({ type: attrName, values: [raw.trim()] }),
        }),
      );
    }
  }
  for (const [patchKey, attrName] of Object.entries(PATCH_MULTI_ATTRIBUTE_MAP)) {
    const raw = data[patchKey];
    if (raw === undefined) continue;
    if (raw === null) {
      changes.push(
        new Change({
          operation: 'delete',
          modification: new Attribute({ type: attrName, values: [] }),
        }),
      );
      continue;
    }
    if (Array.isArray(raw)) {
      const cleaned = raw
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      changes.push(
        cleaned.length === 0
          ? new Change({
              operation: 'delete',
              modification: new Attribute({ type: attrName, values: [] }),
            })
          : new Change({
              operation: 'replace',
              modification: new Attribute({ type: attrName, values: cleaned }),
            }),
      );
    }
  }
  // managerDn / accountExpiresAt are typed on UserAttributePatch but not in the
  // MVP edit allowlist — they need extra validation (cycle check for manager;
  // FILETIME conversion for account expiry). Excluded here intentionally.
  return changes;
}

/** Pull just the editable attributes out of a normalized user for audit logging. */
function snapshotForAudit(user: DirectoryUser): Record<string, unknown> {
  const raw = user.rawAttributes;
  return {
    displayName: user.displayName,
    givenName: user.givenName,
    surname: user.surname,
    email: user.email,
    phone: user.phone,
    mobile: user.mobile,
    title: user.title,
    department: user.department,
    employeeID: rawAuditScalar(raw['employeeID']),
    employeeNumber: rawAuditScalar(raw['employeeNumber']),
    ipPhone: rawAuditScalar(raw['ipPhone']),
    homePhone: rawAuditScalar(raw['homePhone']),
    homePostalAddress: rawAuditScalar(raw['homePostalAddress']),
    description: rawAuditScalar(raw['description']),
    company: rawAuditScalar(raw['company']),
    c: rawAuditScalar(raw['c']),
    co: rawAuditScalar(raw['co']),
    l: rawAuditScalar(raw['l']),
    st: rawAuditScalar(raw['st']),
    postalCode: rawAuditScalar(raw['postalCode']),
    otherMailbox: rawAuditArray(raw['otherMailbox']),
    otherHomePhone: rawAuditArray(raw['otherHomePhone']),
    otherMobile: rawAuditArray(raw['otherMobile']),
  };
}

function rawAuditScalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length > 0 ? rawAuditScalar(v[v.length - 1]) : null;
  return typeof v === 'string' ? (v.length > 0 ? v : null) : String(v);
}

function rawAuditArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (typeof x === 'string' ? x : x === null || x === undefined ? '' : String(x)))
    .filter((s) => s.length > 0);
}
