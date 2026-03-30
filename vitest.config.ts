import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    fileParallelism: false,
    exclude: ['github-matrix-dev/**', 'node_modules/**'],
  },
});
