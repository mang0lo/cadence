import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the web app's pure logic (lib/, features/*/lib/, chart and map helpers). No DOM: React components
// are not rendered here. Same `@/` alias as vite.config.ts.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
