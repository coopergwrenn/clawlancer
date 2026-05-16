/**
 * Gate 0 repro test for the orphan tool_use session-recovery bug.
 *
 * Determines whether OpenClaw 2026.4.26's existing transcript repair
 * (`repairSessionFileIfNeeded` at compaction-successor-transcript-CFukhZtt.js:2060,
 * `repairToolUseResultPairing` at session-transcript-repair-D9T_omS-.js:266)
 * handles SIGTERM-during-tool_use cases on session reload. If yes, the orphan-
 * repair PR (see CLAUDE.md follow-up note + the design plan) is not needed.
 * If no, the bug is confirmed and the PR is justified.
 *
 * The runtime repair has an `assistant.stopReason === "aborted"` bypass that
 * SKIPS synthesis for exactly the SIGTERM-mid-tool-call case. The test
 * determines empirically whether `repairSessionFileIfNeeded` covers the gap
 * elsewhere in the load path, or whether the orphan actually reaches the
 * Anthropic API and triggers "Something went wrong, use /new".
 *
 * Pre-conditions (`--mode=real`):
 *   - Target VM at `config_version` >= 100 (post-v100 RuntimeMaxSec removal).
 *   - Rule 35 gbrain HTTP sidecar deployed on the target so the gbrain-MCP-hang
 *     confounder is eliminated. Verified by `systemctl --user is-active gbrain`
 *     returning "active" AND OpenClaw's `mcp.servers.gbrain.transport` set to
 *     "streamable-http". `--skip-rule35-check` bypasses but invalidates results.
 *   - Operator (you) has Telegram chat access to the target VM's bot.
 *
 * Procedure (`--mode=real`):
 *   1. SSH to target, snapshot pre-test state (gateway PID, journal cursor,
 *      active session jsonl path + size + last 10 events).
 *   2. Prompt operator to send a slow tool_use trigger message via Telegram.
 *   3. Poll the session jsonl for the new user message, then for the assistant
 *      message containing a toolCall block.
 *   4. Immediately SIGTERM the gateway PID — the toolCall has been written
 *      but the toolResult has not (we hope).
 *   5. Wait for systemd restart + `/health=200`. Capture journal output during
 *      restart, including any `ORPHAN_REPAIR:` (would mean PR already shipped)
 *      or `repairSessionFileIfNeeded` lines (would mean OpenClaw's internal
 *      repair fired).
 *   6. Prompt operator to send a follow-up message.
 *   7. Watch the jsonl for the next assistant message AFTER the follow-up
 *      user message.
 *   8. Classify the response:
 *        ORPHAN_HANDLED:        normal model reply (text content, no error
 *                               markers) → OpenClaw fixed it, PR not needed.
 *        ORPHAN_BUG_CONFIRMED:  reply contains the "Something went wrong" /
 *                               "use /new" markers → orphan reached the API,
 *                               PR is justified.
 *        INCONCLUSIVE:          timeout, no response, or unexpected content
 *                               → log and re-run.
 *   9. Save forensic artifacts to /tmp/repro-orphan-<ts>/.
 *
 * Modes:
 *   --mode=real       Actual SIGTERM repro. Requires Rule 35 deployed.
 *   --mode=simulate   Skip the SIGTERM; instead, copy the active jsonl,
 *                     inject a synthetic orphan tail, send the follow-up
 *                     against the COPY. Tests the classification plumbing
 *                     without touching production state. Safe to run any time.
 *   --mode=dry-run    Pre-flight + state capture only. No destructive ops.
 *
 * Usage:
 *   npx tsx instaclaw/scripts/_repro-orphan-tool-use.ts \
 *     --vm=vm-050 --mode=real --i-understand-this-sigterms-the-gateway
 *   npx tsx instaclaw/scripts/_repro-orphan-tool-use.ts --vm=vm-050 --mode=simulate
 *   npx tsx instaclaw/scripts/_repro-orphan-tool-use.ts --vm=vm-050 --mode=dry-run
 *
 * Safety: --mode=real refuses to run unless --i-understand-this-sigterms-the-gateway
 * is set explicitly. Designed for a TEST VM (default vm-050 is Cooper's test
 * agent). Do NOT point at a paying customer's VM.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { Client } from "ssh2";

// ── Rule 18: load both env files ─────────────────────────────────────────────
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* env file optional — fail later if missing */
  }
}

if (!process.env.SSH_PRIVATE_KEY_B64) {
  console.error("FATAL: SSH_PRIVATE_KEY_B64 missing from .env.ssh-key");
  process.exit(2);
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  process.exit(2);
}
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString("utf-8");

