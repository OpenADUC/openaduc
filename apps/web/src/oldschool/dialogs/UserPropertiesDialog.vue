<!-- SPDX-License-Identifier: BUSL-1.1
     User Properties dialog — pixel-faithful 13-tab classic ADUC layout.
     Tabs not backed by our cache schema (Dial-in, Environment, Sessions,
     Remote control, Remote Desktop Services Profile, COM+) render the
     authentic layout with disabled controls so the experience reads as
     "ADUC, but our directory doesn't expose this here". Editable fields
     submit through PATCH /users/:id and respect the step-up gate. -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import WinDialog from './WinDialog.vue';
import WinTabs from '../primitives/WinTabs.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';
import { useOldSchool } from '../stores/useOldSchool.js';
import { useToast } from 'primevue/usetoast';
import type { UserDetail, UserUpdateRequest } from '@openaduc/shared';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const auth = useAuthStore();
const store = useOldSchool();
const toast = useToast();

const visible = ref(true);
const user = ref<UserDetail | null>(null);
const loading = ref(true);
const err = ref<string | null>(null);

// Mutable "draft" mirrors UserDetail writable subset. Dirty when any
// field differs from the loaded snapshot.
type StringField =
  | 'displayName'
  | 'givenName'
  | 'surname'
  | 'description'
  | 'email'
  | 'phone'
  | 'mobile'
  | 'title'
  | 'department'
  | 'company'
  | 'employeeID'
  | 'employeeNumber'
  | 'ipPhone'
  | 'homePhone'
  | 'homePostalAddress'
  | 'c'
  | 'co'
  | 'l'
  | 'st'
  | 'postalCode';

interface Draft {
  // Writable scalar fields.
  values: Record<StringField, string>;
  // Whether to flip the unlock action on Apply (only meaningful when locked).
  doUnlock: boolean;
}

const draft = ref<Draft>({
  values: {
    displayName: '',
    givenName: '',
    surname: '',
    description: '',
    email: '',
    phone: '',
    mobile: '',
    title: '',
    department: '',
    company: '',
    employeeID: '',
    employeeNumber: '',
    ipPhone: '',
    homePhone: '',
    homePostalAddress: '',
    c: '',
    co: '',
    l: '',
    st: '',
    postalCode: '',
  },
  doUnlock: false,
});
const snapshot = ref<Draft | null>(null);

function strField(v: string | null | undefined): string {
  return v ?? '';
}

