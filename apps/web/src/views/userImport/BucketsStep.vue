<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Step 4: rows grouped by a column's value into buckets, each created in
  one OU with one set of groups. A placement rule prefills a bucket with
  where the last import put that value; a row can move to another bucket.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Select from 'primevue/select';
import TreeSelect from 'primevue/treeselect';
import type { GroupSummary, ImportField } from '@openaduc/shared';
import type { useUserImport } from '../../design/composables/useUserImport.js';
import { useOuTree } from '../../design/composables/useOuTree.js';
import { MIN_GROUP_QUERY } from '../../design/composables/useAddToGroup.js';
import { ouTreeNodes } from '../../design/lib/ouTree.js';
import { fmtDate } from '../../design/lib/format.js';

const props = defineProps<{ wizard: ReturnType<typeof useUserImport> }>();
const w = props.wizard;
const {
  groupBy,
  groupByOptions,
  buckets,
  bucketProblems,
  canAddGroups,
  groupSearch,
  namesReady,
  pending,
} = w;
const { query, results, searching, searchError, queryTooShort } = groupSearch;

const { ous, loading: ousLoading, error: ousError, load: loadOus } = useOuTree();
const ouTree = computed(() => ouTreeNodes(ous.value));
onMounted(() => void loadOus());

// A bucket of people already in the directory creates no one, so has nothing to place.
const shown = computed(() => buckets.value.filter((b) => b.creating > 0));
const targets = computed(() => buckets.value.map((b) => ({ value: b.key, label: b.label })));
/** The bucket whose group search is open. */
const addingTo = ref<string | null>(null);

const selection = (dn: string | null) => (dn ? { [dn]: true } : {});
function pickOu(key: string, keys: Record<string, boolean>): void {
  w.setBucketOu(key, Object.keys(keys).find((k) => keys[k]) ?? null);
}
function openSearch(key: string): void {
  groupSearch.reset();
  addingTo.value = addingTo.value === key ? null : key;
}
function addGroup(group: GroupSummary): void {
  if (addingTo.value !== null) w.addBucketGroup(addingTo.value, group);
}
const REMEMBER = {
  new: 'Remembered for this value as a new placement rule when the import runs.',
  update: 'Replaces this value’s placement rule when the import runs.',
  keep: 'This value’s placement rule stays as it is.',
};
const ouName = (dn: string) =>
  ous.value.find((o) => o.distinguishedName.toLowerCase() === dn.toLowerCase())?.name ?? dn;
</script>

