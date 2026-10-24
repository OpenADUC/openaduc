<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { latestRequest } from '../design/lib/latestRequest.js';
import { useUserRecord } from '../design/composables/useDirectoryRecords.js';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRouter } from 'vue-router';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Message from 'primevue/message';
import { useToast } from 'primevue/usetoast';
import { api, type AuditEventRow } from '../api/index.js';
import { useAuthStore } from '../stores/auth.js';
import StatusBadge from '../design/primitives/StatusBadge.vue';
import Card from '../design/primitives/Card.vue';
import GroupChip from '../design/primitives/GroupChip.vue';
import EmptyState from '../design/primitives/EmptyState.vue';
import AppToast from '../design/feedback/AppToast.vue';
import ConfirmDialog from '../design/feedback/ConfirmDialog.vue';
import InlineFailure from '../design/feedback/InlineFailure.vue';
import { undoable } from '../design/feedback/undoToast.js';
import {
  accountActionToast,
  announceUserCreated,
  passwordResetToast,
} from '../design/feedback/userToasts.js';
import DeleteUsersDialog from '../design/feedback/DeleteUsersDialog.vue';
import MoveToOuDialog from '../design/feedback/MoveToOuDialog.vue';
import NewUserDialog from '../design/feedback/NewUserDialog.vue';
import RenameUserDialog from '../design/feedback/RenameUserDialog.vue';
import ResetPasswordDialog from '../design/feedback/ResetPasswordDialog.vue';
import IssueTapDialog from '../design/feedback/IssueTapDialog.vue';
import AccountExpiryDialog from '../design/feedback/AccountExpiryDialog.vue';
import BulkJobPanel from '../design/feedback/BulkJobPanel.vue';
import ReassignReportsDialog from '../design/feedback/ReassignReportsDialog.vue';
import BulkRevertDialog from '../design/feedback/BulkRevertDialog.vue';
import { expiryMoment } from '../design/lib/accountExpiry.js';
import SignInStatus from '../design/primitives/SignInStatus.vue';
import { lockoutEnd, signInBlockers, signInNotes, type SignInFix } from '../design/lib/signIn.js';
import type { ResetOutcome } from '../design/composables/usePasswordReset.js';
import ReportingStructureCard from '../design/primitives/ReportingStructureCard.vue';
import ActivityFeed from '../design/primitives/ActivityFeed.vue';
import SignInEventsList from '../design/primitives/SignInEventsList.vue';
import SignInEventDetailDialog from '../design/feedback/SignInEventDetailDialog.vue';
import { fmtAbsolute, nameOf } from '../design/lib/format.js';
import type { UserCreateResponse, UserDetail } from '@openaduc/shared';
import ObjectPageLayout from './_detail/ObjectPageLayout.vue';
import type { ObjectAction, ObjectLink, ObjectPageTab } from './_detail/objectPage';
import type { ActionFailure } from '../design/lib/actionFailure.js';
import { useRecordCrumb } from '../design/layout/recordCrumb.js';
import { useMoveDialog } from './_detail/useMoveDialog';
import { useExpiryDialog } from './_detail/useExpiryDialog';
import { useConfirm } from '../design/composables/useConfirm.js';
import { useAccountActions, type AccountAction } from '../design/composables/useAccountActions.js';
import { useReassignReports } from '../design/composables/useReassignReports.js';
import {
  USER_ACTIONS,
  USER_ACTION_ORDER,
  userActionUnavailable,
  userActionLabel,
  type UserAction,
} from '../design/lib/userActions.js';
import { useSignInFixes } from '../design/composables/useSignInFixes.js';
import { SHORTCUT_KEYS } from '../design/lib/shortcutKeys.js';
import {
  membershipChangeText,
  membershipDoneText,
  membershipOf,
  useGroupMembership,
  type Membership,
  type MembershipChange,
  type MembershipFailure,
} from '../design/composables/useGroupMembership.js';
import { placeFailure } from '../design/lib/failurePlacement.js';
import type { UndoOffer } from '../design/lib/undoableWrite.js';
import { useAddToGroup, MIN_GROUP_QUERY } from '../design/composables/useAddToGroup.js';
import {
  useUserAttributeEdit,
  type MultiValuedAttribute,
  type ScalarAttribute,
} from '../design/composables/useUserAttributeEdit.js';

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
  'streetAddress',
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
  key: ScalarAttribute;
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
  key: MultiValuedAttribute;
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
  {
    key: 'streetAddress',
    label: 'Street',
    multiline: true,
    view: 'contact',
    section: 'address',
  },
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

