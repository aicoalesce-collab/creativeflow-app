import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Base config: serves the BUILT client (web/dist) on :4173 and the default
 * mock on :8787. Suites that need knob variants (MOCK_SLOW_BIG etc.) spawn
 * their own mock on 8790+ inside the spec — the verify-v491 pattern.
 * All suites are hermetic: script.google.com is route-aborted in the fixtures.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: 0,
  // Serial: every suite shares ONE stateful mock on :8787 and calls /__reset in
  // beforeEach — parallel workers would race each other's fixtures. Suites that
  // need isolation spawn their own mock on 879x (see 70-problem-pc).
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: [
    {
      command: 'node mock/mock-api.mjs',
      url: 'http://127.0.0.1:8787/__state',
      reuseExistingServer: true,
      cwd: HERE,
    },
    {
      // --host 127.0.0.1: vite otherwise binds ::1 only and the IPv4 health check hangs
      command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: true,
      cwd: path.join(HERE, '..', 'web'),
    },
  ],
});
