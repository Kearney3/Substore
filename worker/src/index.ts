import { DurableObject } from 'cloudflare:workers';
import { runOfficial } from './official/runtime.js';
import { executeScript } from './scripts';
import { backendPathSecret, nextCron, redact } from './schedule';
declare global { namespace Cloudflare { interface Env { ADMIN_TOKEN?: string; SUB_STORE_FRONTEND_BACKEND_PATH?: string; SUB_STORE_PUSH_SERVICE?: string; SUB_STORE_CRON_TIMEZONE?: string; } } }

const MAX_BYTES = 1024 * 1024;
const failure = (code: string, message: string, status = 500) => Response.json({
  status: 'failed', error: { code, type: 'WorkersError', message },
}, { status });

async function boundedText(response: Response | Request, limit = MAX_BYTES): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Content exceeds the Workers adapter limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Content exceeds the Workers adapter limit');
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
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS preference_chunks (key TEXT NOT NULL, part INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(key, part))');
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tasks (name TEXT PRIMARY KEY, cron TEXT NOT NULL, next_run INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'scheduled', error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, payload TEXT NOT NULL, next_run INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '')");
    if (!this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(notifications)').toArray().some(column => column.name === 'error')) this.ctx.storage.sql.exec("ALTER TABLE notifications ADD COLUMN error TEXT NOT NULL DEFAULT ''");
    this.ctx.blockConcurrencyWhile(async () => { await this.reconcileSchedules(); });
  }

  private readValues(): Map<string, string> {
    const values = new Map(this.ctx.storage.sql.exec<{ key: string; value: string }>('SELECT key, value FROM preferences').toArray().map(row => [row.key, row.value]));
    const parts = this.ctx.storage.sql.exec<{ key: string; value: string }>('SELECT key, value FROM preference_chunks ORDER BY key, part').toArray();
    const chunked = new Map<string, string[]>();
    for (const row of parts) { const list = chunked.get(row.key) || []; list.push(row.value); chunked.set(row.key, list); }
    for (const [key, list] of chunked) values.set(key, list.join(''));
    return values;
  }

  private storeValue(key: string, value?: string) {
    this.ctx.storage.sql.exec('DELETE FROM preference_chunks WHERE key = ?', key);
    if (value === undefined) { this.ctx.storage.sql.exec('DELETE FROM preferences WHERE key = ?', key); return; }
    const chunked = new TextEncoder().encode(value).length > 1900000;
    // Fail closed in old adapters instead of making their JSON parser treat a chunked installation as empty.
    this.ctx.storage.sql.exec('INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, chunked ? 'Cloudflare chunked storage v1 requires a compatible adapter' : value);
    if (chunked) for (const [part, text] of (value.match(/[\s\S]{1,200000}/gu) || []).entries()) this.ctx.storage.sql.exec('INSERT INTO preference_chunks (key, part, value) VALUES (?, ?, ?)', key, part, text);
  }

  private async reconcileSchedules() {
    const values = this.readValues();
    const data = JSON.parse(values.get('sub-store') || '{}');
    const timezone = this.env.SUB_STORE_CRON_TIMEZONE || 'UTC';
    const timezoneChanged = values.get('workers-cron-timezone') !== timezone;
    const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
    const active = new Set<string>();
    for (const artifact of artifacts.filter((a: any) => a.sync && a.source && a.cron).slice(0, 50)) {
      active.add(artifact.name);
      try {
        const next = nextCron(artifact.cron, Date.now(), timezone);
        this.ctx.storage.sql.exec("INSERT INTO tasks(name,cron,next_run) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET cron=excluded.cron,next_run=excluded.next_run,attempts=0,status='scheduled',error='' WHERE tasks.cron != excluded.cron OR tasks.status = 'disabled' OR ?", artifact.name, artifact.cron, next, timezoneChanged ? 1 : 0);
      } catch {
        this.ctx.storage.sql.exec("INSERT INTO tasks(name,cron,next_run,status,error) VALUES (?,?,0,'disabled','Invalid or excessive schedule') ON CONFLICT(name) DO UPDATE SET status='disabled',next_run=0,error='Invalid or excessive schedule'", artifact.name, artifact.cron);
      }
    }
    for (const row of this.ctx.storage.sql.exec<{ name: string }>('SELECT name FROM tasks').toArray()) if (!active.has(row.name)) this.ctx.storage.sql.exec('DELETE FROM tasks WHERE name=?', row.name);
    if (timezoneChanged) this.ctx.storage.transactionSync(() => this.storeValue('workers-cron-timezone', timezone));
    await this.armAlarm();
  }

  private async armAlarm() {
    const rows = this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(due) AS due FROM (SELECT next_run AS due FROM tasks WHERE status!='disabled' UNION ALL SELECT next_run AS due FROM notifications WHERE status='pending')").toArray();
    if (rows[0]?.due != null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, rows[0].due));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const work = this.queue.then(() => this.runTasks());
    this.queue = work.catch(() => undefined);
    await work;
  }

  private async runTasks() {
    const due = this.ctx.storage.sql.exec<{ name: string; cron: string; attempts: number }>("SELECT name,cron,attempts FROM tasks WHERE next_run<=? AND status!='disabled' ORDER BY next_run LIMIT 3", Date.now()).toArray();
    for (const task of due) {
      this.ctx.storage.sql.exec("UPDATE tasks SET status='running',updated_at=? WHERE name=?", Date.now(), task.name);
      const response = await this.execute(new Request(`https://substore.internal/api/sync/artifact/${encodeURIComponent(task.name)}`));
      let error = '';
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: { message?: string; details?: string } } | null;
        const settings = JSON.parse(this.readValues().get('sub-store') || '{}').settings || {};
        error = redact(`${result?.error?.message || 'Artifact sync failed'} ${result?.error?.details || ''}`, [settings.gistToken || '', backendPathSecret(this.env.SUB_STORE_FRONTEND_BACKEND_PATH)]);
      }
      const retry = !response.ok && task.attempts < 2;
      const next = retry ? Date.now() + 60000 * (task.attempts + 1) : nextCron(task.cron, Date.now(), this.env.SUB_STORE_CRON_TIMEZONE || 'UTC');
      this.ctx.storage.sql.exec('UPDATE tasks SET status=?,error=?,attempts=?,next_run=?,updated_at=? WHERE name=?', response.ok ? 'success' : 'failed', error, retry ? task.attempts + 1 : 0, next, Date.now(), task.name);
    }
    const notifications = this.ctx.storage.sql.exec<{ id: string; payload: string; attempts: number }>("SELECT id,payload,attempts FROM notifications WHERE next_run<=? AND status='pending' ORDER BY next_run LIMIT 3", Date.now()).toArray();
    for (const notification of notifications) {
      try {
        if (!this.env.SUB_STORE_PUSH_SERVICE) throw new Error('Notification service is not configured');
        const { title, content } = JSON.parse(notification.payload);
        const template = this.env.SUB_STORE_PUSH_SERVICE;
        const url = template.replaceAll('[推送标题]', encodeURIComponent(title)).replaceAll('[推送内容]', encodeURIComponent(content));
        if (new URL(url).protocol !== 'https:') throw new Error('Notification service must use HTTPS');
        const response = await fetch(url, { method: template.includes('[推送') ? 'GET' : 'POST', headers: template.includes('[推送') ? undefined : { 'Content-Type': 'application/json' }, body: template.includes('[推送') ? undefined : notification.payload, signal: AbortSignal.timeout(10000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error('Notification delivery failed');
        this.ctx.storage.sql.exec("UPDATE notifications SET status='sent',payload='{}',error='' WHERE id=?", notification.id);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : 'Notification delivery failed', [this.env.SUB_STORE_PUSH_SERVICE || '']);
        this.ctx.storage.sql.exec("UPDATE notifications SET status=?,attempts=attempts+1,next_run=?,payload=CASE WHEN ? THEN '{}' ELSE payload END,error=? WHERE id=?", notification.attempts < 2 ? 'pending' : 'failed', Date.now() + 60000 * (notification.attempts + 1), notification.attempts >= 2 ? 1 : 0, message, notification.id);
      }
    }
    this.ctx.storage.sql.exec("DELETE FROM notifications WHERE status!='pending' AND id NOT IN (SELECT id FROM notifications ORDER BY next_run DESC LIMIT 50)");
    await this.armAlarm();
  }

  async handle(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.execute(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async execute(request: Request): Promise<Response> {
    const controller = new AbortController();
    let active = true;
    const signal = controller.signal;
    try {
      if (new URL(request.url).pathname === '/api/workers/tasks') {
        if (request.headers.get('origin')) return failure('FORBIDDEN', 'Use the integrated frontend', 403);
        if (request.method !== 'GET') return failure('METHOD_NOT_ALLOWED', 'Use GET', 405);
        return Response.json({ status: 'success', data: { timezone: this.env.SUB_STORE_CRON_TIMEZONE || 'UTC', tasks: this.ctx.storage.sql.exec('SELECT * FROM tasks').toArray(), notifications: this.ctx.storage.sql.exec('SELECT id,status,attempts,next_run,error FROM notifications').toArray() } });
      }
      const body = await boundedText(request, new URL(request.url).pathname === '/api/storage' ? 8 * MAX_BYTES : 4 * MAX_BYTES);
      const values = this.readValues();
      const original = new Map(values);
      const changed = new Set<string>();
      const notices: string[] = [];
      let fetchCount = 0;
      let scriptCalls = 0, scriptDepth = 0;
      const fetches = new Set<Promise<any>>();
      const settings = JSON.parse(values.get('sub-store') || '{}').settings || {};
      const safeLog = (message: string) => redact(message, [backendPathSecret(this.env.SUB_STORE_FRONTEND_BACKEND_PATH), this.env.ADMIN_TOKEN || '', this.env.SUB_STORE_PUSH_SERVICE || '', settings.gistToken || '', settings['age-secret-key'] || '']);
      const response = await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => { controller.abort(); active = false; reject(new Error('Sub-Store request exceeded 25 seconds')); }, 25000);
        const finish = (response: Response) => { clearTimeout(timer); resolve(response); };
        try {
          runOfficial({
            executeScript: async (call: Parameters<typeof executeScript>[0]) => {
              if (++scriptCalls > 20 || scriptDepth >= 4) throw new Error('Script call or nesting limit exceeded');
              scriptDepth++;
              try { return await executeScript(call, signal); } finally { scriptDepth--; }
            },
            validateCron: (cron: string) => nextCron(cron, Date.now(), this.env.SUB_STORE_CRON_TIMEZONE || 'UTC'),
            redact: safeLog,
            $request: { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body },
            $prefs: {
              valueForKey: (key: string) => values.get(key) ?? null,
              setValueForKey: (value: string | null, key: string) => {
                if (!active) return false;
                changed.add(key);
                if (value === null) values.delete(key); else values.set(key, value);
                return true;
              },
              removeValueForKey: (key: string) => { if (!active) return false; changed.add(key); values.delete(key); return true; },
            },
            $task: { fetch: async (options: TaskOptions) => {
              signal.throwIfAborted();
              if (++fetchCount > 40) throw new Error('Workers fetch limit exceeded');
              while (fetches.size >= 4) await Promise.race(fetches);
              signal.throwIfAborted();
              const work = (async () => {
              const url = new URL(options.url);
              if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP(S) subscription URLs are supported');
              for (const route of [options.opts?.policy, options.routing]) {
                if (route && route !== 'DIRECT') throw new Error('Proxy/policy routing is unavailable on Cloudflare Workers; requests can only be sent directly');
              }
              const response = await fetch(url, {
                method: options.method || 'GET', headers: options.headers,
                body: ['GET', 'HEAD'].includes(options.method || 'GET') ? undefined : options.body,
                signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
              });
              const text = await boundedText(response);
              return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: text, bodyBytes: new TextEncoder().encode(text).buffer };
              })();
              fetches.add(work);
              try { return await work; } finally { fetches.delete(work); }
            } },
            $done: (result: OfficialResponse) => {
              if (!active) return;
              const status = typeof result.status === 'number' ? result.status : Number(result.status?.split(' ')[1] || 200);
              finish(new Response([204, 205, 304].includes(status) ? null : (result.body || ''), { status, headers: result.headers }));
            },
            $notify: (title: string, subtitle: string, content: string) => {
              if (active && this.env.SUB_STORE_PUSH_SERVICE && notices.length < 3) notices.push(JSON.stringify({ title: safeLog(title), content: safeLog(`${subtitle}\n${content}`) }));
            },
            // The official logger captures this request-local console, never the Worker global console.
            console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
          });
        } catch (error) { clearTimeout(timer); reject(error); }
      });
      active = false;
      controller.abort();
      if (response.ok) {
        if (!original.has('sub-store')) changed.add('sub-store');
        for (const key of changed) {
          const value = values.get(key);
          if (value && new TextEncoder().encode(value).length > 4 * MAX_BYTES) return failure('STORAGE_LIMIT', 'Sub-Store preference exceeds 4 MiB', 413);
        }
        const data = JSON.parse(values.get('sub-store') || '{}');
        const scheduled = (Array.isArray(data.artifacts) ? data.artifacts : []).filter((a: any) => a.sync && a.source && a.cron);
        if (scheduled.length > 50) return failure('TASK_LIMIT', 'At most 50 scheduled artifacts are supported', 400);
        const previous = JSON.parse(original.get('sub-store') || '{}');
        for (const artifact of scheduled) {
          const existing = (Array.isArray(previous.artifacts) ? previous.artifacts : []).find((a: any) => a.name === artifact.name);
          if (existing?.cron === artifact.cron && existing.sync && existing.source) continue;
          try { nextCron(artifact.cron, Date.now(), this.env.SUB_STORE_CRON_TIMEZONE || 'UTC'); }
          catch { return failure('INVALID_ARTIFACT_CRON', 'Invalid or excessive artifact schedule', 400); }
        }
        // Commit every changed key together before acknowledging a successful request.
        this.ctx.storage.transactionSync(() => {
          for (const key of changed) {
            const value = values.get(key);
            if (value !== original.get(key)) this.storeValue(key, value);
          }
        });
      }
      // Preserve diagnostic logs on failed requests without committing their business-state changes.
      if (!response.ok && changed.has('#sub-store-logs')) this.ctx.storage.transactionSync(() => this.storeValue('#sub-store-logs', values.get('#sub-store-logs')));
      for (const payload of notices) {
        const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM notifications WHERE status='pending'").toArray()[0].count;
        if (count < 20) this.ctx.storage.sql.exec('INSERT INTO notifications(id,payload,next_run) VALUES (?,?,?)', crypto.randomUUID(), payload, Date.now() + 1000);
      }
      await this.reconcileSchedules();
      return response;
    } catch (error) {
      return failure('WORKERS_RUNTIME_ERROR', error instanceof Error ? error.message : 'Sub-Store request failed');
    } finally { active = false; controller.abort(); }
  }
}

