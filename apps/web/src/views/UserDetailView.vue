<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import Button from 'primevue/button';
import Password from 'primevue/password';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Menu from 'primevue/menu';
import Textarea from 'primevue/textarea';
import Message from 'primevue/message';
import Toast from 'primevue/toast';
import TreeSelect from 'primevue/treeselect';
import type { MenuItem } from 'primevue/menuitem';
import type { TreeNode } from 'primevue/treenode';
import { useToast } from 'primevue/usetoast';
import { api, type AuditEventRow } from '../api/index.js';
import { ApiError } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import Avatar from '../design/primitives/Avatar.vue';
import StatusBadge from '../design/primitives/StatusBadge.vue';
import Card from '../design/primitives/Card.vue';
import GroupChip from '../design/primitives/GroupChip.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import ConfirmDialog from '../design/feedback/ConfirmDialog.vue';
import ReportingStructureCard from '../design/primitives/ReportingStructureCard.vue';
import ActivityFeed from '../design/primitives/ActivityFeed.vue';
import SignInEventsList from '../design/primitives/SignInEventsList.vue';
import SignInEventDetailDialog from '../design/feedback/SignInEventDetailDialog.vue';
import { fmtAbsolute, fmtRelative } from '../design/lib/format.js';
import type { GroupSummary, UserDetail, UserUpdateRequest } from '@openaduc/shared';
import { useStickyHeader } from './_detail/useStickyHeader';
import { useCompactTabs } from './_detail/useCompactTabs';

// 'location' / 'security' tabs map to 'organization' / 'contact' / 'account'.
// 'overview' is new; 'raw' is admin-gated. 'signins' shows Microsoft Entra
// sign-in events for this user — only rendered when the directory has an
// Entra integration configured.
type TabId = 'overview' | 'organization' | 'contact' | 'account' | 'groups' | 'signins' | 'raw';

// Attributes already rendered with first-class affordances elsewhere on the
// page (heading, subtitle, status badges, dedicated Security tab, dedicated
// Identity grid fields, Email aliases, Direct reports). Hide them from the
// read-only "More from directory" grid so the same value isn't shown twice.
const HANDLED_ATTRS = new Set<string>([
  'displayName',
  'name',
  'cn',
  'givenName',
  'sn',
  'mail',
  'userPrincipalName',
  'sAMAccountName',
  'sAMAccountType',
  'distinguishedName',
  'telephoneNumber',
  'mobile',
  'title',
  'department',
  'manager',
  'memberOf',
  'objectClass',
  'objectCategory',
  'userAccountControl',
  'lockoutTime',
  'pwdLastSet',
  'accountExpires',
  'lastLogonTimestamp',
  'lastLogon',
  'lastLogoff',
  'badPasswordTime',
  'badPwdCount',
  'logonCount',
  'whenCreated',
  'whenChanged',
  'uSNCreated',
  'uSNChanged',
  'instanceType',
  'objectGUID',
  'objectSid',
  'dSCorePropagationData',
  'codePage',
  'countryCode',
  'primaryGroupID',
  // Promoted into the typed Identity / Location grids:
  'employeeID',
  'employeeNumber',
  'ipPhone',
  'homePhone',
  'homePostalAddress',
  'description',
  'company',
  'c',
  'co',
  'l',
  'st',
  'postalCode',
  'otherMailbox',
  'otherHomePhone',
  'otherMobile',
  // Rendered by their own sections:
  'proxyAddresses',
  'directReports',
  // Surfaced as the "Privileged" hero badge — hide from the raw extras grid.
  'adminCount',
]);

interface AttrRow {
  key: string;
  values: string[];
}

function valuesOf(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : String(x))).filter((s) => s.length > 0);
  }
  if (typeof v === 'string') return v.length > 0 ? [v] : [];
  return [String(v)];
}

type ScalarKey =
  | 'displayName'
  | 'givenName'
  | 'surname'
  | 'email'
  | 'phone'
  | 'mobile'
  | 'title'
  | 'department'
  | 'employeeID'
  | 'employeeNumber'
  | 'ipPhone'
  | 'homePhone'
  | 'homePostalAddress'
  | 'description'
  | 'company'
  | 'c'
  | 'co'
  | 'l'
  | 'st'
  | 'postalCode';

type ArrayKey = 'otherMailbox' | 'otherHomePhone' | 'otherMobile';
type EditableKey = ScalarKey | ArrayKey;
type FieldView = 'organization' | 'contact';

// Sub-sections within Organization and Contact tabs. Each section is a
// labelled block so the form reads as a narrative.
//   organization → person · ids · job
//   contact      → email  · phones · address
type SectionKey = 'person' | 'ids' | 'job' | 'email' | 'phones' | 'address';

const VIEW_SECTIONS: Record<FieldView, SectionKey[]> = {
  organization: ['person', 'ids', 'job'],
  contact: ['email', 'phones', 'address'],
};

const SECTION_LABEL: Record<SectionKey, string> = {
  person: 'Person',
  ids: 'Identifiers',
  job: 'Job',
  email: 'Email',
  phones: 'Phones',
  address: 'Address',
};

interface ScalarField {
  key: ScalarKey;
  label: string;
  view: FieldView;
  section: SectionKey;
  type?: 'email' | 'tel' | 'text';
  mono?: boolean;
  // Render with a Textarea instead of InputText. Used for paragraph-style
  // values (description, homePostalAddress) where a single-line input
  // truncates the visible content.
  multiline?: boolean;
}

interface ArrayField {
  key: ArrayKey;
  label: string;
  placeholder: string;
  section: SectionKey;
}

const SCALAR_FIELDS: ScalarField[] = [
  // Organization → Person ---------------------------------------------
  { key: 'displayName', label: 'Display name', view: 'organization', section: 'person' },
  { key: 'givenName', label: 'First name', view: 'organization', section: 'person' },
  { key: 'surname', label: 'Last name', view: 'organization', section: 'person' },
  {
    key: 'description',
    label: 'Description',
    multiline: true,
    view: 'organization',
    section: 'person',
  },
  // Organization → Identifiers ----------------------------------------
  { key: 'employeeID', label: 'Employee ID', mono: true, view: 'organization', section: 'ids' },
  {
    key: 'employeeNumber',
    label: 'Employee number',
    mono: true,
    view: 'organization',
    section: 'ids',
  },
  // Organization → Job ------------------------------------------------
  { key: 'title', label: 'Title', view: 'organization', section: 'job' },
  { key: 'department', label: 'Department', view: 'organization', section: 'job' },
  { key: 'company', label: 'Company', view: 'organization', section: 'job' },
  // Contact → Email ---------------------------------------------------
  {
    key: 'email',
    label: 'Primary email',
    type: 'email',
    mono: true,
    view: 'contact',
    section: 'email',
  },
  // Contact → Phones --------------------------------------------------
  {
    key: 'phone',
    label: 'Work phone',
    type: 'tel',
    mono: true,
    view: 'contact',
    section: 'phones',
  },
  { key: 'mobile', label: 'Mobile', type: 'tel', mono: true, view: 'contact', section: 'phones' },
  {
    key: 'homePhone',
    label: 'Home phone',
    type: 'tel',
    mono: true,
    view: 'contact',
    section: 'phones',
  },
  {
    key: 'ipPhone',
    label: 'IP phone',
    type: 'tel',
    mono: true,
    view: 'contact',
    section: 'phones',
  },
  // Contact → Address -------------------------------------------------
  { key: 'l', label: 'City', view: 'contact', section: 'address' },
  { key: 'st', label: 'State / Province', view: 'contact', section: 'address' },
  { key: 'postalCode', label: 'Postal code', view: 'contact', section: 'address' },
  { key: 'c', label: 'Country code', mono: true, view: 'contact', section: 'address' },
  { key: 'co', label: 'Country', view: 'contact', section: 'address' },
  {
    key: 'homePostalAddress',
    label: 'Home address',
    multiline: true,
    view: 'contact',
    section: 'address',
  },
];

function scalarFieldsForSection(s: SectionKey): ScalarField[] {
  return SCALAR_FIELDS.filter((f) => f.section === s);
}

const ARRAY_FIELDS: ArrayField[] = [
  {
    key: 'otherMailbox',
    label: 'Personal email',
    placeholder: 'one address per line',
    section: 'email',
  },
  {
    key: 'otherMobile',
    label: 'Other mobiles',
    placeholder: 'one number per line',
    section: 'phones',
  },
  {
    key: 'otherHomePhone',
    label: 'Other home phones',
    placeholder: 'one number per line',
    section: 'phones',
  },
];

function arrayFieldsForSection(s: SectionKey): ArrayField[] {
  return ARRAY_FIELDS.filter((f) => f.section === s);
}

const props = defineProps<{ id: string }>();
const auth = useAuthStore();
const toast = useToast();

const user = ref<UserDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const refreshing = ref(false);
const saving = ref(false);
const activeTab = ref<TabId>('overview');
const rawFilter = ref('');

// Drives the compact-on-scroll hero. `setHero` is bound to the hero
// section's :ref; the composable then wires a scroll listener on the
// nearest scroll ancestor and a ResizeObserver on the hero.
// `heroCompact` flips when the operator scrolls; `heroHeight` tracks
// the rendered height so the tab bar's sticky offset can follow the
// hero's bottom edge mid-animation.
const { setHero, compact: heroCompact, heroHeight } = useStickyHeader();
const { setNav: setTabsNav, compact: tabsCompact } = useCompactTabs();

// Capability flags. The Edit toggle handles "are you elevated"; the
// capability flags decide whether each action surface is offered at all.
const canUnlock = computed(() => auth.hasCapability('write:user.unlock'));
const canEdit = computed(() => auth.hasCapability('write:user.attributes'));
const canEnableDisable = computed(() => auth.hasCapability('write:user.enableDisable'));
const canResetPassword = computed(() => auth.hasCapability('write:user.resetPassword'));
const canManageGroups = computed(() => auth.hasCapability('write:group.membership'));
const canMove = computed(() => auth.hasCapability('write:user.move'));
// Raw LDAP tab is admin-only — gated by view:raw_attributes (admin role
// gets all caps, operator/auditor explicitly do not).
const canViewRaw = computed(() => auth.hasCapability('view:raw_attributes'));

// Per-user activity feed. Auto-loaded on user load to populate the
// Overview "Recent activity" card. Fetches a small page (10) since the
// dedicated Admin actions tab was removed; only the top 5 are shown.
const activityEvents = ref<AuditEventRow[]>([]);
const activityLoading = ref(false);
const activityLoaded = ref(false);
const activityError = ref<string | null>(null);

