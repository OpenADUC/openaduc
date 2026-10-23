<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Delete a group. The preflight, typed confirmation and delete live in
  useGroupDeletion; this renders them.
-->
<script setup lang="ts">
import { watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import { useGroupDeletion } from '../composables/useGroupDeletion.js';

const props = defineProps<{ visible: boolean; id: string }>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  deleted: [];
}>();

const {
  phase,
  loadError,
  preflight,
  typed,
  blockedText,
  confirmWord,
  confirmed,
  deleting,
  error,
  load,
  remove,
} = useGroupDeletion({ onDeleted: () => emit('deleted') });

watch(
  () => props.visible,
  (open) => {
    if (open) void load(props.id);
  },
  { immediate: true },
);

function close(): void {
  if (!deleting.value) emit('update:visible', false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    header="Delete group?"
    :style="{ width: '32rem' }"
    :closable="!deleting"
    @update:visible="(v) => !v && close()"
  >
    <div v-if="phase === 'loading'" class="dg-muted">Checking the group…</div>

    <Message v-else-if="phase === 'error'" severity="error" :closable="false">
      {{ loadError }}
    </Message>

    <template v-else-if="preflight">
      <Message v-if="blockedText" severity="warn" :closable="false">
        {{ preflight.name ?? preflight.samAccountName }} can’t be deleted. {{ blockedText }}
      </Message>
      <template v-else>
        <p class="dg-prose">
          Delete <strong>{{ preflight.name ?? preflight.samAccountName }}</strong
          >? Its members lose whatever access it grants, and OpenADUC can’t undo this.
        </p>
        <dl class="dg-facts">
          <dt>Members</dt>
          <dd>
            {{ preflight.memberCount === 1 ? '1 member' : `${preflight.memberCount} members` }}
          </dd>
          <dt>Member of</dt>
          <dd v-if="preflight.memberOf.length === 0">No groups</dd>
          <dd v-else>
            <ul class="dg-parents">
              <li v-for="p in preflight.memberOf" :key="p.distinguishedName">
                <router-link
                  v-if="p.id"
                  :to="{ name: 'group-detail', params: { id: p.id } }"
                  target="_blank"
                  >{{ p.name ?? p.distinguishedName }}</router-link
                >
                <span v-else :title="p.distinguishedName">{{ p.name ?? p.distinguishedName }}</span>
              </li>
            </ul>
          </dd>
        </dl>
        <p class="dg-muted">The audit log keeps a copy of its members and parent groups.</p>

        <div class="dg-confirm">
          <label for="dg-confirm-input">
            Type <strong class="mono">{{ confirmWord }}</strong> to confirm
          </label>
          <InputText
            id="dg-confirm-input"
            v-model="typed"
            autocomplete="off"
            spellcheck="false"
            fluid
            :disabled="deleting"
            @keyup.enter="remove"
          />
        </div>
        <Message v-if="error" severity="error" :closable="false" class="dg-msg">
          {{ error }}
        </Message>
      </template>
    </template>

    <template #footer>
      <template v-if="phase === 'review' && !blockedText">
        <Button label="Cancel" text severity="secondary" :disabled="deleting" @click="close" />
        <Button
          label="Delete group"
          icon="pi pi-trash"
          severity="danger"
          :loading="deleting"
          :disabled="!confirmed"
          @click="remove"
        />
      </template>
      <Button v-else label="Close" severity="secondary" @click="close" />
    </template>
  </Dialog>
</template>

<style scoped>
.dg-muted {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}

.dg-prose {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text);
}

.dg-facts {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0 0 10px;
  font-size: 13px;
}

.dg-facts dt {
  color: var(--text-3);
}

.dg-facts dd {
  margin: 0;
  min-width: 0;
}

.dg-parents {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 8rem;
  overflow-y: auto;
}

.dg-confirm {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  font-size: 13px;
  color: var(--text-2);
}

.dg-msg {
  margin: 10px 0 0;
}

.mono {
  font-family: var(--font-mono);
}
</style>