<template>
  <div class="bk">
    <div class="bk-group-by">
      <label class="fld-label" for="bk-group-by">Group rows by</label>
      <Select
        input-id="bk-group-by"
        :model-value="groupBy"
        :options="groupByOptions"
        option-label="label"
        option-value="value"
        @update:model-value="(f: ImportField | null) => w.setGroupBy(f)"
      />
    </div>
    <Message v-if="ousError" severity="error" :closable="false">{{ ousError }}</Message>
    <Message v-if="!pending && !namesReady" severity="warn" :closable="false" class="bk-msg">
      Some names need another look in their new OUs.
      <Button label="Review names" size="small" text @click="w.goTo('names')" />
    </Message>

    <section v-for="b in shown" :key="b.key" class="bk-bucket">
      <header class="bk-head">
        <h3 class="bk-title">{{ b.label }}</h3>
        <span class="hint">{{ b.creating }} to create</span>
        <span v-if="b.rule" class="bk-rule" :title="`Saved ${fmtDate(b.rule.updatedAt)}`">
          <i class="pi pi-bookmark" aria-hidden="true" /> Placement rule
        </span>
      </header>

      <div class="bk-field">
        <label class="fld-label" :for="`bk-ou-${b.key}`">Create in</label>
        <TreeSelect
          :model-value="selection(b.placement.ouDn)"
          :input-id="`bk-ou-${b.key}`"
          :options="ouTree"
          :loading="ousLoading"
          selection-mode="single"
          placeholder="Pick an OU"
          fluid
          @update:model-value="(keys: Record<string, boolean>) => pickOu(b.key, keys)"
        />
        <span
          v-if="b.rule && b.placement.ouDn?.toLowerCase() !== b.rule.ouDn.toLowerCase()"
          class="bk-note"
        >
          The placement rule puts {{ b.label }} in {{ ouName(b.rule.ouDn) }}.
          <Button label="Use it" size="small" text @click="w.useRule(b.key)" />
        </span>
      </div>

      <div class="bk-field">
        <span class="fld-label">Groups</span>
        <p v-if="!canAddGroups" class="bk-note">
          You can’t change group memberships, so the import adds no groups.
        </p>
        <template v-else>
          <ul
            v-if="b.placement.groups.length"
            class="bk-chips"
            :aria-label="`Groups for ${b.label}`"
          >
            <li v-for="g in b.placement.groups" :key="g.id" class="bk-chip">
              <span>{{ g.name }}</span>
              <button
                type="button"
                class="bk-chip-remove"
                :aria-label="`Remove ${g.name}`"
                @click="w.removeBucketGroup(b.key, g.id)"
              >
                <i class="pi pi-times" />
              </button>
            </li>
          </ul>
          <Button
            :label="addingTo === b.key ? 'Done' : 'Add a group'"
            :icon="addingTo === b.key ? 'pi pi-check' : 'pi pi-plus'"
            size="small"
            severity="secondary"
            outlined
            class="bk-add"
            @click="openSearch(b.key)"
          />
          <div v-if="addingTo === b.key" class="bk-search">
            <InputText
              v-model="query"
              placeholder="Search groups…"
              aria-label="Search groups"
              autofocus
              fluid
            />
            <p v-if="queryTooShort" class="hint">At least {{ MIN_GROUP_QUERY }} characters.</p>
            <p v-else-if="searching" class="hint">Searching…</p>
            <Message v-else-if="searchError" severity="error" :closable="false">
              Couldn’t search groups: {{ searchError }}
            </Message>
            <p v-else-if="results.length === 0" class="hint">No matches.</p>
            <ul v-else class="bk-results">
              <li v-for="g in results" :key="g.id">
                <span class="bk-result-name">{{ g.name || g.distinguishedName }}</span>
                <span v-if="b.placement.groups.some((p) => p.id === g.id)" class="hint">added</span>
                <Button
                  v-else
                  label="Add"
                  icon="pi pi-plus"
                  size="small"
                  text
                  @click="addGroup(g)"
                />
              </li>
            </ul>
          </div>
        </template>
      </div>

      <p v-if="b.remember" class="bk-note">
        <i class="pi pi-bookmark" aria-hidden="true" />
        {{ REMEMBER[b.remember] }}
      </p>

      <details class="bk-rows">
        <summary>Rows ({{ b.rows.length }})</summary>
        <ul>
          <li v-for="r in b.rows" :key="r" class="bk-row">
            <span class="bk-line">Row {{ w.lineOf(r) }}</span>
            <span class="bk-row-name">{{ w.nameOf(r) }}</span>
            <span v-if="w.reviews.value.get(r)?.review.existing" class="hint">skipped</span>
            <Button
              label="Leave out"
              size="small"
              text
              severity="secondary"
              :aria-label="`Leave row ${w.lineOf(r)} out`"
              @click="w.exclude(r)"
            />
            <Select
              v-if="targets.length > 1"
              :model-value="b.key"
              :options="targets"
              option-label="label"
              option-value="value"
              size="small"
              :aria-label="`Bucket for row ${w.lineOf(r)}`"
              @update:model-value="(key: string) => w.moveRow(r, key)"
            />
          </li>
        </ul>
      </details>
    </section>

    <Message v-for="p in bucketProblems" :key="p" severity="error" :closable="false" class="bk-msg">
      {{ p }}
    </Message>
    <p v-if="groupBy" class="hint">
      Where each bucket goes is remembered as a placement rule when the import runs.
    </p>
  </div>
</template>

<style scoped>
.bk-group-by {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.bk-bucket {
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.bk-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}

.bk-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.bk-rule {
  font-size: 11.5px;
  color: var(--accent-text);
}

.bk-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.bk-note {
  font-size: 12px;
  color: var(--text-3);
}

.bk-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.bk-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12.5px;
}

.bk-chip-remove {
  border: 0;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  padding: 2px 4px;
}

.bk-add {
  align-self: flex-start;
}

.bk-search {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 28rem;
}

.bk-results {
  list-style: none;
  margin: 0;
  padding: 0;
}

.bk-results li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
}

.bk-rows summary {
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-2);
}

.bk-rows ul {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}

.bk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  font-size: 12.5px;
}

.bk-line {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-3);
}

.bk-row-name {
  flex: 1;
  color: var(--text);
}

.bk-msg {
  margin: 8px 0;
}
</style>
