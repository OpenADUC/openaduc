<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Checkbox from 'primevue/checkbox';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import {
  api,
  type DirectorySummary,
  type EntraFeatureKey,
  type EntraIntegrationPut,
  type EntraIntegrationSummary,
} from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import Card from '../../design/primitives/Card.vue';
import EmptyState from '../../design/primitives/EmptyState.vue';
import StepUpDialog from '../../design/feedback/StepUpDialog.vue';
import { fmtRelative } from '../../design/lib/format.js';

// Settings → Entra ID tab. Configures the Microsoft Entra (Graph)
// integration on a per-directory basis.
//
// The form for each directory is opened in a modal dialog rather than
// inline cards: the field set is non-trivial (tenant ID, client ID,
// secret rotation, four feature toggles, webhook URL, permissions help)
// and the modal keeps the parent list compact.

const auth = useAuthStore();
const toast = useToast();

const canConfigure = auth.hasCapability('configure:directory');

interface DirectoryEntra {
  directory: DirectorySummary;
  integration: EntraIntegrationSummary | null;
}

const rows = ref<DirectoryEntra[]>([]);
const loading = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await api.directories.list();
    const dirs = r.directories.filter((d) => d.configured);
    // Pull each directory's Entra integration in parallel — the API
    // returns null on directories that have nothing configured yet.
    const integrations = await Promise.all(
      dirs.map((d) => api.directories.entra.get(d.id).then((res) => res.integration)),
    );
    rows.value = dirs.map((d, i) => ({ directory: d, integration: integrations[i] ?? null }));
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Could not load integrations',
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// ---- Edit dialog ------------------------------------------------------

const editOpen = ref(false);
const editStepUpOpen = ref(false);
const editError = ref<string | null>(null);
const editSubmitting = ref(false);
const editTarget = ref<DirectoryEntra | null>(null);
const editTestResult = ref<{ ok: boolean; message: string } | null>(null);
const editTestRunning = ref(false);

interface FeatureRow {
  key: EntraFeatureKey;
  label: string;
  description: string;
  /** Permission needed in Entra, surfaced in the help block when toggled on. */
  permissionNote?: string;
}

const FEATURES: FeatureRow[] = [
  {
    key: 'photos',
    label: 'User photos',
    description:
      'Lazy-fetch a user’s photo from Graph and cache it in the database. Renders on the user detail page (search-list avatars stay as initials in this release).',
    permissionNote: 'User.Read.All (Application)',
  },
  {
    key: 'signInActivity',
    label: 'Sign-in activity (last seen)',
    description:
      'Show last interactive and non-interactive sign-in timestamps on the user detail Account card. Lightweight; pulls a single field per user.',
    permissionNote: 'AuditLog.Read.All (Application) — requires Entra ID P1 license',
  },
  {
    key: 'signInEvents',
    label: 'Sign-in events (full history)',
    description:
      'Delta-sync the per-event sign-in log into the local database every 15 minutes. Powers the user-detail Sign-ins tab and the Audit page Sign-ins tab with rich filtering, date ranges, and per-event detail.',
    permissionNote: 'AuditLog.Read.All (Application) — requires Entra ID P1 license',
  },
  {
    key: 'mfaRegistration',
    label: 'MFA registration',
    description:
      'Show whether each user has registered MFA, which methods, and the default method. Pulled weekly from /reports/authenticationMethods.',
    permissionNote: 'AuditLog.Read.All (Application)',
  },
  {
    key: 'teamsAdminWebhook',
    label: 'Teams admin notifications',
    description:
      'Post sync-failure and password-expiry alerts to a Teams channel via incoming webhook (no Graph permissions needed).',
  },
  {
    key: 'passwordExpiryNotifications',
    label: 'Password-expiry alerts',
    description:
      'Daily scan for accounts whose password expires in 3, 7, or 14 days. Sends an Adaptive Card to the admin Teams channel.',
  },
];

