import { defineConfig } from 'vitest/config';

// Tests run against the real local infrastructure, isolated from dev data:
// database "anchorpay_test" (recreated by the global setup) and a per-run Redis key prefix.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/env.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'services/*/src/**/*.ts'],
      exclude: ['**/server.ts', '**/scripts/**'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
    },
  },
});
