<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Step 3: the names the naming pattern gives each row, against the
  directory and each other. Truncations are approved together, collision
  suffixes and dropped characters one at a time; normalizations are only
  shown. Rows that are someone already in the directory are skipped.
-->
<script setup lang="ts">
import { computed } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import type { LimitedAttribute } from '@openaduc/shared';
import type { useUserImport } from '../../design/composables/useUserImport.js';
import type { TypedNames } from '../../design/lib/importDraft.js';

const props = defineProps<{ wizard: ReturnType<typeof useUserImport> }>();
const w = props.wizard;
const {
  pending,
  reviewError,
  toCreate,
  truncations,
  unapprovedTruncations,
  individual,
  normalizations,
  cnCollisions,
  blockedRows,
  warnedRows,
  skipped,
  excludedRows,
} = w;

/** The name field a truncated attribute is typed in. */
const FIELD_OF: Record<LimitedAttribute, keyof TypedNames> = {
  samAccountName: 'samAccountName',
  userPrincipalName: 'upnLocal',
  displayName: 'displayName',
  cn: 'displayName',
};
const FIELD_LABEL: Record<keyof TypedNames, string> = {
  samAccountName: 'sAMAccountName',
  upnLocal: 'UPN before the @',
  displayName: 'Display name',
};
const NAME_FIELDS = Object.keys(FIELD_LABEL) as (keyof TypedNames)[];

const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);
const summary = computed(() =>
  [
    `${people(toCreate.value.length)} to create`,
    skipped.value.length ? `${skipped.value.length} already in the directory` : null,
    excludedRows.value.length ? `${excludedRows.value.length} left out` : null,
  ]
    .filter(Boolean)
    .join(' · '),
);
const cnShown = computed(() =>
  cnCollisions.value.filter((c) => c.deviation.approval !== 'blocked'),
);

