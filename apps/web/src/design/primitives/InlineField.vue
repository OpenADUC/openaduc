<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

interface SelectOption {
  label: string;
  value: string;
}

const props = withDefaults(
  defineProps<{
    label: string;
    modelValue: string | null | undefined;
    placeholder?: string;
    type?: 'text' | 'select' | 'email' | 'tel';
    options?: SelectOption[];
    mono?: boolean | undefined;
    readonly?: boolean | undefined;
    busy?: boolean | undefined;
  }>(),
  { type: 'text', readonly: false, busy: false, mono: false },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'save', value: string): void;
}>();

const editing = ref(false);
const draft = ref<string>(props.modelValue ?? '');
const inputEl = ref<HTMLInputElement | HTMLSelectElement | null>(null);

watch(
  () => props.modelValue,
  (next) => {
    if (!editing.value) draft.value = next ?? '';
  },
);

const isEmpty = computed(() => !props.modelValue);
const display = computed(() => props.modelValue ?? props.placeholder ?? '—');

async function startEdit(): Promise<void> {
  if (props.readonly || props.busy) return;
  editing.value = true;
  draft.value = props.modelValue ?? '';
  await nextTick();
  inputEl.value?.focus();
  if (inputEl.value && 'select' in inputEl.value) {
    (inputEl.value as HTMLInputElement).select();
  }
}

function commit(): void {
  editing.value = false;
  emit('update:modelValue', draft.value);
  emit('save', draft.value);
}

function cancel(): void {
  draft.value = props.modelValue ?? '';
  editing.value = false;
}
</script>

<template>
  <div class="fld">
    <div class="fld-label">{{ label }}</div>
    <div
      v-if="!editing"
      class="fld-value"
      :class="{ editable: !readonly && !busy, empty: isEmpty }"
      :title="readonly ? 'Read-only' : 'Click to edit'"
      :role="readonly || busy ? undefined : 'button'"
      :tabindex="readonly || busy ? undefined : 0"
      @click="startEdit"
      @keydown.enter.prevent="startEdit"
      @keydown.space.prevent="startEdit"
    >
      <span :class="{ mono }" class="fld-display">{{ display }}</span>
      <i v-if="!readonly && !busy" class="pi pi-pencil fld-edit-icon" />
      <span v-if="busy" class="fld-busy">…</span>
    </div>
    <div v-else class="fld-value editing">
      <select
        v-if="type === 'select'"
        ref="inputEl"
        v-model="draft"
        class="fld-input"
        @keydown.enter.prevent="commit"
        @keydown.escape.prevent="cancel"
      >
        <option value="">—</option>
        <option v-for="o in options ?? []" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <input
        v-else
        ref="inputEl"
        v-model="draft"
        :type="type"
        class="fld-input"
        :class="{ mono }"
        :placeholder="placeholder"
        @keydown.enter.prevent="commit"
        @keydown.escape.prevent="cancel"
      />
      <div class="fld-actions">
        <button type="button" class="fld-iconbtn cancel" title="Cancel (Esc)" @click="cancel">
          <i class="pi pi-times" />
        </button>
        <button type="button" class="fld-iconbtn commit" title="Save (Enter)" @click="commit">
          <i class="pi pi-check" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fld-display {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fld-busy {
  color: var(--text-3);
  font-family: var(--font-mono);
  margin-left: auto;
}
</style>