// ── Constants ────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://qvrnuyzfqjrsjljcqbub.supabase.co";

const TIMEOUTS = {
  /** Max wait for operator to send the initial trigger message. */
  initialMessageWait: 180_000,
  /** Max wait for OpenClaw to start tool execution (assistant w/ toolCall). */
  toolCallAppear: 90_000,
  /** Max wait between SIGTERM and gateway entering 'deactivating' or 'failed'. */
  gatewayDeactivate: 30_000,
  /** Max wait for systemd restart + /health=200. Generous to accommodate
   *  gbrain HTTP sidecar boot + plugin loading. */
  gatewayRestart: 180_000,
  /** Max wait for operator to send follow-up message. */
  followupMessageWait: 180_000,
  /** Max wait for the post-restart assistant response to appear. */
  responseAppear: 120_000,
} as const;

/** Strings that, if present in the assistant's post-restart response,
 *  indicate the orphan reached Anthropic and the runtime didn't repair it. */
const ORPHAN_BUG_MARKERS = [
  "Something went wrong while processing your request",
  "use /new to start a fresh session",
];

/** Strings that, if present in the restart journal, indicate the runtime's
 *  internal repair fired (we want to know about this either way). */
const REPAIR_FIRED_MARKERS = [
  "repairSessionFileIfNeeded",
  "repairToolUseResultPairing",
  "droppedOrphanCount",
  "ORPHAN_REPAIR:", // would mean OUR future fix already shipped — shouldn't happen pre-PR
];

const SUGGESTED_TRIGGER_MESSAGE =
  'Use web_search to find the latest 5 news headlines about Anthropic, then write a 1-paragraph summary of each.';
const SUGGESTED_FOLLOWUP_MESSAGE = 'are you there?';

// ── Types ────────────────────────────────────────────────────────────────────
type Mode = "real" | "simulate" | "dry-run";

interface Args {
  vmName: string;
  mode: Mode;
  iUnderstand: boolean;
  skipRule35Check: boolean;
}

interface VMState {
  id: string;
  name: string;
  ip_address: string;
  config_version: number | null;
  health_status: string | null;
  telegram_bot_username: string | null;
  partner: string | null;
}

interface Verdict {
  outcome: "ORPHAN_HANDLED" | "ORPHAN_BUG_CONFIRMED" | "INCONCLUSIVE";
  reasoning: string;
  mode: Mode;
  vm: string;
  timestamps: Record<string, string>;
  orphanIds: string[];
  repairMarkersFoundInJournal: string[];
  bugMarkersFoundInResponse: string[];
  responseText: string | null;
  artifactsDir: string;
}

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const idx = args.indexOf(flag);
    if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    return fallback;
  };
  const has = (flag: string) => args.includes(flag);

  const vmName = get("--vm", "vm-050")!;
  const modeStr = get("--mode", "dry-run") as string;
  if (!["real", "simulate", "dry-run"].includes(modeStr)) {
    console.error(`FATAL: --mode must be one of: real, simulate, dry-run (got "${modeStr}")`);
    process.exit(2);
  }
  return {
    vmName,
    mode: modeStr as Mode,
    iUnderstand: has("--i-understand-this-sigterms-the-gateway"),
    skipRule35Check: has("--skip-rule35-check"),
  };
}

// ── Logging + forensics ──────────────────────────────────────────────────────
const TS_RUN = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const ARTIFACTS_DIR = `/tmp/repro-orphan-${TS_RUN}`;
const RUN_TIMESTAMPS: Record<string, string> = {};

function nowIso(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  const t = nowIso();
  console.log(`[${t.slice(11, 19)}] ${msg}`);
}

function logEvent(key: string, extra?: string): void {
  RUN_TIMESTAMPS[key] = nowIso();
  log(`▸ ${key}${extra ? " — " + extra : ""}`);
}

function saveArtifact(name: string, body: string): void {
  if (!existsSync(ARTIFACTS_DIR)) mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(`${ARTIFACTS_DIR}/${name}`, body);
}

