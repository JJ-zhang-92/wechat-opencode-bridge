// wx-bridge.mjs — WeChat ilink ↔ OpenCode Serve bridge
// Uses correct ilink API format (from cc-connect source)
// Session listing uses CLI bypass for cross-directory access
// Message passing uses OpenCode SDK (no auth needed)

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "fs";
import { resolve } from "path";
import { execSync, spawn } from "child_process";
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

function getServePass() {
  if (process.env.SERVE_PASS) return process.env.SERVE_PASS;
  if (process.env.OPENCODE_SERVER_PASSWORD) return process.env.OPENCODE_SERVER_PASSWORD;
  return "";
}
const SERVE_PASS = getServePass();
const SERVE_USER = process.env.SERVE_USER || "opencode";

function serveAuthHeaders() {
  if (!SERVE_PASS) return {};
  const pair = `${SERVE_USER}:${SERVE_PASS}`;
  return { "Authorization": `Basic ${Buffer.from(pair).toString("base64")}` };
}

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
  try {
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    _sdk = createOpencodeClient({ baseUrl: SERVE_URL });
  } catch (e) {
    log("error", "SDK import failed — install @opencode-ai/sdk", { error: e.message });
    throw e;
  }
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
  try { writeFileSync(statePath, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

const LEVELS = { error:0, warn:1, info:2, debug:3 };
const LOG_THRESHOLD = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase()}] ${msg}` + (extra ? " " + JSON.stringify(extra) : "");
  if (LEVELS[level] <= LOG_THRESHOLD) process.stderr.write(line + "\n");
  logCount = (logCount + 1) % 100;
  try {
    if (logCount === 0 && existsSync(logPath)) {
      try { if (statSync(logPath).size > 10 * 1024 * 1024) {
        try { unlinkSync(logPath + ".1"); } catch {}
        try { writeFileSync(logPath + ".1", readFileSync(logPath)); } catch {}
        writeFileSync(logPath, "");
      }} catch {}
    }
    writeFileSync(logPath, line + "\n", { flag: "a" });
  } catch {}
}
let logCount = 0;

// ── http helpers ────────────────────────────────────────────────────────
const keepAliveAgent = new https.Agent({ keepAlive: true });

function httpRequest(method, url, body = null, extraHeaders = {}, timeout = 120000) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;
  const agent = isHttps ? keepAliveAgent : new http.Agent({ keepAlive: true });

  const headers = { "Content-Type": "application/json", ...extraHeaders };
  const bodyStr = body ? JSON.stringify(body) : null;
  if (bodyStr) headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf8"));

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
    if (bodyStr) req.write(bodyStr);
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
function findOpenCode() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const candidates = [
    resolve(process.env.APPDATA || "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    resolve(process.env.LOCALAPPDATA || "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]; // best-effort fallback
}
const OCODE = findOpenCode();
const OCODE_PORT = (() => { try { return new URL(SERVE_URL).port || "4097"; } catch { return "4097"; } })();
const OCODE_HOST = (() => { try { return new URL(SERVE_URL).hostname || "127.0.0.1"; } catch { return "127.0.0.1"; } })();

// ── NL classifier config ──────────────────────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const NL_CLASSIFY_MODEL = process.env.NL_CLASSIFY_MODEL || "qwen2.5:7b";
const NL_MODE = process.env.NL_MODE || "auto";
const NL_CONTEXT_ENABLED = process.env.NL_CONTEXT_ENABLED !== "0";
const CAPABILITY_HINT = process.env.CAPABILITY_HINT || "legal search, bid generation, patent drafting, doc processing, image generation, database query";
const PERMISSION_AUTO_APPROVE = process.env.PERMISSION_AUTO_APPROVE || "low";

let cachedSessions = [];
let cachedSessionsAt = 0;
let sessionIndex = "";

function buildSessionIndex(sessions) {
  const parts = [];
  const dirs = [...new Set(sessions.map(s => s.directory).filter(Boolean))];
  if (dirs.length) {
    parts.push(`Projects: ${dirs.map(d => d.split(/[\/\\]/).filter(Boolean).pop() || "?").join(", ")}`);
  }
  const titles = sessions.map(s => `[${s.title}]`).join(", ");
  if (titles.length > 400) {
    parts.push(`Titles: ${titles.slice(0, 400)}...`);
  } else if (titles) {
    parts.push(`Titles: ${titles}`);
  }
  return parts.length ? `[INDEX]\n${parts.join("\n")}\n---\n` : "";
}

async function getSessions(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedSessions.length > 0 && (now - cachedSessionsAt) < 30_000) {
    return cachedSessions;
  }
  cachedSessions = await serveListAllSessions();
  cachedSessionsAt = now;
  sessionIndex = buildSessionIndex(cachedSessions);
  return cachedSessions;
}

async function serveListAllSessions(limit = 100) {
  try {
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

async function serveSendMessageAsync(sessionId, text, systemPrompt) {
  const body = { parts: [{ type: "text", text }] };
  if (systemPrompt) body.system = systemPrompt;
  const resp = await fetch(`${SERVE_URL}/session/${sessionId}/prompt_async`, {
    method: "POST", headers: { "Content-Type": "application/json", ...serveAuthHeaders() }, body: JSON.stringify(body),
  });
  if (!resp.ok && resp.status !== 204) throw new Error(`prompt_async HTTP ${resp.status}`);
}

// ── NL classifier ────────────────────────────────────────────────────────
let nlActive = false;
let nlOllamaAvailable = false;
let nlUserOverride = null;

async function nlDetectOllama() {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch { return false; }
}

async function ollamaGenerate(prompt) {
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NL_CLASSIFY_MODEL, prompt, stream: false, options: { num_predict: 32, temperature: 0 } }),
  });
  if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.response || "").trim();
}

function updateNlState() {
  nlActive = nlUserOverride !== null
    ? nlUserOverride
    : (NL_MODE === "on" || (NL_MODE === "auto" && nlOllamaAvailable));
}

function buildContext(us, sessions) {
  try {
    let parts = [];
    if (us.activeSession) {
      const cur = sessions.find(s => s.id === us.activeSession);
      if (cur) {
        const dir = (cur.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?";
        parts.push(`Active: ${cur.title} (${dir})`);
      }
    }
    const recent = (us._recent || []).slice(0, 8);
    if (recent.length) {
      parts.push(`Recent: ${recent.map(s => `[${s.title}] (${(s.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?"})`).join(", ")}`);
    }
    const dynamic = parts.length ? `[CONTEXT]\n${parts.join("\n")}\nMain: ${CAPABILITY_HINT}\n` : "";
    return sessionIndex + dynamic + "---\n";
  } catch { return sessionIndex + "---\n"; }
}

async function nlClassifyIntent(text, us, sessions) {
  const lower = text.toLowerCase();

  // gate: multi-line and URLs don't need LLM
  if (lower.includes("\n")) return { intent: "chat", args: "" };
  if (/^https?:\/\//i.test(lower)) return { intent: "chat", args: "" };

  // ── Phase 1: high-precision keyword matching (optimization only) ──────
  let m;

  // resume: must have explicit subject after the verb
  m = lower.match(/^(切换|切换到|进入|回到|打开|switch|resume|继续)\s+(\S.{1,60}?)$/);
  if (m) return { intent: "resume", args: m[2].trim() };

  // exact title match → resume (user typed the session name)
  const titleMatch = sessions.find(s => (s.title || "").toLowerCase() === lower);
  if (titleMatch) return { intent: "resume", args: titleMatch.title };

  // sessions
  if (/^(列出|查看|看|显示|show|看看|全部|所有|list|sessions?)\s*$/.test(lower))
    return { intent: "sessions", args: "" };
  m = lower.match(/^(list|sessions?|列出|查看|看)\s+(\S.+)/);
  if (m) return { intent: "sessions", args: m[2].trim() };

  // recent
  if (/^(最近|recent|latest|刚才)\s*$/.test(lower)) return { intent: "recent", args: "" };

  // stats
  if (/^(统计|stats?)\s*$/.test(lower)) return { intent: "stats", args: "" };

  // new
  m = lower.match(/^(新建|创建|建|new)\s*(.+)?/);
  if (m) return { intent: "new", args: (m[2] || "").trim() };

  // search
  m = lower.match(/^(搜索|查找|search|find|找)\s+(\S.+)/);
  if (m) return { intent: "search", args: m[2].trim() };

  // delete
  m = lower.match(/^(删除|delete|remove|删)\s+(\S.+)/);
  if (m) return { intent: "delete", args: m[2].trim() };

  // model
  m = lower.match(/^(模型|model)\s*(.+)?/);
  if (m) return { intent: "model", args: (m[2] || "").trim() };

  // system
  m = lower.match(/^(系统|设定指令|system)\s*(.+)?/);
  if (m) return { intent: "system", args: (m[2] || "").trim() };

  // confirm
  if (/^(同意|确认|通过|允许|approve|yes|好|可以|行|ok)\s*$/.test(lower))
    return { intent: "confirm", args: "" };

  // deny
  if (/^(拒绝|不同意|deny|no|不许|不行|不可以)\s*$/.test(lower))
    return { intent: "deny", args: "" };

  // stop
  if (/^(停[止下]|中断|abort|取消)\b/.test(lower) || /^(别)(跑|干|搞|弄)/.test(lower))
    return { intent: "stop", args: "" };

  // force
  if (/^(强制|打断|force|强行)\s*$/.test(lower))
    return { intent: "force", args: "" };

  // help
  if (/^(帮助|help|功能|命令|怎么|说明|教程)\s*$/.test(lower))
    return { intent: "help", args: "" };

  // current
  if (/^(当前|状态|status|在哪|哪个)\s*$/.test(lower))
    return { intent: "current", args: "" };

  // compact
  if (/^(压缩|compact|精简|清理)\s*$/.test(lower))
    return { intent: "compact", args: "" };

  // nl toggle
  if (/^nl\s*(on|off|开|关)?\s*$/.test(lower)) {
    const toggle = lower.match(/(on|off|开|关)/);
    return { intent: "nl", args: toggle ? (toggle[1] === "on" || toggle[1] === "开" ? "on" : "off") : "toggle" };
  }

  // ── Phase 2: LLM with context + confidence ────────────────────────────
  if (nlActive) {
    try {
      const ctx = NL_CONTEXT_ENABLED ? buildContext(us, sessions) : "";
      const prompt = ctx + `Classify intent. Output only JSON: {"intent":"<cmd>","args":"<arg>","confidence":<0-1>}