const editForm = reactive({
  tenantId: '',
  clientId: '',
  // Empty = leave existing secret untouched. Any value = replace.
  clientSecret: '',
  enabled: true,
  features: {
    photos: false,
    signInActivity: false,
    signInEvents: false,
    mfaRegistration: false,
    teamsAdminWebhook: false,
    passwordExpiryNotifications: false,
  } as Record<EntraFeatureKey, boolean>,
  // Empty = no change. Use the explicit "Clear" button to remove an existing one.
  teamsWebhookUrl: '',
  // True when operator clicked Clear; sends teamsWebhookUrl='' on save to
  // distinguish "not changed" from "delete the stored URL".
  teamsWebhookUrlClear: false,
});

const editConsentUrl = computed(() => {
  const tid = editForm.tenantId.trim();
  const cid = editForm.clientId.trim();
  if (!tid || !cid) return null;
  return `https://login.microsoftonline.com/${encodeURIComponent(tid)}/adminconsent?client_id=${encodeURIComponent(cid)}`;
});

const editIsNew = computed(() => !editTarget.value?.integration);
const editHasStoredSecret = computed(() => editTarget.value?.integration?.hasClientSecret === true);

function openEdit(row: DirectoryEntra): void {
  editTarget.value = row;
  editError.value = null;
  editTestResult.value = null;
  const ex = row.integration;
  editForm.tenantId = ex?.tenantId ?? '';
  editForm.clientId = ex?.clientId ?? '';
  editForm.clientSecret = '';
  editForm.enabled = ex?.enabled ?? true;
  editForm.features = {
    photos: ex?.features.photos ?? false,
    signInActivity: ex?.features.signInActivity ?? false,
    signInEvents: ex?.features.signInEvents ?? false,
    mfaRegistration: ex?.features.mfaRegistration ?? false,
    teamsAdminWebhook: ex?.features.teamsAdminWebhook ?? false,
    passwordExpiryNotifications: ex?.features.passwordExpiryNotifications ?? false,
  };
  editForm.teamsWebhookUrl = '';
  editForm.teamsWebhookUrlClear = false;
  editOpen.value = true;
}

function startSave(): void {
  if (!auth.elevated) {
    editStepUpOpen.value = true;
    return;
  }
  void submitEdit();
}

async function submitEdit(): Promise<void> {
  if (editSubmitting.value || !editTarget.value) return;
  editError.value = null;

  if (!editForm.tenantId.trim() || !editForm.clientId.trim()) {
    editError.value = 'Tenant ID and Client ID are required';
    return;
  }
  if (editIsNew.value && !editForm.clientSecret) {
    editError.value = 'Client secret is required for first-time setup';
    return;
  }

  const body: EntraIntegrationPut = {
    tenantId: editForm.tenantId.trim(),
    clientId: editForm.clientId.trim(),
    enabled: editForm.enabled,
    features: { ...editForm.features },
  };
  if (editForm.clientSecret) body.clientSecret = editForm.clientSecret;
  if (editForm.teamsWebhookUrl.trim()) {
    body.teamsWebhookUrl = editForm.teamsWebhookUrl.trim();
  } else if (editForm.teamsWebhookUrlClear) {
    body.teamsWebhookUrl = '';
  }

  editSubmitting.value = true;
  try {
    await api.directories.entra.put(editTarget.value.directory.id, body);
    toast.add({ severity: 'success', summary: 'Entra integration saved', life: 3000 });
    editOpen.value = false;
    await load();
  } catch (err) {
    editError.value = err instanceof ApiError ? err.message : 'Save failed';
  } finally {
    editSubmitting.value = false;
  }
}

async function runTest(): Promise<void> {
  if (!editTarget.value) return;
  editTestResult.value = null;
  // Test against currently-saved creds. If the operator has unsaved
  // changes — especially a fresh secret — they should save first.
  if (editForm.clientSecret || editIsNew.value) {
    editTestResult.value = {
      ok: false,
      message: 'Save first — test runs against the stored credentials',
    };
    return;
  }
  editTestRunning.value = true;
  try {
    const r = await api.directories.entra.test(editTarget.value.directory.id);
    editTestResult.value = { ok: r.ok, message: r.message };
  } catch (err) {
    editTestResult.value = {
      ok: false,
      message: err instanceof ApiError ? err.message : 'Test failed',
    };
  } finally {
    editTestRunning.value = false;
  }
}

