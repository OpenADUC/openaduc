// SPDX-License-Identifier: BUSL-1.1
// Importing users from a spreadsheet: which column is which, what each
// row would create and what stops it, and the buckets rows are placed
// in. Pure, so the wizard and the server's final check decide alike.
import { z } from 'zod';
import { csvRow } from './csv.js';
import { directoryCountry, directoryCountryCodes } from './country.js';
import type { NameOverrides, NamingDeviation, NamingRequest, NamingSuggestion } from './naming.js';
import { normalizePhone, type NormalizedPhone } from './phone.js';
import type { PhoneField } from './schemas/userCreate.js';
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_MAX,
  managerLoops,
  type ImportField,
  type ImportPerson,
  type ImportRow,
  type PlacementRule,
} from './schemas/userImport.js';
import { approvalKey, needsApproval } from './userCreation.js';

export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  first: 'First name',
  last: 'Last name',
  middleInitial: 'Middle initial',
  preferredFirst: 'Preferred first name',
  displayName: 'Display name',
  employeeId: 'Employee ID',
  email: 'Email',
  personalEmail: 'Personal email',
  title: 'Title',
  department: 'Department',
  company: 'Company',
  office: 'Office',
  officePhone: 'Office phone',
  mobile: 'Mobile',
  manager: 'Manager',
  description: 'Description',
  usageLocation: 'Usage location',
  startDate: 'Start date',
};

// Headers as HR systems, Excel templates and AD exports name them, each
// compared without case, spaces or punctuation.
const SYNONYMS: Record<ImportField, string[]> = {
  first: ['firstname', 'givenname', 'given', 'forename', 'first', 'fname', 'legalfirstname'],
  last: ['lastname', 'surname', 'sn', 'familyname', 'last', 'lname', 'legallastname'],
  // Ahead of a middle name, whose first letter is all an initial keeps.
  middleInitial: ['middleinitial', 'mi', 'initial', 'initials', 'middlename', 'middle'],
  preferredFirst: [
    'preferredfirstname',
    'preferredname',
    'preferred',
    'nickname',
    'knownas',
    'goesby',
  ],
  displayName: ['displayname', 'fullname', 'name'],
  employeeId: [
    'employeeid',
    'employeenumber',
    'employeeno',
    'empid',
    'staffid',
    'staffnumber',
    'personnelnumber',
    'payrollnumber',
  ],
  email: ['email', 'emailaddress', 'mail', 'workemail', 'businessemail', 'workemailaddress'],
  personalEmail: [
    'personalemail',
    'personalemailaddress',
    'privateemail',
    'homeemail',
    'otheremail',
    'othermailbox',
  ],
  title: ['title', 'jobtitle', 'position', 'role', 'jobrole'],
  department: ['department', 'dept', 'team', 'division'],
  company: ['company', 'companyname', 'organisation', 'organization', 'employer'],
  office: ['office', 'officelocation', 'location', 'site', 'physicaldeliveryofficename'],
  officePhone: [
    'officephone',
    'phone',
    'telephone',
    'telephonenumber',
    'workphone',
    'businessphone',
    'phonenumber',
  ],
  mobile: ['mobile', 'mobilephone', 'mobilenumber', 'cell', 'cellphone', 'cellnumber'],
  manager: [
    'manager',
    'linemanager',
    'manageremail',
    'manageremailaddress',
    'managerupn',
    'managerusername',
    'reportsto',
    'supervisor',
  ],
  description: ['description', 'notes', 'comment', 'comments'],
  usageLocation: ['usagelocation', 'country', 'countrycode'],
  startDate: ['startdate', 'start', 'hiredate', 'employeehiredate', 'joindate', 'joiningdate'],
};

