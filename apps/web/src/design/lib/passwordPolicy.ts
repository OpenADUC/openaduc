// SPDX-License-Identifier: BUSL-1.1
import { RESET_PASSWORD_MIN_LENGTH, type DirectoryPolicy } from '@openaduc/shared';

export type PasswordPolicy = Pick<DirectoryPolicy, 'minPwdLength' | 'complexityRequired'>;

export interface PasswordAccount {
  samAccountName: string | null;
  displayName: string | null;
}

export type PasswordRule = 'length' | 'categories' | 'names';

export interface PasswordCheck {
  rule: PasswordRule;
  met: boolean;
  text: string;
}

const GENERATED_LENGTH = 16;

function minimumLength(policy: PasswordPolicy | null): number {
  return Math.max(RESET_PASSWORD_MIN_LENGTH, policy?.minPwdLength ?? 0);
}

export function checkPassword(
  password: string,
  policy: PasswordPolicy | null,
  account: PasswordAccount,
): PasswordCheck[] {
  const min = minimumLength(policy);
  const checks: PasswordCheck[] = [
    { rule: 'length', met: password.length >= min, text: `At least ${min} characters` },
  ];
  // Unreadable policy: assume complexity, which almost every domain has on.
  if (policy?.complexityRequired !== false) {
    checks.push(
      {
        rule: 'categories',
        met: categoryCount(password) >= 3,
        text: 'Three of: uppercase, lowercase, digits, symbols',
      },
      {
        rule: 'names',
        met: !containsName(password, account),
        text: 'Not the logon name or part of the display name',
      },
    );
  }
  return checks;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!#%+-=?@';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

/** Every kind of character, so it passes complexity even where it's off. */
export function generatePassword(policy: PasswordPolicy | null, account: PasswordAccount): string {
  const length = Math.max(GENERATED_LENGTH, minimumLength(policy));
  const strict = { minPwdLength: length, complexityRequired: true };
  for (;;) {
    const chars = [UPPER, LOWER, DIGITS, SYMBOLS].map(pick);
    while (chars.length < length) chars.push(pick(ALL));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    }
    const password = chars.join('');
    if (checkPassword(password, strict, account).every((c) => c.met)) return password;
  }
}

// AD's categories: upper, lower, digits, its symbol set, and letters
// without case (e.g. CJK).
const CATEGORIES = [
  /\p{Lu}/u,
  /\p{Ll}/u,
  /[0-9]/,
  /[~!@#$%^&*_\-+=`|\\(){}[\]:;"'<>,.?/]/,
  /[\p{Lt}\p{Lm}\p{Lo}]/u,
];

function categoryCount(password: string): number {
  return CATEGORIES.filter((re) => re.test(password)).length;
}

// AD ignores a logon name shorter than 3 and splits the display name on
// these delimiters, ignoring parts shorter than 3.
function containsName(password: string, account: PasswordAccount): boolean {
  const lower = password.toLowerCase();
  const names = [
    account.samAccountName ?? '',
    ...(account.displayName ?? '').split(/[,.\-_ #\t]/),
  ].filter((n) => n.length >= 3);
  return names.some((n) => lower.includes(n.toLowerCase()));
}

function pick(set: string): string {
  return set[randomInt(set.length)]!;
}

function randomInt(max: number): number {
  // Rejection sampling keeps every value equally likely.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % max;
}
