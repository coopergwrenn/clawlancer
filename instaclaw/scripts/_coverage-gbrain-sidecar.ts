/**
 * _coverage-gbrain-sidecar.ts — fleet-wide HTTP-sidecar rollout coverage.
 *
 * Rule 27 — coverage queries should answer fleet-state questions in <10s.
 * This script answers: "what % of edge_city VMs are on the Rule 35 HTTP
 * sidecar architecture vs the legacy stdio architecture?"
 *
 * Mirrors the same probe shell the gbrain-coverage-check cron uses (after
 * the 2026-05-16 patch) so manual runs and cron runs report the same data.
 * Useful before flipping GBRAIN_COVERAGE_OPERATIONAL=true, before Esmeralda,
 * and as a manual canary check after any reconciler change that touches
 * stepGbrain.
 *
 * Read-only. No mutations. SSHes in parallel batches of 10.
 *
 * Usage:
 *   npx tsx scripts/_coverage-gbrain-sidecar.ts
 *   npx tsx scripts/_coverage-gbrain-sidecar.ts --partner consensus_2026
 *   npx tsx scripts/_coverage-gbrain-sidecar.ts --verbose          # per-VM table
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

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
  } catch { /* try next */ }
}

const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const args = process.argv.slice(2);
const partnerArg = args.includes("--partner") ? args[args.indexOf("--partner") + 1] : "edge_city";
const verbose = args.includes("--verbose");

// 2026-05-29: --exclude-vms / GBRAIN_COVERAGE_EXCLUDE_VMS — operator-known
// VMs to skip from the coverage sample. Use sparingly and document the
// reason out-of-band (e.g., privacy-bridge SSH-blocked VM whose gbrain
// state we can't verify but is healthy at the gateway layer). The env-var
// form is what scripts/_pre-bake-check.ts inherits when it shells out to
// this script; the CLI flag is for ad-hoc manual runs.
const excludeFlagIdx = args.indexOf("--exclude-vms");
const excludeVmsArg =
  excludeFlagIdx >= 0 ? args[excludeFlagIdx + 1] : process.env.GBRAIN_COVERAGE_EXCLUDE_VMS;
const EXCLUDE_VMS = new Set(
  (excludeVmsArg || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

type Arch = "http-sidecar" | "stdio" | "none" | "unknown";
type Status = "gbrained" | "missing_gbrain" | "missing_key" | "partial" | "ssh_err";

interface Probe {
  name: string;
  ip: string;
  version: string | null;
  transport: string;
  service: string;
  port: number;
  mcp: number;
  keyLen: number;
  architecture: Arch;
  status: Status;
  error?: string;
}

function ssh(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 10_000 });
  });
}

function exec(c: Client, cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let o = "";
    const tt = setTimeout(() => resolve(o + "\n[TIMEOUT]"), timeoutMs);
    c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); return resolve(`SSHERR: ${e.message}`); }
      s.on("data", (d: Buffer) => o += d.toString());
      s.stderr.on("data", (d: Buffer) => o += d.toString());
      s.on("close", () => { clearTimeout(tt); resolve(o); });
    });
  });
}

// Same probe shell as app/api/cron/gbrain-coverage-check/route.ts (post-2026-05-16 patch).
const PROBE_SHELL =
  'source ~/.nvm/nvm.sh 2>/dev/null; ' +
  'export PATH="$HOME/.bun/bin:/usr/sbin:/usr/bin:/bin:$PATH"; ' +
  'export XDG_RUNTIME_DIR="/run/user/$(id -u)" 2>/dev/null; ' +
  'V=$(gbrain --version 2>/dev/null | head -1 | grep -oE "[0-9]+(\\.[0-9]+)+"); ' +
  'T=$(jq -r ".mcp.servers.gbrain.transport // \\"absent\\"" "$HOME/.openclaw/openclaw.json" 2>/dev/null); ' +
  'S=$(systemctl --user is-active gbrain.service 2>/dev/null | head -1); ' +
  'P=$(ss -lnpt 2>/dev/null | grep -c "127\\.0\\.0\\.1:3131"); ' +
  'M=$(openclaw mcp show gbrain 2>/dev/null | grep -c "/home/openclaw/.bun/bin/gbrain"); ' +
  'K=$(grep "^GBRAIN_ANTHROPIC_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\' | wc -c); ' +
  'echo "GBRAIN_PROBE V=${V:-missing} T=${T:-absent} S=${S:-inactive} P=${P:-0} M=${M:-0} K=${K:-0}"';

