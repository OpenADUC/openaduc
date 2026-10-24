// SPDX-License-Identifier: BUSL-1.1
// The naming pattern: turning a person's name into the names a new account
// gets (sAMAccountName, UPN, mail, CN, display name), with every place the
// result differs from what the pattern asked for reported as a deviation.
// Pure, so the settings preview, the create and import workflows and the
// API's uniqueness check all agree.

import { CONTROL_CHARS, samAccountNameSchema } from './schemas/user.js';

export const NAMING_TOKENS = ['first', 'last', 'f', 'l', 'mi'] as const;
export type NamingToken = (typeof NAMING_TOKENS)[number];
export const DEFAULT_NAMING_PATTERN = '{first}.{last}';
export const NAMING_PATTERN_MAX = 64;

/** AD's and Entra's hard limits on the names a new account gets. */
export const NAME_LIMITS = {
  samAccountName: 20,
  // Before the @: Entra's limit for a synced account's UPN.
  userPrincipalName: 64,
  cn: 64,
  displayName: 256,
} as const;
export type LimitedAttribute = keyof typeof NAME_LIMITS;

// Suffixes run to 999, so a candidate may lose 3 characters to one.
const MAX_SUFFIX = 999;

export interface PersonName {
  /** Legal first name; feeds the username. */
  first: string;
  last: string;
  /** A middle name or initial; only its first letter is used. */
  middleInitial?: string | null | undefined;
  /** Feeds only the display name and CN. */
  preferredFirst?: string | null | undefined;
}

export interface NamingSettings {
  pattern: string;
  upnSuffix: string;
}

/** A CN within an OU: the CN is unique among the OU's children. */
export interface OuName {
  ouDn: string;
  cn: string;
}

export type NameField = 'first' | 'last';
export type NormalizationRule =
  'invisible' | 'letterforms' | 'diacritics' | 'apostrophes' | 'periods' | 'spaces';
export type NamingAttribute = 'samAccountName' | 'userPrincipalName' | 'mail';

/**
 * How a deviation is cleared: `none` is only shown, `together` can be
 * approved with others of its kind, `individual` one at a time, and
 * `blocked` can't be approved (the name has to be edited).
 */
export type NamingApproval = 'none' | 'together' | 'individual' | 'blocked';

// Each deviation's `from` and `to` are the values either side of the one
// step it describes, and its reason quotes them.
export type NamingDeviation =
  | {
      kind: 'normalized';
      field: NameField;
      rule: NormalizationRule;
      from: string;
      to: string;
      approval: 'none';
      reason: string;
    }
  | {
      kind: 'dropped';
      field: NameField;
      /** `letters` outside the Latin alphabet, or other `characters`. */
      what: 'letters' | 'characters';
      characters: string[];
      from: string;
      to: string;
      approval: 'individual';
      reason: string;
    }
  | {
      kind: 'truncated';
      attribute: LimitedAttribute;
      from: string;
      to: string;
      approval: 'together';
      reason: string;
    }
  | {
      kind: 'collision';
      source: 'directory' | 'batch';
      /** What was already held. */
      taken: NamingAttribute[];
      /** What took the suffix. */
      changed: NamingAttribute[];
      suffix: number;
      from: string;
      to: string;
      approval: 'individual';
      reason: string;
    }
  | {
      kind: 'cn_collision';
      source: 'directory' | 'batch';
      from: string;
      to: string;
      /** `blocked` when the bracketed fallback is taken too. */
      approval: 'none' | 'blocked';
      reason: string;
    }
  | {
      /** A name the operator typed is already held; typed names aren't suffixed. */
      kind: 'taken';
      attribute: NamingAttribute;
      source: 'directory' | 'batch';
      value: string;
      approval: 'blocked';
      reason: string;
    }
  | {
      kind: 'unusable';
      field?: NameField;
      /** Set when it's a name the operator typed that can't be used. */
      attribute?: 'samAccountName' | 'userPrincipalName';
      approval: 'blocked';
      reason: string;
    };

