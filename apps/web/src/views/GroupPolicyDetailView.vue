<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { api } from '../api/index.js';
import { ApiError } from '../api/client.js';
import type { GroupPolicyDetail } from '@openaduc/shared';
import Card from '../design/primitives/Card.vue';
import Avatar from '../design/primitives/Avatar.vue';
import { fmtRelative } from '../design/lib/format.js';
import { CSE_NAMES } from '../design/lib/gpoCseNames.js';
import { useStickyHeader } from './_detail/useStickyHeader';

const props = defineProps<{ id: string }>();
const router = useRouter();
const toast = useToast();

const policy = ref<GroupPolicyDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const r = await api.groupPolicies.get(props.id);
    policy.value = r.policy;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      error.value = 'Group policy not found';
    } else {
      error.value = err instanceof Error ? err.message : 'Failed to load group policy';
    }
  } finally {
    loading.value = false;
  }
}

watch(() => props.id, load);
onMounted(load);

const { setHero, compact } = useStickyHeader();

function cseLabel(guid: string): string {
  return CSE_NAMES[guid.toUpperCase()] ?? 'Unknown extension';
}

// Render the DN with leading CN= stripped (it's the GPO GUID and we
// surface that separately in the hero) — same pattern as the User /
// Group / Computer detail heros.
const dnPath = computed(() => {
  const dn = policy.value?.distinguishedName ?? '';
  if (!dn) return '';
  const m = /^CN=([^,]+),(.*)$/i.exec(dn);
  return m ? m[2]! : dn;
});

const copied = ref<{ guid: boolean; dn: boolean }>({ guid: false, dn: false });
async function copy(kind: 'guid' | 'dn'): Promise<void> {
  const p = policy.value;
  if (!p) return;
  const text = kind === 'guid' ? p.gpoGuid : p.distinguishedName;
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

// Sort raw attributes alphabetically and render values as JSON for the dump.
const rawEntries = computed<Array<[string, string]>>(() => {
  const p = policy.value;
  if (!p) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(p.rawAttributes)) {
    out.push([k, formatAttr(v)]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
});

function formatAttr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === 'string')) return v.join('\n');
    return JSON.stringify(v, null, 2);
  }
  return JSON.stringify(v, null, 2);
}
</script>

