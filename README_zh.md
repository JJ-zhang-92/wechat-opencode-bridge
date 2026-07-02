# wechat-opencode-bridge

从微信直接操控本地 [OpenCode](https://github.com/anomalyco/opencode) 编程助手。浏览、搜索、切换跨目录的所有 session，支持**自然语言**命令（本地 LLM 驱动）。

```
微信 → ilink API → wx-bridge (Node.js) → OpenCode Serve API → SQLite 会话数据库
                                     ↕
                              ollama (本地 LLM)
```

## 特性

- **微信自然语言操控** — 说「切换专利」即可，无需记 `/resume 专利`。关键词快匹配 (<1ms) + ollama LLM 兜底 (~500ms)
- **防误中断** — session 运行中发消息不会静默打断，返回「正忙，回复 /force 确认中断」提示
- **OpenCode 绑定启动** — bridge 启动时自动 spawn `opencode serve`，退出时自动 kill，一条命令搞定
- **全量 session 管理** — 列出所有目录的所有 session，模糊搜索切换，创建/删除/compact
- **自定义 system prompt** — `/system` 设定，经 OpenCode 原生 `system` 参数注入
- **权限交互** — `/confirm` `/deny` 处理权限请求，自然语言「同意」「拒绝」也支持
- **SSE 异步回复** — REST 发 prompt + SSE 收结果，支持长任务
- **长轮询消息** — 与 cc-connect、OpenClaw 同款 ilink bot API

## 环境要求

- **Node.js** 24+
- **OpenCode CLI** (`npm install -g opencode-ai`)
- **微信 ilink bot token** — 通过 [cc-connect](https://github.com/chenhg5/cc-connect) 等工具获取
- **ollama**（可选 — NL 分类用；无 ollama 时关键词匹配仍可用）

## 快速开始

```bash
# 1. 设置 ilink token
set ILINK_TOKEN=your-bot-id@im.bot:your-token

# 2. 启动桥接（自动启动 opencode serve）
node wx-bridge.mjs
```

Bridge 启动流程：
1. 检测 ollama → 启用 NL 模式
2. 如果 opencode serve 未运行则自动 spawn
3. 等待 serve 就绪
4. 开始长轮询微信消息

首次使用，先给 Bot 发任意消息以建立 `context_token`。

## 使用方法

### 自然语言模式（检测到 ollama 时默认启用）

| 你说 | 相当于 |
|------|--------|
| `列出所有会话` | `/list` |
| `切换专利` | `/resume 专利` |
| `新建一个会话` | `/new` |
| `停下` `别跑了` | `/stop` |
| `强制` `打断` | `/force` |
| `同意` `好的` `行` | `/confirm` |
| `拒绝` `不行` | `/deny` |
| `搜索 douyin` | `/search douyin` |
| `什么模型` `状态` | `/current` |
| `帮助` `怎么用` | `/help` |
| 其他内容 | → 发送给 active session |

微信端 `/nl on` / `/nl off` 随时切换。

### 命令参考

| 命令 | 说明 |
|------|------|
| `/list` | 列出所有目录的所有 session |
| `/list [N]` | 查看第 N 个项目中的 session |
| `/list <名称>` | 查看匹配项目中的 session |
| `/resume` | 同上 |
| `/resume <关键词>` | 模糊搜索并切换 — `Pt催化`、`专利`、`douyin` |
| `/resume [N]` | 按列表序号切换 |
| `/resume ses_xxx` | 按精确 session ID 切换 |
| `/new [标题]` | 创建新 session |
| `/stop` | 中断当前任务 |
| `/force` | 中断当前任务并发送排队消息 |
| `/confirm` | 批准权限请求 |
| `/deny` | 拒绝权限请求 |
| `/search <词>` | 搜索所有 session |
| `/delete <id>` | 删除 session（二次确认） |
| `/compact` | 压缩上下文到新 session |
| `/model` | 查看当前模型 |
| `/model <名称>` | 切换模型（如 `xiaomi/mimo-v2.5`） |
| `/system` | 查看当前 system prompt |
| `/system <文本>` | 设定 system prompt |
| `/system off` | 关闭 system prompt |
| `/nl` | 查看 NL 模式状态 |
| `/nl on` / `/nl off` | 开关自然语言模式 |
| `/current` | 查看当前 session 和模型 |
| `/help` | 显示所有命令 |

### 忙态保护

session 正在运行中时，发新消息不会静默打断：

1. Bridge 回复：「⏳ Session 正忙，回复 /force 强制中断并发送，或等待完成」
2. 你的消息被暂存
3. 回复 `/force` → 中断当前任务 → 发送你的消息
4. 等待完成 → 暂存自动清除 → 重新发送你的消息

## 配置

所有设置通过环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ILINK_TOKEN` | *(必填)* | 微信 ilink bot Bearer token |
| `ILINK_BASE` | `https://ilinkai.weixin.qq.com` | ilink API 地址 |
| `SERVE_URL` | `http://127.0.0.1:4097` | OpenCode serve 地址 |
| `POLL_MS` | `30000` | 长轮询超时（毫秒） |
| `DATA_DIR` | `~/.cc-connect/wx-bridge` | 状态和日志存储路径 |
| `LOG_LEVEL` | `info` | 日志级别 (`debug`/`info`/`warn`/`error`) |
| `OLLAMA_URL` | `http://localhost:11434` | ollama API 地址 |
| `NL_CLASSIFY_MODEL` | `qwen2.5:7b` | 意图分类模型 |
| `NL_MODE` | `auto` | `auto` / `on` / `off` |
| `OPENCODE_BIN` | *(自动检测)* | opencode.exe 路径（覆盖自动检测） |
| `WX_ALLOW_FROM` | *(无)* | 限制为单个微信用户 |

## 架构

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

```
┌──────┐   ilink 长轮询     ┌─────────────────┐   prompt_async + SSE   ┌──────────┐
│ 微信 │ ◄────────────────► │  wx-bridge.mjs  │ ◄────────────────────► │ OpenCode │
└──────┘                     │                  │                        │  Serve   │
                             │  ┌────────────┐ │                        └──────────┘
                             │  │ NL 路由器   │ │                             ▲
                             │  │ 关键词匹配  │ │                        spawn│serve
                             │  │ + LLM 分类 │ │                        ┌──────────┐
                             │  └─────┬──────┘ │                        │ opencode │
                             │        │ ollama │                        │  CLI     │
                             └────────┼────────┘                        └──────────┘
                                      ▼
                              ┌──────────────┐
                              │ ollama       │
                              │ qwen2.5:7b   │
                              └──────────────┘
```

## 设计理念

为**单人、单 Agent** 设计。消息串行处理，`await` 天然消除竞争、状态损坏和并发过载。

- 消息串行 — 同一时间只有一条消息在执行
- 无状态竞争 — 状态更新在同步执行流中完成
- 无需限流 — 单人使用无法过载

## 使用限制

- **个人使用** — 多用户需加请求串行化和状态锁
- **仅支持 Windows** — opencode.exe 路径检测使用 Windows 规范。macOS/Linux 需设置 `OPENCODE_BIN`
- **仅支持 OpenCode** — 通过 SDK + CLI 与 OpenCode Serve 通信
- session 列表使用 `execSync`，会阻塞 event loop 约 1 秒（单人可接受）
- NL LLM 分类增加约 500ms 延迟（关键词匹配即时）

## 常见问题

**Q: 首次发消息提示 "No active session"？**
A: 用 `/resume <关键词>` 或在 NL 模式下说「切换 <关键词>」。

**Q: 412/400 错误是什么？**
A: 412 = ilink token 过期，通过 cc-connect 重新绑定。400 = 请求体中传了多余字段。

**Q: 跨目录 session 切换如何实现？**
A: `opencode session list --format json` 返回全局 session。Bridge 列出全部后，OpenCode serve 原生支持跨目录消息发送。

**Q: 不用 ollama 能用吗？**
A: 能。关键词匹配不依赖 ollama。设 `NL_MODE=off` 完全关闭 NL，或微信端 `/nl off`。

**Q: 如何一起关闭 bridge 和 OpenCode？**
A: 终端 `Ctrl+C` — bridge 退出前自动 kill OpenCode serve。

## License

MIT
