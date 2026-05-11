// SPDX-License-Identifier: BUSL-1.1
import type { Entry } from 'ldapts';
import type {
  DirectoryComputer,
  DirectoryDeletedComputer,
  DirectoryDeletedUser,
  DirectoryGroup,
  DirectoryGroupPolicy,
  DirectoryGroupPolicyLink,
  DirectoryOu,
  DirectoryUser,
} from '../types.js';
import {
  filetimeToDate,
  isLocked,
  objectGuidToString,
  parseUserAccountControl,
  sidToString,
} from './utils.js';

// Attributes ldapts should always return as Buffer rather than UTF-8 strings.
// Without this list, ldapts would mangle binary GUID/SID values. The photo
// blobs are listed so we can drop them from rawAttributes by Buffer-shape
// detection without parsing them as UTF-8 first.
export const BINARY_ATTRS = [
  'objectGUID',
  'objectSid',
  'thumbnailPhoto',
  'jpegPhoto',
  'msExchBlockedSendersHash',
  'msExchSafeSendersHash',
  'msExchSafeRecipientsHash',
];

// Attributes the wildcard query returns but that we don't want to surface
// anywhere — neither in the UI's "More from directory" extras, the Raw LDAP
// tab, nor the cached rawAttributes JSONB blob. Either redundant with a
// typed field (`dn` mirrors distinguishedName), Entra-sync noise the
// operator can't act on, or fields the operator explicitly opted out of.
const SKIP_RAW_ATTRS = new Set<string>([
  'physicalDeliveryOfficeName',
  'url',
  'msExchCoManagedObjectsBL',
  'mS-DS-ConsistencyGuid',
  'dn',
  'wWWHomePage',
  'msExchExtensionCustomAttribute1',
  'carLicense',
  'loginShell',
  'msDS-SupportedEncryptionTypes',
  // postalAddress is the work-address attribute and overlaps with
  // streetAddress/l/st/postalCode that we surface explicitly. Drop it from
  // the raw view so operators aren't comparing two addresses for the same
  // place. (Distinct from `proxyAddresses` despite the similar name —
  // proxyAddresses is the email-aliases attribute we still consume.)
  'postalAddress',
  'preferredLanguage',
  'extensionAttribute1',
  // managedObjects is the back-link of `manager` — the list of users this
  // person manages. We already surface that through `directReports` with
  // names resolved, so the raw DN list is duplicate noise.
  'managedObjects',
]);

// Attribute set for deleted-object reads. Recycle-Bin-enabled domains keep
// most user attributes around for the deleted-object lifetime; tombstones
// strip down to a minimal preserved set. Pulling '*' would also work but
// would drag in tombstone-only operational attributes we don't surface.
export const DELETED_USER_ATTRS = [
  'objectGUID',
  'distinguishedName',
  'cn',
  'sAMAccountName',
  'userPrincipalName',
  'displayName',
  'mail',
  'lastKnownParent',
  'isDeleted',
  'isRecycled',
  'whenChanged',
];

// Curated attribute set for hot paths that don't need the full record:
// search results, group-member lookups, auth lookups. Detail reads and the
// nightly sync request '*' instead so the cache + Raw LDAP view can show
// everything AD has on the account.
export const USER_ATTRS = [
  'objectGUID',
  'objectSid',
  'distinguishedName',
  'sAMAccountName',
  'userPrincipalName',
  'displayName',
  'givenName',
  'sn',
  'mail',
  'telephoneNumber',
  'mobile',
  'title',
  'department',
  'manager',
  'memberOf',
  'userAccountControl',
  'lockoutTime',
  'pwdLastSet',
  'accountExpires',
  'lastLogonTimestamp',
  'badPasswordTime',
  'whenCreated',
  'whenChanged',
];

// Wildcard pulls every non-operational attribute populated on the entry —
// extra mails, secondary phones, addresses, employeeID, etc. Used by detail
// reads and full sync; the cache stores the raw blob so the UI can decide
// what to surface without a schema change per attribute.
export const USER_ATTRS_FULL = ['*'];

