// SPDX-License-Identifier: BUSL-1.1
// Active Directory binary/format conversions.
//
// All of this is "do it once, cover with tests, never touch again" plumbing.
// References:
//  - objectGUID encoding: MS-DTYP §2.3.4 (mixed-endian Win32 GUID layout).
//  - objectSid encoding: MS-DTYP §2.4.2.2.
//  - Windows FILETIME (used by pwdLastSet, lastLogonTimestamp, accountExpires,
//    lockoutTime): 64-bit count of 100-ns intervals since 1601-01-01 UTC.
//  - userAccountControl bit semantics: MS-ADTS §2.2.16.
//  - LDAP filter / DN escaping: RFC 4515 §3 / RFC 4514 §2.4.

// ---- objectGUID ------------------------------------------------------------

/**
 * Convert an AD `objectGUID` Buffer (16 bytes in the Win32 mixed-endian layout)
 * to the canonical 8-4-4-4-12 lowercase UUID string.
 *
 * Win32 GUID layout has the first three groups in little-endian and the last
 * two in big-endian, e.g. bytes:
 *   [d3 a4 75 60][7c 84][9f 4b][9b 26][7e 4f 1d 1f 8a 0c]
 * becomes:
 *   6075a4d3-847c-4b9f-9b26-7e4f1d1f8a0c
 */
export function objectGuidToString(buf: Buffer): string {
  if (buf.length !== 16) {
    throw new Error(`objectGUID must be 16 bytes, got ${buf.length}`);
  }
  const hex = (i: number) => buf[i]!.toString(16).padStart(2, '0');
  // First three groups: reverse byte order.
  const a = `${hex(3)}${hex(2)}${hex(1)}${hex(0)}`;
  const b = `${hex(5)}${hex(4)}`;
  const c = `${hex(7)}${hex(6)}`;
  // Last two groups: byte order as-is.
  const d = `${hex(8)}${hex(9)}`;
  const e = `${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`;
  return `${a}-${b}-${c}-${d}-${e}`;
}

/**
 * Inverse of objectGuidToString. Used when an LDAP filter must reference an
 * objectGUID — the filter form is `\xx\xx\xx...` for each byte.
 */
export function objectGuidFromString(uuid: string): Buffer {
  const clean = uuid.replace(/-/g, '');
  if (clean.length !== 32 || /[^0-9a-f]/i.test(clean)) {
    throw new Error(`invalid GUID string: ${uuid}`);
  }
  const bytes = Buffer.from(clean, 'hex');
  // Re-apply the mixed-endian shuffle.
  return Buffer.from([
    bytes[3]!,
    bytes[2]!,
    bytes[1]!,
    bytes[0]!,
    bytes[5]!,
    bytes[4]!,
    bytes[7]!,
    bytes[6]!,
    bytes[8]!,
    bytes[9]!,
    bytes[10]!,
    bytes[11]!,
    bytes[12]!,
    bytes[13]!,
    bytes[14]!,
    bytes[15]!,
  ]);
}

/** Encode any binary value as the `\xx\xx...` LDAP filter form. */
export function bufferToLdapFilterValue(buf: Buffer): string {
  let out = '';
  for (const byte of buf) {
    out += '\\' + byte.toString(16).padStart(2, '0');
  }
  return out;
}

// ---- objectSid -------------------------------------------------------------

/**
 * Convert an AD `objectSid` binary value to its standard `S-1-5-...` string form.
 *
 * Layout (MS-DTYP §2.4.2.2):
 *   byte 0: Revision (always 1)
 *   byte 1: SubAuthorityCount (N)
 *   bytes 2..7: IdentifierAuthority (6 bytes, big-endian)
 *   bytes 8..(8 + 4N - 1): N sub-authorities (4 bytes each, little-endian)
 */
export function sidToString(buf: Buffer): string {
  if (buf.length < 8) {
    throw new Error(`objectSid too short: ${buf.length} bytes`);
  }
  const revision = buf[0]!;
  const subAuthCount = buf[1]!;
  if (buf.length !== 8 + subAuthCount * 4) {
    throw new Error(
      `objectSid length mismatch: header says ${subAuthCount} sub-auths, buffer is ${buf.length} bytes`,
    );
  }
  // 6-byte identifier authority, big-endian. In practice the first two bytes
  // are always zero, so a regular Number is fine.
  let identifierAuthority = 0;
  for (let i = 2; i < 8; i++) {
    identifierAuthority = identifierAuthority * 256 + buf[i]!;
  }
  const subAuths: string[] = [];
  for (let i = 0; i < subAuthCount; i++) {
    const offset = 8 + i * 4;
    // Little-endian unsigned 32-bit.
    const value = buf.readUInt32LE(offset);
    subAuths.push(value.toString());
  }
  return `S-${revision}-${identifierAuthority}${subAuths.length ? '-' + subAuths.join('-') : ''}`;
}

// ---- Windows FILETIME ------------------------------------------------------

// FILETIME is 100-ns intervals since 1601-01-01 UTC. JS Date is ms since
// 1970-01-01 UTC. Offset between epochs in ms:
const FILETIME_TO_UNIX_EPOCH_DIFF_MS = 11644473600000n;
// "Never" sentinels used by AD: 0 and Int64.MaxValue (0x7FFFFFFFFFFFFFFF).
const FILETIME_MAX = 0x7fffffffffffffffn;

/**
 * Parse a Windows FILETIME (as a string from LDAP, since 64-bit ints don't fit
 * in JS numbers safely) into a Date or null. Treats 0 and INT64_MAX as "never".
 */
