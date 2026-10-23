// SPDX-License-Identifier: BUSL-1.1
// Acting on users from quick search: the action a query starts with, and
// the actions a user result offers.
import type { Capability } from '@openaduc/shared';
import { fixFor, type SignInInput } from './signIn.js';

export type QuickAction = 'unlock' | 'reset-password' | 'enable' | 'disable';

export interface QuickActionInfo {
  label: string;
  /** What the footer says Enter does. */
  verb: string;
  /** Reset password has none: its dialog shows it running. */
  running?: string;
  icon: string;
  capability: Capability;
  /** Why a user's state doesn't fit it. */
  notFitting: string | null;
  /** What a query of the verb alone asks for. */
  ask: string;
}

export const QUICK_ACTIONS: Record<QuickAction, QuickActionInfo> = {
  unlock: {
    label: 'Unlock',
    verb: 'unlock',
    running: 'Unlocking…',
    icon: 'pi-unlock',
    capability: 'write:user.unlock',
    notFitting: 'Not locked',
    ask: 'Type the name of a user to unlock.',
  },
  'reset-password': {
    label: 'Reset password…',
    verb: 'reset password',
    icon: 'pi-key',
    capability: 'write:user.resetPassword',
    notFitting: null,
    ask: 'Type the name of a user to give a new password.',
  },
  enable: {
    label: 'Enable',
    verb: 'enable',
    running: 'Enabling…',
    icon: 'pi-check',
    capability: 'write:user.enableDisable',
    notFitting: 'Already enabled',
    ask: 'Type the name of a user to enable.',
  },
  disable: {
    label: 'Disable',
    verb: 'disable',
    running: 'Disabling…',
    icon: 'pi-ban',
    capability: 'write:user.enableDisable',
    notFitting: 'Already disabled',
    ask: 'Type the name of a user to disable.',
  },
};

// The user page's order.
const ORDER: readonly QuickAction[] = ['unlock', 'reset-password', 'enable', 'disable'];

// "password" isn't one: a search for "Password Policy Admins" is a group's name.
const VERBS = new Map<string, QuickAction>([
  ['unlock', 'unlock'],
  ['reset', 'reset-password'],
  ['pw', 'reset-password'],
  ['enable', 'enable'],
  ['disable', 'disable'],
]);

/** The verbs that start an action, for saying which ones the operator can use. */
export function quickVerbs(can: (capability: Capability) => boolean): string[] {
  return [...VERBS].filter(([, a]) => can(QUICK_ACTIONS[a].capability)).map(([verb]) => verb);
}

export interface QuickQuery {
  /** The action the query starts with, which searches users for `text`. */
  action: QuickAction | null;
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
  if (!action || !can(QUICK_ACTIONS[action].capability)) return { action: null, text };
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
): QuickAction[] {
  const fits: Record<QuickAction, boolean> = {
    unlock: u.locked,
    'reset-password': true,
    enable: !u.enabled,
    disable: u.enabled,
  };
  const offered = ORDER.filter((a) => fits[a] && can(QUICK_ACTIONS[a].capability));
  const fix = fixFor(u, can, now)?.fix;
  const first = offered.find((a) => a === fix);
  return first ? [first, ...offered.filter((a) => a !== first)] : offered;
}
