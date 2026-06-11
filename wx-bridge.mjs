// wx-bridge.mjs — WeChat ilink ↔ OpenCode Serve bridge
// Uses correct ilink API format (from cc-connect source)
// Session listing uses CLI bypass for cross-directory access
// Message passing uses OpenCode SDK (no auth needed)

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import https from "https";
import http from "http";

// ── config ──────────────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR   || resolve(process.env.USERPROFILE, ".cc-connect", "wx-bridge");
const LOG_LEVEL   = process.env.LOG_LEVEL  || "info";

function getToken() {
  if (process.env.ILINK_TOKEN) return process.env.ILINK_TOKEN;
  try {
    const toml = readFileSync(resolve(process.env.USERPROFILE, ".cc-connect", "config.toml"), "utf8");
    const m = toml.match(/token\s*=\s*"([^"]+)"/);
    return m ? m[1] : "";
  } catch { return ""; }
}
const ILINK_TOKEN = getToken();
const ILINK_BASE  = process.env.ILINK_BASE  || "https://ilinkai.weixin.qq.com";
const SERVE_URL   = process.env.SERVE_URL   || "http://127.0.0.1:4097";
const POLL_MS     = parseInt(process.env.POLL_MS) || 30000;

function getAllowFrom() {
  if (process.env.WX_ALLOW_FROM) return process.env.WX_ALLOW_FROM;
  try {
    const toml = readFileSync(resolve(process.env.USERPROFILE, ".cc-connect", "config.toml"), "utf8");
    const m = toml.match(/allow_from\s*=\s*"([^"]+)"/);
    return m ? m[1] : "";
  } catch { return ""; }
}
const ALLOW_FROM = getAllowFrom();

// ── SDK client (lazy init) ──────────────────────────────────────────────
let _sdk = null;
async function getSdk() {
  if (_sdk) return _sdk;
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  _sdk = createOpencodeClient({ baseUrl: SERVE_URL });
  return _sdk;
}

// ── single-instance lock ────────────────────────────────────────────────
const PID_FILE = resolve(DATA_DIR, "bridge.pid");
if (existsSync(PID_FILE)) {
  try {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf8"));
    process.kill(oldPid, 0);
    process.stderr.write("bridge already running, exiting\n");
    process.exit(1);
  } catch { /* old process dead, continue */ }
}
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(PID_FILE, String(process.pid));
process.on("exit", () => { try { unlinkSync(PID_FILE); } catch {} });

// ── state ───────────────────────────────────────────────────────────────
const statePath = resolve(DATA_DIR, "wx-sessions.json");
const logPath   = resolve(DATA_DIR, "bridge.log");

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
  try {
    if (existsSync(logPath) && readFileSync(logPath, "utf8").length > 10 * 1024 * 1024) {
      try { unlinkSync(logPath + ".1"); } catch {}
      try { writeFileSync(logPath + ".1", readFileSync(logPath)); } catch {}
      writeFileSync(logPath, "");
    }
    writeFileSync(logPath, line + "\n", { flag: "a" });
  } catch {}
}

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
async function serveListAllSessions(limit = 100) {
  try {
    const OCODE = process.env.OPENCODE_BIN || "C:\\Users\\12415\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    const output = execSync(`"${OCODE}" session list --format json --max-count ${limit}`, {
      encoding: "utf8", timeout: 10000, env: process.env,
    });
    const all = JSON.parse(output || "[]");
    return all.map(s => ({
      id: s.id,
      title: (s.title || "(untitled)").replace(/^New session - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/, "(new)"),
      directory: s.directory || "",
    }));
  } catch (e) {
    log("error", "exec opencode session list failed", { error: e.message });
    return [];
  }
}

async function serveSendMessage(sessionId, text, systemPrompt) {
  const sdk = await getSdk();
  const body = { sessionID: sessionId, parts: [{ type: "text", text }] };
  if (systemPrompt) body.system = systemPrompt;
  const result = await sdk.session.promptAsync(body);
  if (result.error) throw new Error(`SDK error: ${result.error}`);
  return result.data;
}

