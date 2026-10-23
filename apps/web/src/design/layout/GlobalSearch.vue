<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter, type RouteLocationRaw } from 'vue-router';
import type { DirectoryOu } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { useAuthStore } from '../../stores/auth.js';
import { latestRequest } from '../lib/latestRequest.js';
import Avatar from '../primitives/Avatar.vue';

type Kind = 'user' | 'group' | 'computer' | 'ou';

interface ResultRow {
  kind: Kind;
  id: string;
  primary: string;
  secondary: string | null;
  to: RouteLocationRaw;
}

const PER_KIND = 6;

const router = useRouter();
const auth = useAuthStore();

const open = ref(false);
const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const resultsRef = ref<HTMLElement | null>(null);
const loading = ref(false);
const results = ref<ResultRow[]>([]);
const failed = ref<string[]>([]);
const highlight = ref(0);

// The RDNs of a DN, unescaped: "OU=Sales\, East,DC=corp" → ["OU=Sales, East", "DC=corp"].
function rdns(dn: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < dn.length; i++) {
    const ch = dn[i]!;
    if (ch === '\\' && i + 1 < dn.length) cur += dn[++i];
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Where an OU sits, for its result row: OU=Sales,OU=Corp,DC=corp,DC=example
// reads "corp.example / Corp".
function ouPath(ou: DirectoryOu): string {
  const parents = rdns(ou.distinguishedName).slice(1);
  const value = (rdn: string) => rdn.slice(rdn.indexOf('=') + 1);
  const ous = parents.filter((r) => /^OU=/i.test(r)).map(value);
  const domain = parents
    .filter((r) => /^DC=/i.test(r))
    .map(value)
    .join('.');
  return [domain, ...ous.reverse()].filter(Boolean).join(' / ');
}

// OUs have no search endpoint; the list is small enough to filter here.
// Fetched once per open of the search panel.
let ouList: Promise<DirectoryOu[]> | null = null;

async function searchOus(text: string): Promise<ResultRow[]> {
  ouList ??= api.ous.list().then((r) => r.ous);
  let all: DirectoryOu[];
  try {
    all = await ouList;
  } catch (err) {
    ouList = null;
    throw err;
  }
  const needle = text.trim().toLowerCase();
  return all
    .map((ou) => ({ ou, at: ou.name.toLowerCase().indexOf(needle) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.ou.name.localeCompare(b.ou.name))
    .slice(0, PER_KIND)
    .map<ResultRow>(({ ou }) => ({
      kind: 'ou',
      id: ou.distinguishedName,
      primary: ou.name,
      secondary: ouPath(ou) || null,
      to: { path: '/browse', query: { ou: ou.distinguishedName } },
    }));
}

// Display order of the result groups; arrow keys walk them in this order.
// The OU list sits behind read:user on the API, like the OU browser.
const KINDS: {
  kind: Kind;
  label: string;
  icon?: string;
  allowed: () => boolean;
  search: (text: string) => Promise<ResultRow[]>;
}[] = [
  {
    kind: 'user',
    label: 'Users',
    allowed: () => auth.hasCapability('read:user'),
    search: async (q) =>
      (await api.users.search({ q, pageSize: PER_KIND })).rows.map((u) => ({
        kind: 'user',
        id: u.id,
        primary: u.displayName ?? u.samAccountName,
        secondary: u.email ?? u.userPrincipalName ?? u.title ?? null,
        to: `/users/${u.id}`,
      })),
  },
  {
    kind: 'group',
    label: 'Groups',
    icon: 'pi-objects-column',
    allowed: () => auth.hasCapability('read:group'),
    search: async (q) =>
      (await api.groups.search({ q, pageSize: PER_KIND })).rows.map((g) => ({
        kind: 'group',
        id: g.id,
        primary: g.name ?? g.samAccountName ?? '(unnamed group)',
        secondary: g.description ?? `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`,
        to: `/groups/${g.id}`,
      })),
  },
  {
    kind: 'computer',
    label: 'Computers',
    icon: 'pi-desktop',
    allowed: () => auth.hasCapability('read:computer'),
    search: async (q) =>
      (await api.computers.search({ q, pageSize: PER_KIND })).rows.map((c) => ({
        kind: 'computer',
        id: c.id,
        primary: c.name ?? c.samAccountName ?? '(unnamed computer)',
        secondary: c.dnsHostName ?? c.operatingSystem ?? null,
        to: `/computers/${c.id}`,
      })),
  },
  {
    kind: 'ou',
    label: 'OUs',
    icon: 'pi-folder',
    allowed: () => auth.hasCapability('read:user'),
    search: searchOus,
  },
];

const searches = latestRequest();
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

async function runSearch(text: string): Promise<void> {
  const isCurrent = searches.begin();
  if (!text || text.trim().length < 2) {
    results.value = [];
    failed.value = [];
    loading.value = false;
    return;
  }
  loading.value = true;
  const kinds = KINDS.filter((k) => k.allowed());
  // One kind failing to load shouldn't hide the others.
  const settled = await Promise.allSettled(kinds.map((k) => k.search(text)));
  if (!isCurrent()) return;
  results.value = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  failed.value = kinds.filter((_, i) => settled[i]!.status === 'rejected').map((k) => k.label);
  highlight.value = 0;
  loading.value = false;
}

watch(query, (next) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void runSearch(next), 200);
});

function focusInput(): void {
  void nextTick(() => inputRef.value?.focus());
}

function openSearch(): void {
  open.value = true;
  focusInput();
}

function close(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  searches.begin(); // drop any search still in flight
  open.value = false;
  query.value = '';
  results.value = [];
  failed.value = [];
  loading.value = false;
  highlight.value = 0;
  ouList = null;
}

function pick(row: ResultRow): void {
  close();
  void router.push(row.to);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    close();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlight.value = Math.min(highlight.value + 1, results.value.length - 1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlight.value = Math.max(highlight.value - 1, 0);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const row = results.value[highlight.value];
    if (row) pick(row);
  }
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (open.value) close();
    else openSearch();
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));

