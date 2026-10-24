// SPDX-License-Identifier: BUSL-1.1
// Every single-key shortcut's key, in one place, so two shortcuts on one
// page can't end up on the same key unnoticed (shortcutKeys.test.ts).

export const SHORTCUT_KEYS = {
  general: { help: '?' },
  list: { search: '/', next: 'j', previous: 'k', open: 'Enter' },
  tabs: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  // Enable and Disable share a key: only one of them fits an account.
  user: { unlock: 'u', resetPassword: 'r', enableDisable: 'e', move: 'm', issueTap: 't' },
  computer: { enableDisable: 'e', resetAccount: 'r', move: 'm' },
  group: { addMember: 'a' },
} as const;

export type ShortcutScope = keyof typeof SHORTCUT_KEYS;

/** The scopes whose keys one page offers together. */
export const SHORTCUT_PAGES: Record<string, readonly ShortcutScope[]> = {
  list: ['general', 'list'],
  user: ['general', 'tabs', 'user'],
  computer: ['general', 'tabs', 'computer'],
  group: ['general', 'tabs', 'group'],
};