export const OU_ATTRS = [
  'distinguishedName',
  'ou',
  'name',
  'description',
  'whenCreated',
  'whenChanged',
];

export const GROUP_ATTRS = [
  'objectGUID',
  'objectSid',
  'distinguishedName',
  'sAMAccountName',
  'cn',
  'displayName',
  'description',
  'mail',
  'groupType',
  'member',
  'whenCreated',
  'whenChanged',
];

// Curated attribute set for computer reads. Computers don't carry the
// password/lockout machinery users do; the interesting axes are OS, FQDN,
// last logon, and group membership (for GPO targeting / resource ACLs).
export const COMPUTER_ATTRS = [
  'objectGUID',
  'objectSid',
  'distinguishedName',
  'sAMAccountName',
  'cn',
  'name',
  'dNSHostName',
  'operatingSystem',
  'operatingSystemVersion',
  'description',
  'managedBy',
  'memberOf',
  'userAccountControl',
  'pwdLastSet',
  'lastLogonTimestamp',
  'whenCreated',
  'whenChanged',
];

// Detail / sync use '*' so the cache + Raw view see every populated attribute.
export const COMPUTER_ATTRS_FULL = ['*'];

// GPOs are typically a small set per domain (dozens, not thousands), so we
// always pull the full attribute set — the operator's whole reason to open
// this view is to inspect every directory-side detail. The route is
// live-LDAP, no cache; this list is for documentation and to keep the
// request explicit.
export const GPO_ATTRS = ['*'];

// Scope objects that can carry a `gPLink` value: OUs, the domain root, and
// site objects under the configuration NC. We pull only the attributes
// needed to associate each link back to its GPO.
export const GPLINK_SCAN_ATTRS = ['distinguishedName', 'gPLink'];

// Tombstoned-computer attribute set. Mirrors DELETED_USER_ATTRS but pulls
// the computer-specific fields so the operator sees what they're looking
// at without requesting '*' (which would drag in tombstone-only ops attrs).
export const DELETED_COMPUTER_ATTRS = [
  'objectGUID',
  'distinguishedName',
  'cn',
  'sAMAccountName',
  'dNSHostName',
  'operatingSystem',
  'lastKnownParent',
  'isDeleted',
  'isRecycled',
  'whenChanged',
];

/** Normalize a single attribute value to a string (last value wins for multi-valued). */
export function asString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    return asString(v[v.length - 1]);
  }
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return String(v);
}

export function asStringArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((x): x is string => x !== null);
  const single = asString(v);
  return single ? [single] : [];
}

function asBuffer(v: unknown): Buffer | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length === 0 ? null : asBuffer(v[0]);
  if (Buffer.isBuffer(v)) return v;
  return null;
}

/**
 * Recursively scrub Buffer values out of an attribute payload before it
 * lands in JSONB. Returns the cleaned value or `undefined` if the entire
 * value collapsed to nothing (so the caller can drop the key).
 *
 * Single Buffer → undefined; arrays containing Buffers keep their non-Buffer
 * entries; primitives pass through unchanged.
 */
function stripBuffers(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  if (Buffer.isBuffer(v)) return undefined;
  if (Array.isArray(v)) {
    const cleaned = v.filter((x) => !Buffer.isBuffer(x));
    return cleaned.length === 0 ? undefined : cleaned;
  }
  return v;
}

/**
 * `whenCreated` / `whenChanged` are GeneralizedTime, e.g.
 * "20240115083422.0Z". Date can parse the trimmed form.
 */
