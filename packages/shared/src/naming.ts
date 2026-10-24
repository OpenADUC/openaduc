// SPDX-License-Identifier: BUSL-1.1
// The naming pattern: turning a person's name into the names a new account
// gets (sAMAccountName, UPN, mail, CN, display name), with every place the
// result differs from what the pattern asked for reported as a deviation.
// Pure, so the settings preview, the create and import workflows and the
// API's uniqueness check all agree.

export const NAMING_TOKENS = ['first', 'last', 'f', 'l', 'mi'] as const;
export type NamingToken = (typeof NAMING_TOKENS)[number];
export const DEFAULT_NAMING_PATTERN = '{first}.{last}';
export const SAM_ACCOUNT_NAME_MAX = 20;
export const NAMING_PATTERN_MAX = 64;
// Suffixes run to 999, so a candidate sAMAccountName may lose 3 characters.
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

export type NameField = 'first' | 'last';
export type NormalizationRule = 'diacritics' | 'apostrophes' | 'spaces';
export type NamingAttribute = 'samAccountName' | 'userPrincipalName' | 'mail';

/**
 * How a deviation is cleared: `none` is only shown, `together` can be
 * approved with others of its kind, `individual` one at a time, and
 * `blocked` can't be approved (the name has to be edited).
 */
export type NamingApproval = 'none' | 'together' | 'individual' | 'blocked';

export type NamingDeviation =
  | {
      kind: 'normalized';
      field: NameField;
      rules: NormalizationRule[];
      from: string;
      to: string;
      approval: 'none';
      reason: string;
    }
  | {
      kind: 'dropped';
      field: NameField;
      characters: string[];
      from: string;
      to: string;
      approval: 'individual';
      reason: string;
    }
  | { kind: 'truncated'; from: string; to: string; approval: 'together'; reason: string }
  | {
      kind: 'collision';
      source: 'directory' | 'batch';
      taken: NamingAttribute[];
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
      approval: 'none';
      reason: string;
    }
  | { kind: 'unusable'; approval: 'blocked'; reason: string };

export interface NamingSuggestion {
  samAccountName: string;
  /** The username before `@`: the full pattern, never truncated. */
  upnLocal: string;
  upn: string;
  mail: string;
  cn: string;
  displayName: string;
  deviations: NamingDeviation[];
}

export interface NamingRequest {
  name: PersonName;
  /** The OU the account will be created in; CNs are checked only when given. */
  ouDn?: string | undefined;
}

/** Values already held in the directory. Compared case-insensitively. */
export interface TakenNames {
  samAccountNames: Iterable<string>;
  userPrincipalNames: Iterable<string>;
  /** `mail` values and SMTP proxy addresses, without the `smtp:` prefix. */
  mailAddresses: Iterable<string>;
  cns: Iterable<{ ouDn: string; cn: string }>;
}

// ---- Pattern ------------------------------------------------------------

type Segment = { token: NamingToken } | { literal: string };

const SEGMENT = /\{([^{}]*)\}|([^{}]+)|([{}])/g;
const LITERAL = /^[a-z0-9._-]+$/;

