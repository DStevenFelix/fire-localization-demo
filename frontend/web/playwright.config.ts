import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const pythonExecutable = process.env.FIRE_PYTHON || 'D:/Anaconda/envs/agent/python.exe';
const reuseExistingServer = process.env.FIRE_E2E_REUSE === '1';
// Bridge 批次审计频繁原子替换文件；放入进程隔离的临时目录，避开工作区报告和文件监视器的共享目录。
const runtimeRoot = (process.env.FIRE_TEST_RUNTIME || join(tmpdir(), 'fire-sandbox-e2e', String(process.pid))).replaceAll('\\', '/');
const bridgeCode = `import sys; sys.path.insert(0, '${projectRoot}'); from pathlib import Path; from frontend.bridge.server import create_app; import uvicorn; uvicorn.run(create_app(Path('${runtimeRoot}')), host='127.0.0.1', port=8080, timeout_graceful_shutdown=3)`;

export default defineConfig({
  outputDir: process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/playwright-results` : './test-results',
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 45000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.FIRE_ACCEPTANCE_DIR ? `${process.env.FIRE_ACCEPTANCE_DIR}/playwright-report` : 'playwright-report' }],
    ...(process.env.FIRE_ACCEPTANCE_DIR ? [['json', { outputFile: `${process.env.FIRE_ACCEPTANCE_DIR}/browser-results.json` }] as const] : [])],
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    ...(process.env.FIRE_E2E_MOCK_ONLY === '1' ? [] : [{ command: `"${pythonExecutable}" -B -c "${bridgeCode}"`,
      env: { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', FIRE_SIGNAL_HOST: 'off' },
      url: 'http://127.0.0.1:8080/api/health', timeout: 60000, reuseExistingServer }]),
    { command: 'npm run dev', url: 'http://127.0.0.1:5173', timeout: 60000, reuseExistingServer },
  ],
});
