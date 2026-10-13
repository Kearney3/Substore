import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = resolve(root, 'worker');
const assetsDir = resolve(root, 'frontend-dist');
const base = 'http://127.0.0.1:8787';

if (!existsSync(assetsDir)) {
  throw new Error(`Frontend assets are missing: ${assetsDir}. Run scripts/sync-official-frontend.mjs first.`);
}

if (!existsSync(resolve(assetsDir, 'index.html'))) {
  throw new Error(`Frontend index.html is missing: ${resolve(assetsDir, 'index.html')}.`);
}

const worker = spawn(
  'npx',
  [
    'wrangler',
    'dev',
    '--local',
    '--port',
    '8787',
    '--show-interactive-dev-session',
    'false'
  ],
  {
    cwd: workerDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env }
  }
);

let finished = false;

function stop(code = 0) {
  if (finished) return;
  finished = true;

  try {
    worker.kill('SIGTERM');
  } catch {
    // Process may already have exited.
  }

  process.exit(code);
}

process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));

worker.on('exit', (code) => {
  if (!finished && code !== null && code !== 0) {
    process.exit(code);
  }
});

async function waitForReady(timeoutSeconds = 60) {
  for (let i = 0; i < timeoutSeconds; i += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));

    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return true;
    } catch {
      // Wrangler is still starting.
    }
  }

  return false;
}

const ready = await waitForReady();

if (!ready) {
  stop(1);
  throw new Error(`Worker did not become ready within 60 seconds.`);
}

console.log('Worker is ready; executing contract tests.');

try {
  process.env.WORKER_TEST_URL = base;
  await import('../tests/contract.mjs');
  console.log('Worker contract tests passed.');
  stop(0);
} catch (error) {
  console.error('Worker contract tests failed.');
  stop(1);
  throw error;
}
