// wx-bridge.mjs — WeChat ilink ↔ OpenCode Serve bridge
// Uses correct ilink API format (from cc-connect source)
// Session listing uses CLI bypass for cross-directory access

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import https from "https";
import http from "http";

// ── config ──────────────────────────────────────────────────────────────
const ILINK_TOKEN = process.env.ILINK_TOKEN || "db78a3e21099@im.bot:060000757ee105b37c110dac179fa92a1c6db4";
const ILINK_BASE  = process.env.ILINK_BASE  || "https://ilinkai.weixin.qq.com";
const SERVE_URL   = process.env.SERVE_URL   || "http://127.0.0.1:4096";
const SERVE_USER  = process.env.SERVE_USER  || "opencode";
const SERVE_PASS  = process.env.SERVE_PASS  || "991b9914-7bb2-4806-84e6-1bea3f6a3aa3";
const POLL_MS     = parseInt(process.env.POLL_MS) || 30000;
const DATA_DIR    = process.env.DATA_DIR   || resolve(process.env.USERPROFILE, ".cc-connect", "wx-bridge");
const LOG_LEVEL   = process.env.LOG_LEVEL  || "info";

// ── state ───────────────────────────────────────────────────────────────
const statePath = resolve(DATA_DIR, "wx-sessions.json");
const logPath   = resolve(DATA_DIR, "bridge.log");

mkdirSync(DATA_DIR, { recursive: true });

