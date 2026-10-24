// SPDX-License-Identifier: BUSL-1.1
import {
  type ImportPerson,
  type LdapTlsMode,
  type NamingLookups,
  type OuName,
  type TakenNames,
  type UserCreateStep,
  escapeRdnValueRfc,
  isDnWithin,
} from '@openaduc/shared';
import {
  Attribute,
  Change,
  ConstraintViolationError,
  AlreadyExistsError,
  EqualityFilter,
  OrFilter,
  InsufficientAccessError,
  NotAllowedOnNonLeafError,
  UnwillingToPerformError,
  type Client,
  type Entry,
  type Filter,
} from 'ldapts';
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
  DirectoryObjectRef,
  DirectoryOu,
  DirectoryProvider,
  DirectoryGroupSearchQuery,
  DirectoryUser,
  DirectoryUserSearchQuery,
  GroupCreateInput,
  MutationResult,
  NameHolders,
  NewObjectNames,
  OuAttributePatch,
  PeopleLookups,
  RecycleBinStatus,
  ResetPasswordInput,
  RestoreResult,
  RestoreUserInput,
  SyncInput,
  UserAttributePatch,
  UserCreateFinish,
  GroupsStepResult,
  UserCreateInput,
  UserCreateResult,
  AccountFingerprint,
  UserRenameInput,
  WriteContext,
} from '../types.js';
import { DirectoryUnavailableError, StepUpBindFailedError } from '../types.js';
import {
  type ClientConfig,
  describeConnectionError,
  certificateProblemMessage,
  isDirectoryUnreachable,
  withFailover,
} from './client.js';
import { ShowDeletedControl, TreeDeleteControl, deletedObjectControls } from './controls.js';
import { withAllMembers } from './memberRange.js';
import { planUserRename } from './rename.js';
import { describeDeleteBlock, userDeleteBlockReason } from '../../lib/userDeletion.js';
import {
  describeGroupDeleteBlock,
  groupDeleteBlock,
  type GroupDeleteFacts,
} from '../../lib/groupDeletion.js';
import type { RoleGroup } from '../../lib/groupPrivilege.js';
import { isDomainSid, ridOf } from '../../lib/sid.js';
import { computerWriteBlock, describeComputerWriteBlock } from '../../lib/computerWrites.js';
import {
  BINARY_ATTRS,
  COMPUTER_ATTRS,
  COMPUTER_ATTRS_FULL,
  DELETED_COMPUTER_ATTRS,
  DELETED_USER_ATTRS,
  GPLINK_SCAN_ATTRS,
  GPO_ATTRS,
  GROUP_ATTRS,
  OBJECT_REF_ATTRS,
  OU_ATTRS,
  USER_ATTRS,
  USER_ATTRS_FULL,
  asString,
  asStringArray,
  groupTypeValue,
  leafRdn,
  leafRdnValue,
  normalizeComputer,
  normalizeDeletedComputer,
  normalizeDeletedUser,
  normalizeGroup,
  normalizeGroupPolicy,
  normalizeObjectRef,
  normalizeOu,
  normalizeUser,
  parentDn,
  parseGpLinkValue,
} from './normalize.js';
import {
  adDurationToMs,
  dateToFiletime,
  defaultComputerPassword,
  encodeUnicodePassword,
  FILETIME_NEVER,
  escapeLdapFilter,
  isLocked,
  objectGuidFromString,
  objectGuidToString,
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
  tlsMode: LdapTlsMode;
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
      tlsMode: config.tlsMode,
      tlsRejectUnauthorized: config.tlsRejectUnauthorized,
      tlsCaPath: config.tlsCaPath,
      operationTimeoutMs: config.operationTimeoutMs,
    };
  }

  /**
   * Bind as the operator on the first reachable DC and run `fn`. A refused
   * bind is `permission_denied`; no reachable DC at all is
   * `directory_error`. Once bound, `fn` must return its failures rather than
   * throw, so a half-done write is never retried against another DC.
   */
  private async asOperator<T>(
    ctx: WriteContext,
    fn: (client: Client) => Promise<T>,
  ): Promise<T | MutationResult> {
    try {
      return await withFailover(this.clientConfig, async (client) => {
        try {
          await client.bind(ctx.actorUsername, ctx.actorPassword);
        } catch (err) {
          if (isDirectoryUnreachable(err)) throw err;
          return {
            ok: false,
            reason: 'permission_denied',
            errorMessage: 'step-up bind failed',
          } satisfies MutationResult;
        }
        return fn(client);
      });
    } catch (err) {
      if (!(err instanceof DirectoryUnavailableError)) throw err;
      return { ok: false, reason: 'directory_error', errorMessage: err.message };
    }
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
          // No answer from this DC: throw so withFailover tries the next.
          if (isDirectoryUnreachable(bindErr)) throw bindErr;
          // Surface the actual reason. AD encodes a subcode in the error
          // text (e.g. "data 52e") that distinguishes wrong-password from
          // user-not-found / disabled / expired / locked.
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
        errorMessage:
          certificateProblemMessage(err) ??
          `cannot reach directory: ${describeConnectionError(err)}`,
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
  async getPsoLockoutDuration(psoDn: string): Promise<number | null> {
    try {
      return await this.withServiceBind(async (client) => {
        const { searchEntries } = await client.search(psoDn, {
          scope: 'base',
          filter: '(objectClass=msDS-PasswordSettings)',
          attributes: ['msDS-LockoutDuration'],
        });
        return adDurationToMs(asString(searchEntries[0]?.['msDS-LockoutDuration']));
      });
    } catch {
      // By default only Domain Admins can read PSOs.
      return null;
    }
  }

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
            'pwdProperties',
          ],
        });
        const root: Entry = searchEntries[0] ?? ({} as Entry);
        const intAttr = (v: unknown): number | null => {
          const s = asString(v);
          if (s === null) return null;
          const n = Number.parseInt(s, 10);
          return Number.isFinite(n) ? n : null;
        };
        const pwdProperties = intAttr(root['pwdProperties']);
        return {
          lockoutDurationMs: adDurationToMs(asString(root['lockoutDuration'])),
          lockoutThreshold: intAttr(root['lockoutThreshold']),
          lockoutObservationMs: adDurationToMs(asString(root['lockOutObservationWindow'])),
          maxPwdAgeMs: adDurationToMs(asString(root['maxPwdAge'])),
          minPwdLength: intAttr(root['minPwdLength']),
          pwdHistoryLength: intAttr(root['pwdHistoryLength']),
          complexityRequired: pwdProperties === null ? null : (pwdProperties & 1) === 1,
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
        complexityRequired: null,
      };
    }
  }

  // ---- Reads -------------------------------------------------------------

  async findObject(identifier: DirectoryObjectIdentifier): Promise<DirectoryObjectRef | null> {
    return this.withServiceBind(async (client) => {
      const filter = identifierToFilter(identifier, '(objectClass=*)');
      const entry = await this.searchOne(client, this.config.baseDn, filter, OBJECT_REF_ATTRS);
      return entry ? normalizeObjectRef(entry) : null;
    });
  }

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
      return normalizeGroups(client, searchEntries);
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
      return normalizeGroups(client, searchEntries);
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
      return normalizeGroups(client, searchEntries);
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

  async *syncGroupMembers(groupDn: string): AsyncIterable<DirectoryUser> {
    const filter = `(&${USER_FILTER_BASE}(memberOf=${escapeLdapFilter(groupDn)}))`;
    yield* this.streamSearch(filter, USER_ATTRS_FULL, 500, normalizeUser);
  }

  async *syncLockedUsers(): AsyncIterable<DirectoryUser> {
    // LDAP can't filter on the constructed lockout bit, so narrow by
    // lockoutTime and keep only accounts whose lockout is still in effect.
    const filter = `(&${USER_FILTER_BASE}(lockoutTime>=1))`;
    for await (const user of this.streamSearch(filter, USER_ATTRS, 500, normalizeUser)) {
      if (user.locked) yield user;
    }
  }

  async *syncGroups(input: SyncInput): AsyncIterable<DirectoryGroup> {
    const filter = input.modifiedSince
      ? `(&${GROUP_FILTER_BASE}(whenChanged>=${formatGeneralizedTime(input.modifiedSince)}))`
      : GROUP_FILTER_BASE;
    yield* this.streamSearch(
      filter,
      GROUP_ATTRS,
      input.pageSize ?? 500,
      normalizeGroup,
      withAllMembers,
    );
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
    return this.asOperator(ctx, async (client) => {
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
   * Set a new password (see passwordChanges), with must-change if
   * `forceChangeAtNextLogin`. `unlock` also sets `lockoutTime=0`. All of it
   * is one modify, so it applies or fails whole.
   */
  async resetPassword(
    userId: DirectoryObjectIdentifier,
    input: ResetPasswordInput,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);

        const changes = passwordChanges(input.newPassword, input.forceChangeAtNextLogin);
        if (input.unlock) {
          changes.push(
            new Change({
              operation: 'replace',
              modification: new Attribute({ type: 'lockoutTime', values: ['0'] }),
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
            ...(input.unlock ? { locked: before.locked } : {}),
          },
          after: {
            passwordLastSetAt: after?.passwordLastSetAt?.toISOString() ?? null,
            forceChangeAtNextLogin: input.forceChangeAtNextLogin,
            // Unknown when the re-read failed; don't claim it's unlocked.
            ...(input.unlock ? { locked: after ? after.locked : null } : {}),
          },
        };
      } catch (err) {
        return classifyPasswordError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  enableUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult> {
    return this.toggleAccountDisable('user', userId, ctx, false);
  }

  async setAccountExpiry(
    userId: DirectoryObjectIdentifier,
    expiresAt: Date | null,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);
        await client.modify(
          before.distinguishedName,
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'accountExpires',
              values: [expiresAt ? dateToFiletime(expiresAt) : FILETIME_NEVER],
            }),
          }),
        );
        const afterEntry = await this.findUserEntry(client, userId);
        const after = afterEntry ? normalizeUser(afterEntry) : null;
        return {
          ok: true,
          before: { accountExpiresAt: before.accountExpiresAt?.toISOString() ?? null },
          after: after ? { accountExpiresAt: after.accountExpiresAt?.toISOString() ?? null } : {},
        };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  disableUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult> {
    return this.toggleAccountDisable('user', userId, ctx, true);
  }

  enableComputer(
    computerId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.toggleAccountDisable('computer', computerId, ctx, false);
  }

  disableComputer(
    computerId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.toggleAccountDisable('computer', computerId, ctx, true);
  }

  private findAccountEntry(
    client: Client,
    kind: AccountKind,
    identifier: DirectoryObjectIdentifier,
  ): Promise<Entry | null> {
    return kind === 'user'
      ? this.findUserEntry(client, identifier)
      : this.findComputerEntry(client, identifier);
  }

  private toggleAccountDisable(
    kind: AccountKind,
    id: DirectoryObjectIdentifier,
    ctx: WriteContext,
    disable: boolean,
  ): Promise<MutationResult> {
    return this.setAccountControlFlag(kind, id, ctx, {
      flag: UAC.ACCOUNTDISABLE,
      on: disable,
      snapshot: (uac) => ({ enabled: (uac & UAC.ACCOUNTDISABLE) === 0 }),
      refuse: kind === 'computer' && disable ? protectedComputer : undefined,
    });
  }

  setPasswordMustChange(
    userId: DirectoryObjectIdentifier,
    mustChange: boolean,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);
        await client.modify(
          before.distinguishedName,
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'pwdLastSet',
              values: [mustChange ? '0' : '-1'],
            }),
          }),
        );
        const afterEntry = await this.findUserEntry(client, userId);
        const after = afterEntry ? normalizeUser(afterEntry) : null;
        return {
          ok: true,
          before: {
            passwordMustChange: before.passwordMustChange,
            passwordLastSetAt: before.passwordLastSetAt?.toISOString() ?? null,
          },
          after: {
            passwordMustChange: after ? after.passwordMustChange : mustChange,
            passwordLastSetAt: after?.passwordLastSetAt?.toISOString() ?? null,
          },
        };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  setPasswordNeverExpires(
    userId: DirectoryObjectIdentifier,
    neverExpires: boolean,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.setAccountControlFlag('user', userId, ctx, {
      flag: UAC.DONT_EXPIRE_PASSWORD,
      on: neverExpires,
      snapshot: (uac) => ({ passwordNeverExpires: (uac & UAC.DONT_EXPIRE_PASSWORD) !== 0 }),
    });
  }

  /**
   * Set or clear one bit of `userAccountControl`. Reads the current value
   * from the live entry so we don't clobber the other bits
   * (DONT_EXPIRE_PASSWORD, WORKSTATION_TRUST_ACCOUNT, etc). Before and
   * after are the bit as `snapshot` names it, with the whole value.
   */
  private async setAccountControlFlag(
    kind: AccountKind,
    id: DirectoryObjectIdentifier,
    ctx: WriteContext,
    write: {
      flag: number;
      on: boolean;
      snapshot: (uac: number) => Record<string, unknown>;
      refuse?: ((entry: Entry) => MutationResult | null) | undefined;
    },
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findAccountEntry(client, kind, id);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: `${kind} not found` };
        const refused = write.refuse?.(target) ?? null;
        if (refused) return refused;
        const dn = asString(target.distinguishedName) ?? target.dn;
        const uacNum = userAccountControlOf(target);
        if (!Number.isFinite(uacNum)) {
          return {
            ok: false,
            reason: 'directory_error',
            errorMessage: 'unparseable userAccountControl',
          };
        }
        const nextUac = write.on ? uacNum | write.flag : uacNum & ~write.flag;
        const before = { ...write.snapshot(uacNum), userAccountControl: uacNum };
        if (nextUac === uacNum) {
          // Idempotent no-op.
          return { ok: true, before, after: before };
        }

        await client.modify(dn, accountControlChange(nextUac));

        const afterEntry = await this.findAccountEntry(client, kind, id);
        return {
          ok: true,
          before,
          after: {
            ...write.snapshot(afterEntry ? userAccountControlOf(afterEntry) : nextUac),
            userAccountControl: nextUac,
          },
        };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  async resetComputerAccount(
    computerId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findComputerEntry(client, computerId);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'computer not found' };
        const refused = protectedComputer(target);
        if (refused) return refused;
        const before = normalizeComputer(target);
        if (!before.samAccountName) {
          return {
            ok: false,
            reason: 'directory_error',
            errorMessage: 'computer has no pre-Windows 2000 name',
          };
        }
        await client.modify(
          before.distinguishedName,
          new Change({
            operation: 'replace',
            modification: new Attribute({
              type: 'unicodePwd',
              values: [encodeUnicodePassword(defaultComputerPassword(before.samAccountName))],
            }),
          }),
        );
        const afterEntry = await this.findComputerEntry(client, computerId);
        const after = afterEntry ? normalizeComputer(afterEntry) : null;
        return {
          ok: true,
          before: { passwordLastSetAt: before.passwordLastSetAt?.toISOString() ?? null },
          after: { passwordLastSetAt: after?.passwordLastSetAt?.toISOString() ?? null },
        };
      } catch (err) {
        return classifyWriteError(err);
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
    return this.asOperator(ctx, async (client) => {
      try {
        // The full read, so the audit snapshot holds attributes outside the curated set.
        const target = await this.findUserEntry(client, userId, USER_ATTRS_FULL);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const before = normalizeUser(target);

        const changes = buildAttributeChanges(patch);
        if (changes.length === 0) {
          // Idempotent no-op: nothing changed.
          return { ok: true, before: snapshotForAudit(before), after: snapshotForAudit(before) };
        }

        await client.modify(before.distinguishedName, changes);

        // Re-read so the route can return the actual post-write state.
        const afterEntry = await this.findUserEntry(client, userId, USER_ATTRS_FULL);
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
    return this.modifyGroupMembership({ kind: 'user', id: userId }, groupId, ctx, 'add');
  }

  removeUserFromGroup(
    userId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.modifyGroupMembership({ kind: 'user', id: userId }, groupId, ctx, 'delete');
  }

  addGroupToGroup(
    memberGroupId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.modifyGroupMembership({ kind: 'group', id: memberGroupId }, groupId, ctx, 'add');
  }

  removeGroupFromGroup(
    memberGroupId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.modifyGroupMembership({ kind: 'group', id: memberGroupId }, groupId, ctx, 'delete');
  }

  /**
   * Add or remove a user's or group's DN from a group's `member` attribute.
   * Same write-as-user pattern as the other writes; idempotent (no-op if
   * already in the desired state).
   */
  private async modifyGroupMembership(
    member: { kind: 'user' | 'group'; id: DirectoryObjectIdentifier },
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
    op: 'add' | 'delete',
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const memberEntry =
          member.kind === 'user'
            ? await this.findUserEntry(client, member.id, ['objectGUID', 'distinguishedName'])
            : await this.findGroupEntry(client, member.id, ['objectGUID', 'distinguishedName']);
        if (!memberEntry) {
          return { ok: false, reason: 'not_found', errorMessage: `${member.kind} not found` };
        }
        const groupEntry = await this.findGroupEntry(client, groupId, [
          'objectGUID',
          'distinguishedName',
        ]);
        if (!groupEntry) return { ok: false, reason: 'not_found', errorMessage: 'group not found' };
        const memberDn = asString(memberEntry.distinguishedName) ?? memberEntry.dn;
        const groupDn = asString(groupEntry.distinguishedName) ?? groupEntry.dn;
        const snapshot = (inGroup: boolean) => ({
          isMember: inGroup,
          group: groupDn,
          member: memberDn,
          memberKind: member.kind,
        });
        const wasMember = await this.setMember(client, groupDn, memberDn, op === 'add');
        return { ok: true, before: snapshot(wasMember), after: snapshot(op === 'add') };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /** Make `memberDn` a member of `groupDn` or not; returns whether it was one. */
  private async setMember(
    client: Client,
    groupDn: string,
    memberDn: string,
    member: boolean,
  ): Promise<boolean> {
    // Ask AD rather than reading `member`, which a large group hands out
    // in ranges.
    const { searchEntries } = await client.search(groupDn, {
      scope: 'base',
      filter: `(member=${escapeLdapFilter(memberDn)})`,
      attributes: ['distinguishedName'],
    });
    const wasMember = searchEntries.length > 0;
    if (wasMember !== member) {
      await client.modify(
        groupDn,
        new Change({
          operation: member ? 'add' : 'delete',
          modification: new Attribute({ type: 'member', values: [memberDn] }),
        }),
      );
    }
    return wasMember;
  }

  /**
   * Move a user or computer to a different OU. AD permits this via
   * modifyDN: keep the account's existing RDN (the CN=…) but change its
   * parent to `targetOuDn`. ldapts accepts a full new DN as the second argument and translates it
   * into the wire-level Modify DN request (with `newSuperior` set to the
   * target OU).
   *
   * Idempotent: if the account is already directly under `targetOuDn`,
   * returns `ok: true` with a no-op snapshot so the caller doesn't have to special-
   * case the case where someone clicked "Move" without changing the value.
   *
   * `objectGuid` survives a move, so cached IDs (memberships, audit
   * targetId) remain valid — only the DN changes, which the route re-reads
   * into the cache.
   */
  moveUser(
    userId: DirectoryObjectIdentifier,
    targetOuDn: string,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.moveAccount('user', userId, targetOuDn, ctx);
  }

  moveComputer(
    computerId: DirectoryObjectIdentifier,
    targetOuDn: string,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.moveAccount('computer', computerId, targetOuDn, ctx);
  }

  private async moveAccount(
    kind: AccountKind,
    id: DirectoryObjectIdentifier,
    targetOuDn: string,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    const trimmedTarget = targetOuDn.trim();
    if (!trimmedTarget) {
      return { ok: false, reason: 'directory_error', errorMessage: 'empty target OU' };
    }
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findAccountEntry(client, kind, id);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: `${kind} not found` };
        const refused = kind === 'computer' ? protectedComputer(target) : null;
        if (refused) return refused;
        const dn = asString(target.distinguishedName) ?? target.dn;
        const currentParent = parentDn(dn);
        // By GUID too, so a revert finds the OU however it's renamed or moved since.
        const parentGuid = currentParent ? await this.guidOf(client, currentParent) : null;
        // Compare case-insensitively — AD treats DN components as case-
        // insensitive even though it preserves the casing on writes.
        if (currentParent && currentParent.toLowerCase() === trimmedTarget.toLowerCase()) {
          const unchanged = { distinguishedName: dn, parentDn: currentParent, parentGuid };
          return { ok: true, before: unchanged, after: unchanged };
        }

        const rdn = leafRdn(dn);
        const newDn = `${rdn},${trimmedTarget}`;
        await client.modifyDN(dn, newDn);

        return {
          ok: true,
          before: { distinguishedName: dn, parentDn: currentParent, parentGuid },
          after: {
            distinguishedName: newDn,
            parentDn: trimmedTarget,
            parentGuid: await this.guidOf(client, trimmedTarget),
          },
        };
      } catch (err) {
        // A same-named object in the OU comes back as `conflict`.
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Rename a person. The RDN change goes first because it's the one most
   * likely to be refused (a same-named object in the OU, a missing rename
   * right) and the easiest to undo: if the attribute write that follows
   * fails, the RDN is renamed back so the account isn't left half-renamed.
   *
   * New logon names, address and RDN are checked against the directory
   * first so a clash comes back as `conflict` naming the other object,
   * rather than as AD's opaque constraint error.
   */
  async renameUser(
    userId: DirectoryObjectIdentifier,
    input: UserRenameInput,
    ctx: WriteContext,
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findUserEntry(client, userId, USER_ATTRS_FULL);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const user = normalizeUser(target);
        const before = renameSnapshot(user);
        const plan = planUserRename(
          {
            givenName: user.givenName,
            surname: user.surname,
            displayName: user.displayName,
            cn: asString(target.cn),
            samAccountName: user.samAccountName,
            userPrincipalName: user.userPrincipalName,
            email: user.email,
            proxyAddresses: asStringArray(target.proxyAddresses),
          },
          input,
        );
        if (Object.keys(plan.attributes).length === 0 && plan.newCn === null) {
          return { ok: true, before, after: before };
        }

        const conflict = await this.findNameClash(
          client,
          {
            samAccountName: plan.newSamAccountName,
            userPrincipalName: plan.newUserPrincipalName,
            email: plan.newEmail,
            cn: plan.newCn,
          },
          parentDn(user.distinguishedName),
          { exceptObjectGuid: user.objectGuid },
        );
        if (conflict) return { ok: false, reason: 'conflict', errorMessage: conflict, before };

        let dn = user.distinguishedName;
        const oldRdn = leafRdn(dn);
        if (plan.newCn !== null) {
          const newRdn = `CN=${escapeRdnValueRfc(plan.newCn)}`;
          // A bare RDN (no unescaped comma) keeps the parent: ldapts only
          // sets newSuperior when the new DN contains one.
          await client.modifyDN(dn, newRdn);
          dn = `${newRdn},${parentDn(dn)}`;
        }

        const changes = Object.entries(plan.attributes).map(([type, values]) =>
          values.length === 0
            ? new Change({ operation: 'delete', modification: new Attribute({ type, values: [] }) })
            : new Change({ operation: 'replace', modification: new Attribute({ type, values }) }),
        );
        if (changes.length > 0) {
          try {
            await client.modify(dn, changes);
          } catch (err) {
            if (plan.newCn !== null) {
              const rolledBack = await client
                .modifyDN(dn, oldRdn)
                .then(() => true)
                .catch(() => false);
              const message = err instanceof Error ? err.message : 'modify failed';
              return {
                ...classifyWriteError(err),
                errorMessage: rolledBack
                  ? `${message} (the name change was rolled back)`
                  : `${message} (the object was renamed to ${dn} but its attributes were not updated, and renaming it back failed)`,
              };
            }
            throw err;
          }
        }

        const afterEntry = await this.findUserEntry(client, userId, USER_ATTRS_FULL);
        return {
          ok: true,
          before,
          after: afterEntry ? renameSnapshot(normalizeUser(afterEntry)) : {},
        };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Delete a disabled user. The guard runs against the entry read on the
   * operator's own bind, immediately before the delete, so it holds even
   * if the caller's view of the account is stale.
   *
   * A plain delete is tried first because Delete is the right helpdesk
   * roles are usually delegated; only a user with child objects needs the
   * tree delete and its Delete Subtree right.
   */
  async deleteUser(
    userId: DirectoryObjectIdentifier,
    ctx: WriteContext,
    options: { allowTreeDelete?: boolean } = {},
  ): Promise<MutationResult & { treeDelete?: boolean }> {
    return this.asOperator(ctx, async (client) => {
      try {
        const target = await this.findUserEntry(client, userId, USER_ATTRS_FULL);
        if (!target) return { ok: false, reason: 'not_found', errorMessage: 'user not found' };
        const user = normalizeUser(target);
        const before = deletionSnapshot(user);
        const blocked = userDeleteBlockReason(user);
        if (blocked) {
          return {
            ok: false,
            reason: 'policy_violation',
            errorMessage: describeDeleteBlock(blocked),
            before,
          };
        }

        let treeDelete = false;
        try {
          await client.del(user.distinguishedName);
        } catch (err) {
          if (!(err instanceof NotAllowedOnNonLeafError)) throw err;
          // The account holds other objects. Deleting them too must be the
          // operator's explicit choice, never a silent escalation.
          if (!options.allowTreeDelete) {
            return {
              ok: false,
              reason: 'policy_violation',
              errorMessage:
                'the account contains other objects (e.g. Exchange ActiveSync devices); confirm deleting them too',
              before,
            };
          }
          treeDelete = true;
          await client.del(user.distinguishedName, new TreeDeleteControl());
        }
        return { ok: true, before, after: { deleted: true, treeDelete }, treeDelete };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * Who already holds each name an object would take, other than the
   * object itself. sAMAccountName, UPN and email are searched across the
   * whole domain naming context, not just the configured base DN, because
   * they must be unique domain-wide; the CN only among `parentDn`'s
   * children. A holder outside the base DN comes back with a null `dn`:
   * the operator has no business seeing what lives there.
   */
  private async nameClashes(
    client: Client,
    names: Partial<Record<ClashAttribute, string | null | undefined>>,
    parentDn: string | null,
    exceptObjectGuid?: string,
  ): Promise<Partial<Record<ClashAttribute, { dn: string | null }>>> {
    const domainRoot = await this.domainRoot(client);
    const filters: Record<ClashAttribute, (v: string) => string> = {
      samAccountName: (v) => `(sAMAccountName=${v})`,
      userPrincipalName: (v) => `(userPrincipalName=${v})`,
      email: (v) => `(|(mail=${v})(proxyAddresses=smtp:${v}))`,
      cn: (v) => `(cn=${v})`,
    };
    const holders: Partial<Record<ClashAttribute, { dn: string | null }>> = {};
    for (const attribute of CLASH_ORDER) {
      const value = names[attribute]?.trim();
      if (!value) continue;
      const { searchEntries } = await client.search(
        attribute === 'cn' ? (parentDn ?? domainRoot) : domainRoot,
        {
          scope: attribute === 'cn' ? 'one' : 'sub',
          filter: filters[attribute](escapeLdapFilter(value)),
          attributes: ['objectGUID', 'distinguishedName'],
          explicitBufferAttributes: BINARY_ATTRS,
        },
      );
      const other = searchEntries.find((e) => {
        const guid = e.objectGUID;
        return !(Buffer.isBuffer(guid) && objectGuidToString(guid) === exceptObjectGuid);
      });
      if (other) {
        holders[attribute] = { dn: isDnWithin(other.dn, this.config.baseDn) ? other.dn : null };
      }
    }
    return holders;
  }

  /** The first of `names` already held, as a message naming the holder, or null. */
  private async findNameClash(
    client: Client,
    names: Partial<Record<ClashAttribute, string | null | undefined>>,
    parentDn: string | null,
    options: { exceptObjectGuid?: string; samLabel?: string } = {},
  ): Promise<string | null> {
    const holders = await this.nameClashes(client, names, parentDn, options.exceptObjectGuid);
    const label: Record<ClashAttribute, string> = {
      samAccountName: options.samLabel ?? 'logon name',
      userPrincipalName: 'UPN',
      email: 'email address',
      cn: 'name',
    };
    for (const attribute of CLASH_ORDER) {
      const holder = holders[attribute];
      if (!holder) continue;
      const where = attribute === 'cn' ? 'in this OU' : 'elsewhere in the domain';
      return `the ${label[attribute]} "${names[attribute]!.trim()}" is already used ${holder.dn ? `by ${holder.dn}` : where}`;
    }
    return null;
  }

  async findNameHolders(input: NewObjectNames): Promise<NameHolders> {
    return this.withServiceBind(async (client) => {
      const holders = await this.nameClashes(
        client,
        { cn: input.cn, samAccountName: input.samAccountName },
        input.parentDn,
      );
      return { cn: holders.cn ?? null, samAccountName: holders.samAccountName ?? null };
    });
  }

  async findTakenNames(lookups: NamingLookups): Promise<TakenNames> {
    return this.withServiceBind(async (client) => {
      const domainRoot = await this.domainRoot(client);
      const samAccountNames = (
        await this.searchAny(
          client,
          domainRoot,
          'sub',
          lookups.samAccountNamePrefixes.map((p) => `(sAMAccountName=${escapeLdapFilter(p)}*)`),
          ['sAMAccountName'],
        )
      ).flatMap((e) => asStringArray(e.sAMAccountName));

      const addressEntries = await this.searchAny(
        client,
        domainRoot,
        'sub',
        lookups.upnLocalPrefixes.map((p) => {
          const v = escapeLdapFilter(p);
          return `(userPrincipalName=${v}*)(mail=${v}*)(proxyAddresses=smtp:${v}*)`;
        }),
        ['userPrincipalName', 'mail', 'proxyAddresses'],
      );
      const userPrincipalNames = addressEntries.flatMap((e) => asStringArray(e.userPrincipalName));
      const mailAddresses = addressEntries.flatMap((e) => [
        ...asStringArray(e.mail),
        ...asStringArray(e.proxyAddresses)
          .filter((a) => /^smtp:/i.test(a))
          .map((a) => a.slice(5)),
      ]);

      const byOu = new Map<string, string[]>();
      const want = (ouDn: string, clause: string) =>
        byOu.set(ouDn, [...(byOu.get(ouDn) ?? []), clause]);
      for (const { ouDn, cn } of lookups.cns) want(ouDn, `(cn=${escapeLdapFilter(cn)})`);
      for (const { ouDn, cn } of lookups.cnPrefixes) want(ouDn, `(cn=${escapeLdapFilter(cn)}*)`);
      const cns: OuName[] = [];
      for (const [ouDn, clauses] of byOu) {
        // Callers check this; a search outside the base DN never runs.
        if (!isDnWithin(ouDn, this.config.baseDn)) continue;
        try {
          const found = await this.searchAny(client, ouDn, 'one', clauses, ['cn']);
          for (const e of found) for (const cn of asStringArray(e.cn)) cns.push({ ouDn, cn });
        } catch (err) {
          // An OU that doesn't exist yet holds no names; the create checks it.
          if ((err as { name?: string }).name !== 'NoSuchObjectError') throw err;
        }
      }
      return { samAccountNames, userPrincipalNames, mailAddresses, cns };
    });
  }

  async findPeople(lookups: PeopleLookups): Promise<ImportPerson[]> {
    return this.withServiceBind(async (client) => {
      const clauses = [
        ...lookups.employeeIds.map((v) => `(employeeID=${escapeLdapFilter(v)})`),
        ...lookups.identifiers.map((v) => {
          const e = escapeLdapFilter(v);
          return `(mail=${e})(proxyAddresses=smtp:${e})(userPrincipalName=${e})(sAMAccountName=${e})`;
        }),
      ];
      const entries = await this.searchAny(
        client,
        await this.domainRoot(client),
        'sub',
        clauses,
        [
          'objectGUID',
          'distinguishedName',
          'sAMAccountName',
          'userPrincipalName',
          'displayName',
          'employeeID',
          'mail',
          'proxyAddresses',
        ],
        USER_FILTER_BASE,
      );
      const people = new Map<string, ImportPerson>();
      for (const entry of entries) {
        const ref = normalizeObjectRef(entry);
        if (!ref) continue;
        people.set(ref.objectGuid, {
          id: ref.objectGuid,
          distinguishedName: ref.distinguishedName,
          samAccountName: asString(entry.sAMAccountName) ?? null,
          userPrincipalName: asString(entry.userPrincipalName) ?? null,
          displayName: asString(entry.displayName) ?? null,
          employeeId: asString(entry.employeeID) ?? null,
          addresses: [
            ...asStringArray(entry.mail),
            ...asStringArray(entry.proxyAddresses)
              .filter((a) => /^smtp:/i.test(a))
              .map((a) => a.slice(5)),
          ],
        });
      }
      return [...people.values()];
    });
  }

  async findObjects(refs: {
    dns: readonly string[];
    guids: readonly string[];
  }): Promise<DirectoryObjectRef[]> {
    return this.withServiceBind(async (client) => {
      const entries = await this.searchAny(
        client,
        this.config.baseDn,
        'sub',
        refs.dns.map((dn) => `(distinguishedName=${escapeLdapFilter(dn)})`),
        OBJECT_REF_ATTRS,
      );
      // A binary objectGUID only matches as a filter object, not in a string filter.
      for (let i = 0; i < refs.guids.length; i += 50) {
        const { searchEntries } = await client.search(this.config.baseDn, {
          scope: 'sub',
          filter: new OrFilter({
            filters: refs.guids.slice(i, i + 50).map(
              (guid) =>
                new EqualityFilter({
                  attribute: 'objectGUID',
                  value: objectGuidFromString(guid),
                }),
            ),
          }),
          attributes: OBJECT_REF_ATTRS,
          explicitBufferAttributes: BINARY_ATTRS,
          paged: { pageSize: 500 },
        });
        entries.push(...searchEntries);
      }
      return entries.flatMap((e) => normalizeObjectRef(e) ?? []);
    });
  }

  /**
   * Everything matching any of `clauses` (and `within`, when given), in
   * bounded filters so 500 names don't make one huge one.
   */
  private async searchAny(
    client: Client,
    base: string,
    scope: 'one' | 'sub',
    clauses: string[],
    attributes: string[],
    within?: string,
  ): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (let i = 0; i < clauses.length; i += 50) {
      const any = `(|${clauses.slice(i, i + 50).join('')})`;
      const { searchEntries } = await client.search(base, {
        scope,
        filter: within ? `(&${within}${any})` : any,
        attributes,
        explicitBufferAttributes: BINARY_ATTRS,
        paged: { pageSize: 500 },
      });
      entries.push(...searchEntries);
    }
    return entries;
  }

  async getUpnSuffixes(): Promise<string[]> {
    return this.withServiceBind(async (client) => {
      const { searchEntries } = await client.search('', {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['configurationNamingContext'],
      });
      const configNc = asString(searchEntries[0]?.configurationNamingContext);
      if (!configNc) return [];
      const { searchEntries: partitions } = await client.search(`CN=Partitions,${configNc}`, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['uPNSuffixes'],
      });
      return asStringArray(partitions[0]?.uPNSuffixes);
    });
  }

  /**
   * Create a group at `input.dn`, bound as the operator. The names are
   * checked again on this bind: the preflight the dialog ran may be stale.
   * Once AD has added the group the create has happened, so a failed
   * read-back still reports success, without the group.
   */
  async createGroup(
    input: GroupCreateInput,
    ctx: WriteContext,
  ): Promise<MutationResult & { group?: DirectoryGroup }> {
    return this.asOperator(ctx, async (client) => {
      try {
        const clash = await this.findNameClash(
          client,
          { cn: input.cn, samAccountName: input.samAccountName },
          parentDn(input.dn),
          { samLabel: 'pre-Windows 2000 name' },
        );
        if (clash) return { ok: false, reason: 'conflict', errorMessage: clash };

        const attrs: Record<string, string | string[]> = {
          objectClass: ['top', 'group'],
          cn: input.cn,
          sAMAccountName: input.samAccountName,
          groupType: String(groupTypeValue(input.scope, input.type)),
        };
        if (input.description) attrs.description = input.description;
        await client.add(input.dn, attrs);

        const entry = await this.findGroupEntry(client, {
          kind: 'distinguishedName',
          value: input.dn,
        }).catch(() => null);
        if (!entry) {
          const { dn, cn, samAccountName, description, scope, type } = input;
          return {
            ok: true,
            after: { distinguishedName: dn, cn, samAccountName, description, scope, type },
          };
        }
        const group = normalizeGroup(entry);
        return { ok: true, after: groupSnapshot(group), group };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  async createUser(
    input: UserCreateInput,
    steps: readonly UserCreateStep[],
    finish: UserCreateFinish,
    ctx: WriteContext,
  ): Promise<UserCreateResult> {
    const result = await this.asOperator(ctx, async (client): Promise<UserCreateResult> => {
      try {
        const clash = await this.findNameClash(
          client,
          {
            samAccountName: input.samAccountName,
            userPrincipalName: input.userPrincipalName,
            email: input.mail,
            cn: input.cn,
          },
          parentDn(input.dn),
        );
        if (clash) return { ok: false, reason: 'conflict', errorMessage: clash, completed: [] };

        const attrs: Record<string, string | string[]> = {
          objectClass: ['top', 'person', 'organizationalPerson', 'user'],
          cn: input.cn,
          sAMAccountName: input.samAccountName,
          userPrincipalName: input.userPrincipalName,
          givenName: input.givenName,
          sn: input.surname,
          displayName: input.displayName,
          // Disabled until it has a password: AD refuses an enabled account
          // without one that meets the policy.
          userAccountControl: String(UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE),
        };
        if (input.mail) attrs.mail = input.mail;
        if (input.otherMailbox) attrs.otherMailbox = input.otherMailbox;
        if (input.mobile) attrs.mobile = input.mobile;
        if (input.telephoneNumber) attrs.telephoneNumber = input.telephoneNumber;
        if (input.initials) attrs.initials = input.initials;
        if (input.employeeId) attrs.employeeID = input.employeeId;
        if (input.description) attrs.description = input.description;
        Object.assign(attrs, input.organisation);
        if (input.manager) attrs.manager = input.manager;
        try {
          await client.add(input.dn, attrs);
        } catch (err) {
          return { ...classifyWriteError(err), completed: [] };
        }
        return await this.runCreateSteps(client, input.dn, ['create'], steps, finish);
      } catch (err) {
        return { ...classifyWriteError(err), completed: [] };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
    return 'completed' in result ? result : { ...result, completed: [] };
  }

  async finishUserCreate(
    userId: DirectoryObjectIdentifier,
    steps: readonly UserCreateStep[],
    finish: UserCreateFinish,
    ctx: WriteContext,
  ): Promise<UserCreateResult> {
    const result = await this.asOperator(ctx, async (client): Promise<UserCreateResult> => {
      try {
        const target = await this.findUserEntry(client, userId);
        if (!target) {
          return { ok: false, reason: 'not_found', errorMessage: 'user not found', completed: [] };
        }
        return await this.runCreateSteps(
          client,
          normalizeUser(target).distinguishedName,
          [],
          steps,
          finish,
        );
      } catch (err) {
        return { ...classifyWriteError(err), completed: [] };
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
    return 'completed' in result ? result : { ...result, completed: [] };
  }

  async getAccountFingerprint(
    identifier: DirectoryObjectIdentifier,
  ): Promise<AccountFingerprint | null> {
    return this.withServiceBind((client) => this.accountFingerprint(client, identifier));
  }

  private async accountFingerprint(
    client: Client,
    identifier: DirectoryObjectIdentifier,
  ): Promise<AccountFingerprint | null> {
    const entry = await this.findUserEntry(client, identifier, [
      'objectGUID',
      'whenCreated',
      'uSNChanged',
      'pwdLastSet',
      'lastLogonTimestamp',
    ]);
    const guid = entry?.objectGUID;
    if (!entry || !Buffer.isBuffer(guid)) return null;
    return {
      objectGuid: objectGuidToString(guid),
      whenCreated: asString(entry.whenCreated),
      usnChanged: asString(entry.uSNChanged),
      pwdLastSet: asString(entry.pwdLastSet),
      lastLogonTimestamp: asString(entry.lastLogonTimestamp),
    };
  }

  /**
   * The steps not yet `done`, in order, stopping at the first that fails,
   * then the account as they left it. The password step also clears
   * PASSWD_NOTREQD, and enabling leaves exactly a normal account, so a
   * new account carries no flags nobody chose.
   */
  private async runCreateSteps(
    client: Client,
    dn: string,
    done: UserCreateStep[],
    steps: readonly UserCreateStep[],
    finish: UserCreateFinish,
  ): Promise<UserCreateResult> {
    const completed = [...done];
    const leftAs = async () => {
      const id = { kind: 'distinguishedName', value: dn } as const;
      const entry = await this.findUserEntry(client, id).catch(() => null);
      const fingerprint = await this.accountFingerprint(client, id).catch(() => null);
      return {
        ...(entry ? { user: normalizeUser(entry) } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      };
    };
    let groups: GroupsStepResult | undefined;
    for (const step of steps) {
      if (completed.includes(step)) continue;
      if (step === 'groups') {
        groups = await this.addToGroups(client, dn, finish.groups);
        const failed = groups.failed;
        if (failed.length > 0) {
          return {
            ok: false,
            reason: failed[0]!.reason,
            errorMessage: failed
              .map((f) => `${leafRdnValue(f.dn) ?? f.dn}: ${f.errorMessage}`)
              .join('; '),
            completed,
            failedStep: step,
            groups,
            ...(await leftAs()),
          };
        }
        completed.push(step);
        continue;
      }
      try {
        if (step === 'password') {
          await client.modify(dn, [
            ...passwordChanges(finish.password, finish.mustChange),
            accountControlChange(UAC.NORMAL_ACCOUNT | UAC.ACCOUNTDISABLE),
          ]);
        } else if (step === 'enable') {
          await client.modify(dn, accountControlChange(UAC.NORMAL_ACCOUNT));
        }
        completed.push(step);
      } catch (err) {
        const refused = step === 'password' ? classifyPasswordError(err) : classifyWriteError(err);
        return {
          ...refused,
          completed,
          failedStep: step,
          ...(groups ? { groups } : {}),
          ...(await leftAs()),
        };
      }
    }
    return { ok: true, completed, ...(groups ? { groups } : {}), ...(await leftAs()) };
  }

  /** Add the account to each group, carrying on past one that refuses. */
  private async addToGroups(
    client: Client,
    dn: string,
    groupDns: readonly string[],
  ): Promise<GroupsStepResult> {
    const done: GroupsStepResult = { added: [], failed: [], missing: [] };
    for (const groupDn of groupDns) {
      try {
        await this.setMember(client, groupDn, dn, true);
        done.added.push(groupDn);
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchObjectError') {
          done.missing.push(groupDn);
          continue;
        }
        const { reason, errorMessage } = classifyWriteError(err);
        done.failed.push({
          dn: groupDn,
          reason: reason ?? 'directory_error',
          errorMessage: errorMessage ?? 'refused',
        });
      }
    }
    return done;
  }

  async getGroupDeleteFacts(group: DirectoryGroup): Promise<GroupDeleteFacts> {
    return this.withServiceBind((client) => this.groupDeleteFacts(client, group));
  }

  private async groupDeleteFacts(client: Client, group: DirectoryGroup): Promise<GroupDeleteFacts> {
    const parents: DirectoryGroup[] = [];
    for (const dn of group.memberOfDns) {
      // A parent this bind can't read can't be judged; it's left out.
      const parent = await client
        .search(dn, {
          scope: 'base',
          filter: GROUP_FILTER_BASE,
          attributes: ['objectGUID', 'objectSid', 'distinguishedName', 'adminCount'],
          explicitBufferAttributes: BINARY_ATTRS,
        })
        .then((r) => r.searchEntries[0])
        .catch(() => undefined);
      if (parent) parents.push(normalizeGroup(parent));
    }
    return { parents, primaryGroupMembers: await this.countPrimaryGroupMembers(client, group) };
  }

  /** Accounts whose primaryGroupID is this group's RID; null if AD wouldn't say. */
  private async countPrimaryGroupMembers(
    client: Client,
    group: DirectoryGroup,
  ): Promise<number | null> {
    const rid = ridOf(group.sid);
    // Only a group of the account's own domain can be its primary group.
    if (rid === null || !isDomainSid(group.sid)) return 0;
    try {
      const { searchEntries } = await client.search(await this.domainRoot(client), {
        scope: 'sub',
        filter: `(primaryGroupID=${rid})`,
        attributes: ['distinguishedName'],
        paged: { pageSize: 500 },
      });
      return searchEntries.length;
    } catch {
      return null;
    }
  }

  /**
   * Delete a group. The guard runs against the entry, its parents and its
   * primary-group count read on the operator's own bind, immediately
   * before the delete.
   */
  async deleteGroup(
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
    roleGroups: readonly RoleGroup[],
  ): Promise<MutationResult> {
    return this.asOperator(ctx, async (client) => {
      try {
        const entry = await this.findGroupEntry(client, groupId);
        if (!entry) return { ok: false, reason: 'not_found', errorMessage: 'group not found' };
        const group = normalizeGroup(entry);
        const before = groupSnapshot(group);
        const block = groupDeleteBlock(
          group,
          await this.groupDeleteFacts(client, group),
          roleGroups,
        );
        if (block) {
          return {
            ok: false,
            reason: 'policy_violation',
            errorMessage: describeGroupDeleteBlock(block),
            before,
          };
        }
        await client.del(group.distinguishedName);
        return { ok: true, before, after: { deleted: true } };
      } catch (err) {
        return classifyWriteError(err);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    });
  }

  /**
   * The domain's naming context: sAMAccountName and UPN are unique across
   * it, not just under the configured base DN.
   */
  private async domainRoot(client: Client): Promise<string> {
    return (await this.resolveDefaultNamingContext(client)) ?? this.config.baseDn;
  }

  private async resolveDefaultNamingContext(client: Client): Promise<string | null> {
    const { searchEntries } = await client.search('', {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['defaultNamingContext'],
    });
    const dse = searchEntries[0];
    return dse ? asString((dse as Record<string, unknown>).defaultNamingContext) : null;
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

    return this.asOperator(ctx, async (client) => {
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
    return this.asOperator(ctx, async (client) => {
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
    return this.asOperator(ctx, async (client) => {
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

  async countChildObjects(dns: string[], ctx: WriteContext): Promise<Map<string, number | null>> {
    return this._withOperatorBind(ctx, async (client) => {
      const counts = new Map<string, number | null>();
      for (const dn of dns) {
        try {
          // Everything a tree delete would remove: the whole subtree, which
          // the search returns with the base itself, so minus one.
          const { searchEntries } = await client.search(dn, {
            scope: 'sub',
            filter: '(objectClass=*)',
            attributes: ['1.1'],
          });
          counts.set(dn, Math.max(0, searchEntries.length - 1));
        } catch {
          counts.set(dn, null);
        }
      }
      return counts;
    });
  }

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
    return this.asOperator(ctx, async (client) => {
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
      } catch (err) {
        if (isDirectoryUnreachable(err)) throw err;
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

  /** The object's GUID, or null when it can't be read. */
  private async guidOf(client: Client, dn: string): Promise<string | null> {
    try {
      const { searchEntries } = await client.search(dn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['objectGUID'],
        explicitBufferAttributes: BINARY_ATTRS,
      });
      return searchEntries[0] ? (normalizeObjectRef(searchEntries[0])?.objectGuid ?? null) : null;
    } catch {
      return null;
    }
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
    attributes: readonly string[] = GROUP_ATTRS,
  ): Promise<Entry | null> {
    const filter = identifierToFilter(identifier, GROUP_FILTER_BASE);
    const entry = await this.searchOne(client, this.config.baseDn, filter, [...attributes]);
    return entry ? withAllMembers(client, entry) : null;
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
    complete?: (client: Client, e: Entry) => Promise<Entry>,
  ): AsyncIterable<T> {
    // Yield each page as it arrives, so memory is bounded by the page size
    // rather than the directory size (users carry photos). Failover happens
    // only while connecting: a search that breaks midway isn't restarted on
    // another DC, which would repeat entries.
    const client = await withFailover(this.clientConfig, async (c) => {
      await c.bind(this.config.serviceAccountUpn, this.config.serviceAccountPassword);
      return c;
    });
    try {
      const pages = client.searchPaginated(this.config.baseDn, {
        scope: 'sub',
        filter,
        attributes,
        explicitBufferAttributes: BINARY_ATTRS,
        paged: { pageSize },
      });
      for await (const page of pages) {
        for (const entry of page.searchEntries) {
          yield map(complete ? await complete(client, entry) : entry);
        }
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}

// ---- Module-private helpers ---------------------------------------------

/** Normalize groups read in one search, with every member of the large ones. */
async function normalizeGroups(client: Client, entries: Entry[]): Promise<DirectoryGroup[]> {
  const groups: DirectoryGroup[] = [];
  for (const entry of entries) groups.push(normalizeGroup(await withAllMembers(client, entry)));
  return groups;
}

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
      errorMessage: certificateProblemMessage(err) ?? `cannot reach directory: ${message}`,
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
  // NUL (written as \0, never a raw byte) is intentionally escaped per RFC 4514 §2.4
  return value.replace(/[,+<>;"=\\\0]/g, (m) => `\\${m}`);
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
  streetAddress: 'streetAddress',
  description: 'description',
  company: 'company',
  c: 'c',
  co: 'co',
  l: 'l',
  st: 'st',
  postalCode: 'postalCode',
  countryCode: 'countryCode',
  physicalDeliveryOfficeName: 'physicalDeliveryOfficeName',
  // writeUserAttributes checks the manager is a user, and not the user itself.
  managerDn: 'manager',
};

/** Map our multi-valued patch field name → the AD attribute name. */
const PATCH_MULTI_ATTRIBUTE_MAP: Record<string, string> = {
  otherMailbox: 'otherMailbox',
  otherHomePhone: 'otherHomePhone',
  otherMobile: 'otherMobile',
  postOfficeBox: 'postOfficeBox',
};

/**
 * Translate a `UserAttributePatch` into a set of LDAP `Change` ops.
 *
 * Scalar fields (PATCH_ATTRIBUTE_MAP):
 *   - `undefined` ⇒ field absent, skip
 *   - `null` or empty string ⇒ clear the AD attribute
 *   - anything else ⇒ replace with the trimmed value
 *
 * Multi-valued fields (PATCH_MULTI_ATTRIBUTE_MAP):
 *   - `undefined` ⇒ skip
 *   - `null` or empty array ⇒ clear the AD attribute
 *   - non-empty array ⇒ replace with all (trimmed, non-empty) values
 *
 * A clear is a replace with no values, not a delete: a delete of an
 * attribute the user doesn't have fails the whole modify, a replace
 * with none is a no-op then.
 *
 * Returns an empty array if every field was undefined.
 */
function buildAttributeChanges(patch: UserAttributePatch): Change[] {
  const data = patch as Record<string, unknown>;
  const replace = (type: string, values: string[]) =>
    new Change({ operation: 'replace', modification: new Attribute({ type, values }) });
  const changes: Change[] = [];
  for (const [patchKey, attrName] of Object.entries(PATCH_ATTRIBUTE_MAP)) {
    const raw = data[patchKey];
    if (raw === undefined) continue;
    const value = typeof raw === 'string' ? raw.trim() : '';
    changes.push(replace(attrName, value ? [value] : []));
  }
  for (const [patchKey, attrName] of Object.entries(PATCH_MULTI_ATTRIBUTE_MAP)) {
    const raw = data[patchKey];
    if (raw === undefined) continue;
    const values = Array.isArray(raw)
      ? raw
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
      : [];
    changes.push(replace(attrName, values));
  }
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
    streetAddress: rawAuditScalar(raw['streetAddress']),
    description: rawAuditScalar(raw['description']),
    company: rawAuditScalar(raw['company']),
    c: rawAuditScalar(raw['c']),
    co: rawAuditScalar(raw['co']),
    l: rawAuditScalar(raw['l']),
    st: rawAuditScalar(raw['st']),
    postalCode: rawAuditScalar(raw['postalCode']),
    postOfficeBox: rawAuditArray(raw['postOfficeBox']),
    countryCode: rawAuditScalar(raw['countryCode']),
    physicalDeliveryOfficeName: user.office ?? null,
    managerDn: user.managerDn,
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

/** The identity attributes a rename can touch, for the audit trail. */
function renameSnapshot(user: DirectoryUser): Record<string, unknown> {
  const raw = user.rawAttributes;
  return {
    distinguishedName: user.distinguishedName,
    cn: rawAuditScalar(raw['cn']),
    givenName: user.givenName,
    surname: user.surname,
    displayName: user.displayName,
    samAccountName: user.samAccountName,
    userPrincipalName: user.userPrincipalName,
    email: user.email,
    proxyAddresses: rawAuditArray(raw['proxyAddresses']),
  };
}

/**
 * What a deleted account looked like. On domains without the Recycle Bin
 * the tombstone loses most of this, so the audit row is the only record of
 * the account's groups and attributes.
 */
function deletionSnapshot(user: DirectoryUser): Record<string, unknown> {
  return {
    ...snapshotForAudit(user),
    distinguishedName: user.distinguishedName,
    samAccountName: user.samAccountName,
    userPrincipalName: user.userPrincipalName,
    sid: user.sid,
    enabled: user.enabled,
    memberOf: user.memberOfDns,
  };
}

/**
 * A group as the audit trail keeps it. Its members and parent groups are
 * here because a deleted group's tombstone doesn't keep them.
 */
function groupSnapshot(group: DirectoryGroup): Record<string, unknown> {
  return {
    distinguishedName: group.distinguishedName,
    name: group.name,
    samAccountName: group.samAccountName,
    sid: group.sid,
    description: group.description,
    groupScope: group.groupScope,
    groupType: group.groupType,
    members: group.memberDns,
    memberOf: group.memberOfDns,
  };
}

type AccountKind = 'user' | 'computer';

/** The refusal for a domain controller or critical computer, or null. */
function protectedComputer(entry: Entry): MutationResult | null {
  const block = computerWriteBlock(entry);
  return block
    ? { ok: false, reason: 'policy_violation', errorMessage: describeComputerWriteBlock(block) }
    : null;
}

/** An entry's userAccountControl as a number; NaN when unparseable. */
function userAccountControlOf(entry: Entry): number {
  const raw = (entry as { userAccountControl?: string | string[] }).userAccountControl;
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return value ? Number.parseInt(String(value), 10) : 0;
}

type ClashAttribute = 'samAccountName' | 'userPrincipalName' | 'email' | 'cn';
const CLASH_ORDER: readonly ClashAttribute[] = [
  'samAccountName',
  'userPrincipalName',
  'email',
  'cn',
];

/**
 * Set a password, and must-change with it. One modify, so a password AD
 * refuses leaves `pwdLastSet` alone; without must-change, AD sets
 * `pwdLastSet` to now. AD requires the value as UTF-16LE in quotes, over
 * an encrypted connection.
 */
function passwordChanges(password: string, mustChange: boolean): Change[] {
  const changes = [
    new Change({
      operation: 'replace',
      modification: new Attribute({
        type: 'unicodePwd',
        values: [encodeUnicodePassword(password)],
      }),
    }),
  ];
  if (mustChange) {
    changes.push(
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'pwdLastSet', values: ['0'] }),
      }),
    );
  }
  return changes;
}

function accountControlChange(userAccountControl: number): Change {
  return new Change({
    operation: 'replace',
    modification: new Attribute({
      type: 'userAccountControl',
      values: [String(userAccountControl)],
    }),
  });
}

/**
 * A refused password write. AD reports a password its policy rejects
 * under several result codes (constraint violation, unwilling to
 * perform), always with extended error 0000052D; Samba names the
 * restriction instead.
 */
function classifyPasswordError(err: unknown): MutationResult {
  const refused = classifyWriteError(err);
  return /\b0*52D\b|password_restrictions|policy|complexity|length|history/i.test(
    refused.errorMessage ?? '',
  )
    ? { ...refused, reason: 'policy_violation' }
    : refused;
}

/**
 * Map an LDAP write failure to a MutationResult reason by result code
 * rather than by message text, which varies across DC versions.
 */
function classifyWriteError(err: unknown): MutationResult {
  const errorMessage = err instanceof Error ? err.message : 'write failed';
  if (err instanceof InsufficientAccessError) {
    return { ok: false, reason: 'permission_denied', errorMessage };
  }
  if (err instanceof AlreadyExistsError || err instanceof ConstraintViolationError) {
    return { ok: false, reason: 'conflict', errorMessage };
  }
  if (err instanceof UnwillingToPerformError || err instanceof NotAllowedOnNonLeafError) {
    return { ok: false, reason: 'policy_violation', errorMessage };
  }
  return { ok: false, reason: 'directory_error', errorMessage };
}