async function disableIntegration(): Promise<void> {
  if (!editTarget.value || !editTarget.value.integration) return;
  if (
    !window.confirm(
      'Remove this Entra integration? Cached photos and sign-in data will be deleted.',
    )
  ) {
    return;
  }
  if (!auth.elevated) {
    editStepUpOpen.value = true;
    return;
  }
  editSubmitting.value = true;
  try {
    await api.directories.entra.remove(editTarget.value.directory.id);
    toast.add({ severity: 'success', summary: 'Entra integration removed', life: 3000 });
    editOpen.value = false;
    await load();
  } catch (err) {
    editError.value = err instanceof ApiError ? err.message : 'Remove failed';
  } finally {
    editSubmitting.value = false;
  }
}

function statusLabel(integration: EntraIntegrationSummary | null): {
  text: string;
  cls: string;
} {
  if (!integration) return { text: 'not configured', cls: 'status-none' };
  if (!integration.enabled) return { text: 'disabled', cls: 'status-disabled' };
  if (!integration.hasClientSecret) return { text: 'no secret', cls: 'status-warn' };
  if (integration.lastTestStatus === 'failure') {
    return { text: 'last test failed', cls: 'status-warn' };
  }
  return { text: 'connected', cls: 'status-ok' };
}

function lastTestText(integration: EntraIntegrationSummary | null): string {
  if (!integration?.lastTestAt) return 'Never tested';
  const rel = fmtRelative(integration.lastTestAt);
  if (integration.lastTestStatus === 'success') return `Tested ${rel}`;
  return `Last test failed ${rel}`;
}

</script>

