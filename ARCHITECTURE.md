# Architecture

## Overview

```
┌──────────────┐                    ┌──────────────────┐                    ┌──────────────────────┐
│              │  POST /getupdates  │                  │   POST /session    │                      │
│   WeChat     │ ◄────────────────► │   wx-bridge.mjs  │ ◄────────────────► │  OpenCode Serve API  │
│   (Phone)    │  POST /sendmessage │   (Node.js)      │  GET  /session     │  (localhost:4096)    │
│              │                    │                  │  POST /session/:id │                      │
└──────────────┘                    └───────┬──────────┘                    └──────────┬───────────┘
                                           │                                        │
                                           │ execSync                               │
                                           ▼                                        ▼
                                   ┌──────────────┐                       ┌──────────────────┐
                                   │ opencode CLI │                       │  SQLite DB       │
                                   │ session list │                       │  (opencode.db)   │
                                   └──────────────┘                       └──────────────────┘
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
  ├── Starts with "/" → Command router
  │   ├── /list     → execSync "opencode session list --format json"
  │   ├── /resume   → Fuzzy match → store activeSession
  │   ├── /new      → POST /session → create
  │   ├── /model    → Update user state
  │   ├── /system   → Update user state
  │   └── /current  → Read user state
  │
  └── Regular text → Forward to active session
```

### 2. Sending to OpenCode (Bridge → AI)

```
Message text + system prompt
  │
  ▼
POST /session/{id}/message
  Body: { parts: [{type:"text", text}], system: "..." }
  Timeout: 600000ms (10 min)
  │
  ▼
OpenCode processes with AI model
  │
  ▼
Response: { info: {...}, parts: [{type:"text", ...}, ...] }
  │
  ▼
Bridge extracts text parts → sends to WeChat (max 3500 chars/chunk)
```

### 3. Session Discovery

The serve API's `GET /session` endpoint is scoped to the running directory. To bypass this, the bridge uses the OpenCode CLI:

```bash
opencode session list --format json --max-count 30
```

This returns ALL sessions globally across all directories, including archived ones.

## Component Details

### ilink Transport (`ilinkGetUpdates`, `ilinkSendText`)

- Uses the **same ilink bot HTTP API** as cc-connect and OpenClaw
- Long-poll pattern: `POST /ilink/bot/getupdates` with `get_updates_buf` cursor
- Message sending: `POST /ilink/bot/sendmessage` with `context_token`
- Headers: `Authorization: Bearer {token}`, `AuthorizationType: ilink_bot_token`, `X-WECHAT-UIN`

### OpenCode Serve Client (`serveRequest`, `serveSendMessage`)

- HTTP basic auth against the OpenCode serve
- Configurable password via `OPENCODE_SERVER_PASSWORD` environment variable
- 600-second timeout for long-running agent tasks

### Command Router (`handleCommand`)

- All slash commands parsed and dispatched before reaching the AI
- Fuzzy matching uses multi-keyword `AND` search against `{title} {directory}`
- Single match → auto-switch. Multiple matches → show candidates. None → error.

### State Management

Persisted to `~/.cc-connect/wx-bridge/wx-sessions.json`:

```json
{
  "users": {
    "wechat_user_id": {
      "activeSession": "ses_xxx",
      "activeDirectory": "/path/to/project",
      "model": "deepseek/deepseek-v4-pro",
      "systemPrompt": "default instructions..."
    }
  }
}
```

## Limitations & Design Decisions

| Decision | Reason |
|----------|--------|
| `model` param removed from message body | Serve API returns 400 for unknown body fields |
| 30-session limit on `/list` | WeChat message length and readability |
| No group chat support | ilink bot API returns direct messages only |
| Session listing via CLI, not serve API | Serve API scopes by directory; CLI returns global sessions |
| Node.js built-in modules only | Zero install, zero dependency conflicts |
