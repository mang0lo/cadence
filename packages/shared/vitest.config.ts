import { defineConfig } from 'vitest/config';

// Unit tests for the shared contract helpers (units, sports, tags, tracks, goal metrics, health catalogue).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
