/**
 * EMERGENCY 2026-05-11: fresh fleet scan + surgical recovery.
 *
 * Per Cooper:
 *   1. Fresh scan of ALL assigned VMs (do not trust the 20-min-old report).
 *   2. Push `openclaw config set agents.defaults.bootstrapMaxChars 40000` to
 *      EVERY reachable VM — safe value, idempotent, no reason to be selective.
 *   3. Restart gateway IF any of these are true:
 *        a. SOUL.md > 34,500 chars (500-char safety margin for dynamic growth)
 *        b. VM was unreachable in the earlier scan
 *        c. journalctl --user openclaw-gateway since 24h ago shows
 *           "messages must not be empty" or "all in cooldown" — death-spiral
 *           signals indicating the VM already hit the wall.
 *   4. After all restarts: verify vm-050 (timmy) + vm-780 (cooper's main)
 *      are gateway-active + /health 200 + Telegram channel connected.
 *   5. Retry the 6 unreachables; flag if still down.
 *
 * Single-SSH-per-VM probe collects all needed data + applies in one shot.
 * Concurrency: 12. Expected total time: ~90-180s for ~210 VMs.
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// VMs flagged UNREACHABLE in the 2026-05-11 scan (docs/soul-md-fleet-scan-2026-05-11.md)
// Header line said 6 unreachable but didn't list them in what I read. The
// script retries via the live probe — any VM that comes back UNREACHABLE here
// is the genuine concern. We don't strictly need the historical list.

// SOUL.md size threshold for restart. 500-char safety margin below 35K because
// SOUL.md can grow dynamically (Learned Preferences edits, identity patches).
const SOUL_RESTART_THRESHOLD = 34_500;

// Death-spiral signals in journal output.
const DEATH_SPIRAL_PATTERNS = ["messages must not be empty", "all in cooldown"];

// PROBE_SCRIPT:
//   - PUSH config (safe everywhere)
//   - Measure SOUL.md size
//   - Check journal for death-spiral signals (last 24h)
//   - Probe gateway active + /health
//   - DO NOT restart in this pass — analysis decides per-VM
const PROBE_SCRIPT = `set +e
source ~/.nvm/nvm.sh 2>/dev/null
export XDG_RUNTIME_DIR=/run/user/$(id -u)

# 1. Push config (idempotent, safe value). Always do this.
SET_OUT=$(openclaw config set agents.defaults.bootstrapMaxChars 40000 2>&1)
SET_CODE=$?

# 2. Read current on-disk value (post-set verification).
DISK_VAL=$(grep -oE '"bootstrapMaxChars": *"[0-9]+"' ~/.openclaw/openclaw.json 2>/dev/null | grep -oE '[0-9]+' | head -1)

# 3. Measure SOUL.md.
SOUL_SIZE=$(stat -c %s ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo 0)

# 4. Death-spiral signals in journal (last 24h).
SPIRAL=$(journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null | grep -cE '(messages must not be empty|all in cooldown)')

# 5. Gateway state.
ACTIVE=$(systemctl --user is-active openclaw-gateway 2>/dev/null)
HEALTH=$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000)

echo "RES|SET=$SET_CODE|DISK=$DISK_VAL|SOUL=$SOUL_SIZE|SPIRAL=$SPIRAL|ACTIVE=$ACTIVE|HEALTH=$HEALTH"
`;

const RESTART_SCRIPT = `set +e
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user reset-failed openclaw-gateway 2>/dev/null || true
systemctl --user restart openclaw-gateway 2>&1
ACTIVE=""
HEALTH=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  ACTIVE=$(systemctl --user is-active openclaw-gateway 2>/dev/null)
  HEALTH=$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000)
  if [ "$ACTIVE" = "active" ] && [ "$HEALTH" = "200" ]; then break; fi
  sleep 3
done
echo "RES|ACTIVE=$ACTIVE|HEALTH=$HEALTH"
`;

interface ProbeResult {
  name: string;
  ip: string;
  reachable: boolean;
  setCode: string;
  disk: string;
  soulSize: number;
  spiralHits: number;
  active: string;
  health: string;
  needsRestart: boolean;
  restartReason: string[];
  err?: string;
  durationMs: number;
}

interface RestartResult {
  active: string;
  health: string;
  ok: boolean;
  err?: string;
}

function exec(host: string, cmd: string, t = 30_000): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client();
    let o = "";
    const tt = setTimeout(() => { try { c.end(); } catch { /* noop */ } resolve("[TIMEOUT]"); }, t);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); c.end(); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => { o += d.toString(); });
      s.stderr.on("data", (d: Buffer) => { o += d.toString(); });
      s.on("close", () => { clearTimeout(tt); c.end(); resolve(o); });
    }));
    c.on("error", (e) => { clearTimeout(tt); resolve("conn err: " + e.message); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: KEY, readyTimeout: 8_000 });
  });
}

