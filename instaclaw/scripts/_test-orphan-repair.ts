/**
 * Synthetic-fixture smoke test for run_startup_orphan_repair (v101).
 *
 * Validates the orphan-repair logic against 7 hand-crafted .jsonl fixtures
 * covering the failure modes the production fix must handle:
 *
 *   01-no-orphan              clean assistant→toolCall→toolResult, expect 0 synthesized
 *   02-single-orphan          1 toolCall, no toolResult, expect 1 synthesized
 *   03-multi-orphan-partial   3 toolCalls, 1 toolResult, expect 2 synthesized
 *   04-aborted-stopreason     assistant has stopReason="aborted" + orphan, expect 1 synthesized
 *   05-empty-file             zero bytes, expect 0 synthesized (no-op, no error)
 *   06-malformed-line         valid + corrupt + valid lines, expect 1 synthesized (skip corrupt)
 *   07-no-user-message        only gateway-internal events (no user message), expect 0 (bounds check)
 *
 * Plus an idempotency assertion: re-running --startup-repair on fixture 02
 * must NOT add another synthetic event (orphan was already repaired).
 *
 * Validation method: extract STRIP_THINKING_SCRIPT from lib/ssh.ts to a tmp
 * file, then invoke `python3 <tmp> --startup-repair <fixture>` per fixture.
 * Count the synthetic event additions and assert against expectations.
 *
 * Format note: fixtures use OpenClaw's verified-against-vm-050 on-disk shape
 *   user:       {"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 *   assistant:  {"type":"message","id":"<hex8>","message":{"role":"assistant","stopReason":"toolUse",
 *                "content":[{"type":"toolCall","id":"toolu_...","name":"...","arguments":{...}}]}}
 *   toolResult: {"type":"message","parentId":"<assistant-id>","message":{"role":"toolResult",
 *                "toolCallId":"toolu_...","toolName":"...","content":[{"type":"text","text":"..."}],
 *                "isError":false}}
 *
 * Run:
 *   npx tsx instaclaw/scripts/_test-orphan-repair.ts
 *
 * Exit: 0 if all 8 assertions pass, 1 otherwise. Prints per-fixture results.
 */

import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

// ── Extract Python script to a tmp file so we can run it via python3 ────────
const WORK = mkdtempSync(join(tmpdir(), "orphan-repair-test-"));
const PY = join(WORK, "strip-thinking.py");
writeFileSync(PY, STRIP_THINKING_SCRIPT, { mode: 0o755 });

// ── Fixture builders (verified shape per OpenClaw on-disk format) ──────────
type Event = Record<string, unknown>;

function userMsg(text: string): Event {
  return {
    type: "message",
    id: hex8("user"),
    timestamp: nowIso(),
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantWithToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  opts: { stopReason?: string; eventId?: string } = {},
): Event {
  const eventId = opts.eventId ?? hex8("assistant");
  return {
    type: "message",
    id: eventId,
    timestamp: nowIso(),
    message: {
      role: "assistant",
      stopReason: opts.stopReason ?? "toolUse",
      content: toolCalls.map((tc) => ({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments ?? {},
      })),
    },
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text = "ok",
  parentEventId?: string,
): Event {
  return {
    type: "message",
    id: hex8("toolResult"),
    parentId: parentEventId,
    timestamp: nowIso(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text }],
      isError: false,
    },
  };
}

// Internal/gateway-emitted events that aren't user messages.
function customEvent(type = "custom"): Event {
  return { type, timestamp: nowIso() };
}

function hex8(seed: string): string {
  // Cheap stable-ish 8-hex id for fixture readability (not crypto, just for matching shape).
  let h = 0;
  for (const c of seed + Math.random().toString()) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return Math.abs(h).toString(16).padStart(8, "0").slice(0, 8);
}
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
}

function writeFixture(name: string, events: Array<Event | string>): string {
  const path = join(WORK, `${name}.jsonl`);
  const lines = events.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
  writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "");
  return path;
}