function typed(row: number, field: keyof TypedNames, e: Event): void {
  w.setName(row, field, (e.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="nm">
    <p class="nm-summary">
      {{ summary }}
      <span v-if="pending && !reviewError" class="hint">Checking names…</span>
    </p>
    <Message v-if="reviewError" severity="error" :closable="false" class="nm-msg">
      {{ reviewError }}
      <Button label="Try again" size="small" text @click="w.retryReview" />
    </Message>

    <section v-if="blockedRows.length" class="nm-section">
      <h3 class="nm-title nm-bad">Fix or leave out ({{ blockedRows.length }})</h3>
      <ul class="nm-list">
        <li v-for="b in blockedRows" :key="b.row" class="nm-item">
          <div class="nm-row-head">
            <span class="nm-line">Row {{ b.line }}</span>
            <span class="nm-name">{{ b.name }}</span>
            <Button
              label="Leave out"
              size="small"
              text
              severity="secondary"
              @click="w.exclude(b.row)"
            />
          </div>
          <p v-for="m in b.blockers" :key="m" class="nm-note nm-bad">{{ m }}</p>
          <div v-if="w.reviews.value.get(b.row)?.suggestion" class="nm-edit">
            <label v-for="f in NAME_FIELDS" :key="f" class="nm-edit-field">
              <span class="fld-label">{{ FIELD_LABEL[f] }}</span>
              <InputText
                :model-value="w.nameValue(b.row, f)"
                size="small"
                class="mono"
                spellcheck="false"
                @change="(e: Event) => typed(b.row, f, e)"
              />
            </label>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="truncations.length" class="nm-section">
      <div class="nm-section-head">
        <h3 class="nm-title">Cut to fit ({{ truncations.length }})</h3>
        <Button
          :label="unapprovedTruncations ? `Approve all (${unapprovedTruncations})` : 'All approved'"
          icon="pi pi-check"
          size="small"
          :disabled="unapprovedTruncations === 0"
          @click="w.approveAllTruncations"
        />
      </div>
      <p class="nm-note">Names over AD’s limits are cut. Approve them, or type another value.</p>
      <ul class="nm-list">
        <li
          v-for="t in truncations"
          :key="`${t.row}:${t.deviation.reason}`"
          class="nm-item nm-inline"
        >
          <label class="nm-check">
            <input
              type="checkbox"
              :checked="w.isApproved(t.row, t.deviation)"
              @change="w.approve(t.row, t.deviation, ($event.target as HTMLInputElement).checked)"
            />
            <span class="nm-line">Row {{ t.line }}</span>
            <span>{{ t.deviation.reason }}</span>
          </label>
          <InputText
            v-if="t.deviation.kind === 'truncated'"
            :model-value="w.nameValue(t.row, FIELD_OF[t.deviation.attribute])"
            :aria-label="`${FIELD_LABEL[FIELD_OF[t.deviation.attribute]]} for row ${t.line}`"
            size="small"
            class="mono nm-value"
            spellcheck="false"
            @change="
              (e: Event) =>
                t.deviation.kind === 'truncated' && typed(t.row, FIELD_OF[t.deviation.attribute], e)
            "
          />
          <Button
            label="Leave out"
            size="small"
            text
            severity="secondary"
            :aria-label="`Leave row ${t.line} out`"
            @click="w.exclude(t.row)"
          />
        </li>
      </ul>
    </section>

    <section v-if="individual.length" class="nm-section">
      <h3 class="nm-title">Approve one at a time ({{ individual.length }})</h3>
      <p class="nm-note">
        A number added to a name already taken, or characters a username can’t hold.
      </p>
      <ul class="nm-list">
        <li
          v-for="d in individual"
          :key="`${d.row}:${d.deviation.reason}`"
          class="nm-item nm-inline"
        >
          <label class="nm-check">
            <input
              type="checkbox"
              :checked="w.isApproved(d.row, d.deviation)"
              @change="w.approve(d.row, d.deviation, ($event.target as HTMLInputElement).checked)"
            />
            <span class="nm-line">Row {{ d.line }}</span>
            <span>{{ d.deviation.reason }} <strong>Use it</strong></span>
          </label>
          <Button
            label="Leave out"
            size="small"
            text
            severity="secondary"
            :aria-label="`Leave row ${d.line} out`"
            @click="w.exclude(d.row)"
          />
        </li>
      </ul>
    </section>

    <section v-if="cnShown.length" class="nm-section">
      <h3 class="nm-title">Named differently in the OU ({{ cnShown.length }})</h3>
      <ul class="nm-list">
        <li v-for="c in cnShown" :key="`${c.row}:${c.deviation.reason}`" class="nm-item nm-note">
          <span class="nm-line">Row {{ c.line }}</span> {{ c.deviation.reason }}
        </li>
      </ul>
    </section>

    <section v-if="warnedRows.length" class="nm-section">
      <h3 class="nm-title nm-warn">Worth a look ({{ warnedRows.length }})</h3>
      <ul class="nm-list">
        <li v-for="r in warnedRows" :key="r.row" class="nm-item">
          <div class="nm-row-head">
            <span class="nm-line">Row {{ r.line }}</span>
            <span class="nm-name">{{ r.name }}</span>
            <Button
              label="Leave out"
              size="small"
              text
              severity="secondary"
              :aria-label="`Leave row ${r.line} out`"
              @click="w.exclude(r.row)"
            />
          </div>
          <p v-for="m in r.warnings" :key="m" class="nm-note nm-warn">{{ m }}</p>
        </li>
      </ul>
    </section>

    <details v-if="normalizations.length" class="nm-section">
      <summary class="nm-title">Simplified for usernames ({{ normalizations.length }})</summary>
      <ul class="nm-list">
        <li
          v-for="n in normalizations"
          :key="`${n.row}:${n.deviation.reason}`"
          class="nm-item nm-note"
        >
          <span class="nm-line">Row {{ n.line }}</span> {{ n.deviation.reason }}
        </li>
      </ul>
    </details>

    <section v-if="skipped.length" class="nm-section">
      <h3 class="nm-title">Already in the directory, skipped ({{ skipped.length }})</h3>
      <p class="nm-note">An import only creates people; these rows are left as they are.</p>
      <ul class="nm-list">
        <li v-for="s in skipped" :key="s.row" class="nm-item nm-note">
          <span class="nm-line">Row {{ s.line }}</span>
          {{ s.name }} is
          <RouterLink :to="{ name: 'user-detail', params: { id: s.existing.person.id } }">
            {{ s.existing.person.displayName ?? s.existing.person.samAccountName }}
          </RouterLink>
          ({{ s.existing.by === 'employeeId' ? 'employee ID' : 'email' }} {{ s.existing.value }}).
        </li>
      </ul>
    </section>

    <section v-if="excludedRows.length" class="nm-section">
      <h3 class="nm-title">Left out ({{ excludedRows.length }})</h3>
      <ul class="nm-list">
        <li v-for="x in excludedRows" :key="x.row" class="nm-item nm-row-head">
          <span class="nm-line">Row {{ x.line }}</span>
          <span class="nm-name">{{ x.name }}</span>
          <Button label="Put back" size="small" text @click="w.include(x.row)" />
        </li>
      </ul>
    </section>

    <p v-if="!pending && !reviewError && w.namesReady.value" class="nm-ok">
      <i class="pi pi-check-circle" aria-hidden="true" /> Every name is ready.
    </p>
  </div>
</template>

<style scoped>
.nm-summary {
  display: flex;
  gap: 12px;
  align-items: baseline;
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text);
}

.nm-section {
  margin: 16px 0;
}

.nm-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.nm-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

summary.nm-title {
  cursor: pointer;
}

.nm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nm-item {
  font-size: 12.5px;
  color: var(--text-2);
}

.nm-inline {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.nm-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nm-line {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}

.nm-name {
  color: var(--text);
  font-weight: 500;
}

.nm-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.nm-check input {
  margin-top: 2px;
}

.nm-value {
  width: 14rem;
  flex-shrink: 0;
}

.nm-note {
  margin: 2px 0;
  font-size: 12px;
  color: var(--text-3);
}

.nm-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.nm-edit-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nm-bad {
  color: var(--red);
}

.nm-warn {
  color: var(--amber);
}

.nm-ok {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--green);
}

.nm-msg {
  margin: 8px 0;
}

.mono {
  font-family: var(--font-mono);
}

@media (max-width: 767.98px) {
  .nm-inline {
    flex-direction: column;
  }

  .nm-value {
    width: 100%;
  }
}
</style>
