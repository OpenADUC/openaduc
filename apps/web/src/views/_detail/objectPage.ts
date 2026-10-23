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
  /** False hides the action, e.g. Unlock on an account that isn't locked. */
  available?: boolean;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}

/** An action that failed, shown under the Actions menu until retried or dismissed. */
export interface ObjectActionFailure {
  summary: string;
  message: string;
  retry: () => void;
  dismiss: () => void;
}

/** A launcher in the header, such as Email or a Teams chat. */
export interface ObjectLink {
  label: string;
  icon: string;
  href: string;
  title: string;
}