function parseGeneralizedTime(v: unknown): Date | null {
  const s = asString(v);
  if (!s) return null;
  // Strip fractional seconds, normalize timezone marker.
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeUser(entry: Entry): DirectoryUser {
  const guidBuf = asBuffer(entry.objectGUID);
  if (!guidBuf) {
    throw new Error(`LDAP user entry missing objectGUID: ${asString(entry.distinguishedName)}`);
  }
  const sidBuf = asBuffer(entry.objectSid);

  const uac = parseUserAccountControl(asString(entry.userAccountControl));
  const lockoutTimeStr = asString(entry.lockoutTime);
  const lockedNow = isLocked(lockoutTimeStr);
  const lockoutFiletime = filetimeToDate(lockoutTimeStr);
  const dn = asString(entry.distinguishedName);
  if (!dn) {
    throw new Error('LDAP user entry missing distinguishedName');
  }

  const passwordLastSet = filetimeToDate(asString(entry.pwdLastSet));

  // Build the audit-friendly raw view. Binary attributes — GUID/SID and the
  // photo/hash blobs — are omitted entirely: they're either represented in
  // typed fields above (objectGuid, sid) or they're large binary payloads we
  // don't render in the UI today. Anything that comes back as a Buffer is
  // also skipped defensively in case AD returns one we didn't anticipate.
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BINARY_ATTRS.includes(k)) continue;
    if (SKIP_RAW_ATTRS.has(k)) continue;
    const cleaned = stripBuffers(v);
    if (cleaned === undefined) continue;
    raw[k] = cleaned;
  }

  return {
    objectGuid: objectGuidToString(guidBuf),
    sid: sidBuf ? sidToString(sidBuf) : null,
    distinguishedName: dn,
    samAccountName: asString(entry.sAMAccountName),
    userPrincipalName: asString(entry.userPrincipalName),
    displayName: asString(entry.displayName),
    givenName: asString(entry.givenName),
    surname: asString(entry.sn),
    email: asString(entry.mail),
    phone: asString(entry.telephoneNumber),
    mobile: asString(entry.mobile),
    title: asString(entry.title),
    department: asString(entry.department),
    managerDn: asString(entry.manager),
    enabled: uac.enabled,
    locked: lockedNow,
    lockedAt: lockoutFiletime,
    passwordNeverExpires: uac.passwordNeverExpires,
    passwordLastSetAt: passwordLastSet,
    // passwordExpiresAt requires the domain max-password-age policy. We
    // leave it null at this layer; the API route resolves it from
    // `passwordLastSetAt + getDomainPolicy().maxPwdAgeMs` so the policy
    // fetch (cached per-provider) isn't on the per-entry hot path.
    passwordExpiresAt: null,
    accountExpiresAt: filetimeToDate(asString(entry.accountExpires)),
    lastLogonAt: filetimeToDate(asString(entry.lastLogonTimestamp)),
    lastBadPasswordAt: filetimeToDate(asString(entry.badPasswordTime)),
    createdAtSource: parseGeneralizedTime(entry.whenCreated),
    modifiedAtSource: parseGeneralizedTime(entry.whenChanged),
    memberOfDns: asStringArray(entry.memberOf),
    rawAttributes: raw,
  };
}

export function normalizeOu(entry: Entry): DirectoryOu {
  const dn = asString(entry.distinguishedName);
  if (!dn) {
    throw new Error('LDAP OU entry missing distinguishedName');
  }
  // Prefer the explicit `ou` attribute; fall back to `name`; finally parse
  // the leftmost RDN value out of the DN itself so we always have a label.
  const name = asString(entry.ou) ?? asString(entry.name) ?? leafRdnValue(dn) ?? dn;

  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BINARY_ATTRS.includes(k)) continue;
    if (SKIP_RAW_ATTRS.has(k)) continue;
    const cleaned = stripBuffers(v);
    if (cleaned === undefined) continue;
    raw[k] = cleaned;
  }

  return {
    distinguishedName: dn,
    name,
    parentDn: parentDn(dn),
    rawAttributes: raw,
  };
}

/**
 * Split a DN into its first comma-separated component and the rest. The DN
 * grammar allows escaped commas ("\,"); split only on unescaped ones.
 */
