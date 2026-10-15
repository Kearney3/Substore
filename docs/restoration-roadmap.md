# Cloudflare 免费方案还原原版 Sub-Store：差距与路线

日期：2026-10-15。约束不变：仅使用 Workers Free + SQLite Durable Object，不引入付费产品、VPS 或外部常驻服务。原有阶段设计见 [full-substore-free-plan.md](full-substore-free-plan.md)，已实现范围见 [free-plan-implementation.md](free-plan-implementation.md)。

## P0 脚本覆写（本轮完成，待提交部署）

原版的“覆写”是 mihomo 配置文件上的 Script Operator：

- **YAML 覆写**：脚本内容为 YAML 时，与配置做 deep-merge（主运行时完成，不需要解释器）。
- **JavaScript 覆写**：定义 `main(config)`（可 async），官方快捷包装把 `$content` 解析成对象、调用 `main`、再序列化。与 Clash Verge Rev / Mihomo Party 扩展脚本写法兼容。

现状与修复：

| 项 | 结果 |
| --- | --- |
| 部署 | `ac7d12f` 及更早版本拒绝所有用户脚本；QuickJS 执行器自 `d317a54` 起已部署。 |
| QuickJS 执行器 | 本地、远程链接、订阅/集合来源的 mihomo 配置均可覆写；`/api/file/:name` 下载与预览一致。 |
| 修复：脚本大小 | 官方快捷/覆写包装会把用户脚本内联两次，原 128 KiB 上限实际只允许约 64 KiB 脚本，76 KiB 的覆写即失败。改为求值源码 512 KiB（用户脚本 256 KiB）；实测 980 KiB 包装源码编译仅占 3.3 MiB guest 内存。 |
| 修复：ProxyUtils 桥接 | 新增 `getFlag`、`removeFlag`、`getISO`、`isIPv4/isIPv6/isIP`、`isValidUUID`、`getRandomPort`、`hex_md5`、`download`、`doh`、`JSON5`。 |
| 修复：覆写兼容（2026-10-15） | ① 单行 JS（如 `function main(c) { c.tun = { enable: true }; return c }`）同时是合法 YAML 映射，官方 YAML 分支会合并垃圾键并静默跳过脚本——定义 `main()` 的脚本现在直接走 JS 覆写；② 编辑器示例使用的 `ProxyUtils.yaml.load/dump/parse/stringify` 补齐（此前连同 `produceArtifact` 示例一起报 `not a function`）；③ 补充 Node 下可用的 `structuredClone`、`atob/btoa`、`URL/URLSearchParams`、`TextEncoder/TextDecoder`、`setTimeout/clearTimeout`。与官方一致的行为保留：预览中没有 `$options`；`main` 不返回值会报错。 |
| 验证 | 合同测试新增 YAML 覆写、async `main` + `$arguments` + 订阅来源 + 文件下载、150 KiB 覆写、ProxyUtils 辅助函数。真实公开覆写脚本（26 KiB，2,000 节点）本地约 0.4 s。 |

线上验证：在文件页创建“mihomo 配置”并添加脚本操作。线上 CPU/冷启动未验证。

## 自定义脚本与代理策略实测（2026-10-15）

本地 workerd 与锁定官方后端（Node，离线）用相同请求对比。社区脚本取自公开仓库当日版本，仅用于测试，不随本仓库分发。

| 脚本 / 场景 | Workers | 官方 Node | 结论 |
| --- | --- | --- | --- |
| Keywos `rename.js`（默认、`out=en&flag&nm`） | 成功 | 成功 | 输出一致 |
| xream `chinese-conv.js`（88 KB 简繁转换） | 成功 | 成功 | 输出一致 |
| xream `sing-box/template.js`（文件脚本 + `produceArtifact` + JSON5） | 修复前失败，修复后成功 | 成功 | 输出一致 |
| xream `check/entrance.js`（经 ip-api 查询入口信息） | 成功，按 IP 改名 | 未对比（需联网） | 可用；域名服务器按脚本设计跳过 |
| xream `availability.js` / `geo.js`（要求 Surge/Loon/Egern） | 明确报错 | 官方回退为无操作，静默不生效 | 有意差异：不吞错误 |
| xream `http_meta_*.js`（需 http_meta 内核） | 明确报错 | 同样需要 http_meta | 免费 Workers 不可行 |
| xream `clash-mi-encrypt.js`（`require('crypto')`） | 明确报错 | 此适配下同样失败 | 无 `require` |

本轮修复：

1. **文件脚本回退**：顶层文件脚本先以函数形式执行，看不到 `$content`；若脚本自行捕获该错误并抛出自己的消息，原适配不再回退到快捷形式（sing-box 模板脚本因此报“配置文件不是合法的 JSON5 格式”）。现在与官方一致：文件输入总是回退到快捷形式，真实错误仍会在快捷形式中抛出。
2. **代理策略不再静默直连**：官方 QX 风格 HTTP 分支只转发 `opts.policy`，脚本传入的 Surge/Loon `node`、`policy-descriptor` 或 Node `proxy` 会被丢弃并直连——测落地/测活结果会是 Worker 出口而非节点。现在全部转发并明确拒绝（`DIRECT` 除外）。
3. **脚本可见错误原因**：host 异步失败此前只显示 “Script HTTP or async host operation failed”，现在附带原因（截断 300 字符）。
4. **日志脱敏**：后端路径按整段路径（`/sub`）脱敏，而不是任意子串；此前路径为 `sub` 时日志中所有 “sub” 都被替换。

代理策略实测：订阅 `proxy=策略名`、设置 `defaultProxy=策略名`、脚本 `$substore.http` 的 `opts.policy` / `node` / `policy-descriptor` / `proxy` 均明确失败；`proxy=DIRECT` 与不设置时正常。注意：从 Node 版恢复的备份若设置了 `defaultProxy`，所有远程订阅都会失败，需在设置中清空。订阅下载失败的提示沿用官方“请查看日志”，原因需开启日志（`logsMaxCount`）查看。

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
