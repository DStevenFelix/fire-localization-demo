import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Run the Bridge using the user's Anaconda agent environment.
const pythonExecutable = process.env.FIRE_PYTHON || 'D:/Anaconda/envs/agent/python.exe';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const runtimeRoot = fileURLToPath(new URL('./test-results/bridge-runtime/', import.meta.url)).replaceAll('\\', '/');
const bridgeCode = `import sys; sys.path.insert(0, '${projectRoot}'); from pathlib import Path; from frontend.bridge.server import create_app; import uvicorn; uvicorn.run(create_app(Path('${runtimeRoot}')), host='127.0.0.1', port=8080)`;

export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, timeout: 45000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: `"${pythonExecutable}" -B -c "${bridgeCode}"`,
      env: { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' },
      url: 'http://127.0.0.1:8080/api/health', timeout: 60000, reuseExistingServer: false },
    { command: 'npm run dev', url: 'http://127.0.0.1:5173', timeout: 60000, reuseExistingServer: false },
  ],
});
