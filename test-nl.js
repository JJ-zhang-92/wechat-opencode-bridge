// test-nl.js — standalone NL classifier test (no bridge startup)

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const NL_CLASSIFY_MODEL = process.env.NL_CLASSIFY_MODEL || "qwen2.5:7b";
const CAPABILITY_HINT = "legal, patent, chemistry, docs, image gen";

// ── buildContext (mirrors wx-bridge.mjs) ──
function buildContext(us, sessions) {
  try {
    const parts = ["[CONTEXT]"];
    if (us.activeSession) {
      const cur = sessions.find(s => s.id === us.activeSession);
      if (cur) {
        const dir = (cur.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?";
        parts.push(`Active: ${cur.title} (${dir})`);
      }
    }
    const dirs = [...new Set(sessions.map(s => s.directory).filter(Boolean))];
    if (dirs.length) {
      parts.push(`Projects: ${dirs.map(d => d.split(/[\/\\]/).filter(Boolean).pop() || "?").join(", ")}`);
    }
    const recent = (us._recent || []).slice(0, 8);
    if (recent.length) {
      parts.push(`Recent: ${recent.map(s => `[${s.title}] (${(s.directory || "").split(/[\/\\]/).filter(Boolean).pop() || "?"})`).join(", ")}`);
    }
    const titles = sessions.map(s => `[${s.title}]`).join(", ");
    if (titles.length > 400) {
      parts.push(`Titles: ${titles.slice(0, 400)}...`);
    } else if (titles) {
      parts.push(`Titles: ${titles}`);
    }
    if (parts.length === 1) return "";
    parts.push(`Main: ${CAPABILITY_HINT}`);
    parts.push("---\n");
    return parts.join("\n");
  } catch { return ""; }
}

// ── ollamaGenerate ──
async function ollamaGenerate(prompt) {
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NL_CLASSIFY_MODEL, prompt, stream: false, options: { num_predict: 32, temperature: 0 } }),
  });
  if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.response || "").trim();
}

