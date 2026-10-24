<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  A bulk attribute edit's preview: how many users each field changes, then
  user by user each field's before and after, a page at a time, and who it
  skips, can't tell yet or leaves as they are. Shown by the bulk edit and
  by reassigning a manager's direct reports.
-->
<script setup lang="ts">
import Button from 'primevue/button';
import Message from 'primevue/message';
import type { BulkUserAttributesPreview } from '@openaduc/shared';
import { ATTRIBUTE_LABELS, shownValue } from '../lib/bulkAttributes.js';

withDefaults(
  defineProps<{
    preview: BulkUserAttributesPreview;
    /** Selected users the list's filters hide. */
    hiddenCount?: number;
    hasMore: boolean;
    loadingMore: boolean;
  }>(),
  { hiddenCount: 0 },
);
const emit = defineEmits<{ showMore: [] }>();
</script>

<template>
  <p v-if="hiddenCount > 0" class="be-note">
    {{
      hiddenCount === 1
        ? '1 of them is hidden by the current filters.'
        : `${hiddenCount} of them are hidden by the current filters.`
    }}
  </p>
  <p v-if="preview.unknownCount > 0" class="be-note">
    {{
      preview.unknownCount === 1
        ? '1 selected account isn’t in the directory any more; it will fail.'
        : `${preview.unknownCount} selected accounts aren’t in the directory any more; they will fail.`
    }}
  </p>
  <ul class="be-counts" aria-label="Changes by field">
    <li v-for="f in preview.fields" :key="f.field">
      <strong>{{ ATTRIBUTE_LABELS[f.field] }}</strong
      >: {{ f.count === 1 ? '1 user changes' : `${f.count} users change` }}
      <template v-if="f.unread > 0">
        · not known yet for {{ f.unread === 1 ? '1 user' : `${f.unread} users` }}
      </template>
    </li>
  </ul>
  <p v-if="preview.fields.some((f) => f.unread > 0)" class="be-note">
    The cache hasn’t read every user’s value yet. The job reads each user first and changes only
    what differs.
  </p>
  <Message
    v-if="preview.changed.count === 0 && preview.unread.count === 0"
    severity="info"
    :closable="false"
  >
    They’re all as asked already. There’s nothing to change.
  </Message>
  <ul v-else class="be-users" aria-label="Changes by user">
    <li v-for="u in preview.changed.users" :key="u.id" class="be-user">
      <span class="be-user-name">{{ u.name }}</span>
      <ul class="be-user-changes">
        <li v-for="c in u.changes" :key="c.field">
          <span class="be-change-field">{{ ATTRIBUTE_LABELS[c.field] }}</span>
          <span class="be-before">{{ shownValue(c.before) }}</span>
          <i class="pi pi-arrow-right be-arrow" aria-label="becomes" />
          <span class="be-after">{{ shownValue(c.after) }}</span>
        </li>
      </ul>
    </li>
  </ul>
  <div v-if="hasMore" class="be-more">
    <span class="be-note">
      {{ preview.changed.users.length }} of {{ preview.changed.count }} listed.
    </span>
    <Button
      label="Show more"
      size="small"
      severity="secondary"
      text
      :loading="loadingMore"
      @click="emit('showMore')"
    />
  </div>
  <details v-if="preview.skipped.count > 0" class="be-unchanged" open>
    <summary>Skipped ({{ preview.skipped.count }})</summary>
    <ul>
      <li v-for="u in preview.skipped.users" :key="u.id">{{ u.name }}: {{ u.reason }}</li>
    </ul>
  </details>
  <details v-if="preview.unread.count > 0" class="be-unchanged">
    <summary>Not known yet ({{ preview.unread.count }})</summary>
    <ul>
      <li v-for="u in preview.unread.users" :key="u.id">{{ u.name }}</li>
    </ul>
  </details>
  <details v-if="preview.unchanged.count > 0" class="be-unchanged">
    <summary>Already as asked, unchanged ({{ preview.unchanged.count }})</summary>
    <ul>
      <li v-for="u in preview.unchanged.users" :key="u.id">{{ u.name }}</li>
    </ul>
    <p v-if="preview.unchanged.count > preview.unchanged.users.length" class="be-note">
      The first {{ preview.unchanged.users.length }} are listed;
      {{ preview.unchanged.count - preview.unchanged.users.length }} more aren’t.
    </p>
  </details>
</template>

<style scoped>
.be-note {
  margin: 4px 0 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.be-more {
  display: flex;
  align-items: center;
  gap: 8px;
}

.be-counts {
  margin: 0 0 10px;
  padding-left: 18px;
  font-size: 13px;
}

.be-users {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 22rem;
  overflow-y: auto;
}

.be-user {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.be-user:last-child {
  border-bottom: 0;
}

.be-user-name {
  font-size: 13px;
  font-weight: 600;
}

.be-user-changes {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: 12.5px;
}

.be-user-changes li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}

.be-change-field {
  min-width: 7rem;
  color: var(--text-2);
}

.be-before {
  color: var(--text-3);
  text-decoration: line-through;
  white-space: pre-line;
}

.be-arrow {
  font-size: 10px;
  color: var(--text-3);
}

.be-after {
  white-space: pre-line;
}

.be-unchanged {
  margin-top: 10px;
  font-size: 12.5px;
}

.be-unchanged summary {
  cursor: pointer;
  color: var(--text-2);
}

.be-unchanged ul {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 10rem;
  overflow-y: auto;
}
</style>
