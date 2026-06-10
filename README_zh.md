# wechat-opencode-bridge

从微信直接操控本地 [OpenCode](https://github.com/anomalyco/opencode) 编程助手。列出、搜索、切换跨目录的所有 session，支持自然语言模糊匹配。

```
微信 → ilink API → wx-bridge (Node.js) → OpenCode Serve API → SQLite 会话数据库
```

## 特性

- **全量 session 管理** — 列出所有目录的所有 session，按标题模糊搜索切换，创建新 session
- **自然语言切换** — `/resume Pt催化实验` 无需记忆 session ID
- **多关键词模糊匹配** — 同时对标题和目录路径搜索
- **自定义 system prompt** — 通过 `/system` 设定，经 OpenCode 原生 `system` 参数注入，不混入用户文本
- **零外部依赖** — 仅使用 Node.js 内置模块（`http`、`https`、`fs`、`child_process`、`crypto`）
- **长轮询消息** — 使用与 cc-connect、OpenClaw 同款的 ilink bot API
- **10 分钟超时** — 支持长时间 agent 任务

## 环境要求

- **Node.js** 24+
- **OpenCode CLI** (`npm install -g opencode-ai`)
- **微信 ilink bot token** — 通过 [cc-connect](https://github.com/chenhg5/cc-connect) 等工具获取

## 快速开始

```bash
# 1. 启动 OpenCode serve
opencode serve --port 4096 --hostname 127.0.0.1

# 2. 设置 ilink token
set ILINK_TOKEN=your-bot-id@im.bot:your-token

# 3. 启动桥接
node wx-bridge.mjs
```

首次运行后，先从微信给 Bot 发一条任意消息以建立 `context_token`。

## 微信命令

| 命令 | 说明 |
|------|------|
| `/list` | 列出所有目录的所有 session |
| `/resume` | 同上 |
| `/resume <关键词>` | 模糊搜索并切换 — 如 `Pt催化`、`专利`、`douyin` |
| `/resume [N]` | 按列表序号切换 |
| `/resume ses_xxx` | 按精确 session ID 切换 |
| `/new [标题]` | 创建新 session |
| `/model` | 查看当前模型 |
| `/model <名称>` | 切换模型（如 `xiaomi/mimo-v2.5`） |
| `/system` | 查看当前 system prompt |
| `/system <文本>` | 设定 system prompt |
| `/system off` | 关闭 system prompt |
| `/current` | 查看当前 session 和模型 |
| `/help` | 显示所有命令 |
| *任意文本* | 发送到当前活跃 session（AI 回复） |

## 配置

通过环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ILINK_TOKEN` | *(必填)* | 微信 ilink bot Bearer token |
| `ILINK_BASE` | `https://ilinkai.weixin.qq.com` | ilink API 地址 |
| `SERVE_URL` | `http://127.0.0.1:4096` | OpenCode serve 地址 |
| `SERVE_USER` | `opencode` | Basic auth 用户名 |
| `SERVE_PASS` | *(自动检测)* | Basic auth 密码 |
| `POLL_MS` | `30000` | 长轮询超时（毫秒） |
| `DATA_DIR` | `~/.cc-connect/wx-bridge` | 状态和日志存储路径 |
| `LOG_LEVEL` | `info` | 日志级别 |

## 架构

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 常见问题

**Q: 首次发消息提示"No active session"？**
A: 先用 `/resume <关键词>` 切换到一个已有 session。

**Q: 412/400 错误是什么意思？**
A: 412 = ilink token 过期，通过 cc-connect 重新绑定。400 = 不要在请求体中传 `model` 参数。

**Q: 为什么超时设为 10 分钟？**
A: OpenCode serve API 是同步的——它会保持 HTTP 连接直到 agent 完成。复杂任务可能耗时数分钟。

**Q: 跨目录 session 切换如何实现？**
A: `opencode session list --format json` 返回全局所有 session（不限目录）。桥接列出全部后，`POST /session/:id/message` 原生支持跨目录消息发送。

## License

MIT