export interface NamingSuggestion {
  samAccountName: string;
  /** The username before `@`, cut only at 64 characters. */
  upnLocal: string;
  upn: string;
  mail: string;
  cn: string;
  displayName: string;
  deviations: NamingDeviation[];
}

/**
 * Names the operator typed in place of the pattern's. They're used as
 * typed: checked, but never suffixed. A typed UPN also gives the
 * sAMAccountName, cut to 20 characters, unless that's typed too.
 */
export interface NameOverrides {
  samAccountName?: string | null | undefined;
  /** The whole UPN, `local@suffix`. */
  userPrincipalName?: string | null | undefined;
  displayName?: string | null | undefined;
}

export interface NamingRequest {
  name: PersonName;
  /** The OU the account will be created in; CNs are checked only when given. */
  ouDn?: string | undefined;
  overrides?: NameOverrides | undefined;
}

/** Values already held in the directory. Compared case-insensitively. */
export interface TakenNames {
  samAccountNames: Iterable<string>;
  userPrincipalNames: Iterable<string>;
  /** `mail` values and SMTP proxy addresses, without the `smtp:` prefix. */
  mailAddresses: Iterable<string>;
  cns: Iterable<OuName>;
}

// ---- Pattern ------------------------------------------------------------

type Segment = { token: NamingToken } | { literal: string };

const SEGMENT = /\{([^{}]*)\}|([^{}]+)|([{}])/g;
const LITERAL = /^[a-z0-9._-]+$/;
const SEPARATOR = /[._-]/;

function parsePattern(pattern: string): { segments: Segment[]; problem: string | null } {
  const segments: Segment[] = [];
  const fail = (problem: string) => ({ segments, problem });
  for (const m of pattern.matchAll(SEGMENT)) {
    const [, token, literal, brace] = m;
    if (token !== undefined) {
      if (!(NAMING_TOKENS as readonly string[]).includes(token)) {
        return fail(
          `{${token}} isn't a token. Use ${NAMING_TOKENS.map((t) => `{${t}}`).join(', ')}.`,
        );
      }
      segments.push({ token: token as NamingToken });
    } else if (literal !== undefined && LITERAL.test(literal)) {
      const doubled = /[._-]{2,}/.exec(literal);
      if (doubled) {
        return fail(
          `"${doubled[0]}": use one separator at a time. A username can't hold two in a row.`,
        );
      }
      segments.push({ literal });
    } else {
      return fail(
        `"${literal ?? brace}" can't go in a username. Between tokens, use lowercase letters, digits, dots, hyphens or underscores.`,
      );
    }
  }
  if (!segments.some((s) => 'token' in s && s.token !== 'mi')) {
    return fail('The pattern needs a first or last name token.');
  }
  const head = segments[0];
  const tail = segments.at(-1);
  if (
    (head && 'literal' in head && SEPARATOR.test(head.literal[0]!)) ||
    (tail && 'literal' in tail && SEPARATOR.test(tail.literal.at(-1)!))
  ) {
    return fail("The pattern can't start or end with a separator.");
  }
  if (tail && 'literal' in tail && /\d$/.test(tail.literal)) {
    return fail(
      'The pattern can\'t end in a digit: a taken name gets a number on the end, so "smith1" would become "smith12".',
    );
  }
  return { segments, problem: null };
}

/** Why a naming pattern can't be used, or null when it can. */
export function namingPatternProblem(pattern: string): string | null {
  if (pattern.length > NAMING_PATTERN_MAX) {
    return `Keep the pattern to ${NAMING_PATTERN_MAX} characters.`;
  }
  return parsePattern(pattern).problem;
}

interface TokenValues {
  first: string;
  last: string;
  mi: string;
}

function render(segments: Segment[], v: TokenValues): string {
  const out = segments
    .map((s) => {
      if ('literal' in s) return s.literal;
      switch (s.token) {
        case 'first':
          return v.first;
        case 'last':
          return v.last;
        case 'f':
          return v.first.slice(0, 1);
        case 'l':
          return v.last.slice(0, 1);
        case 'mi':
          return v.mi;
      }
    })
    .join('');
  // An empty token leaves its separators touching ("john..smith").
  return out.replace(/([._-])[._-]+/g, '$1').replace(/^[._-]+|[._-]+$/g, '');
}

