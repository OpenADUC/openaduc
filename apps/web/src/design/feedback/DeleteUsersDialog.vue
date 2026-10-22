<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Delete one or more disabled user accounts. Preflight, typed confirmation
  and the delete loop live in useUserDeletion; this renders them and ends
  on a summary.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { BLOCK_TEXT, useUserDeletion, userLabel as label } from '../composables/useUserDeletion.js';

const props = defineProps<{
  visible: boolean;
  ids: string[];
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  // Fired once deletes have run, with the ids that are gone, so the parent
  // can refresh its list or navigate away.
  done: [deletedIds: string[]];
}>();

const {
  phase,
  loadError,
  preflight,
  typed,
  progress,
  deletedIds,
  failures,
  eligible,
  blocked,
  confirmWord,
  confirmed,
  withChildren,
  childObjectTotal,
  childCountUnknown,
  includeChildren,
  load,
  run,
} = useUserDeletion();

watch(
  () => props.visible,
  (open) => {
    if (open) void load(props.ids);
  },
  { immediate: true },
);

async function runDeletes(): Promise<void> {
  if (!confirmed.value) return;
  emit('done', await run());
}

function close(): void {
  if (phase.value === 'running') return;
  emit('update:visible', false);
}

/** "CN=Jane Doe,OU=Leavers,DC=corp" → "Leavers" — enough to tell OUs apart. */
function ouOf(dn: string | null): string {
  if (!dn) return '';
  const ou = dn.match(/,OU=((?:\\.|[^,])+)/i);
  return ou ? ou[1]!.replace(/\\(.)/g, '$1') : '';
}

const title = computed(() => {
  if (phase.value === 'finished') return 'Delete finished';
  const n = eligible.value.length;
  return n === 1 ? 'Delete account?' : n > 1 ? `Delete ${n} accounts?` : 'Delete accounts';
});

