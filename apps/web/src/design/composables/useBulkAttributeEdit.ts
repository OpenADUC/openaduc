// SPDX-License-Identifier: BUSL-1.1
// Edit the attributes of a selection of users: leave each field
// unchanged, set it or clear it, with each field's current values across
// the users (from the cache) shown beside it; see user by user what it
// would change (nothing written), then confirm, which starts a bulk job
// (useBulkActions.startAttributeEdit) and prompts step-up first.

import { computed, reactive, ref, shallowRef } from 'vue';
import {
  BULK_ATTRIBUTE_FIELDS,
  bulkAttributeChangesSchema,
  type BulkAttributeChanges,
  type BulkAttributeField,
  type BulkAttributeValue,
  type BulkUserAttributesPreview,
  type BulkUserAttributesRequest,
  type UserSummary,
} from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { ATTRIBUTE_LABELS } from '../lib/bulkAttributes.js';
import { accounts } from '../lib/bulkJob.js';
import { latestRequest } from '../lib/latestRequest.js';
import { useAttributeEditPreview } from './useAttributeEditPreview.js';
import { useUserPick } from './useUserPick.js';

export type FieldMode = 'keep' | 'set' | 'clear';

/** Shown for a field the users hold different values in. */
export const MULTIPLE_VALUES = '(multiple values)';
/** Shown for a field the cache hasn't read for some of the users. */
export const NOT_READ_YET = 'not known yet for some of them';

const FIELDS = bulkAttributeChangesSchema.shape;

const message = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));

/** What a field holds across the users, as the form shows it beside the field. */
export function currentText(value: BulkAttributeValue | undefined): string | null {
  if (!value) return null;
  if (value.kind === 'multiple') return MULTIPLE_VALUES;
  if (value.kind === 'unknown') return NOT_READ_YET;
  return value.value;
}

export function useBulkAttributeEdit(options: {
  /** The selected users, read when the dialog opens and when the preview is asked for. */
  ids: () => string[];
  /** Start the job on what was previewed; useBulkActions prompts step-up first. */
  start: (edit: BulkUserAttributesRequest) => void;
}) {
  const visible = ref(false);
  const current = shallowRef<BulkUserAttributesPreview['current'] | null>(null);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const loads = latestRequest();

  const modes = reactive(
    Object.fromEntries(BULK_ATTRIBUTE_FIELDS.map((f) => [f, 'keep'])) as Record<
      BulkAttributeField,
      FieldMode
    >,
  );
  /** What each field is set to; the manager's and country's are picked, not typed. */
  const values = reactive(
    Object.fromEntries(BULK_ATTRIBUTE_FIELDS.map((f) => [f, ''])) as Record<
      BulkAttributeField,
      string
    >,
  );
  const managerPick = useUserPick();
  const manager = managerPick.chosen;

  const {
    review: reviewEdit,
    request,
    forget: forgetPreview,
    ...previewState
  } = useAttributeEditPreview();
  const { preview, previewing, mayChange } = previewState;

  const count = computed(() => options.ids().length);

  const changes = computed<BulkAttributeChanges>(() => {
    const out: Record<string, string | string[] | null> = {};
    for (const field of BULK_ATTRIBUTE_FIELDS) {
      if (modes[field] === 'keep') continue;
      if (modes[field] === 'clear') out[field] = null;
      else if (field === 'manager') out[field] = manager.value?.id ?? '';
      else if (field === 'postOfficeBox') out[field] = lines(values[field]);
      else out[field] = values[field].trim();
    }
    return out as BulkAttributeChanges;
  });
  const changedFields = computed(() =>
    BULK_ATTRIBUTE_FIELDS.filter((f) => changes.value[f] !== undefined),
  );

  // Checked against the API's own schema, so a value the server would
  // refuse is caught before the preview.
  const problems = computed(() => {
    const found: Partial<Record<BulkAttributeField, string>> = {};
    for (const field of changedFields.value) {
      const value = changes.value[field];
      if (value === '' || (Array.isArray(value) && value.length === 0)) {
        found[field] = field === 'manager' ? 'Choose a manager' : 'Enter a value, or clear it';
        continue;
      }
      const result = FIELDS[field].safeParse(value);
      if (result.success) continue;
      const issue = result.error.issues[0];
      found[field] =
        issue?.code === 'too_big'
          ? issue.origin === 'array'
            ? `At most ${issue.maximum} values`
            : `At most ${issue.maximum} characters`
          : 'Not a valid value';
    }
    return found;
  });
  const canPreview = computed(
    () =>
      count.value > 0 &&
      changedFields.value.length > 0 &&
      Object.keys(problems.value).length === 0 &&
      !previewing.value,
  );
  const title = computed(() =>
    preview.value ? `Edit ${accounts(count.value)}?` : `Edit ${accounts(count.value)}`,
  );
  const confirmLabel = computed(() => {
    const n = mayChange.value;
    return `Edit ${n === 1 ? 'account' : accounts(n)}`;
  });

  /** What the field holds across the users: a value, empty (null), or MULTIPLE_VALUES. */
  function shown(field: BulkAttributeField): string | null {
    return currentText(current.value?.[field]);
  }

  /** Leave the field unchanged, set it or clear it. Setting a shared value starts from it. */
  function setMode(field: BulkAttributeField, mode: FieldMode): void {
    if (modes[field] === mode) return;
    modes[field] = mode;
    forgetPreview();
    if (mode !== 'set' || field === 'manager' || field === 'country' || field === 'postOfficeBox') {
      return;
    }
    const now = current.value?.[field];
    if (values[field] === '' && now?.kind === 'same' && now.value) values[field] = now.value;
  }

  function setValue(field: BulkAttributeField, value: string): void {
    values[field] = value;
    forgetPreview();
  }

  function chooseManager(user: UserSummary): void {
    managerPick.choose(user);
    forgetPreview();
  }

  async function open(): Promise<void> {
    for (const field of BULK_ATTRIBUTE_FIELDS) {
      modes[field] = 'keep';
      values[field] = '';
    }
    managerPick.reset();
    forgetPreview();
    current.value = null;
    loadError.value = null;
    visible.value = true;
    const isCurrent = loads.begin();
    loading.value = true;
    try {
      const { current: now } = await api.users.previewAttributeEdit({
        ids: options.ids(),
        changes: {},
      });
      if (isCurrent()) current.value = now;
    } catch (err) {
      if (isCurrent()) loadError.value = message(err);
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  function close(): void {
    visible.value = false;
    loads.begin();
    loading.value = false;
    forgetPreview();
  }

  async function review(): Promise<void> {
    if (canPreview.value) await reviewEdit(options.ids(), changes.value);
  }

  /** Back from the preview to change the fields. */
  function back(): void {
    forgetPreview();
  }

  function confirm(): void {
    const edit = request(options.ids());
    if (!edit) return;
    close();
    options.start(edit);
  }

  return {
    visible,
    count,
    title,
    confirmLabel,
    current,
    loading,
    loadError,
    modes,
    values,
    manager,
    managerQuery: managerPick.query,
    managerResults: managerPick.results,
    managerSearching: managerPick.searching,
    managerSearchError: managerPick.searchError,
    changes,
    changedFields,
    problems,
    canPreview,
    ...previewState,
    shown,
    label: (field: BulkAttributeField) => ATTRIBUTE_LABELS[field],
    setMode,
    setValue,
    chooseManager,
    open,
    close,
    review,
    back,
    confirm,
  };
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}
