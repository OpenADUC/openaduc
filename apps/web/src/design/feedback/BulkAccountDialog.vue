<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Move the selected users to an OU, or change an account setting across
  them: pick the change, see who it changes and who is already as asked,
  then confirm. Renders a useBulkAccountChange the page owns; confirming
  starts the bulk job.
-->
<script setup lang="ts">
import { computed } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import DatePicker from 'primevue/datepicker';
import Message from 'primevue/message';
import SelectButton from 'primevue/selectbutton';
import TreeSelect from 'primevue/treeselect';
import type { TreeNode } from 'primevue/treenode';
import type { BulkAccountOp } from '@openaduc/shared';
import {
  accountOpLabel,
  fromText,
  type useBulkAccountChange,
} from '../composables/useBulkAccountChange.js';
import { ouTreeNodes } from '../lib/ouTree.js';

const props = defineProps<{
  workflow: ReturnType<typeof useBulkAccountChange>;
  /** Selected users the list's filters hide. */
  hiddenCount: number;
}>();

const {
  visible,
  op,
  choices,
  title,
  confirmLabel,
  ous,
  ousLoading,
  ousError,
  destination,
  never,
  endOf,
  canPreview,
  preview,
  previewing,
  previewError,
  summary,
  notes,
  effect,
  canConfirm,
  hasMore,
  loadingMore,
} = props.workflow;
const w = props.workflow;

const opOptions = computed(() =>
  choices.value.map((value) => ({ label: accountOpLabel(value), value })),
);
const tree = computed<TreeNode[]>(() => ouTreeNodes(ous.value));
// PrimeVue TreeSelect keys its single selection by node key, which is the DN.
const selection = computed<Record<string, boolean>>({
  get: () => (destination.value ? { [destination.value]: true } : {}),
  set: (keys) => w.setDestination(Object.keys(keys).find((k) => keys[k]) ?? null),
});
const today = new Date(new Date().setHours(0, 0, 0, 0));

function pick(day: Date | Date[] | (Date | null)[] | null | undefined): void {
  if (day instanceof Date) w.setEndOf(day);
}