async function probeOne(vm: { id: string; name: string; ip_address: string }): Promise<Probe> {
  const out: Probe = {
    name: vm.name,
    ip: vm.ip_address,
    version: null, transport: "absent", service: "inactive", port: 0, mcp: 0, keyLen: 0,
    architecture: "unknown", status: "ssh_err",
  };
  let c: Client | null = null;
  try {
    c = await ssh(vm.ip_address);
    const probeOut = await exec(c, PROBE_SHELL, 15_000);
    const line = probeOut.split("\n").find((l: string) => l.startsWith("GBRAIN_PROBE")) ?? "";
    const m = line.match(/V=(\S+) T=(\S+) S=(\S+) P=(\d+) M=(\d+) K=(\d+)/);
    if (!m) {
      out.error = `parse_fail: ${(probeOut || "").slice(0, 120)}`;
      return out;
    }
    out.version = m[1] === "missing" ? null : m[1];
    out.transport = m[2];
    out.service = m[3];
    out.port = parseInt(m[4], 10);
    out.mcp = parseInt(m[5], 10);
    out.keyLen = parseInt(m[6], 10);

    // Architecture detection (mirrors patched cron classification)
    const httpInstalled = out.transport === "streamable-http";
    const stdioInstalled = out.mcp > 0;
    if (httpInstalled && !stdioInstalled) out.architecture = "http-sidecar";
    else if (stdioInstalled && !httpInstalled) out.architecture = "stdio";
    else if (httpInstalled && stdioInstalled) out.architecture = "unknown"; // hybrid (shouldn't happen)
    else out.architecture = "none";

    const installed = !!out.version && (httpInstalled || stdioInstalled);
    if (installed) out.status = "gbrained";
    else if (out.keyLen <= 20) out.status = "missing_key";
    else if (!out.version && !httpInstalled && !stdioInstalled) out.status = "missing_gbrain";
    else out.status = "partial";
  } catch (e: any) {
    out.error = String(e?.message ?? e);
  } finally {
    try { c?.end(); } catch { /* ignore */ }
  }
  return out;
}

