<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { type LdapTlsMode, ldapTransportProblem, rebindRequiredReason } from '@openaduc/shared';
import LdapTlsModeField from '../../design/primitives/LdapTlsModeField.vue';
import { defaultLdapPort, ldapUrlFor } from '../../design/lib/ldap.js';

const TLS_MODE_LABEL: Record<LdapTlsMode, string> = {
  ldaps: 'LDAPS',
  starttls: 'StartTLS',
};
import { computed, onMounted, reactive, ref, watch } from 'vue';
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
import NamingPatternDialog from './NamingPatternDialog.vue';
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
  tlsMode: 'ldaps' as LdapTlsMode,
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
  () => addForm.tlsMode,
  (mode) => {
    if (addForm.port === 389 || addForm.port === 636) addForm.port = defaultLdapPort(mode);
  },
);

function addLdapUrl(host: string): string {
  return ldapUrlFor(host, addForm.tlsMode, addForm.port);
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
    tlsMode: 'ldaps',
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
  const addTransportProblem = ldapTransportProblem(cleanedUrls, addForm.tlsMode);
  if (addTransportProblem) {
    addError.value = addTransportProblem;
    return;
  }
  addSubmitting.value = true;
  try {
    const body: DirectoryAdminBody = {
      name: addForm.domain.trim(),
      domain: addForm.domain.trim(),
      baseDn: addForm.baseDn.trim(),
      ldapUrls: cleanedUrls,
      tlsMode: addForm.tlsMode,
      tlsRejectUnauthorized: addForm.rejectUntrusted,
      adminUsername: addForm.adminUsername.trim(),
      adminPassword: addForm.adminPassword,
    };
    await api.directories.create(body);
    toast.add({ severity: 'success', summary: 'Domain added', life: 3000 });
    addOpen.value = false;
    await load();
  } catch (err) {
    if (auth.retryAfterStepUp(err, submitAdd)) return;
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
  tlsMode: 'ldaps' as LdapTlsMode,
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
  const port = first?.port ?? defaultLdapPort(d.tlsMode);
  const dcs = (d.ldapUrls.length ? d.ldapUrls : ['']).map((u) => {
    const p = parseLdapUrl(u);
    return { host: p?.host ?? u };
  });

  Object.assign(editForm, {
    displayName: d.displayName ?? '',
    name: d.name,
    baseDn: d.baseDn,
    tlsMode: d.tlsMode,
    port,
    rejectUntrusted: d.tlsRejectUnauthorized ?? true,
    dcs: dcs.length ? dcs : [{ host: '' }],
    syncBindUsername: bareUsernameFromUpn(d.syncBindUpn, d.domain),
    syncBindPassword: '',
  });
  editOpen.value = true;
}

watch(
  () => editForm.tlsMode,
  (mode) => {
    if (editForm.port === 389 || editForm.port === 636) editForm.port = defaultLdapPort(mode);
  },
);

// Changing where or how the domain is reached needs the service-account
// password re-entered: the API binds with it before saving.
// Why the stored service-account password can't be reused for this edit
// (null when it can); the API applies the same rule.
const editRebindReason = computed(() => {
  const before = editTarget.value;
  if (!before) return null;
  return rebindRequiredReason(
    {
      ldapUrls: before.ldapUrls,
      tlsMode: before.tlsMode,
      tlsRejectUnauthorized: before.tlsRejectUnauthorized ?? true,
      syncBindUpn: before.syncBindUpn,
    },
    {
      ldapUrls: editForm.dcs.map((d) => editLdapUrl(d.host)).filter(Boolean),
      tlsMode: editForm.tlsMode,
      tlsRejectUnauthorized: editForm.rejectUntrusted,
      syncBindUpn: composeSyncUpn(editForm.syncBindUsername, before.domain) || null,
    },
  );
});

function editLdapUrl(host: string): string {
  return ldapUrlFor(host, editForm.tlsMode, editForm.port);
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
  const editTransportProblem = ldapTransportProblem(cleanedUrls, editForm.tlsMode);
  if (editTransportProblem) {
    editError.value = editTransportProblem;
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
  if (editForm.tlsMode !== before.tlsMode) {
    patch.tlsMode = editForm.tlsMode;
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

  if (editRebindReason.value && !editForm.syncBindPassword) {
    editError.value = editRebindReason.value;
    return;
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
    if (auth.retryAfterStepUp(err, submitEdit)) return;
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
    if (auth.retryAfterStepUp(err, runSyncBindTest)) return;
    testResult.value = {
      ok: false,
      message: err instanceof ApiError ? err.message : 'Test failed',
    };
  } finally {
    testRunning.value = false;
  }
}

// ---- Naming pattern ----
// Edited for the directory the operator is signed in to: its UPN suffixes
// are read with that directory's service account.
const namingTarget = ref<number | null>(null);
const namingOpen = ref(false);

function openNamingDialog(id: number): void {
  namingTarget.value = id;
  namingOpen.value = true;
}

async function onNamingSaved(): Promise<void> {
  toast.add({ severity: 'success', summary: 'Naming pattern saved', life: 3000 });
  await load();
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
          {{ TLS_MODE_LABEL[d.tlsMode] }} ·
          {{
            d.tlsRejectUnauthorized === false ? 'reject untrusted = off' : 'reject untrusted = on'
          }}
        </dd>
        <template v-if="d.certificateCheckOff">
          <dt class="fld-label">Needs attention</dt>
          <dd class="needs-attention" role="alert">
            Certificate checks are off, so anyone on the network path could impersonate this domain
            controller and collect every password sent to it. Give OpenADUC the CA that issued its
            certificate (AD_TLS_CA_PATH) and turn “Reject untrusted TLS certificates” back on.
          </dd>
        </template>
        <template v-if="d.transportProblem">
          <dt class="fld-label">Needs attention</dt>
          <dd class="needs-attention" role="alert">
            {{ d.transportProblem }} Edit the domain controllers to fix it.
          </dd>
        </template>
        <dt class="fld-label">Naming pattern</dt>
        <dd class="naming-row">
          <span class="mono">{{ d.naming.pattern }} · @{{ d.naming.upnSuffix }}</span>
          <Button
            v-if="canEdit && d.id === auth.actor?.directoryId"
            label="Change"
            size="small"
            text
            :aria-label="`Change the naming pattern for ${d.displayName ?? d.domain}`"
            @click="openNamingDialog(d.id)"
          />
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
        <LdapTlsModeField v-model="addForm.tlsMode" class="tls-toggle" />
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
          <label for="dir-add-admin-password" class="fld-label">Admin password</label>
          <Password
            v-model="addForm.adminPassword"
            input-id="dir-add-admin-password"
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
        <LdapTlsModeField v-model="editForm.tlsMode" class="tls-toggle" />
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
          <label for="dir-edit-sync-password" class="fld-label">Service account password</label>
          <Password
            v-model="editForm.syncBindPassword"
            input-id="dir-edit-sync-password"
            :feedback="false"
            toggle-mask
            input-class="w-full"
            class="w-full"
            :placeholder="
              editRebindReason
                ? 'Required for this change'
                : editTarget?.hasSyncBindPassword
                  ? 'Leave blank to keep stored password'
                  : ''
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

  <NamingPatternDialog
    v-if="namingOpen && namingTarget !== null"
    v-model:visible="namingOpen"
    :directory-id="namingTarget"
    @saved="onNamingSaved"
  />
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

.naming-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

/* Inline with the value, so the row keeps the others' height. */
.naming-row :deep(.p-button) {
  padding-block: 0;
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
  align-items: flex-start;
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
.needs-attention {
  color: var(--red);
  font-size: 13px;
}
</style>