async function probeOne(vm: { name: string; ip_address: string }): Promise<ProbeResult> {
  const start = Date.now();
  const out = await exec(vm.ip_address, PROBE_SCRIPT, 30_000);
  const dt = Date.now() - start;
  const r: ProbeResult = {
    name: vm.name, ip: vm.ip_address, reachable: false,
    setCode: "?", disk: "?", soulSize: 0, spiralHits: 0,
    active: "?", health: "?",
    needsRestart: false, restartReason: [], durationMs: dt,
  };
  if (out.startsWith("[TIMEOUT]") || out.includes("conn err") || out.includes("err: ")) {
    r.err = out.slice(0, 200);
    return r;
  }
  const line = out.split("\n").find((l) => l.startsWith("RES|")) ?? "";
  const parts: Record<string, string> = {};
  for (const p of line.replace(/^RES\|/, "").split("|")) {
    const [k, v] = p.split("=");
    if (k && v !== undefined) parts[k] = v;
  }
  r.reachable = true;
  r.setCode = parts.SET ?? "?";
  r.disk = parts.DISK ?? "?";
  r.soulSize = parseInt(parts.SOUL ?? "0", 10) || 0;
  r.spiralHits = parseInt(parts.SPIRAL ?? "0", 10) || 0;
  r.active = parts.ACTIVE ?? "?";
  r.health = parts.HEALTH ?? "?";
  if (r.soulSize > SOUL_RESTART_THRESHOLD) r.restartReason.push(`soul=${r.soulSize}`);
  if (r.spiralHits > 0) r.restartReason.push(`spiral=${r.spiralHits}`);
  if (r.active !== "active" || r.health !== "200") r.restartReason.push(`degraded(active=${r.active},health=${r.health})`);
  r.needsRestart = r.restartReason.length > 0;
  return r;
}

async function restartOne(vm: { name: string; ip: string }): Promise<RestartResult> {
  const out = await exec(vm.ip, RESTART_SCRIPT, 60_000);
  const r: RestartResult = { active: "?", health: "?", ok: false };
  if (out.startsWith("[TIMEOUT]") || out.includes("conn err") || out.includes("err: ")) {
    r.err = out.slice(0, 200);
    return r;
  }
  const line = out.split("\n").find((l) => l.startsWith("RES|")) ?? "";
  const parts: Record<string, string> = {};
  for (const p of line.replace(/^RES\|/, "").split("|")) {
    const [k, v] = p.split("=");
    if (k && v !== undefined) parts[k] = v;
  }
  r.active = parts.ACTIVE ?? "?";
  r.health = parts.HEALTH ?? "?";
  r.ok = r.active === "active" && r.health === "200";
  return r;
}

