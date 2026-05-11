// SPDX-License-Identifier: BUSL-1.1
// Provider abstraction over LDAP/AD/Entra. The MVP only ships an Active
// Directory implementation, but routes/services depend on this interface so
// future providers (generic LDAP, Entra ID/Graph) can drop in without rewrites.

export type ProviderType = 'active-directory' | 'ldap' | 'entra';

// A directory object can be referenced by any of these. Implementations should
// resolve the cheapest unique form first (objectGuid > distinguishedName > sAMAccountName/UPN).
export type DirectoryObjectIdentifier =
  | { kind: 'objectGuid'; value: string } // canonical UUID string
  | { kind: 'distinguishedName'; value: string }
  | { kind: 'samAccountName'; value: string }
  | { kind: 'userPrincipalName'; value: string };

export interface DirectoryUser {
  objectGuid: string;
  sid: string | null;
  distinguishedName: string;
  samAccountName: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  department: string | null;
  managerDn: string | null;
  enabled: boolean;
  locked: boolean;
  /**
   * FILETIME of `lockoutTime` converted to a Date. Non-null when AD has an
   * active lockout stamp on the account. This may co-exist with locked=false
   * when the lockout duration has auto-expired but AD hasn't cleared the
   * attribute yet — useful for "last locked at" display either way.
   */
  lockedAt: Date | null;
  // Reflects the DONT_EXPIRE_PASSWORD bit (0x10000) of userAccountControl.
  // True for service accounts and other accounts AD will never force a
  // password rotation on.
  passwordNeverExpires: boolean;
  passwordLastSetAt: Date | null;
  passwordExpiresAt: Date | null;
  accountExpiresAt: Date | null;
  lastLogonAt: Date | null;
  // FILETIME of the most recent failed authentication attempt (AD's
  // `badPasswordTime`). Per-DC, replicated late — treat as approximate.
  lastBadPasswordAt: Date | null;
  createdAtSource: Date | null;
  modifiedAtSource: Date | null;
  // Direct group memberships only. Nested are derived elsewhere.
  memberOfDns: string[];
  // Raw LDAP attributes for the audit trail / debugging. Sensitive values are
  // not included by the implementation (e.g. unicodePwd).
  rawAttributes: Record<string, unknown>;
}

export interface DirectoryOu {
  // OUs aren't keyed by objectGUID in the cache (we don't need cross-rename
  // tracking the way we do for users/groups). The DN is the natural key.
  distinguishedName: string;
  // The `ou` or `name` attribute — the user-friendly leaf label. Falls back
  // to the leftmost DN component when neither is populated.
  name: string;
  // Parent DN — null when the OU sits directly under a non-OU container
  // (e.g. the domain root). Used to render the tree client-side.
  parentDn: string | null;
  rawAttributes: Record<string, unknown>;
}

export interface DirectoryGroup {
  objectGuid: string;
  sid: string | null;
  distinguishedName: string;
  samAccountName: string | null;
  name: string | null;
  description: string | null;
  email: string | null;
  groupType: string | null;
  groupScope: string | null;
  // Direct member DNs.
  memberDns: string[];
  rawAttributes: Record<string, unknown>;
}

/**
 * A Group Policy Container (GPC) as it appears in AD under
 * `CN=Policies,CN=System,<baseDn>`. The GPC is only the AD half of a GPO —
 * the actual policy settings (registry.pol, GptTmpl.inf, ADMX-driven entries)
 * live in SYSVOL at `gpcFileSysPath` and are not read here. So this view shows
 * "what GPOs exist, where they're linked, and how they're configured at the
 * directory layer", not "what each GPO does to a target machine".
 *
 * Field semantics for the parsed bits:
 *   - `gpoGuid` is the curly-braced identifier in the CN (e.g.
 *     `{31B2F340-016D-11D2-945F-00C04FB984F9}`) — this is the value the
 *     `gPLink` attribute on OUs/sites/domain references. Distinct from
 *     `objectGuid`, the directory-assigned GUID for the AD entry itself.
 *   - `versionNumber` is a 32-bit packed value: low 16 bits = computer-policy
 *     version, high 16 bits = user-policy version. Surfaced as `userVersion`
 *     and `computerVersion` for readability; the raw value stays in
 *     `rawAttributes` for auditing.
 *   - `flags` 0=both enabled, 1=user-policy disabled, 2=computer-policy
 *     disabled, 3=both disabled. Decoded into the two booleans.
 */