const deleteLabel = computed(() => {
  const n = eligible.value.length;
  return n === 1 ? 'Delete account' : `Delete ${n} accounts`;
});
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :header="title"
    :style="{ width: '34rem' }"
    :closable="phase !== 'running'"
    @update:visible="(v) => !v && close()"
  >
    <div v-if="phase === 'loading'" class="du-muted">Checking the selected accounts…</div>

    <Message v-else-if="phase === 'error'" severity="error" :closable="false">
      {{ loadError }}
    </Message>

    <template v-else-if="preflight">
      <template v-if="phase === 'review'">
        <Message v-if="eligible.length === 0" severity="info" :closable="false">
          None of the selected accounts can be deleted.
        </Message>
        <template v-else>
          <Message
            v-if="preflight.recycleBin?.recycleBinEnabled"
            severity="info"
            :closable="false"
            class="du-banner"
          >
            The AD Recycle Bin is on. You can restore deleted accounts from Deleted users with their
            attributes and group memberships.
          </Message>
          <Message
            v-else-if="preflight.recycleBin"
            severity="warn"
            :closable="false"
            class="du-banner"
          >
            The AD Recycle Bin is off, so OpenADUC can’t restore these accounts. AD keeps only a
            tombstone without group memberships or most attributes. The audit log keeps a copy of
            each account’s attributes and groups.
          </Message>
          <Message v-else severity="warn" :closable="false" class="du-banner">
            Couldn't check whether the AD Recycle Bin is on. Assume these accounts can't be fully
            restored.
          </Message>

          <ul class="du-list">
            <li v-for="u in eligible" :key="u.id">
              <span class="du-name">{{ label(u) }}</span>
              <span class="du-sam mono">{{ u.samAccountName }}</span>
              <span
                v-if="u.privileged"
                class="du-tag"
                title="adminCount=1: this account is or was in a protected admin group"
              >
                Privileged
              </span>
              <span
                v-if="u.childObjects !== 0"
                class="du-tag"
                title="Objects stored inside this account, such as Exchange ActiveSync devices"
              >
                {{
                  u.childObjects === null
                    ? 'May contain objects'
                    : `Contains ${u.childObjects} ${u.childObjects === 1 ? 'object' : 'objects'}`
                }}
              </span>
              <span class="du-ou">{{ ouOf(u.distinguishedName) }}</span>
            </li>
          </ul>
        </template>

        <template v-if="blocked.length > 0">
          <p class="du-subhead">
            {{ blocked.length === 1 ? 'Skipped 1 account' : `Skipped ${blocked.length} accounts` }}
          </p>
          <ul class="du-list du-list-skipped">
            <li v-for="u in blocked" :key="u.id">
              <span class="du-name">{{ label(u) }}</span>
              <span class="du-reason">{{ BLOCK_TEXT[u.blockedReason!] }}</span>
            </li>
          </ul>
        </template>

        <label v-if="withChildren.length > 0" class="du-children">
          <input v-model="includeChildren" type="checkbox" />
          <span v-if="childCountUnknown">
            Also delete any objects inside
            {{ withChildren.length === 1 ? 'this account' : 'these accounts' }} (e.g. Exchange
            ActiveSync devices). OpenADUC couldn't count them, and they can't be deleted separately
            from here.
          </span>
          <span v-else>
            Also delete the {{ childObjectTotal }}
            {{ childObjectTotal === 1 ? 'object' : 'objects' }} inside
            {{ withChildren.length === 1 ? 'this account' : 'these accounts' }} (e.g. Exchange
            ActiveSync devices). They can't be deleted separately from here.
          </span>
        </label>

        <div v-if="eligible.length > 0" class="du-confirm">
          <label for="du-confirm-input">
            Type <strong class="mono">{{ confirmWord }}</strong> to confirm
          </label>
          <InputText
            id="du-confirm-input"
            v-model="typed"
            autocomplete="off"
            spellcheck="false"
            fluid
            @keyup.enter="runDeletes"
          />
        </div>
      </template>

      <div v-else-if="phase === 'running'" class="du-muted">
        Deleting {{ Math.min(progress + 1, eligible.length) }} of {{ eligible.length }}…
      </div>

      <template v-else-if="phase === 'finished'">
        <p class="du-summary">
          {{
            deletedIds.length === 1
              ? 'Deleted 1 account.'
              : `Deleted ${deletedIds.length} accounts.`
          }}
          <template v-if="failures.length > 0">
            {{ failures.length === 1 ? '1 failed:' : `${failures.length} failed:` }}
          </template>
        </p>
        <ul v-if="failures.length > 0" class="du-list du-list-skipped">
          <li v-for="f in failures" :key="f.user.id">
            <span class="du-name">{{ label(f.user) }}</span>
            <span class="du-reason">{{ f.message }}</span>
          </li>
        </ul>
      </template>
    </template>

    <template #footer>
      <template v-if="phase === 'review' && eligible.length > 0">
        <Button label="Cancel" text severity="secondary" @click="close" />
        <Button
          :label="deleteLabel"
          icon="pi pi-trash"
          severity="danger"
          :disabled="!confirmed"
          @click="runDeletes"
        />
      </template>
      <Button
        v-else-if="phase === 'running'"
        label="Deleting…"
        severity="danger"
        loading
        disabled
      />
      <Button v-else label="Close" severity="secondary" @click="close" />
    </template>
  </Dialog>
</template>

<style scoped>
.du-muted {
  font-size: 13px;
  color: var(--text-3);
}

.du-banner {
  margin: 0 0 12px;
}

.du-subhead {
  margin: 14px 0 6px;
  font-size: 12px;
  color: var(--text-3);
}

.du-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 14rem;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.du-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  font-size: 13px;
  border-bottom: 1px solid var(--border-soft);
}

.du-list li:last-child {
  border-bottom: 0;
}

.du-name {
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.du-sam {
  font-size: 12px;
  color: var(--text-2);
}

.du-ou,
.du-reason {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
  text-align: right;
}

.du-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--amber-soft);
  color: var(--amber);
}

.du-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 16px;
  font-size: 13px;
  color: var(--text-2);
}

.du-summary {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text);
}

.mono {
  font-family: var(--font-mono);
}
.du-children {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 12px 0 0;
  font-size: 13px;
}
.du-children input {
  margin-top: 3px;
}
</style>
