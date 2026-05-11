// SPDX-License-Identifier: BUSL-1.1
import { defineStore } from 'pinia';
import { computed, ref, watchEffect } from 'vue';

export type ThemeMode = 'dark' | 'light';
export type Density = 'compact' | 'balanced' | 'comfy';
export type AccentName = 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose' | 'blue';

const STORAGE_KEY = 'openaduc:theme';

interface AccentTokens {
  color: string;
  soft: string;
  text: string;
  contrast: string;
}

// Bright tints for dark mode — picked so the accent reads against near-black
// surfaces. Used as-is for buttons, focus rings, and the active sidebar bar.
export const ACCENTS: Record<AccentName, AccentTokens> = {
  cyan: {
    color: '#22d3ee',
    soft: 'rgba(34, 211, 238, 0.12)',
    text: '#22d3ee',
    contrast: '#07080a',
  },
  blue: {
    color: '#60a5fa',
    soft: 'rgba(96, 165, 250, 0.12)',
    text: '#60a5fa',
    contrast: '#07080a',
  },
  violet: {
    color: '#a78bfa',
    soft: 'rgba(167, 139, 250, 0.12)',
    text: '#a78bfa',
    contrast: '#07080a',
  },
  emerald: {
    color: '#34d399',
    soft: 'rgba(52, 211, 153, 0.12)',
    text: '#34d399',
    contrast: '#07080a',
  },
  amber: {
    color: '#fbbf24',
    soft: 'rgba(251, 191, 36, 0.14)',
    text: '#fbbf24',
    contrast: '#1a1107',
  },
  rose: {
    color: '#fb7185',
    soft: 'rgba(251, 113, 133, 0.13)',
    text: '#fb7185',
    contrast: '#1a0708',
  },
};

// Darker, more saturated variants for light mode. Bright cyan/violet/etc on
// pure white renders as pale and washes out — these shades (roughly tailwind
// 600/700) keep accent text legible and primary buttons readable.
const ACCENTS_LIGHT: Record<AccentName, AccentTokens> = {
  cyan: { color: '#0891b2', soft: 'rgba(8, 145, 178, 0.12)', text: '#0e7490', contrast: '#ffffff' },
  blue: { color: '#1d4ed8', soft: 'rgba(29, 78, 216, 0.10)', text: '#1e40af', contrast: '#ffffff' },
  violet: {
    color: '#6d28d9',
    soft: 'rgba(109, 40, 217, 0.10)',
    text: '#5b21b6',
    contrast: '#ffffff',
  },
  emerald: {
    color: '#047857',
    soft: 'rgba(4, 120, 87, 0.10)',
    text: '#065f46',
    contrast: '#ffffff',
  },
  amber: { color: '#b45309', soft: 'rgba(180, 83, 9, 0.10)', text: '#92400e', contrast: '#ffffff' },
  rose: { color: '#be123c', soft: 'rgba(190, 18, 60, 0.10)', text: '#9f1239', contrast: '#ffffff' },
};

interface PersistedShape {
  mode?: ThemeMode;
  density?: Density;
  accent?: AccentName;
  sidebarCollapsed?: boolean;
}

function readPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePersisted(value: PersistedShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable (private mode, etc) — non-fatal.
  }
}

export const useThemeStore = defineStore('theme', () => {
  const persisted = readPersisted();

  const mode = ref<ThemeMode>(persisted.mode ?? 'dark');
  const density = ref<Density>(persisted.density ?? 'balanced');
  const accent = ref<AccentName>(persisted.accent ?? 'cyan');
  const sidebarCollapsed = ref<boolean>(persisted.sidebarCollapsed ?? false);

  // Resolve tokens for the *active* mode — light gets the darker
  // shades, dark gets the bright ones. Same accent name, two palettes.
  const accentTokens = computed<AccentTokens>(() =>
    mode.value === 'light' ? ACCENTS_LIGHT[accent.value] : ACCENTS[accent.value],
  );

  // Apply theme/density classes and accent vars to <html> and <body> whenever
  // any of these change. Persist to localStorage in the same effect.
  watchEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;

    html.classList.toggle('theme-dark', mode.value === 'dark');
    html.classList.toggle('theme-light', mode.value === 'light');
    body.classList.toggle('theme-dark', mode.value === 'dark');
    body.classList.toggle('theme-light', mode.value === 'light');

    body.classList.remove('density-compact', 'density-balanced', 'density-comfy');
    body.classList.add(`density-${density.value}`);

    // PrimeVue Aura responds to the data-theme attribute / system color-scheme.
    html.setAttribute('data-theme', mode.value);
    html.style.colorScheme = mode.value;

    const a = accentTokens.value;
    html.style.setProperty('--accent', a.color);
    html.style.setProperty('--accent-soft', a.soft);
    html.style.setProperty('--accent-text', a.text);
    html.style.setProperty('--accent-contrast', a.contrast);

    writePersisted({
      mode: mode.value,
      density: density.value,
      accent: accent.value,
      sidebarCollapsed: sidebarCollapsed.value,
    });
  });

  function setMode(next: ThemeMode): void {
    mode.value = next;
  }
  function toggleMode(): void {
    mode.value = mode.value === 'dark' ? 'light' : 'dark';
  }
  function setDensity(next: Density): void {
    density.value = next;
  }
  function setAccent(next: AccentName): void {
    accent.value = next;
  }
  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  return {
    mode,
    density,
    accent,
    sidebarCollapsed,
    accentTokens,
    setMode,
    toggleMode,
    setDensity,
    setAccent,
    toggleSidebar,
  };
});
