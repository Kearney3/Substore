import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const ref = 'a3e61061e50b40e5c5938969aab915d05d8d7069';
const checkout = process.env.SUBSTORE_SOURCE || resolve(root, '.upstream-backend');
function run(cmd, args, cwd = root) { execFileSync(cmd, args, { cwd, stdio: 'inherit' }); }
if (!existsSync(checkout)) {
  run('git', ['clone', 'https://github.com/sub-store-org/Sub-Store.git', checkout]);
  run('git', ['checkout', '--detach', ref], checkout);
}
let sha;
if (existsSync(resolve(checkout, '.source-lock.json'))) {
  const manifest = JSON.parse(readFileSync(resolve(checkout, '.source-lock.json'), 'utf8'));
  for (const [path, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(resolve(checkout, path));
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`Source checksum mismatch: ${path}`);
  }
  sha = manifest.ref;
} else sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
if (sha !== ref) throw new Error(`Expected official Sub-Store ${ref}, got ${sha}`);
const backend = resolve(checkout, 'backend');
if (!existsSync(resolve(backend, 'node_modules'))) {
  cpSync(resolve(root, 'scripts/official-backend-lock.json'), resolve(backend, 'package-lock.json'));
  run('npm', ['ci', '--ignore-scripts', '--legacy-peer-deps'], backend);
}
const { build } = createRequire(resolve(backend, 'package.json'))('esbuild');
const result = await build({
  absWorkingDir: backend,
  entryPoints: ['src/main.js'],
  bundle: true, minify: true, platform: 'browser', format: 'iife', write: false,
  logOverride: { 'direct-eval': 'silent' },
  plugins: [{ name: 'workers-runtime', setup(build) {
    build.onLoad({ filter: /proxy-utils\/processors\/index\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const start = source.indexOf('function createDynamicFunction(name, script, $arguments, $options) {');
      if (start < 0 || !source.slice(start).includes('new Function(')) throw new Error('Review official script execution entrypoint');
      // The upstream shortcut fallback can turn a failed full-function script into a no-op.
      // Retry only missing shortcut variables/entrypoints; never swallow an execution limit or user exception.
      const prefix = source.slice(0, start).replace(/((?:const|let) funcErrMsg = `\$\{err.message \?\? err\}`;)/g, '$1\n        if (!/(?:operator|filter|transformFunction|\\$server|\\$content|\\$files|\\$res) is not defined/.test(funcErrMsg)) throw err;');
      if ((prefix.match(/throw err;/g) || []).length !== 3) throw new Error('Review official script fallback paths');
      return { contents: prefix + `function createDynamicFunction(name, script, $arguments, $options) {
        return (...input) => runtime.executeScript({ name, script, input, globals: {
          $arguments, $options, $substore: $, lodash,
          ProxyUtils, yaml: ProxyUtils.yaml, b64d: ProxyUtils.Base64.decode, b64e: ProxyUtils.Base64.encode,
          DOMAIN_RESOLVERS, scriptResourceCache,
          flowUtils: { getFlowField, getFlowHeaders, parseFlowHeaders, flowTransfer, validCheck, getRmainingDays, normalizeFlowHeader },
          produceArtifact,
        }});
      }`, loader: 'js' };
    });
    build.onLoad({ filter: /utils\/artifact-cron\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const before = 'if (!cron || !$.env.isNode) return;';
      if (!source.includes(before)) throw new Error('Review official cron validation');
      return { contents: source.replace(before, 'if (!cron) return;\n    if (!$.env.isNode) { try { runtime.validateCron(cron); return; } catch (e) { throw new RequestInvalidError("INVALID_ARTIFACT_CRON", "Invalid or excessive artifact schedule", e.message); } }'), loader: 'js' };
    });
    build.onLoad({ filter: /restful\/artifacts\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('failed(res, error);')) throw new Error('Review artifact validation response');
      return { contents: source.replaceAll('failed(res, error);', 'failed(res, error, error.code === "INVALID_ARTIFACT_CRON" ? 400 : undefined);'), loader: 'js' };
    });
    build.onLoad({ filter: /utils\/debug-logs\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const before = 'const message = formatLogArguments(args);';
      if (!source.includes(before)) throw new Error('Review official log capture');
      return { contents: source.replace(before, 'const message = runtime.redact(formatLogArguments(args));').replace('const MAX_LOGS_MAX_COUNT = 10000;', 'const MAX_LOGS_MAX_COUNT = 500;'), loader: 'js' };
    });
    build.onLoad({ filter: /vendor\/express\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      // The mobile router lacks the Node frontend's share authentication middleware.
      const guarded = source.replace('import { ENV }', "import { consumeShareToken } from '@/restful/token';\nimport { ENV }")
        .replace('// pattern match', `let shareToken;
        if (path.startsWith('/share/')) {
            const parts = path.split('/');
            shareToken = method === 'GET' && query.token && consumeShareToken({ token: query.token, type: decodeURIComponent(parts[2]), name: decodeURIComponent(parts[3]), pathname: decodeURIComponent(path) });
            if (!shareToken) { Response(cors.headers).status(404).end(); return; }
        }
        // pattern match`)
        .replace('const req = {', 'const req = { subStoreShareToken: shareToken,');
      if (guarded === source || !guarded.includes('subStoreShareToken: shareToken')) throw new Error('Review official share router changes');
      return { contents: guarded.replace("if (/json/i.test(headers['content-type']))", "if (body && /json/i.test(headers['content-type']))").replace('status: isQX ? STATUS_CODE_MAP[statusCode] : statusCode,', 'status: statusCode,'), loader: 'js' };
    });
    build.onLoad({ filter: /restful\/token\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const start = source.indexOf('    if (!ENV().isNode) {', source.indexOf('async function signToken'));
      const end = source.indexOf('    try {', start);
      if (start < 0 || end < 0 || !source.includes('const nanoid = eval(`require("nanoid")`);')) throw new Error('Review official token creation changes');
      // Reuse official validation, expiration and count rules with Web Crypto token generation.
      return { contents: "import { customAlphabet, urlAlphabet } from 'nanoid';\n" + (source.slice(0, start) + source.slice(end)).replace('const nanoid = eval(`require("nanoid")`);', 'const nanoid = { customAlphabet, urlAlphabet };'), loader: 'js' };
    });
    build.onLoad({ filter: /runtime\/(fs|path|net|tls|dgram|worker-threads|stream-promises|child-process)\.js$/ }, () => ({
      contents: 'export default function unavailableNodeBuiltin() { return undefined; }', loader: 'js',
    }));
    build.onLoad({ filter: /vendor\/open-api\.js$/ }, ({ path }) => {
      const original = readFileSync(path, 'utf8');
      const source = original.replace('eval(`typeof process !== "undefined"`)', 'false');
      if (source === original) throw new Error('Official runtime detection changed; review the Workers adapter');
      const notificationEntry = "notify(title, subtitle = '', content = '', options = {}) {";
      if (!source.includes(notificationEntry)) throw new Error('Review official notification entrypoint');
      return { contents: source.replace(notificationEntry, notificationEntry + '\n        $notify(title, subtitle, content, options); return;'), loader: 'js' };
    });
    build.onLoad({ filter: /utils\/env\.js$/ }, ({ path }) => ({
      contents: readFileSync(path, 'utf8').replace("backend = 'QX'", "backend = 'CloudflareWorkers'"), loader: 'js',
    }));
  } }],
});
const output = resolve(root, 'worker/src/official');
mkdirSync(output, { recursive: true });
const version = JSON.parse(readFileSync(resolve(backend, 'package.json'))).version;
const { transformSync, types: t } = createRequire(resolve(backend, 'package.json'))('@babel/core');
const transformed = transformSync(result.outputFiles[0].text, { configFile: false, babelrc: false, compact: true, comments: false, plugins: [() => ({ visitor: {
  CallExpression(path) { if (t.isIdentifier(path.node.callee, { name: 'eval' })) path.node.callee = t.identifier('workersUnsupportedScript'); },
  NewExpression(path) { if (t.isIdentifier(path.node.callee, { name: 'Function' })) path.replaceWith(t.callExpression(t.identifier('workersUnsupportedScript'), path.node.arguments)); },
} })] }).code;
writeFileSync(resolve(output, 'runtime.js'), `// Official Sub-Store ${version} @ ${sha}; AGPL-3.0, see LICENSE.\n// Generated by scripts/build-official-backend.mjs. Each call has its own runtime and module state.\nexport function runOfficial(runtime) {\nconst { $task, $prefs, $request, $done, $notify, console } = runtime;\nfunction workersUnsupportedScript() { throw new Error('Node-only dynamic operations are unavailable on Cloudflare Workers.'); }\n${transformed}\n}\n`);
cpSync(resolve(checkout, 'LICENSE'), resolve(output, 'LICENSE'));
cpSync(resolve(backend, 'node_modules/lodash/lodash.min.js'), resolve(output, 'lodash.txt'));
console.log(`Bundled official Sub-Store ${version} (${result.outputFiles[0].contents.length} bytes)`);