export function filetimeToDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '' || value === '0') return null;
  let big: bigint;
  try {
    big = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return null;
  }
  if (big <= 0n || big >= FILETIME_MAX) return null;
  const unixMs = big / 10000n - FILETIME_TO_UNIX_EPOCH_DIFF_MS;
  // Date supports ~±100M days from epoch; FILETIME values past that are
  // invalid sentinel-style anyway.
  const ms = Number(unixMs);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

// ---- userAccountControl ----------------------------------------------------

// Subset of UAC flags we care about for the MVP. Full table at MS-ADTS §2.2.16.
export const UAC = {
  ACCOUNTDISABLE: 0x0002,
  LOCKOUT: 0x0010, // historical; lockoutTime is the authoritative signal
  PASSWD_NOTREQD: 0x0020,
  DONT_EXPIRE_PASSWORD: 0x10000,
  PASSWORD_EXPIRED: 0x800000,
  NORMAL_ACCOUNT: 0x0200,
} as const;

export interface AccountControlState {
  enabled: boolean;
  passwordNeverExpires: boolean;
  passwordExpired: boolean;
  passwordNotRequired: boolean;
}

export function parseUserAccountControl(
  value: string | number | null | undefined,
): AccountControlState {
  const num = typeof value === 'string' ? Number.parseInt(value, 10) : (value ?? 0);
  const uac = Number.isFinite(num) ? Number(num) : 0;
  return {
    enabled: (uac & UAC.ACCOUNTDISABLE) === 0,
    passwordNeverExpires: (uac & UAC.DONT_EXPIRE_PASSWORD) !== 0,
    passwordExpired: (uac & UAC.PASSWORD_EXPIRED) !== 0,
    passwordNotRequired: (uac & UAC.PASSWD_NOTREQD) !== 0,
  };
}

/**
 * Parse an AD policy duration attribute (lockoutDuration, lockoutObservationWindow,
 * maxPwdAge) into milliseconds. AD stores these as 100-nanosecond intervals
 * with a negative value (because Microsoft chose to encode "back from now" for
 * relative durations). 0 = "duration disabled / manual only / never expire".
 *
 * Returns:
 *   - null when the value is missing or unparseable
 *   - 0 when the policy is explicitly disabled (operator-meaningful "manual only")
 *   - positive ms otherwise
 */
export function adDurationToMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  let big: bigint;
  try {
    big = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return null;
  }
  if (big === 0n) return 0;
  // AD durations are negative (sign-extended 64-bit). Take the absolute value.
  const abs = big < 0n ? -big : big;
  // 10_000 100-ns ticks per millisecond.
  const ms = abs / 10_000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(ms);
}

/**
 * Convert an AD `lockoutTime` value to a Date, or null when the attribute is
 * 0/unset. Same semantics as `filetimeToDate` but named for clarity at the
 * call site.
 */
export function lockoutTimeToDate(value: string | number | null | undefined): Date | null {
  return filetimeToDate(value);
}

/**
 * `lockoutTime` semantics:
 *   - 0 / unset / null → not locked.
 *   - non-zero → account was locked at that FILETIME. Whether the account is
 *     *currently* locked depends on the domain's lockoutDuration policy: if
 *     `lockoutDuration` is non-zero the lock auto-expires, if 0 the lock is
 *     manual-only. For the UI we conservatively treat any non-zero lockoutTime
 *     as "locked" — operators can refresh after expiry, and unlocking sets
 *     lockoutTime to 0 unconditionally.
 */
export function isLocked(lockoutTime: string | number | null | undefined): boolean {
  if (lockoutTime === null || lockoutTime === undefined || lockoutTime === '') return false;
  if (lockoutTime === '0' || lockoutTime === 0) return false;
  try {
    const big = typeof lockoutTime === 'bigint' ? lockoutTime : BigInt(lockoutTime);
    return big > 0n && big < FILETIME_MAX;
  } catch {
    return false;
  }
}

// ---- LDAP filter & DN escaping --------------------------------------------

/**
 * RFC 4515 §3: characters `\`, `*`, `(`, `)`, NUL must be escaped as `\xx`.
 * Used for filter assertion values (e.g. inside `(sAMAccountName=foo)`).
 */
export function escapeLdapFilter(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === '*' || ch === '(' || ch === ')' || code === 0) {
      out += '\\' + code.toString(16).padStart(2, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * RFC 4514 §2.4: characters `,`, `+`, `"`, `\`, `<`, `>`, `;`, leading `#` or
 * space, trailing space must be escaped in DN attribute values. We never build
 * DNs from user input in the MVP, but exposed for completeness.
 */
export function escapeDnValue(input: string): string {
  if (!input) return input;
  const SPECIAL = new Set([',', '+', '"', '\\', '<', '>', ';', '=']);
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (SPECIAL.has(ch)) out += '\\' + ch;
    else out += ch;
  }
  if (out.startsWith('#') || out.startsWith(' ')) out = '\\' + out;
  if (out.endsWith(' ')) out = out.slice(0, -1) + '\\ ';
  return out;
}

// ---- AD password encoding for unicodePwd LDAP modify ----------------------

/**
 * AD requires `unicodePwd` to be sent as the password string surrounded by
 * double quotes, encoded as little-endian UTF-16 (UCS-2). Used for password
 * resets via LDAPS.
 */
export function encodeUnicodePassword(plaintext: string): Buffer {
  const quoted = `"${plaintext}"`;
  return Buffer.from(quoted, 'utf16le');
}
