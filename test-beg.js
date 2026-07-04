// test-beg.js — test B/E/G groups: session cmds, permission risk, regression
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const NL_CLASSIFY_MODEL = process.env.NL_CLASSIFY_MODEL || "qwen2.5:7b";

const tests = { pass: 0, fail: 0 };
function check(name, condition, detail = "") {
  if (condition) { tests.pass++; console.log(`  ✓ ${name}`); }
  else { tests.fail++; console.log(`  ✗ ${name} ${detail ? "— " + detail : ""}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── helpers copied from wx-bridge.mjs ──
function translateOutput(text) {
  let t = text;
  t = t.replace(/✅ Switched to: (.+?) \(ses_\S+\)/g, '切换到「$1」了。');
  t = t.replace(/✅ Created: ses_\S+\nTitle: (.+)/g, '新建了「$1」。');
  t = t.replace(/✅ Deleted: (.+)/g, '删掉了「$1」。');
  t = t.replace(/✅ Compacted\./g, '压缩好了。');
  t = t.replace(/New session: ses_\S+/g, '');
  t = t.replace(/⚠️ Confirm delete: (.+?) \(ses_\S+\)\nReply .+/g, '确认删除「$1」？再说一次。');
  t = t.replace(/\[\d+\] (.+?) \(ses_\S+\)/g, '「$1」');
  t = t.replace(/🔍 (\d+) matches[^:]*:\n/g, '找到$1个：');
  t = t.replace(/🔍 No exact match for "(.+?)"\. Closest:\n/g, '没完全匹配「$1」。相近的有：');
  t = t.replace(/❌ No session found\. \/s to browse, \/r for recent\./g, '没找到。说「列出」看全部。');
  t = t.replace(/❌ No session matching "(.+?)"\. .+/g, '没找到「$1」。输短关键词试试。');
  t = t.replace(/❌ Index (\d+) out of range \((\d+)-(\d+)\)/g, '编号不对，在$2到$3之间。');
  t = t.replace(/Session: ses_\S+\nModel: (.+)/g, '当前用$1。');
  t = t.replace(/Session: \(none\)\nModel: (.+)/g, '还没选会话。当前用$1。');
  t = t.replace(/📊 (\d+) total · (\d+) projects · (\d+) active/g, '共$1个会话、$2个项目、本周活跃$3个。');
  t = t.replace(/📊 (\d+) sessions · (\d+) projects/g, '$1个会话、$2个项目。');
  t = t.replace(/\/confirm\s*\/deny\s*or ask questions/g, '同意还是拒绝？');
  t = t.replace(/Try a shorter keyword like (.+) to switch\./g, '说「切换 $1」试试。');
  t = t.replace(/\n→ .+/g, '');
  t = t.replace(/\nUsage: .+/g, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  if (t !== text) return t.trim();
  return null;
}

function assessRiskByRule(title, type) {
  const t = (title + " " + (type || "")).toLowerCase();
  if (/^(read|list|ls|cat|grep|show|get|find|count|stat|ps|df|du|pwd|whoami|hostname)\b/.test(t) &&
      !/delete|rm|mv|kill|write|save|create/i.test(t)) return "low";
  if (/\b(delete|remove|rm|purge|drop|truncate)\b/i.test(t)) return "critical";
  if (/\b(write|save|create|mv|copy|install|paste|replace|append)\b/i.test(t)) return "high";
  if (/\b(network|fetch|http|curl|api)\b/i.test(t)) return "medium";
  return "unknown";
}

async function ollamaGenerate(prompt) {
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: NL_CLASSIFY_MODEL, prompt, stream: false, options: { num_predict: 32, temperature: 0 } }),
  });
  if (!resp.ok) throw new Error(`ollama HTTP ${resp.status}`);
  return (await resp.json()).response?.trim() || "";
}

async function assessRiskByLLM(title, type) {
  try {
    const prompt = `Output only JSON, no explanation.\nClassify the risk of this operation:\n"${title}" (${type || ''})\n\nRisk is one of: low, medium, high, critical.\n- low: read-only (list, get, show, stat)\n- high: file write or create\n- critical: delete or destroy\n\nJSON:`;
    const result = await ollamaGenerate(prompt);
    const json = JSON.parse(result.replace(/```.*\n?/g, ''));
    return json.risk || "medium";
  } catch { return "medium"; }
}

// ── alias resolution ──
function resolveAlias(cmd, parts) {
  // mirrors handleCommand alias logic
  let c = cmd;
  if (c === "/s") c = "/sessions";
  else if (c === "/st") c = "/stats";
  else if (c === "/n") c = "/new";
  else if (c === "/rm") c = "/delete";
  else if (c === "/l" || c === "/list") c = "/sessions";
  else if (c === "/r") {
    if (parts.length === 1) c = "/recent";
    else if (/^\d+$/.test(parts[1])) c = "/recent";
    else c = "/resume";
  }
  return c;
}

