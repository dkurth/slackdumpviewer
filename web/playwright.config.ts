import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the real binary against the synthetic fixture archive, headless only.
// Nothing opens on screen: the server gets --no-open and the browser is headless.
const dir = join(tmpdir(), 'sdv-e2e-archive');
const port = 8799;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `go run ../internal/fixture/mkfixture "${dir}" && go run ../cmd/slackdumpviewer --no-open --port ${port} "${dir}"`,
    url: `http://127.0.0.1:${port}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { SLACKDUMPVIEWER_NO_OPEN: '1' },
  },
});