function operatorPrompt(message: string): void {
  console.log("");
  console.log("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("┃ ACTION REQUIRED");
  for (const line of message.split("\n")) console.log(`┃ ${line}`);
  console.log("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}

// ── SSH helpers (inline, matches existing _test-*.ts pattern) ────────────────
function sshConnect(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({
      host,
      port: 22,
      username: "openclaw",
      privateKey: SSH_KEY,
      readyTimeout: 12_000,
    });
  });
}

function sshExec(
  c: Client,
  cmd: string,
  timeoutMs: number = 15_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let code = -1;
    let resolved = false;
    const tt = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ stdout: stdout + "\n[TIMEOUT]", stderr, code: -1 });
      }
    }, timeoutMs);
    c.exec(cmd, (err, stream) => {
      if (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(tt);
          resolve({ stdout, stderr: String(err), code: -2 });
        }
        return;
      }
      stream.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      stream.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      stream.on("exit", (c: number) => {
        code = c;
      });
      stream.on("close", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(tt);
          resolve({ stdout, stderr, code });
        }
      });
    });
  });
}

// ── Supabase: look up VM by name ─────────────────────────────────────────────
async function lookupVM(name: string): Promise<VMState> {
  const fullName = name.startsWith("instaclaw-") ? name : `instaclaw-${name}`;
  const url =
    `${SUPABASE_URL}/rest/v1/instaclaw_vms?name=eq.${encodeURIComponent(fullName)}` +
    `&select=id,name,ip_address,config_version,health_status,telegram_bot_username,partner`;
  const h = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
  };
  const r = await fetch(url, { headers: h });
  if (!r.ok) {
    throw new Error(`Supabase lookup failed: HTTP ${r.status}`);
  }
  const rows = (await r.json()) as VMState[];
  if (!rows.length) throw new Error(`VM "${fullName}" not found in instaclaw_vms`);
  return rows[0];
}

// ── jsonl event parsing ──────────────────────────────────────────────────────
type SessionEvent = {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; id?: string; name?: string; tool_use_id?: string; text?: string }>;
    stopReason?: string;
  };
};

function parseEvents(raw: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* skip malformed */
    }
  }
  return events;
}

function findToolCallsInLastTurn(events: SessionEvent[]): Array<{ id: string; name: string }> {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "message" && e.message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const e of events.slice(lastUserIdx)) {
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    for (const b of e.message?.content ?? []) {
      if (b.type === "toolCall" && typeof b.id === "string") {
        out.push({ id: b.id, name: b.name ?? "unknown" });
      }
    }
  }
  return out;
}

function findToolResultIdsInLastTurn(events: SessionEvent[]): Set<string> {
  let lastUserIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "message" && e.message?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const ids = new Set<string>();
  if (lastUserIdx < 0) return ids;
  for (const e of events.slice(lastUserIdx)) {
    if (e.type !== "message" || e.message?.role !== "toolResult") continue;
    for (const b of e.message?.content ?? []) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        ids.add(b.tool_use_id);
      }
    }
  }
  return ids;
}

function findAssistantTextResponse(events: SessionEvent[], afterIdx: number): string | null {
  for (let i = afterIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "message" || e.message?.role !== "assistant") continue;
    const texts: string[] = [];
    for (const b of e.message?.content ?? []) {
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    if (texts.length) return texts.join("\n");
  }
  return null;
}

function findLastUserMessageIdx(events: SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "message" && e.message?.role === "user") return i;
  }
  return -1;
}

