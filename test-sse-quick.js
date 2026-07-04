// quick-check: what event types does /global/event send?
const SERVE_URL = "http://127.0.0.1:4097";

async function main() {
  const resp = await fetch(`${SERVE_URL}/global/event`, { headers: { "Accept": "text/event-stream" } });
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const seen = new Set();
  const deadline = Date.now() + 12_000;

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
        if (!seen.has(pt)) {
          seen.add(pt);
          // show first 2 of each type
          const keys = Object.keys(json);
          const sessionKeys = keys.filter(k => k !== "payload" && k !== "project");
          console.log(`  [${pt}] keys: ${sessionKeys.join(", ")} | payload: ${JSON.stringify(json.payload).slice(0, 120)}`);
        }
      } catch {}
    }
  }
  reader.cancel();
  console.log(`\nEvent types seen: ${[...seen].join(", ")}`);
}

main().catch(e => console.error(e));