// "Employee #" is "employeenumber".
const headerKey = (header: string) =>
  header
    .toLowerCase()
    .replace(/#/g, 'number')
    .replace(/[^a-z0-9]/g, '');

/** Each column's field, or null to leave it out. */
export type ImportMapping = (ImportField | null)[];

/**
 * Each column's field as its header suggests. Two columns naming one
 * field: the closer name takes it ("Middle initial" over "Middle name"),
 * else the first.
 */
export function guessMapping(header: readonly string[]): ImportMapping {
  const guesses = header.map((h) => {
    const key = headerKey(h);
    const field = IMPORT_FIELDS.find((f) => SYNONYMS[f].includes(key));
    return field ? { field, rank: SYNONYMS[field].indexOf(key) } : null;
  });
  return guesses.map((g, i) => {
    if (!g) return null;
    const wins = guesses.every(
      (o, j) => j === i || o?.field !== g.field || o.rank > g.rank || (o.rank === g.rank && j > i),
    );
    return wins ? g.field : null;
  });
}

export function mappingProblems(mapping: ImportMapping): string[] {
  const problems: string[] = [];
  const missing = (['first', 'last'] as const).filter((f) => !mapping.includes(f));
  if (missing.length > 0) {
    problems.push(
      `Choose the ${missing.map((f) => IMPORT_FIELD_LABEL[f].toLowerCase()).join(' and ')} column.`,
    );
  }
  for (const field of IMPORT_FIELDS) {
    if (mapping.filter((f) => f === field).length > 1) {
      problems.push(`More than one column is ${IMPORT_FIELD_LABEL[field]}. Pick one.`);
    }
  }
  return problems;
}

/** The template's header row, whose headers map with no changes. */
export function importTemplateCsv(): string {
  return `${csvRow(IMPORT_FIELDS.map((f) => IMPORT_FIELD_LABEL[f]))}\r\n`;
}

export type ImportValues = Record<ImportField, string>;

/** A data row's cells by field; a field no column maps to is blank. */
export function importValues(row: readonly string[], mapping: ImportMapping): ImportValues {
  const values = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ''])) as ImportValues;
  mapping.forEach((field, i) => {
    if (field) values[field] = row[i]?.trim() ?? '';
  });
  return values;
}

// ---- Values ------------------------------------------------------------

interface Read {
  value: string | null;
  problem: string | null;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * A start date as a spreadsheet writes it: 2026-11-03, 3 Nov 2026, Nov 3,
 * 2026, or 03/11/2026 when only one reading is a date. A time after it,
 * as Excel's CSV adds, is ignored.
 */
export function readStartDate(input: string): Read {
  const v = input.trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/, '');
  if (!v) return { value: null, problem: null };
  const bad = { value: null, problem: `“${input.trim()}” isn’t a date. Write it as 2026-11-03.` };
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  if (m) {
    const value = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return value ? { value, problem: null } : bad;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(v);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dayFirst = isoDate(y, b, a);
    const monthFirst = isoDate(y, a, b);
    if (dayFirst && monthFirst && dayFirst !== monthFirst) {
      return {
        value: null,
        problem: `“${v}” could be ${a} ${MONTH_NAMES[b - 1]} or ${b} ${MONTH_NAMES[a - 1]}. Write it as ${dayFirst} or ${monthFirst}.`,
      };
    }
    const value = dayFirst ?? monthFirst;
    return value ? { value, problem: null } : bad;
  }
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase() as never) + 1;
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,})\.?,?[\s-]+(\d{4}|\d{2})$/.exec(v);
  const n = /^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(v);
  const parts = m
    ? { d: m[1]!, mon: m[2]!, y: m[3]! }
    : n
      ? { d: n[2]!, mon: n[1]!, y: n[3]! }
      : null;
  if (parts && month(parts.mon) > 0) {
    // Excel's 3-Nov-26: a start date is this century.
    const year = parts.y.length === 2 ? 2000 + Number(parts.y) : Number(parts.y);
    const value = isoDate(year, month(parts.mon), Number(parts.d));
    return value ? { value, problem: null } : bad;
  }
  return bad;
}

const countryKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ');
const COUNTRY_ALIASES: Record<string, string> = {
  uk: 'GB',
  'great britain': 'GB',
  britain: 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  'united states of america': 'US',
  america: 'US',
  uae: 'AE',
  holland: 'NL',
  korea: 'KR',
  'republic of korea': 'KR',
  'czech republic': 'CZ',
  'russian federation': 'RU',
  'viet nam': 'VN',
  türkiye: 'TR',
};
const COUNTRY_BY_NAME = new Map([
  ...directoryCountryCodes().map((c): [string, string] => [countryKey(directoryCountry(c)!.co), c]),
  ...Object.entries(COUNTRY_ALIASES),
]);

/** A usage location as its two-letter code, from the code or the country's English name. */
export function readUsageLocation(input: string): Read {
  const v = input.trim();
  if (!v) return { value: null, problem: null };
  const code =
    v.length === 2 && directoryCountry(v) ? v.toUpperCase() : COUNTRY_BY_NAME.get(countryKey(v));
  return code
    ? { value: code, problem: null }
    : {
        value: null,
        problem: `“${v}” isn’t a country. Use its two-letter code, such as GB or US.`,
      };
}

