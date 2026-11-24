import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.VOICEBOX_E2E_WEB_URL || 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.VOICEBOX_E2E_OUTPUT_DIR
    ? path.join(process.env.VOICEBOX_E2E_OUTPUT_DIR, 'playwright')
    : 'tmp/playwright',
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.VOICEBOX_E2E_WEB_URL
    ? undefined
    : { command: 'bun run dev:web --host 127.0.0.1 --port 5173 --strictPort', url: baseURL },
});
