// SPDX-License-Identifier: BUSL-1.1

/** How many of a product's service plans an assignment turns off, as pages say it. */
export const plansOffText = (count: number): string =>
  `${count} service plan${count === 1 ? '' : 's'} turned off`;

/** The PrimeIcons icon that marks licenses everywhere. */
export const LICENSE_ICON = 'pi-verified';
