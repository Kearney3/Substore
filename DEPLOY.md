# Deployment

## 1. Create GitHub repository

Upload the entire repository, including `.github/`, `worker/`, `scripts/`, `tests/` and `.upstream/`.

## 2. Configure GitHub secrets

Settings → Secrets and variables → Actions → New repository secret:

`CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_ACCOUNT_ID`

Required token scope: Workers Scripts edit, D1 edit and Workers KV Storage edit for the target account. The D1 permission is required for database checks and migrations; a successful `wrangler whoami` does not prove D1 access. R2 is not used by the current Worker and is not required.

Optional application secret:

`SUB_STORE_ADMIN_TOKEN`

If configured, the GitHub Actions deployment automatically writes it to the Worker as the `ADMIN_TOKEN` secret.

## 3. Push main

```bash
git add .
git commit -m "feat: initial deployment"
git push origin main
```

GitHub Actions will:

1. Download and build the official Sub-Store Front-End using pnpm 11.0.9.
2. Install and typecheck the Worker, then run local contract tests.
3. Verify the existing `DB` binding and apply remote D1 migrations.
4. Configure the optional admin token and deploy Worker and frontend assets.

Migrations run before deployment so a new Worker never serves requests against an uninitialized database.

## 4. Automatic upstream tracking

`upstream-sync.yml` runs every 30 minutes and can also be started manually.

- Frontend update: automatically rebuild and deploy.
- Backend update: fetch the new upstream package metadata and changed-file list; run a compatibility gate; safe changes continue to deploy the current Worker compatibility layer; unsafe Node-specific changes stop production deployment and open/update an issue.

The design intentionally does not copy the official Node.js backend into Workers.

## 5. Custom domain

After the first successful deployment, bind a custom domain in Cloudflare. The Worker can serve both the official frontend and API from the same host.

## 6. Resource bindings and retries

`worker/wrangler.toml` explicitly binds the existing `sub-store-cloudflare-cache` KV namespace and `sub-store-cloudflare-db` D1 database in the Kearney account. Re-running Actions reuses these resources rather than creating duplicate names after a partial failure.

When deploying this fork to another account, create its KV namespace and D1 database once and replace `id`, `database_name` and `database_id` in the configuration. Use the same account in `CLOUDFLARE_ACCOUNT_ID`. Resource IDs are identifiers, not API tokens.

R2 is omitted because the current Worker does not use it. Add an R2 binding only when a feature requires it and R2 is enabled for the account.

## TypeScript runtime types

The Worker now follows Cloudflare's recommended `wrangler types` flow. Do not add `@cloudflare/workers-types` back to `worker/package.json`; `npm run typecheck` generates `worker/worker-configuration.d.ts` from `wrangler.toml` before running `tsc`.
