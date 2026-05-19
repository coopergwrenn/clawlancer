/**
 * Canary monitor for v107 gbrain fleet rollout.
 *
 * Aggregates per-VM health signals across the canary cohort (or any subset
 * specified). Compares to baseline snapshot saved at first run. Exits non-
 * zero if any threshold breach detected.
 *
 * Signals captured per VM:
 *   - gbrain.service state (active / failed / activating / inactive)
 *   - gbrain /health (HTTP 200 + JSON parse)
 *   - gbrain NRestarts (vs baseline)
 *   - pg_control mtime age (must be < 60 min for healthy checkpoint cron)
 *   - pglite-checkpoint cron last 5 entries (failure detection)
 *   - openclaw-gateway state + /health
 *   - free memory (MB) — alert if < 500 MB
 *   - disk usage % — alert if > 85%
 *   - load avg (1min)
 *   - SOUL.md marker present (GBRAIN_SOUL_ROUTING_V1)
 *   - AGENTS.md marker present (GBRAIN_MEMORY_PROTOCOL_V1)
 *   - gbrain page count (list_pages — proves utility)
 *
 * Usage:
 *   cd instaclaw
 *   npx tsx scripts/_monitor-gbrain-canary.ts              # all canary VMs (gbrain_enabled=true)
 *   npx tsx scripts/_monitor-gbrain-canary.ts vm-602 vm-517 # subset
 *   npx tsx scripts/_monitor-gbrain-canary.ts --baseline    # save baseline (run before deploy)
 *
 * Outputs:
 *   - Console: human summary + breach flags
 *   - /tmp/gbrain-canary-monitor-<ts>.json: structured per-VM data
 *   - /tmp/gbrain-canary-baseline.json: baseline snapshot (created by --baseline)
 *   - Exit code: 0 if all green, 1 if any threshold breached
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

try {
  for (const f of [
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
  ]) {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {}

const BASELINE_FILE = "/tmp/gbrain-canary-baseline.json";

interface VmSignals {
  name: string;
  ip: string;
  tier: string | null;
  // gbrain service
  gbrain_service_state: string;
  gbrain_health_http: string;
  gbrain_version: string | null;
  gbrain_nrestarts: number;
  // pg_control
  pg_control_age_min: number | null;
  cron_last_5: string[];
  // gateway
  gateway_state: string;
  gateway_health_http: string;
  // system
  free_mem_mb: number;
  disk_used_pct: number;
  load_avg_1min: number;
  // content markers
  soul_marker_present: boolean;
  agents_marker_present: boolean;
  // utility signal
  page_count: number | null;
  // error states
  error: string | null;
}

interface Baseline {
  ts: string;
  vms: Record<string, Partial<VmSignals>>;
}

async function probe(ip: string, name: string, tier: string | null): Promise<VmSignals> {
  const result: VmSignals = {
    name, ip, tier,
    gbrain_service_state: "?",
    gbrain_health_http: "?",
    gbrain_version: null,
    gbrain_nrestarts: 0,
    pg_control_age_min: null,
    cron_last_5: [],
    gateway_state: "?",
    gateway_health_http: "?",
    free_mem_mb: 0,
    disk_used_pct: 0,
    load_avg_1min: 0,
    soul_marker_present: false,
    agents_marker_present: false,
    page_count: null,
    error: null,
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip, username: "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      readyTimeout: 12_000,
    });

    const cmd = `
export XDG_RUNTIME_DIR=/run/user/$(id -u)
echo "PROBE_GBRAIN_STATE=$(systemctl --user is-active gbrain.service 2>&1 | head -1)"
echo "PROBE_GBRAIN_HEALTH=$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/health 2>/dev/null || echo 000)"
echo "PROBE_GBRAIN_VERSION=$(curl -sf -m 2 http://127.0.0.1:3131/health 2>/dev/null | grep -oE '"version":"[^"]+"' | cut -d'"' -f4 || echo none)"
echo "PROBE_GBRAIN_NRESTARTS=$(systemctl --user show gbrain.service --property=NRestarts --value 2>/dev/null || echo 0)"
PGCTL=$(stat -c %Y ~/.gbrain/brain.pglite/global/pg_control 2>/dev/null); [ -z "$PGCTL" ] && PGCTL=0
NOW=$(date +%s)
if [ "$PGCTL" -gt 0 ]; then echo "PROBE_PG_CONTROL_AGE_MIN=$(( (NOW - PGCTL) / 60 ))"; else echo "PROBE_PG_CONTROL_AGE_MIN=-1"; fi
echo "PROBE_CRON_LAST_5=$(tail -5 ~/.openclaw/logs/pglite-checkpoint.log 2>/dev/null | tr '\\n' '|' || echo none)"
echo "PROBE_GATEWAY_STATE=$(systemctl --user is-active openclaw-gateway 2>&1 | head -1)"
echo "PROBE_GATEWAY_HEALTH=$(curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000)"
echo "PROBE_FREE_MEM_MB=$(free -m | awk '/^Mem:/ {print $7}')"
echo "PROBE_DISK_USED_PCT=$(df --output=pcent / | tail -1 | tr -d ' %')"
echo "PROBE_LOAD_AVG_1MIN=$(awk '{print $1}' /proc/loadavg)"
echo "PROBE_SOUL_MARKER=$(grep -cF '<!-- GBRAIN_SOUL_ROUTING_V1 -->' ~/.openclaw/workspace/SOUL.md 2>/dev/null)"
echo "PROBE_AGENTS_MARKER=$(grep -cF 'GBRAIN_MEMORY_PROTOCOL_V1' ~/.openclaw/workspace/AGENTS.md 2>/dev/null)"
# Page count via gbrain MCP (list_pages, only run if gbrain is healthy)
PAGE_COUNT=""
if [ -f ~/.gbrain/openclaw-bearer-token.txt ]; then
  BEARER=$(cat ~/.gbrain/openclaw-bearer-token.txt 2>/dev/null)
  PAGE_RESP=$(curl -sS -X POST http://127.0.0.1:3131/mcp \\
    -H "Authorization: Bearer $BEARER" -H "Content-Type: application/json" \\
    -H "Accept: application/json,text/event-stream" --max-time 5 \\
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}' 2>/dev/null || echo "")
  if [ -n "$PAGE_RESP" ]; then
    PAGE_COUNT=$(echo "$PAGE_RESP" | grep -oE '\\\\"slug\\\\":' | wc -l)
  fi
fi
echo "PROBE_PAGE_COUNT=$PAGE_COUNT"
`;
    const r = await Promise.race([
      ssh.execCommand(cmd),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000)),
    ]);
    const stdout: string = (r as any).stdout || "";
    const lines = stdout.split("\n");
    const getLine = (prefix: string): string => {
      const line = lines.find((l) => l.startsWith(prefix));
      return line ? line.slice(prefix.length).trim() : "";
    };

    result.gbrain_service_state = getLine("PROBE_GBRAIN_STATE=") || "?";
    result.gbrain_health_http = getLine("PROBE_GBRAIN_HEALTH=") || "?";
    const gv = getLine("PROBE_GBRAIN_VERSION=");
    result.gbrain_version = (gv && gv !== "none") ? gv : null;
    result.gbrain_nrestarts = parseInt(getLine("PROBE_GBRAIN_NRESTARTS=") || "0", 10);
    const pgAge = parseInt(getLine("PROBE_PG_CONTROL_AGE_MIN=") || "-1", 10);
    result.pg_control_age_min = pgAge < 0 ? null : pgAge;
    const cronRaw = getLine("PROBE_CRON_LAST_5=");
    result.cron_last_5 = cronRaw && cronRaw !== "none"
      ? cronRaw.split("|").filter(Boolean).map((s) => s.trim())
      : [];
    result.gateway_state = getLine("PROBE_GATEWAY_STATE=") || "?";
    result.gateway_health_http = getLine("PROBE_GATEWAY_HEALTH=") || "?";
    result.free_mem_mb = parseInt(getLine("PROBE_FREE_MEM_MB=") || "0", 10);
    result.disk_used_pct = parseInt(getLine("PROBE_DISK_USED_PCT=") || "0", 10);
    result.load_avg_1min = parseFloat(getLine("PROBE_LOAD_AVG_1MIN=") || "0");
    result.soul_marker_present = parseInt(getLine("PROBE_SOUL_MARKER=") || "0", 10) > 0;
    result.agents_marker_present = parseInt(getLine("PROBE_AGENTS_MARKER=") || "0", 10) > 0;
    const pc = getLine("PROBE_PAGE_COUNT=");
    result.page_count = pc ? parseInt(pc, 10) : null;
  } catch (e: any) {
    result.error = String(e.message).slice(0, 120);
  } finally {
    try { ssh.dispose(); } catch {}
  }
  return result;
}

async function getCanaryVms(args: string[]): Promise<Array<{ name: string; ip: string; tier: string | null }>> {
  const sb = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const explicit = args.filter((a) => !a.startsWith("--"));
  let query = sb.from("instaclaw_vms").select("name, ip_address, tier, gbrain_enabled, partner");
  if (explicit.length > 0) {
    query = query.in("name", explicit);
  } else {
    // Default: all canary cohort (gbrain_enabled = true) — NOT edge partner-default.
    // This isolates the canary signal from edge_city which already had gbrain.
    query = query.eq("gbrain_enabled", true);
  }
  const { data } = await query;
  return (data ?? []).map((d) => ({ name: d.name, ip: d.ip_address, tier: d.tier }));
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveBaseline(snapshot: Baseline) {
  writeFileSync(BASELINE_FILE, JSON.stringify(snapshot, null, 2));
}

function evaluateThresholds(s: VmSignals, baseline: Partial<VmSignals> | null): string[] {
  const breaches: string[] = [];
  if (s.error) {
    breaches.push(`error: ${s.error}`);
    return breaches;
  }
  // gbrain.service
  if (s.gbrain_service_state !== "active") {
    breaches.push(`gbrain_state=${s.gbrain_service_state} (want active)`);
  }
  if (s.gbrain_health_http !== "200") {
    breaches.push(`gbrain_health=${s.gbrain_health_http} (want 200)`);
  }
  // NRestarts delta
  if (baseline && typeof baseline.gbrain_nrestarts === "number") {
    const delta = s.gbrain_nrestarts - baseline.gbrain_nrestarts;
    if (delta > 0) breaches.push(`gbrain_nrestarts +${delta} since baseline`);
  } else if (s.gbrain_nrestarts > 2) {
    // No baseline; absolute restart count threshold
    breaches.push(`gbrain_nrestarts=${s.gbrain_nrestarts} (>2 without baseline context)`);
  }
  // pg_control freshness (the 2026-05-18 Rule 54 corruption class)
  if (s.pg_control_age_min === null) {
    breaches.push("pg_control_age unknown (file missing or unreadable)");
  } else if (s.pg_control_age_min > 60) {
    breaches.push(`pg_control_age=${s.pg_control_age_min}min (>60min — checkpoint cron broken)`);
  }
  // Checkpoint cron: last 5 entries should be `ok`. Any `FAILED` is a problem.
  const cronFailed = s.cron_last_5.filter((l) => l.includes("FAILED"));
  if (cronFailed.length > 0) {
    breaches.push(`cron_failures=${cronFailed.length} in last 5 entries`);
  }
  // Gateway
  if (s.gateway_state !== "active") {
    breaches.push(`gateway_state=${s.gateway_state} (want active)`);
  }
  if (s.gateway_health_http !== "200") {
    breaches.push(`gateway_health=${s.gateway_health_http} (want 200)`);
  }
  // Resources
  if (s.free_mem_mb < 500) {
    breaches.push(`free_mem=${s.free_mem_mb}MB (<500MB)`);
  }
  if (s.disk_used_pct > 85) {
    breaches.push(`disk_used=${s.disk_used_pct}% (>85%)`);
  }
  // Content markers should be present once deployed
  if (!s.soul_marker_present) {
    breaches.push("soul_marker missing (GBRAIN_SOUL_ROUTING_V1 not on disk)");
  }
  if (!s.agents_marker_present) {
    breaches.push("agents_marker missing (GBRAIN_MEMORY_PROTOCOL_V1 not on disk)");
  }
  return breaches;
}

function printVm(s: VmSignals, breaches: string[]) {
  const tag = breaches.length === 0 ? "✓" : "✗";
  const restartsStr = s.gbrain_nrestarts > 0 ? `R${s.gbrain_nrestarts}` : "R0";
  const summary = s.error
    ? `ERR: ${s.error}`
    : `gbrain=${s.gbrain_service_state}/${s.gbrain_health_http} ${restartsStr} ` +
      `pg=${s.pg_control_age_min}min gw=${s.gateway_state}/${s.gateway_health_http} ` +
      `mem=${s.free_mem_mb}MB disk=${s.disk_used_pct}% ` +
      `soul=${s.soul_marker_present ? "✓" : "✗"} agents=${s.agents_marker_present ? "✓" : "✗"} ` +
      `pages=${s.page_count ?? "?"}`;
  console.log(`${tag} ${s.name.padEnd(20)} ${(s.tier || "?").padEnd(6)} ${summary}`);
  for (const b of breaches) {
    console.log(`    ! ${b}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isBaseline = args.includes("--baseline");
  const cleanArgs = args.filter((a) => a !== "--baseline");

  const vms = await getCanaryVms(cleanArgs);
  if (vms.length === 0) {
    console.error("No VMs match selection. Did you forget to enable canary (UPDATE gbrain_enabled = true)?");
    process.exit(2);
  }

  console.log(`Probing ${vms.length} VM(s)${isBaseline ? " (BASELINE)" : ""}...\n`);

  // Concurrency 5 — same as deploy script
  const results: VmSignals[] = [];
  for (let i = 0; i < vms.length; i += 5) {
    const batch = vms.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map((v) => probe(v.ip, v.name, v.tier)));
    results.push(...batchResults);
  }

  if (isBaseline) {
    const baseline: Baseline = { ts: new Date().toISOString(), vms: {} };
    for (const r of results) baseline.vms[r.name] = r;
    saveBaseline(baseline);
    console.log(`\nBaseline saved to ${BASELINE_FILE} (${results.length} VMs)`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.log("(No baseline file found — alerts will use absolute thresholds only. Run with --baseline first.)\n");
  } else {
    console.log(`(Baseline ts: ${baseline.ts})\n`);
  }

  let totalBreaches = 0;
  for (const r of results) {
    const baselineVm = baseline?.vms[r.name] ?? null;
    const breaches = evaluateThresholds(r, baselineVm);
    if (breaches.length > 0) totalBreaches += 1;
    printVm(r, breaches);
  }

  // Save snapshot for trend analysis
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = `/tmp/gbrain-canary-monitor-${ts}.json`;
  writeFileSync(snapshotPath, JSON.stringify({
    ts, baseline_ts: baseline?.ts ?? null, vms: results,
  }, null, 2));
  console.log(`\nSnapshot: ${snapshotPath}`);
  console.log("");

  // Aggregate stats
  const installed = results.filter((r) => r.gbrain_service_state === "active").length;
  const healthy = results.filter((r) => r.gbrain_health_http === "200").length;
  const soul = results.filter((r) => r.soul_marker_present).length;
  const agents = results.filter((r) => r.agents_marker_present).length;
  const errors = results.filter((r) => r.error).length;
  console.log(`Total: ${results.length}  gbrain active: ${installed}  /health 200: ${healthy}  soul-marker: ${soul}  agents-marker: ${agents}  errors: ${errors}`);
  console.log(`VMs with breaches: ${totalBreaches} / ${results.length}`);

  process.exit(totalBreaches === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