async function loadActivity(): Promise<void> {
  if (!user.value || activityLoading.value) return;
  activityLoading.value = true;
  activityError.value = null;
  try {
    const r = await api.users.activity(user.value.id, 10);
    activityEvents.value = r.rows;
    activityLoaded.value = true;
  } catch (err) {
    activityError.value = err instanceof Error ? err.message : 'Failed to load activity';
  } finally {
    activityLoading.value = false;
  }
}

// Attribute-edit form state. Scalar fields are stored verbatim. Multi-valued
// fields (otherMailbox etc.) are stored as a single newline-delimited string
// that the textarea v-models against, then split on save.
const form = reactive<Record<EditableKey, string>>({
  displayName: '',
  givenName: '',
  surname: '',
  email: '',
  phone: '',
  mobile: '',
  title: '',
  department: '',
  employeeID: '',
  employeeNumber: '',
  ipPhone: '',
  homePhone: '',
  homePostalAddress: '',
  description: '',
  company: '',
  c: '',
  co: '',
  l: '',
  st: '',
  postalCode: '',
  otherMailbox: '',
  otherHomePhone: '',
  otherMobile: '',
});

function parseLines(s: string): string[] {
  return s
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function resetForm(): void {
  if (!user.value) return;
  for (const f of SCALAR_FIELDS) {
    form[f.key] = user.value[f.key] ?? '';
  }
  for (const f of ARRAY_FIELDS) {
    form[f.key] = (user.value[f.key] ?? []).join('\n');
  }
}

// Each dirty entry carries the field key plus the canonical patch value the
// API expects: a string|null for scalars, a string[]|null for arrays.
type DirtyEntry =
  | { key: ScalarKey; kind: 'scalar'; from: string | null; to: string | null }
  | { key: ArrayKey; kind: 'array'; from: string[]; to: string[] };

const dirtyFields = computed<DirtyEntry[]>(() => {
  if (!user.value) return [];
  const changed: DirtyEntry[] = [];
  for (const f of SCALAR_FIELDS) {
    const original = user.value[f.key] ?? null;
    const draft = form[f.key].trim();
    const next = draft === '' ? null : draft;
    if (next !== original) changed.push({ key: f.key, kind: 'scalar', from: original, to: next });
  }
  for (const f of ARRAY_FIELDS) {
    const original = user.value[f.key] ?? [];
    const next = parseLines(form[f.key]);
    if (!arraysEqual(original, next)) {
      changed.push({ key: f.key, kind: 'array', from: original, to: next });
    }
  }
  return changed;
});

const isDirty = computed(() => dirtyFields.value.length > 0);

// Quick membership lookup so per-field templates can highlight modified
// values without iterating dirtyFields each time.
const dirtyFieldKeys = computed(() => new Set(dirtyFields.value.map((d) => d.key as string)));

const displayName = computed(() => user.value?.displayName ?? user.value?.samAccountName ?? '—');
const subtitle = computed(() => {
  const u = user.value;
  if (!u) return '';
  return [u.title, u.department].filter(Boolean).join(' · ');
});

// Photo URL from the Entra integration. Null when no photo is cached
// for this user — the photoCache writes either bytes-with-absent=false
// or absent=true, and `hasPhoto` reflects the former. The Avatar
// primitive falls back to initials on a 404 either way; we gate up-front
// so an unconfigured integration doesn't fire 404s for every rendered
// user.
const photoUrl = computed(() => {
  const u = user.value;
  if (!u || !u.hasPhoto) return null;
  const dirId = auth.actor?.directoryId;
  if (!dirId) return null;
  return api.directories.entra.photoUrl(dirId, u.id);
});

// Selected sign-in event for the detail modal. Set when the user
// clicks a row in the Sign-ins tab; cleared when the modal closes.
const signInDialogOpen = ref(false);
const signInDialogEventId = ref<string | null>(null);
function onSignInSelect(id: string): void {
  signInDialogEventId.value = id;
  signInDialogOpen.value = true;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  // Stale activity cache from a previous user — clear so the Overview card
  // re-fetches against the new user on next load.
  activityLoaded.value = false;
  activityEvents.value = [];
  try {
    const resp = await api.users.get(props.id);
    user.value = resp.user;
    resetForm();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      error.value = 'User not found';
    } else {
      error.value = err instanceof Error ? err.message : 'Failed to load user';
    }
  } finally {
    loading.value = false;
  }
}

async function refreshFromAd(): Promise<void> {
  // The backend's GET /api/users/:id always live-refreshes against AD before
  // responding, so reusing `load()` is a sync of just this user.
  refreshing.value = true;
  try {
    await load();
    toast.add({ severity: 'success', summary: 'Refreshed from directory', life: 2500 });
  } finally {
    refreshing.value = false;
  }
}

watch(() => props.id, load);
onMounted(load);

// ---- Navigation / unload guard ------------------------------------------
//
// Stop the operator from navigating away (back button, sidebar click, tab
// close) when there are unsaved field edits in the buffer. Vue Router's
// onBeforeRouteLeave handles in-app nav; the matching beforeunload listener
// covers full page unloads.

onBeforeRouteLeave((_to, _from) => {
  if (!isDirty.value) return true;
  const ok = window.confirm(
    `You have ${dirtyFields.value.length} unsaved change${dirtyFields.value.length === 1 ? '' : 's'}. Leave anyway?`,
  );
  return ok;
});

