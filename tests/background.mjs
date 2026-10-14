import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, Response, convertV4MiniflareOptions } from '../worker/node_modules/miniflare/dist/src/index.js';

const bundle = resolve(import.meta.dirname, '../worker/.wrangler/acceptance');
const persistence = mkdtempSync(resolve(tmpdir(), 'substore-background-'));
const modules = [
  { type: 'ESModule', path: resolve(bundle, 'harness.js'), contents: `
    import worker, { SubscriptionStore } from './index.js';
    export default worker;
    export class TestStore extends SubscriptionStore {
      testSQL(sql, ...parameters) { return this.ctx.storage.sql.exec(sql, ...parameters).toArray(); }
      async testWake() { await this.ctx.storage.setAlarm(Date.now() + 1); }
    }
  ` },
  { type: 'ESModule', path: resolve(bundle, 'index.js'), contents: readFileSync(resolve(bundle, 'index.js'), 'utf8') },
  ...readdirSync(bundle).filter(path => /\.(wasm|txt)$/.test(path)).map(path => ({ type: path.endsWith('.wasm') ? 'CompiledWasm' : 'Text', path: resolve(bundle, path), contents: path.endsWith('.wasm') ? readFileSync(resolve(bundle, path)) : readFileSync(resolve(bundle, path), 'utf8') })),
];
let uploads = [], notifications = 0, failNotification = true;
const options = {
  modules, modulesRoot: bundle, compatibilityDate: '2026-08-17', compatibilityFlags: ['nodejs_compat'],
  bindings: { SUB_STORE_FRONTEND_BACKEND_PATH: 'sub', SUB_STORE_PUSH_SERVICE: 'https://notify.test/webhook' },
  durableObjects: { SUBSTORE: { className: 'TestStore', useSQLite: true, unsafeUniqueKey: 'substore-acceptance' } }, resourcePersistencePath: persistence,
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'notify.test') { notifications++; return new Response('', { status: failNotification ? 503 : 200 }); }
    if (url.hostname === 'api.github.com') {
      const gist = { id: 'fixture', description: 'Sub-Store Artifacts Repository', html_url: 'https://gist.github.com/fixture', files: { 'upload.json': { filename: 'upload.json', raw_url: 'https://gist.test/raw/upload.json' } } };
      if (request.method === 'PATCH' || request.method === 'POST') uploads.push(JSON.parse(await request.text()));
      return Response.json(request.method === 'GET' && url.pathname === '/gists' ? [gist] : gist);
    }
    if (url.hostname === 'source.test') return new Response(url.pathname === '/script' ? 'function operator(nodes) { nodes[0].name = "remote-script"; return nodes; }' : 'remote-value');
    throw new Error(`Unexpected outbound request ${url.hostname}`);
  },
};
let mf = new Miniflare(convertV4MiniflareOptions(options));
const api = async (path, method = 'GET', body) => {
  const response = await mf.dispatchFetch(`https://worker.test/sub${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
  return (await response.json()).data;
};
const store = async () => (await mf.getDurableObjectNamespace('SUBSTORE')).getByName('official-v3');
const wake = async predicate => {
  await (await store()).testWake();
  for (let i = 0; i < 60; i++) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    if (predicate(await api('/api/workers/tasks'))) return;
  }
  throw new Error('Automatic Alarm did not complete');
};
try {
  const content = 'ss://YWVzLTEyOC1nY206cGFzcw==@example.com:443#Fixture';
  await api('/api/subs', 'POST', { name: 'fixture', source: 'local', content, process: [] });
  await api('/api/artifacts', 'POST', { name: 'upload.json', source: 'fixture', type: 'subscription', platform: 'JSON', upload: true, sync: true, cron: '*/5 * * * *' });
  await api('/api/settings', 'PATCH', { gistToken: 'fixture-token', logsMaxCount: 50 });
  await api('/api/sync/artifact/upload.json');
  assert.ok(uploads.some(upload => upload.files?.['upload.json']?.content.includes('example.com')), 'Actual HTTP sync must carry converted content');
  await (await store()).testSQL("UPDATE tasks SET next_run=0 WHERE name='upload.json'");
  await wake(data => data.tasks[0]?.status === 'success');
  const tasks = await api('/api/workers/tasks');
  assert.equal(tasks.tasks[0].status, 'success');
  assert.ok(tasks.tasks[0].next_run > Date.now());
  // Guest async host calls use the real HTTP adapter, and queued notifications are delivered by Alarm.
  const preview = await api('/api/preview/sub', 'POST', { name: 'fixture', source: 'local', content, process: [{ type: 'Script Operator', args: { mode: 'script', content: 'async function operator(nodes) { const response = await $substore.http.get("https://source.test/value"); nodes[0].name = response.body; $substore.notify("title", "", "notice"); return nodes; }' } }] });
  assert.equal(preview.processed[0].name, 'remote-value');
  const remoteScript = await api('/api/preview/sub', 'POST', { name: 'fixture', source: 'local', content, process: [{ type: 'Script Operator', args: { mode: 'link', content: 'https://source.test/script' } }] });
  assert.equal(remoteScript.processed[0].name, 'remote-script');
  await (await store()).testSQL("UPDATE notifications SET next_run=0 WHERE status='pending'");
  await wake(data => data.notifications[0]?.attempts === 1);
  assert.equal((await api('/api/workers/tasks')).notifications[0].attempts, 1);
  failNotification = false;
  await (await store()).testSQL("UPDATE notifications SET next_run=0 WHERE status='pending'");
  await wake(data => data.notifications[0]?.status === 'sent');
  assert.equal((await api('/api/workers/tasks')).notifications[0].status, 'sent');
  assert.equal(notifications, 2);
  const large = '😀'.repeat(520000);
  await api('/api/files', 'POST', { name: 'large', source: 'local', content: large, process: [] });
  const legacy = await (await store()).testSQL("SELECT value FROM preferences WHERE key='sub-store'");
  assert.throws(() => JSON.parse(legacy[0].value), 'Old adapters must fail closed for chunked data');
  assert.ok((await (await store()).testSQL("SELECT COUNT(*) AS count FROM preference_chunks WHERE key='sub-store'"))[0].count > 1);
  assert.equal((await api('/api/workers/tasks')).tasks.length, 1, 'Task exists before restart');
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions(options));
  const file = await mf.dispatchFetch('https://worker.test/sub/api/file/large');
  assert.equal(await file.text(), large, 'Chunked Unicode data survives restart');
  assert.ok((await api('/api/workers/tasks')).tasks[0]?.next_run > Date.now(), 'Task schedule survives restart');
  await api('/api/artifact/upload.json', 'DELETE');
  assert.equal((await api('/api/workers/tasks')).tasks.length, 0);
  console.log('Background acceptance passed: actual mocked HTTP upload, Alarm sync, guest async HTTP, notification retry, restart, chunks and task removal.');
} finally { await mf.dispose(); rmSync(persistence, { recursive: true, force: true }); }