// ── Phase helpers ────────────────────────────────────────────────────────────
async function preflight(ssh: Client, vm: VMState, args: Args): Promise<{ pid: number; jsonlPath: string; preEvents: SessionEvent[]; gbrainActive: boolean }> {
  logEvent("preflight.start", `vm=${vm.name} ip=${vm.ip_address}`);

  // 1. Gateway active + healthy
  const active = (await sshExec(ssh, "systemctl --user is-active openclaw-gateway")).stdout.trim();
  const healthResp = await sshExec(ssh, "curl -sS -m 5 http://localhost:18789/health");
  log(`  gateway is-active=${active}, health body=${healthResp.stdout.slice(0, 80)}`);
  if (active !== "active" || !healthResp.stdout.includes('"ok":true')) {
    throw new Error(`Pre-flight failed: gateway not active+healthy (is-active=${active})`);
  }

  // 2. cv >= 100
  if (vm.config_version != null && vm.config_version < 100) {
    throw new Error(`Pre-flight failed: cv=${vm.config_version} < 100 (v100 RuntimeMaxSec removal). Reconcile this VM first.`);
  }

  // 3. Rule 35 — gbrain HTTP sidecar present (unless --skip-rule35-check)
  const gbrainActiveOut = (await sshExec(ssh, "systemctl --user is-active gbrain 2>/dev/null || echo not-installed")).stdout.trim();
  const gbrainActive = gbrainActiveOut === "active";
  log(`  gbrain sidecar is-active=${gbrainActiveOut}`);
  if (!gbrainActive && args.mode === "real" && !args.skipRule35Check) {
    throw new Error(
      `Pre-flight failed: gbrain sidecar not active (Rule 35 prerequisite). ` +
        `If you SIGTERM the gateway now, any post-restart "Something went wrong" ` +
        `cannot be attributed to orphan-tool_use vs gbrain-MCP-hang. ` +
        `Pass --skip-rule35-check to bypass (results will be ambiguous).`,
    );
  }

  // 4. Gateway PID
  const pidOut = (await sshExec(ssh, "systemctl --user show openclaw-gateway --property=MainPID --value")).stdout.trim();
  const pid = parseInt(pidOut, 10);
  if (!pid || Number.isNaN(pid)) throw new Error(`Pre-flight failed: invalid gateway PID "${pidOut}"`);
  log(`  gateway PID=${pid}`);

  // 5. Active session jsonl (most recently modified, excluding .trajectory.jsonl)
  const jsonlLs = (
    await sshExec(
      ssh,
      "ls -t ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | grep -v trajectory | head -1",
    )
  ).stdout.trim();
  if (!jsonlLs) throw new Error(`Pre-flight failed: no session jsonl files in ~/.openclaw/agents/main/sessions/`);
  const jsonlPath = jsonlLs;
  log(`  active session jsonl=${jsonlPath}`);

  // 6. Snapshot the jsonl (last 200 lines is plenty for context)
  const jsonlTail = (await sshExec(ssh, `tail -n 200 "${jsonlPath}"`)).stdout;
  const preEvents = parseEvents(jsonlTail);
  log(`  pre-test event count (last 200 lines)=${preEvents.length}`);

  // 7. Snapshot to local artifacts
  saveArtifact("pre-state.json", JSON.stringify({
    vm,
    pid,
    jsonlPath,
    preEventCount: preEvents.length,
    activeStatus: active,
    gbrainActive,
    runMode: args.mode,
    runTimestamp: TS_RUN,
  }, null, 2));
  saveArtifact("pre-jsonl-tail-200.jsonl", jsonlTail);

  logEvent("preflight.done");
  return { pid, jsonlPath, preEvents, gbrainActive };
}

async function pollFileSize(ssh: Client, path: string): Promise<number> {
  const r = await sshExec(ssh, `stat -c %s "${path}" 2>/dev/null || echo 0`, 5_000);
  return parseInt(r.stdout.trim(), 10) || 0;
}

async function waitForJsonlGrowth(
  ssh: Client,
  jsonlPath: string,
  baselineSize: number,
  timeoutMs: number,
  matcher: (events: SessionEvent[]) => boolean,
  label: string,
): Promise<SessionEvent[]> {
  const t0 = Date.now();
  let lastSize = baselineSize;
  while (Date.now() - t0 < timeoutMs) {
    const size = await pollFileSize(ssh, jsonlPath);
    if (size > lastSize) {
      const tail = (await sshExec(ssh, `tail -n 200 "${jsonlPath}"`)).stdout;
      const events = parseEvents(tail);
      if (matcher(events)) {
        return events;
      }
      lastSize = size;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for ${label}`);
}

async function waitForGatewayActive(ssh: Client, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const active = (await sshExec(ssh, "systemctl --user is-active openclaw-gateway", 5_000)).stdout.trim();
    if (active === "active") return;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for gateway active`);
}

async function waitForGatewayHealthy(ssh: Client, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await sshExec(ssh, "curl -sS -m 4 http://localhost:18789/health", 6_000);
    if (r.stdout.includes('"ok":true')) return;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for /health=200`);
}

// ── Classification ───────────────────────────────────────────────────────────
function classifyResponse(text: string | null, journalText: string): Pick<Verdict, "outcome" | "reasoning" | "bugMarkersFoundInResponse" | "repairMarkersFoundInJournal" | "responseText"> {
  const repairMarkersFound = REPAIR_FIRED_MARKERS.filter((m) => journalText.includes(m));
  const bugMarkersFound = ORPHAN_BUG_MARKERS.filter((m) => text?.includes(m));

  if (text == null) {
    return {
      outcome: "INCONCLUSIVE",
      reasoning: "No post-restart assistant response detected within timeout. Gateway may be stuck on another issue, or operator never sent the follow-up.",
      bugMarkersFoundInResponse: [],
      repairMarkersFoundInJournal: repairMarkersFound,
      responseText: null,
    };
  }
  if (bugMarkersFound.length > 0) {
    return {
      outcome: "ORPHAN_BUG_CONFIRMED",
      reasoning: `Post-restart response contains the GENERIC_EXTERNAL_RUN_FAILURE marker(s) [${bugMarkersFound.map(JSON.stringify).join(", ")}]. The orphan tool_use reached Anthropic and was rejected; OpenClaw's internal repair did NOT cover this load path. The orphan-repair PR plan is justified.`,
      bugMarkersFoundInResponse: bugMarkersFound,
      repairMarkersFoundInJournal: repairMarkersFound,
      responseText: text,
    };
  }
  // Normal-shaped response: classify as handled. But flag if the response is
  // suspiciously short / generic — could be a different error path.
  const looksHealthy = text.length > 20 && !/^[^a-zA-Z]*$/.test(text);
  if (!looksHealthy) {
    return {
      outcome: "INCONCLUSIVE",
      reasoning: `Post-restart response present but suspiciously short/empty (${text.length} chars). Manual review required.`,
      bugMarkersFoundInResponse: [],
      repairMarkersFoundInJournal: repairMarkersFound,
      responseText: text,
    };
  }
  return {
    outcome: "ORPHAN_HANDLED",
    reasoning: `Post-restart response is normal-shaped (${text.length} chars, no failure markers). OpenClaw's session-load path successfully recovered from the SIGTERM orphan. The orphan-repair PR is NOT needed for this scenario.${repairMarkersFound.length ? ` Repair marker(s) seen in journal: [${repairMarkersFound.join(", ")}].` : ""}`,
    bugMarkersFoundInResponse: [],
    repairMarkersFoundInJournal: repairMarkersFound,
    responseText: text,
  };
}