export interface DirectoryGroupPolicy {
  /** AD-assigned GUID for the GPC entry. Stable across renames. */
  objectGuid: string;
  /** Curly-braced GPO GUID (the CN). Used as the public identifier in
   * `gPLink` references. */
  gpoGuid: string;
  distinguishedName: string;
  /** Friendly name (`displayName` attribute). May be null on pristine AD
   * installs where only the cn-GUID is populated. */
  displayName: string | null;
  /** SYSVOL path containing the policy's GPT files
   * (`\\domain\sysvol\domain\Policies\{guid}`). */
  fileSysPath: string | null;
  /** GPC schema version — '2' on every modern domain. Kept for completeness. */
  functionalityVersion: number | null;
  /** Packed version number from AD. Same value the engine uses to detect
   * client-side cache invalidation. */
  versionNumberRaw: number | null;
  /** Decoded user half of `versionNumber` (high 16 bits). */
  userVersion: number | null;
  /** Decoded computer half of `versionNumber` (low 16 bits). */
  computerVersion: number | null;
  /** Raw `flags` value, 0–3. Null when the attribute isn't populated. */
  flagsRaw: number | null;
  userPolicyEnabled: boolean;
  computerPolicyEnabled: boolean;
  /** WMI filter reference (`gPCWQLFilter`), e.g.
   * `[example.local;{guid};0]`. We don't resolve to the WMI filter object
   * here — surfacing the raw string is enough to identify it. */
  wmiFilterRef: string | null;
  /** Configured client-side extensions for computer policy. AD stores these
   * as a single string of bracketed `{cseGuid}{toolGuid}…` runs; we parse
   * out just the leading CSE GUIDs (one per run). Used to know which policy
   * areas the GPO touches without parsing SYSVOL. */
  computerExtensionGuids: string[];
  /** Same as above for user policy. */
  userExtensionGuids: string[];
  createdAtSource: Date | null;
  modifiedAtSource: Date | null;
  rawAttributes: Record<string, unknown>;
}

/**
 * A single `gPLink` association between a GPO and a scope object (OU, domain
 * root, or site). One scope can link many GPOs (ordered by precedence) and
 * one GPO can be linked from many scopes — so this is the join row.
 *
 * `flags` values per [MS-GPOL] §2.2.2: 0=normal, 1=link disabled,
 * 2=enforced, 3=disabled+enforced.
 */
export interface DirectoryGroupPolicyLink {
  /** DN of the AD object that carries the `gPLink` attribute (OU,
   * domainDNS, or site). */
  scopeDn: string;
  /** DN referenced inside the `gPLink` value — points at the GPC. */
  gpoDn: string;
  /** Curly-braced GUID extracted from `gpoDn`'s leading CN, for cross-ref
   * with `DirectoryGroupPolicy.gpoGuid`. */
  gpoGuid: string;
  /** Position within the scope's `gPLink` value (0 = first applied,
   * highest precedence given equal enforcement). */
  order: number;
  flagsRaw: number;
  enabled: boolean;
  enforced: boolean;
}

export interface DirectoryComputer {
  objectGuid: string;
  sid: string | null;
  distinguishedName: string;
  // sAMAccountName for computers ends in `$` (e.g. "WIN10-DEV$").
  samAccountName: string | null;
  // The CN — typically the bare hostname without the trailing `$`.
  name: string | null;
  // dNSHostName — the FQDN AD uses for Kerberos. Often null on stale joins.
  dnsHostName: string | null;
  operatingSystem: string | null;
  operatingSystemVersion: string | null;
  description: string | null;
  // managedBy DN — the user/group designated as the owner of the machine.
  managedByDn: string | null;
  // userAccountControl ACCOUNTDISABLE bit — disabled computer accounts can no
  // longer authenticate to the domain.
  enabled: boolean;
  lastLogonAt: Date | null;
  passwordLastSetAt: Date | null;
  // Direct group memberships (computers can be in groups; common for GPO
  // targeting and resource ACLs).
  memberOfDns: string[];
  createdAtSource: Date | null;
  modifiedAtSource: Date | null;
  rawAttributes: Record<string, unknown>;
}

export interface DirectoryComputerSearchQuery {
  pageSize?: number;
  text?: string;
  enabled?: boolean;
  operatingSystem?: string;
  searchBase?: string;
}