Intents: chat, sessions, recent, stats, resume, new, stop, force, confirm, deny, search, delete, model, system, current, help, compact

Rules:
- If text looks like conversation, not a command → chat with high confidence
- confidence < 0.6 → return "chat"
- Use exact session titles from context when matching
- Short imperative text may be a command; long descriptive text is chat

Examples:
"how does this work" → {"intent":"chat","args":"","confidence":0.95}
"tell me about it" → {"intent":"chat","args":"","confidence":0.95}
"show all sessions" → {"intent":"sessions","args":"all","confidence":0.95}
"switch to patent" → {"intent":"resume","args":"patent","confidence":0.95}
"stop" → {"intent":"stop","args":"","confidence":0.95}
"yes" → {"intent":"confirm","args":"","confidence":0.9}

Message: "${text}"
JSON:`;
      const result = await ollamaGenerate(prompt);
      const json = JSON.parse(result);
      if (json.intent === "chat" || (json.confidence || 0) < 0.6) {
        return { intent: "chat", args: "" };
      }
      if (json.intent && typeof json.intent === "string") return { intent: json.intent, args: json.args || "" };
    } catch (e) {
      log("warn", "nl llm classify failed", { error: e.message });
    }
  }

  return { intent: "chat", args: "" };
}

// ── permission risk assessment ─────────────────────────────────────────
function assessRiskByRule(title, type) {
  const t = (title + " " + (type || "")).toLowerCase();
  if (/^(read|list|ls|cat|grep|show|get|find|count|stat|ps|df|du|pwd|whoami|hostname)\b/.test(t) &&
      !/delete|rm|mv|kill|write|save|create/i.test(t)) return "low";
  if (/\b(delete|remove|rm|purge|drop|truncate)\b/i.test(t)) return "critical";
  if (/\b(write|save|create|mv|copy|install|paste|replace|append)\b/i.test(t)) return "high";
  if (/\b(network|fetch|http|curl|api)\b/i.test(t)) return "medium";
  return "unknown";
}

async function assessRiskByLLM(title, type) {
  try {
    const prompt = `Classify the risk level of this operation. Output only JSON: {"risk":"low|medium|high|critical","reason":"..."}

