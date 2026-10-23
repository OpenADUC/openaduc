<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts" generic="T extends string">
import { computed, ref } from 'vue';
import Button from 'primevue/button';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { useToast } from 'primevue/usetoast';
import Avatar from '../../design/primitives/Avatar.vue';
import { fmtRelative } from '../../design/lib/format.js';
import { useAuthStore } from '../../stores/auth.js';
import { useStickyHeader } from './useStickyHeader';
import { useCompactTabs } from './useCompactTabs';
import { useRouteTab } from './useRouteTab';
import type { ObjectAction, ObjectLink, ObjectPageTab } from './objectPage';

// The page mounts this once its record has loaded, so tab visibility is
// already final.
const props = withDefaults(
  defineProps<{
    kind: 'user' | 'group' | 'computer';
    name: string;
    avatar: {
      name: string | null;
      seed: string | null;
      photoUrl?: string | null;
      shape?: 'circle' | 'rounded';
      icon?: string;
    };
    subtitle?: string | null;
    /** The line under the name; `copyLabel` makes it a copy button. */
    identifier?: { text: string; copyLabel?: string } | null;
    dn: string;
    links?: readonly ObjectLink[];
    tabs: readonly ObjectPageTab<T>[];
    fallbackTab: T;
    actions?: readonly ObjectAction[];
    /** An action is running: the Actions button shows it. */
    actionsBusy?: boolean;
    refreshing?: boolean;
    /** `liveRefreshedAt` is left out for records that are only read from the cache. */
    freshness: { liveRefreshedAt?: string | null; cachedAt: string | null };
  }>(),
  {
    subtitle: null,
    identifier: null,
    links: () => [],
    actions: () => [],
    actionsBusy: false,
    refreshing: false,
  },
);

defineEmits<{ refresh: [] }>();

defineSlots<{
  default(props: { tab: T; select: (id: T) => void }): unknown;
  badges?(): unknown;
  /** The object's primary actions, beside the identity. */
  primary?(props: { compact: boolean }): unknown;
}>();

const auth = useAuthStore();
const toast = useToast();

const { setHero, compact: heroCompact, heroHeight } = useStickyHeader();
const { setNav: setTabsNav, compact: tabsCompact } = useCompactTabs();

const kindLabel = computed(() => props.kind[0]!.toUpperCase() + props.kind.slice(1));

// ---- Header ---------------------------------------------------------------

// The DN without its leading CN when that only repeats the heading.
const dnPath = computed(() => {
  const m = /^CN=([^,]+),(.*)$/i.exec(props.dn);
  if (!m) return props.dn;
  const cn = m[1]!.replace(/\\,/g, ',');
  return cn === props.name.trim() ? m[2]! : props.dn;
});

const copied = ref<{ identifier: boolean; dn: boolean }>({ identifier: false, dn: false });
async function copy(kind: 'identifier' | 'dn'): Promise<void> {
  const text = kind === 'identifier' ? (props.identifier?.text ?? '') : props.dn;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = { ...copied.value, [kind]: true };
    setTimeout(() => {
      copied.value = { ...copied.value, [kind]: false };
    }, 1800);
  } catch {
    toast.add({ severity: 'warn', summary: 'Clipboard unavailable', life: 2500 });
  }
}

// ---- Tabs -----------------------------------------------------------------

const activeTab = useRouteTab<T>({
  tabs: () => props.tabs,
  fallback: props.fallbackTab,
  ready: () => true,
});
const visibleTabs = computed(() => props.tabs.filter((t) => t.visible));

function select(id: T): void {
  activeTab.value = id;
}

// ---- Actions menu ---------------------------------------------------------

const actionsMenu = ref<InstanceType<typeof Menu> | null>(null);
const menuId = computed(() => `${props.kind}-actions-menu`);

const menuItems = computed<MenuItem[]>(() =>
  props.actions
    .filter((a) => a.available !== false && auth.hasCapability(a.capability))
    .map((a) => ({
      label: a.label,
      icon: a.icon,
      disabled: a.disabled,
      class: a.danger ? 'menu-item-danger' : undefined,
      command: a.run,
    })),
);

function toggleActionsMenu(event: Event): void {
  actionsMenu.value?.toggle(event);
}

const freshnessText = computed(() => {
  const f = props.freshness;
  const cached = `Cache written ${fmtRelative(f.cachedAt)}`;
  return 'liveRefreshedAt' in f
    ? `Live refreshed ${fmtRelative(f.liveRefreshedAt)} · ${cached}`
    : cached;
});
</script>

