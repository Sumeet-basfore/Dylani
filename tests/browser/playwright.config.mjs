import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  testDir:'.',
  testMatch:'security.spec.mjs',
  workers:1,
  retries:0,
  timeout:45_000,
  reporter:'list',
  webServer:{
    command:'node tests/browser/fixture-server.mjs',
    cwd:fileURLToPath(new URL('../..',import.meta.url)),
    url:'http://127.0.0.1:4173/',
    timeout:90_000,
    reuseExistingServer:false,
    env:{...process.env,VITE_PORT:'4173'}
  }
});
