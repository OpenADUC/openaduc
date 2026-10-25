// SPDX-License-Identifier: BUSL-1.1
import { onTestFinished, vi } from 'vitest';

// useResponsive reads its breakpoints through matchMedia; a phone is narrower
// than every one of them. Lasts until the test finishes.
export function atPhoneWidth(): void {
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  onTestFinished(() => spy.mockRestore());
}