Operation title: "${title}"
Operation type: "${type || ''}"

Risk levels:
- low: read-only, no side effects (list, show, get, view, ls, cat, grep, stat)
- medium: network access or ambiguous commands
- high: file write, modify, or create
- critical: delete, remove, purge, or destructive operations

JSON:`;
    const result = await ollamaGenerate(prompt);
    const json = JSON.parse(result);
    if (json.risk) return json.risk;
  } catch (e) { /* fall through */ }
  return "medium";
}

// ── SSE event handling (permissions + async replies) ────────────────────
const activeTurns = new Map();        // sessionID → { userId, contextToken }
const pendingPermissions = new Map();  // sessionID → { permissionID, title }
const turnReplies = new Map();         // sessionID → { text: "" }
const pendingMessages = new Map();     // sessionID → { userId, contextToken, text }

async function startSSEListener() {
  while (running) {
    try {
      const resp = await fetch(`${SERVE_URL}/global/event`, { headers: serveAuthHeaders() });
      if (!resp.ok) throw new Error(`SSE HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("sse idle timeout")), 120_000)),
        ]);
        if (result.done) break;
        buf += decoder.decode(result.value, { stream: true });
        // /global/event sends SSE with \n\n delimiters
        buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const chunks = buf.split("\n\n");
        buf = chunks.pop() || "";
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          let eventType = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const raw = JSON.parse(data);
            // Unwrap /global/event envelope → extract payload
            const pt = raw.payload?.type || eventType;
            const props = raw.payload?.properties || raw;
            const sid = props.sessionID || raw.sessionID || "";
            log("debug", `sse ${pt}`, { sid: sid.slice(0, 20) });
            await handleSSEEvent(pt, { sessionID: sid, ...props });
          } catch {}
        }
      }
    } catch (e) { log("warn", "SSE error", { error: e.message }); }
    await sleep(5000);
  }
}

