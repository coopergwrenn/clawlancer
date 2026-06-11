#!/usr/bin/env node
/**
 * travala-search.mjs — discovery leg (B). Calls the backend search proxy, which
 * speaks Travala's PUBLIC MCP search tools (mcp:read, no token). Search is free
 * and reveals no money path, so there are no booking gates here.
 *
 * Deliberately HTTP-via-backend, NOT a native MCP tool on the VM: the agent must
 * never hold a `travala_book` tool it could auto-call around the consent gate
 * (PRD §14-B). Discovery returns packageId + sessionId, which the human approves
 * before travala-book.mjs is ever run.
 *
 * Usage:
 *   node travala-search.mjs --type hotel --args '{"location":"Lisbon","checkIn":"2026-06-24","checkOut":"2026-06-26","rooms":["2"]}' --json
 *   node travala-search.mjs --type package --args '{...}'
 *
 * Reads GATEWAY_TOKEN from ~/.openclaw/.env. Node ESM, built-ins only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const API_BASE = process.env.INSTACLAW_API_BASE || "https://instaclaw.io";

function loadEnv() {
  const out = {};
  try {
    const raw = readFileSync(`${homedir()}/.openclaw/.env`, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* env optional */ }
  return out;
}
function fail(msg, extra) { console.error(JSON.stringify({ ok: false, error: msg, ...extra })); process.exit(1); }
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2); const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[key] = true;
      else { a[key] = next; i++; }
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const json = !!args.json;
  const env = loadEnv();
  const gatewayToken = env.GATEWAY_TOKEN;
  if (!gatewayToken) fail("not_configured: GATEWAY_TOKEN missing in ~/.openclaw/.env");

  const type = (args.type || "hotel").toLowerCase();
  if (type !== "hotel" && type !== "package") fail("bad_type", { detail: "--type must be hotel or package" });
  const op = type === "hotel" ? "search-hotel" : "search-package";

  let toolArgs = {};
  if (args.args) { try { toolArgs = JSON.parse(args.args); } catch { fail("bad_args_json", { detail: "--args must be valid JSON" }); } }
  // Convenience flags fold into the tool args (explicit --args wins per-key).
  for (const [flag, key] of [["location", "location"], ["check-in", "checkIn"], ["check-out", "checkOut"]]) {
    if (args[flag] !== undefined && toolArgs[key] === undefined) toolArgs[key] = args[flag];
  }
  // --guests N maps to the MCP's required occupancy shape rooms:["N"] (one room,
  // N adults). The schema takes rooms (string[]) — a bare `guests` key fails its
  // validation (2026-06-11 canary-prep finding).
  if (args.guests !== undefined && toolArgs.rooms === undefined) {
    const n = Math.max(1, Number(args.guests) || 1);
    toolArgs.rooms = [String(n)];
  }

  const res = await fetch(`${API_BASE}/api/travala/${op}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ arguments: toolArgs }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || !body?.ok) fail("search_failed", { status: res.status, detail: body });

  if (json) console.log(JSON.stringify({ ok: true, result: body.result }));
  else console.log(typeof body.result === "string" ? body.result : JSON.stringify(body.result, null, 2));
}

main().catch((e) => fail("unexpected_error", { detail: String(e?.stack ?? e) }));
