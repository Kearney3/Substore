import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSHandle } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import wasmModule from '../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm';
import lodashSource from './official/lodash.txt';
import { Buffer } from 'node:buffer';

export interface ScriptCall { name: string; script: string; input: unknown[]; globals: Record<string, any>; }
// Only the immutable WASM module is reused; runtimes, globals and handles belong to one call.
let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;

export async function executeScript(call: ScriptCall, requestSignal: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(3000)]);
  if (!['operator', 'filter', 'transformFunction'].includes(call.name)) throw new Error('Unsupported script entrypoint');
  // Official shortcut/override wrappers inline the user script twice; 512 KiB evaluated source keeps 256 KiB user scripts working.
  if (new TextEncoder().encode(call.script).length > 512 * 1024) throw new Error('Script exceeds 256 KiB');
  signal.throwIfAborted();
  const module = await (modulePromise ??= newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule })));
  const vm = module.newContext();
  vm.runtime.setMemoryLimit(16 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  let interrupts = 0;
  // Workers clocks do not advance during synchronous computation. Count interrupts as well as checking time.
  const deadline = Date.now() + 3000;
  vm.runtime.setInterruptHandler(() => signal.aborted || ++interrupts > 2000 || Date.now() > deadline);
  const pending = new Set<Promise<void>>();
  const deferreds = new Set<ReturnType<typeof vm.newPromise>>();
  let hostCalls = 0;
  const json = (value: unknown): QuickJSHandle => {
    if (value === undefined) return vm.undefined.dup();
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length > 4 * 1024 * 1024) throw new Error('Script bridge value exceeds 4 MiB');
    return vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(encoded)})`));
  };
  const hostFunction = (name: string, fn: (...args: any[]) => any, receiver?: unknown): QuickJSHandle => vm.newFunction(name, (...handles) => {
    signal.throwIfAborted();
    if (++hostCalls > 1000) throw new Error('Script host call limit exceeded');
    if (handles.some(h => vm.typeof(h) === 'function')) throw new Error('Host callbacks are unsupported; use guest lodash or native array methods');
    const result = fn.apply(receiver, handles.map(h => vm.dump(h)));
    if (!result || typeof result.then !== 'function') return json(result);
    const deferred = vm.newPromise();
    deferreds.add(deferred);
    const task: Promise<void> = Promise.resolve(result).then(value => {
      if (vm.alive && !signal.aborted) { const h = json(value); deferred.resolve(h); h.dispose(); }
    }, () => {
      if (vm.alive && !signal.aborted) { const h = vm.newError('Script HTTP or async host operation failed'); deferred.reject(h); h.dispose(); }
    }).catch(() => {
      if (vm.alive && !signal.aborted) { const h = vm.newError('Invalid host result'); deferred.reject(h); h.dispose(); }
    }).finally(() => { if (deferred.alive) deferred.dispose(); deferreds.delete(deferred); pending.delete(task); });
    pending.add(task);
    return deferred.handle.dup();
  });
  const object = (value: any, keys = Object.keys(value || {})): QuickJSHandle => {
    const result = vm.newObject();
    try {
      for (const key of keys) {
        const entry = value?.[key];
        const handle = typeof entry === 'function' ? hostFunction(key, entry, value) : json(entry);
        vm.setProp(result, key, handle); handle.dispose();
      }
      return result;
    } catch (error) { result.dispose(); throw error; }
  };
  const put = (key: string, value: QuickJSHandle) => { vm.setProp(vm.global, key, value); value.dispose(); };
  let resultHandle: QuickJSHandle | undefined;
  let abortListener: (() => void) | undefined;
  try {
    put('$arguments', json(call.globals.$arguments));
    put('$options', json(call.globals.$options));
    const inputHandle = json(call.input);
    call.input.forEach((value, index) => { if (value === undefined) vm.setProp(inputHandle, index, vm.undefined); });
    put('__input', inputHandle);
    put('console', object(call.globals.$substore, ['log', 'info', 'warn', 'error']));
    const substore = object(call.globals.$substore, ['read', 'write', 'delete', 'notify', 'log', 'info', 'warn', 'error', 'env']);
    const http = object(call.globals.$substore.http, ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
    vm.setProp(substore, 'http', http); http.dispose(); put('$substore', substore);
    const proxyUtils = object(call.globals.ProxyUtils, ['parse', 'produce', 'getFlag', 'removeFlag', 'getISO', 'isIPv4', 'isIPv6', 'isIP', 'isValidUUID', 'getRandomPort', 'hex_md5', 'download', 'doh']);
    const json5 = object(call.globals.ProxyUtils.JSON5, ['parse', 'stringify']);
    vm.setProp(proxyUtils, 'JSON5', json5); json5.dispose();
    const yaml = object(call.globals.yaml, ['safeLoad', 'safeDump']);
    vm.setProp(proxyUtils, 'yaml', yaml); vm.setProp(vm.global, 'yaml', yaml); yaml.dispose();
    const base64 = object(call.globals.ProxyUtils.Base64, ['encode', 'decode']);
    vm.setProp(proxyUtils, 'Base64', base64); base64.dispose(); put('ProxyUtils', proxyUtils);
    for (const key of ['b64d', 'b64e', 'produceArtifact']) put(key, hostFunction(key, call.globals[key]));
    for (const key of ['flowUtils', 'DOMAIN_RESOLVERS']) put(key, object(call.globals[key]));
    put('scriptResourceCache', object(call.globals.scriptResourceCache, ['get', 'set', 'remove']));
    put('__bufferFrom', hostFunction('bufferFrom', (value, encoding) => Array.from(Buffer.from(value, encoding))));
    put('__bufferString', hostFunction('bufferString', (value, encoding) => Buffer.from(value).toString(encoding)));
    vm.unwrapResult(vm.evalCode(`
      class Buffer extends Uint8Array {
        static from(value, encoding) { return new Buffer(__bufferFrom(value, encoding)); }
        static isBuffer(value) { return value instanceof Buffer; }
        toString(encoding) { return __bufferString(Array.from(this), encoding); }
      }
      globalThis.Buffer = Buffer;
      ProxyUtils.Buffer = Buffer;
      ${lodashSource}
      globalThis.lodash = globalThis._;
    `)).dispose();
    if (call.name === 'transformFunction') vm.unwrapResult(vm.evalCode(`
      let responseHeaders = __input[0].headers || __input[0].header || {};
      for (const key of ['headers', 'header']) Object.defineProperty(__input[0], key, {
        enumerable: true, configurable: true,
        get() { return responseHeaders; }, set(value) { responseHeaders = value || {}; }
      });
    `)).dispose();
    resultHandle = vm.unwrapResult(vm.evalCode(`(async () => { ${call.script}\n; const value = await ${call.name}(...__input); return { value, input: __input, options: $options, undefinedHeaders: Object.keys($options?._res?.headers || {}).filter(key => $options._res.headers[key] === undefined) }; })()`, 'substore-script.js'));
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error('Script execution cancelled'));
      signal.addEventListener('abort', abortListener, { once: true });
    });
    for (;;) {
      signal.throwIfAborted();
      if (Date.now() > deadline) throw new Error('Script execution exceeded 3 seconds');
      const jobs = vm.runtime.executePendingJobs(100);
      vm.unwrapResult(jobs);
      const state = vm.getPromiseState(resultHandle);
      if (state.type === 'fulfilled') {
        try {
          const result = vm.dump(state.value);
          const { value, options, undefinedHeaders } = result;
          const input = result.input[0];
          if (call.name === 'filter' && (!Array.isArray(value) || value.length !== input.length || value.some(v => typeof v !== 'boolean'))) throw new Error('Script filter must return one boolean per node');
          const output = value === undefined ? input : value;
          if (call.name === 'operator' && Array.isArray(input) && !Array.isArray(output)) throw new Error('Script operator must return nodes');
          if (call.name === 'operator' && !Array.isArray(input) && (!output || typeof output.$content !== 'string')) throw new Error('File script must return file content');
          if (call.name === 'transformFunction' && (!output || typeof output !== 'object' || Array.isArray(output))) throw new Error('Response transformer must return a response');
          const contextIndex = call.name === 'transformFunction' ? 1 : 2;
          const originalContext = call.input[contextIndex] as Record<string, unknown> | undefined;
          const nextContext = result.input[contextIndex];
          if (originalContext && nextContext) {
            for (const key of Object.keys(originalContext)) if (!['env', 'source'].includes(key) && !(key in nextContext)) delete originalContext[key];
            for (const [key, value] of Object.entries(nextContext)) if (!['env', 'source'].includes(key)) originalContext[key] = value;
          }
          if (call.globals.$options && options) {
            Object.assign(call.globals.$options, options);
            for (const key of undefinedHeaders || []) call.globals.$options._res.headers[key] = undefined;
          }
          return output;
        } finally { state.value.dispose(); }
      }
      if (state.type === 'rejected') { try { const error = vm.dump(state.error); const message = String(error?.message || 'invalid result').replace(/'(\$?\w+)' is not defined/g, '$1 is not defined'); throw new Error(`Script failed: ${message}`); } finally { state.error.dispose(); } }
      if (!vm.runtime.hasPendingJob()) {
        if (!pending.size) throw new Error('Script promise did not settle');
        await Promise.race([...pending, aborted]);
      }
    }
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    resultHandle?.dispose();
    for (const deferred of deferreds) if (deferred.alive) deferred.dispose();
    vm.dispose();
  }
}