function onBeforeUnload(ev: BeforeUnloadEvent): void {
  if (!isDirty.value) return;
  ev.preventDefault();
  // Modern browsers ignore the message string but require returnValue set.
  ev.returnValue = '';
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

// When edit mode flips off (manually or via TTL expiry), discard any
// unsaved drafts. Without this, fields that no longer have a save button
// would still display stale draft text. We pop a quiet toast only if we
// actually had to throw something away.
//
// One important exception: when the server signals step_up_required during
// a save, the auth store flips elevated → false to drive the prompt. That
// looks like "edit mode ended" to this watcher, but the operator's intent
// is mid-flight — they clicked Save, are about to re-enter their password,
// and expect the edits to still be there when the dialog clears. Skipping
// reset+toast on that path keeps the form populated so the queued retry
// (in saveAttributes' catch) submits the same patch.
watch(
  () => auth.editMode,
  (now, prev) => {
    if (prev && !now) {
      if (auth.stepUpRequested) return;
      if (isDirty.value) {
        toast.add({
          severity: 'info',
          summary: 'Unsaved changes discarded',
          detail: 'Edit mode ended before you saved.',
          life: 3500,
        });
      }
      resetForm();
    }
  },
);

// ---- Attribute save / discard --------------------------------------------

async function saveAttributes(): Promise<void> {
  if (!user.value || !isDirty.value) return;
  saving.value = true;
  try {
    const patch: NonNullable<UserUpdateRequest['patch']> = {};
    for (const d of dirtyFields.value) {
      // The patch type is a discriminated union per field. A loose record
      // cast here keeps the dispatch readable; the server validates each
      // value's shape via the zod schema.
      const bag = patch as Record<string, string | null | string[]>;
      if (d.kind === 'scalar') {
        bag[d.key] = d.to;
      } else {
        // Send null for empty arrays so the server deletes the attribute
        // outright rather than receiving a no-op replace.
        bag[d.key] = d.to.length === 0 ? null : d.to;
      }
    }
    await api.users.update(user.value.id, { patch });
    toast.add({
      severity: 'success',
      summary: 'Attributes saved',
      detail: `${dirtyFields.value.length} field${dirtyFields.value.length === 1 ? '' : 's'} updated`,
      life: 3000,
    });
    await load();
  } catch (err) {
    // Step-up required: the API client's global handler already opened
    // the StepUpDialog. Queue this very save as the retry so a successful
    // re-auth submits the same patch — the operator should not have to
    // re-enter edits or click Save a second time. No toast: the dialog
    // is the operator-visible affordance.
    if (err instanceof ApiError && err.code === 'step_up_required') {
      auth.stepUpPendingAction = saveAttributes;
      return;
    }
    toast.add({
      severity: 'error',
      summary: 'Save failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    saving.value = false;
  }
}

function discardAttributes(): void {
  resetForm();
}

// ---- Hero actions (unlock / enable / disable) ----------------------------

const actionRunning = ref<'unlock' | 'enable' | 'disable' | 'move' | null>(null);

async function doUnlock(): Promise<void> {
  if (!user.value) return;
  actionRunning.value = 'unlock';
  // Snapshot the lock context before the call so the toast can mention it
  // even though the post-unlock reload clears the fields.
  const wasLockedAt = user.value.lockedAt;
  const wouldHaveAutoUnlockedAt = user.value.autoUnlockAt;
  try {
    await api.users.unlock(user.value.id);
    const detailParts: string[] = [
      `${user.value.displayName ?? user.value.samAccountName} can sign in now.`,
    ];
    if (wasLockedAt) {
      detailParts.push(`Was locked at ${fmtAbsolute(wasLockedAt)}.`);
    }
    if (wouldHaveAutoUnlockedAt) {
      detailParts.push(`Would have auto-unlocked at ${fmtAbsolute(wouldHaveAutoUnlockedAt)}.`);
    }
    toast.add({
      severity: 'success',
      summary: 'Account unlocked',
      detail: detailParts.join(' '),
      life: 5000,
    });
    await load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Unlock failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    actionRunning.value = null;
  }
}

async function doToggleEnabled(disable: boolean): Promise<void> {
  if (!user.value) return;
  actionRunning.value = disable ? 'disable' : 'enable';
  try {
    if (disable) await api.users.disable(user.value.id);
    else await api.users.enable(user.value.id);
    toast.add({
      severity: 'success',
      summary: disable ? 'Account disabled' : 'Account enabled',
      life: 3000,
    });
    await load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: disable ? 'Disable failed' : 'Enable failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    actionRunning.value = null;
  }
}

// ---- Reset password dialog ------------------------------------------------

const resetDialogOpen = ref(false);
const resetDraft = ref({ newPassword: '', forceChangeAtNextLogin: true });
const resetSubmitting = ref(false);
const resetError = ref<string | null>(null);

function openResetDialog(): void {
  resetDraft.value = { newPassword: '', forceChangeAtNextLogin: true };
  resetError.value = null;
  resetDialogOpen.value = true;
}

async function onResetSubmit(): Promise<void> {
  if (!user.value) return;
  resetError.value = null;
  if (resetDraft.value.newPassword.length < 8) {
    resetError.value = 'New password must be at least 8 characters';
    return;
  }
  resetSubmitting.value = true;
  try {
    await api.users.resetPassword(user.value.id, {
      newPassword: resetDraft.value.newPassword,
      forceChangeAtNextLogin: resetDraft.value.forceChangeAtNextLogin,
    });
    toast.add({
      severity: 'success',
      summary: 'Password reset',
      detail: resetDraft.value.forceChangeAtNextLogin
        ? 'User must change at next sign-in'
        : 'New password is in effect',
      life: 4000,
    });
    resetDialogOpen.value = false;
    await load();
  } catch (err) {
    resetError.value = err instanceof ApiError ? err.message : 'reset failed';
  } finally {
    resetSubmitting.value = false;
  }
}

// ---- Move to OU ----------------------------------------------------------

const moveDialogOpen = ref(false);
const moveSubmitting = ref(false);
const moveError = ref<string | null>(null);
// PrimeVue TreeSelect uses a record keyed by node `key` for selection state.
// We always operate on a single OU, so the record will have at most one entry.
const moveSelection = ref<Record<string, boolean>>({});
// Loaded once when the dialog opens. Tree is rebuilt reactively from this.
const moveOus = ref<
  { distinguishedName: string; name: string; parentDn: string | null; stale: boolean }[]
>([]);
const moveOusLoading = ref(false);

// Current parent OU of the loaded user (null while no user / DN can't be split).
const currentOuDn = computed<string | null>(() => {
  const dn = user.value?.distinguishedName;
  if (!dn) return null;
  // Same comma-aware split the API uses; duplicated here so we don't need a
  // server round-trip just to compute the parent.
  let i = 0;
  while (i < dn.length) {
    const ch = dn[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === ',') return dn.slice(i + 1).trim() || null;
    i++;
  }
  return null;
});

// Build a PrimeVue TreeNode forest from the flat OU list. OUs whose
// `parentDn` is unknown to us (e.g. the directory root, or a non-OU
// container) become roots of the tree.
const moveOuTree = computed<TreeNode[]>(() => {
  const all = moveOus.value;
  if (all.length === 0) return [];
  const byDn = new Map<string, TreeNode & { children: TreeNode[] }>();
  for (const ou of all) {
    byDn.set(ou.distinguishedName.toLowerCase(), {
      key: ou.distinguishedName,
      label: ou.name,
      data: { dn: ou.distinguishedName, stale: ou.stale },
      icon: 'pi pi-folder',
      children: [],
    });
  }
  const roots: TreeNode[] = [];
  for (const ou of all) {
    const node = byDn.get(ou.distinguishedName.toLowerCase())!;
    const parentKey = ou.parentDn?.toLowerCase();
    const parent = parentKey ? byDn.get(parentKey) : undefined;
    if (parent) parent.children!.push(node);
    else roots.push(node);
  }
  // Sort each level alphabetically by label.
  const sortRec = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
    for (const n of nodes) if (n.children) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
});

const selectedTargetDn = computed<string | null>(() => {
  const keys = Object.keys(moveSelection.value).filter((k) => moveSelection.value[k]);
  return keys[0] ?? null;
});

const moveTargetIsCurrent = computed(() => {
  const target = selectedTargetDn.value;
  const current = currentOuDn.value;
  return target !== null && current !== null && target.toLowerCase() === current.toLowerCase();
});

async function openMoveDialog(): Promise<void> {
  moveError.value = null;
  moveSelection.value = {};
  moveDialogOpen.value = true;
  if (moveOus.value.length === 0) {
    moveOusLoading.value = true;
    try {
      const resp = await api.ous.list();
      moveOus.value = resp.ous;
    } catch (err) {
      moveError.value = err instanceof ApiError ? err.message : 'failed to load OUs';
    } finally {
      moveOusLoading.value = false;
    }
  }
  // Pre-select the user's current OU so the operator can see where they are
  // before picking a destination. The TreeSelect renders its parent chain
  // expanded automatically when a key is preselected.
  const cur = currentOuDn.value;
  if (cur) moveSelection.value = { [cur]: true };
}

async function onMoveSubmit(): Promise<void> {
  if (!user.value) return;
  const target = selectedTargetDn.value;
  if (!target) {
    moveError.value = 'pick a destination OU';
    return;
  }
  if (moveTargetIsCurrent.value) {
    moveError.value = 'user is already in that OU';
    return;
  }
  moveError.value = null;
  moveSubmitting.value = true;
  actionRunning.value = 'move';
  try {
    await api.users.move(user.value.id, { targetOuDn: target });
    toast.add({
      severity: 'success',
      summary: 'User moved',
      detail: `Now under ${target}`,
      life: 4000,
    });
    moveDialogOpen.value = false;
    await load();
  } catch (err) {
    moveError.value = err instanceof ApiError ? err.message : 'move failed';
  } finally {
    moveSubmitting.value = false;
    actionRunning.value = null;
  }
}

// ---- Group membership: remove + add --------------------------------------

const groupBusy = ref<string | null>(null);

// Removing a group is destructive and a single click on the chip's "x" was
// too easy to trigger by accident. Funnel removals through a confirmation
// dialog with an explicit Cancel/Remove choice.
const removeConfirm = ref<{ groupId: string; label: string } | null>(null);

function requestRemoveGroup(groupId: string, label: string): void {
  if (!user.value || groupBusy.value !== null) return;
  removeConfirm.value = { groupId, label };
}

function cancelRemoveGroup(): void {
  removeConfirm.value = null;
}

async function confirmRemoveGroup(): Promise<void> {
  const pending = removeConfirm.value;
  if (!pending || !user.value) return;
  groupBusy.value = pending.groupId;
  try {
    await api.users.removeGroup(user.value.id, { groupId: pending.groupId });
    toast.add({ severity: 'success', summary: `Removed from ${pending.label}`, life: 3000 });
    removeConfirm.value = null;
    await load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Remove failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    groupBusy.value = null;
  }
}

const addGroupOpen = ref(false);
const groupSearchQuery = ref('');
const groupSearchResults = ref<GroupSummary[]>([]);
const groupSearchLoading = ref(false);
let groupSearchTimer: ReturnType<typeof setTimeout> | undefined;

function openAddGroupDialog(): void {
  groupSearchQuery.value = '';
  groupSearchResults.value = [];
  addGroupOpen.value = true;
}

watch(groupSearchQuery, (q) => {
  if (groupSearchTimer) clearTimeout(groupSearchTimer);
  if (q.trim().length < 2) {
    groupSearchResults.value = [];
    return;
  }
  groupSearchTimer = setTimeout(async () => {
    groupSearchLoading.value = true;
    try {
      const resp = await api.groups.search({ q: q.trim(), pageSize: 12 });
      groupSearchResults.value = resp.rows;
    } catch {
      groupSearchResults.value = [];
    } finally {
      groupSearchLoading.value = false;
    }
  }, 200);
});

async function doAddGroup(group: GroupSummary): Promise<void> {
  if (!user.value) return;
  groupBusy.value = group.id;
  try {
    await api.users.addGroup(user.value.id, { groupId: group.id });
    toast.add({ severity: 'success', summary: `Added to ${group.name}`, life: 3000 });
    addGroupOpen.value = false;
    await load();
  } catch (err) {
    toast.add({
      severity: 'error',
      summary: 'Add failed',
      detail: err instanceof ApiError ? err.message : String(err),
      life: 6000,
    });
  } finally {
    groupBusy.value = null;
  }
}

const existingGroupIds = computed(
  () => new Set((user.value?.groupMemberships ?? []).map((g) => g.id)),
);

// Filter + alphabetical sort + direct/inherited split for the Groups tab.
// AD returns memberships in arbitrary order; sorting by display name keeps
// the layout stable across syncs and makes specific groups easier to find.
const groupFilter = ref('');

const groupsSorted = computed(() => {
  const list = user.value?.groupMemberships ?? [];
  return [...list].sort((a, b) => {
    const an = (a.name || a.distinguishedName).toLowerCase();
    const bn = (b.name || b.distinguishedName).toLowerCase();
    return an.localeCompare(bn);
  });
});

const groupsFiltered = computed(() => {
  const q = groupFilter.value.trim().toLowerCase();
  if (!q) return groupsSorted.value;
  return groupsSorted.value.filter((g) => {
    const name = (g.name || g.distinguishedName).toLowerCase();
    return name.includes(q) || g.distinguishedName.toLowerCase().includes(q);
  });
});

const groupsDirect = computed(() => groupsFiltered.value.filter((g) => g.direct));
const groupsInherited = computed(() => groupsFiltered.value.filter((g) => !g.direct));

// ---- Raw / extra attributes ---------------------------------------------

// Sorted list of every populated raw attribute, normalized to AttrRow.
// Used to drive both the Identity "More from directory" grid (filtered to
// not duplicate handled fields) and the Raw LDAP tab (everything).
const rawAttrRows = computed<AttrRow[]>(() => {
  const raw = user.value?.rawAttributes;
  if (!raw) return [];
  const rows: AttrRow[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const values = valuesOf(v);
    if (values.length === 0) continue;
    rows.push({ key: k, values });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return rows;
});

const extraAttrRows = computed<AttrRow[]>(() =>
  rawAttrRows.value.filter((r) => !HANDLED_ATTRS.has(r.key)),
);

const filteredRawRows = computed<AttrRow[]>(() => {
  const q = rawFilter.value.trim().toLowerCase();
  if (!q) return rawAttrRows.value;
  return rawAttrRows.value.filter((r) => {
    if (r.key.toLowerCase().includes(q)) return true;
    return r.values.some((v) => v.toLowerCase().includes(q));
  });
});

// ---- Hero launcher links -------------------------------------------------

const mailtoHref = computed(() => (user.value?.email ? `mailto:${user.value.email}` : null));
// `msteams:/l/chat/0/0?users=…` is the documented deep-link form. Browsers
// hand this off to the OS handler — the same way `mailto:` does — so
// clicking opens the Teams desktop app (or prompts to open it).
const teamsHref = computed(() =>
  user.value?.email ? `msteams:/l/chat/0/0?users=${encodeURIComponent(user.value.email)}` : null,
);

// Render a DN with the leading `CN=…` segment stripped so it doesn't repeat
// the heading. Falls back to the full DN if the CN doesn't match the
// displayed name.
const dnPath = computed(() => {
  const dn = user.value?.distinguishedName ?? '';
  if (!dn) return '';
  const m = /^CN=([^,]+),(.*)$/i.exec(dn);
  if (!m) return dn;
  const cn = m[1]!.replace(/\\,/g, ',');
  const rest = m[2]!;
  const heading = (user.value?.displayName ?? user.value?.samAccountName ?? '').trim();
  return cn === heading ? rest : dn;
});

// Actions dropdown — replaces the row of action buttons that used to live
// under the hero. Items are still rendered when edit mode is off so the
// operator can see what's available, but they're disabled until editing
// is unlocked (matching the previous button behavior).
const actionsMenu = ref<InstanceType<typeof Menu> | null>(null);

function toggleActionsMenu(event: Event): void {
  actionsMenu.value?.toggle(event);
}

const actionItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [];
  const u = user.value;
  if (!u) return items;
  // Buttons stay clickable whether or not edit mode is on — `auth.requireEdit`
  // pops the StepUpDialog for an unauthenticated operator and auto-fires the
  // action after they authenticate. The only disable case is "an action of
  // this kind is already running" so the operator can't double-fire.
  const busy = actionRunning.value !== null;

  if (canUnlock.value && u.locked) {
    items.push({
      label: actionRunning.value === 'unlock' ? 'Unlocking…' : 'Unlock account',
      icon: 'pi pi-unlock',
      disabled: busy,
      command: () => auth.requireEdit(doUnlock),
    });
  }
  if (canResetPassword.value) {
    items.push({
      label: 'Reset password…',
      icon: 'pi pi-key',
      class: 'menu-item-danger',
      command: () => auth.requireEdit(openResetDialog),
    });
  }
  if (canEnableDisable.value) {
    if (u.enabled) {
      items.push({
        label: actionRunning.value === 'disable' ? 'Disabling…' : 'Disable account',
        icon: 'pi pi-ban',
        class: 'menu-item-danger',
        disabled: busy,
        command: () => auth.requireEdit(() => doToggleEnabled(true)),
      });
    } else {
      items.push({
        label: actionRunning.value === 'enable' ? 'Enabling…' : 'Enable account',
        icon: 'pi pi-check',
        disabled: busy,
        command: () => auth.requireEdit(() => doToggleEnabled(false)),
      });
    }
  }
  if (canMove.value) {
    items.push({
      label: actionRunning.value === 'move' ? 'Moving…' : 'Move to OU…',
      icon: 'pi pi-folder-open',
      disabled: busy,
      command: () => auth.requireEdit(openMoveDialog),
    });
  }
  return items;
});

// Render the user's location as a proper postal address: the city/state/postal
// code on one line, country on the next. Empty parts are dropped — values are
// trimmed first so a stray empty string from AD doesn't turn into ", ,".
function addressLines(u: UserDetail | null): string[] {
  if (!u) return [];
  const trim = (s: string | null | undefined): string | null => {
    const v = (s ?? '').trim();
    return v.length > 0 ? v : null;
  };
  const lines: string[] = [];
  const cityState = [trim(u.l), trim(u.st)].filter(Boolean).join(', ');
  const line1 = [cityState, trim(u.postalCode)].filter(Boolean).join(' ');
  if (line1) lines.push(line1);
  const country = trim(u.co);
  if (country) lines.push(country);
  return lines;
}

const overviewLocation = computed(() => addressLines(user.value));

// Tab specs drive the nav rendering so we can hide capability-gated tabs
// without scattering v-ifs across the template.
interface TabSpec {
  id: TabId;
  label: string;
  icon: string; // PrimeIcon variant class, e.g. 'pi-th-large'
  count?: number;
  visible: boolean;
  // When true, the tab always renders icon-only (label hidden, native
  // tooltip on hover). Used for tabs whose icon is universal enough to
  // stand on its own — Overview and Debug — so the bar has more room
  // for word labels on the more ambiguous tabs.
  iconOnly?: boolean;
}
const tabs = computed<TabSpec[]>(() => {
  const u = user.value;
  const list: TabSpec[] = [
    { id: 'overview', label: 'Overview', icon: 'pi-th-large', visible: true, iconOnly: true },
    { id: 'organization', label: 'Organization', icon: 'pi-sitemap', visible: true },
    { id: 'contact', label: 'Contact', icon: 'pi-envelope', visible: true },
    { id: 'account', label: 'Account', icon: 'pi-id-card', visible: true },
  ];
  const groupsTab: TabSpec = {
    id: 'groups',
    label: 'Groups',
    icon: 'pi-users',
    visible: true,
  };
  if (u) groupsTab.count = u.groupMemberships.length;
  list.push(groupsTab);
  // Sign-ins is conditional on an Entra integration. We use the same
  // `entra` field the response carries when integration is enabled —
  // null = not configured, so the tab disappears entirely.
  list.push({
    id: 'signins',
    label: 'Sign-ins',
    icon: 'pi-sign-in',
    visible: !!u?.entra,
  });
  list.push({
    id: 'raw',
    label: 'Debug',
    icon: 'pi-code',
    visible: canViewRaw.value,
    iconOnly: true,
  });
  return list;
});

// If the active tab gets hidden (e.g. capability changes), fall back to overview
watch(tabs, (list) => {
  if (!list.find((t) => t.id === activeTab.value && t.visible)) {
    activeTab.value = 'overview';
  }
});

// First N groups for the Overview summary
const groupsTop = computed(() => (user.value?.groupMemberships ?? []).slice(0, 5));
const activityTop = computed(() => activityEvents.value.slice(0, 5));

// Auto-load a few recent events for the Overview card on first user load
watch(user, (u) => {
  if (u && !activityLoaded.value && !activityLoading.value) void loadActivity();
});

const copied = ref<{ email: boolean; dn: boolean }>({ email: false, dn: false });
async function copy(kind: 'email' | 'dn'): Promise<void> {
  const u = user.value;
  if (!u) return;
  const text = kind === 'email' ? (u.email ?? '') : u.distinguishedName;
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
</script>

<template>
  <Toast />
  <div class="page-inner detail-page" :style="{ '--detail-sticky-offset': `${heroHeight}px` }">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div v-if="user" class="detail-stack">
      <!-- Hero. Two-column layout: avatar + identity + identifier line +
           launchers + DN, with a compact meta strip on the right. Actions
           live on the tab bar (not here) so the hero stays focused on
           "who is this" rather than "what can I do." -->
      <section :ref="setHero" class="detail-hero" :class="{ 'is-compact': heroCompact }">
        <Avatar
          :name="user.displayName ?? user.samAccountName"
          :seed="user.samAccountName"
          :size="heroCompact ? 28 : 80"
          :photo-url="photoUrl"
        />

        <div class="detail-hero-main">
          <div class="detail-hero-row">
            <h1 class="detail-hero-name">{{ displayName }}</h1>
            <StatusBadge :user="user" size="lg" />
            <span
              v-if="user.isPrivileged"
              class="badge badge-amber badge-lg"
              title="AD adminCount=1 — this account is or was a member of a protected group. AD does not clear adminCount automatically when removed, so verify current group memberships before relying on this."
            >
              <i class="pi pi-shield" /> privileged
            </span>
            <span
              v-if="user.passwordNeverExpires"
              class="badge badge-violet badge-lg"
              title="DONT_EXPIRE_PASSWORD set"
            >
              <i class="pi pi-shield" /> never expires
            </span>
            <span v-if="user.freshness.isStale" class="badge badge-amber badge-lg stale-flag">
              <span class="badge-dot" /> Cache stale
            </span>
          </div>

          <div v-if="subtitle" class="detail-hero-title">{{ subtitle }}</div>

          <!-- Primary identifier line. Prefers the email; falls back
               to UPN/SAM only when no email is set. -->
          <button
            v-if="user.email"
            type="button"
            class="copybtn copybtn-inline"
            :title="copied.email ? 'Copied!' : 'Copy email'"
            @click="copy('email')"
          >
            <i :class="copied.email ? 'pi pi-check' : 'pi pi-copy'" />
            <span class="mono">{{ user.email }}</span>
          </button>
          <div v-else class="detail-hero-upn mono">
            {{ user.userPrincipalName ?? user.samAccountName }}
          </div>

          <!-- Email / Teams launchers + DN copy live on a single row to
               keep the hero tight. -->
          <div class="detail-hero-actions-row">
            <a v-if="mailtoHref" class="copybtn launcher" :href="mailtoHref" title="Send email">
              <i class="pi pi-envelope" />
              <span>Email</span>
            </a>
            <a v-if="teamsHref" class="copybtn launcher" :href="teamsHref" title="Open Teams chat">
              <i class="pi pi-comments" />
              <span>Teams</span>
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
      </section>

      <!-- Tabs. Actions menu lives at the right end of the bar so it's
           always one click away regardless of which tab is active. The
           menu items themselves stay disabled until edit mode is on,
           which provides the "you need to enable editing" affordance
           without an extra hint chip. -->
      <nav
        :ref="setTabsNav"
        class="ds-tabs ds-tabs-with-actions"
        :class="{ compact: tabsCompact, 'hero-compact': heroCompact }"
        role="tablist"
      >
        <button
          v-for="t in tabs.filter((t) => t.visible)"
          :key="t.id"
          type="button"
          role="tab"
          class="ds-tab"
          :class="{ active: activeTab === t.id, 'icon-only': t.iconOnly }"
          :aria-selected="activeTab === t.id"
          :title="tabsCompact || t.iconOnly ? t.label : undefined"
          :aria-label="t.label"
          @click="activeTab = t.id"
        >
          <i :class="['pi', t.icon]" aria-hidden="true" />
          <span class="ds-tab-label">{{ t.label }}</span>
          <span v-if="t.count !== undefined" class="ds-tab-count mono">{{ t.count }}</span>
        </button>
        <div class="ds-tabs-spacer" />
        <Button
          icon="pi pi-refresh"
          text
          severity="secondary"
          size="small"
          :loading="refreshing"
          title="Refresh from directory"
          class="ds-tabs-refresh"
          @click="refreshFromAd"
        />
        <div v-if="auth.canEverWrite && actionItems.length > 0" class="ds-tabs-actions">
          <Button
            label="Actions"
            icon="pi pi-chevron-down"
            icon-pos="right"
            severity="secondary"
            text
            size="small"
            :loading="actionRunning !== null"
            aria-haspopup="true"
            aria-controls="user-actions-menu"
            @click="toggleActionsMenu"
          />
          <Menu id="user-actions-menu" ref="actionsMenu" :model="actionItems" :popup="true" />
        </div>
      </nav>

      <!-- Overview — at-a-glance summary that aggregates the most-asked-about
           pieces from each detail tab so the operator does not have to hunt. -->
      <div v-if="activeTab === 'overview'" class="detail-grid">
        <Card title="Organization">
          <dl class="kv-grid">
            <dt class="fld-label">Title</dt>
            <dd>{{ user.title ?? '—' }}</dd>
            <dt class="fld-label">Department</dt>
            <dd>{{ user.department ?? '—' }}</dd>
            <dt class="fld-label">Company</dt>
            <dd>{{ user.company ?? '—' }}</dd>
            <dt class="fld-label">Manager</dt>
            <dd>
              <router-link
                v-if="user.manager?.id"
                :to="{ name: 'user-detail', params: { id: user.manager.id } }"
                class="reports-link"
              >
                <i class="pi pi-user" />
                <span>{{ user.manager.displayName ?? user.manager.distinguishedName }}</span>
              </router-link>
              <span v-else-if="user.manager">{{
                user.manager.displayName ?? user.manager.distinguishedName
              }}</span>
              <span v-else>—</span>
            </dd>
          </dl>
        </Card>

        <Card title="Contact">
          <dl class="kv-grid">
            <dt class="fld-label">Email</dt>
            <dd class="mono kv-wrap">{{ user.email ?? '—' }}</dd>
            <dt class="fld-label">Mobile</dt>
            <dd class="mono">{{ user.mobile ?? '—' }}</dd>
            <dt class="fld-label">Work phone</dt>
            <dd class="mono">{{ user.phone ?? '—' }}</dd>
            <dt class="fld-label kv-top">Location</dt>
            <dd>
              <template v-if="overviewLocation.length > 0">
                <div v-for="line in overviewLocation" :key="line" class="address-line">
                  {{ line }}
                </div>
              </template>
              <template v-else>—</template>
            </dd>
          </dl>
        </Card>

        <Card title="Account">
          <dl class="kv-grid">
            <dt class="fld-label">Status</dt>
            <dd><StatusBadge :user="user" /></dd>
            <dt class="fld-label">Last logon</dt>
            <dd class="mono">{{ fmtAbsolute(user.lastLogonAt) }}</dd>
            <template v-if="user.entra">
              <dt class="fld-label" title="Most recent interactive sign-in reported by Entra ID">
                Last sign-in (Entra)
              </dt>
              <dd class="mono">
                <template v-if="user.entra.lastSignInAt">{{
                  fmtAbsolute(user.entra.lastSignInAt)
                }}</template>
                <span
                  v-else-if="user.entra.lastStatus === 'p1_required'"
                  class="entra-na"
                  title="signInActivity requires an Entra ID P1 license"
                  >P1 required</span
                >
                <span v-else class="entra-na">—</span>
              </dd>
            </template>
            <template v-if="user.entra && user.entra.mfa">
              <dt
                class="fld-label"
                title="MFA registration state from /reports/authenticationMethods"
              >
                MFA
              </dt>
              <dd>
                <span
                  v-if="user.entra.mfa.isRegistered === true"
                  class="badge badge-green"
                  :title="
                    user.entra.mfa.defaultMethod
                      ? `Default: ${user.entra.mfa.defaultMethod}`
                      : undefined
                  "
                >
                  <i class="pi pi-shield" /> registered
                </span>
                <span
                  v-else-if="user.entra.mfa.isRegistered === false && user.entra.mfa.isCapable"
                  class="badge badge-amber"
                  title="User can register MFA but hasn't yet"
                >
                  capable, not registered
                </span>
                <span
                  v-else-if="user.entra.mfa.isRegistered === false"
                  class="badge badge-red"
                  title="User cannot register MFA in this tenant"
                >
                  not capable
                </span>
                <span v-else class="entra-na">unknown</span>
                <div v-if="user.entra.mfa.methods.length > 0" class="mfa-methods mono">
                  {{ user.entra.mfa.methods.join(', ') }}
                </div>
              </dd>
            </template>
            <dt class="fld-label">Password set</dt>
            <dd class="mono">{{ fmtAbsolute(user.passwordLastSetAt) }}</dd>
            <dt class="fld-label">Expires</dt>
            <dd class="mono">
              {{ user.passwordNeverExpires ? 'never' : fmtAbsolute(user.passwordExpiresAt) }}
            </dd>
          </dl>
        </Card>

        <Card>
          <template #head>
            <h3 class="dc-card-title">
              Groups
              <span class="ds-tab-count mono">{{ user.groupMemberships.length }}</span>
            </h3>
          </template>
          <template #actions>
            <Button
              label="View all"
              text
              size="small"
              severity="secondary"
              @click="activeTab = 'groups'"
            />
          </template>
          <EmptyState
            v-if="user.groupMemberships.length === 0"
            icon="pi pi-users"
            title="No memberships"
            compact
          />
          <div v-else class="group-grid">
            <GroupChip
              v-for="g in groupsTop"
              :key="g.id"
              :name="g.name || g.distinguishedName"
              :nested="!g.direct"
              :to="{ name: 'group-detail', params: { id: g.id } }"
            />
            <span v-if="user.groupMemberships.length > groupsTop.length" class="hint">
              + {{ user.groupMemberships.length - groupsTop.length }} more
            </span>
          </div>
        </Card>

        <!-- Recent sign-ins (Entra) takes priority on the overview —
             operators investigating a user usually want to know "did
             they sign in, when, from where" first. Falls back to a
             Recent activity card (top 5 of the per-user audit log)
             when no Entra integration is configured; "View all" on
             that card jumps to /audit. -->
        <Card v-if="user.entra && auth.actor?.directoryId" class="overview-activity">
          <template #head>
            <h3 class="dc-card-title">Recent sign-ins</h3>
          </template>
          <template #actions>
            <Button
              label="View all"
              text
              size="small"
              severity="secondary"
              @click="activeTab = 'signins'"
            />
          </template>
          <SignInEventsList
            :directory-id="auth.actor.directoryId"
            :user-id="user.id"
            :page-size="5"
            hide-user-column
            @select="onSignInSelect"
          />
        </Card>
        <Card v-else class="overview-activity">
          <template #head>
            <h3 class="dc-card-title">Recent activity</h3>
          </template>
          <template #actions>
            <router-link to="/audit" class="p-button p-button-text p-button-secondary p-button-sm">
              <span class="p-button-label">View all</span>
            </router-link>
          </template>
          <Message v-if="activityError" severity="warn" :closable="false">{{
            activityError
          }}</Message>
          <ActivityFeed
            :events="activityTop"
            :loading="activityLoading && activityTop.length === 0"
          />
        </Card>
      </div>

      <!-- Organization — Person / Identifiers / Job + Reporting Structure +
           "More from directory" attribute roll-up. -->
      <Card v-else-if="activeTab === 'organization'">
        <section v-for="sec in VIEW_SECTIONS.organization" :key="sec" class="ident-section">
          <h3 class="ident-section-title">{{ SECTION_LABEL[sec] }}</h3>

          <div v-if="scalarFieldsForSection(sec).length > 0 || sec === 'ids'" class="attr-grid">
            <div
              v-for="f in scalarFieldsForSection(sec)"
              :key="f.key"
              class="fld"
              :class="{ 'fld-multiline': f.multiline, 'fld-modified': dirtyFieldKeys.has(f.key) }"
            >
              <div class="fld-label">
                {{ f.label }}
                <span
                  v-if="dirtyFieldKeys.has(f.key)"
                  class="fld-modified-dot"
                  title="Unsaved change"
                ></span>
              </div>
              <Textarea
                v-if="auth.editMode && canEdit && f.multiline"
                v-model="form[f.key]"
                :placeholder="f.label"
                :disabled="saving"
                auto-resize
                rows="2"
                :class="['attr-input', { mono: f.mono }]"
              />
              <InputText
                v-else-if="auth.editMode && canEdit"
                v-model="form[f.key]"
                :type="f.type ?? 'text'"
                :class="['attr-input', { mono: f.mono }]"
                :placeholder="f.label"
                :disabled="saving"
                size="small"
                fluid
              />
              <div
                v-else
                class="fld-value readonly-val"
                :class="{ empty: !user[f.key], 'readonly-multiline': f.multiline }"
              >
                <span :class="{ mono: f.mono }">{{ user[f.key] ?? '—' }}</span>
              </div>
            </div>

            <template v-if="sec === 'ids'">
              <div class="fld">
                <div class="fld-label">Username</div>
                <div class="fld-value mono readonly-val">{{ user.samAccountName }}</div>
              </div>
              <div class="fld">
                <div class="fld-label">UPN</div>
                <div class="fld-value mono readonly-val">{{ user.userPrincipalName ?? '—' }}</div>
              </div>
            </template>
          </div>
        </section>

        <ReportingStructureCard
          :manager="user.manager"
          :direct-reports="user.directReports"
          :self-name="displayName"
        />

        <section v-if="extraAttrRows.length > 0" class="ident-section">
          <h3 class="ident-section-title">
            More from directory
            <span class="hint"
              >{{ extraAttrRows.length }} attribute{{ extraAttrRows.length === 1 ? '' : 's' }}</span
            >
          </h3>
          <div class="extras-grid">
            <div v-for="row in extraAttrRows" :key="row.key" class="extras-row">
              <div class="extras-key mono">{{ row.key }}</div>
              <div class="extras-vals">
                <div v-for="(val, idx) in row.values" :key="`${row.key}-${idx}`" class="extras-val">
                  {{ val }}
                </div>
              </div>
            </div>
          </div>
        </section>
      </Card>

      <!-- Contact — Email / Phones / Address + Communication placeholder +
           Directory Visibility. -->
      <Card v-else-if="activeTab === 'contact'">
        <section v-for="sec in VIEW_SECTIONS.contact" :key="sec" class="ident-section">
          <h3 class="ident-section-title">{{ SECTION_LABEL[sec] }}</h3>

          <div v-if="scalarFieldsForSection(sec).length > 0" class="attr-grid">
            <div
              v-for="f in scalarFieldsForSection(sec)"
              :key="f.key"
              class="fld"
              :class="{ 'fld-multiline': f.multiline, 'fld-modified': dirtyFieldKeys.has(f.key) }"
            >
              <div class="fld-label">
                {{ f.label }}
                <span
                  v-if="dirtyFieldKeys.has(f.key)"
                  class="fld-modified-dot"
                  title="Unsaved change"
                ></span>
              </div>
              <Textarea
                v-if="auth.editMode && canEdit && f.multiline"
                v-model="form[f.key]"
                :placeholder="f.label"
                :disabled="saving"
                auto-resize
                rows="3"
                :class="['attr-input', { mono: f.mono }]"
              />
              <InputText
                v-else-if="auth.editMode && canEdit"
                v-model="form[f.key]"
                :type="f.type ?? 'text'"
                :class="['attr-input', { mono: f.mono }]"
                :placeholder="f.label"
                :disabled="saving"
                size="small"
                fluid
              />
              <div
                v-else
                class="fld-value readonly-val"
                :class="{ empty: !user[f.key], 'readonly-multiline': f.multiline }"
              >
                <span :class="{ mono: f.mono }">{{ user[f.key] ?? '—' }}</span>
              </div>
            </div>
          </div>

          <div v-if="arrayFieldsForSection(sec).length > 0" class="attr-multi-grid">
            <div
              v-for="f in arrayFieldsForSection(sec)"
              :key="f.key"
              class="fld attr-multi"
              :class="{ 'fld-modified': dirtyFieldKeys.has(f.key) }"
            >
              <div class="fld-label">
                {{ f.label }}
                <span v-if="(user[f.key]?.length ?? 0) > 0" class="ds-tab-count mono">
                  {{ user[f.key]!.length }}
                </span>
                <span
                  v-if="dirtyFieldKeys.has(f.key)"
                  class="fld-modified-dot"
                  title="Unsaved change"
                ></span>
              </div>
              <Textarea
                v-if="auth.editMode && canEdit"
                v-model="form[f.key]"
                :placeholder="f.placeholder"
                :disabled="saving"
                auto-resize
                rows="2"
                class="attr-input"
              />
              <div
                v-else-if="(user[f.key]?.length ?? 0) === 0"
                class="fld-value readonly-val empty"
              >
                <span>—</span>
              </div>
              <div v-else class="multi-chips">
                <span
                  v-for="(val, idx) in user[f.key]"
                  :key="`${f.key}-${idx}`"
                  class="multi-chip mono"
                  >{{ val }}</span
                >
              </div>
            </div>
          </div>

          <div v-if="sec === 'email' && user.emailAliases.length > 0" class="ident-subblock">
            <div class="fld-label">
              Aliases
              <span class="ds-tab-count mono">{{ user.emailAliases.length }}</span>
            </div>
            <div class="multi-chips">
              <span v-for="alias in user.emailAliases" :key="alias" class="multi-chip mono">{{
                alias
              }}</span>
            </div>
          </div>
        </section>

        <section class="ident-section">
          <h3 class="ident-section-title">Directory visibility</h3>
          <div class="attr-grid">
            <div class="fld">
              <div class="fld-label">Display name</div>
              <div class="fld-value readonly-val">{{ user.displayName ?? '—' }}</div>
            </div>
            <div class="fld">
              <div class="fld-label">Username</div>
              <div class="fld-value mono readonly-val">{{ user.samAccountName }}</div>
            </div>
            <div class="fld">
              <div class="fld-label">UPN</div>
              <div class="fld-value mono readonly-val">{{ user.userPrincipalName ?? '—' }}</div>
            </div>
          </div>
        </section>
      </Card>

      <!-- Groups -->
      <Card v-else-if="activeTab === 'groups'">
        <div class="groups-toolbar">
          <div class="groups-toolbar-left">
            <span class="p-input-icon-left groups-filter">
              <i class="pi pi-search" />
              <InputText v-model="groupFilter" placeholder="Filter groups…" size="small" />
            </span>
            <span class="groups-count">
              {{ groupsFiltered.length
              }}<span v-if="groupsFiltered.length !== user.groupMemberships.length">
                of {{ user.groupMemberships.length }}</span
              >
            </span>
          </div>
          <Button
            v-if="canManageGroups"
            label="Add group"
            icon="pi pi-plus"
            size="small"
            @click="auth.requireEdit(openAddGroupDialog)"
          />
        </div>

        <EmptyState
          v-if="user.groupMemberships.length === 0"
          icon="pi pi-users"
          title="No memberships in cache"
          message="Run a sync if this seems wrong."
        />
        <EmptyState
          v-else-if="groupsFiltered.length === 0"
          icon="pi pi-filter"
          title="No groups match"
          message="Try a different filter."
          compact
        />
        <template v-else>
          <section v-if="groupsDirect.length > 0" class="group-section">
            <h4 class="group-section-title">
              Direct
              <span class="group-section-count mono">{{ groupsDirect.length }}</span>
            </h4>
            <div class="group-grid">
              <GroupChip
                v-for="g in groupsDirect"
                :key="g.id"
                :name="g.name || g.distinguishedName"
                :nested="false"
                :removable="canManageGroups && groupBusy !== g.id"
                :to="{ name: 'group-detail', params: { id: g.id } }"
                @remove="
                  auth.requireEdit(() => requestRemoveGroup(g.id, g.name || g.distinguishedName))
                "
              />
            </div>
          </section>
          <section v-if="groupsInherited.length > 0" class="group-section">
            <h4 class="group-section-title">
              Inherited via nested groups
              <span class="group-section-count mono">{{ groupsInherited.length }}</span>
            </h4>
            <div class="group-grid">
              <GroupChip
                v-for="g in groupsInherited"
                :key="g.id"
                :name="g.name || g.distinguishedName"
                :nested="true"
                :to="{ name: 'group-detail', params: { id: g.id } }"
              />
            </div>
          </section>
        </template>
      </Card>

      <!-- Account — sign-in & lockout, password & security, lifecycle, plus
           a placeholder for Devices / Authentication Methods that surfaces
           only once the Entra integration lands. -->
      <div v-else-if="activeTab === 'account'" class="detail-grid">
        <Card title="Sign-in & Identity">
          <dl class="kv-grid">
            <dt class="fld-label">Status</dt>
            <dd><StatusBadge :user="user" /></dd>
            <dt class="fld-label">Locked</dt>
            <dd>{{ user.locked ? 'Yes' : 'No' }}</dd>
            <template v-if="user.lockedAt">
              <dt class="fld-label">Locked at</dt>
              <dd class="mono">{{ fmtAbsolute(user.lockedAt) }}</dd>
            </template>
            <template v-if="user.locked">
              <dt class="fld-label">Auto-unlocks</dt>
              <dd class="mono">
                <template v-if="user.autoUnlockAt">
                  {{ fmtAbsolute(user.autoUnlockAt) }}
                  <span class="text-muted"> · {{ fmtRelative(user.autoUnlockAt) }}</span>
                </template>
                <template v-else>
                  <span class="text-muted">manual unlock required</span>
                </template>
              </dd>
            </template>
            <dt class="fld-label">Last logon</dt>
            <dd class="mono">{{ fmtAbsolute(user.lastLogonAt) }}</dd>
          </dl>
          <div class="card-actions">
            <Button
              v-if="canUnlock"
              :label="user.locked ? 'Unlock account' : 'Not locked'"
              icon="pi pi-unlock"
              :disabled="!user.locked || actionRunning !== null"
              :severity="user.locked ? 'warn' : 'secondary'"
              :outlined="!user.locked"
              size="small"
              :loading="actionRunning === 'unlock'"
              @click="auth.requireEdit(doUnlock)"
            />
          </div>
        </Card>

        <Card title="Password & Security">
          <dl class="kv-grid">
            <dt class="fld-label">Last set</dt>
            <dd class="mono">{{ fmtAbsolute(user.passwordLastSetAt) }}</dd>
            <dt class="fld-label">Last bad password</dt>
            <dd class="mono">
              {{ user.lastBadPasswordAt ? fmtAbsolute(user.lastBadPasswordAt) : 'never' }}
            </dd>
            <dt class="fld-label">Expires</dt>
            <dd class="mono">
              {{ user.passwordNeverExpires ? 'never' : fmtAbsolute(user.passwordExpiresAt) }}
            </dd>
          </dl>
          <div class="card-actions">
            <Button
              v-if="canResetPassword"
              label="Reset password"
              icon="pi pi-key"
              severity="danger"
              outlined
              size="small"
              @click="auth.requireEdit(openResetDialog)"
            />
          </div>
        </Card>

        <Card title="Lifecycle">
          <dl class="kv-grid">
            <dt class="fld-label">Account expires</dt>
            <dd class="mono">
              {{ user.accountExpiresAt ? fmtAbsolute(user.accountExpiresAt) : 'never' }}
            </dd>
            <dt class="fld-label">Last modified</dt>
            <dd class="mono">{{ fmtAbsolute(user.modifiedAtSource) }}</dd>
            <dt class="fld-label">Privileged</dt>
            <dd>{{ user.isPrivileged ? 'Yes (adminCount=1)' : 'No' }}</dd>
          </dl>
        </Card>

        <Card title="Authentication & MFA">
          <!-- MFA data when an Entra integration is configured AND the
               entra.mfa.registration runner has visited this user.
               Note: registered devices come from a separate Graph
               endpoint (/users/{id}/registeredDevices) we haven't
               wired yet — listed as a follow-up. -->
          <template v-if="user.entra && user.entra.mfa">
            <dl class="kv-grid">
              <dt class="fld-label">Status</dt>
              <dd>
                <span v-if="user.entra.mfa.isRegistered === true" class="badge badge-green">
                  <i class="pi pi-shield" /> registered
                </span>
                <span
                  v-else-if="user.entra.mfa.isRegistered === false && user.entra.mfa.isCapable"
                  class="badge badge-amber"
                  title="User can register MFA but hasn't yet"
                >
                  capable, not registered
                </span>
                <span v-else-if="user.entra.mfa.isRegistered === false" class="badge badge-red">
                  not capable
                </span>
                <span v-else class="entra-na">unknown</span>
              </dd>
              <dt class="fld-label">Methods registered</dt>
              <dd>
                <ul v-if="user.entra.mfa.methods.length > 0" class="mfa-method-list">
                  <li v-for="m in user.entra.mfa.methods" :key="m">
                    <i class="pi pi-lock" /> {{ m }}
                  </li>
                </ul>
                <span v-else class="entra-na">none</span>
              </dd>
              <dt class="fld-label">Default method</dt>
              <dd>{{ user.entra.mfa.defaultMethod ?? '—' }}</dd>
              <dt class="fld-label">Passwordless capable</dt>
              <dd>
                {{
                  user.entra.mfa.isPasswordlessCapable === null
                    ? '—'
                    : user.entra.mfa.isPasswordlessCapable
                      ? 'Yes'
                      : 'No'
                }}
              </dd>
              <dt class="fld-label">Last refreshed</dt>
              <dd class="mono">
                {{ user.entra.mfa.fetchedAt ? fmtAbsolute(user.entra.mfa.fetchedAt) : '—' }}
              </dd>
            </dl>
          </template>
          <EmptyState
            v-else-if="user.entra"
            icon="pi pi-clock"
            title="MFA data not yet synced"
            message="Enable the MFA registration feature in Settings → Integrations and run the entra.mfa.registration task to populate this card."
            compact
          />
          <EmptyState
            v-else
            icon="pi pi-shield"
            title="Requires Entra integration"
            message="Configure the Microsoft Graph integration in Settings → Integrations to surface MFA registration here. Registered devices coming in a future release."
            compact
          />
        </Card>
      </div>

      <!-- Sign-ins — Microsoft Entra audit log for this user, served
           from the local entra_signin_events cache (delta-synced every
           15min by entra.signins.events). Filtering by user_object_guid
           is reliable; the live-Graph approach was unreliable due to
           UPN case-sensitivity in Graph's $filter. -->
      <Card v-else-if="activeTab === 'signins' && user?.entra && auth.actor?.directoryId">
        <SignInEventsList
          :directory-id="auth.actor.directoryId"
          :user-id="user.id"
          hide-user-column
          @select="onSignInSelect"
        />
      </Card>

      <!-- Raw LDAP — every populated attribute on the entry, as AD returned
           it. Source of truth for deciding which attributes to promote into
           the typed grids; admin-only via the view:raw_attributes capability. -->
      <Card v-else-if="activeTab === 'raw' && canViewRaw">
        <div class="raw-toolbar">
          <InputText
            v-model="rawFilter"
            placeholder="Filter by attribute name or value…"
            size="small"
            fluid
          />
          <span class="hint">
            {{ filteredRawRows.length }} of {{ rawAttrRows.length }} attribute{{
              rawAttrRows.length === 1 ? '' : 's'
            }}
          </span>
        </div>
        <EmptyState
          v-if="rawAttrRows.length === 0"
          icon="pi pi-inbox"
          title="No raw attributes"
          message="The directory returned no populated attributes for this user."
        />
        <EmptyState
          v-else-if="filteredRawRows.length === 0"
          icon="pi pi-filter"
          title="No matches"
          message="Try a different filter."
          compact
        />
        <div v-else class="extras-grid">
          <div v-for="row in filteredRawRows" :key="row.key" class="extras-row">
            <div class="extras-key mono">{{ row.key }}</div>
            <div class="extras-vals">
              <div v-for="(val, idx) in row.values" :key="`${row.key}-${idx}`" class="extras-val">
                {{ val }}
              </div>
            </div>
          </div>
        </div>
      </Card>

      <!-- Save / discard bar — page-level so it covers edits made on
           either the Identity or the Location tab. Sticky to the bottom of
           the viewport while scrolling so it's always reachable on tall
           attribute lists. -->
      <transition name="save-bar">
        <div v-if="auth.editMode && canEdit && isDirty" class="save-bar save-bar-floating">
          <span class="save-bar-summary">
            <i class="pi pi-pencil" />
            <strong>{{ dirtyFields.length }}</strong>
            unsaved change{{ dirtyFields.length === 1 ? '' : 's' }}
          </span>
          <span class="save-bar-fields">
            <span v-for="d in dirtyFields" :key="d.key" class="dirty-chip">
              {{ d.key }}
            </span>
          </span>
          <span class="save-bar-actions">
            <Button
              label="Discard"
              text
              severity="secondary"
              size="small"
              :disabled="saving"
              @click="discardAttributes"
            />
            <Button
              label="Save changes"
              icon="pi pi-check"
              size="small"
              :loading="saving"
              @click="saveAttributes"
            />
          </span>
        </div>
      </transition>

      <p class="freshness-foot">
        <span class="hint">
          Live refreshed {{ fmtRelative(user.freshness.liveRefreshedAt) }} · Cache written
          {{ fmtRelative(user.freshness.cachedAt) }}
        </span>
      </p>
    </div>

    <!-- Reset password dialog. No longer needs the AD password input —
         the active edit-mode session has it cached server-side. -->
    <Dialog
      :visible="resetDialogOpen"
      modal
      header="Reset password"
      :style="{ width: '28rem' }"
      :closable="!resetSubmitting"
      @update:visible="(v) => !v && (resetDialogOpen = false)"
    >
      <p class="dialog-prose primary">
        Set a new password for <strong>{{ user?.displayName ?? user?.samAccountName }}</strong
        >.
      </p>
      <p class="dialog-prose secondary">
        AD policy still applies — complexity, length, and history rules can reject the value.
      </p>
      <div class="reset-form">
        <div class="form-row">
          <label class="fld-label">New password</label>
          <Password
            v-model="resetDraft.newPassword"
            :feedback="false"
            toggle-mask
            input-class="w-full"
            class="w-full"
            :disabled="resetSubmitting"
            autocomplete="new-password"
            @keyup.enter="onResetSubmit"
          />
        </div>
        <label class="check-row">
          <input
            v-model="resetDraft.forceChangeAtNextLogin"
            type="checkbox"
            :disabled="resetSubmitting"
          />
          <span>Force change at next sign-in</span>
        </label>
        <Message v-if="resetError" severity="error" :closable="false">{{ resetError }}</Message>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          text
          severity="secondary"
          :disabled="resetSubmitting"
          @click="resetDialogOpen = false"
        />
        <Button label="Reset" :loading="resetSubmitting" @click="onResetSubmit" />
      </template>
    </Dialog>

    <!-- Move to OU dialog: TreeSelect over the cached OU list. The current
         parent OU is preselected so the operator can see where they are
         before picking a destination. -->
    <Dialog
      :visible="moveDialogOpen"
      modal
      header="Move to OU"
      :style="{ width: '34rem' }"
      :closable="!moveSubmitting"
      @update:visible="(v) => !v && (moveDialogOpen = false)"
    >
      <p class="dialog-prose primary">
        Move <strong>{{ user?.displayName ?? user?.samAccountName }}</strong> to a different
        organizational unit.
      </p>
      <p class="dialog-prose secondary">
        The user's CN stays the same — only the parent container changes. Group memberships and the
        user's GUID are preserved.
      </p>
      <div v-if="currentOuDn" class="move-current">
        <span class="muted">Currently in:</span>
        <code class="dn-line">{{ currentOuDn }}</code>
      </div>
      <div class="move-tree">
        <div v-if="moveOusLoading" class="hint">Loading OUs…</div>
        <TreeSelect
          v-else
          v-model="moveSelection"
          :options="moveOuTree"
          selection-mode="single"
          placeholder="Pick a destination OU"
          fluid
          :disabled="moveSubmitting"
        />
      </div>
      <Message v-if="moveError" severity="error" :closable="false">{{ moveError }}</Message>
      <Message v-else-if="moveTargetIsCurrent" severity="info" :closable="false">
        That's the user's current OU — pick a different one.
      </Message>
      <template #footer>
        <Button
          label="Cancel"
          text
          severity="secondary"
          :disabled="moveSubmitting"
          @click="moveDialogOpen = false"
        />
        <Button
          label="Move"
          icon="pi pi-folder-open"
          :loading="moveSubmitting"
          :disabled="!selectedTargetDn || moveTargetIsCurrent"
          @click="onMoveSubmit"
        />
      </template>
    </Dialog>

    <!-- Add group dialog: simple debounced search against /groups, with
         the user's existing memberships filtered out of results. -->
    <Dialog
      :visible="addGroupOpen"
      modal
      header="Add to group"
      :style="{ width: '32rem' }"
      :closable="groupBusy === null"
      @update:visible="(v) => !v && (addGroupOpen = false)"
    >
      <p class="dialog-prose secondary">Search by name. Adding commits immediately.</p>
      <InputText v-model="groupSearchQuery" placeholder="Search groups…" autofocus fluid />
      <div class="group-search-results">
        <div v-if="groupSearchLoading" class="hint">Searching…</div>
        <EmptyState
          v-else-if="groupSearchQuery.trim().length < 2"
          icon="pi pi-search"
          title="Type to search"
          message="At least 2 characters."
          compact
        />
        <EmptyState
          v-else-if="groupSearchResults.length === 0"
          icon="pi pi-inbox"
          title="No matches"
          compact
        />
        <ul v-else class="group-result-list">
          <li
            v-for="g in groupSearchResults"
            :key="g.id"
            class="group-result"
            :class="{ disabled: existingGroupIds.has(g.id) }"
          >
            <div class="group-result-meta">
              <span class="group-result-name">{{ g.name || g.distinguishedName }}</span>
              <span class="group-result-dn mono">{{ g.distinguishedName }}</span>
            </div>
            <Button
              v-if="!existingGroupIds.has(g.id)"
              label="Add"
              icon="pi pi-plus"
              size="small"
              :loading="groupBusy === g.id"
              @click="doAddGroup(g)"
            />
            <span v-else class="hint">already a member</span>
          </li>
        </ul>
      </div>
      <template #footer>
        <Button label="Close" text severity="secondary" @click="addGroupOpen = false" />
      </template>
    </Dialog>

    <!-- Group removal confirmation: a single-click on the chip's "x" was too
         easy to fire by accident, so every removal now goes through here. -->
    <ConfirmDialog
      :visible="removeConfirm !== null"
      title="Remove group membership?"
      :message="
        removeConfirm
          ? `Remove ${user?.displayName || user?.samAccountName || 'this user'} from “${removeConfirm.label}”?`
          : ''
      "
      detail="The change is committed to the directory immediately."
      confirm-label="Remove"
      severity="danger"
      :busy="groupBusy !== null && removeConfirm !== null && groupBusy === removeConfirm.groupId"
      @update:visible="(v) => !v && cancelRemoveGroup()"
      @cancel="cancelRemoveGroup"
      @confirm="confirmRemoveGroup"
    />

    <SignInEventDetailDialog
      v-if="auth.actor?.directoryId"
      v-model:visible="signInDialogOpen"
      :directory-id="auth.actor.directoryId"
      :event-id="signInDialogEventId"
    />
  </div>
</template>

<style scoped>
.detail-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* --detail-sticky-offset is set inline (reactive to hero height) so
     the sticky tab bar pins flush with the hero's current bottom edge,
     including mid-shrink-animation. */
  /* Disable browser scroll anchoring inside the detail page. When the
     hero shrinks during the compact transition, anchoring would auto-
     adjust scrollTop to "stabilize" content — but that fights our
     detection and produces a flicker loop right at the trigger point. */
  overflow-anchor: none;
}

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

/* Compact state: padding tightens, avatar shrinks via the reactive
   :size prop on Avatar (animated by Avatar's own width/height
   transition), and the secondary rows below the name collapse to
   zero. Corners square off and the bottom border drops so the hero
   merges seamlessly into the sticky tab bar below — they read as
   one pinned banner. The drop shadow on the tab bar carries the
   "content scrolls under" signal for the merged unit. */
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

.copybtn .dn-short {
  max-width: 320px;
}

/* DN copy chip: same shape as Email/Teams launchers, but the DN text
   inside is allowed to grow (with ellipsis) so the operator can scan
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

/* Inline copy button used at the top of the hero meta as the primary
   identifier line. Looks like text + a copy icon — no button chrome —
   so it doesn't visually compete with the launcher row below. */
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

.overview-activity {
  grid-column: 1 / -1;
}

.stale-flag {
  margin-left: 4px;
}

@media (max-width: 767.98px) {
  .detail-hero {
    grid-template-columns: 1fr;
    justify-items: start;
  }
}

/* Tab bar actions — Actions menu and refresh icon scoot to the right. */
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

/* Tint the Disable item in the Actions menu so destructive intent is
   obvious without forcing the operator to read the label twice. */
:deep(.p-menu .menu-item-danger .p-menuitem-link) {
  color: var(--red);
}

:deep(.p-menu .menu-item-danger .p-menuitem-icon) {
  color: var(--red);
}

/* Tabs ------------------------------------------------------------------- */
.ds-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: var(--detail-sticky-offset, 40px);
  z-index: 5;
  background: var(--surface);
  /* Pronounced drop shadow when the tab bar pins under the compact
     hero: makes it clear that page content scrolls beneath. Carries
     the visual signal for the entire merged hero+tabs unit since
     the hero's own shadow drops in compact. */
  box-shadow: 0 10px 18px -10px rgba(0, 0, 0, 0.28);
  /* No transition on `top`: the offset is updated continuously by
     ResizeObserver during the hero shrink, so the tab bar follows
     the hero's bottom edge frame-by-frame. A CSS transition here
     would make the tab bar lag behind the hero. */
}

/* When the hero is compact, the hero's bottom border drops and its
   side borders remain. Mirror those side borders on the tab bar so
   the merged hero + tab bar reads as one continuous bordered
   rectangle pinned at the top — without this, the tab bar appears
   ~2 px wider than the hero on each side because the hero is inset
   by its own border while the tab bar runs edge to edge. */
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

/* Compact mode: the nav's ResizeObserver detects overflow and flips
   .ds-tabs.compact, which hides the text label so each tab shrinks to
   its icon (and count badge, if any). The icon remains the click target
   and the button's title attribute exposes the full label on hover. */
.ds-tabs.compact .ds-tab {
  padding: 9px 10px;
}

.ds-tabs.compact .ds-tab-label {
  display: none;
}

.ds-tabs.compact .ds-tab-count {
  margin-left: 4px;
}

/* Per-tab icon-only opt-in (Overview, Debug). Same effect as the
   compact-mode rule above, but applied unconditionally on those tabs
   so the bar stays narrower and labels stay visible on the more
   ambiguous tabs at narrower widths. */
.ds-tab.icon-only {
  padding: 9px 10px;
}
.ds-tab.icon-only .ds-tab-label {
  display: none;
}

/* Measurement state: useCompactTabs.update() applies this briefly
   inside a single rAF to read the true natural width of the bar's
   children. The flex spacer is hidden and every other child has
   `flex: none` so nothing shrinks; labels are forced visible so the
   measurement reflects the expanded layout. The class is removed
   before the next paint, so the user never sees this state. */
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
/* Per-tab icon-only opt-in stays icon-only even during measurement —
   the measurement is asking "would the always-labeled tabs fit?", so
   the always-icon tabs should keep their compact width. */
.ds-tabs.measuring .ds-tab.icon-only .ds-tab-label {
  display: none;
}

/* Body ------------------------------------------------------------------- */
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: start;
}

