import { DurableObject } from 'cloudflare:workers';
import { runOfficial } from './official/runtime.js';
declare global { namespace Cloudflare { interface Env { ADMIN_TOKEN?: string; SUB_STORE_FRONTEND_BACKEND_PATH?: string; } } }

const MAX_BYTES = 1024 * 1024;
const failure = (code: string, message: string, status = 500) => Response.json({
  status: 'failed', error: { code, type: 'WorkersError', message },
}, { status });

async function boundedText(response: Response | Request): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Content exceeds the 1 MiB Workers adapter limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('Content exceeds the 1 MiB Workers adapter limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

// One object represents this personal Sub-Store installation, including collections.
// ponytail: serialize its shared JSON database; shard by installation if multi-tenancy is added.
export class SubscriptionStore extends DurableObject<Cloudflare.Env> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  async handle(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.execute(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async execute(request: Request): Promise<Response> {
    try {
      const body = await boundedText(request);
      const rows = this.ctx.storage.sql.exec<{ key: string; value: string }>('SELECT key, value FROM preferences').toArray();
      const values = new Map(rows.map(row => [row.key, row.value]));
      const original = new Map(values);
      const changed = new Set<string>();
      const response = await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sub-Store request exceeded 25 seconds')), 25000);
        const finish = (response: Response) => { clearTimeout(timer); resolve(response); };
        try {
          runOfficial({
            $request: { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body },
            $prefs: {
              valueForKey: (key: string) => values.get(key) ?? null,
              setValueForKey: (value: string | null, key: string) => {
                changed.add(key);
                if (value === null) values.delete(key); else values.set(key, value);
                return true;
              },
              removeValueForKey: (key: string) => { changed.add(key); values.delete(key); return true; },
            },
            $task: { fetch: async (options: TaskOptions) => {
              const url = new URL(options.url);
              if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP(S) subscription URLs are supported');
              if (options.opts?.policy && options.opts.policy !== 'DIRECT') throw new Error('Proxy/policy routing is unavailable on Cloudflare Workers');
              const response = await fetch(url, {
                method: options.method || 'GET', headers: options.headers,
                body: ['GET', 'HEAD'].includes(options.method || 'GET') ? undefined : options.body,
                signal: AbortSignal.timeout(20000),
              });
              const text = await boundedText(response);
              return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: text, bodyBytes: new TextEncoder().encode(text).buffer };
            } },
            $done: (result: OfficialResponse) => {
              const status = typeof result.status === 'number' ? result.status : Number(result.status?.split(' ')[1] || 200);
              finish(new Response([204, 205, 304].includes(status) ? null : (result.body || ''), { status, headers: result.headers }));
            },
            $notify: () => undefined,
            // The official logger captures this request-local console, never the Worker global console.
            console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
          });
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      if (response.ok) {
        if (!original.has('sub-store')) changed.add('sub-store');
        for (const key of changed) {
          const value = values.get(key);
          if (value && new TextEncoder().encode(value).length > 1900000) return failure('STORAGE_LIMIT', 'Sub-Store data exceeds the SQLite per-value limit', 413);
        }
        // Commit every changed key together before acknowledging a successful request.
        this.ctx.storage.transactionSync(() => {
          for (const key of changed) {
            const value = values.get(key);
            if (value === undefined) this.ctx.storage.sql.exec('DELETE FROM preferences WHERE key = ?', key);
            else if (value !== original.get(key)) this.ctx.storage.sql.exec('INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
          }
        });
      }
      return response;
    } catch (error) {
      return failure('WORKERS_RUNTIME_ERROR', error instanceof Error ? error.message : 'Sub-Store request failed');
    }
  }
}

interface TaskOptions {
  url: string; method?: string; headers?: Record<string, string>; body?: string;
  opts?: { policy?: string };
}
interface OfficialResponse { status?: number | string; body?: string; headers?: Record<string, string>; }

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'sub-store-cloudflare' });
    const prefix = env.SUB_STORE_FRONTEND_BACKEND_PATH;
    const hasPrefix = prefix && /^\/[A-Za-z0-9_-]{20,}$/.test(prefix) && url.pathname.startsWith(`${prefix}/`);
    if (hasPrefix) {
      url.pathname = url.pathname.slice(prefix.length);
      request = new Request(url, request);
    }
    if (!/^\/(api|download|share)(\/|$)/.test(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set('Referrer-Policy', 'no-referrer');
      return response;
    }
    // Match official merged deployment: secret backend path, public token-scoped shares.
    if (!prefix || !/^\/[A-Za-z0-9_-]{20,}$/.test(prefix)) return failure('ACCESS_NOT_CONFIGURED', 'Configure a strong Sub-Store backend path', 503);
    if (!hasPrefix && !url.pathname.startsWith('/share/')) return failure('NOT_FOUND', 'Not found', 404);
    if (url.pathname === '/api/health') return Response.json({ ok: true });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (env.ADMIN_TOKEN && !url.pathname.startsWith('/share/') && request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return failure('UNAUTHORIZED', 'Admin token required', 401);
    // The official mobile runtime allows its own frontend origins. Our frontend is served on this origin.
    if (request.headers.get('origin') === url.origin) {
      const headers = new Headers(request.headers);
      headers.delete('origin');
      request = new Request(request, { headers });
    }
    const response = await env.SUBSTORE.getByName('official-v3').handle(request);
    if (url.pathname === '/api/utils/env' && response.ok) {
      const data = await response.json() as { data: { feature: Record<string, unknown>; meta: Record<string, unknown> } };
      data.data.feature = { ...data.data.feature, workers: true, shares: true, scripts: false, proxyPolicy: false };
      data.data.meta = { ...data.data.meta, workers: { secretPath: prefix }, runtime: 'cloudflare-workers', source: 'https://github.com/sub-store-org/Sub-Store', sourceRef: 'a3e61061e50b40e5c5938969aab915d05d8d7069' };
      return Response.json(data);
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
