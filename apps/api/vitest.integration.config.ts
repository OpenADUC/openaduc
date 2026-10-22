// SPDX-License-Identifier: BUSL-1.1
// Route integration tests: the real API against Postgres and the dev Samba
// DC. Run with `pnpm test:integration`; needs Docker.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    globals: false,
    globalSetup: ['test/integration/globalSetup.ts'],
    // Files share one directory, so run them one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