@media (max-width: 1100px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}

.detail-side {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.attr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 24px;
  margin: 0;
}

.attr-input {
  width: 100%;
}

/* Modified-field highlight ----------------------------------------------
   A small accent dot next to the field label and a tinted left edge on
   the field row so the operator can see at a glance which inputs they've
   touched and not yet saved. */
.fld-modified {
  border-left: 2px solid color-mix(in oklab, var(--accent) 70%, transparent);
  padding-left: 8px;
  margin-left: -10px;
}

.fld-modified-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin-left: 6px;
  vertical-align: middle;
}

.readonly-val {
  cursor: default;
  color: var(--text);
  font-size: 13px;
  padding: 4px 0;
}

.readonly-val.empty {
  color: var(--text-4);
  font-style: italic;
}

/* Multi-line scalars (description, homePostalAddress) preserve newlines in
   their value rather than collapsing them onto a single row. */
.readonly-val.readonly-multiline span {
  white-space: pre-line;
}

/* Multi-line scalar field cells span 2 columns of the auto-fit grid so the
   textarea / address has room to breathe. */
.fld-multiline {
  grid-column: span 2;
}

@media (max-width: 720px) {
  .fld-multiline {
    grid-column: auto;
  }
}

.kv-grid {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 6px 14px;
  margin: 0;
  font-size: 13px;
  color: var(--text);
  align-items: center;
}