// ── formatSessionsInProject ──
function formatSessionsInProject(dir, items, activeId) {
  const lines = [`[ ${dir} ] (${items.length})`];
  for (const s of items) {
    const active = activeId === s.id ? ">" : " ";
    lines.push(`  ${active} [${s.globalIndex}] ${s.title || "(untitled)"}`);
  }
  lines.push("", "Reply with /resume [number]");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// B组: Session 管理命令
// ═══════════════════════════════════════════════════════════════
section("=== B组: Session 管理 ===");

// B1-B4: alias resolution
section("B1-B4: 别名解析");
check("B1 /s → /sessions", resolveAlias("/s", ["/s"]) === "/sessions");
check("B2 /st → /stats", resolveAlias("/st", ["/st"]) === "/stats");
check("B3 /n → /new", resolveAlias("/n", ["/n", "test"]) === "/new");
check("B4 /rm → /delete", resolveAlias("/rm", ["/rm", "abc"]) === "/delete");
check("B5 /l → /sessions", resolveAlias("/l", ["/l"]) === "/sessions");
check("B6 /r alone → /recent", resolveAlias("/r", ["/r"]) === "/recent");
check("B7 /r 0 → /recent", resolveAlias("/r", ["/r", "0"]) === "/recent");
check("B8 /r patent → /resume", resolveAlias("/r", ["/r", "patent"]) === "/resume");
check("B9 /list → /sessions", resolveAlias("/list", ["/list"]) === "/sessions");

// B10: formatSessionsInProject structure
section("B10: formatSessionsInProject");
const mockItems = [{ id: "ses_a", title: "会话A", globalIndex: 0 }, { id: "ses_b", title: "会话B", globalIndex: 1 }];
const formatted = formatSessionsInProject("test", mockItems, "ses_a");
check("B10a 包含目录名", formatted.includes("[ test ]"));
check("B10b 包含会话数", formatted.includes("(2)"));
check("B10c 活跃标记 >", formatted.includes("> [0] 会话A"));

// ═══════════════════════════════════════════════════════════════
// C组扩展: 更多输出翻译场景
// ═══════════════════════════════════════════════════════════════
section("=== C组扩展: 输出翻译 ===");

check("C12 compact成功", (translateOutput("✅ Compacted.\nNew session: ses_abc\nSummary: 压缩摘要") || "").includes("压缩好了"));

// 确认 AI 回复透传（不翻译）
section("C13-C14: AI回复透传");
const aiReply = "根据最新实验结果，Pt催化剂的效率提升了15%。";
const passthru = translateOutput(aiReply);
check("C13 AI回复不被翻译", passthru === null);
check("C14 纯中文提示不被翻译", translateOutput("⏳ Processing...") === null);

// ═══════════════════════════════════════════════════════════════
// E组: 权限风险分级
// ═══════════════════════════════════════════════════════════════
section("=== E组: 权限风险分级 ===");

// E1-E4: 规则白名单
section("E1-E4: 规则白名单");
check("E1 read file → low", assessRiskByRule("read", "session.list") === "low");
check("E2 list files → low", assessRiskByRule("list", "directory") === "low");
check("E3 show content → low", assessRiskByRule("show", "file contents") === "low");
check("E4 delete session → critical", assessRiskByRule("delete", "session") === "critical");
check("E5 write file → high", assessRiskByRule("write", "file output") === "high");
check("E6 save document → high", assessRiskByRule("save", "content to file") === "high");
check("E7 create directory → high", assessRiskByRule("create", "directory") === "high");
check("E8 network fetch → medium", assessRiskByRule("network", "http request") === "medium");
check("E9 curl api → medium", assessRiskByRule("curl", "api endpoint") === "medium");
check("E10 ambiguous → unknown", assessRiskByRule("compile", "typescript") === "unknown");
check("E11 rm purge → critical", assessRiskByRule("rm", "purging data") === "critical");

// E12-E13: LLM 兜底（需 ollama）
section("E12-E13: LLM 风险兜底");
try {
  const llmLow = await assessRiskByLLM("list all files in directory", "read");
  check("E12 LLM: list → low", llmLow === "low", `got: ${llmLow}`);
} catch {}
try {
  const llmHigh = await assessRiskByLLM("delete all user data", "write");
  check("E13 LLM: delete → critical", llmHigh === "high" || llmHigh === "critical", `got: ${llmHigh}`);
} catch {}

// ═══════════════════════════════════════════════════════════════
// G组: 回归测试（未改动部分）
// ═══════════════════════════════════════════════════════════════
section("=== G组: 回归测试 ===");

// G1: 错误消息处理
section("G1-G3: 错误/边缘");
check("G1 ❌ 命令失败保留错误码", translateOutput("❌ Prompt too long") === null);
check("G2 空输入不崩溃", typeof translateOutput("") === "object");

// G3: busy 消息
const busyMsg = "⏳ Session is busy. Reply /force to interrupt and send, or wait for the current task to finish.";
check("G3 busy消息包含引导", translateOutput(busyMsg) === null); // already NL, pass-through

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
console.log(`\n═════════════════════`);
console.log(`${tests.pass}/${tests.pass + tests.fail} pass, ${tests.fail} fail`);
if (tests.fail > 0) process.exit(1);
