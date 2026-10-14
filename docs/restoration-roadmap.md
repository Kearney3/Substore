# Cloudflare 免费方案还原原版 Sub-Store：差距与路线

日期：2026-10-15。约束不变：仅使用 Workers Free + SQLite Durable Object，不引入付费产品、VPS 或外部常驻服务。原有阶段设计见 [full-substore-free-plan.md](full-substore-free-plan.md)，已实现范围见 [free-plan-implementation.md](free-plan-implementation.md)。

## P0 脚本覆写（本轮完成，待提交部署）

原版的“覆写”是 mihomo 配置文件上的 Script Operator：

- **YAML 覆写**：脚本内容为 YAML 时，与配置做 deep-merge（主运行时完成，不需要解释器）。
- **JavaScript 覆写**：定义 `main(config)`（可 async），官方快捷包装把 `$content` 解析成对象、调用 `main`、再序列化。与 Clash Verge Rev / Mihomo Party 扩展脚本写法兼容。

现状与修复：

| 项 | 结果 |
| --- | --- |
| 已部署版本（`main` 分支 HEAD） | 所有用户脚本被 `workersUnsupportedScript` 拒绝，覆写不可用。QuickJS 脚本支持只存在于未提交的工作区。 |
| 工作区 QuickJS 执行器 | 本地、远程链接、订阅/集合来源的 mihomo 配置均可覆写；`/api/file/:name` 下载与预览一致。 |
| 修复：脚本大小 | 官方快捷/覆写包装会把用户脚本内联两次，原 128 KiB 上限实际只允许约 64 KiB 脚本，76 KiB 的覆写即失败。改为求值源码 512 KiB（用户脚本 256 KiB）；实测 980 KiB 包装源码编译仅占 3.3 MiB guest 内存。 |
| 修复：ProxyUtils 桥接 | 新增 `getFlag`、`removeFlag`、`getISO`、`isIPv4/isIPv6/isIP`、`isValidUUID`、`getRandomPort`、`hex_md5`、`download`、`doh`、`JSON5`。 |
| 验证 | 合同测试新增 YAML 覆写、async `main` + `$arguments` + 订阅来源 + 文件下载、150 KiB 覆写、ProxyUtils 辅助函数。真实公开覆写脚本（26 KiB，2,000 节点）本地约 0.4 s。 |

上线步骤：提交工作区 → 推送 `main` 触发部署工作流 → 在线上文件页创建“mihomo 配置”并添加脚本操作验证。线上 CPU/冷启动未验证。

## 剩余差距（按优先级）

| 优先级 | 功能 | 原版 | 当前 | 免费方案做法 |
| --- | --- | --- | --- | --- |
| P1 | 脚本 API 完整度 | Node `new Function`，可传回调、`require`、完整 Buffer | 回调传给 host 被拒；无 `require`；Buffer 子集；`ProxyUtils.process/MMDB/Gist/ipAddress/age` 未桥接 | 先收集真实脚本失败日志，再按频率桥接；`ProxyUtils.process` 可复用 scriptDepth 防递归。回调类 API 改为 guest 端实现 |
| P1 | 脚本时限 | 无限制 | 3 秒（含 async 等待）、2,000 次中断 | 区分 CPU 中断预算与网络等待预算；网络等待放宽到约 10 秒，仍受请求 25 秒总时限约束 |
| P1 | 下载体积 | 无硬限制 | 单次下载 1 MiB | 大订阅/远程规则文件常超 1 MiB；按类型提高到 4–5 MiB 并测 DO 内存 |
| P2 | GeoIP / ASN（MMDB） | 读取本地 MMDB | 不支持 | 从用户配置的 URL 拉取 MMDB，存入 Cache API 或 DO 分块，纯 JS 读取器查询；需单独体积上限 |
| P2 | 经代理下载订阅 | HTTP/SOCKS5 代理 | 不支持 | Workers `connect()` TCP sockets（免费可用）实现 HTTP CONNECT / SOCKS5 客户端，仅用于下载 |
| P2 | Gist 备份/同步 | 官方路由 | 路由存在，未用真实 GitHub 验证 | 用测试 token 做一次真实上传/下载验收 |
| P3 | 通知 | Shoutrrr 多渠道 | HTTP 模板/webhook | 按需增加 Bark/Telegram 等纯 HTTP 渠道 |
| 不可行 | 节点可用性检测（http_meta）、mihomo 内核、子进程、本地任意文件 | Node + 二进制 | 不支持 | 免费 Workers 无法运行二进制；保持明确报错 |

## 执行顺序

1. 提交并部署 P0，线上验证覆写。
2. 开启日志（`logsMaxCount`）收集脚本失败原因，据此做 P1 API 桥接与时限调整。
3. P1 下载体积；P2 按用户需求选择 MMDB 或代理下载。
4. 每项都扩充 `tests/contract.mjs`，与锁定官方版本做原生对比（`tests/native-parity.mjs`）。