<template>
  <div class="int-tab">
    <header class="int-head">
      <div>
        <h2 class="int-title">Entra ID</h2>
        <p class="int-sub">
          Connect Microsoft Entra (Graph) per AD directory to enrich users with photos, sign-in
          activity, and MFA state, and to post admin notifications to Teams.
        </p>
      </div>
    </header>

    <!-- Entra integration: one card per configured AD directory -->
    <Card
      title="Microsoft Entra ID (Microsoft Graph)"
      :sub="'Photos, sign-in activity, and Teams notifications. Configure per directory.'"
    >
      <div v-if="loading" class="int-loading">Loading…</div>
      <EmptyState
        v-else-if="rows.length === 0"
        title="No directories configured"
        sub="Add an Active Directory in the Configuration tab first — Entra integrations attach to an existing directory."
      />
      <ul v-else class="entra-list">
        <li v-for="row in rows" :key="row.directory.id" class="entra-row">
          <div class="entra-row-main">
            <div class="entra-row-name">
              <strong>{{ row.directory.displayName ?? row.directory.name }}</strong>
              <span class="entra-row-domain">{{ row.directory.domain }}</span>
            </div>
            <span class="entra-status" :class="statusLabel(row.integration).cls">{{
              statusLabel(row.integration).text
            }}</span>
          </div>
          <div class="entra-row-meta">
            <span v-if="row.integration?.tenantId" class="entra-tenant"
              >tenant {{ row.integration.tenantId.slice(0, 8) }}…</span
            >
            <span class="entra-test">{{ lastTestText(row.integration) }}</span>
            <span
              v-if="row.integration?.lastTestError"
              class="entra-test-err"
              :title="row.integration.lastTestError"
              >last error: {{ row.integration.lastTestError }}</span
            >
          </div>
          <div class="entra-row-actions">
            <Button
              :label="row.integration ? 'Edit' : 'Configure'"
              size="small"
              severity="secondary"
              :disabled="!canConfigure"
              @click="openEdit(row)"
            />
          </div>
        </li>
      </ul>
    </Card>

    <!-- Edit dialog -->
    <Dialog
      v-model:visible="editOpen"
      modal
      :header="`Configure Entra — ${editTarget?.directory.displayName ?? editTarget?.directory.name ?? ''}`"
      :style="{ width: '720px', maxWidth: '95vw' }"
    >
      <div v-if="editTarget" class="entra-form">
        <Message v-if="editError" severity="error" class="entra-msg">{{ editError }}</Message>

        <section class="entra-section">
          <h4 class="entra-section-title">App registration</h4>
          <p class="entra-help">
            Create an App Registration in the Entra admin center. Copy the Tenant ID and Client ID
            from the app's Overview page; create a Client Secret under Certificates &amp; Secrets.
          </p>
          <div class="entra-fields">
            <label class="entra-field">
              <span>Tenant ID</span>
              <InputText
                v-model="editForm.tenantId"
                placeholder="11111111-2222-3333-4444-555555555555"
              />
            </label>
            <label class="entra-field">
              <span>Client ID</span>
              <InputText v-model="editForm.clientId" />
            </label>
            <label class="entra-field">
              <span>Client secret</span>
              <Password
                v-model="editForm.clientSecret"
                :feedback="false"
                toggle-mask
                :placeholder="
                  editHasStoredSecret
                    ? '•••• (stored — leave blank to keep)'
                    : 'enter the new secret value (not the secret ID)'
                "
              />
            </label>
          </div>
        </section>

        <section class="entra-section">
          <h4 class="entra-section-title">Permissions to grant</h4>
          <p class="entra-help">
            In the App Registration's <em>API permissions</em> page, add the following
            <strong>Application</strong> permissions for Microsoft Graph and click
            <em>Grant admin consent</em>:
          </p>
          <ul class="entra-perms">
            <li><code>User.Read.All</code> &mdash; profile + photos</li>
            <li><code>AuditLog.Read.All</code> &mdash; sign-in activity (requires Entra ID P1)</li>
            <li>
              <code>Directory.Read.All</code> &mdash; tenant identity (used by the test connection)
            </li>
          </ul>
          <p class="entra-help">
            <a v-if="editConsentUrl" :href="editConsentUrl" target="_blank" rel="noopener">
              <i class="pi pi-external-link" /> Open admin-consent URL for this tenant
            </a>
          </p>
        </section>

        <section class="entra-section">
          <h4 class="entra-section-title">Features</h4>
          <ul class="entra-features">
            <li v-for="f in FEATURES" :key="f.key" class="entra-feature">
              <Checkbox :input-id="`feat-${f.key}`" v-model="editForm.features[f.key]" binary />
              <label :for="`feat-${f.key}`" class="entra-feature-body">
                <span class="entra-feature-name">{{ f.label }}</span>
                <span class="entra-feature-desc">{{ f.description }}</span>
                <span v-if="f.permissionNote" class="entra-feature-perm"
                  >requires {{ f.permissionNote }}</span
                >
              </label>
            </li>
          </ul>
        </section>

        <section
          v-if="
            editForm.features.teamsAdminWebhook || editForm.features.passwordExpiryNotifications
          "
          class="entra-section"
        >
          <h4 class="entra-section-title">Teams admin webhook</h4>
          <p class="entra-help">
            Add an Incoming Webhook connector to the channel that should receive notifications and
            paste the URL here. The URL is the auth (a shared secret) so we encrypt it at rest.
            Direct user DMs aren&rsquo;t supported in this release — alerts go to this channel, not
            the affected user.
          </p>
          <label class="entra-field">
            <span>Webhook URL</span>
            <InputText
              v-model="editForm.teamsWebhookUrl"
              :placeholder="
                editTarget.integration?.hasTeamsWebhookUrl
                  ? '•••• (stored — leave blank to keep)'
                  : 'https://outlook.office.com/webhook/…'
              "
            />
          </label>
          <Button
            v-if="editTarget.integration?.hasTeamsWebhookUrl"
            label="Clear stored URL"
            text
            size="small"
            severity="danger"
            @click="editForm.teamsWebhookUrlClear = !editForm.teamsWebhookUrlClear"
          />
          <small v-if="editForm.teamsWebhookUrlClear" class="entra-cleared">
            Will clear the stored webhook URL on save.
          </small>
        </section>

        <section class="entra-section">
          <h4 class="entra-section-title">Connection</h4>
          <div class="entra-test-row">
            <Button
              label="Test connection"
              size="small"
              severity="secondary"
              :loading="editTestRunning"
              :disabled="!editTarget.integration"
              @click="runTest"
            />
            <Message
              v-if="editTestResult"
              :severity="editTestResult.ok ? 'success' : 'error'"
              :closable="false"
              class="entra-test-msg"
            >
              {{ editTestResult.message }}
            </Message>
            <span v-else class="entra-help">
              Acquires a token and reads <code>/organization</code>. Saved creds only — save first
              if you've changed the secret.
            </span>
          </div>
        </section>
      </div>

      <template #footer>
        <div class="entra-foot">
          <Button
            v-if="editTarget?.integration"
            label="Remove integration"
            severity="danger"
            text
            :disabled="editSubmitting"
            @click="disableIntegration"
          />
          <span class="entra-foot-spacer" />
          <Button label="Cancel" severity="secondary" text @click="editOpen = false" />
          <Button label="Save" :loading="editSubmitting" @click="startSave" />
        </div>
      </template>
    </Dialog>

    <StepUpDialog v-model:visible="editStepUpOpen" @ok="submitEdit" />
  </div>
