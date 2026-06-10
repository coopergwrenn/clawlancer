// DISCRIMINATION PROOF: empty-completion guards through the real proxy.
// Local dev proxy (NODE_ENV=development activates the mock seam) + an in-process
// mock Anthropic upstream that returns controlled empty/non-empty responses
// (real Anthropic won't reliably empty). Real prod DB (governor + usage_log).
//
// Cases:
//  1 NS fallback : fable empty → fallback serves sonnet, bills once @ sonnet, orig empty refunded row
//  2 NS total    : fable empty → sonnet empty → friendly error + EVERYTHING refunded
//  3 NS gate     : haiku empty → NO fallback (down-only gate BLOCKS) → error + refund; mock sees ONLY haiku
//  4 stream ok   : sonnet non-empty stream → byte-identical passthrough, billed, not refunded
//  5 stream empty: fable empty stream → byte-identical passthrough, NO retry, refunded (Guard 2 streaming)
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import http from "node:http";

const env = readFileSync("/Users/cooperwrenn/wild-west-bots-sidebar/instaclaw/.env.local", "utf-8");
for (const l of env.split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const SB = "https://qvrnuyzfqjrsjljcqbub.supabase.co";
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json", Prefer: "return=representation" };
const PROXY = "http://localhost:3001/api/gateway/proxy";
const MOCK_PORT = 7878;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (l, c, e) => { c ? pass++ : fail++; console.log(`    ${c ? "✓" : "✗ FAIL"} ${l}${c || e === undefined ? "" : `  (${e})`}`); };
async function rest(method, path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; } return { status: r.status, json: j };
}

