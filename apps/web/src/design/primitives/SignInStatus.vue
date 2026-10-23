<!-- SPDX-License-Identifier: BUSL-1.1 -->
<!--
  Whether a user can sign in: what stops them, most severe first, each with
  its timing; or that nothing does, and when they last signed in.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { UserDetail } from '@openaduc/shared';
import { describeBlocker, type SignInBlocker } from '../lib/signIn.js';
import { fmtAbsolute, fmtRelative } from '../lib/format.js';

const props = defineProps<{
  blockers: readonly SignInBlocker[];
  lastLogonAt: UserDetail['lastLogonAt'];
}>();

const ICONS: Record<SignInBlocker['kind'], string> = {
  disabled: 'pi-ban',
  locked: 'pi-lock',
  'password-expired': 'pi-key',
  'account-expired': 'pi-calendar-times',
  'must-change-password': 'pi-key',
};

const conditions = computed(() =>
  props.blockers.map((b) => ({ kind: b.kind, icon: ICONS[b.kind], ...describeBlocker(b) })),
);

const lastSignIn = computed(() =>
  props.lastLogonAt
    ? `Last signed in ${fmtAbsolute(props.lastLogonAt)} (${fmtRelative(props.lastLogonAt)})`
    : 'No sign-in recorded',
);
</script>

<template>
  <div class="sign-in-status" :class="conditions.length > 0 ? 'is-blocked' : 'is-clear'">
    <template v-if="conditions.length > 0">
      <div
        v-for="(c, i) in conditions"
        :key="c.kind"
        class="sign-in-condition"
        :class="{ 'is-top': i === 0 }"
      >
        <i :class="['pi', c.icon]" aria-hidden="true" />
        <span class="sign-in-condition-title">{{ c.title }}</span>
        <span v-for="d in c.details" :key="d" class="sign-in-condition-detail">{{ d }}</span>
      </div>
    </template>
    <div v-else class="sign-in-condition is-top">
      <i class="pi pi-check-circle" aria-hidden="true" />
      <span class="sign-in-condition-title">Can sign in</span>
      <!-- lastLogonTimestamp replicates lazily, so it can trail the real sign-in. -->
      <span
        class="sign-in-condition-detail"
        title="From lastLogonTimestamp, which AD updates only every 9 to 14 days"
        >{{ lastSignIn }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.sign-in-status {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--text-2);
}

.sign-in-condition {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 6px;
}

.sign-in-condition > .pi {
  font-size: 12px;
  color: var(--text-3);
}

.sign-in-condition-title {
  font-weight: 500;
}

.sign-in-condition.is-top {
  font-size: 13.5px;
  color: var(--text);
}

.sign-in-condition.is-top .sign-in-condition-title {
  font-weight: 600;
}

.is-blocked .sign-in-condition.is-top > .pi,
.is-blocked .sign-in-condition.is-top .sign-in-condition-title {
  color: var(--red);
}

.is-clear .sign-in-condition.is-top > .pi {
  color: var(--green);
}

.sign-in-condition-detail {
  color: var(--text-3);
}

.sign-in-condition-detail::before {
  content: '·';
  margin-right: 6px;
}
</style>