<template>
  <Toast />
  <div class="page-inner gpo-detail">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <template v-if="policy">
      <!-- Hero — mirrors User / Group / Computer detail heros: avatar
           with a GPO icon, name + scoped badges, identifier line, and a
           DN copy chip. The aside on the right keeps refresh/back. -->
      <section :ref="setHero" class="detail-hero" :class="{ 'is-compact': compact }">
        <Avatar
          :name="policy.displayName ?? policy.gpoGuid"
          :seed="policy.gpoGuid"
          :size="compact ? 26 : 64"
          shape="rounded"
          icon="pi-clipboard"
        />
        <div class="detail-hero-main">
          <div class="detail-hero-row">
            <h1 class="detail-hero-name">
              {{ policy.displayName ?? policy.gpoGuid }}
            </h1>
            <span
              class="badge"
              :class="policy.userPolicyEnabled ? 'badge-green' : 'badge-muted'"
              :title="policy.userPolicyEnabled ? 'user side enabled' : 'user side disabled'"
            >
              <i class="pi pi-user" /> user
            </span>
            <span
              class="badge"
              :class="policy.computerPolicyEnabled ? 'badge-green' : 'badge-muted'"
              :title="policy.computerPolicyEnabled ? 'computer side enabled' : 'computer side disabled'"
            >
              <i class="pi pi-desktop" /> computer
            </span>
          </div>

          <div v-if="policy.modifiedAtSource" class="detail-hero-title">
            modified {{ fmtRelative(policy.modifiedAtSource) }} · refreshed
            {{ fmtRelative(policy.fetchedAt) }}
          </div>

          <button
            type="button"
            class="copybtn copybtn-inline"
            :title="copied.guid ? 'Copied!' : 'Copy GPO GUID'"
            @click="copy('guid')"
          >
            <i :class="copied.guid ? 'pi pi-check' : 'pi pi-copy'" />
            <span class="mono">{{ policy.gpoGuid }}</span>
          </button>

          <div class="detail-hero-actions-row">
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
        <aside class="detail-hero-aside">
          <Button
            label="Back"
            icon="pi pi-arrow-left"
            text
            severity="secondary"
            size="small"
            @click="router.push({ name: 'group-policy' })"
          />
          <Button
            icon="pi pi-refresh"
            text
            severity="secondary"
            size="small"
            :loading="loading"
            title="Refresh"
            @click="load"
          />
        </aside>
      </section>

      <!-- Top-line facts. The directory layer can't tell us "what this GPO
           does" — only what AD knows about it. We surface every directory
           field that helps answer "is this active, where, and against what". -->
      <Card title="Overview">
        <div class="kv-grid">
          <div class="kv-row">
            <div class="kv-key">Display name</div>
            <div class="kv-val">{{ policy.displayName ?? '—' }}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">GPO GUID</div>
            <div class="kv-val mono" :title="policy.gpoGuid">{{ policy.gpoGuid }}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Object GUID</div>
            <div class="kv-val mono" :title="policy.id">{{ policy.id }}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Distinguished name</div>
            <div class="kv-val mono" :title="policy.distinguishedName">
              {{ policy.distinguishedName }}
            </div>
          </div>
          <div class="kv-row">
            <div class="kv-key">SYSVOL path</div>
            <div class="kv-val mono">{{ policy.fileSysPath ?? '—' }}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">WMI filter</div>
            <div class="kv-val mono">{{ policy.wmiFilterRef ?? '—' }}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Functionality version</div>
            <div class="kv-val mono">{{ policy.functionalityVersion ?? '—' }}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Version</div>
            <div class="kv-val mono">
              user {{ policy.userVersion ?? '—' }} · computer {{ policy.computerVersion ?? '—' }}
              <span v-if="policy.versionNumberRaw !== null" class="kv-aside"
                >(raw {{ policy.versionNumberRaw }})</span
              >
            </div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Sections</div>
            <div class="kv-val">
              <span class="badge" :class="policy.userPolicyEnabled ? 'badge-green' : 'badge-red'">
                user {{ policy.userPolicyEnabled ? 'enabled' : 'disabled' }}
              </span>
              <span
                class="badge"
                :class="policy.computerPolicyEnabled ? 'badge-green' : 'badge-red'"
              >
                computer {{ policy.computerPolicyEnabled ? 'enabled' : 'disabled' }}
              </span>
              <span v-if="policy.flagsRaw !== null" class="kv-aside mono"
                >flags={{ policy.flagsRaw }}</span
              >
            </div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Created</div>
            <div class="kv-val mono">{{ policy.createdAtSource ?? '—' }}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Modified</div>
            <div class="kv-val mono">{{ policy.modifiedAtSource ?? '—' }}</div>
          </div>
        </div>
      </Card>

      <!-- Where this GPO applies. Each scope row carries the link's flags
           (enforced / disabled) so the operator can see at a glance whether
           the link is doing anything. -->
      <Card :title="`Linked scopes (${policy.links.length})`">
        <div v-if="policy.links.length === 0" class="empty-block">
          This GPO is not linked anywhere — it has no effect on any account.
        </div>
        <table v-else class="link-table">
          <thead>
            <tr>
              <th>Scope DN</th>
              <th class="num">Order</th>
              <th>State</th>
              <th>Enforced</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in policy.links" :key="`${l.scopeDn}-${l.order}`">
              <td class="mono">{{ l.scopeDn }}</td>
              <td class="num mono">{{ l.order }}</td>
              <td>
                <span class="badge" :class="l.enabled ? 'badge-green' : 'badge-red'">
                  {{ l.enabled ? 'enabled' : 'disabled' }}
                </span>
              </td>
              <td>
                <span v-if="l.enforced" class="badge badge-amber">enforced</span>
                <span v-else class="cell-muted mono">no</span>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      <!-- Client-side extension GUIDs reveal which policy areas this GPO
           configures (Registry, Security, Folder Redirection, etc.) without
           reading SYSVOL. We label the well-known ones; the rest stay as
           raw GUIDs the operator can look up. -->
      <Card :title="`Configured areas — computer side (${policy.computerExtensionGuids.length})`">
        <div v-if="policy.computerExtensionGuids.length === 0" class="empty-block">
          No computer-side extensions configured.
        </div>
        <ul v-else class="cse-list">
          <li v-for="g in policy.computerExtensionGuids" :key="`c-${g}`">
            <span class="cse-name">{{ cseLabel(g) }}</span>
            <span class="cse-guid mono">{{ g }}</span>
          </li>
        </ul>
      </Card>

      <Card :title="`Configured areas — user side (${policy.userExtensionGuids.length})`">
        <div v-if="policy.userExtensionGuids.length === 0" class="empty-block">
          No user-side extensions configured.
        </div>
        <ul v-else class="cse-list">
          <li v-for="g in policy.userExtensionGuids" :key="`u-${g}`">
            <span class="cse-name">{{ cseLabel(g) }}</span>
            <span class="cse-guid mono">{{ g }}</span>
          </li>
        </ul>
      </Card>

      <!-- Audit / debugging dump: every populated attribute on the GPC entry
           that wasn't binary or in the project-wide skip list. Mirrors the
           Raw view used on user/group/computer detail. -->
      <Card title="Raw LDAP attributes">
        <table class="raw-table">
          <thead>
            <tr>
              <th>Attribute</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[k, v] in rawEntries" :key="k">
              <td class="raw-key mono">{{ k }}</td>
              <td class="raw-val mono">{{ v }}</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </template>
  </div>