function splitDnHead(dn: string): { head: string; rest: string | null } {
  let i = 0;
  while (i < dn.length) {
    const ch = dn[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === ',') {
      return { head: dn.slice(0, i).trim(), rest: dn.slice(i + 1).trim() || null };
    }
    i++;
  }
  return { head: dn.trim(), rest: null };
}

/** Return the parent DN, or null if the DN is single-component. */
export function parentDn(dn: string): string | null {
  return splitDnHead(dn).rest;
}

/** Return the leftmost RDN component, e.g. "CN=Alice Adams" from a user DN. */
export function leafRdn(dn: string): string {
  return splitDnHead(dn).head;
}

/** Return the value of the leftmost RDN ("OU=Sales,…" → "Sales"), or null. */
function leafRdnValue(dn: string): string | null {
  const { head } = splitDnHead(dn);
  const eq = head.indexOf('=');
  if (eq < 0) return null;
  return head.slice(eq + 1).trim() || null;
}

/**
 * Strip the AD tombstone DN suffix from a CN value. Per MS-ADTS
 * §3.1.1.1.5, when AD deletes an object it renames the RDN to:
 *   <originalCn> + 0x0A + "DEL:" + <objectGUID>
 *
 * The 0x0A is a literal LF byte. ldapts returns it as a real newline in
 * the string. Some tooling/logs render it as the escape sequence `\0A`
 * (three characters) instead, so we strip on either form for safety.
 *
 * Examples:
 *   "Alice Adams\nDEL:6075a4d3-..."   → "Alice Adams"
 *   "Alice Adams\\0ADEL:6075a4d3-..." → "Alice Adams"
 *   "Alice Adams"                      → "Alice Adams" (already clean)
 */
export function stripDeletedSuffix(cn: string | null): string | null {
  if (!cn) return cn;
  return cn.replace(/(?:\n|\\0A)DEL:[0-9a-f-]+$/i, '');
}

export function normalizeDeletedUser(entry: Entry): DirectoryDeletedUser {
  const guidBuf = asBuffer(entry.objectGUID);
  if (!guidBuf) {
    throw new Error(
      `LDAP deleted user entry missing objectGUID: ${asString(entry.distinguishedName)}`,
    );
  }
  const dn = asString(entry.distinguishedName);
  if (!dn) {
    throw new Error('LDAP deleted user entry missing distinguishedName');
  }
  // Build raw view the same way as the live user normalizer so the detail
  // page can render any preserved attributes uniformly.
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BINARY_ATTRS.includes(k)) continue;
    if (SKIP_RAW_ATTRS.has(k)) continue;
    const cleaned = stripBuffers(v);
    if (cleaned === undefined) continue;
    raw[k] = cleaned;
  }
  // AD stores `isDeleted` and `isRecycled` as the literal strings
  // "TRUE"/"FALSE". Treat presence-as-TRUE generously since some servers
  // omit the value entirely once deletion is complete.
  const isDeletedRaw = asString(entry.isDeleted);
  const isRecycledRaw = asString(entry.isRecycled);
  const recycled = isRecycledRaw !== null && isRecycledRaw.toUpperCase() === 'TRUE';

  return {
    objectGuid: objectGuidToString(guidBuf),
    cn: stripDeletedSuffix(asString(entry.cn)),
    samAccountName: asString(entry.sAMAccountName),
    userPrincipalName: asString(entry.userPrincipalName),
    displayName: asString(entry.displayName),
    email: asString(entry.mail),
    deletedDn: dn,
    lastKnownParent: asString(entry.lastKnownParent),
    deletedAt: parseGeneralizedTime(entry.whenChanged),
    recycled,
    rawAttributes: raw,
  };
  // isDeletedRaw is read for completeness — every entry returned with the
  // ShowDeleted control should have it; we don't gate on the value because
  // the search filter already requires (isDeleted=TRUE).
  void isDeletedRaw;
}