.kv-grid dt {
  color: var(--text-3);
}

.kv-grid dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Multi-line cells (address) want top alignment so the label sits next
   to the first line, not vertically centered with the whole block. */
.kv-grid .kv-top {
  align-self: start;
  padding-top: 2px;
}

/* Long mono values (email, UPN, DN) get explicit wrap behavior so the
   card doesn't blow out its column on the wider tablet/desktop layouts. */
.kv-grid .kv-wrap {
  white-space: normal;
}

.address-line {
  line-height: 1.35;
}
.address-line + .address-line {
  margin-top: 1px;
}

.kv-foot {
  font-size: 11px;
  color: var(--text-4);
  font-family: var(--font-mono);
  margin-top: 2px;
}

.card-actions {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.groups-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.groups-toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
}

.groups-filter {
  display: inline-flex;
  align-items: center;
  position: relative;
}

.groups-filter :deep(.p-inputtext) {
  padding-left: 28px;
  width: 240px;
}

.groups-filter > i {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  font-size: 12px;
  pointer-events: none;
  z-index: 1;
}

.groups-count {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}

.group-section {
  margin-top: 6px;
}

.group-section + .group-section {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

.group-section-title {
  margin: 0 0 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.group-section-count {
  font-size: 11px;
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  letter-spacing: 0;
  text-transform: none;
}

.group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
}

.group-grid :deep(.gchip) {
  width: 100%;
  min-width: 0;
}

.group-grid :deep(.gchip > span:nth-child(2)) {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.raw-block {
  margin: 0;
  padding: 12px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-2);
  max-height: 540px;
  overflow: auto;
  white-space: pre;
}

/* Identity sections ------------------------------------------------------ */
.ident-section {
  padding-top: 16px;
  margin-top: 18px;
  border-top: 1px solid var(--border);
}

.ident-section:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}

