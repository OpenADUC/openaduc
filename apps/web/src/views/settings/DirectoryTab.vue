<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import InputNumber from 'primevue/inputnumber';
import Password from 'primevue/password';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import {
  api,
  type DirectoryAdminBody,
  type DirectoryPatch,
  type DirectorySummary,
} from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import Card from '../../design/primitives/Card.vue';
import EmptyState from '../../design/primitives/EmptyState.vue';
import StepUpDialog from '../../design/feedback/StepUpDialog.vue';
import { fmtRelative } from '../../design/lib/format.js';

const route = useRoute();
const router = useRouter();

const auth = useAuthStore();
const toast = useToast();

const directories = ref<DirectorySummary[]>([]);
const loading = ref(true);

const canEdit = auth.hasCapability('configure:directory');

// ---- Add-domain dialog ----
const addOpen = ref(false);
const addStepUpOpen = ref(false);
const addError = ref<string | null>(null);
const addSubmitting = ref(false);
const addForm = reactive({
  domain: '',
  baseDn: '',
  baseDnTouched: false,
  useTls: true,
  port: 636,
  rejectUntrusted: true,
  dcs: [{ host: '' }] as { host: string }[],
  adminUsername: '',
  adminPassword: '',
});

watch(
  () => addForm.domain,
  (next) => {
    if (addForm.baseDnTouched) return;
    const trimmed = next.trim();
    addForm.baseDn = trimmed
      ? trimmed
          .split('.')
          .filter(Boolean)
          .map((part) => `DC=${part}`)
          .join(',')
      : '';
  },
);

watch(
  () => addForm.useTls,
  (useTls) => {
    if (addForm.port === 389 || addForm.port === 636) {
      addForm.port = useTls ? 636 : 389;
    }
  },
);