// ── nlClassifyIntent (mirrors wx-bridge.mjs) ──
async function nlClassifyIntent(text, us, sessions, nlActive) {
  const lower = text.toLowerCase();

  // gate: multi-line and URLs don't need LLM
  if (lower.includes("\n")) return { intent: "chat", args: "", phase: 0, reason: "multiline" };
  if (/^https?:\/\//i.test(lower)) return { intent: "chat", args: "", phase: 0, reason: "URL" };

  // Phase 1: high-precision keyword matching (optimization only)
  let m;

  m = lower.match(/^(切换|切换到|进入|回到|打开|switch|resume|继续)\s+(\S.{1,60}?)$/);
  if (m) return { intent: "resume", args: m[2].trim(), phase: 1, reason: "verb+arg" };

  // exact title match → resume
  const titleMatch = sessions.find(s => (s.title || "").toLowerCase() === lower);
  if (titleMatch) return { intent: "resume", args: titleMatch.title, phase: 1, reason: "exact title" };

  if (/^(列出|查看|看|显示|show|看看|全部|所有|list|sessions?)\s*$/.test(lower))
    return { intent: "sessions", args: "", phase: 1, reason: "keyword" };
  m = lower.match(/^(list|sessions?|列出|查看|看)\s+(\S.+)/);
  if (m) return { intent: "sessions", args: m[2].trim(), phase: 1, reason: "keyword+arg" };

  if (/^(最近|recent|latest|刚才)\s*$/.test(lower)) return { intent: "recent", args: "", phase: 1, reason: "keyword" };
  if (/^(统计|stats?)\s*$/.test(lower)) return { intent: "stats", args: "", phase: 1, reason: "keyword" };

  m = lower.match(/^(新建|创建|建|new)\s*(.+)?/);
  if (m) return { intent: "new", args: (m[2] || "").trim(), phase: 1, reason: "keyword" };

  m = lower.match(/^(搜索|查找|search|find|找)\s+(\S.+)/);
  if (m) return { intent: "search", args: m[2].trim(), phase: 1, reason: "keyword+arg" };

  m = lower.match(/^(删除|delete|remove|删)\s+(\S.+)/);
  if (m) return { intent: "delete", args: m[2].trim(), phase: 1, reason: "keyword+arg" };

  m = lower.match(/^(模型|model)\s*(.+)?/);
  if (m) return { intent: "model", args: (m[2] || "").trim(), phase: 1, reason: "keyword" };

  m = lower.match(/^(系统|设定指令|system)\s*(.+)?/);
  if (m) return { intent: "system", args: (m[2] || "").trim(), phase: 1, reason: "keyword" };

  if (/^(同意|确认|通过|允许|approve|yes|好|可以|行|ok)\s*$/.test(lower))
    return { intent: "confirm", args: "", phase: 1, reason: "keyword" };

  if (/^(拒绝|不同意|deny|no|不许|不行|不可以)\s*$/.test(lower))
    return { intent: "deny", args: "", phase: 1, reason: "keyword" };

  if (/^(停[止下]|中断|abort|取消)\b/.test(lower) || /^(别)(跑|干|搞|弄)/.test(lower))
    return { intent: "stop", args: "", phase: 1, reason: "keyword" };

  if (/^(强制|打断|force|强行)\s*$/.test(lower))
    return { intent: "force", args: "", phase: 1, reason: "keyword" };

  if (/^(帮助|help|功能|命令|怎么|说明|教程)\s*$/.test(lower))
    return { intent: "help", args: "", phase: 1, reason: "keyword" };

  if (/^(当前|状态|status|在哪|哪个)\s*$/.test(lower))
    return { intent: "current", args: "", phase: 1, reason: "keyword" };

  if (/^(压缩|compact|精简|清理)\s*$/.test(lower))
    return { intent: "compact", args: "", phase: 1, reason: "keyword" };

  if (/^nl\s*(on|off|开|关)?\s*$/.test(lower)) {
    const toggle = lower.match(/(on|off|开|关)/);
    return { intent: "nl", args: toggle ? (toggle[1] === "on" || toggle[1] === "开" ? "on" : "off") : "toggle", phase: 1, reason: "keyword" };
  }

  // Phase 2: LLM
  if (nlActive) {
    try {
      const ctx = buildContext(us, sessions);
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
        return { intent: "chat", args: "", phase: 2, reason: `llm:${json.confidence || "?"}` };
      }
      if (json.intent && typeof json.intent === "string") return { intent: json.intent, args: json.args || "", phase: 2, reason: `llm:${json.confidence || "?"}` };
    } catch (e) { /* fall through */ }
  }

  return { intent: "chat", args: "", phase: 2, reason: "fallback" };
}

// ── test data ──
const sessions = [
  { id: "ses_0", title: "Pt催化亚甲基蓝滴数法测氢完整实验方案", directory: "C:\\science\\实验方案" },
  { id: "ses_1", title: "OER专利撰写", directory: "C:\\patent" },
  { id: "ses_2", title: "专利答辩一审", directory: "C:\\patent" },
  { id: "ses_3", title: "抖音普法文案v2", directory: "C:\\douyin" },
  { id: "ses_4", title: "抖音AI科普", directory: "C:\\douyin" },
  { id: "ses_5", title: "浙江康复医院法律服务项目", directory: "C:\\lawyer" },
  { id: "ses_6", title: "法律投标文件", directory: "C:\\lawyer" },
  { id: "ses_7", title: "Z-Image测试", directory: "C:\\tools" },
  { id: "ses_8", title: "OpenCode微信桥接开发", directory: "C:\\.opencode" },
  { id: "ses_9", title: "架构师模式分析wechat-opencode-bridge", directory: "C:\\.opencode" },
  { id: "ses_10", title: "微信链接二维码显示", directory: "C:\\.opencode" },
  { id: "ses_11", title: "文件相似度", directory: "C:\\tools" },
  { id: "ses_12", title: "慕容复第五卷剧情讨论启动", directory: "C:\\fiction" },
  { id: "ses_13", title: "慕容复第三卷写作计划", directory: "C:\\fiction" },
];

