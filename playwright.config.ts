import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioFixture } from './e2e/tone';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${createAudioFixture()}`,
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: [
    {
      command: 'cargo run -p discord-backend --locked',
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        BACKEND_ADDR: '127.0.0.1:3000',
        DATABASE_URL: `sqlite://${join(tmpdir(), `conversa-e2e-${process.pid}.db`)}`,
        CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
        COOKIE_SECURE: 'false',
        STUN_URLS: '',
        TURN_URLS: '',
        TURN_SHARED_SECRET: '',
        RUST_LOG: 'warn',
      },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
    },
  ],
});
