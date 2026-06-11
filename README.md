# wechat-opencode-bridge

Control your local [OpenCode](https://github.com/anomalyco/opencode) agent directly from WeChat. List, search, and switch between sessions across all project directories — with natural-language fuzzy matching.

```
WeChat → ilink API → wx-bridge (Node.js) → OpenCode Serve API → SQLite session DB
```

## Features

- **Full session management** — list all sessions across all directories, switch by fuzzy title search, create new sessions
- **Natural-language resume** — `/resume 程序框图` finds your session without remembering IDs
- **Instant fuzzy matching** — multi-keyword search against session titles and directories
- **Custom system prompt** — set per-session system instructions via `/system`, injected through OpenCode's native `system` parameter
- **Zero dependencies** — pure Node.js built-in modules only (`http`, `https`, `fs`, `child_process`, `crypto`)
- **Long-poll transport** — same ilink bot API used by cc-connect and OpenClaw
- **10-minute timeout** — handles long-running agent tasks

## Prerequisites

- **Node.js** 24+
- **OpenCode CLI** (`npm install -g opencode-ai`)
- **WeChat ilink bot token** — obtain via [cc-connect](https://github.com/chenhg5/cc-connect) or similar tool

## Quick Start

```bash
# 1. Ensure OpenCode serve is running
opencode serve --port 4096 --hostname 127.0.0.1

# 2. Set your ilink token
set ILINK_TOKEN=your-bot-id@im.bot:your-token

# 3. Start the bridge
node wx-bridge.mjs
```

On first run, send any message from WeChat to establish the `context_token`. Then you're ready.

## WeChat Commands

| Command | Description |
|---------|-------------|
| `/list` | List all sessions across all directories |
| `/resume` | Same as `/list` |
| `/resume <keyword>` | Fuzzy search and switch — `Pt催化`, `专利`, `douyin` |
| `/resume [N]` | Switch by list index |
| `/resume ses_xxx` | Switch by exact session ID |
| `/new [title]` | Create a new session |
| `/model` | Show current model |
| `/model <name>` | Switch model (e.g. `xiaomi/mimo-v2.5`) |
| `/system` | Show current system prompt |
| `/system <text>` | Set system prompt |
| `/system off` | Disable system prompt |
| `/current` | Show current session and model |
| `/help` | Show all commands |
| *any text* | Send to active session (AI responds) |

## Configuration

All settings via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ILINK_TOKEN` | *(required)* | WeChat ilink bot Bearer token |
| `ILINK_BASE` | `https://ilinkai.weixin.qq.com` | ilink API base URL |
| `SERVE_URL` | `http://127.0.0.1:4096` | OpenCode serve address |
| `SERVE_USER` | `opencode` | Basic auth username |
| `SERVE_PASS` | *(auto-detected)* | Basic auth password |
| `POLL_MS` | `30000` | Long-poll timeout (ms) |
| `DATA_DIR` | `~/.cc-connect/wx-bridge` | State and log storage |
| `LOG_LEVEL` | `info` | Log level (`debug`, `info`, `warn`, `error`) |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full data flow and component diagram.

## Design

Built for **single-user, single-agent** usage. The bridge processes messages
sequentially — each message is `await`ed before the next one begins. This
eliminates session-write races, state corruption, and concurrent request
overload without adding queues or locks.

- No concurrent message processing — one message at a time per user
- No state race conditions — writes happen synchronously within a turn
- No queue or backpressure needed — single user cannot overload

## Limitations

- Designed for **personal use** only. Multi-user scenarios require adding
  request serialization and state locking.
- **Windows-only** — `opencode.exe` path detection uses Windows conventions.
  macOS/Linux users must set `OPENCODE_BIN` explicitly.
- **OpenCode-only** — the bridge talks to OpenCode Serve via SDK and CLI.
- Session listing uses `execSync` which blocks the event loop for ~1 second.
  Acceptable for single-user; would need async for concurrent use.
- Inflight tracking is statistical only (0 or 1), no rate limiting.
- Default session titles like "New session - ..." are stripped to "(new)" —
  if you intentionally keep timestamps, name your sessions.

## FAQ

**Q: First message gets "No active session"?**
A: Use `/resume <keyword>` to switch to an existing session first.

**Q: What does the 412/400 error mean?**
A: 412 = expired ilink token, re-bind via cc-connect. 400 = don't pass `model` in the message body.

**Q: Why 10-minute timeout?**
A: OpenCode serve API is synchronous — it holds the HTTP connection until the agent finishes. Complex tasks like document generation can take several minutes.

**Q: How does cross-directory session switching work?**
A: `opencode session list --format json` returns ALL sessions globally (not scoped by directory). The bridge lists them all, then `POST /session/:id/message` handles cross-directory messages natively.

## License

MIT