// ---- mock Anthropic upstream ----
const mockReqs = []; // {mode, model, stream}
function streamBody(model, empty) {
  let s = `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","model":"${model}","usage":{"input_tokens":100,"output_tokens":1}}}\n\n`;
  if (!empty) {
    s += `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`;
    s += `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"mock answer"}}\n\n`;
    s += `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`;
  }
  s += `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${empty ? "stop" : "end_turn"}"},"usage":{"output_tokens":${empty ? 0 : 5}}}\n\n`;
  s += `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  return s;
}
function jsonBody(model, empty) {
  return JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model, content: empty ? [] : [{ type: "text", text: "mock answer" }], stop_reason: empty ? "stop" : "end_turn", usage: { input_tokens: 100, output_tokens: empty ? 0 : 5 } });
}
const mockServer = http.createServer((req, res) => {
  const mode = req.url.replace(/^\//, "").split("?")[0];
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let pb = {}; try { pb = JSON.parse(raw); } catch {}
    const model = pb.model || "?"; const stream = pb.stream === true;
    let empty;
    if (mode === "empty") empty = true;
    else if (mode === "ok") empty = false;
    else if (mode === "by-model") empty = !String(model).includes("sonnet"); // sonnet ok, others empty
    else empty = false;
    mockReqs.push({ mode, model, stream, empty });
    if (stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(streamBody(model, empty)); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end(jsonBody(model, empty)); }
  });
});
async function startMock() { return new Promise((r) => mockServer.listen(MOCK_PORT, r)); }

async function mkVM(pinned) {
  const userId = randomUUID(), vmId = randomUUID(), gw = "gwtok_" + randomUUID().replace(/-/g, "");
  await rest("POST", "instaclaw_users", { id: userId, email: `eg-${userId.slice(0, 8)}@example.invalid` });
  await rest("POST", "instaclaw_vms", { id: vmId, name: `eg-${vmId.slice(0, 8)}`, assigned_to: userId, api_mode: "all_inclusive", status: "assigned", health_status: "unknown", tier: "power", ip_address: "192.0.2.1", gateway_token: gw, pinned_model: pinned, user_timezone: "UTC" });
  return { userId, vmId, gw };
}
async function teardown(v) {
  for (const t of ["instaclaw_usage_log", "instaclaw_daily_usage", "instaclaw_model_tier_usage", "instaclaw_agent_activity"]) await rest("DELETE", `${t}?vm_id=eq.${v.vmId}`).catch(() => {});
  await rest("DELETE", `instaclaw_vms?id=eq.${v.vmId}`); await rest("DELETE", `instaclaw_users?id=eq.${v.userId}`);
}
async function rows(vmId) {
  const r = await rest("GET", `instaclaw_usage_log?vm_id=eq.${vmId}&select=model,cost_weight,output_tokens,billing_refunded,routing_reason&order=created_at.asc`);
  return Array.isArray(r.json) ? r.json : [];
}
async function msgCount(vmId) {
  const r = await rest("GET", `instaclaw_daily_usage?vm_id=eq.${vmId}&select=message_count&order=usage_date.desc&limit=1`);
  return Array.isArray(r.json) && r.json[0] ? Number(r.json[0].message_count) : 0;
}

async function main() {
  await startMock();
  console.log(`mock upstream on :${MOCK_PORT}\n`);

  // ---- Case 1: NS fallback ----
  console.log("== CASE 1: non-streaming, fable empty → fallback serves sonnet ==");
  { const v = await mkVM("claude-fable-5"); mockReqs.length = 0;
    const res = await fetch(PROXY, { method: "POST", headers: { "x-api-key": v.gw, "content-type": "application/json", "x-proxy-upstream-override": `http://localhost:${MOCK_PORT}/by-model` }, body: JSON.stringify({ model: "x", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }) });
    const body = await res.json(); await sleep(1500);
    const r = await rows(v.vmId); const mc = await msgCount(v.vmId);
    ok("served non-empty (sonnet) content", Array.isArray(body.content) && body.content.length > 0 && body.content[0].text === "mock answer");
    const sonnetRow = r.find((x) => x.model === "claude-sonnet-4-6" && !x.billing_refunded);
    const fableForensic = r.find((x) => x.model === "claude-fable-5" && x.billing_refunded);
    ok("served row = sonnet, cost 4, NOT refunded, output 5", sonnetRow && Number(sonnetRow.cost_weight) === 4 && Number(sonnetRow.output_tokens) === 5, JSON.stringify(sonnetRow));
    ok("forensic row = fable, output 0, REFUNDED (empty-rate detector survives)", fableForensic && Number(fableForensic.output_tokens) === 0, JSON.stringify(fableForensic));
    ok("governor net = 4 (charged 38, partial refund 34)", mc === 4, `message_count=${mc}`);
    ok("mock saw fable then sonnet (fallback fired)", mockReqs.length === 2 && mockReqs[0].model.includes("fable") && mockReqs[1].model.includes("sonnet"), JSON.stringify(mockReqs.map((x) => x.model)));
    await teardown(v);
  }

  // ---- Case 2: NS total fail ----
  console.log("\n== CASE 2: non-streaming, fable empty → sonnet empty → error + everything refunded ==");
  { const v = await mkVM("claude-fable-5"); mockReqs.length = 0;
    const res = await fetch(PROXY, { method: "POST", headers: { "x-api-key": v.gw, "content-type": "application/json", "x-proxy-upstream-override": `http://localhost:${MOCK_PORT}/empty` }, body: JSON.stringify({ model: "x", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }) });
    const body = await res.json(); await sleep(1500);
    const r = await rows(v.vmId); const mc = await msgCount(v.vmId);
    ok("served friendly error (not the empty body)", Array.isArray(body.content) && body.content.some((c) => (c.text || "").includes("couldn't generate")), JSON.stringify(body.content));
    ok("governor net = 0 (full refund of 38)", mc === 0, `message_count=${mc}`);
    ok("all rows refunded (fable + sonnet, both output 0)", r.length >= 2 && r.every((x) => x.billing_refunded && Number(x.output_tokens) === 0), JSON.stringify(r.map((x) => `${x.model}:ref=${x.billing_refunded}:out=${x.output_tokens}`)));
    ok("mock saw fable then sonnet (fallback attempted)", mockReqs.length === 2, JSON.stringify(mockReqs.map((x) => x.model)));
    await teardown(v);
  }

  // ---- Case 3: NS down-gate BLOCKS ----
  console.log("\n== CASE 3: non-streaming, haiku empty → down-only gate BLOCKS fallback ==");
  { const v = await mkVM("claude-haiku-4-5-20251001"); mockReqs.length = 0;
    const res = await fetch(PROXY, { method: "POST", headers: { "x-api-key": v.gw, "content-type": "application/json", "x-proxy-upstream-override": `http://localhost:${MOCK_PORT}/empty` }, body: JSON.stringify({ model: "x", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }) });
    const body = await res.json(); await sleep(1500);
    const r = await rows(v.vmId); const mc = await msgCount(v.vmId);
    ok("served friendly error", Array.isArray(body.content) && body.content.some((c) => (c.text || "").includes("couldn't generate")));
    ok("governor net = 0 (full refund of 1)", mc === 0, `message_count=${mc}`);
    ok("haiku row present, output 0, refunded", r.some((x) => x.model.includes("haiku") && x.billing_refunded && Number(x.output_tokens) === 0), JSON.stringify(r.map((x) => x.model)));
    ok("NO sonnet row (gate blocked the up-step)", !r.some((x) => x.model.includes("sonnet")), JSON.stringify(r.map((x) => x.model)));
    ok("mock saw ONLY haiku — NO fallback request (gate BLOCKED)", mockReqs.length === 1 && mockReqs[0].model.includes("haiku"), JSON.stringify(mockReqs.map((x) => x.model)));
    await teardown(v);
  }

  // ---- Case 4: streaming ok — byte integrity ----
  console.log("\n== CASE 4: streaming non-empty → byte-integrity passthrough, billed, not refunded ==");
  { const v = await mkVM("claude-sonnet-4-6"); mockReqs.length = 0;
    const expected = streamBody("claude-sonnet-4-6", false);
    const res = await fetch(PROXY, { method: "POST", headers: { "x-api-key": v.gw, "content-type": "application/json", "x-proxy-upstream-override": `http://localhost:${MOCK_PORT}/ok` }, body: JSON.stringify({ model: "x", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let got = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += dec.decode(value, { stream: true }); }
    await sleep(2500);
    const r = await rows(v.vmId); const mc = await msgCount(v.vmId);
    ok("streaming body byte-identical to mock (passthrough untouched)", got === expected, got === expected ? "" : `len got=${got.length} exp=${expected.length}`);
    ok("sonnet row, output 5, NOT refunded, cost 4", r.length === 1 && Number(r[0].output_tokens) === 5 && !r[0].billing_refunded && Number(r[0].cost_weight) === 4, JSON.stringify(r));
    ok("governor net = 4 (billed, no refund)", mc === 4, `message_count=${mc}`);
    await teardown(v);
  }

  // ---- Case 5: streaming empty — Guard 2, no retry ----
  console.log("\n== CASE 5: streaming empty → byte-integrity passthrough, NO retry, refunded (Guard 2) ==");
  { const v = await mkVM("claude-fable-5"); mockReqs.length = 0;
    const expected = streamBody("claude-fable-5", true);
    const res = await fetch(PROXY, { method: "POST", headers: { "x-api-key": v.gw, "content-type": "application/json", "x-proxy-upstream-override": `http://localhost:${MOCK_PORT}/empty` }, body: JSON.stringify({ model: "x", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] }) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let got = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += dec.decode(value, { stream: true }); }
    await sleep(3000);
    const r = await rows(v.vmId); const mc = await msgCount(v.vmId);
    ok("empty stream byte-identical to mock (passthrough untouched)", got === expected, got === expected ? "" : `len got=${got.length} exp=${expected.length}`);
    ok("NO retry on streaming (mock saw exactly 1 request)", mockReqs.length === 1 && mockReqs[0].model.includes("fable"), JSON.stringify(mockReqs.map((x) => x.model)));
    ok("fable row, output 0, REFUNDED (Guard 2 streaming no-bill)", r.length === 1 && r[0].model.includes("fable") && Number(r[0].output_tokens) === 0 && r[0].billing_refunded, JSON.stringify(r));
    ok("governor net = 0 (full refund of 38)", mc === 0, `message_count=${mc}`);
    await teardown(v);
  }

  mockServer.close();
  console.log(`\n== RESULT: ${pass} pass / ${fail} fail ==`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); mockServer.close(); process.exit(1); });
