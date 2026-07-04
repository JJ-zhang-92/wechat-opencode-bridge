// watch events during active processing
import { readFileSync } from "fs";
const SERVE_URL = "http://127.0.0.1:4097";

// Read active session
const statePath = String.raw`C:\Users\12415\.cc-connect\wx-bridge\wx-sessions.json`;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const userId = Object.keys(state.users)[0];
const sessionId = state.users[userId].activeSession;
console.log(`Session: ${sessionId}`);

const resp = await fetch(`${SERVE_URL}/global/event`, { headers: { "Accept": "text/event-stream" } });
const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = "";
const deadline = Date.now() + 20_000;

// Send prompt after 2s
setTimeout(async () => {
  console.log("\n--- Sending prompt ---");
  const r = await fetch(`${SERVE_URL}/session/${sessionId}/prompt_async`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "回复：收到SSE测试。只说OK。" }] }),
  });
  console.log(`prompt_async: ${r.status}\n`);
}, 2000);

const seenTypes = new Set();
while (Date.now() < deadline) {
  const r = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: false, value: null }), 2000))]);
  if (r.done) break;
  if (!r.value) continue;

  buf += decoder.decode(r.value, { stream: true });
  const chunks = buf.split("\n\n");
  buf = chunks.pop() || "";

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let eventType = "message";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      const json = JSON.parse(data);
      const pt = json.payload?.type || eventType;
      seenTypes.add(pt);
      // Show part updates and session-related events
      const relevant = pt.includes("part") || pt.includes("idle") || pt.includes("message") || pt.includes("sync");
      if (relevant || !seenTypes.has(pt + "shown")) {
        seenTypes.add(pt + "shown");
        const keys = Object.keys(json);
        console.log(`[${pt}] keys: ${keys.join(", ")} | sample: ${JSON.stringify(json).slice(0, 250)}`);
      }
    } catch {}
  }
}
reader.cancel();
console.log(`\nTypes: ${[...seenTypes].filter(t => !t.endsWith("shown")).join(", ")}`);
