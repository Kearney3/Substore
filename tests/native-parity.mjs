import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Execute the pinned official cross-platform backend with native JavaScript on Node.
// Only runtime detection and unavailable Node modules are adapted; script handling is unmodified.
export async function checkNativeScriptParity(workerRequest) {
  const source = resolve(import.meta.dirname, '../.upstream-backend/backend');
  const { build } = createRequire(resolve(source, 'package.json'))('esbuild');
  const result = await build({ absWorkingDir: source, entryPoints: ['src/main.js'], bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent', plugins: [{ name: 'native-parity', setup(builder) {
    builder.onLoad({ filter: /vendor\/open-api\.js$/ }, ({ path }) => ({ contents: readFileSync(path, 'utf8').replace('eval(`typeof process !== "undefined"`)', 'false'), loader: 'js' }));
    builder.onLoad({ filter: /runtime\/(fs|path|net|tls|dgram|worker-threads|stream-promises|child-process)\.js$/ }, () => ({ contents: 'export default function() { return undefined; }', loader: 'js' }));
  } }] });
  const run = new Function('$task', '$prefs', '$request', '$done', '$notify', 'console', result.outputFiles[0].text);
  const content = 'ss://YWVzLTEyOC1nY206cGFzcw==@example.com:443#Original\ntrojan://password@example.org:443#Trojan';
  const cases = [
    ['Script Operator', 'async function operator(nodes) { await Promise.resolve(); return lodash.orderBy(nodes.map(node => ({...node, name: $arguments.prefix + node.name})), ["name"], ["desc"]); }'],
    ['Script Filter', 'function filter(nodes) { return nodes.map(node => node.type === "ss"); }'],
    ['Script Operator', '$server.name = b64d(b64e($server.name)) + Buffer.from("你好").toString();'],
    ['Script Operator', 'function operator(nodes, platform, context) { nodes[0].name = Object.keys(context.source)[0]; return nodes; }'],
    ['Script Operator', 'function operator(nodes, platform, context) { context.process = { type: "disable", customNames: ["rename"] }; return nodes; }'],
    ['Script Operator', 'function operator(nodes, platform) { if (platform === undefined && $options === undefined) nodes[0].name = "undefined-preserved"; return nodes; }'],
  ];
  for (const [type, script] of cases) {
    const body = { name: 'native-parity', source: 'local', content, process: [{ type, args: { mode: 'script', content: script, arguments: { prefix: 'Test:' } } }, { type: 'Regex Rename Operator', customName: 'rename', args: [{ expr: 'Original', now: 'Changed' }] }] };
    const values = new Map();
    const official = await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native parity timed out')), 5000);
      run({ fetch() { throw new Error('Unexpected network access'); } }, {
        valueForKey: key => values.get(key) ?? null,
        setValueForKey: (value, key) => { values.set(key, value); return true; },
        removeValueForKey: key => { values.delete(key); return true; },
      }, { url: 'https://native.test/api/preview/sub', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, response => { clearTimeout(timeout); resolvePromise(JSON.parse(response.body)); }, () => {}, { log() {}, info() {}, warn() {}, error() {}, debug() {} });
    });
    assert.equal(official.status, 'success', JSON.stringify(official));
    const worker = await workerRequest(body);
    assert.deepEqual(worker, official.data, `Pinned official native script parity: ${type}`);
  }
  console.log('Pinned official native JavaScript parity passed for async operator, filter, shortcut, encoding and source context.');
}
