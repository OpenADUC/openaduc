// SPDX-License-Identifier: BUSL-1.1
// Single-key shortcuts. Pages register what they offer; one keydown
// handler runs them, and the cheat sheet lists the same registrations, so
// it can't list a shortcut that doesn't work or miss one that does.

import { computed, getCurrentScope, onScopeDispose, shallowReactive } from 'vue';

/** The cheat sheet's headings, in its order. */
export const SHORTCUT_SECTIONS = ['List', 'Actions', 'Tabs', 'General'] as const;
export type ShortcutSection = (typeof SHORTCUT_SECTIONS)[number];

export interface Shortcut {
  /** One of SHORTCUT_KEYS: a lower-case letter, '/', '?', 'Enter', a digit. */
  key: string;
  label: string;
  section: ShortcutSection;
  /** Why it can't run now; the cheat sheet lists it greyed, with this. */
  unavailable?: string | null;
  /** Runs again while the key is held, e.g. moving through rows. */
  repeats?: boolean;
  run: () => void;
}

type Source = () => readonly Shortcut[];

const sources = shallowReactive(new Set<Source>());

/** Offer these shortcuts while the calling component is mounted. */
export function useShortcuts(source: Source): void {
  sources.add(source);
  if (getCurrentScope()) onScopeDispose(() => sources.delete(source));
}

/**
 * One shortcut per key, in the order they were registered: the first that
 * can run, else the first. Enable and Disable can share `e` that way.
 */
export const shortcuts = computed<Shortcut[]>(() => {
  const byKey = new Map<string, Shortcut>();
  for (const source of sources) {
    for (const s of source()) {
      const held = byKey.get(s.key);
      if (!held || (held.unavailable && !s.unavailable)) byKey.set(s.key, s);
    }
  }
  return [...byKey.values()];
});

// Inputs that take no letters, such as a row's checkbox, aren't typing.
const NOT_TEXT = [
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'image',
  'color',
  'file',
]
  .map((t) => `:not([type="${t}"])`)
  .join('');

const TYPING = `input${NOT_TEXT}, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"], [role="listbox"]`;

// Enter belongs to a focused control: it presses a button, follows a link.
const CONTROL =
  'a[href], button, input, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], summary';

// Quick search, every PrimeVue Dialog and Drawer, confirmations, and popup
// menus such as Actions.
const OVERLAY =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .p-menu-overlay, .p-select-overlay, .p-multiselect-overlay';

function within(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

/** Whether a shortcut may take this key at all. */
function forShortcuts(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  // Shift is fine where the layout needs it to type a symbol or digit (? on
  // every layout, / on some), but Shift with a letter or Enter is another key.
  if (e.shiftKey && (e.key.length !== 1 || e.key.toLowerCase() !== e.key.toUpperCase())) {
    return false;
  }
  if (within(e.target, TYPING)) return false;
  if (e.key === 'Enter' && within(e.target, CONTROL)) return false;
  return document.querySelector(OVERLAY) === null;
}

/** The window's keydown handler: runs the key's shortcut if one can run. */
export function onShortcutKey(e: KeyboardEvent): void {
  if (!forShortcuts(e)) return;
  // Caps Lock types 'U' without Shift; Shift+U was turned away above.
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const shortcut = shortcuts.value.find((s) => s.key === key);
  if (!shortcut || shortcut.unavailable || (e.repeat && !shortcut.repeats)) return;
  e.preventDefault();
  shortcut.run();
}
