// SPDX-License-Identifier: BUSL-1.1
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

// matchMedia-backed reactive flags for the breakpoints declared in tokens.css
// (--bp-sm 640, --bp-md 768, --bp-lg 1024). Components opt in when CSS alone
// can't express the change (e.g. swap a desktop popover for a fullscreen
// drawer). For simple grid-stacking, keep using CSS media queries.

const QUERY_SM = '(max-width: 639.98px)';
const QUERY_MD = '(max-width: 767.98px)';
const QUERY_LG = '(max-width: 1023.98px)';

export function useResponsive(): {
  isMobile: Ref<boolean>;
  isTablet: Ref<boolean>;
  isCompact: Ref<boolean>;
} {
  const isMobile: Ref<boolean> = ref(false);
  const isTablet: Ref<boolean> = ref(false);
  const isCompact: Ref<boolean> = ref(false);

  let mqlSm: MediaQueryList | null = null;
  let mqlMd: MediaQueryList | null = null;
  let mqlLg: MediaQueryList | null = null;

  function syncSm(): void {
    isCompact.value = mqlSm?.matches ?? false;
  }
  function syncMd(): void {
    isMobile.value = mqlMd?.matches ?? false;
  }
  function syncLg(): void {
    isTablet.value = mqlLg?.matches ?? false;
  }

  onMounted(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    mqlSm = window.matchMedia(QUERY_SM);
    mqlMd = window.matchMedia(QUERY_MD);
    mqlLg = window.matchMedia(QUERY_LG);
    syncSm();
    syncMd();
    syncLg();
    mqlSm.addEventListener('change', syncSm);
    mqlMd.addEventListener('change', syncMd);
    mqlLg.addEventListener('change', syncLg);
  });

  onBeforeUnmount(() => {
    mqlSm?.removeEventListener('change', syncSm);
    mqlMd?.removeEventListener('change', syncMd);
    mqlLg?.removeEventListener('change', syncLg);
  });

  return { isMobile, isTablet, isCompact };
}