export function normalizeComputer(entry: Entry): DirectoryComputer {
  const guidBuf = asBuffer(entry.objectGUID);
  if (!guidBuf) {
    throw new Error(`LDAP computer entry missing objectGUID: ${asString(entry.distinguishedName)}`);
  }
  const sidBuf = asBuffer(entry.objectSid);
  const dn = asString(entry.distinguishedName);
  if (!dn) {
    throw new Error('LDAP computer entry missing distinguishedName');
  }

  const uac = parseUserAccountControl(asString(entry.userAccountControl));

  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BINARY_ATTRS.includes(k)) continue;
    if (SKIP_RAW_ATTRS.has(k)) continue;
    const cleaned = stripBuffers(v);
    if (cleaned === undefined) continue;
    raw[k] = cleaned;
  }

  // CN is the human-readable hostname; sAMAccountName is the same with `$`.
  // Prefer `cn` for the display name; fall back to `name`.
  return {
    objectGuid: objectGuidToString(guidBuf),
    sid: sidBuf ? sidToString(sidBuf) : null,
    distinguishedName: dn,
    samAccountName: asString(entry.sAMAccountName),
    name: asString(entry.cn) ?? asString(entry.name),
    dnsHostName: asString(entry.dNSHostName),
    operatingSystem: asString(entry.operatingSystem),
    operatingSystemVersion: asString(entry.operatingSystemVersion),
    description: asString(entry.description),
    managedByDn: asString(entry.managedBy),
    enabled: uac.enabled,
    lastLogonAt: filetimeToDate(asString(entry.lastLogonTimestamp)),
    passwordLastSetAt: filetimeToDate(asString(entry.pwdLastSet)),
    memberOfDns: asStringArray(entry.memberOf),
    createdAtSource: parseGeneralizedTime(entry.whenCreated),
    modifiedAtSource: parseGeneralizedTime(entry.whenChanged),
    rawAttributes: raw,
  };
}

export function normalizeDeletedComputer(entry: Entry): DirectoryDeletedComputer {
  const guidBuf = asBuffer(entry.objectGUID);
  if (!guidBuf) {
    throw new Error(
      `LDAP deleted computer entry missing objectGUID: ${asString(entry.distinguishedName)}`,
    );
  }
  const dn = asString(entry.distinguishedName);
  if (!dn) {
    throw new Error('LDAP deleted computer entry missing distinguishedName');
  }
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BINARY_ATTRS.includes(k)) continue;
    if (SKIP_RAW_ATTRS.has(k)) continue;
    const cleaned = stripBuffers(v);
    if (cleaned === undefined) continue;
    raw[k] = cleaned;
  }
  const isRecycledRaw = asString(entry.isRecycled);
  const recycled = isRecycledRaw !== null && isRecycledRaw.toUpperCase() === 'TRUE';

  return {
    objectGuid: objectGuidToString(guidBuf),
    cn: stripDeletedSuffix(asString(entry.cn)),
    samAccountName: asString(entry.sAMAccountName),
    dnsHostName: asString(entry.dNSHostName),
    operatingSystem: asString(entry.operatingSystem),
    deletedDn: dn,
    lastKnownParent: asString(entry.lastKnownParent),
    deletedAt: parseGeneralizedTime(entry.whenChanged),
    recycled,
    rawAttributes: raw,
  };
}

