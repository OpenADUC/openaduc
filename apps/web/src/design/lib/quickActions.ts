// SPDX-License-Identifier: BUSL-1.1
// Acting on users from quick search: the action a query starts with, and
// the actions a user result offers.
import type { Capability } from '@openaduc/shared';
import { fixFor, type SignInInput } from './signIn.js';
import { USER_ACTIONS, USER_ACTION_ORDER, fitsUser, type UserAction } from './userActions.js';

/** What quick search says about an action, beyond its name on the user's page. */
export interface QuickActionText {
  /** What the footer says Enter does. */
  verb: string;
  /** Why a user's state doesn't fit it. */
  notFitting: string | null;
  /** What a query of the verb alone asks for. */
  ask: string;
}

export const QUICK_ACTIONS: Record<UserAction, QuickActionText> = {
  unlock: {
    verb: 'unlock',
    notFitting: 'Not locked',
    ask: 'Type the name of a user to unlock.',
  },
  'reset-password': {
    verb: 'reset password',
    notFitting: null,
    ask: 'Type the name of a user to give a new password.',
  },
  enable: {
    verb: 'enable',
    notFitting: 'Already enabled',
    ask: 'Type the name of a user to enable.',
  },
  disable: {
    verb: 'disable',
    notFitting: 'Already disabled',
    ask: 'Type the name of a user to disable.',
  },
};

// "password" isn't one: a search for "Password Policy Admins" is a group's name.
const VERBS = new Map<string, UserAction>([
  ['unlock', 'unlock'],
  ['reset', 'reset-password'],
  ['pw', 'reset-password'],
  ['enable', 'enable'],
  ['disable', 'disable'],
]);

/** The verbs that start an action, for saying which ones the operator can use. */
export function quickVerbs(can: (capability: Capability) => boolean): string[] {
  return [...VERBS].filter(([, a]) => can(USER_ACTIONS[a].capability)).map(([verb]) => verb);
}

export interface QuickQuery {
  /** The action the query starts with, which searches users for `text`. */
  action: UserAction | null;
  text: string;
}

/**
 * Reads a leading verb as an action on the users the rest of the query
 * finds. Only a whole first word counts, and only an action the operator
 * `can` perform; a query starting with a quote is searched for as written.
 */
export function parseQuickQuery(
  input: string,
  can: (capability: Capability) => boolean,
): QuickQuery {
  const text = input.trim();
  if (text.startsWith('"')) return { action: null, text: text.slice(1).replace(/"$/, '').trim() };
  const [, first = '', rest = ''] = /^(\S+)\s*(.*)$/s.exec(text) ?? [];
  const action = VERBS.get(first.toLowerCase());
  if (!action || !can(USER_ACTIONS[action].capability)) return { action: null, text };
  return { action, text: rest };
}

interface QuickTarget extends SignInInput {
  enabled: boolean;
  locked: boolean;
}

/**
 * The actions a user result offers: those the operator `can` perform that
 * fit the account's state, the fix its user page leads with first.
 */
export function quickActionsFor(
  u: QuickTarget,
  can: (capability: Capability) => boolean,
  now: Date = new Date(),
): UserAction[] {
  const offered = USER_ACTION_ORDER.filter(
    (a) => fitsUser(a, u) && can(USER_ACTIONS[a].capability),
  );
  const fix = fixFor(u, can, now)?.fix;
  const first = offered.find((a) => a === fix);
  return first ? [first, ...offered.filter((a) => a !== first)] : offered;
}
