// SPDX-License-Identifier: BUSL-1.1
import { onBeforeUnmount, onMounted } from 'vue';

// How much of the window the on-screen keyboard hides, as two variables on
// <html>: --keyboard-inset at the bottom, for sheets and toasts (theme.css),
// and --visual-viewport-top, for the quick search panel at the top. Chrome
// resizes the window for the keyboard (interactive-widget in index.html),
// leaving both at 0; Safari only shrinks the visual viewport, and pans it
// down to the focused field, so fixed surfaces would sit behind the keyboard
// or above the screen without them.
export function useVisualViewport(): void {
  const style = document.documentElement.style;

  function sync(): void {
    const viewport = window.visualViewport;
    if (!viewport) return;
    // A pinch-zoom moves the visual viewport too; the page stays put.
    const zoomed = viewport.scale !== 1;
    const top = zoomed ? 0 : viewport.offsetTop;
    const bottom = zoomed ? 0 : window.innerHeight - viewport.height - viewport.offsetTop;
    style.setProperty('--visual-viewport-top', `${Math.max(0, Math.round(top))}px`);
    style.setProperty('--keyboard-inset', `${Math.max(0, Math.round(bottom))}px`);
  }

  onMounted(() => {
    window.visualViewport?.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('scroll', sync);
    sync();
  });

  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', sync);
    window.visualViewport?.removeEventListener('scroll', sync);
    style.removeProperty('--visual-viewport-top');
    style.removeProperty('--keyboard-inset');
  });
}