export interface DirectoryDeletedComputer {
  objectGuid: string;
  cn: string | null;
  samAccountName: string | null;
  dnsHostName: string | null;
  operatingSystem: string | null;
  deletedDn: string;
  lastKnownParent: string | null;
  deletedAt: Date | null;
  recycled: boolean;
  rawAttributes: Record<string, unknown>;
}

export interface DeletedComputerSearchInput {
  pageSize?: number;
  text?: string;
}

export interface DirectoryUserSearchQuery {
  // Paging.
  pageSize?: number;
  // Server-side filters. Implementations may translate or ignore subsets they
  // can't push down — the cache layer will filter the rest.
  text?: string;
  enabled?: boolean;
  locked?: boolean;
  // Limit the search to a sub-tree under this DN (e.g. an OU).
  searchBase?: string;
}

export interface DirectoryGroupSearchQuery {
  pageSize?: number;
  text?: string;
  searchBase?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  // Diagnostic info: server-detected base DN, dse attributes, etc.
  details?: Record<string, unknown>;
}

export interface AuthenticateInput {
  username: string; // sAMAccountName or UPN
  password: string;
}

export interface AuthResult {
  ok: boolean;
  // Populated only when ok=true.
  user?: DirectoryUser;
  // Populated only when ok=true. Direct group DNs the user belongs to.
  groupDns?: string[];
  // Populated when ok=false.
  reason?: 'invalid_credentials' | 'account_disabled' | 'account_locked' | 'directory_error';
  errorMessage?: string;
}

// Context required for every write operation. Carries the actor identity,
// the credential to re-bind with (write-as-user model), and the audit metadata
// the provider needs to attach to the change.
export interface WriteContext {
  actorUserId: string;
  actorUsername: string;
  actorPassword: string; // used for the per-write LDAP bind; never persisted
  correlationId: string;
}

export interface MutationResult {
  ok: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: 'not_found' | 'permission_denied' | 'policy_violation' | 'directory_error';
  errorMessage?: string;
}

export interface UserAttributePatch {
  // Scalar single-valued attributes — string clears with null or empty.
  displayName?: string | null | undefined;
  givenName?: string | null | undefined;
  surname?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  mobile?: string | null | undefined;
  title?: string | null | undefined;
  department?: string | null | undefined;
  employeeID?: string | null | undefined;
  employeeNumber?: string | null | undefined;
  ipPhone?: string | null | undefined;
  homePhone?: string | null | undefined;
  homePostalAddress?: string | null | undefined;
  description?: string | null | undefined;
  company?: string | null | undefined;
  c?: string | null | undefined;
  co?: string | null | undefined;
  l?: string | null | undefined;
  st?: string | null | undefined;
  postalCode?: string | null | undefined;
  managerDn?: string | null | undefined;
  accountExpiresAt?: Date | null | undefined;
  // Multi-valued attributes — null or empty array clears, non-empty replaces.
  otherMailbox?: string[] | null | undefined;
  otherHomePhone?: string[] | null | undefined;
  otherMobile?: string[] | null | undefined;
}

export interface ResetPasswordInput {
  newPassword: string;
  forceChangeAtNextLogin: boolean;
}

export interface SyncInput {
  pageSize?: number;
  modifiedSince?: Date;
}

/**
 * Domain-wide security policy as read from the AD root object. All fields are
 * nullable: a non-privileged reader may not see every attribute, and we'd
 * rather degrade gracefully than fail.
 *
 * Durations are normalized to ms (or minutes/days at the API edge) so the
 * caller doesn't deal with FILETIME ticks.
 */
export interface DirectoryDomainPolicy {
  /** Lockout duration in ms. 0 = manual unlock only. Null = unknown. */
  lockoutDurationMs: number | null;
  /** Bad-password attempts before AD locks. 0 = lockout disabled. Null = unknown. */
  lockoutThreshold: number | null;
  /** Observation window in ms — rolling window for bad-password counter. */
  lockoutObservationMs: number | null;
  /** maxPwdAge in ms. 0 = never expire. Null = unknown. */
  maxPwdAgeMs: number | null;
  /** Minimum password length. */
  minPwdLength: number | null;
  /** Number of past passwords AD remembers. */
  pwdHistoryLength: number | null;
}