function addLdapUrl(host: string): string {
  const h = host.trim();
  if (!h) return '';
  if (/^ldaps?:\/\//i.test(h)) return h;
  return `${addForm.useTls ? 'ldaps' : 'ldap'}://${h}:${addForm.port}`;
}

function addAddDc(): void {
  if (addForm.dcs.length < 10) addForm.dcs.push({ host: '' });
}
function addRemoveDc(idx: number): void {
  addForm.dcs.splice(idx, 1);
  if (addForm.dcs.length === 0) addForm.dcs.push({ host: '' });
}

function openAddDialog(): void {
  Object.assign(addForm, {
    domain: '',
    baseDn: '',
    baseDnTouched: false,
    useTls: true,
    port: 636,
    rejectUntrusted: true,
    dcs: [{ host: '' }],
    adminUsername: '',
    adminPassword: '',
  });
  addError.value = null;
  addOpen.value = true;
}

function startAdd(): void {
  if (!auth.elevated) {
    addStepUpOpen.value = true;
  } else {
    void submitAdd();
  }
}

async function submitAdd(): Promise<void> {
  if (addSubmitting.value) return;
  addError.value = null;
  if (!addForm.domain.trim() || !addForm.baseDn.trim()) {
    addError.value = 'Domain and base DN are required';
    return;
  }
  if (!addForm.adminUsername.trim() || !addForm.adminPassword) {
    addError.value = 'Admin credentials are required';
    return;
  }
  const cleanedUrls = addForm.dcs.map((d) => addLdapUrl(d.host)).filter(Boolean);
  if (cleanedUrls.length === 0) {
    addError.value = 'At least one DC is required';
    return;
  }
  addSubmitting.value = true;
  try {
    const body: DirectoryAdminBody = {
      name: addForm.domain.trim(),
      domain: addForm.domain.trim(),
      baseDn: addForm.baseDn.trim(),
      ldapUrls: cleanedUrls,
      tlsMode: addForm.useTls ? 'ldaps' : 'plain',
      tlsRejectUnauthorized: addForm.rejectUntrusted,
      adminUsername: addForm.adminUsername.trim(),
      adminPassword: addForm.adminPassword,
    };
    await api.directories.create(body);
    toast.add({ severity: 'success', summary: 'Domain added', life: 3000 });
    addOpen.value = false;
    await load();
  } catch (err) {
    addError.value = err instanceof ApiError ? err.message : 'Add failed';
  } finally {
    addSubmitting.value = false;
  }
}

// ---- Edit dialog ----
const editOpen = ref(false);
const editStepUpOpen = ref(false);
const editError = ref<string | null>(null);
const editSubmitting = ref(false);
const editTarget = ref<DirectorySummary | null>(null);

const editForm = reactive({
  displayName: '',
  name: '',
  baseDn: '',
  useTls: true,
  port: 636,
  rejectUntrusted: true,
  dcs: [] as { host: string }[],
  // Bare username; we attach `@<domain>` before sending unless the operator
  // typed a full UPN (cross-domain SAs are rare but supported).
  syncBindUsername: '',
  // Empty = leave the stored password alone (or there is no password yet).
  // Any value = replace.
  syncBindPassword: '',
});

/**
 * Compose the SA UPN we'll send to the server. If the operator typed a
 * full UPN (anything containing `@`), we honor it as-is — that lets a
 * cross-domain SA work. Otherwise attach `@<directory.domain>`. A
 * `DOMAIN\user` form is normalized to `user@<domain>` because the
 * Win-style prefix doesn't survive an LDAPS bind anyway.
 */
function composeSyncUpn(input: string, domain: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed;
  const bs = trimmed.indexOf('\\');
  const bare = bs >= 0 ? trimmed.slice(bs + 1).trim() : trimmed;
  return bare ? `${bare}@${domain}` : '';
}

/**
 * Inverse of composeSyncUpn: pull the bare username out of a stored UPN
 * for the form's prefilled value. If the stored UPN is in a different
 * domain than this directory, we keep the full UPN so the operator can
 * see (and re-save) the cross-domain value verbatim.
 */
function bareUsernameFromUpn(upn: string | null, directoryDomain: string): string {
  if (!upn) return '';
  const at = upn.indexOf('@');
  if (at < 0) return upn;
  const domain = upn.slice(at + 1).toLowerCase();
  return domain === directoryDomain.toLowerCase() ? upn.slice(0, at) : upn;
}

function parseLdapUrl(u: string): { scheme: 'ldap' | 'ldaps'; host: string; port: number } | null {
  const m = /^(ldaps?):\/\/([^/:]+)(?::(\d+))?$/i.exec(u.trim());
  if (!m) return null;
  const scheme = (m[1] ?? 'ldaps').toLowerCase() as 'ldap' | 'ldaps';
  const port = m[3] ? Number(m[3]) : scheme === 'ldaps' ? 636 : 389;
  return { scheme, host: m[2] ?? '', port };
}

function openEditDialog(d: DirectorySummary): void {
  editTarget.value = d;
  editError.value = null;
  testResult.value = null;

  // Reverse-engineer scheme/port/host from the first existing URL so the
  // bare-hostname form can round-trip cleanly. Mixed schemes get flattened
  // — rare, and editing through this UI normalizes them.
  const first = d.ldapUrls[0] ? parseLdapUrl(d.ldapUrls[0]) : null;
  const useTls = first ? first.scheme === 'ldaps' : d.tlsMode !== 'plain';
  const port = first?.port ?? (useTls ? 636 : 389);
  const dcs = (d.ldapUrls.length ? d.ldapUrls : ['']).map((u) => {
    const p = parseLdapUrl(u);
    return { host: p?.host ?? u };
  });

  Object.assign(editForm, {
    displayName: d.displayName ?? '',
    name: d.name,
    baseDn: d.baseDn,
    useTls,
    port,
    rejectUntrusted: d.tlsRejectUnauthorized ?? true,
    dcs: dcs.length ? dcs : [{ host: '' }],
    syncBindUsername: bareUsernameFromUpn(d.syncBindUpn, d.domain),
    syncBindPassword: '',
  });
  editOpen.value = true;
}

watch(
  () => editForm.useTls,
  (useTls) => {
    if (editForm.port === 389 || editForm.port === 636) {
      editForm.port = useTls ? 636 : 389;
    }
  },
);

function editLdapUrl(host: string): string {
  const h = host.trim();
  if (!h) return '';
  if (/^ldaps?:\/\//i.test(h)) return h;
  return `${editForm.useTls ? 'ldaps' : 'ldap'}://${h}:${editForm.port}`;
}

function editAddDc(): void {
  if (editForm.dcs.length < 10) editForm.dcs.push({ host: '' });
}
function editRemoveDc(idx: number): void {
  editForm.dcs.splice(idx, 1);
  if (editForm.dcs.length === 0) editForm.dcs.push({ host: '' });
}

function startSave(): void {
  if (!auth.elevated) {
    editStepUpOpen.value = true;
  } else {
    void submitEdit();
  }
}

async function submitEdit(): Promise<void> {
  if (editSubmitting.value || !editTarget.value) return;
  editError.value = null;
  const before = editTarget.value;
  const cleanedUrls = editForm.dcs.map((d) => editLdapUrl(d.host)).filter(Boolean);
  if (cleanedUrls.length === 0) {
    editError.value = 'At least one DC is required';
    return;
  }

  const patch: DirectoryPatch = {};
  if (editForm.name.trim() && editForm.name.trim() !== before.name) {
    patch.name = editForm.name.trim();
  }
  const trimmedDisplay = editForm.displayName.trim() || null;
  if (trimmedDisplay !== (before.displayName ?? null)) {
    patch.displayName = trimmedDisplay;
  }
  if (editForm.baseDn.trim() && editForm.baseDn.trim() !== before.baseDn) {
    patch.baseDn = editForm.baseDn.trim();
  }
  if (JSON.stringify(cleanedUrls) !== JSON.stringify(before.ldapUrls)) {
    patch.ldapUrls = cleanedUrls;
  }
  const desiredTlsMode: 'ldaps' | 'plain' = editForm.useTls ? 'ldaps' : 'plain';
  if (desiredTlsMode !== before.tlsMode) {
    patch.tlsMode = desiredTlsMode;
  }
  if (editForm.rejectUntrusted !== (before.tlsRejectUnauthorized ?? true)) {
    patch.tlsRejectUnauthorized = editForm.rejectUntrusted;
  }
  // Sync. Compose the full UPN (attaching @<domain> for bare usernames),
  // then only include in the patch if it actually changed from what's stored.
  const composedSaUpn = composeSyncUpn(editForm.syncBindUsername, before.domain) || null;
  if (composedSaUpn !== (before.syncBindUpn ?? null)) {
    patch.syncBindUpn = composedSaUpn;
  }
  // Empty = keep stored password; non-empty = replace.
  if (editForm.syncBindPassword) {
    patch.syncBindPassword = editForm.syncBindPassword;
  }

  if (Object.keys(patch).length === 0) {
    toast.add({ severity: 'info', summary: 'Nothing to save', life: 2500 });
    editOpen.value = false;
    return;
  }
  editSubmitting.value = true;
  try {
    await api.directories.update(before.id, patch);
    toast.add({ severity: 'success', summary: 'Directory saved', life: 3000 });
    editOpen.value = false;
    await load();
  } catch (err) {
    editError.value = err instanceof ApiError ? err.message : 'Save failed';
  } finally {
    editSubmitting.value = false;
  }
}

// ---- Test sync bind ----
// Probe the SA creds the operator currently has on screen. Reuses the
// directory's TLS / base DN / DC list from the stored row, so we don't
// require a save first.
const testRunning = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

async function runSyncBindTest(): Promise<void> {
  if (!editTarget.value) return;
  testResult.value = null;
  const upn = composeSyncUpn(editForm.syncBindUsername, editTarget.value.domain);
  if (!upn) {
    testResult.value = { ok: false, message: 'Enter a service account username first' };
    return;
  }
  // Use the typed password when the operator entered one; otherwise probe
  // against the stored password (lets you verify "is what I saved still
  // working?" without re-typing).
  const body: { syncBindUpn: string; syncBindPassword?: string } = { syncBindUpn: upn };
  if (editForm.syncBindPassword) {
    body.syncBindPassword = editForm.syncBindPassword;
  } else if (!editTarget.value.hasSyncBindPassword) {
    testResult.value = { ok: false, message: 'Enter the service account password' };
    return;
  }
  testRunning.value = true;
  try {
    const r = await api.directories.testSyncBind(editTarget.value.id, body);
    testResult.value = { ok: r.ok, message: r.message };
  } catch (err) {
    testResult.value = {
      ok: false,
      message: err instanceof ApiError ? err.message : 'Test failed',
    };
  } finally {
    testRunning.value = false;
  }
}

// ---- Load directories ----
async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await api.directories.list();
    directories.value = r.directories;
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not load directories',
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  } finally {
    loading.value = false;
  }
  // Honor `?edit=<id>` once per visit so the post-setup redirect can drop
  // the operator straight into the edit dialog. Strip the param afterwards
  // so a refresh doesn't keep popping the dialog.
  const editParam = route.query.edit;
  if (typeof editParam === 'string' && editParam) {
    const target = directories.value.find((d) => String(d.id) === editParam);
    if (target) {
      openEditDialog(target);
      const nextQuery = { ...route.query };
      delete nextQuery.edit;
      void router.replace({ path: route.path, query: nextQuery });
    }
  }
}

