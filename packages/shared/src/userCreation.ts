// SPDX-License-Identifier: BUSL-1.1
// What creating one user would write, from what the operator entered and
// the naming check's answer for it. Pure, so the create form, copying a
// user and an import all decide the same way what's ready, what needs
// approving and what blocks.
import type { NamingDeviation, NamingSuggestion } from './naming.js';
import { normalizePhone, type NormalizedPhone } from './phone.js';
import { checkPassword, type PasswordCheck, type PasswordPolicy } from './password.js';
import type { PasswordMode, UserCreateRequest } from './schemas/userCreate.js';

/** What the operator enters. The account's names come from the naming check. */
export interface NewUserForm {
  ouDn: string | null;
  first: string;
  last: string;
  middleInitial: string;
  preferredFirst: string;
  personalEmail: string;
  mobile: string;
  telephoneNumber: string;
  mailFromUpn: boolean;
  passwordMode: PasswordMode;
  /** Generated or typed; unused in random mode. */
  password: string;
  mustChange: boolean;
  enabled: boolean;
}

export interface NewUserPlanContext {
  /** The naming check's answer for this form, or null while it's pending. */
  suggestion: NamingSuggestion | null;
  /** The deviations the operator approved, by approvalKey. */
  approved: ReadonlySet<string>;
  policy: PasswordPolicy | null;
  phoneCountry: string | null;
}

export type NewUserField =
  | 'ouDn'
  | 'first'
  | 'last'
  | 'samAccountName'
  | 'userPrincipalName'
  | 'displayName'
  | 'personalEmail'
  | 'mobile'
  | 'telephoneNumber'
  | 'password';

export interface NewUserIssue {
  field: NewUserField | null;
  message: string;
}

export interface NewUserPlan {
  /** The create request, or null until everything's entered, approved and allowed. */
  request: UserCreateRequest | null;
  /** Something required isn't entered yet, or the naming check is pending. */
  incomplete: boolean;
  /** What stops the create until it's changed. */
  blockers: NewUserIssue[];
  /** Worth saying, but the create can go ahead. */
  warnings: NewUserIssue[];
  /** Deviations from the naming pattern waiting for the operator's approval. */
  unapproved: NamingDeviation[];
  mobile: NormalizedPhone;
  telephoneNumber: NormalizedPhone;
  /** Must-change as it will be written. */
  mustChange: boolean;
  /** Why must-change is off when the operator can't turn it on. */
  mustChangeNote: string | null;
  /** The policy checks of the password; empty in random mode. */
  passwordChecks: PasswordCheck[];
}

export const RANDOM_MODE_MUST_CHANGE_NOTE =
  'Off for a random password: "must change" (pwdLastSet=0) stops a synced user signing in to Entra ID unless Connect Sync\'s force-change flag is on, and they set their own password there.';

/** Identifies a deviation across checks, so an approval survives a re-check of the same names. */
export function approvalKey(d: NamingDeviation): string {
  return `${d.kind}:${d.reason}`;
}

/** Whether the operator has to approve a deviation before the create. */
export function needsApproval(d: NamingDeviation): boolean {
  return d.approval === 'together' || d.approval === 'individual';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function planNewUser(form: NewUserForm, ctx: NewUserPlanContext): NewUserPlan {
  const s = ctx.suggestion;
  const blockers: NewUserIssue[] = [];
  const warnings: NewUserIssue[] = [];

  for (const d of s?.deviations ?? []) {
    if (d.approval === 'blocked') blockers.push({ field: deviationField(d), message: d.reason });
  }
  const unapproved = (s?.deviations ?? []).filter(
    (d) => needsApproval(d) && !ctx.approved.has(approvalKey(d)),
  );

  const personalEmail = form.personalEmail.trim();
  if (personalEmail && !EMAIL.test(personalEmail)) {
    blockers.push({
      field: 'personalEmail',
      message: `“${personalEmail}” isn’t an email address.`,
    });
  }

  const mobile = normalizePhone(form.mobile, { kind: 'mobile', defaultCountry: ctx.phoneCountry });
  const telephoneNumber = normalizePhone(form.telephoneNumber, {
    kind: 'telephone',
    defaultCountry: ctx.phoneCountry,
  });
  if (mobile.warning) warnings.push({ field: 'mobile', message: mobile.warning });
  if (telephoneNumber.warning) {
    warnings.push({ field: 'telephoneNumber', message: telephoneNumber.warning });
  }

  const random = form.passwordMode === 'random';
  const passwordChecks = random
    ? []
    : checkPassword(form.password, ctx.policy, {
        samAccountName: s?.samAccountName ?? null,
        displayName: s?.displayName ?? null,
      });
  const mustChange = !random && form.mustChange;

  const incomplete =
    !form.ouDn ||
    !form.first.trim() ||
    !form.last.trim() ||
    !s ||
    (!random && !passwordChecks.every((c) => c.met));

  const request: UserCreateRequest | null =
    incomplete || blockers.length > 0 || unapproved.length > 0
      ? null
      : {
          ouDn: form.ouDn!,
          givenName: form.first.trim(),
          surname: form.last.trim(),
          displayName: s!.displayName,
          cn: s!.cn,
          samAccountName: s!.samAccountName,
          userPrincipalName: s!.upn,
          mailFromUpn: form.mailFromUpn,
          personalEmail: personalEmail || null,
          mobile: mobile.value || null,
          telephoneNumber: telephoneNumber.value || null,
          password: random
            ? { mode: 'random' }
            : {
                mode: form.passwordMode as 'generate' | 'set',
                password: form.password,
                mustChange,
              },
          enabled: form.enabled,
        };

  return {
    request,
    incomplete,
    blockers,
    warnings,
    unapproved,
    mobile,
    telephoneNumber,
    mustChange,
    mustChangeNote: random ? RANDOM_MODE_MUST_CHANGE_NOTE : null,
    passwordChecks,
  };
}

/** The form field a deviation is about. */
export function deviationField(d: NamingDeviation): NewUserField | null {
  switch (d.kind) {
    case 'normalized':
    case 'dropped':
      return d.field;
    case 'truncated':
      return d.attribute === 'samAccountName'
        ? 'samAccountName'
        : d.attribute === 'userPrincipalName'
          ? 'userPrincipalName'
          : 'displayName';
    case 'collision':
      return d.changed.includes('userPrincipalName') ? 'userPrincipalName' : 'samAccountName';
    case 'taken':
      return d.attribute === 'samAccountName' ? 'samAccountName' : 'userPrincipalName';
    case 'cn_collision':
      return 'displayName';
    case 'unusable':
      return d.attribute ?? d.field ?? null;
  }
}
