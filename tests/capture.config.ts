import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * UI capture run — screenshots every screen, role and modal for design work.
 * Separate from the test config so it never runs in the battery, but reuses the
 * same mock + built client so the shots are of the REAL app, not a mock-up.
 *
 *   npx playwright test --config=capture.config.ts
 */
export default defineConfig({
  testDir: './capture',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', headless: true },
  webServer: [
    { command: 'node mock/mock-api.mjs', url: 'http://127.0.0.1:8787/__state', reuseExistingServer: true, cwd: HERE },
    {
      command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      cwd: path.join(HERE, '..', 'web'),
    },
  ],
});
