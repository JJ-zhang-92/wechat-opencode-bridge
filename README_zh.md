# wechat-opencode-bridge

从微信操控 [OpenCode](https://github.com/anomalyco/opencode)。自然语言输入，自然语言输出——本地 LLM（ollama qwen2.5:7b）驱动。

```
微信 → ilink API → wx-bridge (Node.js) → OpenCode Serve → DeepSeek/V4 API
                     ↕ ollama qwen2.5:7b
                  NL路由 + 输出翻译
```

## 特性

**双向 NL。** 输入端：关键词正则 (<1ms) + LLM 上下文分类 (~500ms)。输出端：正则替换 (<1ms) + LLM 兜底。用户永远看不到 session ID 和斜杠命令。

**一键启动。** `node wx-bridge.mjs`。自动 spawn OpenCode serve、连接 SSE、开始长轮询微信。Ctrl+C 同时关掉 bridge 和 serve。

**Session 索引。** 启动时预构建 70+ 个 session 标题和项目目录，注入每次 LLM 调用。LLM 始终知道有哪些会话。

**忙态保护。** Session 正在处理时发消息不会静默中断——bridge 暂存消息并提示确认。

**权限分级。** 低风险（read、list、show）自动通过。危险操作（delete、rm、purge）必须弹窗确认。灰色地带交给 LLM 判断。

## 快速开始

```bash
set ILINK_TOKEN=your-bot-id@im.bot:your-token
node wx-bridge.mjs
```

Bridge 自动启动 `opencode serve --port 4097`，检测 ollama，开始轮询。首次使用给 Bot 发任意消息建立 `context_token`。

## 使用方法

### 自然语言（Phase 1 正则 + Phase 2 LLM）

不需要记命令，说人话就行：

| 你说 | 桥做 |
|------|------|
| `切换专利` `打开 Pt催化实验` | 模糊标题匹配切换会话 |
| `列出` `全部` `看看` | 浏览所有会话 |
| `最近` | 最近用过的会话 |
| `统计` | 会话分布统计 |
| `停下` `别跑了` `别干了` | 中断当前任务 |
| `强制` `打断` | 中断并发送排队消息 |
| `同意` `好` `行` | 通过权限请求 |
| `拒绝` `不行` | 拒绝权限请求 |
| `搜索 douyin` | 搜索会话 |
| `新建 测试` `建一个` | 创建新会话 |
| `帮助` | 显示帮助 |
| `状态` `当前` | 当前会话和模型 |
| 其他内容 | 直接发给 AI |

### 输出——纯自然语言

Bridge 所有输出都经过翻译。用户永远看不到 session ID：

```
翻译前                              → 翻译后
─────────────────────────────────────────
✅ Switched to: 专利 (ses_abc)       → 切换到「专利」了。
Session: ses_abc\nModel: pro         → 当前用pro。
🔍 3 matches:[0] 标题 (ses_x)        → 找到3个：「标题」「标题」
/confirm  /deny                       → 同意还是拒绝？
```

AI 回复直接透传不翻译——翻译器只处理 bridge 自身生成的输出。

### 命令（快捷方式）

| 命令 | 别名 | 作用 |
|------|------|------|
| `/sessions` | `/s` `/l` `/list` | 浏览：摘要 → 项目过滤 → 分页 |
| `/recent` | `/r` | 最近会话；`/r N` 切换 |
| `/stats` | `/st` | 项目分布 |
| `/new` | `/n` | 新建会话 |
| `/resume` | — | 模糊切换：关键词 / 精确ID / 序号 |
| `/stop` | — | 中断当前任务 |
| `/force` | — | 中断+发送排队消息 |
| `/confirm` `/deny` | — | 响应权限弹窗 |
| `/search` | — | 搜索所有会话 |
| `/delete` | `/rm` | 删除（二次确认） |
| `/compact` | — | 压缩上下文到新会话 |
| `/model` | — | 查看/切换模型 |
| `/system` | — | 查看/设定系统指令 |
| `/nl` | — | 切换自然语言模式 |
| `/current` | — | 当前会话和模型 |
| `/help` | — | 帮助 |

## 架构

```
┌──────┐   ilink 长轮询     ┌──────────────────────┐   prompt_async + SSE   ┌──────────┐
│ 微信 │ ◄────────────────► │   wx-bridge.mjs      │ ◄────────────────────► │ OpenCode │
└──────┘                     │                      │     /global/event      │  Serve   │
                             │  ┌────────────────┐  │                        └──────────┘
                             │  │ 输入端 NL 路由  │  │
                             │  │ P1: 正则 (15)  │──┼── ollama qwen2.5:7b
                             │  │ P2: LLM + 上下 │  │
                             │  └────────────────┘  │
                             │                      │
                             │  ┌────────────────┐  │
                             │  │ 输出端 NL 翻译  │  │
                             │  │ P1: 正则 (32)  │  │
                             │  │ P2: LLM 兜底   │  │
                             │  └────────────────┘  │
                             │                      │   AI 回复：直接透传
                             └──────────────────────┘
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ILINK_TOKEN` | *(必填)* | 微信 ilink bot Bearer token |
| `ILINK_BASE` | `https://ilinkai.weixin.qq.com` | ilink API 地址 |
| `SERVE_URL` | `http://127.0.0.1:4097` | OpenCode serve 地址 |
| `POLL_MS` | `30000` | 长轮询超时（毫秒） |
| `DATA_DIR` | `~/.cc-connect/wx-bridge` | 状态和日志路径 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `OLLAMA_URL` | `http://localhost:11434` | ollama 地址 |
| `NL_CLASSIFY_MODEL` | `qwen2.5:7b` | 意图分类模型 |
| `NL_MODE` | `auto` | `auto` / `on` / `off` |
| `NL_CONTEXT_ENABLED` | `true` | 设为 `0` 关闭 LLM 上下文 |
| `PERMISSION_AUTO_APPROVE` | `low` | `off` / `low` / `medium` / `high` |
| `CAPABILITY_HINT` | *见代码* | 注入 LLM 上下文的能力提示 |
| `OPENCODE_BIN` | *(自动)* | opencode.exe 路径 |
| `WX_ALLOW_FROM` | *(无)* | 限制单个微信用户 |

## 测试

```bash
node test-nl.js        # NL 分类器: 33/34 pass
node test-beg.js       # 命令 + 翻译 + 权限: 31/31 pass
node test-sse-live.js  # SSE 全链路: prompt_async → part → idle
```

## 使用限制

- 个人使用。单人单 Agent 设计。
- 仅 Windows。macOS/Linux 需设 `OPENCODE_BIN`。
- 仅 OpenCode。通过 SDK + CLI 通信。
- Session 列表用 execSync，阻塞约 1 秒（单人可接受）。
- NL LLM 分类增加约 500ms（关键词匹配即时）。

## License

MIT