const groupedResults = computed(() =>
  KINDS.map((k) => ({ ...k, rows: results.value.filter((r) => r.kind === k.kind) })).filter(
    (g) => g.rows.length > 0,
  ),
);

// Keep the keyboard highlight visible as it moves down a long list.
watch(highlight, () =>
  nextTick(() =>
    resultsRef.value?.querySelector('.gs-row.active')?.scrollIntoView?.({ block: 'nearest' }),
  ),
);

function isHighlighted(row: ResultRow): boolean {
  return results.value.indexOf(row) === highlight.value;
}
</script>

<template>
  <div class="gs-wrap">
    <button type="button" class="gs-trigger" :title="'Search (Ctrl+K)'" @click="openSearch">
      <i class="pi pi-search" />
      <span class="gs-trigger-label">Search the directory…</span>
      <span class="gs-trigger-kbd kbd">⌘K</span>
    </button>

    <Teleport to="body">
      <div v-if="open" class="gs-overlay" @click.self="close">
        <div class="gs-panel" role="dialog" aria-modal="true" aria-label="Global search">
          <div class="gs-input-row">
            <i class="pi pi-search gs-input-icon" />
            <input
              ref="inputRef"
              v-model="query"
              type="search"
              class="gs-input"
              placeholder="Search the directory…"
              autocomplete="off"
              spellcheck="false"
              @keydown="onKeydown"
            />
            <button type="button" class="gs-close" title="Close (Esc)" @click="close">
              <i class="pi pi-times" />
            </button>
          </div>

          <div ref="resultsRef" class="gs-results">
            <div v-if="failed.length > 0 && !loading" class="gs-failed" role="status">
              <i class="pi pi-exclamation-triangle" />
              Couldn't search {{ failed.join(' or ') }}.
            </div>
            <div v-if="loading && results.length === 0" class="gs-empty">Searching…</div>
            <div
              v-else-if="
                !loading && query.trim().length >= 2 && results.length === 0 && failed.length === 0
              "
              class="gs-empty"
            >
              No matches for "{{ query }}"
            </div>
            <div v-else-if="query.trim().length < 2" class="gs-empty">
              Type at least 2 characters to search.
            </div>

            <template v-else>
              <div v-for="g in groupedResults" :key="g.kind" class="gs-group">
                <div class="gs-group-label">{{ g.label }}</div>
                <button
                  v-for="row in g.rows"
                  :key="`${g.kind}-${row.id}`"
                  type="button"
                  class="gs-row"
                  :class="{ active: isHighlighted(row) }"
                  @mouseenter="highlight = results.indexOf(row)"
                  @click="pick(row)"
                >
                  <span v-if="g.icon" class="gs-row-icon"><i :class="['pi', g.icon]" /></span>
                  <Avatar v-else :name="row.primary" :seed="row.id" :size="28" />
                  <div class="gs-row-meta">
                    <div class="gs-row-primary">{{ row.primary }}</div>
                    <div v-if="row.secondary" class="gs-row-secondary">{{ row.secondary }}</div>
                  </div>
                  <i class="pi pi-arrow-right gs-row-go" />
                </button>
              </div>
            </template>
          </div>

          <footer class="gs-foot">
            <span><span class="kbd">↑↓</span> navigate</span>
            <span><span class="kbd">↵</span> open</span>
            <span><span class="kbd">esc</span> close</span>
          </footer>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.gs-wrap {
  flex: 1 1 120px;
  min-width: 0;
  display: flex;
  justify-content: flex-start;
}