interface TaskOptions {
  url: string; method?: string; headers?: Record<string, string>; body?: string;
  opts?: { policy?: string };
  // Surge/Loon node or policy-descriptor, or a Node proxy URL, forwarded by the patched official HTTP client.
  routing?: string;
}
interface OfficialResponse { status?: number | string; body?: string; headers?: Record<string, string>; }

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'sub-store-cloudflare' });
    const configuredPath = env.SUB_STORE_FRONTEND_BACKEND_PATH;
    const prefix = configuredPath && /^\/?[A-Za-z0-9_-]+$/.test(configuredPath) ? `/${configuredPath.replace(/^\//, '')}` : undefined;
    const hasPrefix = prefix && url.pathname.startsWith(`${prefix}/`);
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
    if (!prefix) return failure('ACCESS_NOT_CONFIGURED', 'Configure a non-empty Sub-Store backend path', 503);
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
      data.data.feature = { ...data.data.feature, workers: true, share: true, scripts: true, nodeScripts: true, responseScripts: true, fileScripts: true, artifactCron: true, httpNotifications: Boolean(env.SUB_STORE_PUSH_SERVICE), proxyPolicy: false };
      data.data.meta = { ...data.data.meta, workers: { secretPath: prefix, scriptEngine: 'QuickJS', cronTimezone: env.SUB_STORE_CRON_TIMEZONE || 'UTC', minCronIntervalSeconds: 300, limits: { scriptBytes: 131072, scriptMemoryBytes: 16777216, preferenceBytes: 4194304, fetches: 40 } }, runtime: 'cloudflare-workers', source: 'https://github.com/sub-store-org/Sub-Store', sourceRef: 'a3e61061e50b40e5c5938969aab915d05d8d7069' };
      return Response.json(data, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