const {
  draft,
  reset: resetDraft,
  changes,
  changed,
  dirty,
  problems,
  valid,
  saving,
  save: saveAttributes,
  failure: saveFailure,
  dismiss: dismissSaveFailure,
} = useUserAttributeEdit({
  onSaved: async (n) => {
    toast.add({
      severity: 'success',
      summary: 'Attributes saved',
      detail: `${n} field${n === 1 ? '' : 's'} updated`,
      life: 3000,
    });
    await load();
  },
});

const {
  record: user,
  loading,
  error,
  load,
  refreshing,
  refresh,
} = useUserRecord({
  id: () => props.id,
  // The Overview activity card belongs to the previous user: clear it, and
  // abandon a request for it still in flight.
  beforeLoad: () => {
    // Moving to another user drops the record; drop its edits with it, so
    // the leave prompts never count them while the next one loads or fails.
    if (!user.value) resetDraft(null);
    activityRequests.begin();
    activityLoading.value = false;
    activityLoaded.value = false;
    activityEvents.value = [];
  },
  onLoaded: resetDraft,
});
useRecordCrumb(
  () => props.id,
  () => user.value?.displayName ?? user.value?.samAccountName,
);

const rawFilter = ref('');

const canUnlock = computed(() => auth.hasCapability('write:user.unlock'));
const canEdit = computed(() => auth.hasCapability('write:user.attributes'));
const canResetPassword = computed(() => auth.hasCapability('write:user.resetPassword'));
const canManageGroups = computed(() => auth.hasCapability('write:group.membership'));
// The Raw LDAP tab shows only when the API sent the attributes, which it
// does for view:raw_attributes holders (admins).
const canViewRaw = computed(() => !!user.value?.rawAttributes);

// Per-user activity feed. Auto-loaded on user load to populate the
// Overview "Recent activity" card. Fetches a small page (10) since the
// dedicated Admin actions tab was removed; only the top 5 are shown.
const activityEvents = ref<AuditEventRow[]>([]);
const activityLoading = ref(false);
const activityLoaded = ref(false);
const activityError = ref<string | null>(null);

const activityRequests = latestRequest();

async function loadActivity(): Promise<void> {
  if (!user.value || activityLoading.value) return;
  const isCurrent = activityRequests.begin();
  const forUserId = user.value.id;
  activityLoading.value = true;
  activityError.value = null;
  try {
    const r = await api.users.activity(forUserId, 10);
    // Ignore if the operator has moved on to another user meanwhile.
    if (!isCurrent() || user.value?.id !== forUserId) return;
    activityEvents.value = r.rows;
    activityLoaded.value = true;
  } catch (err) {
    if (!isCurrent()) return;
    activityError.value = err instanceof Error ? err.message : 'Failed to load activity';
  } finally {
    if (isCurrent()) activityLoading.value = false;
  }
}

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

function refreshFromAd(): Promise<void> {
  // GET live-refreshes against AD, so a reload is a sync of this one object.
  return refresh(toast, 'Refreshed from directory');
}

watch(() => props.id, load);
onMounted(load);

// ---- Navigation / unload guard ------------------------------------------
//
// Stop the operator from navigating away (back button, sidebar click, tab
// close) when there are unsaved field edits in the buffer. Vue Router's
// guards handle in-app nav; the matching beforeunload listener covers full
// page unloads.

const { ask: askToLeave, dialog: leaveDialog } = useConfirm();

function confirmDiscard(): boolean | Promise<boolean> {
  if (!dirty.value) return true;
  const n = changes.value.length;
  return askToLeave({
    title: 'Discard unsaved changes?',
    message: `You have ${n} unsaved change${n === 1 ? '' : 's'} on this user.`,
    confirmLabel: 'Leave without saving',
    cancelLabel: 'Keep editing',
    severity: 'warn',
  });
}

onBeforeRouteLeave(confirmDiscard);
// Another user's page reuses this one; switching tabs only changes the query.
onBeforeRouteUpdate((to, from) => to.params.id === from.params.id || confirmDiscard());