async function serveCreateSession(title = "WeChat session") {
  const sdk = await getSdk();
  const result = await sdk.session.create({ title });
  if (result.error) throw new Error(`SDK create: ${result.error}`);
  return result.data;
}

function extractText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter(p => p.type === "text").map(p => p.text).join("\n");
}

// ── formatting ──────────────────────────────────────────────────────────
function getProjectGroups(sessions) {
  const groups = {};
  const order = [];
  sessions.forEach((s, i) => {
    const dir = s.directory || "";
    const dirLabel = dir.split(/[\/\\]/).filter(Boolean).pop() || dir || "?";
    if (!groups[dirLabel]) { groups[dirLabel] = []; order.push(dirLabel); }
    groups[dirLabel].push({ ...s, globalIndex: i });
  });
  return { groups, order };
}

function formatProjectsList(groups, order) {
  const lines = ["Projects:"];
  order.forEach((dir, i) => lines.push(`  [${i}] ${dir} (${groups[dir].length})`));
  lines.push("", "Reply with /list [number] or /list <name>");
  return lines.join("\n");
}

function formatSessionsInProject(dir, items, activeId) {
  const lines = [`[ ${dir} ] (${items.length})`];
  for (const s of items) {
    const active = activeId === s.id ? ">" : " ";
    lines.push(`  ${active} [${s.globalIndex}] ${s.title || "(untitled)"}`);
  }
  lines.push("", "Reply with /resume [number]");
  return lines.join("\n");
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
        const sessions = await serveListAllSessions();
        if (sessions.length === 0) {
          await ilinkSendText(userId, "No sessions found.", contextToken);
          return;
        }
        const { groups, order } = getProjectGroups(sessions);
        const arg = parts.slice(1).join(" ").trim();
        if (!arg) {
          await ilinkSendText(userId, formatProjectsList(groups, order), contextToken);
          return;
        }
        if (/^\d+$/.test(arg)) {
          const idx = parseInt(arg);
          if (idx >= 0 && idx < order.length) {
            const dir = order[idx];
            await ilinkSendText(userId, formatSessionsInProject(dir, groups[dir], us.activeSession), contextToken);
          } else {
            await ilinkSendText(userId, `Project index ${idx} out of range (0-${order.length-1})`, contextToken);
          }
          return;
        }
        const lower = arg.toLowerCase();
        const matchIdx = order.findIndex(d => d.toLowerCase().includes(lower));
        if (matchIdx >= 0) {
          const dir = order[matchIdx];
          await ilinkSendText(userId, formatSessionsInProject(dir, groups[dir], us.activeSession), contextToken);
        } else {
          await ilinkSendText(userId, `No project matching "${arg}". Use /list to see all projects.`, contextToken);
        }
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
        const sessions = await serveListAllSessions();
        if (!query) {
          if (sessions.length === 0) {
            await ilinkSendText(userId, "No sessions found.", contextToken);
          } else {
            const { groups, order } = getProjectGroups(sessions);
            await ilinkSendText(userId, formatProjectsList(groups, order), contextToken);
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

      case "/stop": {
        if (!us.activeSession) {
          await ilinkSendText(userId, "No active session to stop.", contextToken);
          return;
        }
        try {
          const sdk = await getSdk();
          await sdk.session.abort({ sessionID: us.activeSession });
          await ilinkSendText(userId, "✅ Interrupt signal sent.", contextToken);
        } catch (e) {
          await ilinkSendText(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/search": {
        const query = parts.slice(1).join(" ").trim();
        if (!query) { await ilinkSendText(userId, "Usage: /search <keyword>", contextToken); return; }
        const sessions = await serveListAllSessions();
        log("info", "search", { query, sessionCount: sessions.length, sample: sessions.slice(0,2).map(s=>s.title).join("|") });
        const lowerQ = query.toLowerCase();
        const matches = sessions.filter(s => `${s.title} ${s.directory}`.toLowerCase().includes(lowerQ));
        if (matches.length === 0) {
          await ilinkSendText(userId, `No sessions matching "${query}"`, contextToken);
        } else {
          const lines = matches.map((s, i) => {
            const dir = s.directory.split(/[\/\\]/).filter(Boolean).pop() || "?";
            return `[${sessions.indexOf(s)}] ${s.title} @${dir}`;
          });
          await ilinkSendText(userId, `🔍 ${matches.length} matches:\n${lines.join("\n")}`, contextToken);
        }
        break;
      }

      case "/delete": {
        const target = parts[1];
        if (!target) { await ilinkSendText(userId, "Usage: /delete <id> or /delete [N]", contextToken); return; }
        const sessions = await serveListAllSessions();
        let session = null;
        if (target.startsWith("ses_")) session = sessions.find(s => s.id === target);
        else if (/^\d+$/.test(target)) {
          const idx = parseInt(target);
          if (idx >= 0 && idx < sessions.length) session = sessions[idx];
        }
        if (!session) { await ilinkSendText(userId, `Session not found: ${target}`, contextToken); return; }
        if (us._pendingDelete !== session.id) {
          us._pendingDelete = session.id;
          saveState(state);
          await ilinkSendText(userId, `⚠️ Confirm delete: ${session.title} (${session.id})\nReply with /delete ${target} again to confirm.`, contextToken);
          return;
        }
        us._pendingDelete = null;
        saveState(state);
        try {
          const sdk = await getSdk();
          await sdk.session.delete({ sessionID: session.id });
          if (us.activeSession === session.id) us.activeSession = null;
          saveState(state);
          await ilinkSendText(userId, `✅ Deleted: ${session.title}`, contextToken);
        } catch (e) {
          await ilinkSendText(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/compact": {
        if (!us.activeSession) { await ilinkSendText(userId, "No active session.", contextToken); return; }
        try {
          await ilinkSendText(userId, "⏳ Compacting...", contextToken);
          const sdk = await getSdk();
          await sdk.session.abort({ sessionID: us.activeSession });
          const summary = await serveSendMessage(us.activeSession,
            "Summarize the current conversation context in one paragraph, preserving all key facts, decisions, and pending tasks.", "");
          const newSession = await serveCreateSession("(compact) " + (new Date().toLocaleDateString()));
          us.activeSession = newSession.id;
          saveState(state);
          const summaryText = extractText(summary.parts) || "(no summary)";
          await ilinkSendText(userId, `✅ Compacted.\nNew session: ${newSession.id}\nSummary:\n${summaryText}`, contextToken);
        } catch (e) {
          await ilinkSendText(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/current": {
        await ilinkSendText(userId, `Session: ${us.activeSession || "(none)"}\nModel: ${us.model}`, contextToken);
        break;
      }

      case "/help": {
        await ilinkSendText(userId,
          "🛠 Commands:\n/list — Browse projects/sessions\n/new [title] — Create session\n/resume — List / fuzzy switch\n/stop — Interrupt current task\n/search <word> — Search sessions\n/delete <id> — Delete session\n/compact — Compress context to new session\n/model [name] — Show/switch model\n/system — Show/set system prompt\n/current — Show current state\n/help — This help",
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

  // Whitelist check
  if (ALLOW_FROM && userId !== ALLOW_FROM) {
    log("warn", `blocked ${userId.slice(0,16)}...`);
    return;
  }

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

  // ── serve heartbeat ──────────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    try {
      const resp = await fetch(`${SERVE_URL}/global/health`);
      if (resp.ok) { log("info", `serve ready (attempt ${i + 1})`); break; }
      throw new Error(`HTTP ${resp.status}`);
    } catch {
      if (i === 9) { log("error", "serve unreachable after 10 attempts, exiting"); process.exit(1); }
      await sleep(3000);
    }
  }

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
