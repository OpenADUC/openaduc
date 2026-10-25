<!-- SPDX-License-Identifier: BUSL-1.1
     Which AD group grants each OpenADUC role. Changes apply at each
     operator's next sign-in or step-up. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import Select from 'primevue/select';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { ROLE_MEMBERS_SHOWN, type RoleMapping, type Role as RoleName } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import Card from '../../design/primitives/Card.vue';

const auth = useAuthStore();
const toast = useToast();

const ROLE_INFO: { role: RoleName; label: string; summary: string }[] = [
  {
    role: 'admin',
    label: 'Admin',
    summary: 'Everything, including domains, security settings and deleting accounts.',
  },
  {
    role: 'operator',
    label: 'Operator',
    summary: 'Helpdesk work: unlock, reset passwords, enable/disable, edit, move, rename.',
  },
  { role: 'auditor', label: 'Auditor', summary: 'Read-only, plus the audit log.' },
];

const loading = ref(true);
const loadError = ref<string | null>(null);
const saving = ref(false);
const current = ref<Record<RoleName, RoleMapping> | null>(null);
const draft = ref<Record<RoleName, string | null>>({ admin: null, operator: null, auditor: null });
const groups = ref<{ dn: string; label: string }[]>([]);
const pendingAdminConfirm = ref<string | null>(null);

const changed = computed(() =>
  current.value
    ? (Object.keys(draft.value) as RoleName[]).filter(
        (r) => (draft.value[r] ?? null) !== (current.value![r].groupDn ?? null),
      )
    : [],
);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const [roles, groupList] = await Promise.all([
      api.settings.roles(),
      api.groups.search({ pageSize: 50_000, sort: 'name', sortDir: 'asc' }),
    ]);
    current.value = roles.roles;
    draft.value = {
      admin: roles.roles.admin.groupDn,
      operator: roles.roles.operator.groupDn,
      auditor: roles.roles.auditor.groupDn,
    };
    groups.value = groupList.rows.map((g) => ({
      dn: g.distinguishedName,
      label: g.name ?? g.distinguishedName,
    }));
    // A mapped group that isn't in the list (not synced) still shows.
    for (const r of Object.values(roles.roles)) {
      if (r.groupDn && !groups.value.some((g) => g.dn.toLowerCase() === r.groupDn!.toLowerCase())) {
        groups.value.push({ dn: r.groupDn, label: r.groupName ?? r.groupDn });
      }
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Failed to load roles';
  } finally {
    loading.value = false;
  }
}

async function save(confirmAdminChange = false): Promise<void> {
  if (changed.value.length === 0) return;
  saving.value = true;
  try {
    const body: Partial<Record<RoleName, string | null>> & { confirmAdminChange?: boolean } = {};
    for (const r of changed.value) body[r] = draft.value[r];
    if (confirmAdminChange) body.confirmAdminChange = true;
    await api.settings.updateRoles(body);
    pendingAdminConfirm.value = null;
    toast.add({
      severity: 'success',
      summary: 'Roles saved',
      detail: 'They apply at each operator’s next sign-in or step-up.',
      life: 4000,
    });
    await load();
  } catch (err) {
    if (auth.retryAfterStepUp(err, () => save(confirmAdminChange))) return;
    if (err instanceof ApiError && err.status === 409) {
      pendingAdminConfirm.value = err.message;
    } else {
      toast.add({
        severity: 'error',
        summary: 'Roles not saved',
        detail: err instanceof Error ? err.message : String(err),
        life: 6000,
      });
    }
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <Toast />
  <Message v-if="loadError" severity="error" :closable="false">{{ loadError }}</Message>
  <Card v-else-if="current" title="Roles" sub="Which AD group grants each role">
    <p class="roles-intro">
      Members of each group get the role when they sign in. Only direct members count; nested groups
      aren't followed.
    </p>
    <div v-for="info in ROLE_INFO" :key="info.role" class="role-row">
      <div class="role-meta">
        <div class="role-name">{{ info.label }}</div>
        <div class="role-summary">{{ info.summary }}</div>
        <div v-if="current[info.role].groupDn" class="role-count">
          {{
            current[info.role].memberCount === null
              ? 'Group not found in the directory cache'
              : `${current[info.role].memberCount} direct ${current[info.role].memberCount === 1 ? 'member' : 'members'}`
          }}
        </div>
        <ul v-if="current[info.role].members.length" class="role-members">
          <li v-for="m in current[info.role].members" :key="m.id">
            {{ m.displayName ?? m.samAccountName }}
            <span class="role-member-sam">{{ m.samAccountName }}</span>
          </li>
          <li
            v-if="(current[info.role].memberCount ?? 0) > ROLE_MEMBERS_SHOWN"
            class="role-member-sam"
          >
            and {{ current[info.role].memberCount! - ROLE_MEMBERS_SHOWN }} more
          </li>
        </ul>
      </div>
      <Select
        v-model="draft[info.role]"
        :options="groups"
        option-label="label"
        option-value="dn"
        filter
        show-clear
        placeholder="No group: nobody has this role"
        class="role-select"
        :aria-label="`${info.label} group`"
      />
    </div>

    <Message v-if="pendingAdminConfirm" severity="warn" :closable="false" class="role-warn">
      {{ pendingAdminConfirm }}
      <div class="role-warn-actions">
        <Button
          label="Cancel"
          text
          severity="secondary"
          size="small"
          @click="pendingAdminConfirm = null"
        />
        <Button
          label="Change it anyway"
          severity="warn"
          size="small"
          :loading="saving"
          @click="auth.requireStepUp(() => save(true))"
        />
      </div>
    </Message>

    <div class="role-actions">
      <Button
        label="Save roles"
        icon="pi pi-check"
        :disabled="changed.length === 0 || saving"
        :loading="saving && !pendingAdminConfirm"
        @click="auth.requireStepUp(() => save())"
      />
    </div>
  </Card>
  <div v-else-if="loading" class="roles-loading" role="status">Loading roles…</div>
</template>

<style scoped>
.roles-intro {
  margin: 0 0 16px;
  color: var(--text-2);
  font-size: 13px;
}
.role-row {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 16px;
  align-items: center;
  padding: 12px 0;
  border-top: 1px solid var(--border-soft);
}
.role-name {
  font-weight: 600;
}
.role-summary,
.role-count {
  font-size: 12px;
  color: var(--text-2);
}
.role-members {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.role-member-sam {
  color: var(--text-3);
  margin-left: 4px;
}
.role-select {
  width: 100%;
}
.role-warn {
  margin-top: 12px;
}
.role-warn-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.role-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
.roles-loading {
  padding: 32px;
  color: var(--text-2);
}
@media (max-width: 760px) {
  .role-row {
    grid-template-columns: 1fr;
  }
}
</style>