// ---- Normalization ------------------------------------------------------

// Latin letters that NFD doesn't split into a base letter and a mark.
const TRANSLITERATIONS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
  ŧ: 't',
  ŀ: 'l',
  ŋ: 'n',
  ĸ: 'k',
};
// Format characters (zero-width spaces and joiners, soft hyphens, marks of
// direction) and control characters other than whitespace.
// eslint-disable-next-line no-control-regex -- matching them is the point
const INVISIBLE = /\p{Cf}|[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu;
const APOSTROPHES = /['’‘ʼʻ`´]/g;
const DASHES = /[‐‑‒–—]/g;

function transliterate(c: string): string {
  const mapped = TRANSLITERATIONS[c.toLowerCase()];
  if (mapped === undefined) return c;
  return c === c.toLowerCase() ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
}

interface Normalized {
  value: string;
  deviations: NamingDeviation[];
}

const RULE_REASON: Record<NormalizationRule, string> = {
  invisible: 'Invisible characters are removed',
  letterforms: 'Letter forms are simplified',
  diacritics: 'Accents are removed',
  apostrophes: 'Apostrophes are removed',
  periods: 'Periods are removed',
  spaces: 'Spaces are removed',
};

/**
 * A name part as a username can hold it: Latin letters and hyphens,
 * lowercase. Each step that changes it is reported with the value before
 * and after that step, in the case the operator typed.
 */
function normalizePart(field: NameField, raw: string): Normalized {
  const deviations: NamingDeviation[] = [];
  let v = raw.trim();
  const step = (rule: NormalizationRule, next: string, changed = next !== v) => {
    if (changed) {
      deviations.push({
        kind: 'normalized',
        field,
        rule,
        from: v,
        to: next,
        approval: 'none',
        reason: next
          ? `${RULE_REASON[rule]}: "${v}" becomes "${next}".`
          : `${RULE_REASON[rule]} from "${v}", leaving nothing.`,
      });
    }
    v = next;
  };

  step('invisible', v.replace(INVISIBLE, ''));
  // Full-width letters, ligatures (ﬁ) and digraphs (Ĳ) fold to plain ones;
  // NFC's own recomposition isn't a change worth showing.
  const folded = v.normalize('NFKC');
  step('letterforms', folded, folded !== v.normalize('NFC'));
  // Only Latin letters lose their accents; other scripts are dropped whole
  // below, so stripping theirs would be noise.
  step(
    'diacritics',
    Array.from(v.normalize('NFD').replace(/([A-Za-z])\p{M}+/gu, '$1'), transliterate)
      .join('')
      .normalize('NFC'),
  );
  step('apostrophes', v.replace(APOSTROPHES, ''));
  step('periods', v.replace(/\./g, ''));
  step('spaces', v.replace(/\s+/gu, ''));
  v = v.replace(DASHES, '-');

  const letters: string[] = [];
  const others: string[] = [];
  let kept = '';
  for (const c of v) {
    if (/[A-Za-z-]/.test(c)) kept += c;
    else {
      const list = /\p{L}/u.test(c) ? letters : others;
      if (!list.includes(c)) list.push(c);
    }
  }
  for (const [what, characters] of [
    ['letters', letters],
    ['characters', others],
  ] as const) {
    if (characters.length === 0) continue;
    const next = Array.from(v)
      .filter((c) => !characters.includes(c))
      .join('');
    const lead =
      what === 'letters'
        ? 'Letters outside the Latin alphabet are dropped'
        : "Characters a username can't use are dropped";
    deviations.push({
      kind: 'dropped',
      field,
      what,
      characters,
      from: v,
      to: next,
      approval: 'individual',
      reason: next ? `${lead}: "${v}" becomes "${next}".` : `${lead} from "${v}", leaving nothing.`,
    });
    v = next;
  }
  return {
    value: kept
      .toLowerCase()
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, ''),
    deviations,
  };
}

// ---- Suggestion ---------------------------------------------------------

interface Prepared {
  segments: Segment[];
  values: TokenValues;
  username: string;
  /** Before the 256-character cut. */
  fullDisplayName: string;
  displayName: string;
  deviations: NamingDeviation[];
}

const FIELD_LABEL: Record<NameField, string> = { first: 'first name', last: 'last name' };

function prepare(name: PersonName, pattern: string): Prepared {
  const { segments, problem } = parsePattern(pattern);
  if (problem) throw new Error(`invalid naming pattern: ${problem}`);
  const uses = (t: NamingToken) => segments.some((s) => 'token' in s && s.token === t);

  const parts = {
    first: normalizePart('first', name.first),
    last: normalizePart('last', name.last),
  };
  const values: TokenValues = {
    first: parts.first.value,
    last: parts.last.value,
    mi: normalizePart('first', name.middleInitial ?? '')
      .value.replace(/-/g, '')
      .slice(0, 1),
  };

  const deviations: NamingDeviation[] = [];
  for (const [field, initial] of [
    ['first', 'f'],
    ['last', 'l'],
  ] as const) {
    const part = parts[field];
    // A field the pattern only takes an initial from is reported only when
    // nothing is left to take it from: otherwise the initial is all that shows.
    if (!uses(field) && !(uses(initial) && !part.value)) continue;
    deviations.push(...part.deviations);
    if (!part.value) {
      deviations.push({
        kind: 'unusable',
        field,
        approval: 'blocked',
        reason: `Nothing is left of the ${FIELD_LABEL[field]} "${name[field].trim()}" to build a username from. Enter it in Latin letters.`,
      });
    }
  }

  const displayFirst = name.preferredFirst?.trim() || name.first.trim();
  const fullDisplayName = `${displayFirst} ${name.last.trim()}`.replace(/\s+/g, ' ').trim();
  return {
    segments,
    values,
    username: render(segments, values),
    fullDisplayName,
    displayName: cutText(fullDisplayName, NAME_LIMITS.displayName),
    deviations,
  };
}

function cutText(value: string, limit: number, tail = ''): string {
  if (value.length + tail.length <= limit) return value + tail;
  return value.slice(0, limit - tail.length).trimEnd() + tail;
}

/**
 * Shorten the username to `budget` characters: keep the first name, drop
 * hyphenated surname parts from the right, then trim the surname (down to
 * its initial), then the first name.
 */
function fit(p: Prepared, budget: number): string {
  let v = { ...p.values };
  let out = render(p.segments, v);
  if (out.length <= budget) return out;

  const parts = v.last.split('-');
  while (parts.length > 1 && out.length > budget) {
    parts.pop();
    v = { ...v, last: parts.join('-') };
    out = render(p.segments, v);
  }
  for (const field of ['last', 'first'] as const) {
    while (out.length > budget && v[field].length > 1) {
      v = { ...v, [field]: v[field].slice(0, -1) };
      out = render(p.segments, v);
    }
  }
  return out.slice(0, budget).replace(/[._-]+$/, '');
}

const tailOf = (suffix: number) => (suffix > 1 ? String(suffix) : '');
const samWith = (p: Prepared, suffix: number) =>
  fit(p, NAME_LIMITS.samAccountName - tailOf(suffix).length) + tailOf(suffix);
const upnLocalWith = (p: Prepared, suffix: number) =>
  fit(p, NAME_LIMITS.userPrincipalName - tailOf(suffix).length) + tailOf(suffix);

interface AccountNames {
  samAccountName: string;
  upnLocal: string;
  upn: string;
  mail: string;
}

function accountNames(samAccountName: string, upnLocal: string, upnSuffix: string): AccountNames {
  const upn = `${upnLocal}@${upnSuffix}`;
  return { samAccountName, upnLocal, upn, mail: upn };
}

function truncation(
  attribute: LimitedAttribute,
  from: string,
  to: string,
  note: string,
): NamingDeviation[] {
  if (from === to) return [];
  const label = { samAccountName: 'sAMAccountName', cn: 'The CN', displayName: 'The display name' };
  const what =
    attribute === 'userPrincipalName'
      ? `The UPN and email are limited to ${NAME_LIMITS.userPrincipalName} characters before the @`
      : `${label[attribute]} is limited to ${NAME_LIMITS[attribute]} characters`;
  return [
    {
      kind: 'truncated',
      attribute,
      from,
      to,
      approval: 'together',
      reason: `${what}, so "${from}" becomes "${to}".${note ? ` ${note}` : ''}`,
    },
  ];
}

/** No names held: the pattern and the typed names' own rules, without a directory. */
export const NOTHING_TAKEN: TakenNames = {
  samAccountNames: [],
  userPrincipalNames: [],
  mailAddresses: [],
  cns: [],
};

/** The names the pattern gives one person, before any uniqueness check. */
export function suggestNames(name: PersonName, settings: NamingSettings): NamingSuggestion {
  return resolveNames([{ name }], settings, NOTHING_TAKEN)[0]!;
}

// ---- Uniqueness ---------------------------------------------------------

const ATTRIBUTE_LABEL: Record<NamingAttribute, string> = {
  samAccountName: 'sAMAccountName',
  userPrincipalName: 'UPN',
  mail: 'email',
};

const dnKey = (dn: string) => dn.toLowerCase().replace(/\s*,\s*/g, ',');
const cnKey = ({ ouDn, cn }: OuName) => `${dnKey(ouDn)}\n${cn.toLowerCase()}`;

class NameSet {
  private readonly directory: Set<string>;
  private readonly batch = new Set<string>();
  constructor(values: Iterable<string>) {
    this.directory = new Set(Array.from(values, (v) => v.toLowerCase()));
  }
  holder(value: string): 'directory' | 'batch' | null {
    const key = value.toLowerCase();
    if (this.directory.has(key)) return 'directory';
    return this.batch.has(key) ? 'batch' : null;
  }
  claim(value: string): void {
    this.batch.add(value.toLowerCase());
  }
}

type Clash = { attr: NamingAttribute; source: 'directory' | 'batch' };

/**
 * Suggest names for each request in order, making each unique against the
 * directory and against the requests before it. A taken name gets the
 * lowest free numeric suffix, only where it clashes:
 *
 * - a UPN or email clash suffixes the UPN and email together (mail is the
 *   UPN), and the sAMAccountName takes the same suffix so the person has
 *   one username;
 * - a clash of the sAMAccountName alone (often a truncated one) suffixes
 *   just that, keeping the UPN and email the person would otherwise get.
 *
 * A CN taken in the target OU gets the sAMAccountName in brackets. Names
 * the operator typed (`overrides`) are never suffixed: one already held
 * blocks the request.
 */
export function resolveNames(
  requests: NamingRequest[],
  settings: NamingSettings,
  taken: TakenNames,
  /** The forest's UPN suffixes, which a typed UPN must end in, when known. */
  upnSuffixes?: readonly string[],
): NamingSuggestion[] {
  const held: Record<NamingAttribute, NameSet> = {
    samAccountName: new NameSet(taken.samAccountNames),
    userPrincipalName: new NameSet(taken.userPrincipalNames),
    mail: new NameSet(taken.mailAddresses),
  };
  const heldCns = new NameSet(Array.from(taken.cns, cnKey));
  const clashesOf = (names: AccountNames, attrs: NamingAttribute[]): Clash[] =>
    attrs.flatMap((attr) => {
      const source = held[attr].holder(valueOf(names, attr));
      return source ? [{ attr, source }] : [];
    });

  return requests.map(({ name, ouDn, overrides }) => {
    const p = prepare(name, settings.pattern);
    const typed = typedNames(overrides, upnSuffixes);
    const displayName = typed.displayName ?? p.displayName;
    // What the pattern still builds; the rest is as typed.
    const free: NamingAttribute[] = [
      ...(typed.samAccountName === undefined ? ['samAccountName' as const] : []),
      ...(typed.upn === undefined ? ['userPrincipalName' as const, 'mail' as const] : []),
    ];
    const addressesFree = typed.upn === undefined;
    const samFree = typed.samAccountName === undefined;
    const candidate = (n: number, suffixSam: boolean, suffixAddresses: boolean) =>
      accountNames(
        typed.samAccountName ?? samWith(p, suffixSam ? n : 1),
        typed.upn?.local ?? upnLocalWith(p, suffixAddresses ? n : 1),
        typed.upn?.suffix ?? settings.upnSuffix,
      );
    const base = candidate(1, false, false);
    const samNote = base.upnLocal === p.username ? 'The UPN and email keep the full name.' : '';
    const deviations: NamingDeviation[] = [
      ...(addressesFree ? p.deviations : []),
      ...typed.deviations,
      ...(samFree ? truncation('samAccountName', p.username, base.samAccountName, samNote) : []),
      ...(addressesFree ? truncation('userPrincipalName', p.username, base.upnLocal, '') : []),
      ...(typed.displayName === undefined
        ? truncation('displayName', p.fullDisplayName, p.displayName, '')
        : []),
    ];
    for (const { attr, source } of clashesOf(
      base,
      ALL_ATTRIBUTES.filter((a) => !free.includes(a)),
    )) {
      deviations.push(takenBy(attr, valueOf(base, attr), source));
    }
    const result = (names: AccountNames, cn: string): NamingSuggestion => ({
      ...names,
      cn,
      displayName,
      deviations,
    });
    if (deviations.some((d) => d.approval === 'blocked')) {
      return result(base, cutText(displayName, NAME_LIMITS.cn));
    }

    let names = base;
    const clashes = clashesOf(base, free);
    if (clashes.length > 0) {
      const addressesClash = clashes.some((c) => c.attr !== 'samAccountName');
      const checked = free.filter((a) => addressesClash || a === 'samAccountName');
      const next = (n: number) => candidate(n, true, addressesClash);
      let suffix = 2;
      while (suffix <= MAX_SUFFIX && clashesOf(next(suffix), checked).length) suffix++;
      if (suffix > MAX_SUFFIX) {
        deviations.push({
          kind: 'unusable',
          approval: 'blocked',
          reason: `Every suffix up to ${MAX_SUFFIX} is taken for "${p.username}". Enter a different username.`,
        });
        return result(base, cutText(displayName, NAME_LIMITS.cn));
      }
      names = next(suffix);
      deviations.push(collision(base, names, suffix, clashes, addressesClash, samFree));
    }
    for (const attr of ALL_ATTRIBUTES) held[attr].claim(valueOf(names, attr));

    let cn = cutText(displayName, NAME_LIMITS.cn);
    let intended = displayName;
    if (ouDn) {
      const source = heldCns.holder(cnKey({ ouDn, cn }));
      if (source) {
        const tail = ` (${names.samAccountName})`;
        const fallback = cutText(displayName, NAME_LIMITS.cn, tail);
        const alsoTaken = heldCns.holder(cnKey({ ouDn, cn: fallback })) !== null;
        deviations.push({
          kind: 'cn_collision',
          source,
          from: cn,
          to: fallback,
          approval: alsoTaken ? 'blocked' : 'none',
          reason: alsoTaken
            ? `"${cn}" and "${fallback}" both already exist in this OU. Enter a different name for the account.`
            : `"${cn}" already exists in this OU, so the account is named "${fallback}".`,
        });
        cn = fallback;
        intended = displayName + tail;
      }
      heldCns.claim(cnKey({ ouDn, cn }));
    }
    deviations.push(...truncation('cn', intended, cn, 'The display name keeps the full name.'));
    return result(names, cn);
  });
}

const ALL_ATTRIBUTES: NamingAttribute[] = ['samAccountName', 'userPrincipalName', 'mail'];

function takenBy(
  attribute: NamingAttribute,
  value: string,
  source: 'directory' | 'batch',
): NamingDeviation {
  const where =
    source === 'directory' ? 'used in the directory' : 'taken by another person in this list';
  return {
    kind: 'taken',
    attribute,
    source,
    value,
    approval: 'blocked',
    reason: `The ${ATTRIBUTE_LABEL[attribute]} "${value}" is already ${where}.`,
  };
}

interface TypedNames {
  samAccountName: string | undefined;
  upn: { local: string; suffix: string } | undefined;
  displayName: string | undefined;
  deviations: NamingDeviation[];
}

// Entra ID's characters for a UPN's local part; a synced account whose UPN
// has others gets an onmicrosoft.com one instead.
const UPN_LOCAL = /^[A-Za-z0-9'._!#^~-]+$/;

/** The typed names, checked; a typed UPN without a typed sAMAccountName gives it. */
function typedNames(
  overrides: NameOverrides | undefined,
  upnSuffixes?: readonly string[],
): TypedNames {
  const clean = (v: string | null | undefined) => v?.trim() || undefined;
  const deviations: NamingDeviation[] = [];
  const unusable = (attribute: 'samAccountName' | 'userPrincipalName', reason: string) =>
    deviations.push({ kind: 'unusable', attribute, approval: 'blocked', reason });

  const upnTyped = clean(overrides?.userPrincipalName);
  let upn: TypedNames['upn'];
  if (upnTyped !== undefined) {
    const at = upnTyped.lastIndexOf('@');
    upn = { local: at < 0 ? upnTyped : upnTyped.slice(0, at), suffix: upnTyped.slice(at + 1) };
    if (at <= 0 || !upn.suffix) {
      unusable('userPrincipalName', `The UPN "${upnTyped}" needs a suffix: name@domain.`);
    } else if (upn.local.length > NAME_LIMITS.userPrincipalName) {
      unusable(
        'userPrincipalName',
        `The UPN "${upnTyped}" has ${upn.local.length} characters before the @; Entra ID allows ${NAME_LIMITS.userPrincipalName}.`,
      );
    } else if (
      !UPN_LOCAL.test(upn.local) ||
      /^\.|\.$|\.\./.test(upn.local) ||
      /\s|@/.test(upn.suffix) ||
      CONTROL_CHARS.test(upn.suffix)
    ) {
      unusable(
        'userPrincipalName',
        `The UPN "${upnTyped}" won't sync to Entra ID: before the @, use letters, digits and ' . - _ ! # ^ ~, with no dot at either end or two in a row.`,
      );
    } else if (
      upnSuffixes &&
      !upnSuffixes.some((x) => x.toLowerCase() === upn!.suffix.toLowerCase())
    ) {
      unusable(
        'userPrincipalName',
        `"${upn.suffix}" isn't one of this domain's UPN suffixes (${upnSuffixes.join(', ')}).`,
      );
    }
  }

  let samAccountName = clean(overrides?.samAccountName);
  if (samAccountName === undefined && upn) {
    samAccountName = upn.local.slice(0, NAME_LIMITS.samAccountName).replace(/[._-]+$/, '');
    deviations.push(
      ...truncation(
        'samAccountName',
        upn.local,
        samAccountName,
        'The UPN and email keep the full name.',
      ),
    );
  }
  if (samAccountName !== undefined) {
    const problem = samAccountNameSchema.safeParse(samAccountName);
    if (samAccountName.length > NAME_LIMITS.samAccountName) {
      unusable(
        'samAccountName',
        `The sAMAccountName "${samAccountName}" is ${samAccountName.length} characters; AD allows ${NAME_LIMITS.samAccountName}.`,
      );
    } else if (!problem.success) {
      unusable(
        'samAccountName',
        `The sAMAccountName "${samAccountName}" ${problem.error.issues[0]?.message ?? 'is invalid'}.`,
      );
    }
  }
  return { samAccountName, upn, displayName: clean(overrides?.displayName), deviations };
}

function valueOf(names: AccountNames, attr: NamingAttribute): string {
  return attr === 'userPrincipalName' ? names.upn : names[attr];
}

function collision(
  base: AccountNames,
  names: AccountNames,
  suffix: number,
  clashes: Clash[],
  addressesClash: boolean,
  samFree: boolean,
): NamingDeviation {
  const source = clashes.some((c) => c.source === 'directory') ? 'directory' : 'batch';
  const many = clashes.length > 1;
  const values = listOf(
    clashes.map(({ attr }) => `${ATTRIBUTE_LABEL[attr]} "${valueOf(base, attr)}"`),
  );
  const where =
    source === 'directory' ? 'used in the directory' : 'taken by another person in this list';
  const taken = `The ${values} ${many ? 'are' : 'is'} already ${where}.`;
  const addresses = `With ${suffix} added, the UPN and email become "${names.upn}"`;
  return {
    kind: 'collision',
    source,
    taken: clashes.map((c) => c.attr),
    changed: addressesClash
      ? samFree
        ? ['samAccountName', 'userPrincipalName', 'mail']
        : ['userPrincipalName', 'mail']
      : ['samAccountName'],
    suffix,
    from: addressesClash ? base.upnLocal : base.samAccountName,
    to: addressesClash ? names.upnLocal : names.samAccountName,
    approval: 'individual',
    reason: addressesClash
      ? samFree
        ? `${taken} ${addresses} and the sAMAccountName "${names.samAccountName}".`
        : `${taken} ${addresses}.`
      : `${taken} With ${suffix} added it becomes "${names.samAccountName}"; the UPN and email are free and stay "${names.upn}".`,
  };
}

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? '';
  for (const v of values) {
    while (!v.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export interface NamingLookups {
  samAccountNamePrefixes: string[];
  /** Local parts; UPNs and mail addresses starting with them. */
  upnLocalPrefixes: string[];
  /** CNs to look for in each OU, exactly. */
  cns: OuName[];
  /** CNs to look for in each OU starting with these: the bracketed fallbacks. */
  cnPrefixes: OuName[];
}

/**
 * What to look up in the directory so `resolveNames` sees every value a
 * request could end up taking: each sAMAccountName and UPN/mail local part
 * starting with these prefixes, and each CN, or its fallback, in its OU.
 */
export function namingLookups(requests: NamingRequest[], settings: NamingSettings): NamingLookups {
  const sam = new Set<string>();
  const upn = new Set<string>();
  const cns = new Map<string, OuName>();
  const cnPrefixes = new Map<string, OuName>();
  // A fallback's tail is " (" + a sAMAccountName + ")".
  const longestTail = NAME_LIMITS.samAccountName + 3;
  for (const { name, ouDn, overrides } of requests) {
    const p = prepare(name, settings.pattern);
    const typed = typedNames(overrides);
    const budgets = (limit: number) => [0, 1, 2, 3].map((digits) => fit(p, limit - digits));
    if (typed.samAccountName !== undefined) sam.add(typed.samAccountName);
    else if (p.username) sam.add(commonPrefix(budgets(NAME_LIMITS.samAccountName)));
    if (typed.upn) upn.add(typed.upn.local);
    else if (p.username) upn.add(commonPrefix(budgets(NAME_LIMITS.userPrincipalName)));
    const displayName = typed.displayName ?? p.displayName;
    if (ouDn) {
      const cn = { ouDn, cn: cutText(displayName, NAME_LIMITS.cn) };
      cns.set(cnKey(cn), cn);
      const prefix = {
        ouDn,
        cn:
          displayName.length + longestTail <= NAME_LIMITS.cn
            ? `${displayName} (`
            : displayName.slice(0, NAME_LIMITS.cn - longestTail).trimEnd(),
      };
      cnPrefixes.set(cnKey(prefix), prefix);
    }
  }
  return {
    samAccountNamePrefixes: [...sam],
    upnLocalPrefixes: [...upn],
    cns: [...cns.values()],
    cnPrefixes: [...cnPrefixes.values()],
  };
}