export function normalizeGroup(entry: Entry): DirectoryGroup {
  const guidBuf = asBuffer(entry.objectGUID);
  if (!guidBuf) {
    throw new Error(`LDAP group entry missing objectGUID: ${asString(entry.distinguishedName)}`);
  }
  const sidBuf = asBuffer(entry.objectSid);
  const dn = asString(entry.distinguishedName);
  if (!dn) {
    throw new Error('LDAP group entry missing distinguishedName');
  }

  const groupTypeRaw = asString(entry.groupType);
  let groupType: string | null = null;
  let groupScope: string | null = null;
  if (groupTypeRaw !== null) {
    const gt = Number.parseInt(groupTypeRaw, 10);
    if (Number.isFinite(gt)) {
      const SECURITY = 0x80000000 | 0;
      const SCOPE_GLOBAL = 0x2;
      const SCOPE_DOMAIN_LOCAL = 0x4;
      const SCOPE_UNIVERSAL = 0x8;
      groupType = (gt & SECURITY) !== 0 ? 'security' : 'distribution';
      if ((gt & SCOPE_GLOBAL) !== 0) groupScope = 'global';
      else if ((gt & SCOPE_DOMAIN_LOCAL) !== 0) groupScope = 'domain-local';
      else if ((gt & SCOPE_UNIVERSAL) !== 0) groupScope = 'universal';
    }
  }

  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BINARY_ATTRS.includes(k)) continue;
    if (SKIP_RAW_ATTRS.has(k)) continue;
    const cleaned = stripBuffers(v);
    if (cleaned === undefined) continue;
    raw[k] = cleaned;
  }

  // Prefer the AD `displayName` attribute as the human-readable name —
  // Office 365–synced groups have `cn` populated with a GUID-style identifier
  // (e.g. `Group_<uuid>`) and the friendly name only in `displayName`. Fall
  // back to `cn` for groups that don't set displayName.
  return {
    objectGuid: objectGuidToString(guidBuf),
    sid: sidBuf ? sidToString(sidBuf) : null,
    distinguishedName: dn,
    samAccountName: asString(entry.sAMAccountName),
    name: asString(entry.displayName) ?? asString(entry.cn),
    description: asString(entry.description),
    email: asString(entry.mail),
    groupType,
    groupScope,
    memberDns: asStringArray(entry.member),
    rawAttributes: raw,
  };
}

/**
 * Decode a GPC entry. We surface a typed shape for the well-known fields
 * (path, version, flags, extensions) and keep the full attribute set in
 * `rawAttributes` for the audit/raw view — same shape the user/group/computer
 * normalizers use.
 */
export function normalizeGroupPolicy(entry: Entry): DirectoryGroupPolicy {
  const guidBuf = asBuffer(entry.objectGUID);
  if (!guidBuf) {
    throw new Error(`LDAP GPO entry missing objectGUID: ${asString(entry.distinguishedName)}`);
  }
  const dn = asString(entry.distinguishedName);
  if (!dn) {
    throw new Error('LDAP GPO entry missing distinguishedName');
  }

  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (BINARY_ATTRS.includes(k)) continue;
    if (SKIP_RAW_ATTRS.has(k)) continue;
    const cleaned = stripBuffers(v);
    if (cleaned === undefined) continue;
    raw[k] = cleaned;
  }

  // The CN is the curly-braced GPO GUID, e.g.
  // `CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,…`. That's the
  // value `gPLink` references — distinct from the directory-assigned
  // objectGUID we resolved above.
  const cn = asString(entry.cn);
  // CN normally already includes the braces; tolerate a bare GUID just in
  // case some import path strips them.
  const gpoGuid = cn ? (cn.startsWith('{') ? cn : `{${cn}}`) : '';

  const versionRaw = parseIntOrNull(asString(entry.versionNumber));
  // versionNumber packs (userVersion << 16) | computerVersion in 32 bits.
  // We mask back to 16 bits so very large values from a misconfigured GPO
  // don't sign-extend through the high-bit shift.
  const userVersion = versionRaw === null ? null : (versionRaw >>> 16) & 0xffff;
  const computerVersion = versionRaw === null ? null : versionRaw & 0xffff;

  const flagsRaw = parseIntOrNull(asString(entry.flags));
  // Per [MS-GPOL] §2.2.4 the bits are:
  //   0x1 = user-policy section disabled
  //   0x2 = computer-policy section disabled
  // Default (null/0) = both enabled.
  const userPolicyEnabled = flagsRaw === null ? true : (flagsRaw & 0x1) === 0;
  const computerPolicyEnabled = flagsRaw === null ? true : (flagsRaw & 0x2) === 0;

  return {
    objectGuid: objectGuidToString(guidBuf),
    gpoGuid,
    distinguishedName: dn,
    displayName: asString(entry.displayName),
    fileSysPath: asString(entry.gPCFileSysPath),
    functionalityVersion: parseIntOrNull(asString(entry.gPCFunctionalityVersion)),
    versionNumberRaw: versionRaw,
    userVersion,
    computerVersion,
    flagsRaw,
    userPolicyEnabled,
    computerPolicyEnabled,
    wmiFilterRef: asString(entry.gPCWQLFilter),
    computerExtensionGuids: parseExtensionList(asString(entry.gPCMachineExtensionNames)),
    userExtensionGuids: parseExtensionList(asString(entry.gPCUserExtensionNames)),
    createdAtSource: parseGeneralizedTime(entry.whenCreated),
    modifiedAtSource: parseGeneralizedTime(entry.whenChanged),
    rawAttributes: raw,
  };
}

function parseIntOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the leading CSE GUIDs out of a `gPCMachineExtensionNames` /
 * `gPCUserExtensionNames` value.
 *
 * Format per [MS-GPOL] §2.2.4 is a concatenation of bracketed runs:
 *   `[{cseGuid}{toolGuid1}{toolGuid2}…][{cseGuid}…]…`
 *
 * We extract just the first GUID inside each `[…]` run — that's the CSE
 * (client-side extension) GUID, which identifies what kind of policy area
 * the GPO touches (Registry, Security, Folder Redirection, etc.). The tool
 * GUIDs that follow are MMC snap-in identifiers we don't need.
 */
function parseExtensionList(value: string | null): string[] {
  if (!value) return [];
  const runs = value.match(/\[[^\]]+\]/g);
  if (!runs) return [];
  const out: string[] = [];
  for (const run of runs) {
    const m = /\{[0-9A-Fa-f-]+\}/.exec(run);
    if (m) out.push(m[0].toUpperCase());
  }
  return out;
}

/**
 * Parse a single object's `gPLink` attribute into the individual links it
 * contains. The on-wire format is a concatenation of:
 *   `[LDAP://CN={guid},CN=Policies,…;flags]`
 *
 * Order in the string is precedence order (first applied wins on ties).
 * `flags`: 0=normal, 1=link disabled, 2=enforced ("No Override"),
 * 3=disabled+enforced.
 *
 * Returns one link entry per bracketed run, in source order. Malformed runs
 * are skipped silently — a single bad link shouldn't hide the rest.
 */
export function parseGpLinkValue(
  scopeDn: string,
  gpLinkValue: string | null,
): DirectoryGroupPolicyLink[] {
  if (!gpLinkValue) return [];
  const runs = gpLinkValue.match(/\[[^\]]+\]/g);
  if (!runs) return [];
  const out: DirectoryGroupPolicyLink[] = [];
  runs.forEach((run, idx) => {
    // Strip brackets and the LDAP:// prefix; the remainder is `<dn>;<flags>`.
    const inner = run.slice(1, -1).replace(/^LDAP:\/\//i, '');
    const semi = inner.lastIndexOf(';');
    if (semi < 0) return;
    const gpoDn = inner.slice(0, semi).trim();
    const flagsRaw = Number.parseInt(inner.slice(semi + 1), 10);
    if (!gpoDn || !Number.isFinite(flagsRaw)) return;
    const cnMatch = /^CN=(\{[^,}]+\})/i.exec(gpoDn);
    if (!cnMatch) return;
    out.push({
      scopeDn,
      gpoDn,
      gpoGuid: cnMatch[1]!.toUpperCase(),
      order: idx,
      flagsRaw,
      enabled: (flagsRaw & 0x1) === 0,
      enforced: (flagsRaw & 0x2) !== 0,
    });
  });
  return out;
}