// ── Phase: simulate mode (inject orphan, no SIGTERM) ─────────────────────────
async function runSimulateMode(ssh: Client, vm: VMState, jsonlPath: string, preEvents: SessionEvent[]): Promise<void> {
  log("--mode=simulate: not running SIGTERM. Will inject a synthetic orphan into a COPY of the jsonl.");
  const copyPath = `/tmp/repro-orphan-sim-${TS_RUN}.jsonl`;

  // Copy the jsonl down locally
  const fullJsonl = (await sshExec(ssh, `cat "${jsonlPath}"`, 30_000)).stdout;
  writeFileSync(copyPath, fullJsonl);

  // Inject a synthetic user → assistant(toolCall) tail
  const syntheticOrphanId = `toolu_simulated_${TS_RUN}`;
  const userEvent = {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: SUGGESTED_TRIGGER_MESSAGE }] },
  };
  const assistantOrphan = {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "toolCall", id: syntheticOrphanId, name: "web_search", arguments: { q: "test" } }],
    },
  };
  writeFileSync(copyPath, fullJsonl + "\n" + JSON.stringify(userEvent) + "\n" + JSON.stringify(assistantOrphan) + "\n");
  log(`  wrote synthetic orphan to ${copyPath} (orphan id: ${syntheticOrphanId})`);
  saveArtifact("simulated-jsonl.jsonl", readFileSync(copyPath, "utf-8"));

  // Verify the parser finds it
  const events = parseEvents(readFileSync(copyPath, "utf-8"));
  const toolCalls = findToolCallsInLastTurn(events);
  const toolResults = findToolResultIdsInLastTurn(events);
  const orphans = toolCalls.filter((tc) => !toolResults.has(tc.id)).map((tc) => tc.id);
  log(`  parser found ${toolCalls.length} toolCall(s), ${toolResults.size} toolResult(s), ${orphans.length} orphan(s)`);
  if (orphans.length === 0 || !orphans.includes(syntheticOrphanId)) {
    throw new Error(`Simulate-mode plumbing test FAILED: parser did not find the injected orphan. Check parseEvents / findToolCallsInLastTurn logic.`);
  }

  const verdict: Verdict = {
    outcome: "INCONCLUSIVE",
    reasoning: "simulate mode: plumbing test passed (parser correctly detected the injected orphan). No SIGTERM performed; no real classification produced. Run --mode=real after Rule 35 lands for the actual Gate 0 result.",
    mode: "simulate",
    vm: vm.name,
    timestamps: { ...RUN_TIMESTAMPS, completed: nowIso() },
    orphanIds: orphans,
    repairMarkersFoundInJournal: [],
    bugMarkersFoundInResponse: [],
    responseText: null,
    artifactsDir: ARTIFACTS_DIR,
  };
  saveArtifact("verdict.json", JSON.stringify(verdict, null, 2));
  printVerdict(verdict);
}

