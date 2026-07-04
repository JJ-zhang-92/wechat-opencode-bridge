// test-sse.js — test which SSE endpoint receives session events
const SERVE_URL = process.env.SERVE_URL || "http://127.0.0.1:4097";

async function main() {
  // 1. Get active session ID from bridge state
  const fs = await import("fs");
  const path = await import("path");
  const statePath = path.resolve(process.env.USERPROFILE, ".cc-connect", "wx-bridge", "wx-sessions.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const userId = Object.keys(state.users)[0];
  const activeSession = state.users[userId].activeSession;
  console.log(`Active session: ${activeSession}`);

  if (!activeSession) {
    console.log("No active session. /resume first.");
    process.exit(1);
  }

  // 2. Send prompt via prompt_async
  console.log("\n--- Sending prompt_async ---");
  const body = { parts: [{ type: "text", text: "回复：收到。这是一条SSE测试消息，请回复一个词：pong" }] };
  const resp = await fetch(`${SERVE_URL}/session/${activeSession}/prompt_async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`prompt_async status: ${resp.status}`);

  // 3. Listen to /event first
  console.log("\n--- Listening /event (15s) ---");
  let eventCount = 0;
  const eventTypes = {};

  try {
    const streamResp = await fetch(`${SERVE_URL}/event`, {
      headers: { "Accept": "text/event-stream" },
    });
    console.log(`/event status: ${streamResp.status}`);

    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise(r => setTimeout(() => r({ done: false, value: null }), 2000)),
      ]);
      if (result.done) break;
      if (!result.value) continue;
      
      buf += decoder.decode(result.value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() || "";
      
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        eventCount++;
        const lines = chunk.split("\n");
        let eventType = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;
        
        if (data) {
          const summary = data.length > 100 ? data.slice(0, 100) + "..." : data;
          console.log(`  [${eventType}] ${summary}`);
        }
      }
    }

    reader.cancel();
    console.log(`\n/event stats: ${eventCount} events`);
    for (const [type, count] of Object.entries(eventTypes)) {
      console.log(`  ${type}: ${count}`);
    }

    if (eventCount === 0) {
      console.log("❌ NO EVENTS on /event — this is the bug!");
    }
  } catch (e) {
    console.log(`/event error: ${e.message}`);
  }

  // 4. Listen to /global/event
  console.log("\n--- Listening /global/event (15s) ---");
  let geCount = 0;
  const geTypes = {};

  try {
    const streamResp = await fetch(`${SERVE_URL}/global/event`, {
      headers: { "Accept": "text/event-stream" },
    });
    console.log(`/global/event status: ${streamResp.status}`);

    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline2 = Date.now() + 15_000;

    while (Date.now() < deadline2) {
      const result = await Promise.race([
        reader.read(),
        new Promise(r => setTimeout(() => r({ done: false, value: null }), 2000)),
      ]);
      if (result.done) break;
      if (!result.value) continue;
      
      buf += decoder.decode(result.value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() || "";
      
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        eventCount++;
        const lines = chunk.split("\n");
        let eventType = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        eventTypes[eventType] = (eventTypes[eventType] || 0) + 1;
        
        if (data) {
          try {
            const json = JSON.parse(data);
            const sid = json.sessionID || json.id || "";
            const summary = data.length > 150 ? data.slice(0, 150) + "..." : data;
            console.log(`  [${eventType}] ${summary}`);
          } catch {
            console.log(`  [${eventType}] ${data.slice(0, 150)}`);
          }
        }
      }
    }

    reader.cancel();
    console.log(`\n/global/event stats: ${eventCount2}`);
    for (const [type, count] of Object.entries(geTypes)) {
      console.log(`  ${type}: ${count}`);
    }

    if (geCount > 0 && eventCount === 0) {
      console.log("\n✅ CONFIRMED: /global/event gets events, /event does NOT. Fix: switch bridge to /global/event");
    } else if (eventCount > 0) {
      console.log("\n⚠ /event also gets events — something else is wrong.");
    }
  } catch (e) {
    console.log(`/global/event error: ${e.message}`);
  }

  console.log("\nDone. Check wx-bridge.log for /event results.");
}

main().catch(e => { console.error(e); process.exit(1); });