const us = {
  activeSession: "ses_0",
  _recent: [
    { id: "ses_0", title: "Pt催化亚甲基蓝滴数法测氢完整实验方案", directory: "C:\\science\\实验方案" },
    { id: "ses_8", title: "OpenCode微信桥接开发", directory: "C:\\.opencode" },
    { id: "ses_3", title: "抖音普法文案v2", directory: "C:\\douyin" },
    { id: "ses_1", title: "OER专利撰写", directory: "C:\\patent" },
  ],
};

// ── test cases ──
const tests = [
  { input: "Pt催化亚甲基蓝滴数法测氢完整实验方案", expected: "resume" },
  { input: "打开 Pt催化亚甲基蓝滴数法测氢完整实验方案", expected: "resume" },
  { input: "Pt催化", expected: "chat" },
  { input: "切换 Pt催化", expected: "resume" },
  { input: "列出", expected: "sessions" },
  { input: "打开这个session", expected: "resume" },
  { input: "切换专利", expected: "resume" },
  { input: "最近", expected: "recent" },
  { input: "统计", expected: "stats" },
  { input: "好", expected: "confirm" },
  { input: "同意", expected: "confirm" },
  { input: "行", expected: "confirm" },
  { input: "拒绝", expected: "deny" },
  { input: "这个方案再加一组对照实验，用同样的催化剂但提高温度到80度试试", expected: "chat" },
  { input: "有结果了吗", expected: "chat" },
  { input: "对了，之前那个专利的对比实验数据发我一下", expected: "chat" },
  { input: "专利", expected: "search" },
  { input: "法律 投标", expected: "search" },
  { input: "没有权限？", expected: "chat" },
  { input: "查看文件列表", expected: "search" },
  { input: "看下文件", expected: "chat" },
  { input: "停下", expected: "stop" },
  { input: "别跑了", expected: "stop" },
  { input: "强制", expected: "force" },
  { input: "帮助", expected: "help" },
  { input: "怎么用", expected: "chat" },
  { input: "当前", expected: "current" },
  { input: "这个模型架构怎么设计", expected: "chat" },
  { input: "开放一个专利的session", expected: "resume" },
  { input: "切换法律", expected: "resume" },
  { input: "搜索抖音", expected: "search" },
  { input: "建一个关于测试的新会话", expected: "new" },
  { input: "删除test", expected: "delete" },
  { input: "别干了", expected: "stop" },
];

// ── run ──
async function main() {
  // Check ollama
  let nlActive = false;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) { nlActive = true; console.log("✓ ollama available\n"); }
    else { console.log("✗ ollama not available, Phase 2 skipped\n"); }
  } catch {
    console.log("✗ ollama unreachable, Phase 2 skipped\n");
  }

  let pass = 0, fail = 0;
  const results = [];

  for (const t of tests) {
    const start = Date.now();
    const r = await nlClassifyIntent(t.input, us, sessions, nlActive);
    const ms = Date.now() - start;
    const ok = r.intent === t.expected;
    const mark = ok ? "✓" : "✗";
    if (ok) pass++; else fail++;

    const res = `${mark} P${r.phase} | ${ms}ms | "${t.input}" → ${r.intent}${r.args ? ":" + r.args : ""} (${r.reason})`;
    results.push({ ok, res, expected: t.expected, got: r.intent });
    console.log(res);
  }

  console.log(`\n${pass}/${tests.length} pass, ${fail} fail`);

  if (fail > 0) {
    console.log("\nFailures:");
    results.filter(r => !r.ok).forEach(r => console.log(r.res));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