// ── Phase: dry-run mode (pre-flight only) ────────────────────────────────────
function runDryRunMode(vm: VMState, jsonlPath: string): void {
  log("--mode=dry-run: pre-flight only. No destructive operations.");
  log("");
  log("If --mode=real were used, the script would:");
  log(`  1. Prompt operator to send to @${vm.telegram_bot_username || "<bot>"}: "${SUGGESTED_TRIGGER_MESSAGE}"`);
  log(`  2. Watch ${jsonlPath} for a new user message → assistant(toolCall) sequence`);
  log(`  3. SIGTERM the gateway upon toolCall detection`);
  log(`  4. Wait up to ${TIMEOUTS.gatewayRestart / 1000}s for systemd restart + /health=200`);
  log(`  5. Prompt operator to send: "${SUGGESTED_FOLLOWUP_MESSAGE}"`);
  log(`  6. Watch for the next assistant response, classify against bug markers`);
  log("");
  log("Pre-flight passed. Re-run with --mode=real --i-understand-this-sigterms-the-gateway when ready.");

  const verdict: Verdict = {
    outcome: "INCONCLUSIVE",
    reasoning: "dry-run mode: pre-flight only, no test performed.",
    mode: "dry-run",
    vm: vm.name,
    timestamps: { ...RUN_TIMESTAMPS, completed: nowIso() },
    orphanIds: [],
    repairMarkersFoundInJournal: [],
    bugMarkersFoundInResponse: [],
    responseText: null,
    artifactsDir: ARTIFACTS_DIR,
  };
  saveArtifact("verdict.json", JSON.stringify(verdict, null, 2));
  printVerdict(verdict);
}