function parsePattern(pattern: string): { segments: Segment[]; problem: string | null } {
  const segments: Segment[] = [];
  for (const m of pattern.matchAll(SEGMENT)) {
    const [, token, literal, brace] = m;
    if (token !== undefined) {
      if (!(NAMING_TOKENS as readonly string[]).includes(token)) {
        return {
          segments,
          problem: `{${token}} isn't a token. Use ${NAMING_TOKENS.map((t) => `{${t}}`).join(', ')}.`,
        };
      }
      segments.push({ token: token as NamingToken });
    } else if (literal !== undefined && LITERAL.test(literal)) {
      segments.push({ literal });
    } else {
      return {
        segments,
        problem: `"${literal ?? brace}" can't go in a username. Between tokens, use lowercase letters, digits, dots, hyphens or underscores.`,
      };
    }
  }
  if (!segments.some((s) => 'token' in s && s.token !== 'mi')) {
    return { segments, problem: 'The pattern needs a first or last name token.' };
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

// Letters NFD doesn't split into a base letter and a mark.
const TRANSLITERATIONS: Record<string, string> = {
  ß: 'ss',
  ẞ: 'ss',
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
const APOSTROPHES = /['’‘ʼʻ`´]/g;
const DASHES = /[‐‑‒–—]/g;

interface Normalized {
  value: string;
  rules: NormalizationRule[];
  dropped: string[];
}

function normalizePart(raw: string): Normalized {
  const rules: NormalizationRule[] = [];
  let v = raw.trim().toLowerCase();

  const stripped = Array.from(v.normalize('NFD').replace(/\p{M}/gu, ''))
    .map((c) => TRANSLITERATIONS[c] ?? c)
    .join('');
  if (stripped !== v) rules.push('diacritics');
  v = stripped;

  const noApostrophes = v.replace(APOSTROPHES, '');
  if (noApostrophes !== v) rules.push('apostrophes');
  v = noApostrophes;

  const noSpaces = v.replace(/\s+/gu, '');
  if (noSpaces !== v) rules.push('spaces');
  v = noSpaces.replace(DASHES, '-');

  const dropped: string[] = [];
  let kept = '';
  for (const c of v) {
    if (/[a-z-]/.test(c)) kept += c;
    else if (!dropped.includes(c)) dropped.push(c);
  }
  return { value: kept.replace(/-+/g, '-').replace(/^-+|-+$/g, ''), rules, dropped };
}

const RULE_WORDS: Record<NormalizationRule, string> = {
  diacritics: 'accents',
  apostrophes: 'apostrophes',
  spaces: 'spaces',
};

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function partDeviations(field: NameField, raw: string, n: Normalized): NamingDeviation[] {
  const out: NamingDeviation[] = [];
  const from = raw.trim();
  if (n.rules.length > 0) {
    out.push({
      kind: 'normalized',
      field,
      rules: n.rules,
      from,
      to: n.value,
      approval: 'none',
      reason: `${sentenceCase(listOf(n.rules.map((r) => RULE_WORDS[r])))} are removed: "${from}" becomes "${n.value}".`,
    });
  }
  if (n.dropped.length > 0) {
    out.push({
      kind: 'dropped',
      field,
      characters: n.dropped,
      from,
      to: n.value,
      approval: 'individual',
      reason: `Characters a username can't use are dropped from "${from}": ${n.dropped.join(' ')}`,
    });
  }
  return out;
}

// ---- Suggestion ---------------------------------------------------------

interface Prepared {
  segments: Segment[];
  values: TokenValues;
  username: string;
  displayName: string;
  deviations: NamingDeviation[];
}

function prepare(name: PersonName, pattern: string): Prepared {
  const { segments, problem } = parsePattern(pattern);
  if (problem) throw new Error(`invalid naming pattern: ${problem}`);
  const uses = (t: NamingToken) => segments.some((s) => 'token' in s && s.token === t);

  const first = normalizePart(name.first);
  const last = normalizePart(name.last);
  const values: TokenValues = {
    first: first.value,
    last: last.value,
    mi: normalizePart(name.middleInitial ?? '')
      .value.replace(/-/g, '')
      .slice(0, 1),
  };

  const deviations: NamingDeviation[] = [];
  // A field the pattern only takes an initial from is reported only when
  // nothing is left to take it from: otherwise the initial is all that shows.
  const reported = (full: NamingToken, initial: NamingToken, n: Normalized) =>
    uses(full) || (uses(initial) && !n.value);
  if (reported('first', 'f', first)) deviations.push(...partDeviations('first', name.first, first));
  if (reported('last', 'l', last)) deviations.push(...partDeviations('last', name.last, last));

  const displayFirst = name.preferredFirst?.trim() || name.first.trim();
  return {
    segments,
    values,
    username: render(segments, values),
    displayName: `${displayFirst} ${name.last.trim()}`.replace(/\s+/g, ' ').trim(),
    deviations,
  };
}

/**
 * Shorten a rendered username to `budget` characters for sAMAccountName:
 * keep the first name, drop hyphenated surname parts from the right, then
 * trim the surname (down to its initial), then the first name.
 */
function fitSam(p: Prepared, budget: number): string {
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

interface SuffixedNames {
  samAccountName: string;
  upnLocal: string;
  upn: string;
  mail: string;
}

const ATTRIBUTES: NamingAttribute[] = ['samAccountName', 'userPrincipalName', 'mail'];

function valueOf(names: SuffixedNames, attr: NamingAttribute): string {
  return attr === 'userPrincipalName' ? names.upn : names[attr];
}

function withSuffix(p: Prepared, upnSuffix: string, suffix: number): SuffixedNames {
  const tail = suffix > 1 ? String(suffix) : '';
  const upnLocal = `${p.username}${tail}`;
  const upn = `${upnLocal}@${upnSuffix}`;
  return {
    samAccountName: `${fitSam(p, SAM_ACCOUNT_NAME_MAX - tail.length)}${tail}`,
    upnLocal,
    upn,
    mail: upn,
  };
}

function truncation(p: Prepared, sam: string): NamingDeviation[] {
  if (sam === p.username) return [];
  return [
    {
      kind: 'truncated',
      from: p.username,
      to: sam,
      approval: 'together',
      reason: `sAMAccountName is limited to ${SAM_ACCOUNT_NAME_MAX} characters, so "${p.username}" becomes "${sam}". The UPN and email keep the full name.`,
    },
  ];
}

function unusable(p: Prepared): NamingDeviation | null {
  if (p.username) return null;
  return {
    kind: 'unusable',
    approval: 'blocked',
    reason: 'No letters are left to build a username from. Enter the name in Latin letters.',
  };
}

const NOTHING_TAKEN: TakenNames = {
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
const cnKey = (ouDn: string, cn: string) => `${dnKey(ouDn)}\n${cn.toLowerCase()}`;

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

/**
 * Suggest names for each request in order, making each unique against the
 * directory and against the requests before it: a taken name gets the
 * lowest free numeric suffix (the same one in sAMAccountName, UPN and
 * mail), and a CN taken in the target OU gets the username in brackets.
 */
export function resolveNames(
  requests: NamingRequest[],
  settings: NamingSettings,
  taken: TakenNames,
): NamingSuggestion[] {
  const sets: Record<NamingAttribute, NameSet> = {
    samAccountName: new NameSet(taken.samAccountNames),
    userPrincipalName: new NameSet(taken.userPrincipalNames),
    mail: new NameSet(taken.mailAddresses),
  };
  const cns = new NameSet(Array.from(taken.cns, (c) => cnKey(c.ouDn, c.cn)));
  const clashes = (names: SuffixedNames) =>
    ATTRIBUTES.flatMap((attr) => {
      const source = sets[attr].holder(valueOf(names, attr));
      return source ? [{ attr, source }] : [];
    });

  return requests.map(({ name, ouDn }) => {
    const p = prepare(name, settings.pattern);
    const first = withSuffix(p, settings.upnSuffix, 1);
    const deviations = [...p.deviations, ...truncation(p, first.samAccountName)];
    const result = (names: SuffixedNames, cn = p.displayName): NamingSuggestion => ({
      ...names,
      cn,
      displayName: p.displayName,
      deviations,
    });
    const blocked = unusable(p);
    if (blocked) {
      deviations.push(blocked);
      return result(first);
    }

    let names = first;
    const taken = clashes(first);
    if (taken.length > 0) {
      let suffix = 2;
      while (suffix <= MAX_SUFFIX && clashes(withSuffix(p, settings.upnSuffix, suffix)).length) {
        suffix++;
      }
      if (suffix > MAX_SUFFIX) {
        deviations.push({
          kind: 'unusable',
          approval: 'blocked',
          reason: `Every suffix up to ${MAX_SUFFIX} is taken for "${p.username}". Enter a different username.`,
        });
        return result(first);
      }
      names = withSuffix(p, settings.upnSuffix, suffix);
      deviations.push(collision(first, names, suffix, taken));
    }
    for (const attr of ATTRIBUTES) sets[attr].claim(valueOf(names, attr));

    let cn = p.displayName;
    if (ouDn) {
      const source = cns.holder(cnKey(ouDn, cn));
      if (source) {
        cn = `${p.displayName} (${names.samAccountName})`;
        deviations.push({
          kind: 'cn_collision',
          source,
          from: p.displayName,
          to: cn,
          approval: 'none',
          reason: `"${p.displayName}" already exists in this OU, so the account is named "${cn}".`,
        });
      }
      cns.claim(cnKey(ouDn, cn));
    }
    return result(names, cn);
  });
}

function collision(
  first: SuffixedNames,
  names: SuffixedNames,
  suffix: number,
  taken: { attr: NamingAttribute; source: 'directory' | 'batch' }[],
): NamingDeviation {
  const source = taken.some((t) => t.source === 'directory') ? 'directory' : 'batch';
  const many = taken.length > 1;
  const values = listOf(
    taken.map(({ attr }) => `${ATTRIBUTE_LABEL[attr]} "${valueOf(first, attr)}"`),
  );
  const where =
    source === 'directory' ? 'used in the directory' : 'taken by another person in this list';
  return {
    kind: 'collision',
    source,
    taken: taken.map((t) => t.attr),
    suffix,
    from: first.upnLocal,
    to: names.upnLocal,
    approval: 'individual',
    reason: `The ${values} ${many ? 'are' : 'is'} already ${where}. Adding ${suffix} makes ${
      many ? 'them' : 'it'
    } unique; the UPN and email get the same suffix (${names.upn}).`,
  };
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
  cns: { ouDn: string; cn: string }[];
}

/**
 * What to look up in the directory so `resolveNames` sees every value a
 * request could end up taking: each sAMAccountName and UPN/mail local part
 * starting with these prefixes, and each CN in its OU.
 */
export function namingLookups(requests: NamingRequest[], settings: NamingSettings): NamingLookups {
  const sam = new Set<string>();
  const upn = new Set<string>();
  const cns = new Map<string, { ouDn: string; cn: string }>();
  for (const { name, ouDn } of requests) {
    const p = prepare(name, settings.pattern);
    if (!p.username) continue;
    const budgets = [0, 1, 2, 3].map((digits) => fitSam(p, SAM_ACCOUNT_NAME_MAX - digits));
    sam.add(commonPrefix(budgets));
    upn.add(p.username);
    if (ouDn) cns.set(cnKey(ouDn, p.displayName), { ouDn, cn: p.displayName });
  }
  return { samAccountNamePrefixes: [...sam], upnLocalPrefixes: [...upn], cns: [...cns.values()] };
}
