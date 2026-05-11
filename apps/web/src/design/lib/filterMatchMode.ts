// SPDX-License-Identifier: BUSL-1.1
// Mirror of PrimeVue's `@primevue/core/api` FilterMatchMode constants.
// We don't import that package directly because it isn't a hoisted
// dependency under pnpm — only `primevue` is. The string values match
// PrimeVue 4.x exactly and are stable across the 4.x line.
export const FilterMatchMode = {
  STARTS_WITH: 'startsWith',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'notContains',
  ENDS_WITH: 'endsWith',
  EQUALS: 'equals',
  NOT_EQUALS: 'notEquals',
  IN: 'in',
  LESS_THAN: 'lt',
  LESS_THAN_OR_EQUAL_TO: 'lte',
  GREATER_THAN: 'gt',
  GREATER_THAN_OR_EQUAL_TO: 'gte',
  BETWEEN: 'between',
  DATE_IS: 'dateIs',
  DATE_IS_NOT: 'dateIsNot',
  DATE_BEFORE: 'dateBefore',
  DATE_AFTER: 'dateAfter',
} as const;

export type FilterMatchModeValue = (typeof FilterMatchMode)[keyof typeof FilterMatchMode];
