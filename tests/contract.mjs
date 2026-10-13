import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const base = process.env.WORKER_TEST_URL || 'http://127.0.0.1:8787';
const suffix = crypto.randomUUID().slice(0, 8);
const name = `cf-contract-${suffix}`;
const collection = `${name}-collection`;
const file = `${name}-file`;
const created = [];
const publicBase = new URL(base).origin;
async function publicRequest(path, method = 'GET') {
  return fetch(`${publicBase}${path}`, { method, redirect: 'manual' });
}
const content = 'ss://YWVzLTEyOC1nY206cGFzcw==@example.com:443#Original\n' +
  'trojan://test-password@example.org:443?sni=example.org#Trojan';
const sub = { name, source: 'local', content, process: [] };
async function raw(path, method = 'GET', body) {
  return fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: new URL(base).origin }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function api(path, method = 'GET', body, expected = 200) {
  const response = await raw(path, method, body);
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 400)}`);
  const result = JSON.parse(text);
  assert.equal(result.status, 'success', text.slice(0, 400));
  return result.data;
}
let server;
try {
  assert.equal((await raw('/api/health')).status, 200);
  for (const path of ['/api/subs', '/api/storage', '/api/utils/env', '/download/UNTITLED', '/wrong-path/api/subs']) {
    const response = await publicRequest(path);
    assert.notEqual(response.status, 302, 'No external login gateway');
    assert.notEqual(response.headers.get('content-type')?.includes('application/json') && response.status, 200, 'No anonymous management data');
  }
  assert.equal((await publicRequest('/api/subs')).status, 404);
  for (const route of ['/api/subs', '/api/collections', '/api/files', '/api/artifacts', '/api/settings', '/api/logs']) await api(route);
  const env = await api('/api/utils/env');
  assert.equal(env.backend, 'CloudflareWorkers');
  assert.equal(env.feature.scripts, false);
  const crossOrigin = await fetch(`${base}/api/utils/env`, { headers: { Origin: 'https://unrelated.example' } });
  assert.equal(crossOrigin.status, 403, 'Only the integrated frontend origin bypasses the mobile runtime CORS allowlist');
  const preview = await api('/api/preview/sub', 'POST', sub);
  assert.equal(preview.original.length, 2);
  assert.equal(preview.processed[0].type, 'ss');
  await api('/api/subs', 'POST', sub, 201); created.push(`/api/sub/${name}`);
  assert.equal((await api(`/api/sub/${name}`)).content, content);
  const token = (await api('/api/token', 'POST', { payload: { type: 'sub', name } })).token;
  assert.match(token, /^[A-Za-z0-9_-]{21,}$/);
  const share = `/share/sub/${name}?token=${encodeURIComponent(token)}&target=ClashMeta`;
  const shared = await publicRequest(share);
  assert.equal(shared.status, 200, 'Share must work without cookies, admin path or login');
  assert.match(await shared.text(), /example.com/);
  assert.equal((await publicRequest(`/share/sub/${name}`)).status, 404);
  assert.equal((await publicRequest(`/share/sub/${name}?token=invalid`)).status, 404);
  assert.equal((await publicRequest(`/share/sub/${name}-other?token=${token}`)).status, 404);
  assert.equal((await publicRequest(`/share/col/${name}?token=${token}`)).status, 404);
  assert.equal((await publicRequest(share, 'POST')).status, 404);
  assert.equal((await publicRequest(`${share}&content=trojan%3A%2F%2Foverride`)).status, 400);
  await api(`/api/token/${token}?type=sub&name=${name}`, 'DELETE');
  assert.equal((await publicRequest(share)).status, 404, 'Revoked token must stop working');
  const counted = (await api('/api/token', 'POST', { payload: { type: 'sub', name }, options: { mode: 'count', count: 1 } })).token;
  const counts = await Promise.all([1, 2].map(() => publicRequest(`/share/sub/${name}?token=${counted}`)));
  assert.deepEqual(counts.map(r => r.status).sort(), [200, 404], 'One-use token cannot be raced');
  await api(`/api/token/${counted}?type=sub&name=${name}`, 'DELETE');
  const expired = (await api('/api/token', 'POST', { payload: { type: 'sub', name }, options: { mode: 'datetime', exp: Date.now() - 1000 } })).token;
  assert.equal((await publicRequest(`/share/sub/${name}?token=${expired}`)).status, 404, 'Expired token must be rejected');
  await api(`/api/token/${expired}?type=sub&name=${name}`, 'DELETE');
  await api(`/api/sub/${name}`, 'PATCH', { displayName: 'Edited', process: [{ type: 'Regex Rename Operator', args: [{ expr: 'Original', now: 'Renamed' }] }] });
  assert.equal((await api(`/api/sub/${name}`)).displayName, 'Edited');
  for (const target of ['JSON', 'ClashMeta', 'Clash', 'Loon', 'Surge', 'Shadowrocket']) {
    const response = await raw(`/download/${name}?target=${target}`);
    const text = await response.text();
    assert.equal(response.status, 200, `${target}: ${text.slice(0, 400)}`);
    assert.ok(text.includes('example.com'), target);
    assert.ok(text.includes('Renamed'), `${target} must apply the official rename processor`);
  }
  await api('/api/collections', 'POST', { name: collection, subscriptions: [name], process: [] }, 201);
  created.push(`/api/collection/${collection}`);
  const merged = await api('/api/preview/collection', 'POST', { name: collection, subscriptions: [name], process: [] });
  assert.equal(merged.processed.length, 2);
  assert.equal((await raw(`/download/collection/${collection}?target=ClashMeta`)).status, 200);
  const colToken = (await api('/api/token', 'POST', { payload: { type: 'col', name: collection } })).token;
  assert.equal((await publicRequest(`/share/col/${collection}?token=${colToken}&target=ClashMeta`)).status, 200);
  assert.equal((await publicRequest(`/share/sub/${name}?token=${colToken}`)).status, 404);
  await api('/api/files', 'POST', { name: file, source: 'local', content: 'test-file', process: [] }, 201);
  created.push(`/api/file/${file}`);
  assert.equal(await (await raw(`/api/file/${file}`)).text(), 'test-file');
  const fileToken = (await api('/api/token', 'POST', { payload: { type: 'file', name: file } })).token;
  const publicFile = await publicRequest(`/share/file/${file}?token=${fileToken}`);
  assert.equal(publicFile.status, 200);
  assert.equal(await publicFile.text(), 'test-file');
  assert.equal((await publicRequest(`/share/file/${file}?token=${fileToken}&sourceName=${name}`)).status, 400);
  const backup = await (await raw('/api/storage')).json();
  assert.ok(backup.subs.some(item => item.name === name));
  const scripted = await raw('/api/preview/sub', 'POST', { ...sub, process: [{ type: 'Script Operator', args: { mode: 'script', content: 'function operator(proxies) { return proxies; }' } }] });
  assert.equal(scripted.status, 500);
  assert.match(await scripted.text(), /unavailable on Cloudflare Workers/);
  const concurrent = Array.from({ length: 4 }, (_, i) => ({ ...sub, name: `${name}-${i}` }));
  await Promise.all(concurrent.map(async item => { await api('/api/subs', 'POST', item, 201); created.push(`/api/sub/${item.name}`); }));
  const saved = await api('/api/subs');
  assert.ok(concurrent.every(item => saved.some(row => row.name === item.name)), 'Concurrent writes must not lose subscriptions');
  if (base.startsWith('http://127.0.0.1:')) {
    const restoreSnapshot = await (await raw('/api/storage')).json();
    await api(`/api/sub/${name}`, 'PATCH', { displayName: 'Before restore' });
    await api('/api/storage', 'POST', { content: JSON.stringify(restoreSnapshot) });
    assert.equal((await api(`/api/sub/${name}`)).displayName, 'Edited', 'Official backup restore must round-trip data');
    server = createServer((_req, res) => { res.setHeader('subscription-userinfo', 'upload=1; download=2; total=1000'); res.end(content); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const remote = await api('/api/preview/sub', 'POST', { name, source: 'remote', url: `http://127.0.0.1:${server.address().port}/subscription`, process: [] });
    assert.equal(remote.processed.length, 2, 'Remote HTTP subscription must use the Workers fetch adapter');
  }
  console.log(`Official Sub-Store contracts passed: native access guard, anonymous scoped shares, expiration/revocation/count limits, CRUD, preview, processors, 6 exporters, collections, files, backup, concurrent persistence, script boundary${server ? ', remote HTTP' : ''}.`);
} finally {
  if (server) server.close();
  const tokens = await api('/api/tokens');
  for (const token of tokens.filter(item => [name, collection, file].includes(item.name))) {
    await api(`/api/token/${encodeURIComponent(token.token)}?type=${token.type}&name=${encodeURIComponent(token.name)}`, 'DELETE');
  }
  for (const path of created.reverse()) {
    const response = await raw(path, 'DELETE');
    assert.equal(response.status, 200, `Cleanup ${path}`);
  }
}