.ident-section-title {
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

/* Read-only sub-content within a section (Email aliases, etc.). Spaced so
   it sits clearly under the editable rows but doesn't get its own border. */
.ident-subblock {
  margin-top: 12px;
}

.ident-subblock .fld-label {
  margin-bottom: 4px;
}

/* Identity tab "More from directory" + Raw LDAP shared list ------------- */
.extras-block {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.extras-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}

.extras-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.extras-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px 24px;
}

.extras-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.extras-key {
  font-size: 11px;
  color: var(--text-3);
  text-transform: none;
}

.extras-vals {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.extras-val {
  font-size: 13px;
  color: var(--text);
  word-break: break-word;
}

.raw-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.raw-toolbar :deep(.p-inputtext) {
  font-family: var(--font-mono);
  font-size: 12px;
}

/* Multi-valued attribute editor + read-only chips ----------------------- */
.attr-multi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px 24px;
  margin-top: 14px;
}

.attr-multi .fld-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.attr-multi :deep(.p-textarea) {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
}

.multi-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 0;
}

.multi-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--surface-3);
  color: var(--text);
  font-size: 12px;
  border: 1px solid var(--border);
}

/* Direct reports list --------------------------------------------------- */
.reports-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 4px 12px;
}

.reports-item {
  min-width: 0;
}

