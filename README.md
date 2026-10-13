# Sub-Store on Cloudflare Workers

Official Sub-Store frontend and backend routes on one Cloudflare Workers domain. The backend uses the official cross-platform runtime and proxy parsers, processors and exporters, with a Workers HTTP adapter and SQLite-backed Durable Object storage. No container, VPS, R2 subscription, or paid-plan upgrade is required by this deployment.

## Supported and validated

- Create, edit, list and delete local or remote subscriptions using the official API and response format.
- Preview subscriptions and collections; use built-in node actions such as regex rename/filter and node sorting.
- Export JSON, Clash/Mihomo, Loon, Surge and Shadowrocket output through official converters.
- Manage collections, files, settings, artifacts, archives and share tokens through official routes.
- Download backups and restore official-format data. Data starts in a fresh SQLite store; no previous D1 data is imported.
- Concurrent writes are serialized for this personal installation and changes are committed atomically before success is returned.

The generated backend is pinned to official Sub-Store **2.42.3** (`a3e61061e50b40e5c5938969aab915d05d8d7069`). The frontend is pinned to `4bd7b0acbe65466b933ccea14fc61dbebe036ead`. Updating either requires reviewing the adapter and passing the integration tests; deploys do not silently pull a new backend.

## Workers limits

Custom JavaScript processors and response scripts cannot run in ordinary Workers. Script execution returns a clear error, and the frontend hides script action buttons for this backend. Use built-in actions instead.

Client proxy/policy routing, SOCKS/HTTP proxy dispatch, local files/MMDB, Node notifications, and Node cron schedulers are not available. Remote HTTP(S) subscriptions and DNS-over-HTTPS use Workers fetch. Request and downloaded subscription bodies are limited to 1 MiB; each persisted preference value is limited to 1.9 MB. Cloudflare's normal free-plan limits still apply. This is a personal installation, with one serialized state store for subscriptions and their related collections.

## Deploy

See [DEPLOY.md](DEPLOY.md). Pushes to `main` build the pinned official frontend, check the Worker, run integration tests, and deploy the Worker and static assets together.

There are no account-specific database or KV IDs in the configuration. SQLite Durable Objects are provisioned through Wrangler migrations. The `official-v3` object is a new installation and keeps its data across subsequent deployments.

## Source and licensing

The original repository's code retains its MIT license. The bundled official Sub-Store runtime and the combined derivative service are distributed under **AGPL-3.0**; see [COPYING](COPYING) and [worker/src/official/LICENSE](worker/src/official/LICENSE). The frontend About page links to this fork's source.

To regenerate the backend from the pinned official source and locked dependencies:

```sh
node scripts/build-official-backend.mjs
```

Generated runtime: `worker/src/official/runtime.js`. Adapter: `worker/src/index.ts`. Integration acceptance: `tests/contract.mjs`.