export interface DirectoryProvider {
  readonly id: number;
  readonly name: string;
  readonly type: ProviderType;

  testConnection(): Promise<ConnectionTestResult>;
  authenticateUser(input: AuthenticateInput): Promise<AuthResult>;

  /**
   * Read the domain root for the password / lockout policy. Implementations
   * may cache the result internally for a short TTL (the policy rarely
   * changes); callers should not need to throttle.
   */
  getDomainPolicy(): Promise<DirectoryDomainPolicy>;

  getUser(identifier: DirectoryObjectIdentifier): Promise<DirectoryUser | null>;
  searchUsers(query: DirectoryUserSearchQuery): Promise<DirectoryUser[]>;
  getGroup(identifier: DirectoryObjectIdentifier): Promise<DirectoryGroup | null>;
  searchGroups(query: DirectoryGroupSearchQuery): Promise<DirectoryGroup[]>;
  getUserGroups(userId: DirectoryObjectIdentifier): Promise<DirectoryGroup[]>;
  getGroupMembers(groupId: DirectoryObjectIdentifier): Promise<DirectoryUser[]>;
  getComputer(identifier: DirectoryObjectIdentifier): Promise<DirectoryComputer | null>;
  searchComputers(query: DirectoryComputerSearchQuery): Promise<DirectoryComputer[]>;
  // Resolve the groups a computer's DN belongs to. Mirrors getUserGroups.
  getComputerGroups(computerId: DirectoryObjectIdentifier): Promise<DirectoryGroup[]>;

  syncUsers(input: SyncInput): AsyncIterable<DirectoryUser>;
  syncGroups(input: SyncInput): AsyncIterable<DirectoryGroup>;
  syncComputers(input: SyncInput): AsyncIterable<DirectoryComputer>;
  syncOus(input: SyncInput): AsyncIterable<DirectoryOu>;

  // Group Policy reads. The cache layer (policies.full sync task) drives
  // every UI surface; these are the source-of-truth pulls used by that
  // runner. searchGroupPolicies returns the GPC catalog; getGroupPolicy
  // resolves a single GPO by objectGuid; getGroupPolicyLinks scans the
  // domain naming context for every populated `gPLink` and returns one
  // entry per bracketed run.
  searchGroupPolicies(): Promise<DirectoryGroupPolicy[]>;
  getGroupPolicy(identifier: DirectoryObjectIdentifier): Promise<DirectoryGroupPolicy | null>;
  getGroupPolicyLinks(): Promise<DirectoryGroupPolicyLink[]>;