function onBeforeUnload(ev: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  ev.preventDefault();
  // Modern browsers ignore the message string but require returnValue set.
  ev.returnValue = '';
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

// ---- Hero actions (unlock / enable / disable) ----------------------------

const accountActions = useAccountActions<UserDetail>({
  onDone: async (action, u, offer) => {
    toast.add(accountActionToast(action, u, offer));
    await load();
  },
});

const accountActionRunning = computed(() =>
  user.value ? accountActions.runningOn(user.value.id) : null,
);

function runOnUser(action: AccountAction): void {
  if (user.value) accountActions.run(action, user.value);
}

// ---- Reset password dialog ------------------------------------------------

const resetDialogOpen = ref(false);

function openResetDialog(): void {
  resetDialogOpen.value = true;
}

// ---- Issue Temporary Access Pass -------------------------------------------

const tapDialogOpen = ref(false);

function onTapIssued(): void {
  void loadActivity();
}

async function onPasswordReset(outcome: ResetOutcome): Promise<void> {
  toast.add(passwordResetToast(outcome));
  await load();
}

// ---- Move to OU ----------------------------------------------------------

const {
  move: mover,
  open: moveDialogOpen,
  show: openMoveDialog,
  close: closeMoveDialog,
  dialogFailure: moveDialogFailure,
  pageFailure: movePageFailure,
  submitting: moveSubmitting,
} = useMoveDialog({ kind: 'user', id: () => props.id, onMoved: () => load() });

// ---- Account expiry ------------------------------------------------------

const {
  expiry,
  open: expiryDialogOpen,
  show: showExpiryDialog,
  close: closeExpiryDialog,
  dialogFailure: expiryDialogFailure,
  pageFailure: expiryPageFailure,
  submitting: expirySubmitting,
} = useExpiryDialog({ id: () => props.id, onSet: () => load() });

function openExpiryDialog(): void {
  if (user.value) showExpiryFor(user.value);
}

function showExpiryFor(u: UserDetail): void {
  showExpiryDialog({ id: u.id, name: nameOf(u), accountExpiresAt: u.accountExpiresAt });
}

// ---- Reassign direct reports ----------------------------------------------

const reassign = useReassignReports({
  managerId: () => props.id,
  manager: () => user.value,
  toast,
  reload: load,
});
const {
  hasReports,
  job: reassignJob,
  jobBusy: reassignJobBusy,
  jobRunning: reassignRunning,
  jobFailure: reassignJobFailure,
} = reassign;

// ---- Sign-in status --------------------------------------------------------

const blockers = computed(() => (user.value ? signInBlockers(user.value) : []));
const signInNoteList = computed(() => (user.value ? signInNotes(user.value) : []));

const fixes = useSignInFixes<UserDetail>({
  actions: accountActions,
  resetPassword: openResetDialog,
  extendExpiry: showExpiryFor,
  extendingExpiry: () => expirySubmitting.value,
});

const primaryFix = computed<SignInFix | null>(() => (user.value ? fixes.fixOf(user.value) : null));

const primaryFixRunning = computed(
  () => !!user.value && !!primaryFix.value && fixes.running(primaryFix.value, user.value),
);

function runFix(fix: SignInFix): void {
  if (user.value) fixes.run(fix, user.value);
}

const lockoutEndText = computed(() => {
  const locked = blockers.value.find((b) => b.kind === 'locked');
  return locked ? lockoutEnd(locked) : null;
});

// A failed account action, or a failed move or expiry change its dialog
// isn't showing (an Undo), shows under the Actions menu.
const actionFailure = computed<ActionFailure | null>(
  () => fixes.actionFailureOn(props.id) ?? movePageFailure.value ?? expiryPageFailure.value,
);

// ---- Group membership: remove + add --------------------------------------

async function onMembershipChanged(
  change: MembershipChange,
  m: Membership,
  offer: UndoOffer,
): Promise<void> {
  toast.add(
    undoable({ severity: 'success', summary: membershipDoneText(change, m), life: 3000 }, offer),
  );
  await load();
}

const {
  pending: groupPending,
  remove: removeMembership,
  failure: removeFailure,
  retry: retryRemove,
  dismiss: dismissRemoveFailure,
} = useGroupMembership({ onChanged: onMembershipChanged });

function removeGroup(group: UserDetail['groupMemberships'][number]): void {
  if (user.value) removeMembership(membershipOf(user.value, group));
}

const addGroupOpen = ref(false);
const {
  error: addGroupError,
  query: groupSearchQuery,
  queryTooShort: groupQueryTooShort,
  ready: addGroupReady,
  results: groupSearchResults,
  truncated: groupResultsTruncated,
  searching: groupSearchLoading,
  searchError: groupSearchError,
  existing: existingMembership,
  adding: addingGroupId,
  load: loadAddGroup,
  add: addToGroup,
  failure: addFailure,
  retry: retryAdd,
  dismiss: dismissAddFailure,
} = useAddToGroup({
  onChanged: async (change, m, offer) => {
    if (change === 'add') addGroupOpen.value = false;
    await onMembershipChanged(change, m, offer);
  },
});

const isThisUsers = (f: MembershipFailure) => f.op.membership.memberId === props.id;
const { onPage: removePageFailure } = placeFailure(removeFailure, { belongsHere: isThisUsers });
const { inDialog: addDialogFailure, onPage: addPageFailure } = placeFailure(addFailure, {
  belongsHere: isThisUsers,
  dialog: { open: () => addGroupOpen.value, made: (f) => !f.undo },
});

// Closing the dialog gives up on an add that failed in it.
function closeAddGroupDialog(): void {
  addGroupOpen.value = false;
  if (addDialogFailure.value) dismissAddFailure();
}

// A failed remove, or a failed change the add dialog isn't showing (an
// Undo), shows on the Groups tab.
const groupFailure = computed(() => {
  const remove = removePageFailure.value;
  const add = addPageFailure.value;
  const [f, retry, dismiss] = remove
    ? [remove, retryRemove, dismissRemoveFailure]
    : add
      ? [add, retryAdd, dismissAddFailure]
      : [null, null, null];
  if (!f) return null;
  return {
    summary: `Couldn’t ${membershipChangeText(f.op.change, f.op.membership)}`,
    message: f.message,
    retry,
    dismiss,
  };
});

// Another user's page reuses this one; what failed on the last one is moot.
watch(
  () => props.id,
  () => {
    accountActions.dismiss();
    mover.dismiss();
    expiry.dismiss();
    dismissRemoveFailure();
    dismissAddFailure();
  },
);

function openAddGroupDialog(): void {
  if (!user.value) return;
  addGroupOpen.value = true;
  void loadAddGroup(user.value.id);
}

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

// ---- Header ----------------------------------------------------------------

// The email when there is one, else the UPN or SAM name.
const identifier = computed(() => {
  const u = user.value;
  if (!u) return null;
  if (u.email) return { text: u.email, copyLabel: 'email' };
  return { text: u.userPrincipalName ?? u.samAccountName };
});

// `msteams:/l/chat/0/0?users=…` is the documented deep-link form. Browsers
// hand it to the OS handler, as with `mailto:`, so it opens the Teams app.
const links = computed<ObjectLink[]>(() => {
  const email = user.value?.email;
  if (!email) return [];
  return [
    { label: 'Email', icon: 'pi-envelope', href: `mailto:${email}`, title: 'Send email' },
    {
      label: 'Teams',
      icon: 'pi-comments',
      href: `msteams:/l/chat/0/0?users=${encodeURIComponent(email)}`,
      title: 'Open Teams chat',
    },
  ];
});

// Listed while the record loads too, so the layout can hold the Actions
// button's place.
const actions = computed<ObjectAction[]>(() => {
  const u = user.value;
  // The only disable case is "an action of this kind is already running" so
  // the operator can't double-fire.
  const busy =
    accountActionRunning.value !== null || moveSubmitting.value || expirySubmitting.value;
  const userAction = (action: UserAction, run: () => void): ObjectAction => {
    const info = USER_ACTIONS[action];
    return {
      label: userActionLabel(action, accountActionRunning.value),
      icon: info.icon,
      capability: info.capability,
      shortcut: info.shortcut,
      unavailable: u ? userActionUnavailable(action, u) : null,
      ...(info.danger ? { danger: true } : {}),
      // Reset password runs in its dialog.
      ...(info.running ? { disabled: busy } : {}),
      run,
    };
  };
  return [
    ...USER_ACTION_ORDER.map((a) =>
      userAction(a, a === 'reset-password' ? openResetDialog : () => runOnUser(a)),
    ),
    ...(u?.entra?.temporaryAccessPass
      ? [
          {
            label: 'Issue Temporary Access Pass…',
            icon: 'pi-ticket',
            capability: 'write:user.issueTap',
            shortcut: SHORTCUT_KEYS.user.issueTap,
            unavailable: u.enabled ? null : 'the account is disabled',
            run: () => {
              tapDialogOpen.value = true;
            },
          } satisfies ObjectAction,
        ]
      : []),
    {
      label: expirySubmitting.value ? 'Saving expiry…' : 'Account expiry…',
      icon: 'pi-calendar',
      capability: 'write:user.enableDisable',
      disabled: busy,
      run: openExpiryDialog,
    },
    {
      label: moveSubmitting.value ? 'Moving…' : 'Move to OU…',
      icon: 'pi-folder-open',
      capability: 'write:user.move',
      shortcut: SHORTCUT_KEYS.user.move,
      disabled: busy,
      run: openMoveDialog,
    },
    {
      label: 'Rename…',
      icon: 'pi-id-card',
      capability: 'write:user.rename',
      disabled: busy,
      run: () => {
        renameDialogOpen.value = true;
      },
    },
    {
      label: 'Copy…',
      icon: 'pi-copy',
      capability: 'write:user.create',
      run: () => {
        copyDialogOpen.value = true;
      },
    },
    {
      label: 'Reassign direct reports…',
      icon: 'pi-sitemap',
      capability: 'write:user.attributes',
      unavailable: u && !hasReports.value ? 'has no direct reports' : null,
      disabled: reassignRunning.value,
      run: reassign.open,
    },
    // Delete is offered only once the account is disabled, which is also
    // what the server enforces.
    {
      label: 'Delete…',
      icon: 'pi-trash',
      capability: 'write:user.delete',
      unavailable: u?.enabled === false ? null : 'only a disabled account can be deleted',
      danger: true,
      disabled: busy,
      run: () => {
        deleteDialogOpen.value = true;
      },
    },
  ];
});

// ---- Rename / delete -------------------------------------------------------
// Both run in their own dialogs; the view only opens them and reacts.
const router = useRouter();
const renameDialogOpen = ref(false);
const deleteDialogOpen = ref(false);
const copyDialogOpen = ref(false);

/** The operator lands on the copy's page. */
async function onCopied(created: UserCreateResponse): Promise<void> {
  copyDialogOpen.value = false;
  if (created.id) await router.push({ name: 'user-detail', params: { id: created.id } });
  announceUserCreated(toast, created);
}

async function onRenamed(): Promise<void> {
  toast.add({ severity: 'success', summary: 'User renamed', life: 4000 });
  await load();
}

function onDeleted(deletedIds: string[]): void {
  if (!deletedIds.includes(props.id)) return;
  toast.add({
    severity: 'success',
    summary: 'Account deleted',
    detail: `${user.value?.displayName ?? user.value?.samAccountName ?? 'The account'} was deleted.`,
    life: 5000,
  });
  deleteDialogOpen.value = false;
  void router.push({ name: 'user-search' });
}

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

// Overview and Debug are icon-only: their icons stand on their own, which
// leaves room for labels on the others.
const tabs = computed<ObjectPageTab<TabId>[]>(() => {
  const u = user.value;
  const list: ObjectPageTab<TabId>[] = [
    { id: 'overview', label: 'Overview', icon: 'pi-th-large', visible: true, iconOnly: true },
    { id: 'organization', label: 'Organization', icon: 'pi-sitemap', visible: true },
    { id: 'contact', label: 'Contact', icon: 'pi-envelope', visible: true },
    { id: 'account', label: 'Account', icon: 'pi-id-card', visible: true },
  ];
  list.push({
    id: 'groups',
    label: 'Groups',
    icon: 'pi-users',
    count: u?.groupMemberships.length ?? 0,
    visible: true,
  });
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

// First N groups for the Overview summary
const groupsTop = computed(() => (user.value?.groupMemberships ?? []).slice(0, 5));
const activityTop = computed(() => activityEvents.value.slice(0, 5));

// Auto-load a few recent events for the Overview card on first user load
watch(user, (u) => {
  if (u && !activityLoaded.value && !activityLoading.value) void loadActivity();
});
</script>

<template>
  <AppToast />
  <div class="page-inner detail-page">
    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <ObjectPageLayout
      v-if="user || loading"
      kind="user"
      :loading="!user"
      :skeleton="{ status: true, subtitle: true, cards: 4 }"
      :name="displayName"
      :avatar="{
        name: user?.displayName ?? user?.samAccountName ?? null,
        seed: user?.samAccountName ?? null,
        photoUrl,
      }"
      :subtitle="subtitle"
      :identifier="identifier"
      :dn="user?.distinguishedName ?? ''"
      :links="links"
      :tabs="tabs"
      fallback-tab="overview"
      :actions="actions"
      :actions-busy="accountActionRunning !== null || moveSubmitting || expirySubmitting"
      :action-failure="actionFailure"
      :refreshing="refreshing"
      :cached-at="user?.freshness.cachedAt ?? null"
      :live-refreshed-at="user?.freshness.liveRefreshedAt ?? null"
      @refresh="refreshFromAd"
    >
      <template v-if="user" #badges>
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
      </template>

      <template v-if="user" #status>
        <SignInStatus
          :blockers="blockers"
          :notes="signInNoteList"
          :last-logon-at="user.lastLogonAt"
        />
      </template>

      <template v-if="primaryFix" #primary="{ compact }">
        <Button
          :label="primaryFix.label"
          :icon="`pi ${primaryFix.icon}`"
          :size="compact ? 'small' : undefined"
          :loading="primaryFixRunning"
          :disabled="accountActionRunning !== null || moveSubmitting || expirySubmitting"
          @click="runFix(primaryFix)"
        />
      </template>

      <template v-if="user" #default="{ tab: activeTab, select: selectTab }">
        <BulkJobPanel
          v-if="reassignJob"
          :job="reassignJob"
          :failure="reassignJobFailure"
          :busy="reassignJobBusy"
          @stop="reassign.stopJob"
          @continue="reassign.continueJob"
          @retry="reassign.retryFailed"
          @revert="reassign.revertJob"
          @dismiss="reassign.dismissJob"
        />
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
                @click="selectTab('groups')"
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
                @click="selectTab('signins')"
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
              <router-link
                to="/audit"
                class="p-button p-button-text p-button-secondary p-button-sm"
              >
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
                :class="{ 'fld-multiline': f.multiline, 'fld-modified': changed(f.key) }"
              >
                <div class="fld-label">
                  {{ f.label }}
                  <span
                    v-if="changed(f.key)"
                    class="fld-modified-dot"
                    title="Unsaved change"
                  ></span>
                </div>
                <Textarea
                  v-if="canEdit && f.multiline"
                  v-model="draft[f.key]"
                  :invalid="!!problems[f.key]"
                  :placeholder="f.label"
                  :disabled="saving"
                  auto-resize
                  rows="2"
                  :class="['attr-input', { mono: f.mono }]"
                />
                <InputText
                  v-else-if="canEdit"
                  v-model="draft[f.key]"
                  :invalid="!!problems[f.key]"
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
                <small v-if="canEdit && problems[f.key]" class="fld-problem">{{
                  problems[f.key]
                }}</small>
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
          >
            <template v-if="canEdit && hasReports" #actions>
              <Button
                label="Reassign…"
                icon="pi pi-sitemap"
                size="small"
                severity="secondary"
                text
                :disabled="reassignRunning"
                @click="reassign.open"
              />
            </template>
          </ReportingStructureCard>

          <section v-if="extraAttrRows.length > 0" class="ident-section">
            <h3 class="ident-section-title">
              More from directory
              <span class="hint"
                >{{ extraAttrRows.length }} attribute{{
                  extraAttrRows.length === 1 ? '' : 's'
                }}</span
              >
            </h3>
            <div class="extras-grid">
              <div v-for="row in extraAttrRows" :key="row.key" class="extras-row">
                <div class="extras-key mono">{{ row.key }}</div>
                <div class="extras-vals">
                  <div
                    v-for="(val, idx) in row.values"
                    :key="`${row.key}-${idx}`"
                    class="extras-val"
                  >
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
                :class="{ 'fld-multiline': f.multiline, 'fld-modified': changed(f.key) }"
              >
                <div class="fld-label">
                  {{ f.label }}
                  <span
                    v-if="changed(f.key)"
                    class="fld-modified-dot"
                    title="Unsaved change"
                  ></span>
                </div>
                <Textarea
                  v-if="canEdit && f.multiline"
                  v-model="draft[f.key]"
                  :invalid="!!problems[f.key]"
                  :placeholder="f.label"
                  :disabled="saving"
                  auto-resize
                  rows="3"
                  :class="['attr-input', { mono: f.mono }]"
                />
                <InputText
                  v-else-if="canEdit"
                  v-model="draft[f.key]"
                  :invalid="!!problems[f.key]"
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
                <small v-if="canEdit && problems[f.key]" class="fld-problem">{{
                  problems[f.key]
                }}</small>
              </div>
            </div>

            <div v-if="arrayFieldsForSection(sec).length > 0" class="attr-multi-grid">
              <div
                v-for="f in arrayFieldsForSection(sec)"
                :key="f.key"
                class="fld attr-multi"
                :class="{ 'fld-modified': changed(f.key) }"
              >
                <div class="fld-label">
                  {{ f.label }}
                  <span v-if="(user[f.key]?.length ?? 0) > 0" class="ds-tab-count mono">
                    {{ user[f.key]!.length }}
                  </span>
                  <span
                    v-if="changed(f.key)"
                    class="fld-modified-dot"
                    title="Unsaved change"
                  ></span>
                </div>
                <Textarea
                  v-if="canEdit"
                  v-model="draft[f.key]"
                  :invalid="!!problems[f.key]"
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
                <small v-if="canEdit && problems[f.key]" class="fld-problem">{{
                  problems[f.key]
                }}</small>
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
              @click="openAddGroupDialog"
            />
          </div>

          <InlineFailure
            v-if="groupFailure"
            class="groups-failure"
            :summary="groupFailure.summary"
            :message="groupFailure.message"
            :busy="groupPending !== null || addingGroupId !== null"
            @retry="groupFailure.retry"
            @dismiss="groupFailure.dismiss"
          />

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
                  :removable="canManageGroups && groupPending?.membership.groupId !== g.id"
                  :to="{ name: 'group-detail', params: { id: g.id } }"
                  @remove="removeGroup(g)"
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
              <template v-if="lockoutEndText">
                <dt class="fld-label">Lockout ends</dt>
                <dd>{{ lockoutEndText }}</dd>
              </template>
              <dt class="fld-label">Last logon</dt>
              <dd class="mono">{{ fmtAbsolute(user.lastLogonAt) }}</dd>
            </dl>
            <div class="card-actions">
              <Button
                v-if="canUnlock"
                :label="user.locked ? 'Unlock account' : 'Not locked'"
                icon="pi pi-unlock"
                :disabled="!user.locked || accountActionRunning !== null"
                :severity="user.locked ? 'warn' : 'secondary'"
                :outlined="!user.locked"
                size="small"
                :loading="accountActionRunning === 'unlock'"
                @click="runOnUser('unlock')"
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
                @click="openResetDialog"
              />
            </div>
          </Card>

          <Card title="Lifecycle">
            <dl class="kv-grid">
              <dt class="fld-label">Account expires</dt>
              <dd class="mono">
                {{ user.accountExpiresAt ? `At ${expiryMoment(user.accountExpiresAt)}` : 'never' }}
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
          <div v-if="canEdit && dirty" class="save-bar save-bar-floating">
            <span class="save-bar-summary">
              <i class="pi pi-pencil" />
              <strong>{{ changes.length }}</strong>
              unsaved change{{ changes.length === 1 ? '' : 's' }}
            </span>
            <span class="save-bar-fields">
              <span v-for="d in changes" :key="d.key" class="dirty-chip">
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
                @click="resetDraft(user)"
              />
              <Button
                label="Save changes"
                icon="pi pi-check"
                size="small"
                :loading="saving"
                :disabled="!valid"
                @click="saveAttributes()"
              />
            </span>
            <div v-if="saveFailure" class="save-bar-failure" role="alert">
              <i class="pi pi-times-circle" aria-hidden="true" />
              <span>Save failed: {{ saveFailure }}</span>
              <Button
                icon="pi pi-times"
                text
                rounded
                size="small"
                severity="secondary"
                aria-label="Dismiss"
                @click="dismissSaveFailure"
              />
            </div>
          </div>
        </transition>
      </template>
    </ObjectPageLayout>
    <MoveToOuDialog
      :visible="moveDialogOpen"
      :move="mover"
      kind="user"
      :name="user ? nameOf(user) : ''"
      :failure="moveDialogFailure"
      @close="closeMoveDialog"
    />
    <ReassignReportsDialog :workflow="reassign" :manager-name="displayName" />
    <BulkRevertDialog :workflow="reassign.jobRevert" />
    <AccountExpiryDialog
      :visible="expiryDialogOpen"
      :expiry="expiry"
      :failure="expiryDialogFailure"
      @close="closeExpiryDialog"
    />

    <!-- Add group dialog: search by name; groups the user is directly in are
         shown but can't be added. -->
    <Dialog
      :visible="addGroupOpen"
      modal
      header="Add to group"
      :style="{ width: '32rem' }"
      :closable="addingGroupId === null"
      @update:visible="(v) => !v && closeAddGroupDialog()"
    >
      <p class="dialog-prose secondary">Search by name. Adding commits immediately.</p>
      <InputText v-model="groupSearchQuery" placeholder="Search groups…" autofocus fluid />
      <div class="group-search-results">
        <div v-if="groupSearchLoading" class="hint">Searching…</div>
        <EmptyState
          v-else-if="groupQueryTooShort"
          icon="pi pi-search"
          title="Type to search"
          :message="`At least ${MIN_GROUP_QUERY} characters.`"
          compact
        />
        <Message v-else-if="groupSearchError" severity="error" :closable="false">
          Couldn’t search groups: {{ groupSearchError }}
        </Message>
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
            :class="{ disabled: existingMembership(g.id) === 'direct' }"
          >
            <div class="group-result-meta">
              <span class="group-result-name">{{ g.name || g.distinguishedName }}</span>
              <span class="group-result-dn mono">{{ g.distinguishedName }}</span>
              <span v-if="existingMembership(g.id) === 'nested'" class="hint">
                member via a nested group
              </span>
            </div>
            <Button
              v-if="existingMembership(g.id) !== 'direct'"
              label="Add"
              icon="pi pi-plus"
              size="small"
              :loading="addingGroupId === g.id"
              :disabled="addingGroupId !== null || !addGroupReady"
              @click="addToGroup(g)"
            />
            <span v-else class="hint">already a member</span>
          </li>
        </ul>
        <p v-if="groupResultsTruncated && !groupSearchLoading" class="hint">
          Showing {{ groupSearchResults.length }} — refine your search
        </p>
      </div>
      <Message v-if="addGroupError" severity="error" :closable="false">{{ addGroupError }}</Message>
      <Message v-else-if="addDialogFailure" severity="error" closable @close="dismissAddFailure">
        Couldn’t
        {{ membershipChangeText(addDialogFailure.op.change, addDialogFailure.op.membership) }}:
        {{ addDialogFailure.message }}
      </Message>
      <template #footer>
        <Button label="Close" text severity="secondary" @click="closeAddGroupDialog" />
      </template>
    </Dialog>

    <ConfirmDialog v-bind="leaveDialog" />

    <ResetPasswordDialog v-model:visible="resetDialogOpen" :user="user" @reset="onPasswordReset" />
    <IssueTapDialog v-model:visible="tapDialogOpen" :user="user" @issued="onTapIssued" />
    <RenameUserDialog v-model:visible="renameDialogOpen" :user="user" @renamed="onRenamed" />
    <NewUserDialog
      v-if="copyDialogOpen"
      v-model:visible="copyDialogOpen"
      :copy-from="id"
      @created="onCopied"
    />
    <DeleteUsersDialog
      v-if="deleteDialogOpen"
      v-model:visible="deleteDialogOpen"
      :ids="[props.id]"
      @done="onDeleted"
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
}

.overview-activity {
  grid-column: 1 / -1;
}

.stale-flag {
  margin-left: 4px;
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

.fld-problem {
  color: var(--red);
  font-size: 12px;
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

/* On a phone a value beside its label would have a third of the card, so
   each label sits above its value. */
@media (max-width: 639.98px) {
  .kv-grid {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 2px;
  }

  .kv-grid dd + dt {
    margin-top: 10px;
  }
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

@media (max-width: 767.98px) {
  .card-actions :deep(.p-button) {
    min-height: var(--tap-target);
  }
}

.groups-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.groups-failure {
  margin-bottom: 14px;
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

.group-grid :deep(.gchip-wrap) {
  width: 100%;
}

.group-grid :deep(.gchip) {
  flex: 1 1 auto;
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
  flex-wrap: wrap;
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

.save-bar-failure {
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--red);
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

/* Dialogs ----------------------------------------------------------------- */
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