<template>
  <div class="detail-stack" :style="{ '--detail-sticky-offset': `${heroHeight}px` }">
    <!-- Identity on the left, primary actions on the right; everything else
         the operator can do sits in the tab bar's Actions menu. -->
    <section
      :ref="setHero"
      class="detail-hero"
      :class="{ 'is-compact': heroCompact, 'has-primary': !!$slots.primary }"
    >
      <Avatar v-bind="avatar" :size="heroCompact ? 28 : 80" />

      <div class="detail-hero-main">
        <div class="detail-hero-row">
          <h1 class="detail-hero-name">{{ name }}</h1>
          <slot name="badges" />
        </div>

        <div v-if="subtitle" class="detail-hero-title">{{ subtitle }}</div>

        <button
          v-if="identifier?.copyLabel"
          type="button"
          class="copybtn copybtn-inline"
          :title="copied.identifier ? 'Copied!' : `Copy ${identifier.copyLabel}`"
          @click="copy('identifier')"
        >
          <i :class="copied.identifier ? 'pi pi-check' : 'pi pi-copy'" />
          <span class="mono">{{ identifier.text }}</span>
        </button>
        <div v-else-if="identifier" class="detail-hero-upn mono">{{ identifier.text }}</div>

        <div class="detail-hero-actions-row">
          <a
            v-for="link in links"
            :key="link.label"
            class="copybtn launcher"
            :href="link.href"
            :title="link.title"
          >
            <i :class="['pi', link.icon]" />
            <span>{{ link.label }}</span>
          </a>
          <button
            type="button"
            class="copybtn launcher hero-path"
            :title="copied.dn ? 'Copied!' : 'Copy distinguished name'"
            @click="copy('dn')"
          >
            <i :class="copied.dn ? 'pi pi-check' : 'pi pi-sitemap'" />
            <span class="mono hero-path-text">{{ dnPath }}</span>
          </button>
        </div>
      </div>

      <div v-if="$slots.primary" class="detail-hero-primary">
        <slot name="primary" :compact="heroCompact" />
      </div>
    </section>

    <nav
      :ref="setTabsNav"
      class="ds-tabs ds-tabs-with-actions"
      :class="{ compact: tabsCompact, 'hero-compact': heroCompact }"
    >
      <!-- Only the tabs are in the tablist; refresh and Actions sit beside it. -->
      <div class="ds-tablist" role="tablist" :aria-label="`${kindLabel} sections`">
        <button
          v-for="t in visibleTabs"
          :key="t.id"
          type="button"
          role="tab"
          class="ds-tab"
          :class="{ active: activeTab === t.id, 'icon-only': t.iconOnly }"
          :aria-selected="activeTab === t.id"
          :title="tabsCompact || t.iconOnly ? t.label : undefined"
          :aria-label="t.label"
          @click="select(t.id)"
        >
          <i :class="['pi', t.icon]" aria-hidden="true" />
          <span class="ds-tab-label">{{ t.label }}</span>
          <span v-if="t.count !== undefined" class="ds-tab-count mono">{{ t.count }}</span>
        </button>
      </div>
      <div class="ds-tabs-spacer" />
      <Button
        icon="pi pi-refresh"
        text
        severity="secondary"
        size="small"
        :loading="refreshing"
        title="Refresh from directory"
        class="ds-tabs-refresh"
        @click="$emit('refresh')"
      />
      <div v-if="menuItems.length > 0" class="ds-tabs-actions">
        <Button
          label="Actions"
          icon="pi pi-chevron-down"
          icon-pos="right"
          severity="secondary"
          text
          size="small"
          :loading="actionsBusy"
          aria-haspopup="true"
          :aria-controls="menuId"
          @click="toggleActionsMenu"
        />
        <Menu :id="menuId" ref="actionsMenu" :model="menuItems" :popup="true" />
      </div>
    </nav>

    <slot :tab="activeTab" :select="select" />

    <p class="freshness-foot">
      <span class="hint">{{ freshnessText }}</span>
    </p>
  </div>
</template>

<style scoped>
.detail-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Hero ------------------------------------------------------------------- */
.detail-hero {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--accent) 5%, var(--surface)),
    var(--surface)
  );
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 16px;
  min-width: 0;
  position: sticky;
  top: 0;
  z-index: 6;
  transition:
    padding 200ms ease,
    gap 200ms ease,
    border-radius 200ms ease,
    box-shadow 200ms ease;
}

.detail-hero.has-primary {
  grid-template-columns: auto 1fr auto;
}

/* Compact state: padding tightens, the avatar shrinks (Avatar animates its
   own size), and the secondary rows below the name collapse to zero.
   Corners square off and the bottom border drops so the hero merges into
   the sticky tab bar below as one pinned banner; the tab bar's shadow
   carries the "content scrolls under" signal for both. */
.detail-hero.is-compact {
  padding: 6px 14px;
  align-items: center;
  gap: 10px;
  border-radius: 0;
  border-bottom: 0;
  box-shadow: none;
}

.detail-hero-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-hero-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.detail-hero-name {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--text);
  transition: font-size 200ms ease;
}

.detail-hero.is-compact .detail-hero-name {
  font-size: 14px;
}

