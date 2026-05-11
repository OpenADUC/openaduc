<!-- SPDX-License-Identifier: BUSL-1.1 -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import Toast from 'primevue/toast';
import { api, type InitialSyncJob, type SetupExistingDirectory } from '../api/index.js';
import { invalidateSetupCheck } from '../router/index.js';
import StepDirectory from './setup/StepDirectory.vue';
import StepServiceAccount from './setup/StepServiceAccount.vue';
import StepPolicy from './setup/StepPolicy.vue';
import StepInitialSync from './setup/StepInitialSync.vue';
import StepComplete from './setup/StepComplete.vue';
import Wordmark from '../design/primitives/Wordmark.vue';

interface StepDef {
  id: 1 | 2 | 3 | 4 | 5;
  label: string;
}

const STEPS: StepDef[] = [
  { id: 1, label: 'Domain' },
  { id: 2, label: 'Service account' },
  { id: 3, label: 'Policy' },
  { id: 4, label: 'Initial sync' },
  { id: 5, label: 'Done' },
];

const loading = ref(true);
const currentStep = ref<1 | 2 | 3 | 4 | 5>(1);
const existingDirectory = ref<SetupExistingDirectory | null>(null);
const completedJob = ref<InitialSyncJob | null>(null);

const activeStepLabel = computed(() => {
  const s = STEPS.find((s) => s.id === currentStep.value);
  return s?.label ?? '';
});

async function refreshStatus(): Promise<{ jumpTo: 1 | 2 | 3 | 4 | 5 }> {
  const status = await api.setup.status();
  existingDirectory.value = status.existingDirectory;
  if (status.onboardingCompletedAt) return { jumpTo: 5 };

  try {
    const job = await api.setup.initialSyncStatus();
    if (job.job?.status === 'running') return { jumpTo: 4 };
    if (job.job?.status === 'succeeded') {
      completedJob.value = job.job;
      return { jumpTo: 5 };
    }
    if (job.job?.status === 'failed') return { jumpTo: 4 };
  } catch {
    // fall through to static decision tree
  }

  if (!status.configured) return { jumpTo: 1 };
  if (!status.hasServiceAccount) return { jumpTo: 2 };
  return { jumpTo: 3 };
}

onMounted(async () => {
  try {
    const { jumpTo } = await refreshStatus();
    currentStep.value = jumpTo;
  } catch {
    currentStep.value = 1;
  } finally {
    loading.value = false;
  }
});

async function handleDirectoryDone(): Promise<void> {
  const { jumpTo } = await refreshStatus();
  currentStep.value = jumpTo === 1 ? 2 : jumpTo;
}

function handleServiceAccountDone(): void {
  currentStep.value = 3;
}

function handlePolicyDone(): void {
  currentStep.value = 4;
}

function handleSyncComplete(job: InitialSyncJob): void {
  completedJob.value = job;
  currentStep.value = 5;
  invalidateSetupCheck();
}

function goBackTo(step: 1 | 2 | 3): void {
  if (step >= currentStep.value) return;
  if (currentStep.value >= 4) return; // step 4+ locks history
  currentStep.value = step;
}

function isReachable(step: StepDef): boolean {
  if (step.id === currentStep.value) return true;
  if (step.id < currentStep.value) return currentStep.value < 4;
  return false;
}

function stepStatus(step: StepDef): 'done' | 'active' | 'pending' {
  if (step.id < currentStep.value) return 'done';
  if (step.id === currentStep.value) return 'active';
  return 'pending';
}

function clickStep(step: StepDef): void {
  if (!isReachable(step)) return;
  if (step.id === currentStep.value) return;
  if (step.id < currentStep.value && step.id <= 3) goBackTo(step.id as 1 | 2 | 3);
}
</script>