</template>

<style scoped>
.int-tab {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.int-title {
  font-size: 16px;
  margin: 0 0 4px;
  color: var(--text);
}

.int-sub {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
  max-width: 64ch;
  line-height: 1.5;
}

.int-loading {
  color: var(--text-3);
  font-size: 13px;
  padding: 8px 4px;
}

/* Entra rows */
.entra-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.entra-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.entra-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.entra-row-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.entra-row-name strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entra-row-domain {
  font-size: 11.5px;
  color: var(--text-3);
}

.entra-status {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
}

.entra-status.status-ok {
  color: var(--success-text, var(--accent-text));
  background: var(--success-soft, var(--accent-soft));
  border-color: color-mix(in oklab, var(--success, var(--accent)) 30%, transparent);
}

.entra-status.status-warn {
  color: #b56b00;
  background: color-mix(in oklab, #ffb84d 18%, transparent);
  border-color: color-mix(in oklab, #ffb84d 32%, transparent);
}

.entra-status.status-disabled {
  color: var(--text-3);
  background: var(--surface-2);
}

.entra-status.status-none {
  color: var(--text-3);
  background: var(--surface-2);
}

.entra-row-meta {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-3);
}

.entra-test-err {
  color: var(--danger-text, #b00020);
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entra-row-actions {
  display: flex;
  align-items: center;
}

/* Edit dialog */
.entra-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.entra-msg {
  margin: 0;
}

.entra-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.entra-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-2);
}

.entra-help {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.5;
}

.entra-help a {
  color: var(--accent-text);
}

.entra-perms {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.7;
}

.entra-perms code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  font-size: 11.5px;
}

.entra-fields {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.entra-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}

.entra-field span {
  font-weight: 500;
}

.entra-field :deep(.p-inputtext),
.entra-field :deep(.p-password input) {
  width: 100%;
}

.entra-features {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.entra-feature {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 10px;
  align-items: start;
}

.entra-feature-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}

.entra-feature-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.entra-feature-desc {
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}

.entra-feature-perm {
  font-size: 11px;
  color: var(--text-3);
  font-style: italic;
}

.entra-test-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.entra-test-msg {
  flex: 1;
  margin: 0;
}

.entra-cleared {
  color: var(--danger-text, #b00020);
  font-size: 11.5px;
}

.entra-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.entra-foot-spacer {
  flex: 1;
}
</style>