function loadState() {
  try { return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}; }
  catch { return {}; }
}
function saveState(s) {
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

let state = loadState();

function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] ${msg}` + (extra ? " " + JSON.stringify(extra) : "");
  if (LOG_LEVEL === "debug" || level !== "debug") process.stderr.write(line + "\n");
  try { writeFileSync(logPath, line + "\n", { flag: "a" }); } catch {}
}

// ── auth ────────────────────────────────────────────────────────────────
const authHeader = "Basic " + Buffer.from(`${SERVE_USER}:${SERVE_PASS}`).toString("base64");

// ── http helpers ────────────────────────────────────────────────────────
function httpRequest(method, url, body = null, extraHeaders = {}, timeout = 120000) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;
  const agent = new mod.Agent({ keepAlive: true });

  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (body) headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(body), "utf8"));

  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method, headers, agent, timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── ilink API ───────────────────────────────────────────────────────────
function ilinkHeaders() {
  return {
    "Authorization": `Bearer ${ILINK_TOKEN}`,
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 1e10))).toString("base64"),
  };
}

async function ilinkGetUpdates(buf) {
  const body = { get_updates_buf: buf || "", base_info: { channel_version: "wx-bridge/1.0" } };
  return httpRequest("POST", `${ILINK_BASE}/ilink/bot/getupdates`, body, ilinkHeaders(), POLL_MS + 10000);
}

async function ilinkSendText(to, text, contextToken) {
  const body = {
    msg: {
      to_user_id: to, client_id: "wb-" + randomUUID().slice(0, 8),
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken,
    },
    base_info: { channel_version: "wx-bridge/1.0" },
  };
  return httpRequest("POST", `${ILINK_BASE}/ilink/bot/sendmessage`, body, ilinkHeaders(), 15000);
}

// ── serve API ───────────────────────────────────────────────────────────
async function serveRequest(method, path, body = null, timeout = 120000) {
  const headers = { Authorization: authHeader };
  return httpRequest(method, `${SERVE_URL}${path}`, body, headers, timeout);
}

async function serveListAllSessions(limit = 30) {
  try {
    const output = execSync(`opencode session list --format json --max-count ${limit}`, {
      encoding: "utf8", timeout: 10000, env: process.env,
    });
    const all = JSON.parse(output || "[]");
    return all.map(s => ({
      id: s.id,
      title: s.title || "(untitled)",
      directory: s.directory || "",
    }));
  } catch (e) {
    log("error", "exec opencode session list failed", { error: e.message });
    return [];
  }
}

async function serveCreateSession(title = "WeChat session") {
  const r = await serveRequest("POST", "/session", { title });
  if (r.status !== 200) throw new Error(`create session: HTTP ${r.status}`);
  return r.data;
}

async function serveSendMessage(sessionId, text, systemPrompt) {
  const body = { parts: [{ type: "text", text }] };
  if (systemPrompt) body.system = systemPrompt;
  const r = await serveRequest("POST", `/session/${sessionId}/message`, body, 600000);
  if (r.status !== 200) throw new Error(`send message: HTTP ${r.status}`);
  return r.data;
}

function extractText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter(p => p.type === "text").map(p => p.text).join("\n");
}

// ── user state ──────────────────────────────────────────────────────────
function getUserState(userId) {
  if (!state.users) state.users = {};
  if (!state.users[userId]) {
    state.users[userId] = { activeSession: null, activeDirectory: null, model: "deepseek/deepseek-v4-pro", systemPrompt: "默认在对话框内以文本格式输出。需要生成文件（Office、PDF等）时，先询问用户确认后再输出。" };
  }
  return state.users[userId];
}

// ── command router ──────────────────────────────────────────────────────
async function handleCommand(userId, contextToken, text) {
  const us = getUserState(userId);
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  try {
    switch (cmd) {
      case "/list": {
        const sessions = await serveListAllSessions(30);
        if (sessions.length === 0) {
          await ilinkSendText(userId, "No sessions found.", contextToken);
          return;
        }
        const lines = sessions.map((s, i) => {
          const dir = s.directory || "";
          const dirLabel = dir.split(/[\/\\]/).filter(Boolean).pop() || dir || "?";
          const active = us.activeSession === s.id ? " ▶" : "";
          return `[${i}]${active} ${s.title}  @${dirLabel}  (${s.id})`;
        });
        await ilinkSendText(userId, `📋 ${sessions.length} sessions:\n${lines.join("\n")}`, contextToken);
        break;
      }

      case "/new": {
        const title = parts.slice(1).join(" ") || "WeChat session";
        const session = await serveCreateSession(title);
        us.activeSession = session.id;
        saveState(state);
        await ilinkSendText(userId, `✅ Created: ${session.id}\nTitle: ${title}`, contextToken);
        break;
      }

      case "/resume": {
        const query = parts.slice(1).join(" ").trim();
        const sessions = await serveListAllSessions(30);
        if (!query) {
          if (sessions.length === 0) {
            await ilinkSendText(userId, "No sessions found.", contextToken);
          } else {
            const lines = sessions.map((s, i) => {
              const dir = s.directory || "";
              const dirLabel = dir.split(/[\/\\]/).filter(Boolean).pop() || dir || "?";
              const active = us.activeSession === s.id ? " ▶" : "";
              return `[${i}]${active} ${s.title}  @${dirLabel}  (${s.id})`;
            });
            await ilinkSendText(userId, `📋 ${sessions.length} sessions:\n${lines.join("\n")}`, contextToken);
          }
          return;
        }
        const lowerQ = query.toLowerCase();
        // [N] index match
        if (/^\d+$/.test(query)) {
          const idx = parseInt(query);
          if (idx >= 0 && idx < sessions.length) {
            us.activeSession = sessions[idx].id;
            us.activeDirectory = sessions[idx].directory;
            saveState(state);
            await ilinkSendText(userId, `✅ Switched to: ${sessions[idx].title} (${sessions[idx].id})`, contextToken);
          } else {
            await ilinkSendText(userId, `❌ Index ${idx} out of range (0-${sessions.length - 1})`, contextToken);
          }
          return;
        }
        // Exact session ID
        if (query.startsWith("ses_")) {
          const match = sessions.find(s => s.id === query);
          if (match) {
            us.activeSession = match.id;
            us.activeDirectory = match.directory;
            saveState(state);
            await ilinkSendText(userId, `✅ Switched to: ${match.title} (${match.id})`, contextToken);
          } else {
            await ilinkSendText(userId, `❌ Session ${query} not found`, contextToken);
          }
          return;
        }
        // Fuzzy match by title + directory
        const matches = sessions.filter(s => {
          const haystack = `${s.title} ${s.directory}`.toLowerCase();
          const keywords = lowerQ.split(/\s+/);
          return keywords.every(k => haystack.includes(k));
        });
        if (matches.length === 1) {
          us.activeSession = matches[0].id;
          us.activeDirectory = matches[0].directory;
          saveState(state);
          await ilinkSendText(userId, `✅ Switched to: ${matches[0].title} (${matches[0].id})`, contextToken);
        } else if (matches.length > 1 && matches.length <= 5) {
          const lines = matches.map((s, i) => `[${i}] ${s.title} (${s.id})`);
          await ilinkSendText(userId, `🔍 ${matches.length} matches:\n${lines.join("\n")}\nReply with "/resume [N]"`, contextToken);
        } else if (matches.length > 5) {
          const lines = matches.slice(0, 5).map((s, i) => `[${i}] ${s.title} (${s.id})`);
          await ilinkSendText(userId, `🔍 ${matches.length} matches (showing first 5):\n${lines.join("\n")}\nNarrow your search`, contextToken);
        } else {
          await ilinkSendText(userId, `❌ No session matching "${query}"`, contextToken);
        }
        break;
      }

      case "/model": {
        if (parts.length < 2) {
          await ilinkSendText(userId,
            `Current: ${us.model}\nAvailable: deepseek/deepseek-v4-pro, xiaomi/mimo-v2.5, xiaomi/mimo-v2.5-pro`,
            contextToken);
          return;
        }
        us.model = parts[1];
        saveState(state);
        await ilinkSendText(userId, `✅ Model: ${us.model}`, contextToken);
        break;
      }

      case "/system": {
        if (parts.length < 2) {
          await ilinkSendText(userId, `Current system prompt:\n"${us.systemPrompt}"\n\nUsage: /system <new prompt> or /system off`, contextToken);
          return;
        }
        const newPrompt = parts.slice(1).join(" ").trim();
        if (newPrompt.toLowerCase() === "off") {
          us.systemPrompt = "";
          saveState(state);
          await ilinkSendText(userId, "✅ System prompt disabled.", contextToken);
        } else {
          us.systemPrompt = newPrompt;
          saveState(state);
          await ilinkSendText(userId, `✅ System prompt set:\n"${us.systemPrompt}"`, contextToken);
        }
        break;
      }

      case "/current": {
        await ilinkSendText(userId, `Session: ${us.activeSession || "(none)"}\nModel: ${us.model}`, contextToken);
        break;
      }

      case "/help": {
        await ilinkSendText(userId,
          "🛠 Commands:\n/list — List all sessions\n/new [title] — Create session\n/resume — List / fuzzy switch session\n/model [name] — Show/switch model\n/system — Show/set system prompt\n/current — Show current state\n/help — This help",
          contextToken);
        break;
      }

      default:
        await ilinkSendText(userId, `Unknown: ${cmd}. Use /help.`, contextToken);
    }
  } catch (e) {
    log("error", "command failed", { cmd, error: e.message });
    await ilinkSendText(userId, `❌ ${e.message}`, contextToken);
  }
}

// ── message handler ─────────────────────────────────────────────────────
async function handleMessage(msg) {
  const userId = msg.from_user_id;
  const contextToken = msg.context_token;
  const us = getUserState(userId);

  let text = "";
  if (Array.isArray(msg.item_list)) {
    for (const item of msg.item_list) {
      if (item.type === 1 && item.text_item?.text) text += item.text_item.text;
    }
  }
  text = text.trim();
  if (!text) return;

  log("info", `msg ${userId.slice(0,16)}...`, { text: text.slice(0, 100) });

  // Slash command
  if (text.startsWith("/")) {
    await handleCommand(userId, contextToken, text);
    return;
  }

  // Regular message
  if (!us.activeSession) {
    await ilinkSendText(userId, "⚠️ No active session. Use /list && /resume <id> first.", contextToken);
    return;
  }

  try {
    await ilinkSendText(userId, "⏳ Processing...", contextToken);
    const result = await serveSendMessage(us.activeSession, text, us.systemPrompt);
    const reply = extractText(result.parts);
    if (reply) {
      const maxLen = 3500;
      for (let i = 0; i < reply.length; i += maxLen) {
        await ilinkSendText(userId, reply.slice(i, i + maxLen), contextToken);
      }
    } else {
      await ilinkSendText(userId, "✅ Done (no text output).", contextToken);
    }
  } catch (e) {
    log("error", "serve msg failed", { error: e.message });
    await ilinkSendText(userId, `❌ ${e.message}`, contextToken);
  }
}

// ── main loop ───────────────────────────────────────────────────────────
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

async function main() {
  log("info", "wx-bridge starting", { ilink_base: ILINK_BASE, serve_url: SERVE_URL, poll_ms: POLL_MS });

  let buf = "";
  let backoff = 1000;
  const maxBackoff = 30000;

  while (running) {
    try {
      const resp = await ilinkGetUpdates(buf);
      if (!resp || resp.status !== 200) {
        log("warn", `getUpdates HTTP ${resp?.status || "err"}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }
      backoff = 1000;

      if (resp.data.get_updates_buf) buf = resp.data.get_updates_buf;

      for (const msg of (resp.data.msgs || [])) {
        if (msg.message_type === 1) await handleMessage(msg);
      }
    } catch (e) {
      log("warn", "poll error", { error: e.message });
      await sleep(Math.min(backoff, maxBackoff));
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
  log("info", "wx-bridge stopped");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { log("error", "fatal", { error: e.message }); process.exit(1); });