.reports-link,
.reports-stale {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
  text-decoration: none;
  color: var(--text);
  max-width: 100%;
}

.reports-link {
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}

.reports-link:hover {
  background: color-mix(in oklab, var(--accent) 12%, var(--surface-2));
  border-color: color-mix(in oklab, var(--accent) 28%, var(--border));
}

.reports-stale {
  color: var(--text-3);
  border: 1px dashed var(--border);
  background: var(--surface-2);
}

.reports-stale span:not(.hint) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

/* Hero launcher links — share .copybtn styling but render as anchors. */
.copybtn.launcher {
  text-decoration: none;
  color: var(--text);
  border-color: color-mix(in oklab, var(--accent) 30%, var(--border-strong));
  background: color-mix(in oklab, var(--accent) 8%, var(--surface-2));
}

.copybtn.launcher:hover {
  background: color-mix(in oklab, var(--accent) 15%, var(--surface-3));
}

.freshness-foot {
  margin: 4px 0 0;
}

/* On narrow screens auto-fit collapses naturally; nothing extra needed. */

@media (max-width: 880px) {
  .detail-hero-top {
    flex-wrap: wrap;
  }

  .detail-hero-main {
    flex: 1 1 100%;
  }

  .detail-hero-aside {
    flex: 1 1 100%;
    flex-direction: row;
    align-items: center;
    justify-content: flex-start;
  }
}