.gs-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 480px;
  min-width: 0;
  padding: 6px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-3);
  font-size: 13px;
  cursor: pointer;
  font-family: var(--font-sans);
}

.gs-trigger:hover {
  border-color: var(--border-strong);
  color: var(--text-2);
}

.gs-trigger-label {
  flex: 1;
  min-width: 0;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-trigger-kbd {
  font-size: 10.5px;
  flex-shrink: 0;
}

.gs-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 80px 16px 16px;
  z-index: 1000;
}

.gs-panel {
  width: 100%;
  max-width: 640px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  max-height: min(560px, 80vh);
}

.gs-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.gs-input-icon {
  color: var(--text-3);
}

.gs-input {
  flex: 1;
  background: transparent;
  border: 0;
  outline: none;
  color: var(--text);
  font-size: 15px;
  font-family: var(--font-sans);
}

.gs-close {
  background: transparent;
  border: 0;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.gs-close:hover {
  background: var(--hover);
  color: var(--text);
}

.gs-results {
  overflow: auto;
  flex: 1;
}

.gs-failed {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 8px 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--surface-2);
  font-size: 12.5px;
  color: var(--text-2);
}

.gs-empty {
  padding: 24px;
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
}

.gs-group {
  padding: 8px 8px 12px;
}

.gs-group-label {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 8px 12px 6px;
}

.gs-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  color: var(--text);
}

.gs-row.active {
  background: var(--hover);
}

.gs-row-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  background: var(--surface-2);
  border-radius: 50%;
  color: var(--text-2);
}

.gs-row-meta {
  flex: 1;
  min-width: 0;
}

.gs-row-primary {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-row-secondary {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gs-row-go {
  color: var(--text-4);
  font-size: 11px;
}

.gs-row.active .gs-row-go {
  color: var(--accent-text);
}

.gs-foot {
  border-top: 1px solid var(--border);
  display: flex;
  gap: 14px;
  padding: 10px 16px;
  font-size: 11.5px;
  color: var(--text-3);
}

@media (max-width: 767.98px) {
  .gs-trigger {
    padding: 6px 8px;
  }

  .gs-trigger-kbd {
    display: none;
  }

  .gs-overlay {
    padding: 0;
  }

  .gs-panel {
    max-height: 100vh;
    border-radius: 0;
    height: 100vh;
  }
}
</style>