async function batched<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    const batch = items.slice(i, i + n);
    const r = await Promise.all(batch.map(fn));
    out.push(...r);
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log(`gbrain HTTP-sidecar coverage — partner=${partnerArg}`);
  console.log("─".repeat(70));

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id,name,ip_address,partner,health_status,status,config_version")
    .eq("partner", partnerArg)
    .eq("status", "assigned")
    .eq("health_status", "healthy");
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  const fleetPre = (vms ?? []).filter((v: any) => v.ip_address);
  const excluded = fleetPre.filter((v: any) => EXCLUDE_VMS.has(v.name)).map((v: any) => v.name);
  const fleet = fleetPre.filter((v: any) => !EXCLUDE_VMS.has(v.name));
  console.log(`Fleet: ${fleet.length} VMs (partner=${partnerArg}, assigned+healthy)`);
  if (excluded.length > 0) {
    console.log(`Excluded ${excluded.length} VM(s) per --exclude-vms / GBRAIN_COVERAGE_EXCLUDE_VMS: ${excluded.join(", ")}`);
  }
  if (fleet.length === 0) {
    console.log("No VMs to probe. Done.");
    return;
  }

  console.log("Probing in parallel batches of 10...\n");
  const probes = await batched(fleet, 10, probeOne);

  // Aggregate
  const archCounts: Record<Arch, number> = { "http-sidecar": 0, stdio: 0, none: 0, unknown: 0 };
  const statusCounts: Record<Status, number> = { gbrained: 0, missing_gbrain: 0, missing_key: 0, partial: 0, ssh_err: 0 };
  for (const p of probes) {
    statusCounts[p.status]++;
    if (p.status !== "ssh_err") archCounts[p.architecture]++;
  }

  const total = probes.length;
  const reachable = total - statusCounts.ssh_err;
  const httpPct = reachable === 0 ? 0 : Math.round((archCounts["http-sidecar"] / reachable) * 100);
  const stdioPct = reachable === 0 ? 0 : Math.round((archCounts.stdio / reachable) * 100);
  const gbrainedPct = total === 0 ? 0 : Math.round((statusCounts.gbrained / total) * 100);

  console.log("─── Status ───────────────────────────────────────────────────");
  console.log(`  gbrained       ${statusCounts.gbrained}/${total} (${gbrainedPct}%)`);
  console.log(`  partial        ${statusCounts.partial}`);
  console.log(`  missing_gbrain ${statusCounts.missing_gbrain}`);
  console.log(`  missing_key    ${statusCounts.missing_key}`);
  console.log(`  ssh_err        ${statusCounts.ssh_err}`);

  console.log("\n─── Architecture (excludes ssh_err) ──────────────────────────");
  console.log(`  http-sidecar (Rule 35)  ${archCounts["http-sidecar"]} (${httpPct}% of reachable)`);
  console.log(`  stdio (legacy)          ${archCounts.stdio} (${stdioPct}% of reachable)`);
  console.log(`  none                    ${archCounts.none}`);
  console.log(`  unknown (hybrid)        ${archCounts.unknown}`);

  if (verbose) {
    console.log("\n─── Per-VM detail ─────────────────────────────────────────────");
    console.log("  name              status       arch          V          T              S        P  M  K   notes");
    console.log("  " + "─".repeat(120));
    for (const p of probes.sort((a, b) => a.name.localeCompare(b.name))) {
      const v = (p.version ?? "—").padEnd(10);
      const t = p.transport.padEnd(14);
      const s = p.service.padEnd(8);
      const notes = p.error ? `err: ${p.error.slice(0, 50)}` : "";
      console.log(`  ${p.name.padEnd(18)}${p.status.padEnd(13)}${p.architecture.padEnd(14)}${v} ${t} ${s} ${String(p.port).padEnd(2)} ${String(p.mcp).padEnd(2)} ${String(p.keyLen).padEnd(3)} ${notes}`);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsedSec}s.`);

  // Operator hint: surface action items in priority order.
  const actionable = statusCounts.partial + statusCounts.missing_gbrain + statusCounts.missing_key;
  if (actionable > 0) {
    console.log(`\n⚠ ${actionable} VM(s) need attention. Re-run with --verbose for the per-VM table.`);
  }
  if (archCounts.stdio > 0) {
    console.log(`→ Rule 35 migration: ${archCounts.stdio} legacy stdio VM(s) pending migration to HTTP sidecar.`);
  }
  if (archCounts.none > 0) {
    console.log(`→ Fresh install: ${archCounts.none} VM(s) have no gbrain installed yet.`);
    console.log(`  Use: npx tsx scripts/_install-gbrain-on-vm.ts <vm-name>`);
  }
  if (archCounts.unknown > 0) {
    console.log(`⚠ Hybrid state: ${archCounts.unknown} VM(s) have BOTH stdio + HTTP configs. Investigate.`);
  }
  if (gbrainedPct === 100) {
    console.log(`\n✓ Full coverage (${gbrainedPct}%). Safe to flip GBRAIN_COVERAGE_OPERATIONAL=true and GBRAIN_DEEP_CHECK_ENABLED=true.`);
  } else if (httpPct >= 90 && archCounts.stdio === 0) {
    console.log(`\n✓ Rule 35 architecture rollout effectively complete (${httpPct}% of reachable on HTTP sidecar; ${actionable} VM(s) still need install).`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
