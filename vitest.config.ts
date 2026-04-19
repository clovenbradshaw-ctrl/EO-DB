import { defineConfig } from 'vitest/config';

// Give tests a stable secret so modules that now require EO_INGESTION_SECRET
// boot without every test file having to set it.
process.env.EO_INGESTION_SECRET ??= 'test-ingestion-secret-____________________________________';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    fileParallelism: false,
    exclude: ['github-matrix-dev/**', 'node_modules/**'],
  },
});
