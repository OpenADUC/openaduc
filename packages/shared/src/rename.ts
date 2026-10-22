// SPDX-License-Identifier: BUSL-1.1
// Suggest the rest of an account's identity when a person's name changes.
//
// Directories rarely agree on naming conventions, so instead of asking the
// operator for a pattern we infer it per account from the values it has
// today. "jsmith" with given name John and surname Smith tells us the logon
// is first-initial + surname; renaming to Jane Doe then suggests "jdoe".
// Anything we can't explain from the old name is left as is and flagged, so
// the operator edits it by hand rather than trusting a guess.

export interface RenameIdentity {
  givenName: string | null;
  surname: string | null;
  displayName: string | null;
  cn: string | null;
  samAccountName: string | null;
  userPrincipalName: string | null;
  email: string | null;
}

export type RenameField = Exclude<keyof RenameIdentity, 'givenName' | 'surname'>;

export interface RenameSuggestion {
  values: RenameIdentity;
  // Fields whose naming pattern couldn't be inferred. Their value in
  // `values` is unchanged from `current`.
  unresolved: RenameField[];
}

const SAM_MAX = 20;

export function suggestRenamedIdentity(
  current: RenameIdentity,
  next: { givenName: string; surname: string },
): RenameSuggestion {
  const givenName = next.givenName.trim();
  const surname = next.surname.trim();
  const unresolved: RenameField[] = [];
  const values: RenameIdentity = { ...current, givenName, surname };

  const oldNames = { given: current.givenName?.trim() ?? '', sur: current.surname?.trim() ?? '' };
  const newNames = { given: givenName, sur: surname };

  for (const field of ['displayName', 'cn'] as const) {
    const out = renameFullName(current[field], oldNames, newNames);
    if (out === null) unresolved.push(field);
    else values[field] = out;
  }

  const sam = renameIdentifier(current.samAccountName, oldNames, newNames);
  if (sam === null) unresolved.push('samAccountName');
  else values.samAccountName = sam.slice(0, SAM_MAX);

  for (const field of ['userPrincipalName', 'email'] as const) {
    const value = current[field];
    const at = value ? value.lastIndexOf('@') : -1;
    if (!value || at <= 0) {
      if (value) unresolved.push(field);
      continue;
    }
    const local = renameIdentifier(value.slice(0, at), oldNames, newNames);
    if (local === null) unresolved.push(field);
    else values[field] = `${local}${value.slice(at)}`;
  }

  return { values, unresolved };
}

interface NamePair {
  given: string;
  sur: string;
}

/**
 * Swap the old given name and surname for the new ones wherever they appear
 * as whole words, which keeps whatever arrangement the account uses
 * ("Smith, John", "John Smith (Contractor)", "John Q. Smith"). Returns null
 * when neither old name appears. An empty field gets "Given Surname".
 */
function renameFullName(value: string | null, old: NamePair, next: NamePair): string | null {
  if (!value || !value.trim()) return [next.given, next.sur].filter(Boolean).join(' ');
  const replacements = new Map<string, string>();
  if (old.sur) replacements.set(old.sur.toLowerCase(), next.sur);
  if (old.given) replacements.set(old.given.toLowerCase(), next.given);
  if (replacements.size === 0) return null;

  // One pass with an alternation, longest first, so a new name that
  // happens to equal the other old name isn't replaced twice.
  const alternation = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${alternation})(?![\\p{L}\\p{N}])`, 'giu');
  let matched = false;
  const out = value.replace(re, (m) => {
    matched = true;
    return replacements.get(m.toLowerCase()) ?? m;
  });
  if (!matched) return null;
  return out.replace(/\s{2,}/g, ' ').trim();
}

type Part = 'G' | 'G1' | 'S' | 'S1' | '.' | '_' | '-';

// Common logon-name conventions, most specific first so that e.g. "john.smith"
// isn't claimed by a shorter pattern.
const IDENTIFIER_PATTERNS: Part[][] = [
  ['G', '.', 'S'],
  ['G', '_', 'S'],
  ['G', '-', 'S'],
  ['S', '.', 'G'],
  ['S', '_', 'G'],
  ['G1', '.', 'S'],
  ['G', 'S'],
  ['S', 'G'],
  ['G1', 'S'],
  ['S', 'G1'],
  ['G', 'S1'],
  ['S1', 'G'],
  ['S'],
  ['G'],
];

/**
 * Re-derive a logon-style identifier ("jsmith", "John.Smith", "smithj2")
 * from the new name, using whichever pattern reproduces the current value
 * from the old name. A trailing number added to dodge a collision is
 * dropped: the new name may not collide, and the server checks uniqueness
 * before writing. Returns null when no pattern fits.
 */
function renameIdentifier(value: string | null, old: NamePair, next: NamePair): string | null {
  if (!value) return null;
  const oldTokens = { G: identifierToken(old.given), S: identifierToken(old.sur) };
  const newTokens = { G: identifierToken(next.given), S: identifierToken(next.sur) };
  if (!oldTokens.G && !oldTokens.S) return null;

  const base = value.replace(/\d+$/, '');
  const lower = base.toLowerCase();
  for (const pattern of IDENTIFIER_PATTERNS) {
    if (
      pattern.some((p) => (p.startsWith('G') ? !oldTokens.G : p.startsWith('S') && !oldTokens.S))
    ) {
      continue;
    }
    if (render(pattern, oldTokens) !== lower) continue;
    if (
      pattern.some((p) => (p.startsWith('G') ? !newTokens.G : p.startsWith('S') && !newTokens.S))
    ) {
      return null;
    }
    return applyCase(base, pattern, oldTokens, render(pattern, newTokens), newTokens);
  }
  return null;
}

function render(pattern: Part[], tokens: { G: string; S: string }): string {
  return pattern
    .map((p) => {
      switch (p) {
        case 'G':
          return tokens.G;
        case 'G1':
          return tokens.G.slice(0, 1);
        case 'S':
          return tokens.S;
        case 'S1':
          return tokens.S.slice(0, 1);
        default:
          return p;
      }
    })
    .join('');
}

/**
 * Carry the original's capitalisation style over: all lower, all upper, or
 * each name part capitalised ("John.Smith", "JSmith").
 */
function applyCase(
  original: string,
  pattern: Part[],
  oldTokens: { G: string; S: string },
  rendered: string,
  newTokens: { G: string; S: string },
): string {
  if (original === original.toLowerCase()) return rendered;
  if (original === original.toUpperCase()) return rendered.toUpperCase();
  const oldPartsCapitalised = pattern
    .map((p) => partText(p, oldTokens))
    .every((t, i, all) => {
      if (!t || /^[._-]$/.test(t)) return true;
      const offset = all.slice(0, i).join('').length;
      const slice = original.slice(offset, offset + t.length);
      return slice[0] === slice[0]?.toUpperCase();
    });
  if (!oldPartsCapitalised) return rendered;
  return pattern
    .map((p) => {
      const t = partText(p, newTokens);
      return /^[._-]$/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join('');
}

function partText(p: Part, tokens: { G: string; S: string }): string {
  return render([p], tokens);
}

/** "José O'Brien-Smith" → "joseobriensmith": ASCII letters and digits only. */
function identifierToken(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
