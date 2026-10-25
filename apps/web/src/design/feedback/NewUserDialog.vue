<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Create a user in an OU. The form, the naming check, the plan and the
  create live in useUserCreation; this renders them. Opened from the user
  list, or from an OU with that OU preselected.
-->
<script setup lang="ts">
import { computed, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Message from 'primevue/message';
import Select from 'primevue/select';
import SelectButton from 'primevue/selectbutton';
import TreeSelect from 'primevue/treeselect';
import { PASSWORD_MODES, type NewUserField, type UserCreateResponse } from '@openaduc/shared';
import { useUserCreation } from '../composables/useUserCreation.js';
import { useOuTree } from '../composables/useOuTree.js';
import { ouTreeNodes } from '../lib/ouTree.js';
import { PASSWORD_MODE_LABEL } from '../lib/newUser.js';

const props = defineProps<{
  visible: boolean;
  /** The OU to create the user in, when the operator started from one. */
  ouDn?: string | null;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
  created: [created: UserCreateResponse];
}>();

const creation = useUserCreation({ onCreated: (created) => emit('created', created) });
const {
  form,
  loading,
  loadError,
  upnSuffixes,
  names,
  usesMiddleInitial,
  checking,
  checkError,
  deviations,
  plan,
  shown,
  copied,
  submitting,
  error,
  unfinished,
  unfinishedSummary,
  passwordLeft,
  canSubmit,
  canFinish,
  namesTyped,
} = creation;

const { ous, loading: ousLoading, error: ousError, load: loadOus } = useOuTree();
const ouTree = computed(() => ouTreeNodes(ous.value));

watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    void creation.start({ ouDn: props.ouDn ?? null });
    void loadOus();
  },
  { immediate: true },
);

// PrimeVue TreeSelect keys its single selection by node key, which is the DN.
const ouSelection = computed<Record<string, boolean>>({
  get: () => (form.ouDn ? { [form.ouDn]: true } : {}),
  set: (keys) => (form.ouDn = Object.keys(keys).find((k) => keys[k]) ?? null),
});

const modeOptions = PASSWORD_MODES.map((value) => ({ value, label: PASSWORD_MODE_LABEL[value] }));
const passwordMode = computed({
  get: () => form.passwordMode,
  set: (mode) => creation.setPasswordMode(mode),
});

/** The blockers and warnings beside one field. */
const issuesOf = (field: NewUserField) => ({
  blockers: plan.value.blockers.filter((b) => b.field === field).map((b) => b.message),
  warnings: plan.value.warnings.filter((w) => w.field === field).map((w) => w.message),
});
const nameNotes = computed(() =>
  deviations.value.filter(({ deviation }) => deviation.approval !== 'blocked'),
);
// Blockers shown beside their field are the rest's.
const SHOWN_BESIDE: NewUserField[] = [
  'first',
  'last',
  'displayName',
  'samAccountName',
  'userPrincipalName',
  'personalEmail',
];
const otherBlockers = computed(() =>
  plan.value.blockers.filter((b) => !b.field || !SHOWN_BESIDE.includes(b.field)),
);
const locked = computed(() => submitting.value || !!unfinished.value);
const cnDiffers = computed(() => !!names.value.cn && names.value.cn !== names.value.displayName);

