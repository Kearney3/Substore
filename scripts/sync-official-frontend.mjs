import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkout = resolve(root, 'frontend');
const output = resolve(root, 'frontend-dist');
// 默认使用官方仓库，可通过环境变量 FRONTEND_REPO 覆盖
const repo = process.env.FRONTEND_REPO || 'https://github.com/sub-store-org/Sub-Store-Front-End.git';
const ref = process.env.FRONTEND_REF || '4bd7b0acbe65466b933ccea14fc61dbebe036ead';
const pnpmVersion = process.env.PNPM_VERSION || '11.0.9';
const pnpmArgs = ['--yes', `pnpm@${pnpmVersion}`];

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env } });
}

console.log('🧹 Cleaning up previous builds...');
rmSync(checkout, { recursive: true, force: true });
rmSync(output, { recursive: true, force: true });

const source = process.env.FRONTEND_SOURCE;
if (source) {
  const manifest = JSON.parse(readFileSync(resolve(source, '.source-lock.json'), 'utf8'));
  if (manifest.ref !== ref) throw new Error('Frontend source revision mismatch');
  for (const [path, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(resolve(source, path));
    if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== expected) throw new Error(`Frontend checksum mismatch: ${path}`);
  }
  cpSync(resolve(source), checkout, { recursive: true });
} else {
console.log(`📥 Cloning frontend repository: ${repo} ${ref ? `(branch: ${ref})` : ''}`);
const cloneArgs = ['clone', '--depth', '1'];
if (ref && !/^[a-f0-9]{40}$/.test(ref)) cloneArgs.push('--branch', ref);
cloneArgs.push(repo, checkout);
run('git', cloneArgs);
if (/^[a-f0-9]{40}$/.test(ref)) {
  run('git', ['fetch', '--depth', '1', 'origin', ref], checkout);
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], checkout);
}
}
run('node', [resolve(root, 'scripts/patch-workers-frontend.mjs'), checkout]);

console.log('📦 Installing dependencies...');
run('npx', [...pnpmArgs, 'install', '--frozen-lockfile'], checkout);

console.log('🏗️ Building frontend with VITE_API_URL=/ ...');
// 【关键修复】在构建时注入环境变量 VITE_API_URL=/
// 这样前端会使用 window.location.origin 作为后端地址，适配 Cloudflare Workers 部署
execFileSync(
  'npx',
  [...pnpmArgs, 'build'],
  {
    cwd: checkout,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_API_URL: '/',
    },
  }
);

const dist = resolve(checkout, 'dist');
if (!existsSync(dist)) throw new Error('Official frontend build did not produce dist/');

console.log('📂 Copying build artifacts...');
mkdirSync(output, { recursive: true });
cpSync(dist, output, { recursive: true });

let sha = source ? ref : '';
try { 
  if (!source) sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
} catch {}

writeFileSync(resolve(output, '.upstream-frontend-sha'), `${sha}\n`);
console.log(`✅ Official frontend ${sha || 'default-branch'} synced to ${output}`);
console.log(`ℹ️  API URL configured as: / (will resolve to window.location.origin)`);
