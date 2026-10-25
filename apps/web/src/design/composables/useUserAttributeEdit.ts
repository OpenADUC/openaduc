// SPDX-License-Identifier: BUSL-1.1
import { computed, reactive, ref } from 'vue';
import { userUpdateRequestSchema, type UserDetail, type UserUpdateRequest } from '@openaduc/shared';
import { api } from '../../api/index.js';
import { ApiError } from '../../api/client.js';
import { useAuthStore } from '../../stores/auth.js';

type Patch = NonNullable<UserUpdateRequest['patch']>;
const PATCH_FIELDS = userUpdateRequestSchema.shape.patch.shape;

export type UserAttribute = keyof typeof PATCH_FIELDS;
export type MultiValuedAttribute = {
  [K in UserAttribute]: UserDetail[K] extends string[] ? K : never;
}[UserAttribute];
export type ScalarAttribute = Exclude<UserAttribute, MultiValuedAttribute>;

// A multi-valued attribute is one whose patch takes a list of values.
const isMultiValued = (key: UserAttribute): key is MultiValuedAttribute =>
  PATCH_FIELDS[key].safeParse([]).success;
const ATTRIBUTES = Object.keys(PATCH_FIELDS) as UserAttribute[];
const SCALAR_ATTRIBUTES = ATTRIBUTES.filter((k): k is ScalarAttribute => !isMultiValued(k));
const MULTI_VALUED_ATTRIBUTES = ATTRIBUTES.filter(isMultiValued);

type AttributeChange =
  | { key: ScalarAttribute; from: string | null; to: string | null }
  | { key: MultiValuedAttribute; from: string[]; to: string[] };

/**
 * Edit a user's attributes and save the changes in one write. A failed save
 * stays in `failure` until the next save, a reset or `dismiss()`.
 */
export function useUserAttributeEdit(options: {
  onSaved?: (changed: number) => void | Promise<void>;
  onFailed?: (message: string) => void;
}) {
  const auth = useAuthStore();
  const user = ref<UserDetail | null>(null);
  const draft = reactive(emptyDraft());
  const saving = ref(false);
  const failure = ref<string | null>(null);

  function reset(u: UserDetail | null): void {
    user.value = u;
    failure.value = null;
    for (const key of SCALAR_ATTRIBUTES) draft[key] = u?.[key] ?? '';
    for (const key of MULTI_VALUED_ATTRIBUTES) draft[key] = (u?.[key] ?? []).join('\n');
  }

  // The loaded values are normalised too, so a value AD stores with
  // surrounding whitespace doesn't show as changed before any edit.
  const changes = computed<AttributeChange[]>(() => {
    const u = user.value;
    if (!u) return [];
    const list: AttributeChange[] = [];
    for (const key of SCALAR_ATTRIBUTES) {
      const from = u[key];
      const to = scalar(draft[key]);
      if (to !== scalar(from ?? '')) list.push({ key, from, to });
    }
    for (const key of MULTI_VALUED_ATTRIBUTES) {
      const from = u[key];
      const to = lines(draft[key]);
      if (!sameValues(to, lines(from.join('\n')))) list.push({ key, from, to });
    }
    return list;
  });
  const changedKeys = computed(() => new Set<UserAttribute>(changes.value.map((c) => c.key)));
  const dirty = computed(() => changes.value.length > 0);

  function changed(key: UserAttribute): boolean {
    return changedKeys.value.has(key);
  }

  const patch = computed<Patch>(() => {
    const p: Record<string, string | string[] | null> = {};
    for (const c of changes.value) {
      p[c.key] = Array.isArray(c.to) && c.to.length === 0 ? null : c.to;
    }
    return p as Patch;
  });

  // Checked against the API's own schema, so a value the server would refuse
  // is caught before the step-up prompt.
  const problems = computed(() => {
    const found: Partial<Record<UserAttribute, string>> = {};
    for (const [key, value] of Object.entries(patch.value)) {
      const problem = problemWith(key as UserAttribute, value);
      if (problem) found[key as UserAttribute] = problem;
    }
    return found;
  });
  const valid = computed(() => Object.keys(problems.value).length === 0);

  /** `after` runs once the save lands, after `onSaved`, including after a step-up. */
  function save(after?: () => void | Promise<void>): void {
    if (!user.value || !dirty.value || !valid.value || saving.value) return;
    auth.requireStepUp(() => commit(after));
  }

  async function commit(after?: () => void | Promise<void>): Promise<void> {
    if (!user.value || !dirty.value || !valid.value || saving.value) return;
    saving.value = true;
    failure.value = null;
    const count = changes.value.length;
    try {
      await api.users.update(user.value.id, { patch: patch.value });
      await options.onSaved?.(count);
      await after?.();
    } catch (err) {
      if (auth.retryAfterStepUp(err, () => commit(after))) return;
      failure.value = err instanceof ApiError ? err.message : String(err);
      options.onFailed?.(failure.value);
    } finally {
      saving.value = false;
    }
  }

  function dismiss(): void {
    failure.value = null;
  }

  return {
    draft,
    reset,
    changes,
    changed,
    dirty,
    problems,
    valid,
    saving,
    save,
    failure,
    dismiss,
  };
}

function emptyDraft(): Record<UserAttribute, string> {
  return Object.fromEntries(ATTRIBUTES.map((k) => [k, ''])) as Record<UserAttribute, string>;
}

function scalar(text: string): string | null {
  const t = text.trim();
  return t === '' ? null : t;
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function problemWith(key: UserAttribute, value: unknown): string | null {
  const result = PATCH_FIELDS[key].safeParse(value);
  if (result.success) return null;
  const issue = result.error.issues[0];
  if (issue?.code === 'too_big') {
    return issue.origin === 'array'
      ? `At most ${issue.maximum} values`
      : `At most ${issue.maximum} characters`;
  }
  return key === 'email' ? 'Not an email address' : 'Not a valid value';
}
