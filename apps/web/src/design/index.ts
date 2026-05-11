// SPDX-License-Identifier: BUSL-1.1
// Design system barrel — import from here when consuming primitives.
//
// Layout components are imported by path (e.g., AppShell, Sidebar) since
// they're used in App.vue / route shell only.

export { default as Avatar } from './primitives/Avatar.vue';
export { default as StatusBadge } from './primitives/StatusBadge.vue';
export { default as LiveBadge } from './primitives/LiveBadge.vue';
export { default as KpiCard } from './primitives/KpiCard.vue';
export { default as Sparkline } from './primitives/Sparkline.vue';
export { default as GroupChip } from './primitives/GroupChip.vue';
export { default as Card } from './primitives/Card.vue';
export { default as DnDisplay } from './primitives/DnDisplay.vue';
export { default as InlineField } from './primitives/InlineField.vue';
export { default as EmptyState } from './primitives/EmptyState.vue';
export { default as PageHeader } from './primitives/PageHeader.vue';

export * from './lib/format.js';
