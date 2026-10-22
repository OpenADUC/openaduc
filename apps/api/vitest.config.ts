// SPDX-License-Identifier: BUSL-1.1
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/integration/**', '**/node_modules/**'],
    environment: 'node',
    globals: false,
  },
});
