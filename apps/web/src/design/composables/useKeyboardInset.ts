// SPDX-License-Identifier: BUSL-1.1
import { onBeforeUnmount, onMounted } from 'vue';

// How much of the window the on-screen keyboard covers, as --keyboard-inset
// on <html>, so dialog sheets (theme.css) can sit above it. Chrome resizes
// the window for the keyboard (interactive-widget in index.html), leaving
// this at 0; Safari only shrinks the visual viewport, and a sheet fixed to
// the window's bottom would be behind the keyboard.
export function useKeyboardInset(): void {
  const root = document.documentElement;

  function sync(): void {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const covered = window.innerHeight - viewport.height - viewport.offsetTop;
    root.style.setProperty('--keyboard-inset', `${Math.max(0, Math.round(covered))}px`);
  }

  onMounted(() => {
    window.visualViewport?.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('scroll', sync);
    sync();
  });

  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
    root.style.removeProperty('--keyboard-inset');
  });
}
