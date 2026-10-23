// SPDX-License-Identifier: BUSL-1.1
// The actions on a user's account wherever they're offered, the user's page
// and quick search, so they're named and gated the same way.
import type { Capability } from '@openaduc/shared';

export type UserAction = 'unlock' | 'reset-password' | 'enable' | 'disable';

export interface UserActionInfo {
  label: string;
  /** Reset password has none: its dialog shows it running. */
  running?: string;
  icon: string;
  capability: Capability;
  danger?: boolean;
  /** Its key on the user's page; Enable and Disable share one. */
  shortcut: string;
}

export const USER_ACTIONS: Record<UserAction, UserActionInfo> = {
  unlock: {
    label: 'Unlock account',
    running: 'Unlocking…',
    icon: 'pi-unlock',
    capability: 'write:user.unlock',
    shortcut: 'u',
  },
  'reset-password': {
    label: 'Reset password…',
    icon: 'pi-key',
    capability: 'write:user.resetPassword',
    danger: true,
    shortcut: 'r',
  },
  enable: {
    label: 'Enable account',
    running: 'Enabling…',
    icon: 'pi-check',
    capability: 'write:user.enableDisable',
    shortcut: 'e',
  },
  disable: {
    label: 'Disable account',
    running: 'Disabling…',
    icon: 'pi-ban',
    capability: 'write:user.enableDisable',
    danger: true,
    shortcut: 'e',
  },
};

export const USER_ACTION_ORDER: readonly UserAction[] = [
  'unlock',
  'reset-password',
  'enable',
  'disable',
];

type AccountState = { enabled: boolean; locked: boolean };

/** Why the account's state doesn't fit the action, e.g. Unlock an account that isn't locked. */
export function unfitReason(action: UserAction, u: AccountState): string | null {
  switch (action) {
    case 'unlock':
      return u.locked ? null : 'account isn’t locked';
    case 'reset-password':
      return null;
    case 'enable':
      return u.enabled ? 'account is already enabled' : null;
    case 'disable':
      return u.enabled ? null : 'account is already disabled';
  }
}

/** Whether the account's state fits the action, e.g. Unlock only a locked account. */
export function fitsUser(action: UserAction, u: AccountState): boolean {
  return unfitReason(action, u) === null;
}

/** The label, or what it says while `running` is this action. */
export function userActionLabel(action: UserAction, running: UserAction | null): string {
  const info = USER_ACTIONS[action];
  return (running === action && info.running) || info.label;
}