  // Writes. Vertical slice only ships unlockUser. Other methods are typed here
  // so route signatures can be stable, but the AD provider may throw
  // 'not_implemented' until later phases land them.
  unlockUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult>;
  resetPassword(
    userId: DirectoryObjectIdentifier,
    input: ResetPasswordInput,
    ctx: WriteContext,
  ): Promise<MutationResult>;
  enableUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult>;
  disableUser(userId: DirectoryObjectIdentifier, ctx: WriteContext): Promise<MutationResult>;
  updateUserAttributes(
    userId: DirectoryObjectIdentifier,
    patch: UserAttributePatch,
    ctx: WriteContext,
  ): Promise<MutationResult>;
  addUserToGroup(
    userId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult>;
  removeUserFromGroup(
    userId: DirectoryObjectIdentifier,
    groupId: DirectoryObjectIdentifier,
    ctx: WriteContext,
  ): Promise<MutationResult>;
  // Move a user to a new parent OU (LDAP modifyDN keeping the existing RDN).
  // Idempotent: if already under `targetOuDn`, returns ok with a no-op.
  moveUser(
    userId: DirectoryObjectIdentifier,
    targetOuDn: string,
    ctx: WriteContext,
  ): Promise<MutationResult>;
  // Create a new OU as a direct child of `parentDn`. Returns the resulting
  // DirectoryOu so the route can update its cache row in place rather than
  // waiting for the next sync.
  createOu(
    parentDn: string,
    name: string,
    description: string | null,
    ctx: WriteContext,
  ): Promise<MutationResult & { ou?: DirectoryOu }>;
  // Delete an OU. AD refuses to delete a non-empty OU at the wire level
  // (LDAP_NOT_ALLOWED_ON_NONLEAF / 66). The route layer pre-checks the
  // cache and refuses early so the operator gets a clean 409 instead of a
  // bare LDAP error.
  deleteOu(dn: string, ctx: WriteContext): Promise<MutationResult>;
  // Update mutable OU attributes. Today the only supported field is
  // `description`; rename (modifyDN-of-OU) is intentionally not exposed
  // because the cascading DN rewrite makes our cache + audit story messy.
  updateOuAttributes(
    dn: string,
    patch: OuAttributePatch,
    ctx: WriteContext,
  ): Promise<MutationResult>;

  // Recycle Bin / deleted objects. Requires AD-specific LDAP controls;
  // non-AD providers may throw 'not_implemented'.
  //
  // All four methods bind as the operator (write-as-user model), not the
  // service account. The deleted-objects container is restricted by
  // default to Domain Admins, so this lets AD's own ACLs decide who can
  // see and restore what — the service account stays minimally
  // privileged. The route layer enforces step-up so the operator's bind
  // password is available in the credential cache.
  getRecycleBinStatus(ctx: WriteContext): Promise<RecycleBinStatus>;
  searchDeletedUsers(
    query: DeletedUserSearchInput,
    ctx: WriteContext,
  ): Promise<DirectoryDeletedUser[]>;
  getDeletedUser(objectGuid: string, ctx: WriteContext): Promise<DirectoryDeletedUser | null>;
  // Reanimate a deleted user. Requires the Reanimate Tombstones extended
  // right; will return permission_denied otherwise. Cannot restore entries
  // that have transitioned to recycled state.
  restoreDeletedUser(
    objectGuid: string,
    input: RestoreUserInput,
    ctx: WriteContext,
  ): Promise<RestoreResult>;

  // Computers — read-only view into the Deleted Objects container, scoped
  // to objectClass=computer. No restore primitive (v1 does not surface
  // computer reanimation).
  searchDeletedComputers(
    query: DeletedComputerSearchInput,
    ctx: WriteContext,
  ): Promise<DirectoryDeletedComputer[]>;
  getDeletedComputer(
    objectGuid: string,
    ctx: WriteContext,
  ): Promise<DirectoryDeletedComputer | null>;
}

export interface OuAttributePatch {
  // null clears the attribute, undefined skips the field, a string replaces.
  description?: string | null | undefined;
}

// ---- Deleted users (AD Recycle Bin / tombstones) -------------------------

export interface RecycleBinStatus {
  // True when the AD Recycle Bin Optional Feature is enabled. False means
  // the directory uses tombstones — restores succeed but most attributes
  // (including group memberships) are not preserved.
  recycleBinEnabled: boolean;
  // The CN=Deleted Objects container DN. Null when the provider couldn't
  // discover it (e.g. service account lacks read on the configuration
  // partition's Optional Features container).
  deletedObjectsContainer: string | null;
  // Diagnostic message when state is partially unknown. Null on success.
  message: string | null;
}

export interface DirectoryDeletedUser {
  objectGuid: string;
  // Original CN with the AD `\nADEL:<guid>` tombstone suffix stripped.
  cn: string | null;
  samAccountName: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
  email: string | null;
  // The DN the entry currently lives at (under Deleted Objects).
  deletedDn: string;
  // Where the entry was deleted from. Null when AD didn't preserve it.
  lastKnownParent: string | null;
  // When the object transitioned to deleted (whenChanged on the delete).
  deletedAt: Date | null;
  // True when AD has further demoted the entry to recycled state. Recycled
  // entries cannot be restored — surfaced so the UI can disable the action.
  recycled: boolean;
  rawAttributes: Record<string, unknown>;
}

export interface DeletedUserSearchInput {
  pageSize?: number;
  text?: string;
}

export interface RestoreUserInput {
  // When omitted, the restore reuses the entry's lastKnownParent. Pass an
  // explicit DN to restore into a different OU (useful when the original
  // parent was also deleted and not yet restored).
  targetParentDn?: string;
}

export interface RestoreResult extends MutationResult {
  restoredDn?: string;
}

/**
 * Thrown by read-as-operator methods when the operator's bind to the
 * directory fails — typically because the cached step-up password has
 * expired or was wiped. Distinct from a plain directory error because the
 * route should map it to a 401/403 prompting re-elevation, not a 502.
 */
export class StepUpBindFailedError extends Error {
  constructor(message = 'step-up bind failed') {
    super(message);
    this.name = 'StepUpBindFailedError';
  }
}