// ── Phase: real mode (the actual gate test) ──────────────────────────────────
async function runRealMode(ssh: Client, vm: VMState, pid: number, jsonlPath: string, preEvents: SessionEvent[]): Promise<void> {
  log("--mode=real: will SIGTERM the gateway. Forensics will be saved regardless of outcome.");

  // Capture journal cursor for post-test diff
  const journalCursorRaw = (
    await sshExec(ssh, "journalctl --user -u openclaw-gateway -n 1 --output=json --no-pager 2>/dev/null | tail -1", 8_000)
  ).stdout.trim();
  let journalCursor: string | null = null;
  try {
    journalCursor = JSON.parse(journalCursorRaw).__CURSOR ?? null;
  } catch { /* best-effort */ }
  log(`  journal cursor (post-test diff anchor): ${journalCursor ? "captured" : "NOT captured — full-journal fallback"}`);

  // ── Phase A: operator sends initial trigger ──
  operatorPrompt(
    `Send the following message via Telegram to @${vm.telegram_bot_username || "<bot>"}:\n\n` +
      `    ${SUGGESTED_TRIGGER_MESSAGE}\n\n` +
      `Send it now. The script will wait up to ${TIMEOUTS.initialMessageWait / 1000}s and watch the session jsonl.`,
  );
  logEvent("waiting-for-trigger-message");

  // Watch for a NEW user message after preEvents
  const baselineUserCount = preEvents.filter((e) => e.type === "message" && e.message?.role === "user").length;
  const eventsAfterUser = await waitForJsonlGrowth(
    ssh,
    jsonlPath,
    await pollFileSize(ssh, jsonlPath),
    TIMEOUTS.initialMessageWait,
    (events) => events.filter((e) => e.type === "message" && e.message?.role === "user").length > baselineUserCount,
    "new user message",
  );
  logEvent("trigger-message-received");

  // ── Phase B: wait for toolCall to appear ──
  log(`  waiting up to ${TIMEOUTS.toolCallAppear / 1000}s for OpenClaw to start tool execution...`);
  const baselineToolCallCount = findToolCallsInLastTurn(eventsAfterUser).length;
  const eventsAfterToolCall = await waitForJsonlGrowth(
    ssh,
    jsonlPath,
    await pollFileSize(ssh, jsonlPath),
    TIMEOUTS.toolCallAppear,
    (events) => findToolCallsInLastTurn(events).length > baselineToolCallCount,
    "assistant toolCall block",
  );
  const toolCallsInTurn = findToolCallsInLastTurn(eventsAfterToolCall);
  logEvent("toolcall-detected", `count=${toolCallsInTurn.length} ids=[${toolCallsInTurn.map((t) => t.id).join(", ")}]`);

  // Snapshot pre-SIGTERM state IMMEDIATELY
  saveArtifact("pre-sigterm-jsonl-tail-200.jsonl", (await sshExec(ssh, `tail -n 200 "${jsonlPath}"`, 15_000)).stdout);

  // ── Phase C: SIGTERM ──
  log("  ☠️  SIGTERM-ing gateway NOW");
  const killResult = await sshExec(ssh, `kill -TERM ${pid}`, 5_000);
  logEvent("sigterm-sent", `code=${killResult.code}`);
  if (killResult.code !== 0) log(`  warning: kill exited non-zero (stdout=${killResult.stdout} stderr=${killResult.stderr})`);

  // ── Phase D: wait for restart ──
  log(`  waiting up to ${TIMEOUTS.gatewayRestart / 1000}s for gateway restart + /health=200...`);
  // Coarse: wait for is-active=active. Fine: wait for /health=200.
  // First a brief settling window so we don't poll while shutdown is in flight.
  await new Promise((r) => setTimeout(r, 2_000));
  await waitForGatewayActive(ssh, TIMEOUTS.gatewayRestart);
  logEvent("gateway-active-again");
  await waitForGatewayHealthy(ssh, 60_000);
  logEvent("gateway-healthy-again");

  // Capture restart journal — everything since the SIGTERM
  const journalCmd = journalCursor
    ? `journalctl --user -u openclaw-gateway --after-cursor='${journalCursor}' --no-pager`
    : `journalctl --user -u openclaw-gateway --since '5 minutes ago' --no-pager`;
  const restartJournal = (await sshExec(ssh, journalCmd, 30_000)).stdout;
  saveArtifact("restart-journal.txt", restartJournal);

  const repairMarkerHits = REPAIR_FIRED_MARKERS.filter((m) => restartJournal.includes(m));
  log(`  restart journal captured (${restartJournal.length} bytes). Repair markers seen: [${repairMarkerHits.join(", ") || "none"}]`);

  // ── Phase E: operator sends follow-up ──
  operatorPrompt(
    `Gateway is back up. Send a follow-up message via Telegram to @${vm.telegram_bot_username || "<bot>"}:\n\n` +
      `    ${SUGGESTED_FOLLOWUP_MESSAGE}\n\n` +
      `Any short message works. The script will wait up to ${TIMEOUTS.followupMessageWait / 1000}s and look for the bot's reply in the session jsonl.`,
  );
  logEvent("waiting-for-followup-message");

  const sizeAtFollowupStart = await pollFileSize(ssh, jsonlPath);
  const followupSeenEvents = await waitForJsonlGrowth(
    ssh,
    jsonlPath,
    sizeAtFollowupStart,
    TIMEOUTS.followupMessageWait,
    (events) => {
      const lastUserIdx = findLastUserMessageIdx(events);
      // Need a NEW user message we haven't seen before
      return lastUserIdx > -1 && events.length > eventsAfterToolCall.length;
    },
    "follow-up user message",
  );
  logEvent("followup-message-received");
  const followupUserIdx = findLastUserMessageIdx(followupSeenEvents);

  // ── Phase F: wait for assistant response ──
  log(`  waiting up to ${TIMEOUTS.responseAppear / 1000}s for the assistant response...`);
  const responseEvents = await waitForJsonlGrowth(
    ssh,
    jsonlPath,
    await pollFileSize(ssh, jsonlPath),
    TIMEOUTS.responseAppear,
    (events) => {
      const idx = findLastUserMessageIdx(events);
      if (idx <= followupUserIdx) return false;
      // OR — same user idx but assistant followed
      return findAssistantTextResponse(events, followupUserIdx) != null;
    },
    "assistant response",
  ).catch((e) => {
    log(`  no assistant response within timeout: ${e.message}`);
    return null;
  });

  // Snapshot final jsonl
  saveArtifact("post-restart-jsonl-tail-200.jsonl", (await sshExec(ssh, `tail -n 200 "${jsonlPath}"`, 15_000)).stdout);

  const responseText = responseEvents ? findAssistantTextResponse(responseEvents, followupUserIdx) : null;
  logEvent("response-captured", responseText ? `${responseText.length} chars` : "NONE");

  // ── Phase G: classify ──
  const { outcome, reasoning, bugMarkersFoundInResponse, repairMarkersFoundInJournal } = classifyResponse(
    responseText,
    restartJournal,
  );
  const verdict: Verdict = {
    outcome,
    reasoning,
    mode: "real",
    vm: vm.name,
    timestamps: { ...RUN_TIMESTAMPS, completed: nowIso() },
    orphanIds: toolCallsInTurn.map((t) => t.id),
    repairMarkersFoundInJournal,
    bugMarkersFoundInResponse,
    responseText,
    artifactsDir: ARTIFACTS_DIR,
  };
  saveArtifact("verdict.json", JSON.stringify(verdict, null, 2));
  printVerdict(verdict);
}