/* Save bar --------------------------------------------------------------- */
.save-bar-floating {
  /* Sticky at the bottom of the page-inner viewport so editors don't lose
     access to Save while scrolling through tall attribute lists or while
     switching between Identity and Location tabs. */
  position: sticky;
  bottom: 12px;
  z-index: 10;
  margin-top: 0;
  box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.5);
}

.save-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--accent) 12%, var(--surface-2));
  border: 1px solid color-mix(in oklab, var(--accent) 35%, var(--border-strong));
  font-size: 13px;
}

.save-bar-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
  white-space: nowrap;
}

.save-bar-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.dirty-chip {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--accent) 18%, var(--surface-3));
  color: var(--text);
}

.save-bar-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.save-bar-enter-active,
.save-bar-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.save-bar-enter-from,
.save-bar-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* Group search dialog ---------------------------------------------------- */
.group-search-results {
  margin-top: 12px;
  min-height: 120px;
  max-height: 320px;
  overflow: auto;
}

.group-result-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.group-result {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-2);
}

.group-result.disabled {
  opacity: 0.6;
}

.group-result-meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-result-name {
  font-size: 13px;
  color: var(--text);
}

.group-result-dn {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Reset dialog ------------------------------------------------------------ */
.dialog-prose {
  font-size: 13px;
  margin: 0 0 8px;
}

.dialog-prose.primary {
  color: var(--text);
}

.dialog-prose.secondary {
  color: var(--text-3);
  font-size: 12px;
  margin-bottom: 14px;
}

.reset-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.move-current {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 12px;
}

.move-current .muted {
  color: var(--text-3);
}

.dn-line {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  color: var(--text-2);
  word-break: break-all;
}

.move-tree {
  margin: 0 0 12px;
  min-height: 40px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
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

/* MFA methods list rendered under the registration badge in the
   Account card. Subtle, mono — matches the rest of the kv-grid. */
.entra-na {
  color: var(--text-3);
}

.mfa-methods {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 4px;
  letter-spacing: 0.01em;
}

/* MFA methods on the dedicated Authentication card. Vertical list of
   chip-style entries — easier to scan than a comma-joined string when
   a user has many methods registered. */
.mfa-method-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
}

.mfa-method-list li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mfa-method-list .pi-lock {
  color: var(--text-3);
  font-size: 11px;
}
</style>
