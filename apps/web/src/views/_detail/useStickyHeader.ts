// SPDX-License-Identifier: BUSL-1.1
import { onBeforeUnmount, ref, type Ref } from 'vue';

// Drives the compact-on-scroll behavior shared by the User, Group, and
// Computer detail pages.
//
// Detection: we discover the actual scrolling ancestor of the hero by
// listening for scroll events on window with capture phase (scroll events
// don't bubble — capture is what catches them from any element). The
// first ancestor scroll we see becomes our reference container, and we
// drive `compact` directly off its scrollTop. This is robust against
// viewport size changes, layout shifts during the shrink animation, and
// nested overflow setups: scrollTop is 0 at the top regardless.
//
// `heroHeight` tracks the rendered border-box height via ResizeObserver
// so pages can bind it to `--detail-sticky-offset` and have downstream
// sticky elements (User tab bar, Group Members card head) pin flush
// with the hero's current bottom edge mid-animation.

type VueTemplateRefArg = Element | { $el?: unknown } | null;

// Hysteresis on the scroll container's scrollTop: enter compact above
// ENTER_THRESHOLD pixels, exit only below EXIT_THRESHOLD. The dead band
// absorbs mid-animation wobble so compact can't flicker at the boundary.
const ENTER_THRESHOLD = 8;
const EXIT_THRESHOLD = 4;

function getBorderBoxHeight(entry: ResizeObserverEntry, el: HTMLElement): number {
  const borderBoxSize = entry.borderBoxSize;
  if (borderBoxSize) {
    const firstSize = Array.isArray(borderBoxSize) ? borderBoxSize[0] : borderBoxSize;
    if (firstSize) return firstSize.blockSize;
  }
  return el.getBoundingClientRect().height;
}

export function useStickyHeader(): {
  setHero: (el: VueTemplateRefArg) => void;
  compact: Ref<boolean>;
  heroHeight: Ref<number>;
} {
  const compact = ref(false);
  const heroHeight = ref(0);

  let heroEl: HTMLElement | null = null;
  let scrollContainer: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rafHandle: number | null = null;

  function update(): void {
    if (!heroEl) return;
    const scrollTop = scrollContainer?.scrollTop ?? 0;
    let next = compact.value;
    if (compact.value) {
      if (scrollTop < EXIT_THRESHOLD) next = false;
    } else {
      if (scrollTop > ENTER_THRESHOLD) next = true;
    }
    if (next !== compact.value) compact.value = next;
  }

  function scheduleUpdate(): void {
    if (rafHandle !== null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      update();
    });
  }

  function onScroll(e: Event): void {
    // Latch onto the actual scrolling ancestor the first time we see
    // a scroll event from one. Re-latch if a different ancestor scrolls
    // (handles nested or sibling scroll containers).
    const t = e.target;
    if (t instanceof HTMLElement && heroEl && t.contains(heroEl) && t !== heroEl) {
      scrollContainer = t;
    }
    scheduleUpdate();
  }

  function onResize(): void {
    scheduleUpdate();
  }

  function teardown(): void {
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    heroEl = null;
    scrollContainer = null;
  }

  function setHero(arg: VueTemplateRefArg): void {
    const el = arg instanceof HTMLElement ? arg : null;
    if (el === heroEl) return;
    teardown();
    if (!el) {
      compact.value = false;
      heroHeight.value = 0;
      return;
    }
    heroEl = el;
    heroHeight.value = el.getBoundingClientRect().height;

    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && heroEl) {
        heroHeight.value = getBorderBoxHeight(entry, heroEl);
        update();
      }
    });
    resizeObserver.observe(el);

    // Capture-phase scroll on window catches scroll events from any
    // element — onScroll latches the first scrolling ancestor we see
    // and reads its scrollTop on each update.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize, { passive: true });
  }

  onBeforeUnmount(teardown);

  return { setHero, compact, heroHeight };
}
