// SPDX-License-Identifier: BUSL-1.1
import { onBeforeUnmount, ref, type Ref } from 'vue';

// Watches a tab nav element and flips `compact` true when its content
// would overflow horizontally. Used by the User detail toolbar to hide
// tab labels (icon-only) once the tabs + actions cluster no longer fit.
//
// Why measurement over a CSS media query: the toolbar's available width
// depends on the sidebar state, page padding, and the Actions cluster's
// rendered width — none of which a viewport breakpoint can see.
//
// Hysteresis: enter compact when scrollWidth exceeds clientWidth by more
// than ENTER_OVERFLOW. Exit only when, with labels expanded, we'd have
// EXIT_HEADROOM px of slack. The two thresholds prevent the bar from
// flickering at the boundary as label widths jitter by a pixel.

type VueTemplateRefArg = Element | { $el?: unknown } | null;

const ENTER_OVERFLOW = 1;
const EXIT_HEADROOM = 24;

export function useCompactTabs(): {
  setNav: (el: VueTemplateRefArg) => void;
  compact: Ref<boolean>;
} {
  const compact = ref(false);

  let navEl: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let rafHandle: number | null = null;

  function update(): void {
    if (!navEl) return;
    let next = compact.value;
    if (compact.value) {
      // scrollWidth alone can't tell us whether content is *narrower*
      // than the container — it's clamped to a minimum of clientWidth.
      // To recover the natural width we apply `.measuring`, which hides
      // the flex spacer and pins every other child to `flex: none` so
      // nothing shrinks under flex pressure. Then the visible content
      // spans from the first child's left edge to the last child's
      // right edge, regardless of where it lands inside the container.
      navEl.classList.remove('compact');
      navEl.classList.add('measuring');
      const first = navEl.firstElementChild as HTMLElement | null;
      const last = navEl.lastElementChild as HTMLElement | null;
      let naturalWidth = 0;
      if (first && last) {
        const firstLeft = first.getBoundingClientRect().left;
        const lastRight = last.getBoundingClientRect().right;
        naturalWidth = lastRight - firstLeft;
      }
      const client = navEl.clientWidth;
      navEl.classList.remove('measuring');
      navEl.classList.add('compact');
      if (naturalWidth + EXIT_HEADROOM <= client) next = false;
    } else {
      const overflow = navEl.scrollWidth - navEl.clientWidth;
      if (overflow > ENTER_OVERFLOW) next = true;
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

  function onResize(): void {
    scheduleUpdate();
  }

  function teardown(): void {
    window.removeEventListener('resize', onResize);
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    navEl = null;
  }

  function setNav(arg: VueTemplateRefArg): void {
    const el = arg instanceof HTMLElement ? arg : null;
    if (el === navEl) return;
    teardown();
    if (!el) {
      compact.value = false;
      return;
    }
    navEl = el;

    // Initial measurement deferred to next frame so layout settles.
    requestAnimationFrame(() => {
      if (!navEl) return;
      update();
    });

    resizeObserver = new ResizeObserver(() => {
      scheduleUpdate();
    });
    resizeObserver.observe(el);

    window.addEventListener('resize', onResize, { passive: true });
  }

  onBeforeUnmount(teardown);

  return { setNav, compact };
}