const unchangedLabel = computed(() => {
  if (op.value === 'move') return `Already in ${preview.value?.ou?.name ?? 'it'}`;
  return 'Already as asked, unchanged';
});
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="title"
    :style="{ width: '36rem' }"
    @update:visible="(v) => !v && w.close()"
  >
    <template v-if="!preview">
      <SelectButton
        v-if="opOptions.length > 1"
        :model-value="op"
        :options="opOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        aria-label="Account setting"
        class="ba-op"
        @update:model-value="(v: BulkAccountOp) => w.setOp(v)"
      />

      <template v-if="op === 'move'">
        <p class="ba-prose">Pick the OU to move them to.</p>
        <div v-if="ousLoading" class="hint">Loading OUs…</div>
        <Message v-else-if="ousError" severity="error" :closable="false">
          Couldn’t load the OUs: {{ ousError }}
        </Message>
        <TreeSelect
          v-else
          v-model="selection"
          :options="tree"
          selection-mode="single"
          placeholder="Pick a destination OU"
          aria-label="Destination OU"
          fluid
        />
      </template>

      <template v-else-if="op === 'accountExpiry'">
        <p class="ba-prose">Choose the last day they can sign in.</p>
        <label class="ba-choice">
          <input
            type="radio"
            name="bulk-account-expiry"
            :checked="!never"
            @change="w.setNever(false)"
          />
          <span>End of</span>
        </label>
        <DatePicker
          :model-value="endOf"
          :min-date="today"
          placeholder="Pick a day"
          show-icon
          icon-display="input"
          fluid
          class="ba-date"
          input-id="bulk-account-expiry-day"
          aria-label="Last day the accounts work"
          @update:model-value="pick"
        />
        <label class="ba-choice">
          <input
            type="radio"
            name="bulk-account-expiry"
            :checked="never"
            @change="w.setNever(true)"
          />
          <span>Never expires</span>
        </label>
      </template>

      <p v-else-if="op === 'mustChangePassword'" class="ba-prose">
        They’ll have to choose a new password the next time they sign in. Their current password
        keeps working until then.
      </p>
      <p v-else class="ba-prose">
        Their passwords will expire as the password policy says, instead of never.
      </p>

      <Message v-if="previewError" severity="error" :closable="false">
        Couldn’t work out what it would change: {{ previewError }}
      </Message>
    </template>

    <template v-else>
      <p v-if="hiddenCount > 0" class="ba-note">
        {{
          hiddenCount === 1
            ? '1 of them is hidden by the current filters.'
            : `${hiddenCount} of them are hidden by the current filters.`
        }}
      </p>
      <p v-if="preview.unknownCount > 0" class="ba-note">
        {{
          preview.unknownCount === 1
            ? '1 selected account isn’t in the directory any more; it will fail.'
            : `${preview.unknownCount} selected accounts aren’t in the directory any more; they will fail.`
        }}
      </p>
      <p class="ba-summary">{{ summary }}</p>
      <p v-if="preview.changed.count > 0" class="ba-note">{{ effect }}</p>
      <Message
        v-for="note in notes"
        :key="note.kind"
        severity="warn"
        :closable="false"
        class="ba-warning"
      >
        <p class="ba-warning-text">{{ note.text }}</p>
        <ul class="ba-names">
          <li v-for="u in note.users" :key="u.id">{{ u.name }}</li>
        </ul>
      </Message>

      <ul v-if="preview.changed.users.length > 0" class="ba-users" aria-label="Users it changes">
        <li v-for="u in preview.changed.users" :key="u.id" class="ba-user">
          <span>{{ u.name }}</span>
          <span v-if="fromText(op, u)" class="ba-from mono">{{ fromText(op, u) }}</span>
        </li>
      </ul>
      <div v-if="hasMore" class="ba-more">
        <span class="ba-note">
          {{ preview.changed.users.length }} of {{ preview.changed.count }} listed.
        </span>
        <Button
          label="Show more"
          size="small"
          severity="secondary"
          text
          :loading="loadingMore"
          @click="w.showMore"
        />
      </div>

      <details v-if="preview.unchanged.count > 0" class="ba-unchanged">
        <summary>{{ unchangedLabel }} ({{ preview.unchanged.count }})</summary>
        <ul>
          <li v-for="u in preview.unchanged.users" :key="u.id">{{ u.name }}</li>
        </ul>
        <p v-if="preview.unchanged.count > preview.unchanged.users.length" class="ba-note">
          The first {{ preview.unchanged.users.length }} are listed;
          {{ preview.unchanged.count - preview.unchanged.users.length }} more aren’t.
        </p>
      </details>
      <Message v-if="!canConfirm" severity="info" :closable="false">
        They’re all as asked already. There’s nothing to change.
      </Message>
      <Message v-if="previewError" severity="error" :closable="false">
        {{ previewError }}
      </Message>
    </template>

    <template #footer>
      <template v-if="preview">
        <Button label="Back" severity="secondary" text @click="w.back" />
        <Button :label="confirmLabel" :disabled="!canConfirm" @click="w.confirm" />
      </template>
      <template v-else>
        <Button label="Cancel" severity="secondary" text @click="w.close" />
        <Button
          label="Preview"
          icon="pi pi-eye"
          :loading="previewing"
          :disabled="!canPreview"
          @click="w.review"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.ba-op {
  margin-bottom: 12px;
}

.ba-prose {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text);
}

.ba-choice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 6px;
  font-size: 13px;
}

.ba-date {
  margin: 0 0 4px 24px;
  width: calc(100% - 24px);
}

.ba-summary {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.ba-note {
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.ba-warning {
  margin: 0 0 8px;
}

.ba-warning-text {
  margin: 0;
}

.ba-names {
  margin: 4px 0 0;
  padding-left: 18px;
  max-height: 6rem;
  overflow-y: auto;
  font-size: 12.5px;
}

.ba-users {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  max-height: 16rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.ba-user {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.ba-user:last-child {
  border-bottom: 0;
}

.ba-from {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ba-more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
}

.ba-unchanged {
  margin-top: 10px;
  font-size: 12.5px;
}

.ba-unchanged summary {
  cursor: pointer;
  color: var(--text-2);
}

.ba-unchanged ul {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 10rem;
  overflow-y: auto;
}
</style>
