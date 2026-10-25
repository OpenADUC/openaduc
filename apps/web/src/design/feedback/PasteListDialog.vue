<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import Message from 'primevue/message';
import { MAX_USER_MATCH_ENTRIES, type UserMatchCandidate } from '@openaduc/shared';
import { usePastedListSelection } from '../composables/usePastedListSelection.js';
import { dnPath, rdns } from '../lib/dn.js';

const visible = defineModel<boolean>('visible', { required: true });
const selected = defineModel<Set<string>>('selected', { required: true });
const props = defineProps<{ isLoaded: (id: string) => boolean }>();

const {
  text,
  entries,
  tooMany,
  phase,
  error,
  results,
  matched,
  ambiguous,
  unmatched,
  unresolved,
  picks,
  selection,
  notLoaded,
  disabled,
  match,
  pick,
  edit,
  reset,
  apply,
} = usePastedListSelection({ selectedIds: selected, isLoaded: (id) => props.isLoaded(id) });

watch(visible, (open) => {
  if (open) reset();
});

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const users = (n: number) => plural(n, 'user', 'users');

const tooManyNote = computed(
  () =>
    `That's ${entries.value.length.toLocaleString()} entries. Match up to ${MAX_USER_MATCH_ENTRIES.toLocaleString()} at a time.`,
);

const summary = computed(() => {
  const n = selection.value.length;
  const parts = [
    `${users(n)} found from ${plural(results.value.length, 'entry', 'entries')}` +
      (disabled.value > 0 ? `, ${disabled.value.toLocaleString()} of them disabled.` : '.'),
  ];
  if (notLoaded.value > 0) {
    parts.push(
      `${plural(notLoaded.value, 'more user isn’t', 'more users aren’t')} in the loaded list. Refresh the list to include them.`,
    );
  }
  if (unresolved.value > 0) {
    parts.push(
      `Pick who you mean for ${plural(unresolved.value, 'entry', 'entries')} below, or ${unresolved.value === 1 ? 'it' : 'they'}'ll be skipped.`,
    );
  }
  return parts.join(' ');
});

function name(u: UserMatchCandidate): string {
  return u.displayName || u.samAccountName;
}

function where(u: UserMatchCandidate): string {
  return dnPath(rdns(u.distinguishedName).slice(1));
}

function details(u: UserMatchCandidate): string {
  return [u.userPrincipalName ?? u.samAccountName, u.department, u.title]
    .filter(Boolean)
    .join(' · ');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void match();
  }
}

function finish(mode: 'replace' | 'add'): void {
  apply(mode);
  visible.value = false;
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    class="ds-sheet"
    header="Select users from a list"
    :style="{ width: '38rem' }"
  >
    <template v-if="phase !== 'review'">
      <label for="paste-list-input" class="pl-intro">
        Paste emails, usernames, UPNs or display names, one per line or separated by commas.
      </label>
      <Textarea
        id="paste-list-input"
        v-model="text"
        rows="9"
        fluid
        autofocus
        spellcheck="false"
        class="pl-input"
        :disabled="phase === 'matching'"
        placeholder="jane.doe@example.com&#10;CORP\bsmith&#10;Carol Chen"
        @keydown="onKeydown"
      />
      <p v-if="tooMany" class="pl-note pl-note-error" role="alert">{{ tooManyNote }}</p>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    </template>

    <template v-else>
      <p class="pl-summary" role="status">{{ summary }}</p>

      <section v-if="ambiguous.length > 0" class="pl-section">
        <h3 class="pl-head">More than one match ({{ ambiguous.length }})</h3>
        <fieldset v-for="r in ambiguous" :key="r.entry" class="pl-choice">
          <legend class="pl-entry">{{ r.entry }}</legend>
          <label v-for="c in r.candidates" :key="c.id" class="pl-option">
            <input
              type="radio"
              :name="`pick-${r.entry}`"
              :checked="picks.get(r.entry) === c.id"
              @change="pick(r.entry, c.id)"
            />
            <span class="pl-person">
              <span class="pl-name">
                {{ name(c) }}
                <span v-if="!c.enabled" class="pl-tag">Disabled</span>
              </span>
              <span class="pl-detail">{{ details(c) }}</span>
              <span class="pl-detail" :title="c.distinguishedName">{{ where(c) }}</span>
            </span>
          </label>
          <label class="pl-option">
            <input
              type="radio"
              :name="`pick-${r.entry}`"
              :checked="!picks.has(r.entry)"
              @change="pick(r.entry, null)"
            />
            <span class="pl-skip">Skip this entry</span>
          </label>
        </fieldset>
      </section>

      <section v-if="unmatched.length > 0" class="pl-section">
        <h3 class="pl-head">No match ({{ unmatched.length }})</h3>
        <p class="pl-note">Skipped. Go back to fix a typo and match again.</p>
        <ul class="pl-list">
          <li v-for="r in unmatched" :key="r.entry" class="pl-entry">{{ r.entry }}</li>
        </ul>
      </section>

      <details v-if="matched.length > 0" class="pl-section">
        <summary class="pl-head">Matched ({{ matched.length }})</summary>
        <ul class="pl-list">
          <li v-for="r in matched" :key="r.entry">
            <span class="pl-entry">{{ r.entry }}</span>
            <span class="pl-detail">{{ name(r.user) }}</span>
          </li>
        </ul>
      </details>
    </template>

    <template #footer>
      <template v-if="phase === 'review'">
        <Button label="Back" severity="secondary" text @click="edit" />
        <Button
          v-if="selected.size > 0"
          :label="`Add to the ${selected.size.toLocaleString()} selected`"
          severity="secondary"
          outlined
          :disabled="selection.length === 0"
          @click="finish('add')"
        />
        <Button
          :label="selection.length === 0 ? 'Select users' : `Select ${users(selection.length)}`"
          icon="pi pi-check"
          :disabled="selection.length === 0"
          @click="finish('replace')"
        />
      </template>
      <template v-else>
        <Button label="Cancel" severity="secondary" text @click="visible = false" />
        <Button
          label="Find users"
          icon="pi pi-search"
          :loading="phase === 'matching'"
          :disabled="entries.length === 0 || tooMany"
          @click="match"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.pl-intro {
  display: block;
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-2);
}

.pl-input {
  font-family: var(--font-mono);
  font-size: 13px;
  resize: vertical;
}

.pl-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-3);
}

.pl-note-error {
  color: var(--red);
}

.pl-summary {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--text);
}

.pl-section {
  margin-top: 16px;
}

.pl-head {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

details > .pl-head {
  cursor: pointer;
}

.pl-choice {
  margin: 0 0 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.pl-choice > legend {
  padding: 0 4px;
}

.pl-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
}

.pl-option > input {
  margin: 3px 0 0;
  accent-color: var(--accent);
}

.pl-person {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pl-name {
  font-size: 13px;
  color: var(--text);
}

.pl-detail {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pl-skip {
  font-size: 13px;
  color: var(--text-2);
}

.pl-tag {
  margin-left: 4px;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text-2);
}

.pl-entry {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  overflow-wrap: anywhere;
}

.pl-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 12rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.pl-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-soft);
}

.pl-list li:last-child {
  border-bottom: 0;
}

.pl-list li > .pl-detail {
  margin-left: auto;
}

@media (max-width: 767.98px) {
  .pl-option {
    min-height: var(--tap-target);
    align-items: center;
  }
}
</style>
