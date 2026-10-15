import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const base = process.env.WORKER_TEST_URL || 'http://127.0.0.1:8787';
const backendHint = new URL(base).pathname.replace(/\/$/, '');
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
  assert.equal(env.feature.scripts, true);
  assert.equal(env.feature.artifactCron, true);
  assert.equal(env.feature.share, true, 'Official frontend must enable its Share UI');
  assert.equal(env.meta.workers.secretPath, new URL(base).pathname, 'Backend path must normalize to the frontend management prefix');
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
  assert.equal(scripted.status, 200);
  assert.equal((await scripted.json()).data.processed.length, 2);
  if (base.startsWith('http://127.0.0.1:')) {
    if (process.env.WORKER_TEST_NATIVE_PARITY === '1') {
      const { checkNativeScriptParity } = await import('./native-parity.mjs');
      await checkNativeScriptParity(body => api('/api/preview/sub', 'POST', body));
    }
    const script = (type, content, extra = {}) => ({ type, args: { mode: 'script', content, ...extra } });
    const scriptedPreview = async (process) => api('/api/preview/sub', 'POST', { ...sub, process });
    const asynchronous = await scriptedPreview([script('Script Operator', 'async function operator(nodes, target, context) { await Promise.resolve(); nodes[0].name = lodash.get($arguments, "prefix") + ":" + Buffer.from("你好").toString(); return lodash.orderBy(nodes, ["name"], ["asc"]); }', { arguments: { prefix: name } })]);
    assert.ok(asynchronous.processed.some(node => node.name === `${name}:你好`));
    const filtered = await scriptedPreview([script('Script Filter', 'function filter(nodes) { return nodes.map(node => node.type === "ss"); }')]);
    assert.equal(filtered.processed.length, 1);
    const helpers = await scriptedPreview([script('Script Operator', 'function operator(nodes) { nodes[0].name = [ProxyUtils.getFlag("香港 01"), ProxyUtils.getISO("香港 01"), ProxyUtils.removeFlag("🇭🇰 HK"), ProxyUtils.isIPv4("1.2.3.4"), ProxyUtils.isIP("::1"), ProxyUtils.JSON5.parse("{a:1}").a, ProxyUtils.hex_md5("a")].join("|"); return nodes; }')]);
    assert.ok(helpers.processed.some(node => node.name === '🇭🇰|HK|HK|true|true|1|0cc175b9c0f1b6a831c399e269772661'), JSON.stringify(helpers.processed.map(node => node.name)));
    const shortcut = await scriptedPreview([script('Script Operator', '$server.name = "Shortcut:" + $server.name;')]);
    assert.ok(shortcut.processed.every(node => node.name.startsWith('Shortcut:')));
    for (const content of ['function operator() { while(true) {} }', 'function operator() { throw new Error("expected failure"); }', 'function operator() { return 42; }', 'function operator() { return require("fs"); }', 'function operator() { return new Array(10000000).fill("allocation"); }']) {
      const response = await raw('/api/preview/sub', 'POST', { ...sub, process: [script('Script Operator', content)] });
      assert.equal(response.status, 500, content);
    }
    const healthy = await scriptedPreview([script('Script Operator', 'function operator(nodes) { if(globalThis.previous) throw new Error("state leaked"); globalThis.previous = true; return nodes; }')]);
    assert.equal(healthy.processed.length, 2);
    await scriptedPreview([script('Script Operator', 'function operator(nodes) { if(globalThis.previous) throw new Error("state leaked"); return nodes; }')]);
    const processedFile = await api('/api/preview/file', 'POST', { name: file, source: 'local', content: 'hello', process: [script('Script Operator', '$content = $content.toUpperCase();')] });
    assert.equal(processedFile.processed, 'HELLO');
    // mihomo config 覆写: YAML deep-merge patch and JavaScript main(config), as in the official file editor.
    const mihomo = (process, extra = {}) => ({ name: `${file}-mihomo`, type: 'mihomoConfig', sourceType: 'local', source: 'local', content: 'mixed-port: 7890\nproxies: []\nrules:\n  - MATCH,DIRECT\n', process, ...extra });
    const yamlPatched = await api('/api/preview/file', 'POST', mihomo([script('Script Operator', 'mixed-port: 7891\ndns:\n  enable: true\n')]));
    assert.match(yamlPatched.processed, /mixed-port: 7891/);
    assert.match(yamlPatched.processed, /dns:\n  enable: true/);
    const overrideScript = `async function main(config) { await Promise.resolve(); const names = config.proxies.map(p => p.name); config['proxy-groups'] = [{ name: 'Proxy', type: 'select', proxies: names }]; config.rules = ['DOMAIN,' + $arguments.domain + ',Proxy', 'MATCH,DIRECT']; return config; }`;
    const fromSub = mihomo([script('Script Operator', overrideScript, { arguments: { domain: 'example.net' } })], { sourceType: 'subscription', sourceName: name });
    await api('/api/files', 'POST', fromSub, 201);
    created.push(`/api/file/${fromSub.name}`);
    const overridden = await (await raw(`/api/file/${fromSub.name}`)).text();
    assert.match(overridden, /proxy-groups:\n  - name: Proxy\n    type: select\n    proxies:\n      - Renamed/);
    assert.match(overridden, /rules:\n  - DOMAIN,example\.net,Proxy\n  - MATCH,DIRECT/);
    // Official wrappers inline the script twice; a 150 KiB override must still run.
    const largeOverride = await api('/api/preview/file', 'POST', mihomo([script('Script Operator', `function main(config) { config.large = true; return config; }\n//${'x'.repeat(150 * 1024)}`)]));
    assert.match(largeOverride.processed, /large: true/);
    // One-line JavaScript containing ": " is also valid YAML; it must still run as a JavaScript override.
    const oneLine = await api('/api/preview/file', 'POST', mihomo([script('Script Operator', 'function main(config) { config.tun = { enable: true }; return config }')]));
    assert.match(oneLine.processed, /tun:\n  enable: true/);
    assert.doesNotMatch(oneLine.processed, /function main/);
    // The editor's own examples: ProxyUtils.yaml.load/dump with produceArtifact, plus Node-like globals.
    const editorExample = await api('/api/preview/file', 'POST', mihomo([script('Script Operator', `const y = ProxyUtils.yaml.load($content); y.proxies.unshift(...await produceArtifact({ type: 'subscription', name: '${name}', platform: 'ClashMeta', produceType: 'internal' })); $content = ProxyUtils.yaml.dump(y)`)]));
    assert.match(editorExample.processed, /name: Renamed/);
    // Top-level file scripts that catch the function-form ReferenceError still fall back to the shortcut form, as upstream.
    const caught = await api('/api/preview/file', 'POST', { name: file, source: 'local', content: '{"a":1}', process: [script('Script Operator', 'let parsed; try { parsed = ProxyUtils.JSON5.parse($content ?? $files[0]); } catch (e) { throw new Error("not JSON5"); } parsed.b = 2; $content = JSON.stringify(parsed);')] });
    assert.equal(caught.processed, '{"a":1,"b":2}');
    const globals = await api('/api/preview/file', 'POST', mihomo([script('Script Operator', 'async function main(c) { await new Promise(r => setTimeout(r, 1)); const u = new URL("https://a.com/p?q=1"); u.searchParams.set("q", "2"); c.g = [structuredClone({ a: atob(btoa("ok")) }).a, u.href, new TextDecoder().decode(new TextEncoder().encode("你好"))].join(" "); return c }')]));
    assert.match(globals.processed, /g: ok https:\/\/a\.com\/p\?q=2 你好/);
    // $options exists on download (not preview), as upstream; response headers set by the override reach the client.
    const headerFile = mihomo([script('Script Operator', 'function main(config) {\n  if ($options) $options._res = { headers: { "profile-update-interval": 24 } }\n  return config\n}')], { name: `${file}-mihomo-headers` });
    await api('/api/files', 'POST', headerFile, 201);
    created.push(`/api/file/${headerFile.name}`);
    assert.equal((await raw(`/api/file/${headerFile.name}`)).headers.get('profile-update-interval'), '24');
    await api(`/api/sub/${name}`, 'PATCH', { process: [script('Response Transformer', '$res.body += "\\n# transformed"; $res.headers["x-script"] = "yes";')] });
    const transformed = await raw(`/download/${name}?target=ClashMeta`);
    assert.equal(transformed.headers.get('x-script'), 'yes');
    assert.match(await transformed.text(), /# transformed$/);
    await api(`/api/sub/${name}`, 'PATCH', { process: [] });
    const settings = await api('/api/settings');
    await api('/api/settings', 'PATCH', { logsMaxCount: 50 });
    await scriptedPreview([script('Script Operator', 'function operator(nodes) { $substore.info("password=private-value https://example.com/?token=private-token"); return nodes; }')]);
    const logs = await api('/api/logs');
    assert.ok(logs.logs.length > 0);
    assert.ok(!JSON.stringify(logs).includes('private-value'));
    assert.ok(!JSON.stringify(logs).includes('private-token'));
    // The backend path is redacted as a path segment only, so short paths such as "sub" keep logs readable.
    await scriptedPreview([script('Script Operator', `function operator(nodes) { $substore.info("subscription marker ${backendHint}/api"); return nodes; }`)]);
    const pathLog = (await api('/api/logs')).logs.map(entry => entry.message).find(message => message.includes('subscription marker'));
    assert.match(pathLog, /subscription marker \/\[redacted\]\/api/);
    await api('/api/settings', 'PATCH', { logsMaxCount: settings.logsMaxCount ?? 0 });
    const artifact = `${name}-artifact`;
    await api('/api/artifacts', 'POST', { name: artifact, type: 'subscription', source: name, platform: 'ClashMeta', sync: true, upload: false, cron: '*/5 * * * *' }, 201);
    created.push(`/api/artifact/${artifact}`);
    const tasks = await api('/api/workers/tasks');
    assert.equal(tasks.timezone, 'UTC');
    assert.ok(tasks.tasks.some(task => task.name === artifact));
    const invalidCron = await raw(`/api/artifact/${artifact}`, 'PATCH', { cron: '* * * * *' });
    assert.equal(invalidCron.status, 400);
    assert.equal((await api(`/api/artifact/${artifact}`)).cron, '*/5 * * * *');
    const synced = await api(`/api/sync/artifact/${artifact}`);
    assert.ok(synced.updated > 0);
    const largeFile = `${file}-large`;
    const largeContent = '😀'.repeat(520000);
    await api('/api/files', 'POST', { name: largeFile, source: 'local', content: largeContent, process: [] }, 201);
    created.push(`/api/file/${largeFile}`);
    assert.equal(await (await raw(`/api/file/${largeFile}`)).text(), largeContent);
    const tooLargeBackup = await (await raw('/api/storage')).json();
    tooLargeBackup.files.push({ name: `${file}-oversize`, source: 'local', content: 'x'.repeat(3 * 1024 * 1024), process: [] });
    assert.equal((await raw('/api/storage', 'POST', { content: JSON.stringify(tooLargeBackup) })).status, 413);
    assert.equal(await (await raw(`/api/file/${largeFile}`)).text(), largeContent, 'Rejected restore must preserve existing large data');
    for (const size of [100, 1000, 5000]) {
      const nodes = Array.from({ length: size }, (_, i) => `ss://YWVzLTEyOC1nY206cGFzcw==@example.com:443#Node-${i}`).join('\n');
      const start = performance.now();
      const result = await api('/api/preview/sub', 'POST', { ...sub, content: nodes, process: [script('Script Operator', 'function operator(nodes) { return nodes.map(node => ({ ...node, name: "Processed:" + node.name })); }')] });
      assert.equal(result.processed.length, size);
      assert.ok(result.processed.every(node => node.name.startsWith('Processed:')));
      console.log(`Local preview + script: ${size} nodes, ${Math.round(performance.now() - start)} ms wall time (not CPU quota proof).`);
    }
  }
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
    // Proxy/policy routing is unavailable on Workers and must fail explicitly instead of silently going direct.
    const remoteUrl = `http://127.0.0.1:${server.address().port}/subscription#noCache`;
    assert.equal((await raw('/api/preview/sub', 'POST', { name, source: 'remote', url: remoteUrl, proxy: 'MyPolicy', process: [] })).status, 500);
    assert.equal((await api('/api/preview/sub', 'POST', { name, source: 'remote', url: remoteUrl, proxy: 'DIRECT', process: [] })).processed.length, 2);
    for (const routing of ["opts: { policy: 'MyPolicy' }", "node: 'MyPolicy'", "'policy-descriptor': 'MyPolicy'", "proxy: 'http://127.0.0.1:7890'"]) {
      const routed = await raw('/api/preview/sub', 'POST', { ...sub, process: [{ type: 'Script Operator', args: { mode: 'script', content: `async function operator(nodes) { await $substore.http.get({ url: '${remoteUrl}', ${routing} }); return nodes; }` } }] });
      assert.equal(routed.status, 500, routing);
      assert.match(await routed.text(), /routing is unavailable on Cloudflare Workers/, routing);
    }
  }
  console.log(`Official Sub-Store contracts passed: access and shares, CRUD, exporters, script sandbox and limits, files, logs, schedules, large Unicode persistence, backup and concurrent writes${server ? ', remote HTTP' : ''}.`);
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