function printVerdict(verdict: Verdict): void {
  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════");
  console.log(`  VERDICT: ${verdict.outcome}`);
  console.log("════════════════════════════════════════════════════════════════════════");
  console.log("");
  console.log(verdict.reasoning);
  console.log("");
  console.log(`Mode:           ${verdict.mode}`);
  console.log(`VM:             ${verdict.vm}`);
  console.log(`Orphan ids:     ${verdict.orphanIds.join(", ") || "(none captured)"}`);
  console.log(`Repair markers: ${verdict.repairMarkersFoundInJournal.join(", ") || "(none)"}`);
  console.log(`Bug markers:    ${verdict.bugMarkersFoundInResponse.join(", ") || "(none)"}`);
  if (verdict.responseText) {
    console.log("");
    console.log(`Response excerpt (first 300 chars):`);
    console.log(`  ${verdict.responseText.slice(0, 300).replace(/\n/g, "\n  ")}`);
  }
  console.log("");
  console.log(`Forensics:      ${verdict.artifactsDir}/`);
  console.log("");
  console.log("Next step:");
  if (verdict.outcome === "ORPHAN_HANDLED") {
    console.log("  → OpenClaw's internal repair covers this scenario. Drop a confirmatory");
    console.log("    note at instaclaw/docs/incidents/<date>-orphan-already-handled.md");
    console.log("    citing this run's artifacts dir. The orphan-repair PR is NOT needed.");
  } else if (verdict.outcome === "ORPHAN_BUG_CONFIRMED") {
    console.log("  → The bug is real. Proceed with the orphan-repair PR plan (see CLAUDE.md");
    console.log("    follow-up note + companion PR-plan doc). File an incident at");
    console.log("    instaclaw/docs/incidents/<date>-orphan-repro-confirmed.md.");
  } else {
    console.log("  → Inconclusive. Review the forensics, identify the gap, and either");
    console.log("    re-run with longer timeouts or fix the missing pre-condition.");
  }
  console.log("");
}

// ── Main orchestrator ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();

  if (args.mode === "real" && !args.iUnderstand) {
    console.error("");
    console.error("REFUSED: --mode=real requires --i-understand-this-sigterms-the-gateway");
    console.error("");
    console.error("This test:");
    console.error("  - SIGTERMs the gateway on the target VM mid-tool-call");
    console.error("  - Causes a brief outage (~60-180s depending on plugin count)");
    console.error("  - Leaves a real session turn (with intentional orphan) in the jsonl");
    console.error("  - Is intended for vm-050 (Cooper's test agent), NOT a paying customer VM");
    console.error("");
    console.error("Re-run with --i-understand-this-sigterms-the-gateway to proceed.");
    process.exit(2);
  }

  log(`Repro: orphan tool_use Gate 0 — vm=${args.vmName} mode=${args.mode}`);
  log(`Artifacts dir: ${ARTIFACTS_DIR}`);
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  // Save the script invocation for forensics
  saveArtifact("invocation.json", JSON.stringify({
    args: process.argv,
    cwd: process.cwd(),
    timestamp: nowIso(),
    nodeVersion: process.version,
  }, null, 2));

  const vm = await lookupVM(args.vmName);
  log(`Resolved VM: ${vm.name} ip=${vm.ip_address} cv=${vm.config_version} health=${vm.health_status} partner=${vm.partner ?? "(none)"}`);
  if (vm.health_status !== "healthy") {
    log(`  WARNING: health_status is "${vm.health_status}", not "healthy". Test may not behave as expected.`);
  }

  const ssh = await sshConnect(vm.ip_address);
  try {
    const { pid, jsonlPath, preEvents } = await preflight(ssh, vm, args);

    if (args.mode === "dry-run") {
      runDryRunMode(vm, jsonlPath);
      return;
    }
    if (args.mode === "simulate") {
      await runSimulateMode(ssh, vm, jsonlPath, preEvents);
      return;
    }
    if (args.mode === "real") {
      await runRealMode(ssh, vm, pid, jsonlPath, preEvents);
      return;
    }
  } finally {
    ssh.end();
  }
}

main().catch((err) => {
  console.error("");
  console.error("FATAL: repro script crashed");
  console.error(err?.stack ?? err);
  console.error("");
  console.error(`Forensics (partial): ${ARTIFACTS_DIR}/`);
  // Try to save the error to the artifacts dir too
  try {
    saveArtifact("crash.json", JSON.stringify({ error: String(err), stack: err?.stack, timestamp: nowIso() }, null, 2));
  } catch { /* best-effort */ }
  process.exit(1);
});