</template>

<style scoped>
.gpo-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* Disable browser scroll anchoring inside the detail page — see the
     User detail page for rationale (compact-on-scroll flicker fix). */
  overflow-anchor: none;
}

/* Hero — same shape as User / Group / Computer detail heros so the
   four detail surfaces feel like a family. See UserDetailView for
   the layout rationale. */
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
  grid-template-columns: auto 1fr auto;
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

.detail-hero-title,
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
  text-decoration: none;
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

.detail-hero-aside {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  max-width: 280px;
  opacity: 1;
  transition:
    max-width 200ms ease,
    opacity 150ms ease;
}

.detail-hero.is-compact .detail-hero-aside {
  max-width: 0;
  opacity: 0;
  pointer-events: none;
}

@media (max-width: 767.98px) {
  .detail-hero {
    grid-template-columns: auto 1fr;
  }
  .detail-hero-aside {
    grid-column: 1 / -1;
    align-items: flex-start;
  }
}

.kv-grid {
  display: grid;
  gap: 6px;
}

.kv-row {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 12px;
  align-items: baseline;
  font-size: 13px;
}

.kv-key {
  color: var(--text-3);
  font-size: 12px;
}

.kv-val {
  color: var(--text);
  word-break: break-word;
}

.kv-val .badge + .badge {
  margin-left: 6px;
}

.kv-aside {
  color: var(--text-3);
  font-size: 11.5px;
  margin-left: 8px;
}

.mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.cell-muted {
  color: var(--text-3);
}

.empty-block {
  color: var(--text-3);
  font-size: 13px;
  padding: 4px 0;
}

.link-table,
.raw-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.link-table th,
.link-table td,
.raw-table th,
.raw-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.link-table th,
.raw-table th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-3);
  font-weight: 500;
}

.link-table .num,
.raw-table .num {
  text-align: right;
  width: 60px;
}

.raw-key {
  color: var(--text-2);
  width: 240px;
  white-space: nowrap;
}

.raw-val {
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

.cse-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.cse-list li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  align-items: baseline;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.cse-list li:last-child {
  border-bottom: none;
}

.cse-name {
  color: var(--text);
}

.cse-guid {
  color: var(--text-3);
  font-size: 11.5px;
}
</style>
