# Sub-Store Cloudflare V2

V2.0.1 hotfix: migrated Worker TypeScript definitions to `wrangler types` and fixed the Hono admin middleware signature for current Hono TypeScript definitions.

# Sub-Store Cloudflare Workers V2

“官方 Sub-Store 前端 + Cloudflare Workers 兼容层 + D1/KV/R2 + GitHub Actions 全自动上游跟踪”。

## 目标

- 每次部署都从官方 `Sub-Store-Front-End` 拉取最新源码并构建，不在本仓库复制官方前端源码。
- 定时检查官方 `Sub-Store` 后端与前端的上游 HEAD。
- 上游前端变化：自动构建、测试并部署。
- 上游后端变化：自动做兼容性扫描与 Worker 合约测试；如果发现 Node 专属运行时变化，自动停止生产部署并创建/更新 GitHub Issue；不会把官方 Node.js backend 直接塞进 Workers。
- 部署配置显式复用已创建的 D1/KV 资源，重跑不会重复创建同名资源；当前 Worker 不使用 R2。
- D1 migrations 使用 binding `DB`，在部署前执行 migration。
- Worker 同时提供静态前端和 API，默认单域名部署。

## 重要事实

官方 backend 当前仍是 Node.js/Express，并使用 `cron`、`fetch-socks`、`http-proxy-middleware` 等 Node 生态能力，因此 V2 使用“上游跟踪 + Workers 兼容层”而不是伪装成官方 backend 的 1:1 运行时移植。

## GitHub Secrets

只需要：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

API Token 至少需要当前账户的 Workers Scripts Edit、D1 Edit 和 Workers KV Storage Edit 权限。`whoami` 成功不能证明 D1 权限可用。

可选：

- `SUB_STORE_ADMIN_TOKEN`：Worker 管理 API 的 Bearer Token；设置后 GitHub Actions 会自动执行 `wrangler secret put ADMIN_TOKEN`。

## 首次部署

1. 上传整个仓库到 GitHub。
2. 设置上述 Cloudflare Secrets。
3. 推送到 `main`，或在 Actions 手动运行 `Deploy`。
4. Wrangler 根据 `worker/wrangler.toml` 验证已有 D1 绑定。
5. GitHub Actions 执行 D1 migrations。
6. Worker 上线并同时托管 `frontend-dist/`。

当前配置绑定 Kearney 账户已有资源；其他账户部署前需替换 D1/KV 的资源标识，详见 `DEPLOY.md`。

## 自动同步节奏

`.github/workflows/upstream-sync.yml` 默认每 30 分钟运行一次，也支持手动运行。

执行：

1. 查询官方前端 HEAD。
2. 查询官方 backend HEAD。
3. 对比 `.upstream/state.json`。
4. 前端有变化：同步并执行完整构建/测试/部署。
5. backend 有变化：下载上游 `backend/package.json` 与 changed-files 清单，运行兼容性扫描与 Worker 合约测试。
6. 若通过：更新 `.upstream/state.json` 并部署当前 Worker 兼容层。
7. 若失败：不部署生产，并创建/更新 GitHub Issue `upstream-incompatible`。

## 目录

```text
.github/workflows/
  deploy.yml
  upstream-sync.yml
  tests.yml
.upstream/state.json
scripts/
  check-upstream.mjs
  sync-official-frontend.mjs
  test-worker.mjs
worker/
  src/index.ts
  migrations/0001_init.sql
  package.json
  tsconfig.json
  wrangler.toml
tests/
  contract.mjs
```

## 当前 Worker 兼容层

提供：

- `/api/health`
- `/health`
- `/api/utils/env`
- `/api/utils/testJSON`
- `/api/utils/testText`
- `/api/storage` GET/POST
- `/api/subscriptions` GET/POST
- `/api/subscriptions/:name` GET/PUT/DELETE
- `/download/:name`
- 基础远程订阅抓取
- Raw / JSON / Clash / Mihomo 基础输出
- KV 缓存
- D1 持久化
- Cron 健康巡检/缓存清理

这个兼容层不是官方 backend 的完整功能替代；复杂脚本运行、SOCKS 代理链、所有官方转换器和 Node-only API 需要继续逐项迁移。

## What “automatic backend sync” means in V2

The official backend is intentionally **not** copied into this Worker. The workflow tracks its branch/commit and package version, compares changed files, and gates production deployment when runtime-sensitive Node.js components change. This avoids silently deploying incompatible Node.js code to the Workers runtime.

A compatible upstream backend change currently causes a redeploy of the Workers compatibility layer, but does not magically port new Node.js backend features. A new feature that requires Node-only APIs must be implemented in `worker/src/` explicitly; the workflow will open/update an issue instead of silently breaking production.

## 自动上游同步

官方前端和官方后端分支均不写死。GitHub Actions 通过 GitHub API 读取两个官方仓库当前的 `default_branch`，因此不会因为官方将默认分支从 `master`/`main` 调整而导致克隆失败。当前官方 Front-End 默认分支为 `master`。
