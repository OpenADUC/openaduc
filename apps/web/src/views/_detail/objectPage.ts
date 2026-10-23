// SPDX-License-Identifier: BUSL-1.1
import type { Capability } from '@openaduc/shared';

// Icons are PrimeIcons names such as 'pi-th-large'; the layout adds the
// base `pi` class.

export interface ObjectPageTab<T extends string> {
  id: T;
  label: string;
  icon: string;
  count?: number;
  visible: boolean;
  /** Always icon-only, for icons that stand on their own (Overview, Debug). */
  iconOnly?: boolean;
}

export interface ObjectAction {
  label: string;
  icon: string;
  /** Operators without it don't see the action. */
  capability: Capability;
  /**
   * Why it doesn't apply to this object, e.g. Unlock on an account that
   * isn't locked: the menu leaves it out, and the cheat sheet says why.
   */
  unavailable?: string | null;
  /** The key that runs it on the page, e.g. 'u'; actions may share one. */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

/** A launcher in the header, such as Email or a Teams chat. */
export interface ObjectLink {
  label: string;
  icon: string;
  href: string;
  title: string;
}

/**
 * What the loaded page usually shows, so the skeleton shown while its
 * record loads takes about the same room.
 */
export interface ObjectPageSkeleton {
  /** A status line under the name, such as a user's sign-in status. */
  status?: boolean;
  /** A subtitle line, such as a user's title or a group's description. */
  subtitle?: boolean;
  /** Cards on the first tab; two or more sit side by side. Default 2. */
  cards?: number;
}
