<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Button from 'primevue/button';
import { invalidateSetupCheck } from '../../router/index.js';
import type { InitialSyncJob } from '../../api/index.js';

interface Props {
  job: InitialSyncJob | null;
}
const props = defineProps<Props>();
const router = useRouter();

interface RecapStat {
  label: string;
  count: number;
}

const recap = computed<RecapStat[]>(() => {
  if (!props.job) return [];
  const out: RecapStat[] = [];
  for (const task of props.job.tasks) {
    if (!task.stats) continue;
    const stats = task.stats as Record<string, unknown>;
    if (task.key === 'users.full') {
      const v = stats.users ?? stats.count ?? stats.scanned;
      if (typeof v === 'number') out.push({ label: 'Users', count: v });
    } else if (task.key === 'groups.full') {
      const v = stats.groups ?? stats.count ?? stats.scanned;
      if (typeof v === 'number') out.push({ label: 'Groups', count: v });
    } else if (task.key === 'computers.full') {
      const v = stats.computers ?? stats.count ?? stats.scanned;
      if (typeof v === 'number') out.push({ label: 'Computers', count: v });
    } else if (task.key === 'ous.full') {
      const v = stats.ous ?? stats.count ?? stats.scanned;
      if (typeof v === 'number') out.push({ label: 'OUs', count: v });
    }
  }
  return out;
});

function go(name: string): void {
  invalidateSetupCheck();
  void router.push({ name });
}

function goSettings(tab: string): void {
  invalidateSetupCheck();
  void router.push({ name: 'settings', query: { tab } });
}
</script>

<template>
  <div class="step">
    <div class="hero">
      <div class="hero-icon"><i class="pi pi-check" /></div>
      <h2 class="title">You're all set</h2>
      <p class="sub">
        OpenADUC has a complete snapshot of your directory. Background sync will keep it fresh.
      </p>
    </div>

    <div v-if="recap.length" class="recap">
      <div v-for="row in recap" :key="row.label" class="recap-row">
        <div class="recap-count">{{ row.count.toLocaleString() }}</div>
        <div class="recap-label">{{ row.label }}</div>
      </div>
    </div>

    <div class="next-grid">
      <button class="next-card" type="button" @click="go('tasks')">
        <i class="pi pi-clock next-icon" />
        <div class="next-text">
          <div class="next-name">Configure sync schedule</div>
          <div class="next-desc">Adjust cadences or pause individual tasks.</div>
        </div>
        <i class="pi pi-arrow-right next-arrow" />
      </button>
      <button class="next-card" type="button" @click="goSettings('integrations')">
        <i class="pi pi-microsoft next-icon" />
        <div class="next-text">
          <div class="next-name">Connect Microsoft Entra</div>
          <div class="next-desc">Photos, sign-ins, and MFA registration.</div>
        </div>
        <i class="pi pi-arrow-right next-arrow" />
      </button>
    </div>

    <div class="actions">
      <Button
        type="button"
        label="Skip to dashboard"
        severity="secondary"
        text
        @click="go('dashboard')"
      />
    </div>
  </div>
</template>

<style scoped>
.step {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: #18181b;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 12px 0 4px;
}
.hero-icon {
  width: 44px;
  height: 44px;
  background: #16a34a;
  color: #ffffff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  margin-bottom: 4px;
  box-shadow: 0 0 0 6px rgba(22, 163, 74, 0.15);
}
.title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: #18181b;
}
.sub {
  margin: 0;
  font-size: 13px;
  color: #52525b;
  line-height: 1.5;
  max-width: 44ch;
}

.recap {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}
.recap-row {
  background: #fafafa;
  border: 1px solid #e7e7ea;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.recap-count {
  font-size: 18px;
  font-weight: 600;
  color: #18181b;
  font-variant-numeric: tabular-nums;
}
.recap-label {
  font-size: 11.5px;
  color: #71717a;
}

.next-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
@media (max-width: 480px) {
  .next-grid {
    grid-template-columns: 1fr;
  }
}
.next-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid #e7e7ea;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    transform 0.05s ease;
}
.next-card:hover {
  border-color: #4f46e5;
  background: #eef2ff;
}
.next-card:active {
  transform: translateY(1px);
}
.next-icon {
  font-size: 18px;
  color: #4f46e5;
  flex-shrink: 0;
}
.next-text {
  flex: 1;
  min-width: 0;
}
.next-name {
  font-size: 13px;
  font-weight: 600;
  color: #18181b;
}
.next-desc {
  font-size: 11.5px;
  color: #71717a;
  line-height: 1.4;
  margin-top: 1px;
}
.next-arrow {
  font-size: 12px;
  color: #a1a1aa;
}

.actions {
  display: flex;
  justify-content: center;
}
:deep(.p-button) {
  padding: 7px 14px;
  font-size: 13px;
}
</style>
