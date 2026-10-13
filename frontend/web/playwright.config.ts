import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 45000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${fileURLToPath(new URL('../start-bridge.ps1', import.meta.url))}"`,
      url: 'http://127.0.0.1:8080/api/health', timeout: 60000, reuseExistingServer: false },
    { command: 'npm run dev', url: 'http://127.0.0.1:5173', timeout: 60000, reuseExistingServer: false },
  ],
});