function close(): void {
  if (!submitting.value) emit('update:visible', false);
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    class="ds-sheet"
    header="New user"
    :style="{ width: '40rem' }"
    :closable="!submitting"
    @update:visible="(v) => !v && close()"
  >
    <Message v-if="loadError" severity="error" :closable="false" class="nu-msg">
      {{ loadError }}
    </Message>

    <div class="nu-field">
      <label class="fld-label" for="nu-ou">Create in</label>
      <Message v-if="ousError" severity="error" :closable="false">{{ ousError }}</Message>
      <TreeSelect
        v-else
        v-model="ouSelection"
        input-id="nu-ou"
        :options="ouTree"
        :loading="ousLoading"
        selection-mode="single"
        placeholder="Pick an OU"
        fluid
        :disabled="locked"
      />
    </div>

    <div class="nu-row">
      <div class="nu-field">
        <label class="fld-label" for="nu-first">First name</label>
        <InputText
          id="nu-first"
          v-model="form.first"
          maxlength="64"
          autofocus
          fluid
          :disabled="locked"
        />
        <span v-for="m in issuesOf('first').blockers" :key="m" class="nu-note nu-bad">{{ m }}</span>
      </div>
      <div class="nu-field">
        <label class="fld-label" for="nu-last">Last name</label>
        <InputText id="nu-last" v-model="form.last" maxlength="64" fluid :disabled="locked" />
        <span v-for="m in issuesOf('last').blockers" :key="m" class="nu-note nu-bad">{{ m }}</span>
      </div>
    </div>
    <div class="nu-row">
      <div class="nu-field">
        <label class="fld-label" for="nu-preferred">Preferred first name (optional)</label>
        <InputText
          id="nu-preferred"
          v-model="form.preferredFirst"
          maxlength="64"
          fluid
          :disabled="locked"
        />
        <span class="nu-note">Changes only the display name.</span>
      </div>
      <div v-if="usesMiddleInitial" class="nu-field">
        <label class="fld-label" for="nu-mi">Middle initial (optional)</label>
        <InputText
          id="nu-mi"
          v-model="form.middleInitial"
          maxlength="64"
          fluid
          :disabled="locked"
        />
      </div>
    </div>
    <div class="nu-field">
      <label class="fld-label" for="nu-display">Display name</label>
      <InputText
        id="nu-display"
        :model-value="names.displayName"
        maxlength="256"
        fluid
        :disabled="locked"
        @update:model-value="creation.setDisplayName"
      />
      <span v-for="m in issuesOf('displayName').blockers" :key="m" class="nu-note nu-bad">{{
        m
      }}</span>
      <span v-if="cnDiffers" class="nu-note">Named “{{ names.cn }}” in the OU.</span>
    </div>

    <h4 class="nu-section">Sign-in names</h4>
    <div class="nu-field">
      <label class="fld-label" for="nu-upn">User logon name (UPN)</label>
      <div class="nu-upn">
        <InputText
          id="nu-upn"
          class="mono"
          :model-value="names.upnLocal"
          maxlength="64"
          spellcheck="false"
          fluid
          :invalid="issuesOf('userPrincipalName').blockers.length > 0"
          :disabled="locked"
          @update:model-value="creation.setUpnLocal"
        />
        <span class="nu-at">@</span>
        <Select
          :model-value="names.upnSuffix"
          :options="upnSuffixes"
          aria-label="UPN suffix"
          :disabled="locked || loading"
          @update:model-value="creation.setUpnSuffix"
        />
      </div>
      <span v-for="m in issuesOf('userPrincipalName').blockers" :key="m" class="nu-note nu-bad">{{
        m
      }}</span>
    </div>
    <div class="nu-field">
      <label class="fld-label" for="nu-sam">Logon name (pre-Windows 2000)</label>
      <InputText
        id="nu-sam"
        class="mono"
        :model-value="names.samAccountName"
        maxlength="64"
        spellcheck="false"
        fluid
        :invalid="issuesOf('samAccountName').blockers.length > 0"
        :disabled="locked"
        @update:model-value="creation.setSamAccountName"
      />
      <span v-for="m in issuesOf('samAccountName').blockers" :key="m" class="nu-note nu-bad">{{
        m
      }}</span>
    </div>
    <ul
      v-if="nameNotes.length"
      class="nu-deviations"
      aria-label="How the names differ from the pattern"
    >
      <li v-for="{ deviation, needsApproval } in nameNotes" :key="deviation.reason">
        <label v-if="needsApproval" class="nu-check nu-warn">
          <input
            type="checkbox"
            :checked="creation.isApproved(deviation)"
            :disabled="locked"
            @change="creation.approve(deviation, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ deviation.reason }} <strong>Use it</strong></span>
        </label>
        <span v-else class="nu-note">{{ deviation.reason }}</span>
      </li>
    </ul>
    <p v-for="b in otherBlockers" :key="b.message" class="nu-note nu-bad">{{ b.message }}</p>
    <Button
      v-if="namesTyped && !unfinished"
      label="Use the suggested names"
      size="small"
      text
      class="nu-reset"
      :disabled="locked"
      @click="creation.useSuggestedNames"
    />
    <p v-if="checkError" class="nu-note">
      Couldn’t check the names against the directory ({{ checkError }}). They’re checked again when
      you create the user.
    </p>

    <h4 class="nu-section">Contact</h4>
    <label class="nu-check">
      <input v-model="form.mailFromUpn" type="checkbox" :disabled="locked" />
      <span>
        Set email to the UPN<template v-if="names.upnLocal">
          (<span class="mono">{{ names.upnLocal }}@{{ names.upnSuffix }}</span
          >)</template
        >
      </span>
    </label>
    <div class="nu-field">
      <label class="fld-label" for="nu-personal">Personal email (optional)</label>
      <InputText
        id="nu-personal"
        v-model="form.personalEmail"
        type="email"
        maxlength="256"
        fluid
        :invalid="issuesOf('personalEmail').blockers.length > 0"
        :disabled="locked"
      />
      <span v-for="m in issuesOf('personalEmail').blockers" :key="m" class="nu-note nu-bad">{{
        m
      }}</span>
    </div>
    <div class="nu-row">
      <div class="nu-field">
        <label class="fld-label" for="nu-mobile">Mobile (optional)</label>
        <InputText
          id="nu-mobile"
          v-model="form.mobile"
          type="tel"
          maxlength="64"
          fluid
          :disabled="locked"
          @blur="creation.tidyPhones"
        />
        <span v-for="m in issuesOf('mobile').warnings" :key="m" class="nu-note nu-warn">{{
          m
        }}</span>
      </div>
      <div class="nu-field">
        <label class="fld-label" for="nu-phone">Telephone (optional)</label>
        <InputText
          id="nu-phone"
          v-model="form.telephoneNumber"
          type="tel"
          maxlength="64"
          fluid
          :disabled="locked"
          @blur="creation.tidyPhones"
        />
        <span v-for="m in issuesOf('telephoneNumber').warnings" :key="m" class="nu-note nu-warn">{{
          m
        }}</span>
      </div>
    </div>

    <h4 class="nu-section">Password</h4>
    <SelectButton
      v-model="passwordMode"
      :options="modeOptions"
      option-label="label"
      option-value="value"
      :allow-empty="false"
      aria-label="Password"
      :disabled="submitting || (!!unfinished && !passwordLeft)"
    />
    <p v-if="form.passwordMode === 'random'" class="nu-note nu-mode">
      A long random password nobody sees, for people who set their own in Entra ID (self-service
      password reset with writeback, or a Temporary Access Pass).
    </p>
    <template v-else>
      <div class="nu-password">
        <InputText
          v-model="form.password"
          :type="shown ? 'text' : 'password'"
          class="mono nu-password-value"
          aria-label="Password"
          autocomplete="new-password"
          spellcheck="false"
          fluid
          :readonly="form.passwordMode === 'generate'"
          :disabled="submitting || (!!unfinished && !passwordLeft)"
        />
        <Button
          :icon="shown ? 'pi pi-eye-slash' : 'pi pi-eye'"
          text
          severity="secondary"
          :aria-label="shown ? 'Hide password' : 'Show password'"
          @click="shown = !shown"
        />
        <Button
          :icon="copied ? 'pi pi-check' : 'pi pi-copy'"
          text
          severity="secondary"
          aria-label="Copy password"
          :disabled="!form.password"
          @click="creation.copy"
        />
        <Button
          v-if="form.passwordMode === 'generate'"
          icon="pi pi-refresh"
          text
          severity="secondary"
          aria-label="Generate another"
          :disabled="submitting"
          @click="creation.generate"
        />
      </div>
      <p v-if="form.passwordMode === 'generate'" class="nu-note">
        Copy it now: OpenADUC doesn’t keep it, and it isn’t shown again.
      </p>
      <span v-if="copied === false" class="nu-note">Couldn’t copy. Select it and copy it.</span>
      <ul class="nu-checks">
        <li v-for="c in plan.passwordChecks" :key="c.rule" :class="{ met: c.met }">
          <i :class="c.met ? 'pi pi-check' : 'pi pi-times'" aria-hidden="true" />
          {{ c.text }}
        </li>
      </ul>
    </template>
    <label class="nu-check">
      <input
        type="checkbox"
        :checked="plan.mustChange"
        :disabled="locked || form.passwordMode === 'random'"
        @change="form.mustChange = ($event.target as HTMLInputElement).checked"
      />
      <span>Must change password at next sign-in</span>
    </label>
    <p v-if="plan.mustChangeNote" class="nu-note nu-indent">{{ plan.mustChangeNote }}</p>
    <label class="nu-check">
      <input v-model="form.enabled" type="checkbox" :disabled="submitting" />
      <span>Enable the account</span>
    </label>

    <Message v-if="unfinishedSummary" severity="warn" :closable="false" class="nu-msg">
      <strong>{{ unfinishedSummary.title }}</strong>
      <span v-if="unfinishedSummary.failed"> {{ unfinishedSummary.failed }}.</span>
      {{ unfinishedSummary.left }}
      <span v-if="!unfinished?.id">
        It couldn’t be read back, so finish it from its page once the next sync lists it.</span
      >
    </Message>
    <Message v-if="error" severity="error" :closable="false" class="nu-msg">{{ error }}</Message>

    <template #footer>
      <span v-if="checking" class="nu-note nu-checking">Checking names…</span>
      <template v-if="unfinished">
        <Button
          label="Open the account"
          text
          severity="secondary"
          :disabled="submitting"
          @click="creation.openUnfinished"
        />
        <Button
          label="Retry the remaining steps"
          icon="pi pi-replay"
          :loading="submitting"
          :disabled="!canFinish"
          @click="creation.finish"
        />
      </template>
      <template v-else>
        <Button label="Cancel" text severity="secondary" :disabled="submitting" @click="close" />
        <Button
          label="Create user"
          icon="pi pi-user-plus"
          :loading="submitting"
          :disabled="!canSubmit"
          @click="creation.submit"
        />
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
.nu-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  min-width: 0;
}