async function handleSSEEvent(event, data) {
  const sid = data.sessionID;
  switch (event) {
    case "permission.asked": {
      const turn = activeTurns.get(sid);
      if (!turn) return;
      const title = data.title || data.type || "Permission";
      const ruleRisk = assessRiskByRule(data.title, data.type);

      if (ruleRisk === "low") {
        try {
          const sdk = await getSdk();
          await sdk.permission.respond({ sessionID: sid, permissionID: data.id, response: "once" });
        } catch { /* ok, permission may have been answered elsewhere */ }
        return;
      }

      let risk = ruleRisk;
      if (risk === "unknown" && nlActive) {
        risk = await assessRiskByLLM(data.title, data.type);
      }

      const allowUpTo = { low: 1, medium: 2, high: 3, off: 0 }[PERMISSION_AUTO_APPROVE] ?? 1;
      const riskLevel = { low: 1, medium: 2, high: 3, critical: 4 }[risk] ?? 2;
      if (riskLevel <= allowUpTo) {
        try {
          const sdk = await getSdk();
          await sdk.permission.respond({ sessionID: sid, permissionID: data.id, response: "once" });
        } catch {}
        return;
      }

      const pt = { permissionID: data.id, title };
      pendingPermissions.set(sid, pt);
      sendToWeChat(turn.userId, `🔐 [${pt.title}]\n/confirm  /deny   or ask questions`, turn.contextToken).catch(()=>{});
      break;
    }
    case "message.part.updated": {
      if (!data.part || data.part.type !== "text") return;
      if (!activeTurns.has(sid)) {
        log("warn", "part no turn — dropped", { sid: sid.slice(0, 20), chars: (data.part.text || "").length });
        return;
      }
      const r = turnReplies.get(sid) || { text: "" };
      r.text += (data.part.text || "");
      turnReplies.set(sid, r);
      break;
    }
    case "session.idle": {
      log("debug", "idle", { sid: sid.slice(0, 20), hasTurn: activeTurns.has(sid) });
      const turn = activeTurns.get(sid);
      if (!turn) { log("warn", "idle no turn — response dropped", { sid: sid.slice(0, 20) }); return; }
      const reply = turnReplies.get(sid);
      const text = reply?.text || "";
      log("debug", "idle reply", { sid: sid.slice(0, 20), chars: text.length });
      turnReplies.delete(sid);
      activeTurns.delete(sid);
      pendingPermissions.delete(sid);
      pendingMessages.delete(sid);
      if (text) {
        const MAX_BYTES = 3500;
        let pos = 0;
        let chunkN = 0;
        while (pos < text.length) {
          let end = pos + 1;
          while (end <= text.length && Buffer.byteLength(text.slice(pos, end), "utf8") <= MAX_BYTES) end++;
          end--;
          log("debug", `idle send chunk ${chunkN}`, { sid: sid.slice(0, 20), bytes: Buffer.byteLength(text.slice(pos, end), "utf8") });
          ilinkSendText(turn.userId, text.slice(pos, end), turn.contextToken).catch(e => log("warn", "idle send fail", { sid: sid.slice(0, 20), error: e.message }));
          pos = end;
          chunkN++;
        }
      } else {
        log("debug", "idle done (empty)", { sid: sid.slice(0, 20) });
        ilinkSendText(turn.userId, "✅ Done (no text output).", turn.contextToken).catch(()=>{});
      }
      break;
    }
  }
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

function recordResume(userId, session) {
  const us = getUserState(userId);
  if (!us._recent) us._recent = [];
  us._recent = us._recent.filter(s => s.id !== session.id);
  us._recent.unshift({ id: session.id, title: session.title || "", directory: session.directory || "", ts: new Date().toISOString() });
  if (us._recent.length > 20) us._recent = us._recent.slice(0, 20);
  saveState(state);
}

// ── output NL translator ────────────────────────────────────────────────
function translateOutput(text) {
  let t = text;

  // Switch: "✅ Switched to: title (ses_xxx)" → "切换到「title」了。"
  t = t.replace(/✅ Switched to: (.+?) \(ses_\S+\)/g, '切换到「$1」了。');

  // New: "✅ Created: ses_xxx\nTitle: title"
  t = t.replace(/✅ Created: ses_\S+\nTitle: (.+)/g, '新建了「$1」。');

  // Delete: "✅ Deleted: title" → "删掉了「title」。"
  t = t.replace(/✅ Deleted: (.+)/g, '删掉了「$1」。');

  // Delete confirm: "⚠️ Confirm delete: title (ses_xxx)\nReply..."
  t = t.replace(/⚠️ Confirm delete: (.+?) \(ses_\S+\)\nReply .+/g, '确认删除「$1」？再说一次。');

  // Compact: "✅ Compacted." header
  t = t.replace(/✅ Compacted\./g, '压缩好了。');
  t = t.replace(/New session: ses_\S+/g, '');

  // Match lines: "[N] title (ses_xxx)" or "[N] title @dir"
  t = t.replace(/\[\d+\] (.+?) \(ses_\S+\)/g, '「$1」');
  t = t.replace(/\s+\[\d+\] (.+?) @\S+/g, '「$1」');

  // Match headers: "🔍 N matches" / "🔍 No exact match"
  t = t.replace(/🔍 (\d+) matches[^:]*:\n/g, '找到$1个：');
  t = t.replace(/🔍 No exact match for "(.+?)"\. Closest:\n/g, '没完全匹配「$1」。相近的有：');

  // Recent: "📌 Recent:\n" keep
  t = t.replace(/→ \/r N 切换\s*\|?\s*\/?resume?.*/g, '');
  t = t.replace(/→ \/s all \d+ 下一页/g, '');
  t = t.replace(/→ \/s all 全部\s*\|?\s*\/r 切换/g, '');

  // No session found
  t = t.replace(/❌ No session found\. \/s to browse, \/r for recent\./g, '没找到。说「列出」看全部。');
  t = t.replace(/❌ No session matching "(.+?)"\. .+/g, '没找到「$1」。输短关键词试试。');
  t = t.replace(/❌ Session .+ not found/g, '没找到那个会话。');

  // Index out of range: "❌ Index N out of range (0-M)"
  t = t.replace(/❌ Index (\d+) out of range \((\d+)-(\d+)\)/g, '编号不对，在$2到$3之间。');
  t = t.replace(/❌ Project index .+/g, '');

  // Current: "Session: ses_xxx\nModel: xxx" or "Session: (none)\nModel: xxx"
  t = t.replace(/Session: ses_\S+\nModel: (.+)/g, '当前用$1。');
  t = t.replace(/Session: \(none\)\nModel: (.+)/g, '还没选会话。当前用$1。');

  // Stats: "📊 N total · M projects · K active"
  t = t.replace(/📊 (\d+) total · (\d+) projects · (\d+) active/g, '共$1个会话、$2个项目、本周活跃$3个。');

  // Sessions summary: "📊 N sessions · M projects"
  t = t.replace(/📊 (\d+) sessions · (\d+) projects/g, '$1个会话、$2个项目。');

  // CLI hints cleanup
  t = t.replace(/Reply with "\/resume \[N\]"/g, '');
  t = t.replace(/Reply with number[^.]+\./g, '');
  t = t.replace(/Narrow your search\n?/g, '');
  t = t.replace(/Try a shorter keyword like (.+) to switch\./g, '说「切换 $1」试试。');

  // Trailing hints
  t = t.replace(/\n→ .+/g, '');
  t = t.replace(/→ $/g, '');
  t = t.replace(/\nUsage: .+/g, '');
  t = t.replace(/Available: .+/g, '');

  // Permission prompt: "/confirm /deny or ask questions"
  t = t.replace(/\/confirm\s*\/deny\s*or ask questions/g, '同意还是拒绝？');

  // Empty lines compact
  t = t.replace(/\n{3,}/g, '\n\n');

  // Clean trailing whitespace
  if (t !== text) return t.trim();
  return null;
}

async function sendToWeChat(userId, text, contextToken) {
  // Phase 1: regex translation
  const nl = translateOutput(text);
  if (nl) return ilinkSendText(userId, nl, contextToken);

  // Phase 2: LLM translation
  if (nlActive && /[🔍✅❌⚠️📊📌📋🕐📁🛠]/.test(text)) {
    try {
      const result = await ollamaGenerate(
        `Convert to natural Chinese for WeChat. Remove session IDs, slash commands, CLI formatting. Keep ≤150 chars.\nInput: "${text}"\nOutput:`
      );
      return ilinkSendText(userId, result.trim(), contextToken);
    } catch {}
  }

  // Pass through (already NL, or LLM unavailable)
  return ilinkSendText(userId, text, contextToken);
}

// ── command router ──────────────────────────────────────────────────────
async function handleCommand(userId, contextToken, text) {
  const us = getUserState(userId);
  const parts = text.trim().split(/\s+/);
  let cmd = parts[0].toLowerCase();

  // alias resolution
  if (cmd === "/s") cmd = "/sessions";
  else if (cmd === "/st") cmd = "/stats";
  else if (cmd === "/n") cmd = "/new";
  else if (cmd === "/rm") cmd = "/delete";
  else if (cmd === "/l" || cmd === "/list") cmd = "/sessions";
  else if (cmd === "/r") {
    if (parts.length === 1) cmd = "/recent";
    else if (/^\d+$/.test(parts[1])) cmd = "/recent";
    else cmd = "/resume";
  }

  try {
    switch (cmd) {
      case "/sessions": {
        const sessions = await serveListAllSessions();
        if (sessions.length === 0) {
          await sendToWeChat(userId, "No sessions.", contextToken);
          return;
        }
        const { groups, order } = getProjectGroups(sessions);
        const arg = parts.slice(1).join(" ").trim();

        // /s all → paginated list
        if (arg === "all" || arg === "全部") {
          const page = Math.max(0, parseInt(parts[2]) || 0);
          const perPage = 8;
          const totalPages = Math.ceil(sessions.length / perPage);
          const start = page * perPage;
          const chunk = sessions.slice(start, start + perPage);
          const lines = [`📋 ${page + 1}/${totalPages} (${sessions.length} total)`];
          chunk.forEach((s, j) => {
            const dir = (s.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?";
            const active = s.id === us.activeSession ? ">" : " ";
            lines.push(`${active}${start + j} ${s.title} @${dir}`);
          });
          if (page + 1 < totalPages) lines.push(`→ /s all ${page + 1} 下一页`);
          await sendToWeChat(userId, lines.join("\n"), contextToken);
          return;
        }

        // /s <project> → filter
        if (arg) {
          const lower = arg.toLowerCase();
          const keywords = lower.split(/\s+/).filter(Boolean);
          const matchIdx = order.findIndex(d => keywords.every(k => d.toLowerCase().includes(k)));
          if (matchIdx >= 0) {
            const dir = order[matchIdx];
            await sendToWeChat(userId, formatSessionsInProject(dir, groups[dir], us.activeSession), contextToken);
          } else {
            // auto-fallback: unknown project → show all
            const page = Math.max(0, parseInt(parts[2]) || 0);
            const perPage = 8;
            const totalPages = Math.ceil(sessions.length / perPage);
            const start = page * perPage;
            const chunk = sessions.slice(start, start + perPage);
            const lines = [`📋 ${page + 1}/${totalPages} (${sessions.length} total)`];
            chunk.forEach((s, j) => {
              const dir = (s.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?";
              const active = s.id === us.activeSession ? ">" : " ";
              lines.push(`${active}${start + j} ${s.title} @${dir}`);
            });
            if (page + 1 < totalPages) lines.push(`→ /s all ${page + 1} 下一页`);
            await sendToWeChat(userId, lines.join("\n"), contextToken);
          }
          return;
        }

        // /s → summary
        const recent = (us._recent || []).slice(0, 5);
        const lines = [`📊 ${sessions.length} sessions · ${order.length} projects`];
        if (recent.length > 0) {
          lines.push("");
          lines.push("🕐 Recent:");
          recent.forEach((s, i) => {
            const dir = (s.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?";
            lines.push(`  ${i} ${s.title}  @${dir}`);
          });
        }
        lines.push("");
        lines.push("📁 Projects:");
        order.forEach(d => lines.push(`  ${d}  ${groups[d].length}  /s ${d}`));
        lines.push("");
        lines.push("→ /s all 全部  |  /r 切换");
        await sendToWeChat(userId, lines.join("\n"), contextToken);
        break;
      }

      case "/recent": {
        let recent = us._recent || [];
        // auto-populate from active session on first use
        if (recent.length === 0 && us.activeSession) {
          const sessions = await serveListAllSessions();
          const cur = sessions.find(s => s.id === us.activeSession);
          if (cur) { recordResume(userId, cur); recent = us._recent || []; }
        }
        if (recent.length === 0) {
          await sendToWeChat(userId, "No recent sessions. /resume to switch first, or /s to browse.", contextToken);
          return;
        }
        const arg = parts.slice(1).join(" ").trim();
        if (arg && /^\d+$/.test(arg)) {
          const idx = parseInt(arg);
          if (idx >= 0 && idx < recent.length) {
            us.activeSession = recent[idx].id;
            us.activeDirectory = recent[idx].directory;
            saveState(state);
            await sendToWeChat(userId, `✅ ${recent[idx].title} (${recent[idx].id})`, contextToken);
          } else {
            await sendToWeChat(userId, `❌ Index ${idx} out of range (0-${recent.length - 1})`, contextToken);
          }
          return;
        }
        const lines = ["📌 Recent:"];
        recent.forEach((s, i) => {
          const dir = (s.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?";
          const active = s.id === us.activeSession ? ">" : " ";
          lines.push(`${active}${i} ${s.title}  @${dir}`);
        });
        lines.push("", "→ /r N 切换  |  /resume 名字 搜索");
        await sendToWeChat(userId, lines.join("\n"), contextToken);
        break;
      }

      case "/stats": {
        const sessions = await serveListAllSessions();
        if (sessions.length === 0) {
          await sendToWeChat(userId, "No sessions.", contextToken);
          return;
        }
        const { groups, order } = getProjectGroups(sessions);
        const recent = us._recent || [];
        const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
        const weekActive = recent.filter(s => s.ts >= weekAgo).length;
        const lines = [`📊 ${sessions.length} total · ${order.length} projects · ${weekActive} active this week`];
        const maxCount = Math.max(...order.map(d => groups[d].length), 1);
        order.forEach(d => {
          const count = groups[d].length;
          const w = Math.round(count / maxCount * 10);
          const bar = "█".repeat(w) + (w < 10 ? "▌" : "");
          lines.push(`  ${d.padEnd(12)} ${String(count).padStart(2)}  ${bar}`);
        });
        await sendToWeChat(userId, lines.join("\n"), contextToken);
        break;
      }

      case "/new": {
        const title = parts.slice(1).join(" ") || "WeChat session";
        const session = await serveCreateSession(title);
        us.activeSession = session.id;
        saveState(state);
        recordResume(userId, session);
        await sendToWeChat(userId, `✅ Created: ${session.id}\nTitle: ${title}`, contextToken);
        break;
      }

      case "/resume": {
        const query = parts.slice(1).join(" ").trim();
        const sessions = await serveListAllSessions();
        if (!query) {
          if (sessions.length === 0) {
            await sendToWeChat(userId, "No sessions found.", contextToken);
          } else {
            const { groups, order } = getProjectGroups(sessions);
            await sendToWeChat(userId, formatProjectsList(groups, order), contextToken);
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
            recordResume(userId, sessions[idx]);
            await sendToWeChat(userId, `✅ Switched to: ${sessions[idx].title} (${sessions[idx].id})`, contextToken);
          } else {
            await sendToWeChat(userId, `❌ Index ${idx} out of range (0-${sessions.length - 1})`, contextToken);
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
            recordResume(userId, match);
            await sendToWeChat(userId, `✅ Switched to: ${match.title} (${match.id})`, contextToken);
          } else {
            await sendToWeChat(userId, `❌ Session ${query} not found`, contextToken);
          }
          return;
        }
        // Fuzzy match by title + directory
        const matches = sessions.filter(s => {
          const haystack = `${s.title} ${s.directory}`.toLowerCase();
          const keywords = lowerQ.split(/\s+/).filter(Boolean);
          return keywords.every(k => haystack.includes(k));
        });
        if (matches.length === 1) {
          us.activeSession = matches[0].id;
          us.activeDirectory = matches[0].directory;
          saveState(state);
          recordResume(userId, matches[0]);
          await sendToWeChat(userId, `✅ Switched to: ${matches[0].title} (${matches[0].id})`, contextToken);
        } else if (matches.length > 1 && matches.length <= 5) {
          const lines = matches.map((s, i) => `[${i}] ${s.title} (${s.id})`);
          await sendToWeChat(userId, `🔍 ${matches.length} matches:\n${lines.join("\n")}\nReply with "/resume [N]"`, contextToken);
        } else if (matches.length > 5) {
          const lines = matches.slice(0, 5).map((s, i) => `[${i}] ${s.title} (${s.id})`);
          await sendToWeChat(userId, `🔍 ${matches.length} matches (showing first 5):\n${lines.join("\n")}\nNarrow your search`, contextToken);
        } else {
          // No keyword match → substring search for closest
          const subs = sessions.filter(s => {
            const t = (s.title || "").toLowerCase();
            return lowerQ.slice(0, 10).split(/\s+/).some(k => k.length >= 2 && t.includes(k));
          }).slice(0, 5);
          if (subs.length > 0) {
            const lines = [`🔍 No exact match for "${query}". Closest:`];
            subs.forEach(s => {
              const dir = (s.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?";
              lines.push(`  ${s.title}  @${dir}`);
            });
            lines.push("", "Try a shorter keyword like " + subs[0].title.split(/\s+/).slice(0, 2).join(" ") + " to switch.");
            await sendToWeChat(userId, lines.join("\n"), contextToken);
          } else {
            await sendToWeChat(userId, `❌ No session found. /s to browse, /r for recent.`, contextToken);
          }
        }
        break;
      }

      case "/model": {
        if (parts.length < 2) {
          await sendToWeChat(userId,
            `Current: ${us.model}\nAvailable: deepseek/deepseek-v4-pro, xiaomi/mimo-v2.5, xiaomi/mimo-v2.5-pro`,
            contextToken);
          return;
        }
        us.model = parts[1];
        saveState(state);
        await sendToWeChat(userId, `✅ Model: ${us.model}`, contextToken);
        break;
      }

      case "/nl": {
        if (parts.length < 2) {
          const mode = nlActive ? "on" : "off";
          const info = nlOllamaAvailable ? ` (ollama: ${NL_CLASSIFY_MODEL})` : " (ollama unavailable, keywords only)";
          await sendToWeChat(userId, `NL mode: ${mode}${info}`, contextToken);
          return;
        }
        const arg = parts[1].toLowerCase();
        if (arg === "on" || arg === "开") {
          nlUserOverride = true;
          updateNlState();
          saveState(state);
          await sendToWeChat(userId, "✅ NL mode on.", contextToken);
        } else if (arg === "off" || arg === "关") {
          nlUserOverride = false;
          updateNlState();
          saveState(state);
          await sendToWeChat(userId, "✅ NL mode off.", contextToken);
        } else {
          await sendToWeChat(userId, "Usage: /nl on | /nl off", contextToken);
        }
        break;
      }

      case "/system": {
        if (parts.length < 2) {
          await sendToWeChat(userId, `Current system prompt:\n"${us.systemPrompt}"\n\nUsage: /system <new prompt> or /system off`, contextToken);
          return;
        }
        const newPrompt = parts.slice(1).join(" ").trim();
        if (newPrompt.toLowerCase() === "off") {
          us.systemPrompt = "";
          saveState(state);
          await sendToWeChat(userId, "✅ System prompt disabled.", contextToken);
        } else {
          us.systemPrompt = newPrompt;
          saveState(state);
          await sendToWeChat(userId, `✅ System prompt set:\n"${us.systemPrompt}"`, contextToken);
        }
        break;
      }

      case "/stop": {
        if (!us.activeSession) {
          await sendToWeChat(userId, "No active session to stop.", contextToken);
          return;
        }
        try {
          const sdk = await getSdk();
          await sdk.session.abort({ sessionID: us.activeSession });
          activeTurns.delete(us.activeSession);
          pendingPermissions.delete(us.activeSession);
          turnReplies.delete(us.activeSession);
          pendingMessages.delete(us.activeSession);
          await sendToWeChat(userId, "✅ Interrupt signal sent.", contextToken);
        } catch (e) {
          await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/force": {
        if (!us.activeSession) { await sendToWeChat(userId, "No active session.", contextToken); return; }
        const pending = pendingMessages.get(us.activeSession);
        if (!pending) { await sendToWeChat(userId, "No pending message. Send a message first when the session is busy.", contextToken); return; }
        pendingMessages.delete(us.activeSession);
        try {
          const sdk = await getSdk();
          await sdk.session.abort({ sessionID: us.activeSession });
        } catch { /* ignore abort errors */ }
        activeTurns.delete(us.activeSession);
        pendingPermissions.delete(us.activeSession);
        turnReplies.delete(us.activeSession);
        try {
          inflight++;
          await serveSendMessageAsync(us.activeSession, pending.text, us.systemPrompt);
          activeTurns.set(us.activeSession, { userId, contextToken });
          turnReplies.set(us.activeSession, { text: "" });
          await sendToWeChat(userId, `🔄 Interrupted. Sending: "${pending.text.slice(0, 50)}${pending.text.length > 50 ? "..." : ""}"`, contextToken);
        } catch (e) {
          await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
        } finally {
          inflight--;
        }
        break;
      }

      case "/confirm": {
        if (!us.activeSession) { await sendToWeChat(userId, "No active session.", contextToken); return; }
        const pp = pendingPermissions.get(us.activeSession);
        if (!pp) { await sendToWeChat(userId, "No pending permission to confirm.", contextToken); return; }
        try {
          const sdk = await getSdk();
          await sdk.permission.respond({ sessionID: us.activeSession, permissionID: pp.permissionID, response: "once" });
          await sendToWeChat(userId, "✅ Approved.", contextToken);
        } catch (e) {
          await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/deny": {
        if (!us.activeSession) { await sendToWeChat(userId, "No active session.", contextToken); return; }
        const pp = pendingPermissions.get(us.activeSession);
        if (!pp) { await sendToWeChat(userId, "No pending permission to deny.", contextToken); return; }
        try {
          const sdk = await getSdk();
          await sdk.permission.respond({ sessionID: us.activeSession, permissionID: pp.permissionID, response: "reject" });
          await sendToWeChat(userId, "❌ Denied.", contextToken);
        } catch (e) {
          await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/search": {
        const query = parts.slice(1).join(" ").trim();
        if (!query) { await sendToWeChat(userId, "Usage: /search <keyword>", contextToken); return; }
        const sessions = await serveListAllSessions();
        const lowerQ = query.toLowerCase();
        const matches = sessions.filter(s => `${s.title} ${s.directory}`.toLowerCase().includes(lowerQ));
        if (matches.length === 0) {
          await sendToWeChat(userId, `No sessions matching "${query}"`, contextToken);
        } else {
          const idMap = new Map(sessions.map((s, i) => [s.id, i]));
          const lines = matches.map(s => {
            const dir = s.directory.split(/[\/\\]/).filter(Boolean).pop() || "?";
            return `[${idMap.get(s.id)}] ${s.title} @${dir}`;
          });
          await sendToWeChat(userId, `🔍 ${matches.length} matches:\n${lines.join("\n")}`, contextToken);
        }
        break;
      }

      case "/delete": {
        const target = parts[1];
        if (!target) { await sendToWeChat(userId, "Usage: /delete <id> or /delete [N]", contextToken); return; }
        const sessions = await serveListAllSessions();
        let session = null;
        if (target.startsWith("ses_")) session = sessions.find(s => s.id === target);
        else if (/^\d+$/.test(target)) {
          const idx = parseInt(target);
          if (idx >= 0 && idx < sessions.length) session = sessions[idx];
        }
        if (!session) { await sendToWeChat(userId, `Session not found: ${target}`, contextToken); return; }
        if (us._pendingDelete !== session.id) {
          us._pendingDelete = session.id;
          saveState(state);
          await sendToWeChat(userId, `⚠️ Confirm delete: ${session.title} (${session.id})\nReply with /delete ${target} again to confirm.`, contextToken);
          return;
        }
        us._pendingDelete = null;
        saveState(state);
        try {
          const sdk = await getSdk();
          await sdk.session.delete({ sessionID: session.id });
          if (us.activeSession === session.id) us.activeSession = null;
          saveState(state);
          await sendToWeChat(userId, `✅ Deleted: ${session.title}`, contextToken);
        } catch (e) {
          await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/compact": {
        if (!us.activeSession) { await sendToWeChat(userId, "No active session.", contextToken); return; }
        try {
          await sendToWeChat(userId, "⏳ Compacting...", contextToken);
          const sdk = await getSdk();
          await sdk.session.abort({ sessionID: us.activeSession });
          await sleep(3000); // wait for abort to settle
          const result = await sdk.session.promptAsync({
            sessionID: us.activeSession,
            parts: [{ type: "text", text: "Summarize the current conversation context in one paragraph, preserving all key facts, decisions, and pending tasks." }],
          });
          if (result.error) throw new Error(`SDK error: ${result.error}`);
          const newSession = await serveCreateSession("(compact) " + (new Date().toLocaleDateString()));
          us.activeSession = newSession.id;
          saveState(state);
          const summaryText = extractText(result.data.parts) || "(no summary)";
          await sendToWeChat(userId, `✅ Compacted.\nNew session: ${newSession.id}\nSummary:\n${summaryText}`, contextToken);
        } catch (e) {
          await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
        }
        break;
      }

      case "/current": {
        await sendToWeChat(userId, `Session: ${us.activeSession || "(none)"}\nModel: ${us.model}`, contextToken);
        break;
      }

      case "/help": {
        const nlNote = nlActive ? "\n\n💬 NL mode ON — you can use natural language instead of commands." : "";
        await sendToWeChat(userId,
          "🛠 /s sessions · /r recent · /st stats\n/sessions — Browse (summary + filter)\n/s all — All sessions paginated\n/r recent — Recent sessions\n/r N — Switch by recent index\n/st stats — Session statistics\n/n new [title] — Create session\n/resume <keyword> — Fuzzy search & switch\n/stop — Interrupt task\n/force — Interrupt & send queued\n/confirm — Approve permission\n/deny — Deny permission\n/search <word> — Search\n/delete <id> — Delete (double-confirm)\n/compact — Compress context\n/model [name] — Show/switch model\n/system — Show/set system prompt\n/nl [on|off] — NL mode\n/current — Current session\n/help — This help" + nlNote,
          contextToken);
        break;
      }

      default:
        await sendToWeChat(userId, `Unknown: ${cmd}. Use /help.`, contextToken);
    }
  } catch (e) {
    log("error", "command failed", { cmd, error: e.message });
    await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
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
  const hasMedia = Array.isArray(msg.item_list) && msg.item_list.some(item => item.type === 2 || item.type === 3 || item.type === 4 || item.type === 5);
  if (!text) {
    if (hasMedia) await sendToWeChat(userId, "📷 收到图片/文件，当前模型不支持多媒体处理。请用文字描述。", contextToken);
    return;
  }

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

  // NL classification
  const sessions = await getSessions();
  const { intent, args } = await nlClassifyIntent(text, us, sessions);
  if (intent !== "chat") {
    log("info", `nl routed`, { text: text.slice(0, 50), intent, args });
    const cmdText = `/${intent}${args ? " " + args : ""}`;
    await handleCommand(userId, contextToken, cmdText);
    return;
  }

  // Regular message
  if (!us.activeSession) {
    await sendToWeChat(userId, "⚠️ No active session. Use /list && /resume <id> first.", contextToken);
    return;
  }

  if (pendingPermissions.has(us.activeSession)) {
    const pp = pendingPermissions.get(us.activeSession);
    try {
      const sdk = await getSdk();
      await sdk.permission.respond({ sessionID: us.activeSession, permissionID: pp.permissionID, response: "reject" });
    } catch {
      log("warn", "auto-deny failed, keeping permission pending");
      return;
    }
    pendingPermissions.delete(us.activeSession);
    await sendToWeChat(userId, `❌ Denied previous request.\nForwarding: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"\n\nRe-send your original message to retry.`, contextToken);
    return;
  }

  if (activeTurns.has(us.activeSession)) {
    pendingMessages.set(us.activeSession, { userId, contextToken, text });
    await sendToWeChat(userId, `⏳ Session is busy. Reply /force to interrupt and send, or wait for the current task to finish.\n\nYour message: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`, contextToken);
    return;
  }

  try {
    inflight++;
    log("debug", "turn start", { sid: us.activeSession.slice(0, 20), chars: text.length });
    await serveSendMessageAsync(us.activeSession, text, us.systemPrompt);
    activeTurns.set(us.activeSession, { userId, contextToken });
    turnReplies.set(us.activeSession, { text: "" });
    await sendToWeChat(userId, "⏳ Processing...", contextToken);
  } catch (e) {
    log("error", "serve msg failed", { error: e.message });
    await sendToWeChat(userId, `❌ ${e.message}`, contextToken);
  } finally {
    inflight--;
  }
}

// ── main loop ───────────────────────────────────────────────────────────
let running = true;
let inflight = 0;

let serveProcess = null;

async function shutdown(signal) {
  running = false;
  if (serveProcess) {
    log("info", "stopping opencode serve...");
    try { serveProcess.kill("SIGTERM"); } catch (e) { log("warn", "serve kill failed", { error: e.message }); }
    try {
      await Promise.race([
        new Promise((r) => { serveProcess.on("exit", r); }),
        sleep(5000),
      ]);
    } catch {}
    serveProcess = null;
  }
  log("info", `shutting down (${signal}), ${inflight} in-flight...`);
  for (let i = 0; i < 30 && inflight > 0; i++) await sleep(1000);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  log("info", "wx-bridge starting", { ilink_base: ILINK_BASE, serve_url: SERVE_URL, poll_ms: POLL_MS });

  // ── NL classifier init ─────────────────────────────────────────────────
  try {
    nlOllamaAvailable = await nlDetectOllama();
    updateNlState();
    log("info", `nl classifier`, { active: nlActive, ollama: nlOllamaAvailable, model: NL_CLASSIFY_MODEL });
  } catch {
    log("warn", "nl init failed, classification disabled");
  }

  // ── opencode serve auto-start ──────────────────────────────────────────
  let serveAlive = false;
  try {
    const resp = await fetch(`${SERVE_URL}/global/health`, { headers: serveAuthHeaders(), signal: AbortSignal.timeout(3000) });
    serveAlive = true; // any HTTP response means serve is listening
  } catch {}

  if (!serveAlive) {
    const bin = findOpenCode();
    if (existsSync(bin)) {
      log("info", `starting opencode serve on port ${OCODE_PORT}...`);
      serveProcess = spawn(bin, ["serve", "--port", OCODE_PORT, "--hostname", OCODE_HOST], { stdio: "pipe", env: process.env });
      serveProcess.stdout.on("data", (d) => log("debug", "serve", { text: d.toString().trim() }));
      serveProcess.stderr.on("data", (d) => log("debug", "serve", { text: d.toString().trim() }));
      serveProcess.on("error", (e) => log("error", "serve spawn error", { error: e.message }));
      serveProcess.on("exit", (code) => {
        log("info", `serve exited (code ${code})`);
        serveProcess = null;
      });
      log("info", `spawned opencode serve pid ${serveProcess.pid}`);
    } else {
      log("warn", `opencode binary not found at ${bin}, cannot auto-start`);
    }
  } else {
    log("info", "opencode serve already running");
  }

  // ── serve heartbeat ──────────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    try {
      const resp = await fetch(`${SERVE_URL}/global/health`, { headers: serveAuthHeaders(), signal: AbortSignal.timeout(5000) });
      log("info", `serve ready (attempt ${i + 1}, status ${resp.status})`);
      break; // any response = serve is up
    } catch {
      if (i === 9) { log("error", "serve unreachable after 10 attempts, exiting"); try { unlinkSync(PID_FILE); } catch {} process.exit(1); }
      await sleep(3000);
    }
  }

  log("info", "starting SSE listener");
  startSSEListener().catch(e => log("error", "SSE listener crashed", { error: e.message }));

  // warm session cache
  getSessions().catch(() => {});

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
      for (const msg of (resp.data.msgs || [])) { if (msg.message_type === 1) await handleMessage(msg); }
    } catch (e) {
      log("warn", "poll error", { error: e.message });
      backoff = Math.min((backoff || 1000) * 2, maxBackoff);
      await sleep(backoff);
    }
  }
  log("info", "wx-bridge stopped");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { log("error", "fatal", { error: e.message }); process.exit(1); });
