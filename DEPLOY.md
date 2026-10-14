# Deployment

## Account configuration

Configure GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`: Workers Scripts Edit for the target account. The token must allow deploying SQLite-backed Durable Objects with the Worker.
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to.
- Required repository Actions secret `SUB_STORE_FRONTEND_BACKEND_PATH`: a non-empty path name using letters, digits, `_` or `-`. There is no minimum length, and the leading `/` is optional: `sub` and `/sub` both use `/sub` as the management prefix. Configure it under GitHub **Settings → Secrets and variables → Actions → Repository secrets**. The deploy workflow validates it before building and writes it to the Worker through `wrangler secret put` immediately before deployment. Empty values, `/` alone and names containing other characters stop deployment. Never put its value in Wrangler config, frontend assets or this repository.
- Optional `SUB_STORE_ADMIN_TOKEN`: an additional bearer check for management APIs/downloads. The stock frontend does not add this header automatically; normally leave this unset and use the native secret backend path.

No D1, KV, R2, Dynamic Workers or Containers service is used. A SQLite Durable Object named `SubscriptionStore` is created through the `substore-sqlite-v1` Wrangler migration. Do not remove/rename this migration or class after deployment: it owns the persistent official Sub-Store data.

Optional Worker configuration:

- `SUB_STORE_CRON_TIMEZONE`: IANA timezone, default `UTC`. For Ulaanbaatar use `Asia/Ulaanbaatar`. Changing it recalculates existing schedules. No permanent Node cron process or Wrangler cron trigger is required.
- `SUB_STORE_PUSH_SERVICE`: Worker secret containing an HTTPS URL template with `[推送标题]` / `[推送内容]`, or an HTTPS webhook receiving JSON `{title, content}` via POST. Shoutrrr schemes are not supported. Notifications are disabled when unset; delivery is attempted at most three times. The deployment workflow does not overwrite these optional values.

The Sync page exposes task state. At most 50 artifacts may have active schedules, each at least five minutes apart; times are best effort and Alarm is at least once. A crash after an external upload/notification but before recording success can repeat delivery. Network calls are bounded and notifications have a pending backlog limit of 20.

## Native access control and public shares

This adapter implements the official merged deployment's access model: management APIs and direct downloads are reachable only under `SUB_STORE_FRONTEND_BACKEND_PATH`, while `/share/sub`, `/share/col` and `/share/file` require their own official resource-scoped tokens. Share links need no account login or management secret. Do not protect the entire Worker with Cloudflare Access, as it would block subscription clients.

Open the frontend and enter the secret backend path in its native configuration dialog, or initialize the owner browser with `/?magicpath=<secret-path-without-leading-slash>`. The browser saves its backend configuration. Anyone holding this path can manage the installation, so treat it as an owner credential; share only the generated `/share/...?...token=...` links. The public frontend shell contains no management secret and cannot read data without it.

For example, setting the Actions secret to either `sub` or `/sub` gives the backend URL `https://<worker-host>/sub`. Enter `/sub` in the frontend's backend configuration dialog, or open `https://<worker-host>/?magicpath=sub`. Management requests use `/sub/api/...`; public share links still use `/share/...` without this prefix.

Create and revoke shares using the official Share UI. Tokens use Web Crypto through the pinned upstream Nano ID dependency. The official token validation, expiration, resource scope and use-count rules are retained. Share creation and consumption are serialized with the installation's SQLite state. Invalid, revoked, expired and exhausted tokens return 404. The adapter does not enable the optional invalid-share fake-node fallback.

GitHub Actions is the source of truth for the management path: each successful deploy reapplies the repository secret to the Worker. Change the GitHub secret and dispatch the deploy workflow to rotate the path; browsers then need the new backend path. Independent share tokens and stored subscriptions are unaffected by a management-path rotation. After deployment, verify that unprefixed `/api/subs` and `/download/<name>` return 404, the owner path permits management, and a generated public share downloads without cookies or login. Use frontend backup export before rotating/replacing infrastructure.

Preview URLs are disabled because historical Worker versions predate the native access guard. Keep `preview_urls = false`; otherwise an old preview may expose the same installation through an older adapter.

## Deploy through Actions

Push `main` or dispatch `Deploy Sub-Store to Cloudflare`.

1. Build the pinned official frontend with `VITE_API_URL=/` and the Workers capability/source patches.
2. Install locked Worker dependencies, generate runtime types and typecheck.
3. Run official API integration tests, including CRUD, preview, six exporters, collections, files, backups, concurrent writes and remote HTTP.
4. Apply the required backend path secret, then deploy the Worker, SQLite Durable Object class and frontend assets together.

The `official-v3` Durable Object starts with empty official Sub-Store data. No previous D1 data is imported. Its SQLite data persists across deploys, restarts and eviction; use the frontend backup export before major changes. Existing old Cloudflare resources are not used by this implementation.

## Local verification

```sh
cd worker
npm ci
npm run typecheck
cd ..
node scripts/sync-official-frontend.mjs
node scripts/test-worker.mjs
cd worker
npm run test:background
```

The contract test creates uniquely named sample subscriptions, collections and files, then removes only its own fixtures. To test an already-running local Worker or deployed service:

```sh
WORKER_TEST_URL=http://127.0.0.1:8787/sub node tests/contract.mjs
```

## Upstream updates

Backend and frontend revisions are pinned to prevent accidental API/runtime drift. Update the pins deliberately, regenerate the backend with `node scripts/build-official-backend.mjs`, review the generated changes, and rerun integration and browser acceptance. The backend build uses `scripts/official-backend-lock.json` to fix upstream dependency versions.

There is currently no automatic upstream-sync workflow in this repository. A new upstream version does not change the running service until reviewed and deployed.

## Domain and limitations

`workers.dev` serves both the frontend and API; a custom domain may be bound to the same Worker. API/download/share paths are explicitly routed to the Worker before SPA fallback.

User JavaScript is interpreted with QuickJS/WASM. Node-only modules, local files/MMDB, client proxy/policy routing and complete Node cron/notification implementations remain unavailable. See README for supported bridges, size limits and tested functionality.

## Data compatibility and rollback

Export an official backup before deploying this storage change. Existing single-value preferences remain readable, and new chunk tables are created in the same `official-v3` object. No data is moved to a new installation.

Once a preference exceeds 1.9 MB, an older adapter cannot read its chunks. Its legacy row contains an invalid-JSON compatibility marker so it fails instead of interpreting the installation as empty. Roll back only to an adapter that supports this chunk layout, or restore a verified backup using a compatible adapter. Do not claim a plain old-code rollback is sufficient. Test backup restoration in an isolated installation before a production rollback.