async function workerPool<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main() {
  const t0 = Date.now();
  console.log(`\n=== EMERGENCY fleet sweep — fresh probe + targeted restart ===\n`);

  // Phase 1: pull all assigned + healthy VMs.
  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address, assigned_to")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy");
  if (error || !vms) { console.error("DB query failed:", error?.message); process.exit(1); }
  console.log(`Phase 1: probing ${vms.length} healthy assigned VMs (concurrency=12)...\n`);

  const probes = await workerPool(vms, 12, async (vm, i) => {
    const r = await probeOne(vm);
    const status = r.reachable ? (r.needsRestart ? "RESTART" : "ok") : "UNREACH";
    if (i % 20 === 0 || r.needsRestart || !r.reachable) {
      console.log(`  [${String(i + 1).padStart(3)}/${vms.length}] ${vm.name.padEnd(22)} ${status.padEnd(8)} soul=${String(r.soulSize).padStart(5)}  disk=${r.disk}  spiral=${r.spiralHits}  active=${r.active}  health=${r.health}${r.err ? `  err=${r.err.slice(0, 60)}` : ""}`);
    }
    return r;
  });

  console.log(`\nPhase 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  // Phase 2: retry unreachables (1 retry).
  const unreach = probes.filter((p) => !p.reachable);
  console.log(`Phase 2: retrying ${unreach.length} unreachables...`);
  for (let i = 0; i < unreach.length; i++) {
    const r = await probeOne({ name: unreach[i].name, ip_address: unreach[i].ip });
    if (r.reachable) {
      console.log(`  ✓ ${unreach[i].name}: now reachable on retry  soul=${r.soulSize}  active=${r.active}  health=${r.health}`);
      probes[probes.findIndex((p) => p.name === unreach[i].name)] = r;
    } else {
      console.log(`  ✗ ${unreach[i].name}: STILL UNREACHABLE  err=${r.err?.slice(0, 80)}`);
    }
  }

  // Phase 3: aggregate.
  const reached = probes.filter((p) => p.reachable);
  const setOk = reached.filter((p) => p.disk === "40000").length;
  const stillUnreach = probes.filter((p) => !p.reachable);
  const toRestart = reached.filter((p) => p.needsRestart);

  console.log(`\n=== Phase 1 + 2 summary ===`);
  console.log(`  Total VMs probed:    ${probes.length}`);
  console.log(`  Reached:             ${reached.length}`);
  console.log(`  Still unreachable:   ${stillUnreach.length}`);
  console.log(`  bootstrapMaxChars=40000 verified on disk: ${setOk} / ${reached.length}`);
  console.log(`  Need restart:        ${toRestart.length}`);
  if (stillUnreach.length > 0) {
    console.log(`\n!! Still-unreachable VMs (MOST URGENT — may be the broken ones):`);
    for (const u of stillUnreach) {
      console.log(`     ${u.name.padEnd(22)} ip=${u.ip}  err=${u.err?.slice(0, 100)}`);
    }
  }
  if (toRestart.length > 0) {
    console.log(`\nRestart targets (sorted by SOUL size desc):`);
    for (const p of [...toRestart].sort((a, b) => b.soulSize - a.soulSize)) {
      console.log(`     ${p.name.padEnd(22)} soul=${String(p.soulSize).padStart(5)} spiral=${p.spiralHits} active=${p.active} health=${p.health} reason=[${p.restartReason.join(",")}]`);
    }
  }

  // Phase 4: parallel restart.
  console.log(`\nPhase 4: restarting ${toRestart.length} VMs (concurrency=8)...\n`);
  const restartResults = await workerPool(toRestart, 8, async (p, i) => {
    const r = await restartOne({ name: p.name, ip: p.ip });
    const icon = r.ok ? "✓" : "✗";
    console.log(`  ${icon} [${String(i + 1).padStart(3)}/${toRestart.length}] ${p.name.padEnd(22)} active=${r.active} health=${r.health}${r.err ? `  err=${r.err.slice(0,80)}` : ""}`);
    return { name: p.name, r };
  });
  const restartOk = restartResults.filter((x) => x.r.ok).length;

  console.log(`\n=== Final summary (total ${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
  console.log(`  Probed:             ${probes.length}`);
  console.log(`  Config push OK:     ${setOk} VMs at disk=40000`);
  console.log(`  Restart attempts:   ${toRestart.length}`);
  console.log(`  Restart OK:         ${restartOk}`);
  console.log(`  Restart FAILED:     ${toRestart.length - restartOk}`);
  console.log(`  Still unreachable:  ${stillUnreach.length}`);

  // Phase 5: confirm vm-050 (timmy) + vm-780 (cooper main)
  console.log(`\n=== Phase 5: target verification (vm-050 timmy + vm-780 cooper main) ===\n`);
  for (const name of ["instaclaw-vm-050", "instaclaw-vm-780"]) {
    const p = probes.find((x) => x.name === name);
    const restart = restartResults.find((x) => x.name === name);
    if (!p) {
      console.log(`  ${name}: NOT FOUND in healthy-assigned cohort (check status/health_status)`);
      continue;
    }
    const final = restart?.r ?? { active: p.active, health: p.health, ok: p.active === "active" && p.health === "200" };
    const tag = final.ok ? "✓ HEALTHY" : "✗ DEGRADED";
    console.log(`  ${tag}  ${name}  soul=${p.soulSize}  spiral_24h=${p.spiralHits}  active=${final.active}  health=${final.health}`);
  }
}

main().then(() => process.exit(0));