.detail-hero-primary {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Secondary rows collapse together via max-height + opacity. */
.detail-hero-title,
.detail-hero-upn,
.detail-hero-actions-row,
.copybtn-inline {
  overflow: hidden;
  max-height: 60px;
  opacity: 1;
  transition:
    max-height 200ms ease,
    opacity 150ms ease,
    margin 200ms ease;
}

.detail-hero.is-compact .detail-hero-title,
.detail-hero.is-compact .detail-hero-upn,
.detail-hero.is-compact .detail-hero-actions-row,
.detail-hero.is-compact .copybtn-inline {
  max-height: 0;
  opacity: 0;
  margin: 0;
  pointer-events: none;
}

.detail-hero-title {
  color: var(--text-2);
  font-size: 13px;
  margin-top: 4px;
}

.detail-hero-upn {
  color: var(--text-3);
  font-size: 12.5px;
  margin-top: 2px;
}

.detail-hero-actions-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.copybtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-sans);
  max-width: 100%;
  overflow: hidden;
}

.copybtn:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--surface-3);
}

.copybtn .mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Launchers (Email, Teams) and the DN copy chip render as anchors and
   buttons with the same chip shape. */
.copybtn.launcher {
  text-decoration: none;
  color: var(--text);
  border-color: color-mix(in oklab, var(--accent) 30%, var(--border-strong));
  background: color-mix(in oklab, var(--accent) 8%, var(--surface-2));
}

.copybtn.launcher:hover {
  background: color-mix(in oklab, var(--accent) 15%, var(--surface-3));
}

/* The DN chip's text may grow (with ellipsis) so the operator can scan
   the OU path at a glance without expanding the chip. */
.hero-path {
  flex: 1 1 auto;
  min-width: 120px;
  max-width: 100%;
  justify-content: flex-start;
}

.hero-path .hero-path-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  flex: 1 1 auto;
}

/* The identifier line: text and a copy icon without button chrome, so it
   doesn't compete with the launcher row below. */
.copybtn-inline {
  height: auto;
  padding: 2px 0;
  margin-top: 2px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font-size: 12.5px;
}

.copybtn-inline:hover {
  background: transparent;
  color: var(--text);
  border-color: transparent;
}

.copybtn-inline .mono {
  font-size: 12.5px;
}

@media (max-width: 767.98px) {
  .detail-hero,
  .detail-hero.has-primary {
    grid-template-columns: 1fr;
    justify-items: start;
  }
}

/* Tab bar ---------------------------------------------------------------- */

/* The tablist wrapper doesn't take part in the tab bar's flex layout. */
.ds-tablist {
  display: contents;
}

.ds-tabs-with-actions {
  align-items: center;
}

.ds-tabs-spacer {
  flex: 1 1 auto;
}

.ds-tabs-actions {
  display: inline-flex;
  align-items: center;
  margin-left: 4px;
}

/* Destructive actions are tinted so their intent is obvious without
   reading the label twice. */
:deep(.p-menu .menu-item-danger .p-menuitem-link) {
  color: var(--red);
}

:deep(.p-menu .menu-item-danger .p-menuitem-icon) {
  color: var(--red);
}

.ds-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: var(--detail-sticky-offset, 40px);
  z-index: 5;
  background: var(--surface);
  /* Pinned under the compact hero, the shadow shows that page content
     scrolls beneath the merged hero + tab bar. */
  box-shadow: 0 10px 18px -10px rgba(0, 0, 0, 0.28);
  /* No transition on `top`: the offset follows the hero's height frame by
     frame during the shrink, and a transition would make the bar lag. */
}

/* The compact hero keeps its side borders; mirror them so hero and tab bar
   read as one bordered rectangle rather than the bar sticking out ~1px on
   each side. */
.ds-tabs.hero-compact {
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
}

.ds-tab {
  background: transparent;
  border: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  color: var(--text-3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  border-radius: 6px 6px 0 0;
  font-family: var(--font-sans);
}

.ds-tab > .pi {
  font-size: 14px;
  line-height: 1;
}

.ds-tab:hover {
  color: var(--text);
}

.ds-tab.active {
  color: var(--text);
}

.ds-tab.active::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}

.ds-tab-count {
  font-size: 11px;
  margin-left: 6px;
  color: var(--text-3);
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: 3px;
}

.ds-tab.active .ds-tab-count {
  color: var(--text-2);
}

/* useCompactTabs flips .compact when the bar would overflow: labels hide
   and each tab shrinks to its icon (and count); the title attribute keeps
   the label on hover. */
.ds-tabs.compact .ds-tab {
  padding: 9px 10px;
}

.ds-tabs.compact .ds-tab-label {
  display: none;
}

.ds-tabs.compact .ds-tab-count {
  margin-left: 4px;
}

.ds-tab.icon-only {
  padding: 9px 10px;
}
.ds-tab.icon-only .ds-tab-label {
  display: none;
}

/* useCompactTabs applies .measuring for a single frame to read the bar's
   natural width with labels shown and nothing shrunk. Icon-only tabs stay
   icon-only: the question is whether the labelled tabs would fit. */
.ds-tabs.measuring .ds-tabs-spacer {
  display: none;
}
.ds-tabs.measuring .ds-tab,
.ds-tabs.measuring .ds-tabs-refresh,
.ds-tabs.measuring .ds-tabs-actions {
  flex: none;
}
.ds-tabs.measuring .ds-tab-label {
  display: inline;
}
.ds-tabs.measuring .ds-tab.icon-only .ds-tab-label {
  display: none;
}

.freshness-foot {
  margin: 4px 0 0;
}
</style>