onMounted(load);
</script>

<template>
  <Toast />
  <div class="dir-toolbar">
    <Button
      v-if="canEdit"
      label="Add domain"
      icon="pi pi-plus"
      size="small"
      @click="openAddDialog"
    />
  </div>

  <Card v-if="loading" title="Directories">
    <p class="hint" style="margin: 0">Loading…</p>
  </Card>

  <EmptyState
    v-else-if="directories.length === 0"
    icon="pi pi-server"
    title="No directories configured"
    message="Run setup to connect your first directory."
  />

  <template v-else>
    <Card
      v-for="d in directories"
      :key="d.id"
      :title="d.displayName ?? d.domain"
      :sub="`${d.type} · ${d.domain} · updated ${fmtRelative(d.updatedAt)}`"
    >
      <template #actions>
        <span v-if="d.configured" class="badge badge-green"
          ><span class="badge-dot" /> configured</span
        >
        <Button
          v-if="canEdit"
          label="Edit"
          icon="pi pi-pencil"
          severity="secondary"
          outlined
          size="small"
          @click="openEditDialog(d)"
        />
      </template>

      <dl class="dir-grid">
        <dt class="fld-label">Domain</dt>
        <dd class="mono">{{ d.domain }}</dd>
        <dt class="fld-label">Base DN</dt>
        <dd class="mono">{{ d.baseDn }}</dd>
        <dt class="fld-label">TLS</dt>
        <dd class="mono">
          {{ d.tlsMode }} ·
          {{
            d.tlsRejectUnauthorized === false ? 'reject untrusted = off' : 'reject untrusted = on'
          }}
        </dd>
        <dt class="fld-label">Domain controllers</dt>
        <dd>
          <ul class="dc-list">
            <li v-for="u in d.ldapUrls" :key="u" class="mono">{{ u }}</li>
          </ul>
        </dd>
      </dl>

      <!-- No SA configured: nudge the operator to finish setup. Sync schedules
           themselves live on the Tasks & Scheduler page. -->
      <Message
        v-if="!d.syncBindUpn || !d.hasSyncBindPassword"
        severity="info"
        :closable="false"
        class="needs-sa"
      >
        Background sync requires a service account. Click <strong>Edit</strong> above to add one and
        finish setup.
      </Message>
    </Card>
  </template>

  <!-- Add-domain dialog (unchanged from before) -->
  <Dialog
    v-model:visible="addOpen"
    modal
    :closable="!addSubmitting"
    header="Add a domain"
    :style="{ width: 'min(560px, 95vw)' }"
  >
    <form class="form-stack" @submit.prevent="startAdd">
      <div class="form-row">
        <label class="fld-label">Domain</label>
        <InputText v-model="addForm.domain" placeholder="other.example.com" class="w-full" />
      </div>
      <div class="form-row">
        <label class="fld-label">Base DN</label>
        <InputText
          v-model="addForm.baseDn"
          placeholder="DC=other,DC=example,DC=com"
          class="w-full"
          @input="addForm.baseDnTouched = true"
        />
      </div>
      <div class="tls-row">
        <label class="check-row tls-toggle">
          <input v-model="addForm.useTls" type="checkbox" />
          <span><strong>Use TLS (LDAPS)</strong></span>
        </label>
        <div class="port-field">
          <span class="fld-label">Port</span>
          <InputNumber
            v-model="addForm.port"
            :use-grouping="false"
            :min="1"
            :max="65535"
            input-class="port-input"
          />
        </div>
      </div>
      <label class="check-row">
        <input v-model="addForm.rejectUntrusted" type="checkbox" />
        <span>Reject untrusted TLS certificates</span>
      </label>
      <div class="form-row">
        <label class="fld-label">Domain controllers</label>
        <div v-for="(_, idx) in addForm.dcs" :key="idx" class="url-row">
          <InputText
            v-model="addForm.dcs[idx]!.host"
            class="flex-1"
            :placeholder="`dc${idx + 1}.${addForm.domain || 'other.example.com'}`"
          />
          <Button
            v-if="addForm.dcs.length > 1"
            icon="pi pi-times"
            severity="secondary"
            text
            type="button"
            @click="addRemoveDc(idx)"
          />
        </div>
        <Button
          label="Add another DC"
          icon="pi pi-plus"
          text
          size="small"
          type="button"
          @click="addAddDc"
        />
      </div>
      <div class="form-grid-2">
        <div class="form-row">
          <label class="fld-label">Admin username</label>
          <InputText v-model="addForm.adminUsername" class="w-full" placeholder="administrator" />
          <p class="hint" style="margin: 4px 0 0">
            Just the username — we'll attach
            <span class="mono">@{{ addForm.domain || 'domain' }}</span
            >.
          </p>
        </div>
        <div class="form-row">
          <label class="fld-label">Admin password</label>
          <Password
            v-model="addForm.adminPassword"
            :feedback="false"
            toggle-mask
            input-class="w-full"
            class="w-full"
          />
        </div>
      </div>
      <Message v-if="addError" severity="error" :closable="false">{{ addError }}</Message>
    </form>
    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        text
        :disabled="addSubmitting"
        @click="addOpen = false"
      />
      <Button label="Test &amp; add" :loading="addSubmitting" @click="startAdd" />
    </template>
  </Dialog>

  <StepUpDialog v-model:visible="addStepUpOpen" @ok="submitAdd" />

  <!-- Edit dialog -->
  <Dialog
    v-model:visible="editOpen"
    modal
    :closable="!editSubmitting"
    :focus-on-show="false"
    :header="`Edit ${editTarget?.domain ?? 'directory'}`"
    :style="{ width: 'min(640px, 95vw)' }"
  >
    <form class="form-stack" @submit.prevent="startSave">
      <div class="form-grid-2">
        <div class="form-row">
          <label class="fld-label">Display name</label>
          <InputText
            v-model="editForm.displayName"
            class="w-full"
            placeholder="optional"
            autofocus
          />
        </div>
        <div class="form-row">
          <label class="fld-label">Internal name</label>
          <InputText v-model="editForm.name" class="w-full" />
        </div>
      </div>
      <div class="form-row">
        <label class="fld-label">Base DN</label>
        <InputText v-model="editForm.baseDn" class="w-full" />
      </div>
      <div class="tls-row">
        <label class="check-row tls-toggle">
          <input v-model="editForm.useTls" type="checkbox" />
          <span><strong>Use TLS (LDAPS)</strong></span>
        </label>
        <div class="port-field">
          <span class="fld-label">Port</span>
          <InputNumber
            v-model="editForm.port"
            :use-grouping="false"
            :min="1"
            :max="65535"
            input-class="port-input"
          />
        </div>
      </div>
      <label class="check-row">
        <input v-model="editForm.rejectUntrusted" type="checkbox" />
        <span>Reject untrusted TLS certificates</span>
      </label>
      <div class="form-row">
        <label class="fld-label">Domain controllers</label>
        <div v-for="(_, idx) in editForm.dcs" :key="idx" class="url-row">
          <InputText
            v-model="editForm.dcs[idx]!.host"
            class="flex-1"
            :placeholder="`dc${idx + 1}.${editTarget?.domain || 'domain'}`"
          />
          <Button
            v-if="editForm.dcs.length > 1"
            icon="pi pi-times"
            severity="secondary"
            text
            type="button"
            @click="editRemoveDc(idx)"
          />
        </div>
        <Button
          label="Add another DC"
          icon="pi pi-plus"
          text
          size="small"
          type="button"
          @click="editAddDc"
        />
      </div>

      <hr class="divider" />

      <h4 class="section-title">Background sync</h4>

      <div class="form-grid-2">
        <div class="form-row">
          <label class="fld-label">Service account username</label>
          <InputText v-model="editForm.syncBindUsername" class="w-full" placeholder="sync-svc" />
        </div>
        <div class="form-row">
          <label class="fld-label">Service account password</label>
          <Password
            v-model="editForm.syncBindPassword"
            :feedback="false"
            toggle-mask
            input-class="w-full"
            class="w-full"
            :placeholder="
              editTarget?.hasSyncBindPassword ? 'Leave blank to keep stored password' : ''
            "
          />
        </div>
      </div>

      <div class="sa-test-row">
        <Button
          label="Test bind"
          icon="pi pi-bolt"
          severity="secondary"
          outlined
          size="small"
          type="button"
          :loading="testRunning"
          @click="runSyncBindTest"
        />
      </div>
      <Message
        v-if="testResult"
        :severity="testResult.ok ? 'success' : 'error'"
        :closable="false"
        >{{ testResult.message }}</Message
      >

      <p class="hint">Sync cadence is configured per task in the table on the directory card.</p>

      <Message v-if="editError" severity="error" :closable="false">{{ editError }}</Message>
    </form>
    <template #footer>
      <Button
        label="Cancel"
        severity="secondary"
        text
        :disabled="editSubmitting"
        @click="editOpen = false"
      />
      <Button label="Save changes" :loading="editSubmitting" @click="startSave" />
    </template>
  </Dialog>

  <StepUpDialog v-model:visible="editStepUpOpen" @ok="submitEdit" />
</template>

<style scoped>
.dir-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.dir-grid {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 8px 14px;
  margin: 0;
  font-size: 13px;
}

.dir-grid dt {
  color: var(--text-3);
}
.dir-grid dd {
  margin: 0;
  color: var(--text);
}

.dc-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dc-list li {
  color: var(--text-2);
}

.sa-test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.divider {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 6px 0;
}

.section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.form-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

@media (max-width: 760px) {
  .form-grid-2 {
    grid-template-columns: 1fr;
  }
}

.tls-row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.tls-toggle {
  flex: 1 1 auto;
}

.port-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

:deep(.port-input) {
  width: 80px;
  text-align: center;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
}

.url-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.flex-1 {
  flex: 1;
}
.w-full {
  width: 100%;
}

:deep(.p-password) {
  display: block;
  width: 100%;
}

:deep(.p-password .p-password-input) {
  width: 100%;
}
</style>