function snapshotFrom(u: UserDetail): Draft {
  return {
    values: {
      displayName: strField(u.displayName),
      givenName: strField(u.givenName),
      surname: strField(u.surname),
      description: strField(u.description),
      email: strField(u.email),
      phone: strField(u.phone),
      mobile: strField(u.mobile),
      title: strField(u.title),
      department: strField(u.department),
      company: strField(u.company),
      employeeID: strField(u.employeeID),
      employeeNumber: strField(u.employeeNumber),
      ipPhone: strField(u.ipPhone),
      homePhone: strField(u.homePhone),
      homePostalAddress: strField(u.homePostalAddress),
      c: strField(u.c),
      co: strField(u.co),
      l: strField(u.l),
      st: strField(u.st),
      postalCode: strField(u.postalCode),
    },
    doUnlock: false,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  err.value = null;
  try {
    const resp = await api.users.get(props.id);
    user.value = resp.user;
    const snap = snapshotFrom(resp.user);
    draft.value = JSON.parse(JSON.stringify(snap));
    snapshot.value = JSON.parse(JSON.stringify(snap));
  } catch (e) {
    err.value = e instanceof ApiError ? e.message : (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => store.dataVersion, load);

const dirty = computed(() => {
  if (!snapshot.value) return false;
  if (draft.value.doUnlock) return true;
  for (const k of Object.keys(draft.value.values) as StringField[]) {
    if (draft.value.values[k] !== snapshot.value.values[k]) return true;
  }
  return false;
});

// --- Dialog title -----------------------------------------------------
const dialogTitle = computed(() => {
  const u = user.value;
  if (!u) return 'Properties';
  return `${u.displayName ?? u.samAccountName} Properties`;
});

// --- Tabs -------------------------------------------------------------
type TabId =
  | 'general'
  | 'address'
  | 'account'
  | 'profile'
  | 'telephones'
  | 'organization'
  | 'memberOf'
  | 'dialin'
  | 'environment'
  | 'sessions'
  | 'remoteControl'
  | 'rdsProfile'
  | 'comPlus';

const tabs: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'address', label: 'Address' },
  { id: 'account', label: 'Account' },
  { id: 'profile', label: 'Profile' },
  { id: 'telephones', label: 'Telephones' },
  { id: 'organization', label: 'Organization' },
  { id: 'memberOf', label: 'Member Of' },
  { id: 'dialin', label: 'Dial-in' },
  { id: 'environment', label: 'Environment' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'remoteControl', label: 'Remote control' },
  { id: 'rdsProfile', label: 'Remote Desktop Services Profile' },
  { id: 'comPlus', label: 'COM+' },
];
const activeTab = ref<TabId>('general');

// --- Save -------------------------------------------------------------
async function save(closeAfter: boolean): Promise<void> {
  if (!user.value || !snapshot.value) return;
  if (!dirty.value) {
    if (closeAfter) {
      visible.value = false;
      emit('close');
    }
    return;
  }
  const patch: UserUpdateRequest['patch'] = {};
  for (const k of Object.keys(draft.value.values) as StringField[]) {
    const next = draft.value.values[k];
    const prev = snapshot.value.values[k];
    if (next === prev) continue;
    if (k === 'email') {
      // The PATCH schema treats '' as null for email.
      (patch as Record<string, unknown>)[k] = next.trim() === '' ? null : next.trim();
    } else {
      (patch as Record<string, unknown>)[k] = next === '' ? null : next;
    }
  }
  const wantUnlock = draft.value.doUnlock && user.value.locked;

  auth.requireEdit(async () => {
    try {
      if (Object.keys(patch).length > 0) {
        await api.users.update(props.id, { patch });
      }
      if (wantUnlock) {
        try {
          await api.users.unlock(props.id);
        } catch {
          /* ignore */
        }
      }
      toast.add({ severity: 'success', summary: 'Changes applied.', life: 2500 });
      store.bumpData();
      // Refresh local snapshot from the new state.
      await load();
      if (closeAfter) {
        visible.value = false;
        emit('close');
      }
    } catch (e) {
      err.value = e instanceof ApiError ? e.message : (e as Error).message;
    }
  }, 'Updating a user requires step-up authentication.');
}

// --- Member Of helpers -----------------------------------------------
const memberOfPending = ref<string | null>(null);
function removeMembership(groupId: string, groupName: string): void {
  store.openDialog({
    kind: 'confirm',
    title: 'Multiple Names Found',
    message: `Remove ${user.value?.displayName ?? user.value?.samAccountName} from "${groupName}"?`,
    okLabel: 'Yes',
    destructive: false,
    onOk: () => {
      auth.requireEdit(async () => {
        memberOfPending.value = groupId;
        try {
          await api.users.removeGroup(props.id, { groupId });
          toast.add({ severity: 'success', summary: `Removed from ${groupName}.`, life: 2500 });
          await load();
          store.bumpData();
        } catch (e) {
          toast.add({
            severity: 'error',
            summary: 'Remove failed',
            detail: e instanceof ApiError ? e.message : (e as Error).message,
            life: 5000,
          });
        } finally {
          memberOfPending.value = null;
        }
      }, 'Removing a group membership requires step-up authentication.');
    },
  });
}
function openAddGroup(): void {
  if (!user.value) return;
  store.openDialog({
    kind: 'add-to-group',
    userId: props.id,
    userLabel: user.value.displayName ?? user.value.samAccountName,
  });
}

// --- Account tab helpers ---------------------------------------------
const upnLogonName = computed(() => {
  const upn = user.value?.userPrincipalName ?? '';
  const idx = upn.indexOf('@');
  if (idx === -1) return { local: upn, domain: '' };
  return { local: upn.slice(0, idx), domain: upn.slice(idx) };
});

function rawAttr(u: UserDetail, key: string): string {
  const v = (u.rawAttributes as Record<string, unknown>)[key];
  if (Array.isArray(v)) return v.join('\n');
  return v == null ? '' : String(v);
}
</script>

<template>
  <WinDialog
    :visible="visible"
    :title="dialogTitle"
    icon="user"
    :width="540"
    :can-apply="dirty"
    :can-ok="!loading"
    @ok="save(true)"
    @apply="save(false)"
    @cancel="$emit('close')"
    @update:visible="(v) => !v && $emit('close')"
  >
    <div v-if="loading" style="padding: 24px; text-align: center">Loading…</div>
    <div v-else-if="!user" class="os-error" style="padding: 16px">
      {{ err ?? 'Unable to load user.' }}
    </div>
    <template v-else>
      <WinTabs :tabs="tabs" v-model="activeTab" />
      <div class="os-tab-body">
        <!-- ====== GENERAL ====== -->
        <template v-if="activeTab === 'general'">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px">
            <WinIcon name="user" :size="36" />
            <strong>{{ user.displayName ?? user.samAccountName }}</strong>
          </div>
          <hr
            style="border: 0; border-top: 1px solid var(--os-window-border-soft); margin: 0 0 14px"
          />
          <div class="os-form">
            <label class="label" for="givenName">First name:</label>
            <div style="display: flex; gap: 8px">
              <input id="givenName" class="os-input" v-model="draft.values.givenName" />
              <label class="label" style="flex: 0 0 60px; text-align: right; align-self: center"
                >Initials:</label
              >
              <input class="os-input" style="width: 60px" disabled />
            </div>
            <label class="label" for="surname">Last name:</label>
            <input id="surname" class="os-input" v-model="draft.values.surname" />
            <label class="label" for="displayName">Display name:</label>
            <input id="displayName" class="os-input" v-model="draft.values.displayName" />
            <label class="label" for="description">Description:</label>
            <input id="description" class="os-input" v-model="draft.values.description" />
            <label class="label" for="office">Office:</label>
            <input
              id="office"
              class="os-input"
              :value="rawAttr(user, 'physicalDeliveryOfficeName')"
              disabled
            />
          </div>
          <hr
            style="border: 0; border-top: 1px solid var(--os-window-border-soft); margin: 14px 0"
          />
          <div class="os-form">
            <label class="label" for="phone">Telephone number:</label>
            <div style="display: flex; gap: 6px">
              <input id="phone" class="os-input" v-model="draft.values.phone" />
              <button class="os-btn" disabled style="min-width: 70px">Other…</button>
            </div>
            <label class="label" for="email">E-mail:</label>
            <input id="email" class="os-input" v-model="draft.values.email" />
            <label class="label" for="webPage">Web page:</label>
            <div style="display: flex; gap: 6px">
              <input id="webPage" class="os-input" disabled />
              <button class="os-btn" disabled style="min-width: 70px">Other…</button>
            </div>
          </div>
        </template>

        <!-- ====== ADDRESS ====== -->
        <template v-else-if="activeTab === 'address'">
          <div class="os-form">
            <label class="label" for="street">Street:</label>
            <textarea
              id="street"
              class="os-textarea"
              rows="3"
              v-model="draft.values.homePostalAddress"
            />
            <label class="label" for="pobox">P.O. Box:</label>
            <input id="pobox" class="os-input" :value="rawAttr(user, 'postOfficeBox')" disabled />
            <label class="label" for="city">City:</label>
            <input id="city" class="os-input" v-model="draft.values.l" />
            <label class="label" for="state">State/province:</label>
            <input id="state" class="os-input" v-model="draft.values.st" />
            <label class="label" for="zip">Zip/Postal Code:</label>
            <input id="zip" class="os-input" v-model="draft.values.postalCode" />
            <label class="label" for="country">Country/region:</label>
            <input id="country" class="os-input" v-model="draft.values.co" placeholder="(name)" />
          </div>
        </template>

        <!-- ====== ACCOUNT ====== -->
        <template v-else-if="activeTab === 'account'">
          <div class="os-form" style="grid-template-columns: 200px 1fr">
            <label class="label">User logon name:</label>
            <div style="display: flex; gap: 4px">
              <input class="os-input" :value="upnLogonName.local" disabled />
              <input class="os-input" :value="upnLogonName.domain" disabled style="flex: 0 0 36%" />
            </div>
            <label class="label">User logon name (pre-Windows 2000):</label>
            <input class="os-input" :value="user.samAccountName" disabled />
          </div>
          <div style="display: flex; gap: 8px; margin-top: 12px">
            <button class="os-btn" disabled>Logon Hours…</button>
            <button class="os-btn" disabled>Log On To…</button>
          </div>
          <hr
            style="border: 0; border-top: 1px solid var(--os-window-border-soft); margin: 14px 0"
          />
          <label class="os-check" :class="{ disabled: !user.locked }">
            <input type="checkbox" v-model="draft.doUnlock" :disabled="!user.locked" />
            Unlock account. This account is currently
            {{ user.locked ? 'locked out' : 'not locked out' }} on this Active Directory Domain
            Controller.
          </label>
          <fieldset class="os-groupbox" style="margin-top: 14px">
            <legend>Account options:</legend>
            <div style="display: flex; flex-direction: column; gap: 4px">
              <label class="os-check disabled"
                ><input type="checkbox" disabled /> User must change password at next logon</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" disabled /> User cannot change password</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" :checked="user.passwordNeverExpires" disabled /> Password
                never expires</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" disabled /> Store password using reversible
                encryption</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" :checked="!user.enabled" disabled /> Account is
                disabled</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" disabled /> Smart card is required for interactive
                logon</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" disabled /> Account is sensitive and cannot be
                delegated</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" disabled /> Use only Kerberos DES encryption types for this
                account</label
              >
              <label class="os-check disabled"
                ><input type="checkbox" disabled /> Do not require Kerberos preauthentication</label
              >
            </div>
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Account expires</legend>
            <label class="os-check disabled" style="margin-right: 18px">
              <input type="radio" :checked="!user.accountExpiresAt" disabled /> Never
            </label>
            <label class="os-check disabled">
              <input type="radio" :checked="!!user.accountExpiresAt" disabled />
              End of:
              <input
                class="os-input"
                style="width: 160px; margin-left: 6px"
                :value="
                  user.accountExpiresAt ? new Date(user.accountExpiresAt).toLocaleDateString() : ''
                "
                disabled
              />
            </label>
          </fieldset>
        </template>

        <!-- ====== PROFILE ====== -->
        <template v-else-if="activeTab === 'profile'">
          <fieldset class="os-groupbox">
            <legend>User profile</legend>
            <div class="os-form" style="grid-template-columns: 110px 1fr">
              <label class="label">Profile path:</label>
              <input class="os-input" :value="rawAttr(user, 'profilePath')" disabled />
              <label class="label">Logon script:</label>
              <input class="os-input" :value="rawAttr(user, 'scriptPath')" disabled />
            </div>
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Home folder</legend>
            <label class="os-check disabled" style="margin-bottom: 6px">
              <input type="radio" disabled /> Local path:
              <input
                class="os-input"
                style="margin-left: 8px; flex: 1"
                :value="rawAttr(user, 'homeDirectory')"
                disabled
              />
            </label>
            <label class="os-check disabled">
              <input type="radio" disabled /> Connect:
              <select class="os-select" style="width: 70px; margin-left: 4px" disabled>
                <option>Z:</option>
              </select>
              To:
              <input class="os-input" style="margin-left: 4px; flex: 1" disabled />
            </label>
          </fieldset>
        </template>

        <!-- ====== TELEPHONES ====== -->
        <template v-else-if="activeTab === 'telephones'">
          <fieldset class="os-groupbox">
            <legend>Telephone numbers</legend>
            <div class="os-form" style="grid-template-columns: 80px 1fr 80px">
              <label class="label">Home:</label>
              <input class="os-input" v-model="draft.values.homePhone" />
              <button class="os-btn" disabled>Other…</button>
              <label class="label">Pager:</label>
              <input class="os-input" :value="rawAttr(user, 'pager')" disabled />
              <button class="os-btn" disabled>Other…</button>
              <label class="label">Mobile:</label>
              <input class="os-input" v-model="draft.values.mobile" />
              <button class="os-btn" disabled>Other…</button>
              <label class="label">Fax:</label>
              <input class="os-input" :value="rawAttr(user, 'facsimileTelephoneNumber')" disabled />
              <button class="os-btn" disabled>Other…</button>
              <label class="label">IP phone:</label>
              <input class="os-input" v-model="draft.values.ipPhone" />
              <button class="os-btn" disabled>Other…</button>
            </div>
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Notes:</legend>
            <textarea class="os-textarea" rows="3" :value="rawAttr(user, 'info')" disabled />
          </fieldset>
        </template>

        <!-- ====== ORGANIZATION ====== -->
        <template v-else-if="activeTab === 'organization'">
          <div class="os-form">
            <label class="label">Title:</label>
            <input class="os-input" v-model="draft.values.title" />
            <label class="label">Department:</label>
            <input class="os-input" v-model="draft.values.department" />
            <label class="label">Company:</label>
            <input class="os-input" v-model="draft.values.company" />
          </div>
          <fieldset class="os-groupbox">
            <legend>Manager</legend>
            <div class="os-form" style="grid-template-columns: 60px 1fr; column-gap: 6px">
              <label class="label">Name:</label>
              <div style="display: flex; gap: 6px">
                <input
                  class="os-input"
                  :value="user.manager?.displayName ?? user.manager?.distinguishedName ?? ''"
                  disabled
                />
                <button class="os-btn" disabled>Change…</button>
                <button class="os-btn" disabled>Properties</button>
                <button class="os-btn" disabled>Clear</button>
              </div>
            </div>
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Direct reports:</legend>
            <div class="os-listbox" style="min-height: 80px; max-height: 140px">
              <div v-if="user.directReports.length === 0" class="os-listbox-empty">(none)</div>
              <div
                v-for="dr in user.directReports"
                :key="dr.distinguishedName"
                class="os-listbox-row"
              >
                <WinIcon name="user" :size="14" />
                <span>{{ dr.displayName ?? dr.distinguishedName }}</span>
              </div>
            </div>
          </fieldset>
        </template>

        <!-- ====== MEMBER OF ====== -->
        <template v-else-if="activeTab === 'memberOf'">
          <div style="margin-bottom: 6px">Member of:</div>
          <div class="os-listbox" style="min-height: 180px; max-height: 260px">
            <div v-if="user.groupMemberships.length === 0" class="os-listbox-empty">
              (no group memberships)
            </div>
            <div
              v-for="g in user.groupMemberships"
              :key="g.id"
              class="os-listbox-row"
              :class="{ selected: memberOfPending === g.id }"
              @click="memberOfPending = g.id"
            >
              <WinIcon name="group" :size="14" />
              <span style="flex: 1">{{ g.name }}</span>
              <span style="color: var(--os-window-text-muted)" v-if="!g.direct">(via nested)</span>
            </div>
          </div>
          <div style="display: flex; gap: 6px; margin-top: 8px">
            <button class="os-btn" type="button" @click="openAddGroup">Add…</button>
            <button
              class="os-btn"
              type="button"
              :disabled="!memberOfPending"
              @click="
                () => {
                  const g = user!.groupMemberships.find((x) => x.id === memberOfPending);
                  if (g) removeMembership(g.id, g.name);
                }
              "
            >
              Remove
            </button>
          </div>
          <fieldset class="os-groupbox" style="margin-top: 14px">
            <legend>Primary group:</legend>
            <div class="os-form" style="grid-template-columns: 110px 1fr">
              <label class="label">Primary group:</label>
              <input class="os-input" value="Domain Users" disabled />
            </div>
            <div style="display: flex; gap: 6px; margin-top: 6px">
              <button class="os-btn" disabled>Set Primary Group</button>
            </div>
            <div class="os-info">
              There is no need to change Primary group unless you have Macintosh clients or
              POSIX-compliant applications.
            </div>
          </fieldset>
        </template>

        <!-- ====== DIAL-IN ====== -->
        <template v-else-if="activeTab === 'dialin'">
          <fieldset class="os-groupbox">
            <legend>Network Access Permission</legend>
            <label class="os-check disabled"><input type="radio" disabled /> Allow access</label
            ><br />
            <label class="os-check disabled"><input type="radio" disabled /> Deny access</label
            ><br />
            <label class="os-check disabled"
              ><input type="radio" checked disabled /> Control access through NPS Network
              Policy</label
            >
          </fieldset>
          <label class="os-check disabled"
            ><input type="checkbox" disabled /> Verify Caller-ID:</label
          >
          <input class="os-input" disabled style="margin-top: 4px; max-width: 220px" />
          <fieldset class="os-groupbox">
            <legend>Callback Options</legend>
            <label class="os-check disabled"
              ><input type="radio" checked disabled /> No Callback</label
            ><br />
            <label class="os-check disabled"
              ><input type="radio" disabled /> Set by Caller (Routing and Remote Access Service
              only)</label
            ><br />
            <label class="os-check disabled">
              <input type="radio" disabled /> Always Callback to:
              <input class="os-input" disabled style="margin-left: 6px; max-width: 200px" />
            </label>
          </fieldset>
          <label class="os-check disabled">
            <input type="checkbox" disabled /> Assign Static IP Addresses
          </label>
          <label class="os-check disabled" style="display: block; margin-top: 4px">
            <input type="checkbox" disabled /> Apply Static Routes
          </label>
        </template>

        <!-- ====== ENVIRONMENT ====== -->
        <template v-else-if="activeTab === 'environment'">
          <p>
            Use this tab to configure the Remote Desktop Services startup environment. These
            settings override client-specified settings.
          </p>
          <fieldset class="os-groupbox">
            <legend>Starting program</legend>
            <label class="os-check disabled">
              <input type="checkbox" disabled /> Start the following program at logon:
            </label>
            <div class="os-form" style="grid-template-columns: 110px 1fr; margin-top: 6px">
              <label class="label">Program file name:</label>
              <input class="os-input" disabled />
              <label class="label">Start in:</label>
              <input class="os-input" disabled />
            </div>
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Client devices</legend>
            <label class="os-check disabled"
              ><input type="checkbox" checked disabled /> Connect client drives at logon</label
            ><br />
            <label class="os-check disabled"
              ><input type="checkbox" checked disabled /> Connect client printers at logon</label
            ><br />
            <label class="os-check disabled"
              ><input type="checkbox" checked disabled /> Default to main client printer</label
            >
          </fieldset>
        </template>

        <!-- ====== SESSIONS ====== -->
        <template v-else-if="activeTab === 'sessions'">
          <p>Use this tab to set Remote Desktop Services timeout and reconnection settings.</p>
          <div class="os-form" style="grid-template-columns: 220px 1fr">
            <label class="label">End a disconnected session:</label>
            <select class="os-select" disabled>
              <option>Never</option>
            </select>
            <label class="label">Active session limit:</label>
            <select class="os-select" disabled>
              <option>Never</option>
            </select>
            <label class="label">Idle session limit:</label>
            <select class="os-select" disabled>
              <option>Never</option>
            </select>
          </div>
          <fieldset class="os-groupbox">
            <legend>When a session limit is reached or connection is broken:</legend>
            <label class="os-check disabled"
              ><input type="radio" checked disabled /> Disconnect from session</label
            ><br />
            <label class="os-check disabled"><input type="radio" disabled /> End session</label>
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Allow reconnection:</legend>
            <label class="os-check disabled"
              ><input type="radio" checked disabled /> From any client</label
            ><br />
            <label class="os-check disabled"
              ><input type="radio" disabled /> From originating client only</label
            >
          </fieldset>
        </template>

        <!-- ====== REMOTE CONTROL ====== -->
        <template v-else-if="activeTab === 'remoteControl'">
          <p>
            Use this tab to configure Remote Desktop Services remote control settings. To remotely
            control or observe a user's session, the following settings apply.
          </p>
          <label class="os-check disabled"
            ><input type="checkbox" checked disabled /> Enable remote control</label
          >
          <fieldset class="os-groupbox">
            <legend>
              To require the user's permission for remote observation or control of the session,
              select the following:
            </legend>
            <label class="os-check disabled"
              ><input type="checkbox" checked disabled /> Require user's permission</label
            >
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Level of control</legend>
            <p>Specify the level of control you want to have over a user's session:</p>
            <label class="os-check disabled"
              ><input type="radio" disabled /> View the user's session</label
            ><br />
            <label class="os-check disabled"
              ><input type="radio" checked disabled /> Interact with the session</label
            >
          </fieldset>
        </template>

        <!-- ====== REMOTE DESKTOP SERVICES PROFILE ====== -->
        <template v-else-if="activeTab === 'rdsProfile'">
          <p>
            Use this tab to configure the Remote Desktop Services user profile. Settings in this
            profile apply to Remote Desktop Services.
          </p>
          <fieldset class="os-groupbox">
            <legend>Remote Desktop Services User Profile</legend>
            <div class="os-form" style="grid-template-columns: 100px 1fr">
              <label class="label">Profile Path:</label>
              <input class="os-input" disabled />
            </div>
          </fieldset>
          <fieldset class="os-groupbox">
            <legend>Remote Desktop Services Home Folder</legend>
            <label class="os-check disabled"
              ><input type="radio" checked disabled /> Local path:
              <input class="os-input" disabled style="margin-left: 6px; flex: 1" />
            </label>
            <br />
            <label class="os-check disabled">
              <input type="radio" disabled /> Connect:
              <select class="os-select" style="width: 70px; margin-left: 4px" disabled>
                <option>Z:</option>
              </select>
              To:
              <input class="os-input" style="margin-left: 4px; flex: 1" disabled />
            </label>
          </fieldset>
          <label class="os-check disabled">
            <input type="checkbox" disabled /> Deny this user permissions to log on to Remote
            Desktop Session Host server
          </label>
        </template>

        <!-- ====== COM+ ====== -->
        <template v-else-if="activeTab === 'comPlus'">
          <p>This user is a member of the following COM+ partition set:</p>
          <fieldset class="os-groupbox">
            <legend>Partition Set</legend>
            <div class="os-form" style="grid-template-columns: 70px 1fr">
              <label class="label">Name:</label>
              <div style="display: flex; gap: 4px">
                <input class="os-input" disabled value="(none)" />
                <button class="os-btn" disabled>Properties</button>
              </div>
            </div>
          </fieldset>
        </template>
      </div>
    </template>
  </WinDialog>
</template>
