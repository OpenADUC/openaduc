// SPDX-License-Identifier: BUSL-1.1
import type { Capability } from '@openaduc/shared';

export interface ObjectPageTab<T extends string> {
  id: T;
  label: string;
  /** PrimeIcons class, e.g. 'pi-th-large'. */
  icon: string;
  count?: number;
  visible: boolean;
  /** Always icon-only, for icons that stand on their own (Overview, Debug). */
  iconOnly?: boolean;
}

export interface ObjectAction {
  label: string;
  /** PrimeIcons classes, e.g. 'pi pi-unlock'. */
  icon: string;
  /** Operators without it don't see the action. */
  capability: Capability;
  /** False hides the action, e.g. Unlock on an account that isn't locked. */
  available?: boolean;
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