function countLines(path: string): number {
  const raw = readFileSync(path, "utf-8");
  return raw.split("\n").filter((l) => l.trim()).length;
}

function readAllEvents(path: string): Event[] {
  const raw = readFileSync(path, "utf-8");
  const out: Event[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return out;
}

function runRepair(jsonlPath: string): { stdout: string; lineCountBefore: number; lineCountAfter: number } {
  const lineCountBefore = countLines(jsonlPath);
  const stdout = execSync(`python3 "${PY}" --startup-repair "${jsonlPath}"`, {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  const lineCountAfter = countLines(jsonlPath);
  return { stdout, lineCountBefore, lineCountAfter };
}

// ── Assertions ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const fails: string[] = [];
function assert(cond: boolean, label: string, extra = ""): void {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? "  " + extra : ""}`);
    pass++;
  } else {
    console.error(`  ✗ ${label}${extra ? "  " + extra : ""}`);
    fail++;
    fails.push(label);
  }
}

// ── Fixture 01: no orphan ───────────────────────────────────────────────────
console.log("\n── 01-no-orphan ──");
{
  const aid = "asst-01";
  const f = writeFixture("01-no-orphan", [
    customEvent("session"),
    userMsg("hello"),
    assistantWithToolCalls([{ id: "toolu_abc", name: "Read" }], { eventId: aid }),
    toolResult("toolu_abc", "Read", "file contents", aid),
  ]);
  const r = runRepair(f);
  assert(r.lineCountAfter === r.lineCountBefore, "no events synthesized", `(before=${r.lineCountBefore} after=${r.lineCountAfter})`);
}

// ── Fixture 02: single orphan ───────────────────────────────────────────────
console.log("\n── 02-single-orphan ──");
let fixture02Path: string;
{
  const aid = "asst-02";
  fixture02Path = writeFixture("02-single-orphan", [
    customEvent("session"),
    userMsg("trigger"),
    assistantWithToolCalls([{ id: "toolu_solo", name: "web_search" }], { eventId: aid }),
    // no toolResult — orphan
  ]);
  const r = runRepair(fixture02Path);
  assert(r.lineCountAfter === r.lineCountBefore + 1, "1 synthetic event added", `(before=${r.lineCountBefore} after=${r.lineCountAfter})`);
  // Verify the synthetic event has the right shape
  const events = readAllEvents(fixture02Path);
  const synthetic = events[events.length - 1];
  const msg = (synthetic.message as Record<string, unknown>) ?? {};
  assert(synthetic.type === "message", "synthetic.type='message'");
  assert(msg.role === "toolResult", "synthetic.message.role='toolResult'");
  assert(msg.toolCallId === "toolu_solo", "synthetic.message.toolCallId matches orphan id");
  assert(msg.toolName === "web_search", "synthetic.message.toolName matches orphan name");
  assert(msg.isError === true, "synthetic.message.isError=true");
  assert(
    "_orphanRepairSynthetic" in (msg as Record<string, unknown>),
    "synthetic marker present in message",
  );
  assert(r.stdout.includes("ORPHAN_REPAIR:"), "ORPHAN_REPAIR: log line emitted", `(${r.stdout.split("\n")[0]?.slice(0, 80) ?? ""})`);
}

// ── Fixture 03: multi-orphan partial ────────────────────────────────────────
console.log("\n── 03-multi-orphan-partial ──");
{
  const aid = "asst-03";
  const f = writeFixture("03-multi-orphan-partial", [
    customEvent("session"),
    userMsg("multi"),
    assistantWithToolCalls(
      [
        { id: "toolu_aaa", name: "Read" },
        { id: "toolu_bbb", name: "Read" },
        { id: "toolu_ccc", name: "Read" },
      ],
      { eventId: aid },
    ),
    toolResult("toolu_aaa", "Read", "first ok", aid),
    // toolu_bbb and toolu_ccc are orphans
  ]);
  const r = runRepair(f);
  assert(r.lineCountAfter === r.lineCountBefore + 2, "2 synthetic events added", `(before=${r.lineCountBefore} after=${r.lineCountAfter})`);
  const events = readAllEvents(f);
  const syntheticIds = events.slice(-2).map((e) => ((e.message as Record<string, unknown>)?.toolCallId as string) ?? "");
  assert(
    syntheticIds.includes("toolu_bbb") && syntheticIds.includes("toolu_ccc"),
    "synthetic events reference the unmatched ids",
    `got=[${syntheticIds.join(", ")}]`,
  );
}

// ── Fixture 04: aborted stopReason ──────────────────────────────────────────
console.log("\n── 04-aborted-stopreason ──");
{
  const aid = "asst-04";
  const f = writeFixture("04-aborted-stopreason", [
    customEvent("session"),
    userMsg("kill me"),
    assistantWithToolCalls(
      [{ id: "toolu_kill", name: "web_search" }],
      { eventId: aid, stopReason: "aborted" },
    ),
    // no toolResult — runtime's repair bypasses synthesis here; ours must NOT
  ]);
  const r = runRepair(f);
  assert(r.lineCountAfter === r.lineCountBefore + 1, "1 synthetic event added even though stopReason=aborted", `(before=${r.lineCountBefore} after=${r.lineCountAfter})`);
}

// ── Fixture 05: empty file ──────────────────────────────────────────────────
console.log("\n── 05-empty-file ──");
{
  const f = writeFixture("05-empty-file", []);
  const r = runRepair(f);
  assert(r.lineCountAfter === 0 && r.lineCountBefore === 0, "empty file remains empty (no error)");
}

// ── Fixture 06: malformed line ──────────────────────────────────────────────
console.log("\n── 06-malformed-line ──");
{
  const aid = "asst-06";
  const f = writeFixture("06-malformed-line", [
    customEvent("session"),
    userMsg("noise"),
    "{not valid json at all, parser must skip me",
    assistantWithToolCalls([{ id: "toolu_after_noise", name: "Read" }], { eventId: aid }),
    // orphan
  ]);
  const r = runRepair(f);
  assert(r.lineCountAfter === r.lineCountBefore + 1, "skips malformed line + still detects orphan", `(before=${r.lineCountBefore} after=${r.lineCountAfter})`);
}

// ── Fixture 07: no user message ─────────────────────────────────────────────
console.log("\n── 07-no-user-message ──");
{
  const f = writeFixture("07-no-user-message", [
    customEvent("session"),
    customEvent("model_change"),
    customEvent("thinking_level_change"),
    // no user message at all — bounds check should return [] orphans
  ]);
  const r = runRepair(f);
  assert(r.lineCountAfter === r.lineCountBefore, "no synthesis when no user message exists");
}

// ── Idempotency: re-run on fixture 02 ───────────────────────────────────────
console.log("\n── idempotency: re-run on 02 ──");
{
  const sizeBefore = readFileSync(fixture02Path, "utf-8").length;
  const r = runRepair(fixture02Path);
  const sizeAfter = readFileSync(fixture02Path, "utf-8").length;
  assert(sizeBefore === sizeAfter, "re-run is no-op (orphan was repaired on first run)", `(before=${sizeBefore} after=${sizeAfter})`);
  assert(r.lineCountAfter === r.lineCountBefore, "no extra synthetic event on re-run");
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("");
console.log("════════════════════════════════════════════════════════");
console.log(`  ${pass} passed, ${fail} failed`);
console.log("════════════════════════════════════════════════════════");

if (fail > 0) {
  console.error("\nFAILED assertions:");
  for (const f of fails) console.error("  - " + f);
}

// Don't clean up the tmp dir on failure — operator may want to inspect
if (fail === 0) {
  try { rmSync(WORK, { recursive: true }); } catch { /* best-effort */ }
} else {
  console.error(`\nFixtures preserved at: ${WORK}`);
}

process.exit(fail === 0 ? 0 : 1);
