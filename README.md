# Sub-Store on Cloudflare Workers

Official Sub-Store frontend and backend routes on one Cloudflare Workers domain. The backend uses the official cross-platform runtime and proxy parsers, processors and exporters, with a Workers HTTP adapter and SQLite-backed Durable Object storage. No container, VPS, R2 subscription, or paid-plan upgrade is required by this deployment.

## Supported and validated

- Create, edit, list and delete local or remote subscriptions using the official API and response format.
- Preview subscriptions and collections; use built-in node actions such as regex rename/filter and node sorting.
- Export JSON, Clash/Mihomo, Loon, Surge and Shadowrocket output through official converters.
- Manage collections, files, settings, artifacts, archives and share tokens through official routes.
- Native secret backend path protects management; resource-scoped share links work without login and support expiration, revocation and usage limits.
- Download backups and restore official-format data. Data starts in a fresh SQLite store; no previous D1 data is imported.
- Concurrent writes are serialized for this personal installation and changes are committed atomically before success is returned.
- Script Operator, Script Filter, shortcut scripts, response transformers, file scripts and mihomo config overrides (YAML patch or JavaScript `main(config)`) use an isolated QuickJS/WASM runtime, including promises, restricted HTTP, lodash, YAML, Base64 and a small Buffer API.
- Per-artifact cron schedules use persistent Durable Object Alarms, with finite retries and task status in the Sync page. Schedules default to UTC and must be at least five minutes apart.
- Optional HTTPS notifications are delivered by Alarm with finite retries. Native backend logs are redacted and limited to 500 entries when enabled.

The generated backend is pinned to official Sub-Store **2.42.3** (`a3e61061e50b40e5c5938969aab915d05d8d7069`). The frontend is pinned to `4bd7b0acbe65466b933ccea14fc61dbebe036ead`. Updating either requires reviewing the adapter and passing the integration tests; deploys do not silently pull a new backend.

## Workers limits

Custom JavaScript runs inside a bundled WASM interpreter; the main Worker still rejects Node-only dynamic operations. Scripts are limited to 256 KiB, 16 MiB interpreter memory, three seconds including async waits, and an instruction-interrupt budget. Each call receives a fresh context. `require`, native modules, host callbacks and a complete Node Buffer API are unavailable. Script exceptions and resource limits fail explicitly rather than silently falling back to a no-op.

Client proxy/policy routing, SOCKS/HTTP proxy dispatch, arbitrary local files/MMDB and Node schedulers are unavailable. HTTP(S) subscriptions and DNS-over-HTTPS use Workers fetch, limited to 1 MiB per downloaded body, 40 calls per request and four concurrent fetches. Management bodies allow 4 MiB, backups 8 MiB, and each persisted preference 4 MiB. Large preferences are stored in atomic Unicode-safe chunks. Cloudflare's normal account-wide free-plan limits still apply. This is a personal installation, with one serialized state store for subscriptions and their related collections; slow requests can still hold that queue.

Implementation and verification boundaries: [docs/free-plan-implementation.md](docs/free-plan-implementation.md). Remaining gaps versus official Sub-Store: [docs/restoration-roadmap.md](docs/restoration-roadmap.md). Local and mocked integration checks do not prove production quotas, live GitHub delivery or actual proxy-client imports.

Set the required `SUB_STORE_FRONTEND_BACKEND_PATH` Worker secret before using management APIs. The official frontend's backend-path dialog grants access to its holder; the public UI shell cannot read management data. Share recipients receive independent token-authenticated `/share/...` links and do not need this secret or a Cloudflare login. See [DEPLOY.md](DEPLOY.md#native-access-control-and-public-shares).

Configure this value as a GitHub Actions repository secret. Both `sub` and `/sub` are accepted and normalize to `/sub`; there is no minimum length. The value must be non-empty and use letters, digits, `_` or `-`, with an optional leading slash. After changing it, run the deploy workflow and update the browser's backend path.

## Deploy

See [DEPLOY.md](DEPLOY.md). Pushes to `main` run CI (pinned frontend build, Worker checks, integration tests) and deploy the Worker and the tested static assets only after CI passes.

There are no account-specific database or KV IDs in the configuration. SQLite Durable Objects are provisioned through Wrangler migrations. The `official-v3` object is a new installation and keeps its data across subsequent deployments.

## Source and licensing

The original repository's code retains its MIT license. The bundled official Sub-Store runtime and the combined derivative service are distributed under **AGPL-3.0**; see [COPYING](COPYING) and [worker/src/official/LICENSE](worker/src/official/LICENSE). The frontend About page links to this fork's source.

To regenerate the backend from the pinned official source and locked dependencies:

```sh
node scripts/build-official-backend.mjs
```

Generated runtime: `worker/src/official/runtime.js`. Adapter: `worker/src/index.ts`. Integration acceptance: `tests/contract.mjs`.
