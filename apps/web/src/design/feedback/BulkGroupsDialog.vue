<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Add the selected users to groups, or remove them: pick the groups, see
  per group what it would change, then confirm. Renders a
  useBulkGroupMembership the page owns; confirming starts the bulk job.
-->
<script setup lang="ts">
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import SelectButton from 'primevue/selectbutton';
import { MAX_BULK_GROUPS, type BulkMembershipOp } from '@openaduc/shared';
import EmptyState from '../primitives/EmptyState.vue';
import { MIN_GROUP_QUERY } from '../composables/useAddToGroup.js';
import type { useBulkGroupMembership } from '../composables/useBulkGroupMembership.js';

const props = defineProps<{
  workflow: ReturnType<typeof useBulkGroupMembership>;
  /** Selected users the list's filters hide. */
  hiddenCount: number;
}>();

const {
  visible,
  op,
  title,
  confirmLabel,
  query,
  queryTooShort,
  results,
  total,
  searching,
  searchError,
  chosen,
  full,
  canPreview,
  preview,
  previewing,
  previewError,
  lines,
  changes,
} = props.workflow;
const w = props.workflow;

const opOptions: { label: string; value: BulkMembershipOp }[] = [
  { label: 'Add to groups', value: 'add' },
  { label: 'Remove from groups', value: 'remove' },
];
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
        :model-value="op"
        :options="opOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        aria-label="Add or remove"
        class="bg-op"
        @update:model-value="(v: BulkMembershipOp) => w.setOp(v)"
      />

      <ul v-if="chosen.length > 0" class="bg-chosen" aria-label="Chosen groups">
        <li v-for="g in chosen" :key="g.id" class="bg-chip">
          <span>{{ g.name || g.distinguishedName }}</span>
          <button
            type="button"
            class="bg-chip-remove"
            :aria-label="`Remove ${g.name || g.distinguishedName}`"
            @click="w.unchoose(g.id)"
          >
            <i class="pi pi-times" />
          </button>
        </li>
      </ul>

      <InputText
        v-model="query"
        placeholder="Search groups…"
        aria-label="Search groups"
        autofocus
        fluid
      />
      <div class="bg-results">
        <div v-if="searching" class="hint">Searching…</div>
        <EmptyState
          v-else-if="queryTooShort"
          icon="pi pi-search"
          title="Type to search"
          :message="`At least ${MIN_GROUP_QUERY} characters.`"
          compact
        />
        <Message v-else-if="searchError" severity="error" :closable="false">
          Couldn’t search groups: {{ searchError }}
        </Message>
        <EmptyState
          v-else-if="results.length === 0"
          icon="pi pi-inbox"
          title="No matches"
          compact
        />
        <ul v-else class="bg-result-list">
          <li v-for="g in results" :key="g.id" class="bg-result">
            <div class="bg-result-meta">
              <span class="bg-result-name">{{ g.name || g.distinguishedName }}</span>
              <span class="bg-result-dn mono">{{ g.distinguishedName }}</span>
            </div>
            <span v-if="w.isChosen(g.id)" class="hint">chosen</span>
            <Button
              v-else
              label="Choose"
              icon="pi pi-plus"
              size="small"
              severity="secondary"
              :disabled="full"
              @click="w.choose(g)"
            />
          </li>
        </ul>
        <p v-if="total > results.length && !searching" class="hint">
          Showing {{ results.length }}. Refine your search.
        </p>
        <p v-if="full" class="hint">Choose at most {{ MAX_BULK_GROUPS }} groups at a time.</p>
      </div>
      <Message v-if="previewError" severity="error" :closable="false">
        Couldn’t work out what it would change: {{ previewError }}
      </Message>
    </template>

    <template v-else>
      <p v-if="hiddenCount > 0" class="bg-note">
        {{
          hiddenCount === 1
            ? '1 of them is hidden by the current filters.'
            : `${hiddenCount} of them are hidden by the current filters.`
        }}
      </p>
      <p v-if="preview.unknownCount > 0" class="bg-note">
        {{
          preview.unknownCount === 1
            ? '1 selected account isn’t in the directory any more; it will fail.'
            : `${preview.unknownCount} selected accounts aren’t in the directory any more; they will fail.`
        }}
      </p>
      <section v-for="line in lines" :key="line.group.id" class="bg-group">
        <h3 class="bg-group-name">{{ line.group.name }}</h3>
        <Message v-if="line.warning" severity="warn" :closable="false" class="bg-warning">
          {{ line.warning }}
        </Message>
        <p class="bg-summary">{{ line.summary }}</p>
        <p v-if="line.indirect" class="bg-note">{{ line.indirect }}</p>
        <details v-if="line.group.unchanged.count > 0" class="bg-unchanged">
          <summary>{{ line.unchangedLabel }} ({{ line.group.unchanged.count }})</summary>
          <ul>
            <li v-for="u in line.group.unchanged.users" :key="u.id">{{ u.name }}</li>
          </ul>
          <p v-if="line.unlisted > 0" class="bg-note">
            The first {{ line.group.unchanged.users.length }} are listed; {{ line.unlisted }} more
            aren’t.
          </p>
        </details>
      </section>
      <Message v-if="changes === 0" severity="info" :closable="false">
        {{
          op === 'add'
            ? 'They’re all members already. There’s nothing to add.'
            : 'None of them is a member. There’s nothing to remove.'
        }}
      </Message>
    </template>

    <template #footer>
      <template v-if="preview">
        <Button label="Back" severity="secondary" text @click="w.back" />
        <Button
          :label="confirmLabel"
          :icon="op === 'add' ? 'pi pi-user-plus' : 'pi pi-user-minus'"
          :severity="op === 'remove' ? 'danger' : undefined"
          :disabled="changes === 0"
          @click="w.confirm"
        />
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
.bg-op {
  margin-bottom: 12px;
}

.bg-chosen {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.bg-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12.5px;
}

.bg-chip-remove {
  border: 0;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 999px;
}

.bg-chip-remove:hover {
  color: var(--text);
}

.bg-results {
  margin-top: 12px;
  min-height: 120px;
  max-height: 320px;
  overflow: auto;
}

.bg-result-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bg-result {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-2);
}

.bg-result-meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bg-result-name {
  font-size: 13px;
  color: var(--text);
}

.bg-result-dn {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bg-group {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.bg-group:last-of-type {
  border-bottom: 0;
}

.bg-group-name {
  margin: 0 0 6px;
  font-size: 13.5px;
  font-weight: 600;
}

.bg-warning {
  margin: 0 0 6px;
}

.bg-summary {
  margin: 0;
  font-size: 13px;
}

.bg-note {
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.bg-unchanged {
  margin-top: 6px;
  font-size: 12.5px;
}

.bg-unchanged summary {
  cursor: pointer;
  color: var(--text-2);
}

.bg-unchanged ul {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 10rem;
  overflow-y: auto;
}
</style>
