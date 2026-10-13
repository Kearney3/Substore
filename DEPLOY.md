# Deployment

## Account configuration

Configure GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: Workers Scripts Edit for the target account. The token must allow deploying SQLite-backed Durable Objects with the Worker.
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to.
- Required Worker secret `SUB_STORE_FRONTEND_BACKEND_PATH`: a random secret path such as `/` followed by at least 20 URL-safe characters. Set it in Cloudflare Workers Settings, or use `wrangler secret put SUB_STORE_FRONTEND_BACKEND_PATH`. Never put its value in Wrangler config, frontend assets or this repository. Missing/invalid configuration blocks all backend requests.
- Optional `SUB_STORE_ADMIN_TOKEN`: an additional bearer check for management APIs/downloads. The stock frontend does not add this header automatically; normally leave this unset and use the native secret backend path.

No D1, KV, R2 or Containers service is used. A SQLite Durable Object named `SubscriptionStore` is created through the `substore-sqlite-v1` Wrangler migration. Do not remove/rename this migration or class after deployment: it owns the persistent official Sub-Store data.

## Native access control and public shares

This adapter implements the official merged deployment's access model: management APIs and direct downloads are reachable only under `SUB_STORE_FRONTEND_BACKEND_PATH`, while `/share/sub`, `/share/col` and `/share/file` require their own official resource-scoped tokens. Share links need no account login or management secret. Do not protect the entire Worker with Cloudflare Access, as it would block subscription clients.

Open the frontend and enter the secret backend path in its native configuration dialog, or initialize the owner browser with `/?magicpath=<secret-path-without-leading-slash>`. The browser saves its backend configuration. Anyone holding this path can manage the installation, so treat it as an owner credential; share only the generated `/share/...?...token=...` links. The public frontend shell contains no management secret and cannot read data without it.

Create and revoke shares using the official Share UI. Tokens use Web Crypto through the pinned upstream Nano ID dependency. The official token validation, expiration, resource scope and use-count rules are retained. Share creation and consumption are serialized with the installation's SQLite state. Invalid, revoked, expired and exhausted tokens return 404. The adapter does not enable the optional invalid-share fake-node fallback.

The Worker secret persists across normal deployments to the same Worker. After deployment, verify that unprefixed `/api/subs` and `/download/<name>` return 404, the owner path permits management, and a generated public share downloads without cookies or login. Use frontend backup export before rotating/replacing infrastructure.

Preview URLs are disabled because historical Worker versions predate the native access guard. Keep `preview_urls = false`; otherwise an old preview may expose the same installation through an older adapter.

## Deploy through Actions

Push `main` or dispatch `Deploy Sub-Store to Cloudflare`.

1. Build the pinned official frontend with `VITE_API_URL=/` and the Workers capability/source patches.
2. Install locked Worker dependencies, generate runtime types and typecheck.
3. Run official API integration tests, including CRUD, preview, six exporters, collections, files, backups, concurrent writes and remote HTTP.
4. Deploy the Worker, SQLite Durable Object class and frontend assets together.

The `official-v3` Durable Object starts with empty official Sub-Store data. No previous D1 data is imported. Its SQLite data persists across deploys, restarts and eviction; use the frontend backup export before major changes. Existing old Cloudflare resources are not used by this implementation.

## Local verification

```sh
cd worker
npm ci
npm run typecheck
cd ..
node scripts/sync-official-frontend.mjs
node scripts/test-worker.mjs
```

The contract test creates uniquely named sample subscriptions, collections and files, then removes only its own fixtures. To test an already-running local Worker or deployed service:

```sh
WORKER_TEST_URL=http://127.0.0.1:8787/local-test-backend-path-123456 node tests/contract.mjs
```

## Upstream updates

Backend and frontend revisions are pinned to prevent accidental API/runtime drift. Update the pins deliberately, regenerate the backend with `node scripts/build-official-backend.mjs`, review the generated changes, and rerun integration and browser acceptance. The backend build uses `scripts/official-backend-lock.json` to fix upstream dependency versions.

There is currently no automatic upstream-sync workflow in this repository. A new upstream version does not change the running service until reviewed and deployed.

## Domain and limitations

`workers.dev` serves both the frontend and API; a custom domain may be bound to the same Worker. API/download/share paths are explicitly routed to the Worker before SPA fallback.

User JavaScript, client proxy/policy routing, Node-only local files/MMDB and Node cron/notification features are unavailable in this pure Workers deployment. The official conversion and built-in processing logic is retained. See README for size limits and tested functionality.
