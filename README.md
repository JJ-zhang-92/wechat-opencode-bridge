# wechat-opencode-bridge

Control [OpenCode](https://github.com/anomalyco/opencode) directly from WeChat. Natural language in, natural language out — powered by local LLM (ollama qwen2.5:7b).

```
微信 → ilink API → wx-bridge (Node.js) → OpenCode Serve →  API
                     ↕ ollama qwen2.5:7b
                  NL routing + output translation
```

## Features

**Bidirectional NL.** Input: keyword regex (<1ms) + LLM context-aware classification (~500ms). Output: regex rules (<1ms) + LLM fallback. Session IDs and slash commands are never shown to the user.

**Auto-start.** One command — `node wx-bridge.mjs`. Bridge spawns OpenCode serve, connects SSE, and begins long-polling WeChat. Ctrl+C kills both.

**Session index.** 70+ session titles and project directories are pre-built into a static index on startup and injected into every LLM prompt. The LLM always knows which sessions exist.

**Busy protection.** Sending a message while the session is processing won't silently interrupt it. The bridge queues your message and prompts for confirmation.

**Permission risk grading.** Low-risk operations (read, list, show) auto-approve. Critical operations (delete, rm, purge) always prompt. Ambiguous cases go to LLM for judgment.

## Quick Start

```bash
set ILINK_TOKEN=your-bot-id@im.bot:your-token
node wx-bridge.mjs
```

Bridge auto-starts `opencode serve --port 4097`, detects ollama, and begins polling. Send any message from WeChat to establish the `context_token`.

## Usage

### Natural language (Phase 1 regex + Phase 2 LLM)

You don't need to remember commands. Say what you mean:

| You say | Bridge does |
|----------|-------------|
| `切换微信桥项目` `打开 wechat-opencode-bridge项目` | Switch to session by fuzzy title match |
| `列出` `全部` `看看` | Browse all sessions |
| `最近` | Recent sessions |
| `统计` | Session statistics |
| `停下` `别跑了` `别干了` | Stop current task |
| `强制` `打断` | Interrupt and send queued message |
| `同意` `好` `行` | Approve permission |
| `拒绝` `不行` | Deny permission |
| `搜索 douyin` | Search sessions |
| `新建 测试` `建一个 会话` | Create new session |
| `帮助` | Show help |
| `状态` `当前` | Show current session |
| anything else | Forwarded to AI |

### Output — natural language only

All bridge-generated messages are translated. The user never sees session IDs or slash commands:

```
Before → After
──────────────────────────────────
✅ Switched to: 专利 (ses_abc)     →  切换到「专利」了。
Session: ses_abc\nModel: xxx      →  当前用xxx。
🔍 3 matches:[0] title (ses_x)    →  找到3个：「title」「title」
/confirm  /deny                    →  同意还是拒绝？
```

AI replies pass through untouched — the translator only operates on bridge-generated output.

### Commands (shortcuts)

| Command | Alias | What it does |
|---------|-------|-------------|
| `/sessions` | `/s` `/l` `/list` | Browse: summary → filter by project → paginated all |
| `/recent` | `/r` | Recent sessions; `/r N` to switch |
| `/stats` | `/st` | Session distribution per project |
| `/new` | `/n` | Create new session |
| `/resume` | — | Fuzzy switch by keyword, exact ID, or index |
| `/stop` | — | Abort current task |
| `/force` | — | Abort + send queued message |
| `/confirm` `/deny` | — | Respond to permission prompts |
| `/search` | — | Full-text search across sessions |
| `/delete` | `/rm` | Delete session (double-confirm) |
| `/compact` | — | Compress context into new session |
| `/model` | — | Show/switch AI model |
| `/system` | — | Show/set system prompt |
| `/nl` | — | Toggle natural language mode |
| `/current` | — | Current session and model |
| `/help` | — | Show help |

## Architecture

```
┌──────────┐   ilink long-poll     ┌──────────────────────┐   prompt_async + SSE   ┌──────────┐
│  WeChat  │ ◄───────────────────► │   wx-bridge.mjs      │ ◄────────────────────► │ OpenCode │
└──────────┘                       │                      │                        │  Serve   │
                                   │  ┌────────────────┐  │   /global/event        └──────────┘
                                   │  │ Input NL Router│  │
                                   │  │ P1: regex (15) │──┼── ollama qwen2.5:7b
                                   │  │ P2: LLM + ctx  │  │
                                   │  └────────────────┘  │
                                   │                      │
                                   │  ┌────────────────┐  │
                                   │  │ Output NL      │  │
                                   │  │ P1: regex (32) │  │
                                   │  │ P2: LLM fallbk │  │
                                   │  └────────────────┘  │
                                   │                      │   AI replies: pass-through
                                   └──────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for full data flow.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ILINK_TOKEN` | *(required)* | WeChat ilink bot Bearer token |
| `ILINK_BASE` | `https://ilinkai.weixin.qq.com` | ilink API base URL |
| `SERVE_URL` | `http://127.0.0.1:4097` | OpenCode serve address |
| `POLL_MS` | `30000` | Long-poll timeout (ms) |
| `DATA_DIR` | `~/.cc-connect/wx-bridge` | State and log storage |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `OLLAMA_URL` | `http://localhost:11434` | ollama API address |
| `NL_CLASSIFY_MODEL` | `qwen2.5:7b` | Intent classification model |
| `NL_MODE` | `auto` | `auto` / `on` / `off` |
| `NL_CONTEXT_ENABLED` | `true` | Set `0` to disable LLM context injection |
| `PERMISSION_AUTO_APPROVE` | `low` | `off` / `low` / `medium` / `high` |
| `CAPABILITY_HINT` | *see code* | Injected into LLM context |
| `OPENCODE_BIN` | *(auto)* | Path to opencode.exe |
| `WX_ALLOW_FROM` | *(none)* | Restrict to single WeChat user |

## Testing

```bash
node test-nl.js        # NL classifier: 33/34 pass
node test-beg.js       # Commands + translation + permissions: 31/31 pass
node test-sse-live.js  # Full SSE chain: prompt_async → part → idle
```

## Limitations

- Personal use only. Single-user, single-agent design.
- Windows-only. macOS/Linux users set `OPENCODE_BIN`.
- OpenCode-only. Communicates via SDK + CLI.
- Session listing blocks event loop ~1s (execSync). Acceptable for single-user.
- NL LLM adds ~500ms per classification (keyword matches are instant).

## Design Decisions

### Why current implementation is appropriate for single-user

| Implementation | Why it works | Why no improvement needed |
|----------------|--------------|---------------------------|
| `execSync` for session list | Blocks ~1s, acceptable for single user | Async would add complexity for no real benefit |
| `writeFileSync` for logs | SSD write latency 0.1-1ms, imperceptible | Async batching only helps high-concurrency servers |
| Fixed 5s SSE reconnect | Simple, predictable, works for personal use | Exponential backoff only matters for long outages |
| Maps without TTL cleanup | Single user = max 1-2 active entries | Residual entries cost ~bytes, not worth added complexity |
| Full NL prompt for LLM | Local Ollama, no token cost | Prompt compression only matters for API billing |

### When these would need to change

| Scenario | What would need improvement |
|----------|---------------------------|
| Multi-user deployment | Add Map TTL cleanup, connection pooling, rate limiting |
| Cloud API billing (not local LLM) | Optimize prompt, add response caching |
| Network storage (NFS) or HDD | Switch to async log writes |
| High-availability requirement | Add exponential backoff, circuit breaker |
| Cross-platform support | Replace `execSync` with async alternatives |

### Key design trade-offs

1. **Simplicity over robustness** — `execSync` is synchronous but simple; for single-user, simplicity wins
2. **Local over remote** — Ollama means zero cost, so prompt size doesn't matter
3. **Synchronous over async** — For single-user, blocking operations complete fast enough
4. **Regex-first, LLM-fallback** — Keywords cover 90% of intents instantly; LLM only for edge cases

## License

MIT
