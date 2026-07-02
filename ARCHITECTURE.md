# Architecture

## Overview

```
┌──────────┐   ilink long-poll     ┌──────────────────────┐   prompt_async + SSE   ┌──────────────┐
│  WeChat  │ ◄───────────────────► │                      │ ◄────────────────────► │  OpenCode    │
│  (Phone) │  POST /getupdates     │   wx-bridge.mjs      │  POST /session/:id     │  Serve API   │
│          │  POST /sendmessage    │   (Node.js)          │  GET  /session         │  :4097       │
└──────────┘                       │                      │  SSE /event           │              │
                                   │  ┌────────────────┐  │                        └──────┬───────┘
                                   │  │  NL Classifier │  │                               │
                                   │  │  ┌───────────┐ │  │                         spawn │
                                   │  │  │ keywords  │ │  │                               │
                                   │  │  │ + LLM     │─┼──┼── ollama qwen2.5:7b   ┌──────▼───────┐
                                   │  │  └───────────┘ │  │                        │  opencode    │
                                   │  └────────────────┘  │                  execSync│  CLI         │
                                   │                      │ ◄──────────────────────│  session list│
                                   └──────────────────────┘                        └──────┬───────┘
                                          │                                              │
                                          │ state                                      │
                                          ▼                                              ▼
                                   ┌──────────────┐                           ┌──────────────────┐
                                   │ wx-sessions. │                           │  SQLite DB       │
                                   │ json         │                           │  (opencode.db)   │
                                   └──────────────┘                           └──────────────────┘
```

## Data Flow

### 1. Receiving Messages (WeChat → Bridge)

```
WeChat user sends message
  │
  ▼
ilink API: POST /ilink/bot/getupdates (long poll, 30s timeout)
  │
  ▼
Bridge parses message.item_list → extracts text
  │
  ├── Starts with "/" → Command router (handleCommand)
  │   ├── /list     → execSync "opencode session list --format json"
  │   ├── /resume   → Fuzzy match → store activeSession
  │   ├── /new      → SDK session.create()
  │   ├── /stop     → SDK session.abort()
  │   ├── /force    → abort + send queued message
  │   ├── /confirm  → SDK permission.respond("once")
  │   ├── /deny     → SDK permission.respond("reject")
  │   ├── /delete   → SDK session.delete() (double-confirm)
  │   ├── /compact  → abort → summarize → new session
  │   ├── /model    → Update user state
  │   ├── /system   → Update user state
  │   ├── /nl       → Toggle natural language mode
  │   ├── /current  → Read user state
  │   └── /help     → Show all commands
  │
  └── Regular text → NL Classifier
        │
        ├── Keywords match → route to command
        ├── LLM classifies → route to command
        └── "chat" intent → Forward to active session
              │
              ├── Busy? → Queue + prompt "/force"
              └── Idle  → POST /session/:id/prompt_async
```

### 2. Sending to OpenCode (Bridge → AI)

```
Message text + system prompt
  │
  ▼
POST /session/{id}/prompt_async
  Body: { parts: [{type:"text", text}], system: "..." }
  │
  ▼
OpenCode processes asynchronously
  │
  ▼
SSE /event → message.part.updated → accumulate text
  │
  ▼
session.idle → send accumulated text to WeChat (max 3500 bytes/chunk)
```

### 3. Session Discovery

```
opencode session list --format json --max-count 100
```

Returns ALL sessions globally across all directories. The serve API's `GET /session` is directory-scoped — the CLI bypass is necessary.

### 4. NL Classification Pipeline

```
User text (non-slash)
  │
  ▼
Keyword regex matching (<1ms)
  ├── Match → route to command
  │
  └── No match
        │
        ├── NL disabled → "chat" intent (forward to session)
        │
        └── NL enabled → ollama classify (~500ms)
              ├── Intent found → route to command
              └── Fallback → "chat" intent
```

Keywords cover 14 commands (list, resume, new, stop, force, confirm, deny, search, delete, model, system, current, help, compact, nl). LLM handles ambiguous / edge cases.

### 5. Busy Protection

```
User sends message while session is busy
  │
  ▼
activeTurns.has(sessionId) → true
  │
  ▼
Store message in pendingMessages Map
  │
  ▼
Reply: "Session is busy. Reply /force to interrupt and send, or wait."
  │
  ├── User replies "/force" → abort current task → send pending message
  └── User waits → session.idle fires → pending cleared → user re-sends
```

## Component Details

### ilink Transport (`ilinkGetUpdates`, `ilinkSendText`)

- Same ilink bot HTTP API as cc-connect and OpenClaw
- Long-poll: `POST /ilink/bot/getupdates` with `get_updates_buf` cursor
- Send: `POST /ilink/bot/sendmessage` with `context_token`
- Auth: `Bearer {token}`, `AuthorizationType: ilink_bot_token`, `X-WECHAT-UIN`

### OpenCode Serve Client

- **SDK** (`@opencode-ai/sdk/v2`): session.create, session.delete, session.abort, permission.respond
- **REST** (`fetch`): prompt_async (fire-and-forget), health check
- **SSE** (`/event`): permission.asked, message.part.updated, session.idle

### NL Classifier (`nlClassifyIntent`)

- **Fast path**: 14 keyword regex patterns, zero dependencies, <1ms
- **Slow path**: ollama generate API with few-shot prompt, ~500ms
- **Mode control**: `NL_MODE=auto|on|off` env var + `/nl on|off` runtime toggle
- **Auto-detect**: checks ollama availability on startup

### Auto-Start OpenCode

```
main()
  ├── nlDetectOllama() → update NL state
  ├── health check → serve alive?
  ├── No → spawn("opencode", ["serve", "--port", OCODE_PORT])
  └── heartbeat: 10 attempts × 3s = 30s timeout
```

On shutdown: `serveProcess.kill("SIGTERM")` → wait up to 5s for exit.

### Command Router (`handleCommand`)

- 15+ slash commands, plus NL-routed equivalents
- `/resume` fuzzy matching: multi-keyword AND against `{title} {directory}`
- `/delete` double-confirm: first call prompts, second call executes
- `/force` picks up pending message from `pendingMessages` Map

### State Management

File: `~/.cc-connect/wx-bridge/wx-sessions.json`

```json
{
  "users": {
    "wechat_user_id": {
      "activeSession": "ses_xxx",
      "activeDirectory": "/path/to/project",
      "model": "deepseek/deepseek-v4-pro",
      "systemPrompt": "..."
    }
  }
}
```

In-memory state:

| Map | Key | Value |
|-----|-----|-------|
| `activeTurns` | sessionID | {userId, contextToken} |
| `pendingPermissions` | sessionID | {permissionID, title} |
| `turnReplies` | sessionID | {text} |
| `pendingMessages` | sessionID | {userId, contextToken, text} |

## Limitations & Design Decisions

| Decision | Reason |
|----------|--------|
| Async prompt + SSE (not sync) | Sync API holds HTTP for 10 min — impractical for bridge |
| Session listing via CLI, not API | Serve API scoped by directory; CLI returns global |
| `execSync` for session list | Acceptable ~1s block for single user |
| 3500-byte chunked replies | WeChat message length limit |
| Await each message (no queue) | Single user cannot overload; eliminates race conditions |
| Memory-only pending messages | If bridge restarts, user just re-sends |
| Keywords + LLM two-tier NL | Keywords cover 90% of intents instantly; LLM handles edge cases |
| ollama optional | Bridge works without ollama; keywords cover most use cases |
| `prompt_async` replaces `prompt` | Non-blocking; results collected via SSE |
| Single-instance PID lock | Prevents accidental double-start |
