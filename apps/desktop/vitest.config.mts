import { defineConfig } from 'vitest/config';

// Unit tests for the Electron main process's logic that does not need Electron (server lifecycle, URL policy).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
