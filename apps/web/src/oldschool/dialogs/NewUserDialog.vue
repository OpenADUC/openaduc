<!-- SPDX-License-Identifier: BUSL-1.1
     "New Object - User", rendering the shared create workflow
     (useUserCreation): names suggested and checked as they're typed,
     ADUC's password checkboxes, and an unfinished create kept with a
     retry of what's left. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useToast } from 'primevue/usetoast';
import { PASSWORD_MODES } from '@openaduc/shared';
import WinDialog from './WinDialog.vue';
import WinIcon from '../primitives/WinIcon.vue';
import { useOldSchool } from '../stores/useOldSchool.js';
import { dnPath, rdns } from '../../design/lib/dn.js';
import { announceUserCreated } from '../../design/feedback/userToasts.js';
import { useUserCreation } from '../../design/composables/useUserCreation.js';
import { PASSWORD_MODE_LABEL } from '../../design/lib/newUser.js';

const props = defineProps<{ windowId: number; parentDn: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useOldSchool();
const toast = useToast();
const creation = useUserCreation({
  onCreated: (created) => {
    announceUserCreated(toast, created);
    store.bumpData();
    emit('close');
  },
});
const { form, names, upnSuffixes, deviations, plan, unfinished, unfinishedSummary, submitting } =
  creation;
void creation.start({ ouDn: props.parentDn });

const createIn = computed(() => dnPath(rdns(props.parentDn)));
const locked = computed(() => submitting.value || !!unfinished.value);
const toApprove = computed(() => deviations.value.filter((d) => d.needsApproval));

// One line, as ADUC shows it: the first thing stopping OK.
const problem = computed(
  () =>
    plan.value.blockers[0]?.message ??
    creation.error.value ??
    (unfinishedSummary.value
      ? `${unfinishedSummary.value.title} ${unfinishedSummary.value.failed} ${unfinishedSummary.value.left}`
      : null),
);

const unmetChecks = computed(() =>
  plan.value.passwordChecks.filter((c) => !c.met).map((c) => c.text),
);

function ok(): void {
  if (unfinished.value) creation.finish();
  else creation.submit();
}
</script>

<template>
  <WinDialog
    :window-id="windowId"
    title="New Object - User"
    icon="newuser"
    hide-apply
    :resizable="false"
    :ok-label="unfinished ? 'Retry' : 'OK'"
    :can-ok="unfinished ? creation.canFinish.value : creation.canSubmit.value"
    @ok="ok"
    @cancel="emit('close')"
    @close="emit('close')"
  >
    <div class="os-tab-body">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 10px">
        <WinIcon name="user" :size="32" />
        <span>Create in: {{ createIn }}</span>
      </div>
      <hr style="border: 0; border-top: 1px solid var(--os-window-border-soft); margin: 0 0 10px" />
      <div class="nu-grid">
        <label for="os-nu-first">First name:</label>
        <input id="os-nu-first" v-model="form.first" class="os-input" :disabled="locked" />
        <label for="os-nu-last">Last name:</label>
        <input id="os-nu-last" v-model="form.last" class="os-input" :disabled="locked" />
        <label for="os-nu-display">Full name:</label>
        <input
          id="os-nu-display"
          class="os-input"
          :value="names.displayName"
          :disabled="locked"
          @input="creation.setDisplayName(($event.target as HTMLInputElement).value)"
        />
        <label for="os-nu-upn">User logon name:</label>
        <span style="display: flex; gap: 4px">
          <input
            id="os-nu-upn"
            class="os-input"
            style="flex: 1; width: auto; min-width: 0"
            :value="names.upnLocal"
            spellcheck="false"
            :disabled="locked"
            @input="creation.setUpnLocal(($event.target as HTMLInputElement).value)"
          />
          <select
            class="os-input"
            style="flex: none; width: auto"
            aria-label="UPN suffix"
            :value="names.upnSuffix"
            :disabled="locked"
            @change="creation.setUpnSuffix(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="s in upnSuffixes" :key="s" :value="s">@{{ s }}</option>
          </select>
        </span>
        <label for="os-nu-sam">Pre-Windows 2000:</label>
        <input
          id="os-nu-sam"
          class="os-input"
          :value="names.samAccountName"
          spellcheck="false"
          :disabled="locked"
          @input="creation.setSamAccountName(($event.target as HTMLInputElement).value)"
        />
      </div>
      <label v-for="{ deviation } in toApprove" :key="deviation.reason" class="os-check">
        <input
          type="checkbox"
          :checked="creation.isApproved(deviation)"
          :disabled="locked"
          @change="creation.approve(deviation, ($event.target as HTMLInputElement).checked)"
        />
        {{ deviation.reason }}
      </label>
      <fieldset class="os-groupbox" style="margin-top: 8px">
        <legend>Password</legend>
        <label v-for="m in PASSWORD_MODES" :key="m" class="os-check" style="display: flex">
          <input
            type="radio"
            :checked="form.passwordMode === m"
            :disabled="submitting"
            @change="creation.setPasswordMode(m)"
          />
          {{ PASSWORD_MODE_LABEL[m] }}
        </label>
        <div v-if="form.passwordMode !== 'random'" style="display: flex; gap: 4px; margin: 4px 0">
          <input
            v-model="form.password"
            class="os-input"
            style="flex: 1"
            aria-label="Password"
            autocomplete="new-password"
            :type="form.passwordMode === 'generate' ? 'text' : 'password'"
            :readonly="form.passwordMode === 'generate'"
            :disabled="submitting"
          />
          <button
            v-if="form.passwordMode === 'generate'"
            type="button"
            class="os-btn"
            @click="creation.copy"
          >
            Copy
          </button>
        </div>
        <label class="os-check" style="display: flex">
          <input
            type="checkbox"
            :checked="plan.mustChange"
            :disabled="locked || form.passwordMode === 'random'"
            @change="form.mustChange = ($event.target as HTMLInputElement).checked"
          />
          User must change password at next logon
        </label>
        <label class="os-check" style="display: flex">
          <input
            type="checkbox"
            :checked="!form.enabled"
            :disabled="submitting"
            @change="form.enabled = !($event.target as HTMLInputElement).checked"
          />
          Account is disabled
        </label>
      </fieldset>
      <div v-if="problem" class="os-error" style="margin-top: 8px">{{ problem }}</div>
      <template v-else>
        <div v-for="text in unmetChecks" :key="text" style="margin-top: 4px">{{ text }}</div>
      </template>
    </div>
  </WinDialog>
</template>

<style scoped>
.nu-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 8px;
  align-items: center;
  margin-bottom: 6px;
}
</style>
