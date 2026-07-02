# wechat-opencode-bridge

Control your local [OpenCode](https://github.com/anomalyco/opencode) agent directly from WeChat. Browse, search, and switch sessions across all project directories — with **natural language** commands powered by local LLM.

```
WeChat → ilink API → wx-bridge (Node.js) → OpenCode Serve API → SQLite session DB
                                     ↕
                              ollama (local LLM)
```

## Features

- **Natural language in WeChat** — say "switch to patent" instead of `/resume patent`. Keyword fast-path (<1ms) + ollama LLM fallback (~500ms)
- **No accidental interrupts** — sending a message while the session is busy queues it; reply `/force` to confirm interruption
- **Auto-start OpenCode** — bridge spawns `opencode serve` on startup, kills it on shutdown. One command to launch
- **Full session management** — list all sessions across all directories, fuzzy search by title, create/delete/compact sessions
- **Custom system prompt** — per-session instructions via `/system`, injected through OpenCode's native `system` parameter
- **Permission interaction** — `/confirm` / `/deny` for OpenCode permission requests, supports natural language ("agree", "yes")
- **SSE async replies** — prompt via REST, collect result via Server-Sent Events, supports long-running agent tasks
- **Long-poll transport** — same ilink bot API used by cc-connect and OpenClaw

## Prerequisites

- **Node.js** 24+
- **OpenCode CLI** (`npm install -g opencode-ai`)
- **WeChat ilink bot token** — obtain via [cc-connect](https://github.com/chenhg5/cc-connect) or similar tool
- **ollama** (optional — for NL classification; keywords work without it)

## Quick Start

```bash
# 1. Set your ilink token
set ILINK_TOKEN=your-bot-id@im.bot:your-token

# 2. Start the bridge (auto-starts opencode serve if not running)
node wx-bridge.mjs
```

The bridge will:
1. Detect ollama → enable NL mode
2. Auto-start `opencode serve --port 4097` if not already running
3. Wait for serve to be ready
4. Begin long-polling WeChat messages

Send any message from WeChat to establish the `context_token`. Then you're ready.

## Usage

### Natural Language Mode (default when ollama available)

| You say | Does |
|----------|------|
| `列出所有会话` | `/list` |
| `切换专利` | `/resume 专利` |
| `新建一个会话` | `/new` |
| `停下` `别跑了` | `/stop` |
| `强制` | `/force` |
| `同意` `好的` | `/confirm` |
| `拒绝` | `/deny` |
| `搜索 douyin` | `/search douyin` |
| `什么模型` | `/current` |
| `帮助` | `/help` |
| anything else | → sends to active session |

Toggle with `/nl on` / `/nl off` from WeChat.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/list` | List all sessions across all directories |
| `/list [N]` | Show sessions in project N |
| `/list <name>` | Show sessions in matching project |
| `/resume` | Same as `/list` |
| `/resume <keyword>` | Fuzzy search and switch — `Pt催化`, `专利`, `douyin` |
| `/resume [N]` | Switch by list index |
| `/resume ses_xxx` | Switch by exact session ID |
| `/new [title]` | Create a new session |
| `/stop` | Interrupt current task |
| `/force` | Interrupt current task and send queued message |
| `/confirm` | Approve pending permission request |
| `/deny` | Deny pending permission request |
| `/search <word>` | Search all sessions |
| `/delete <id>` | Delete session (double-confirm) |
| `/compact` | Compress context into a new session |
| `/model` | Show current model |
| `/model <name>` | Switch model (e.g. `xiaomi/mimo-v2.5`) |
| `/system` | Show current system prompt |
| `/system <text>` | Set system prompt |
| `/system off` | Disable system prompt |
| `/nl` | Show NL mode status |
| `/nl on` / `/nl off` | Toggle natural language mode |
| `/current` | Show current session and model |
| `/help` | Show all commands |

### Busy Protection

When the session is processing a task, sending a new message will **not** silently interrupt it. Instead:

1. Bridge replies: "Session is busy. Reply `/force` to interrupt and send, or wait."
2. Your message is queued
3. Reply `/force` → aborts current task → sends your message
4. Wait for it to finish → queue is auto-cleared, re-send your message

## Configuration

All settings via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ILINK_TOKEN` | *(required)* | WeChat ilink bot Bearer token |
| `ILINK_BASE` | `https://ilinkai.weixin.qq.com` | ilink API base URL |
| `SERVE_URL` | `http://127.0.0.1:4097` | OpenCode serve address |
| `POLL_MS` | `30000` | Long-poll timeout (ms) |
| `DATA_DIR` | `~/.cc-connect/wx-bridge` | State and log storage |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |
| `OLLAMA_URL` | `http://localhost:11434` | ollama API address |
| `NL_CLASSIFY_MODEL` | `qwen2.5:7b` | Model for intent classification |
| `NL_MODE` | `auto` | `auto` / `on` / `off` |
| `OPENCODE_BIN` | *(auto-detected)* | Path to opencode.exe (override auto-detect) |
| `WX_ALLOW_FROM` | *(none)* | Restrict to a single WeChat user ID |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md).

```
┌──────────┐   ilink long-poll   ┌─────────────────┐   prompt_async + SSE   ┌──────────┐
│  WeChat  │ ◄──────────────────► │  wx-bridge.mjs  │ ◄────────────────────► │ OpenCode │
└──────────┘                      │                  │                        │  Serve   │
                                  │  ┌────────────┐ │                        └──────────┘
                                  │  │ NL Router  │ │                             ▲
                                  │  │ keywords   │ │                        spawn│serve
                                  │  │ + LLM      │ │                        ┌──────────┐
                                  │  └─────┬──────┘ │                        │ opencode │
                                  │        │ ollama │                        │  CLI     │
                                  └────────┼────────┘                        └──────────┘
                                           ▼
                                   ┌──────────────┐
                                   │ ollama       │
                                   │ qwen2.5:7b   │
                                   └──────────────┘
```

## Design

Built for **single-user, single-agent** usage. Messages are processed sequentially — one-at-a-time `await` eliminates races, state corruption, and concurrent overload.

- No concurrent message processing
- No state race conditions
- No queue or backpressure needed

## Limitations

- **Personal use only**. Multi-user needs request serialization and state locking.
- **Windows-only** — opencode.exe path detection uses Windows conventions. macOS/Linux users set `OPENCODE_BIN`.
- **OpenCode-only** — communicates with OpenCode Serve via SDK + CLI.
- Session listing blocks the event loop ~1s (execSync). Fine for single-user.
- NL classification adds ~500ms latency with LLM fallback (keywords are instant).

## FAQ

**Q: First message gets "No active session"?**
A: Use `/resume <keyword>` or say "切换 <关键词>" in NL mode.

**Q: What does the 412/400 error mean?**
A: 412 = expired ilink token, re-bind via cc-connect. 400 = don't pass extra fields in the message body.

**Q: How does cross-directory session switching work?**
A: `opencode session list --format json` returns ALL sessions globally. The bridge lists them all, and OpenCode serve handles cross-directory messages natively.

**Q: Can I use the bridge without ollama?**
A: Yes. Keyword matching works without ollama. Set `NL_MODE=off` to disable NL entirely, or run `/nl off` from WeChat.

**Q: How do I stop the bridge and OpenCode together?**
A: `Ctrl+C` in the terminal — the bridge kills the OpenCode serve process before exiting.

## License

MIT
