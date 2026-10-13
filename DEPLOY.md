# Deployment

## Account configuration

Configure GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: Workers Scripts Edit for the target account. The token must allow deploying SQLite-backed Durable Objects with the Worker.
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to.
- Optional `SUB_STORE_ADMIN_TOKEN`: written to the Worker as `ADMIN_TOKEN`. When enabled, API and download clients must send `Authorization: Bearer <token>`; share routes use official share tokens instead. The stock frontend does not add this header automatically, so use a client that supplies it before enabling this option.

No D1, KV, R2 or Containers service is used. A SQLite Durable Object named `SubscriptionStore` is created through the `substore-sqlite-v1` Wrangler migration. Do not remove/rename this migration or class after deployment: it owns the persistent official Sub-Store data.

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
WORKER_TEST_URL=http://127.0.0.1:8787 node tests/contract.mjs
```

## Upstream updates

Backend and frontend revisions are pinned to prevent accidental API/runtime drift. Update the pins deliberately, regenerate the backend with `node scripts/build-official-backend.mjs`, review the generated changes, and rerun integration and browser acceptance. The backend build uses `scripts/official-backend-lock.json` to fix upstream dependency versions.

There is currently no automatic upstream-sync workflow in this repository. A new upstream version does not change the running service until reviewed and deployed.

## Domain and limitations

`workers.dev` serves both the frontend and API; a custom domain may be bound to the same Worker. API/download/share paths are explicitly routed to the Worker before SPA fallback.

User JavaScript, client proxy/policy routing, Node-only local files/MMDB and Node cron/notification features are unavailable in this pure Workers deployment. The official conversion and built-in processing logic is retained. See README for size limits and tested functionality.