.nu-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}

@media (max-width: 767.98px) {
  .nu-row {
    grid-template-columns: 1fr;
  }
}

.nu-section {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.nu-upn {
  display: flex;
  align-items: center;
  gap: 6px;
}

.nu-at {
  color: var(--text-3);
}

.nu-note {
  font-size: 11.5px;
  color: var(--text-3);
}

.nu-bad {
  color: var(--red);
}

.nu-warn {
  color: var(--amber);
}

.nu-deviations {
  list-style: none;
  margin: -4px 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nu-deviations .nu-check {
  font-size: 12px;
  margin: 0;
  align-items: flex-start;
}

.nu-reset {
  margin: -4px 0 8px -8px;
}

.nu-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--text-2);
}

.nu-indent {
  display: block;
  margin: -6px 0 10px 24px;
}

.nu-mode {
  display: block;
  margin: 6px 0 10px;
}

.nu-password {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
}

.nu-password-value {
  flex: 1;
}

.nu-checks {
  list-style: none;
  margin: 4px 0 8px;
  padding: 0;
  font-size: 12px;
  color: var(--text-3);
}

.nu-checks li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
}

.nu-checks li.met {
  color: var(--text-2);
}

.nu-checks li.met .pi {
  color: var(--green);
}

.nu-checks .pi {
  font-size: 11px;
}

.nu-msg {
  margin: 8px 0 0;
}

.nu-checking {
  margin-right: auto;
}

.mono {
  font-family: var(--font-mono);
}

@media (max-width: 767.98px) {
  .nu-password :deep(.p-button) {
    min-width: var(--tap-target);
    min-height: var(--tap-target);
  }

  .nu-check {
    min-height: var(--tap-target);
    margin-bottom: 0;
  }
}
</style>