const emailAddress = z.string().email();

/** An email address as the import's request takes one. */
export function isEmailAddress(value: string): boolean {
  return emailAddress.safeParse(value).success;
}

// Initials as typed (J., JR, J. R.); a middle name gives its first letter.
const INITIALS = /^([A-Z]\.?\s?){1,3}$/;

/** What AD's `initials` gets from the middle initial column. */
export function initialsOf(middle: string): string | null {
  const v = middle.trim();
  if (!v) return null;
  return v.length <= 6 && INITIALS.test(v) ? v : v.charAt(0).toUpperCase();
}

// A cell a spreadsheet would run: =, @, or + or - before a function or a
// cell reference. A phone number's + is left alone.
const FORMULA = /^[=@]|^[+-]\s*[A-Za-z_][\w.]*\s*\(|^[+-]\s*\$?[A-Za-z]{1,3}\$?\d+\b/;

export function looksLikeFormula(value: string): boolean {
  return FORMULA.test(value);
}

/**
 * The naming check's request for a row, typed names replacing the
 * pattern's; null for a row without both names, or with one too long to
 * check (which blocks it anyway).
 */
export function namingRequestOf(
  values: ImportValues,
  ouDn: string | null,
  typed: NameOverrides = {},
): NamingRequest | null {
  if (!values.first || !values.last) return null;
  const tooLong = (['first', 'last', 'preferredFirst', 'displayName'] as const).some(
    (f) => values[f].length > IMPORT_FIELD_MAX[f]!,
  );
  if (tooLong) return null;
  return {
    name: {
      first: values.first,
      last: values.last,
      middleInitial: values.middleInitial.slice(0, 64) || null,
      preferredFirst: values.preferredFirst || null,
    },
    ...(ouDn ? { ouDn } : {}),
    overrides: {
      samAccountName: typed.samAccountName ?? null,
      userPrincipalName: typed.userPrincipalName ?? null,
      displayName: typed.displayName ?? (values.displayName || null),
    },
  };
}

// ---- People already in the directory ---------------------------------

export interface ExistingMatch {
  by: 'employeeId' | 'email';
  value: string;
  person: ImportPerson;
}

const lower = (v: string | null | undefined) => (v ?? '').toLowerCase();

function holdsAddress(p: ImportPerson, value: string): boolean {
  const v = value.toLowerCase();
  return lower(p.userPrincipalName) === v || p.addresses.some((a) => lower(a) === v);
}

/** The person a row already is: by employee ID when it has one, otherwise by email. */
export function existingPerson(
  values: Pick<ImportValues, 'employeeId' | 'email'>,
  people: readonly ImportPerson[],
): ExistingMatch | null {
  if (values.employeeId) {
    const id = values.employeeId.toLowerCase();
    const person = people.find((p) => lower(p.employeeId) === id);
    return person ? { by: 'employeeId', value: values.employeeId, person } : null;
  }
  if (values.email) {
    const person = people.find((p) => holdsAddress(p, values.email));
    return person ? { by: 'email', value: values.email, person } : null;
  }
  return null;
}

/** Who to look up for a set of rows: whoever holds their employee IDs, emails or managers. */
export function lookupsOf(rows: readonly ImportValues[]): {
  employeeIds: string[];
  identifiers: string[];
} {
  const employeeIds = new Set<string>();
  const identifiers = new Set<string>();
  // A value too long to be one is blocked anyway, so isn't asked about.
  const fits = (v: string, field: ImportField) => !!v && v.length <= IMPORT_FIELD_MAX[field]!;
  for (const v of rows) {
    if (fits(v.employeeId, 'employeeId')) employeeIds.add(v.employeeId);
    if (fits(v.email, 'email')) identifiers.add(v.email);
    if (fits(v.manager, 'manager')) identifiers.add(v.manager);
  }
  return { employeeIds: [...employeeIds], identifiers: [...identifiers] };
}

/** An account the import creates, with the addresses it takes. */
export interface PlannedAccount {
  index: number;
  email: string | null;
  upn: string;
  samAccountName: string;
}

const nameOfPerson = (p: ImportPerson) => p.displayName ?? p.samAccountName ?? p.distinguishedName;

/**
 * Each account's email against the directory, whoever else holds it, and
 * each account's email and UPN against the other accounts' emails and
 * UPNs; a clash is the later account's to fix. UPNs among themselves are
 * the naming check's.
 */
export function addressConflicts(
  accounts: readonly PlannedAccount[],
  people: readonly ImportPerson[],
  lineOf: (index: number) => number,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const add = (index: number, message: string) =>
    out.set(index, [...(out.get(index) ?? []), message]);
  const held = new Map<string, { index: number; what: 'email' | 'UPN' }>();
  for (const a of accounts) {
    const email = a.email ? lower(a.email) : null;
    if (email) {
      const holder = people.find((p) => holdsAddress(p, email));
      if (holder) {
        add(
          a.index,
          `The email “${a.email}” is already ${nameOfPerson(holder)}’s in the directory.`,
        );
      }
      const earlier = held.get(email);
      if (earlier) {
        add(
          a.index,
          `The email “${a.email}” is row ${lineOf(earlier.index)}’s ${earlier.what} too.`,
        );
      }
    }
    const earlierUpn = held.get(lower(a.upn));
    if (earlierUpn?.what === 'email') {
      add(a.index, `The UPN “${a.upn}” is row ${lineOf(earlierUpn.index)}’s email.`);
    }
    if (email && !held.has(email)) held.set(email, { index: a.index, what: 'email' });
    if (!held.has(lower(a.upn))) held.set(lower(a.upn), { index: a.index, what: 'UPN' });
  }
  return out;
}

// ---- Managers ----------------------------------------------------------

export type ManagerMatch =
  | { kind: 'none' }
  | { kind: 'row'; index: number }
  | { kind: 'directory'; person: ImportPerson }
  /** The account goes ahead without a manager. */
  | { kind: 'unresolved'; message: string }
  /** The row can't go ahead as it is: the run couldn't order it. */
  | { kind: 'invalid'; message: string };

/**
 * The manager a row names, by email, UPN or sAMAccountName: first among
 * the accounts the import creates, then in the directory.
 */
export function resolveManager(
  value: string,
  self: number,
  accounts: readonly PlannedAccount[],
  people: readonly ImportPerson[],
): ManagerMatch {
  const v = value.trim().toLowerCase();
  if (!v) return { kind: 'none' };
  const inImport = accounts.filter(
    (a) => lower(a.email) === v || lower(a.upn) === v || lower(a.samAccountName) === v,
  );
  if (inImport.length === 1) {
    return inImport[0]!.index === self
      ? { kind: 'invalid', message: `The manager “${value.trim()}” is this person.` }
      : { kind: 'row', index: inImport[0]!.index };
  }
  const found = people.filter((p) => holdsAddress(p, v) || lower(p.samAccountName) === v);
  if (inImport.length === 0 && found.length === 1) return { kind: 'directory', person: found[0]! };
  return {
    kind: 'unresolved',
    message:
      inImport.length + found.length > 1
        ? `More than one person is “${value.trim()}”, so the account gets no manager.`
        : `Nobody in this import or the directory is “${value.trim()}”, so the account gets no manager.`,
  };
}

/**
 * Each row's manager, and a loop of managers within the import refused:
 * each account is created after its manager, so a loop has no order.
 */
export function resolveManagers(
  rows: readonly { index: number; manager: string }[],
  accounts: readonly PlannedAccount[],
  people: readonly ImportPerson[],
  lineOf: (index: number) => number,
): Map<number, ManagerMatch> {
  const out = new Map(
    rows.map(({ index, manager }) => [index, resolveManager(manager, index, accounts, people)]),
  );
  const managerOf = new Map<number, number>();
  for (const [index, m] of out) if (m.kind === 'row') managerOf.set(index, m.index);
  for (const index of managerLoops(managerOf)) {
    const chain = [index];
    for (let at = managerOf.get(index)!; at !== index; at = managerOf.get(at)!) chain.push(at);
    out.set(index, {
      kind: 'invalid',
      message: `Its managers go round in a loop (rows ${[...chain, index].map(lineOf).join(' → ')}). Change a manager, or leave a row out.`,
    });
  }
  return out;
}

// ---- Review ------------------------------------------------------------

export interface ImportRowContext {
  /** The naming check's answer for the row, or null while it's pending. */
  suggestion: NamingSuggestion | null;
  /** The row's deviations the operator approved, by approvalKey. */
  approved: ReadonlySet<string>;
  /** The people the directory has with the row's employee ID or email; null while pending. */
  people: readonly ImportPerson[] | null;
  manager: ManagerMatch;
  /** Its email or UPN clashing with the directory's or another row's (addressConflicts). */
  conflicts: readonly string[];
  phoneCountry: string | null;
}

export type ImportRowStatus = 'pending' | 'skipped' | 'blocked' | 'unapproved' | 'ready';

export interface ImportRowReview {
  status: ImportRowStatus;
  existing: ExistingMatch | null;
  /** What stops the row until it's changed. */
  blockers: string[];
  /** Worth saying, but the row goes ahead. */
  warnings: string[];
  /** Deviations from the naming pattern waiting for the operator's approval. */
  unapproved: NamingDeviation[];
  phones: Record<PhoneField, NormalizedPhone>;
  usageLocation: string | null;
  startDate: string | null;
}

/**
 * What stops a row, what's worth a word, and what needs approving. A row
 * that is someone already in the directory is skipped: an import only
 * creates.
 */
export function reviewImportRow(values: ImportValues, ctx: ImportRowContext): ImportRowReview {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const s = ctx.suggestion;
  const existing = ctx.people ? existingPerson(values, ctx.people) : null;

  if (!values.first || !values.last) blockers.push('A first and a last name are both needed.');
  for (const d of s?.deviations ?? []) if (d.approval === 'blocked') blockers.push(d.reason);
  for (const field of IMPORT_FIELDS) {
    const value = values[field];
    const max = IMPORT_FIELD_MAX[field];
    if (max !== undefined && value.length > max) {
      blockers.push(`${IMPORT_FIELD_LABEL[field]} is longer than AD allows (${max} characters).`);
    }
    if (looksLikeFormula(value)) {
      blockers.push(
        `${IMPORT_FIELD_LABEL[field]} “${value}” looks like a spreadsheet formula. Fix the cell, or leave the row out.`,
      );
    }
  }
  for (const field of ['email', 'personalEmail'] as const) {
    if (values[field] && !isEmailAddress(values[field])) {
      blockers.push(`${IMPORT_FIELD_LABEL[field]} “${values[field]}” isn’t an email address.`);
    }
  }
  if (!existing) blockers.push(...ctx.conflicts);
  const usageLocation = readUsageLocation(values.usageLocation);
  const startDate = readStartDate(values.startDate);
  for (const problem of [usageLocation.problem, startDate.problem]) {
    if (problem) blockers.push(problem);
  }

  const phones = {
    mobile: normalizePhone(values.mobile, { kind: 'mobile', defaultCountry: ctx.phoneCountry }),
    telephoneNumber: normalizePhone(values.officePhone, {
      kind: 'telephone',
      defaultCountry: ctx.phoneCountry,
    }),
  };
  for (const phone of Object.values(phones)) if (phone.warning) warnings.push(phone.warning);
  if (ctx.manager.kind === 'unresolved') warnings.push(ctx.manager.message);
  if (ctx.manager.kind === 'invalid') blockers.push(ctx.manager.message);

  const unapproved = (s?.deviations ?? []).filter(
    (d) => needsApproval(d) && !ctx.approved.has(approvalKey(d)),
  );
  const named = namingRequestOf(values, null) !== null;
  const status: ImportRowStatus = existing
    ? 'skipped'
    : blockers.length > 0
      ? 'blocked'
      : (named && !s) || !ctx.people
        ? 'pending'
        : unapproved.length > 0
          ? 'unapproved'
          : 'ready';
  return {
    status,
    existing,
    blockers,
    warnings,
    unapproved,
    phones,
    usageLocation: usageLocation.value,
    startDate: startDate.value,
  };
}

/** The row as the final check judges it and the run creates it; only for a ready row. */
export function importRowRequest(row: {
  line: number;
  values: ImportValues;
  review: ImportRowReview;
  suggestion: NamingSuggestion;
  ouDn: string;
  groups: readonly string[];
  manager: ManagerMatch;
  /** The manager's index among the request's rows, when this import creates them. */
  managerRow?: number | undefined;
}): ImportRow {
  const { values: v, review, suggestion: s } = row;
  const organisation = {
    ...(v.title ? { title: v.title } : {}),
    ...(v.department ? { department: v.department } : {}),
    ...(v.company ? { company: v.company } : {}),
    ...(v.office ? { physicalDeliveryOfficeName: v.office } : {}),
    ...(row.manager.kind === 'directory' ? { managerId: row.manager.person.id } : {}),
  };
  const phones = review.phones;
  const keep = (['mobile', 'telephoneNumber'] as const).filter(
    (f) => phones[f].value && !phones[f].readable,
  );
  return {
    line: row.line,
    ouDn: row.ouDn,
    givenName: v.first,
    surname: v.last,
    ...(initialsOf(v.middleInitial) ? { initials: initialsOf(v.middleInitial) } : {}),
    displayName: s.displayName,
    cn: s.cn,
    samAccountName: s.samAccountName,
    userPrincipalName: s.upn,
    ...(v.email ? { email: v.email } : {}),
    ...(v.personalEmail ? { personalEmail: v.personalEmail } : {}),
    ...(phones.mobile.value ? { mobile: phones.mobile.value } : {}),
    ...(phones.telephoneNumber.value ? { telephoneNumber: phones.telephoneNumber.value } : {}),
    ...(keep.length > 0 ? { keepPhonesAsTyped: keep } : {}),
    ...(v.employeeId ? { employeeId: v.employeeId } : {}),
    ...(v.description ? { description: v.description } : {}),
    ...(review.usageLocation ? { usageLocation: review.usageLocation } : {}),
    ...(review.startDate ? { startDate: review.startDate } : {}),
    ...(Object.keys(organisation).length > 0 ? { organisation } : {}),
    ...(row.managerRow !== undefined ? { managerRow: row.managerRow } : {}),
    ...(row.groups.length > 0 ? { groups: [...row.groups] } : {}),
  };
}

// ---- Buckets -----------------------------------------------------------

export const BLANK_BUCKET_LABEL = '(blank)';
/** The one bucket of an import that isn't grouped. */
export const ALL_ROWS_BUCKET = '*';

/** Values that differ only in case or surrounding spaces share a bucket. */
export function bucketKey(value: string): string {
  return value.trim().toLowerCase();
}

export interface ImportBucket {
  key: string;
  label: string;
  /** Row indexes, in order. */
  rows: number[];
}

/**
 * The rows grouped by a column's value, blanks together, sorted by value
 * with the blank bucket last. `moves` puts a row in another bucket, by
 * key; a move to a bucket the grouping doesn't have is ignored. A bucket
 * every row moved out of stays, empty, so rows can move back.
 */
export function bucketsOf(
  values: readonly ImportValues[],
  rows: readonly number[],
  groupBy: ImportField | null,
  moves: Readonly<Record<number, string>> = {},
): ImportBucket[] {
  if (!groupBy) return [{ key: ALL_ROWS_BUCKET, label: 'All rows', rows: [...rows] }];
  const buckets = new Map<string, ImportBucket>();
  for (const i of rows) {
    const value = values[i]![groupBy];
    const key = bucketKey(value);
    if (!buckets.has(key)) buckets.set(key, { key, label: value || BLANK_BUCKET_LABEL, rows: [] });
  }
  for (const i of rows) {
    const natural = bucketKey(values[i]![groupBy]);
    const moved = moves[i];
    buckets.get(moved !== undefined && buckets.has(moved) ? moved : natural)!.rows.push(i);
  }
  return [...buckets.values()].sort((a, b) =>
    a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label),
  );
}

export interface BucketPlacement {
  ouDn: string | null;
  groups: { id: string; name: string }[];
}

/** One placement rule per grouping column and bucket. */
export function ruleKey(column: ImportField, value: string): string {
  return `${column}\n${bucketKey(value)}`;
}

/** The placement rule for a bucket's value, when the import is grouped by the rule's column. */
export function ruleFor(
  rules: readonly PlacementRule[],
  groupBy: ImportField | null,
  bucket: Pick<ImportBucket, 'key'>,
): PlacementRule | null {
  if (!groupBy) return null;
  const key = ruleKey(groupBy, bucket.key);
  return rules.find((r) => ruleKey(r.column, r.value) === key) ?? null;
}

/**
 * Where a bucket starts: in the OU the import was started from, if any,
 * otherwise where its placement rule puts it; with its rule's groups.
 */
export function startingPlacement(
  rule: PlacementRule | null,
  startOuDn: string | null,
): BucketPlacement {
  return { ouDn: startOuDn ?? rule?.ouDn ?? null, groups: rule ? [...rule.groups] : [] };
}