<template>
  <Toast />
  <div class="setup-page">
    <div class="setup-stage">
      <header class="brand">
        <img class="brand-mark" src="/branding/logo.png" alt="" />
        <div class="brand-text">
          <Wordmark as="h1" class="brand-title" />
          <p class="brand-sub">First-run setup</p>
        </div>
      </header>

      <div class="card theme-light">
        <nav class="stepper" aria-label="Setup progress">
          <ol class="stepper-list">
            <li
              v-for="step in STEPS"
              :key="step.id"
              class="stepper-item"
              :class="`is-${stepStatus(step)}`"
              :aria-current="step.id === currentStep ? 'step' : undefined"
            >
              <button
                type="button"
                class="stepper-button"
                :disabled="!isReachable(step)"
                @click="clickStep(step)"
              >
                <span class="stepper-bullet">
                  <i v-if="stepStatus(step) === 'done'" class="pi pi-check" />
                  <span v-else>{{ step.id }}</span>
                </span>
                <span class="stepper-label">{{ step.label }}</span>
              </button>
            </li>
          </ol>
          <div class="stepper-mobile">
            Step {{ currentStep }} of {{ STEPS.length }} · {{ activeStepLabel }}
          </div>
        </nav>

        <main class="step-area">
          <div v-if="loading" class="loading">Loading…</div>
          <StepDirectory
            v-else-if="currentStep === 1"
            :existing="existingDirectory"
            @next="handleDirectoryDone"
          />
          <StepServiceAccount
            v-else-if="currentStep === 2"
            @next="handleServiceAccountDone"
            @back="goBackTo(1)"
          />
          <StepPolicy v-else-if="currentStep === 3" @next="handlePolicyDone" @back="goBackTo(2)" />
          <StepInitialSync v-else-if="currentStep === 4" @complete="handleSyncComplete" />
          <StepComplete v-else-if="currentStep === 5" :job="completedJob" />
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Always-dark page so the white card has real contrast regardless of
   the app theme the operator may pick later. The wizard is a one-time
   experience; we want it to feel deliberately distinct. */
.setup-page {
  position: fixed;
  inset: 0;
  overflow: auto;
  background:
    radial-gradient(circle at 20% 10%, rgba(79, 70, 229, 0.18), transparent 45%),
    radial-gradient(circle at 80% 90%, rgba(34, 197, 94, 0.1), transparent 50%), #09090b;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 32px 16px;
  color: #ededee;
}

.setup-stage {
  width: 100%;
  max-width: 540px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #ededee;
}
.brand-mark {
  width: 32px;
  height: 32px;
  border-radius: 7px;
  object-fit: contain;
  display: block;
}
.brand-text {
  display: flex;
  flex-direction: column;
  gap: 0;
  line-height: 1.1;
}
.brand-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #fafafa;
}
.brand-sub {
  margin: 0;
  font-size: 12px;
  color: #a1a1aa;
}

/* Wizard card — light theme tokens are scoped here so PrimeVue inputs
   inside the card pick up light surfaces, regardless of the operator's
   eventual theme choice. */
.card {
  background: #ffffff;
  border-radius: 14px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.05),
    0 24px 48px rgba(0, 0, 0, 0.45),
    0 4px 12px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
  color: #18181b;
}

/* Stepper */
.stepper {
  border-bottom: 1px solid #e7e7ea;
  padding: 12px 18px;
  background: #fafafa;
}
.stepper-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}
.stepper-item {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 0;
  min-width: 0;
}
.stepper-item:not(:last-child)::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #e7e7ea;
  margin: 0 4px;
}
.stepper-item.is-done:not(:last-child)::after {
  background: #16a34a;
}
.stepper-item.is-active:not(:last-child)::after {
  background: linear-gradient(to right, #16a34a, #d4d4d8);
}
.stepper-button {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  color: #71717a;
  min-width: 0;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}
.stepper-button:hover:not(:disabled) {
  color: #18181b;
  background: #f5f5f7;
}
.stepper-button:disabled {
  cursor: default;
}
.stepper-bullet {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  background: #ffffff;
  border: 1px solid #d4d4d8;
  color: #71717a;
  flex-shrink: 0;
}
.stepper-item.is-active .stepper-bullet {
  background: #4f46e5;
  border-color: #4f46e5;
  color: #ffffff;
  box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.15);
}
.stepper-item.is-done .stepper-bullet {
  background: #16a34a;
  border-color: #16a34a;
  color: #ffffff;
}
.stepper-item.is-active .stepper-button {
  color: #18181b;
  font-weight: 600;
}
.stepper-item.is-done .stepper-button {
  color: #52525b;
}
.stepper-label {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stepper-mobile {
  display: none;
}

@media (max-width: 560px) {
  .stepper-list {
    display: none;
  }
  .stepper-mobile {
    display: block;
    font-size: 12.5px;
    color: #52525b;
  }
}

/* Step area */
.step-area {
  padding: 22px 22px 24px;
}
.loading {
  color: #71717a;
  font-family: var(--font-mono);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
</style>
