/**
 * Post-deploy audit of the cross-session memory fix.
 *
 * Per Cooper's spec:
 *   1. Sample 10 random healthy VMs — verify:
 *      - strip-thinking.py has all 5 sentinels
 *      - openclaw.json bootstrapMaxChars=35000
 *      - MEMORY_FILING_SYSTEM section is visible within bootstrap (offset
 *        below 35K cap)
 *      - no errors in /tmp/session-summary-error.log
 *
 *   2. Doug's vm-725 specifically — same checks + state file integrity.
 *
 *   3. All 5 edge_city VMs (vm-780, 354, 771, 859, 050) — same checks.
 *      These are the Consensus demo VMs; they must be perfect.
 *
 * The 2-hour follow-up audit (did periodic summary actually fire on real
 * user activity?) runs as a separate script after a soak period.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

interface Probe {
  vm: string;
  ip: string;
  reachable: boolean;
  reason?: string;
  sentinelCount: number;          // 5 = all present
  bootstrapMaxChars: string;
  soulSize: number;
  memoryFilingOffset: number;     // -1 if not found
  memoryFilingVisibleInBootstrap: boolean;
  errorLogLines: number;
  errorLogTail: string;
}

async function probe(ip: string, vmName: string, sshUser = "openclaw"): Promise<Probe> {
  const out: Probe = {
    vm: vmName, ip, reachable: false,
    sentinelCount: 0, bootstrapMaxChars: "(unknown)",
    soulSize: 0, memoryFilingOffset: -1, memoryFilingVisibleInBootstrap: false,
    errorLogLines: 0, errorLogTail: "",
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, username: sshUser, privateKey: sshKey, readyTimeout: 10_000 });
  } catch (e) {
    out.reason = (e as Error).message.slice(0, 80);
    return out;
  }
  out.reachable = true;
  try {
    const r = await ssh.execCommand(`
SOUL=$HOME/.openclaw/workspace/SOUL.md
STRIP=$HOME/.openclaw/scripts/strip-thinking.py
CFG=$HOME/.openclaw/openclaw.json
ERR=/tmp/session-summary-error.log

SENT=$(grep -cE 'def trim_failed_turns|SESSION TRIMMED:|def run_periodic_summary_hook|PERIODIC_SUMMARY_V1|PRE_ARCHIVE_SUMMARY_V1' "$STRIP")
BMC=$(python3 -c "import json; c=json.load(open('$CFG')); print(c.get('agents',{}).get('defaults',{}).get('bootstrapMaxChars','(unset)'))")
SOULSZ=$(wc -c < "$SOUL")
# Find offset of MEMORY_FILING_SYSTEM_V1 marker (the actual filing-system section,
# not the generic "Memory Persistence" header).
MFOFFSET=$(grep -bn -m 1 'MEMORY_FILING_SYSTEM_V1' "$SOUL" | head -1 | cut -d: -f1)
[ -z "$MFOFFSET" ] && MFOFFSET=-1
ERRLINES=$(wc -l < "$ERR" 2>/dev/null || echo 0)
ERRTAIL=$(tail -3 "$ERR" 2>/dev/null | tr '\\n' ';' | head -c 200)
echo "SENT=$SENT BMC=$BMC SOULSZ=$SOULSZ MFOFFSET=$MFOFFSET ERRLINES=$ERRLINES ERRTAIL=$ERRTAIL"
`, { execOptions: { pty: false } });

    const m = r.stdout.match(/SENT=(\d+) BMC=(\S+) SOULSZ=(\d+) MFOFFSET=(-?\d+) ERRLINES=(\d+) ERRTAIL=(.*)/);
    if (m) {
      out.sentinelCount = parseInt(m[1], 10);
      out.bootstrapMaxChars = m[2];
      out.soulSize = parseInt(m[3], 10);
      out.memoryFilingOffset = parseInt(m[4], 10);
      const cap = parseInt(out.bootstrapMaxChars, 10) || 30000;
      out.memoryFilingVisibleInBootstrap = out.memoryFilingOffset >= 0 && out.memoryFilingOffset < cap;
      out.errorLogLines = parseInt(m[5], 10);
      out.errorLogTail = m[6].trim();
    } else {
      out.reason = `unexpected stdout: ${r.stdout.slice(0, 120)}`;
    }
  } catch (e) {
    out.reason = (e as Error).message.slice(0, 100);
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
  return out;
}

function pad(s: string | number, n: number): string { return String(s).padEnd(n); }

function row(p: Probe): string {
  const sent = `${p.sentinelCount}/5`;
  const status = !p.reachable ? "UNREACHABLE" :
    p.sentinelCount === 5 && p.bootstrapMaxChars === "35000" && p.memoryFilingVisibleInBootstrap && p.errorLogLines === 0 ? "OK" :
    "ATTN";
  return `  ${pad(p.vm, 22)} ${pad(p.ip, 16)} ${pad(status, 12)} sent=${pad(sent, 4)} bmc=${pad(p.bootstrapMaxChars, 7)} soul=${pad(p.soulSize, 6)} mfOff=${pad(p.memoryFilingOffset, 6)} mfVis=${pad(p.memoryFilingVisibleInBootstrap, 5)} err=${p.errorLogLines}`;
}

async function main(): Promise<void> {
  // Cohort A: random sample of 10 healthy VMs
  const { data: all } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null);
  const vms = (all || []).map((v) => ({ name: v.name as string, ip: v.ip_address as string, ssh_user: (v.ssh_user as string) || "openclaw" }));
  const shuffled = [...vms].sort(() => Math.random() - 0.5);
  const sampleA = shuffled.slice(0, 10);

  // Cohort B: Doug
  const dougIp = "104.237.151.95";

  // Cohort C: 5 edge_city VMs (the consensus demo set)
  const edgeCityIps = ["104.237.151.95", "172.104.24.165", "104.237.151.26", "66.228.45.219", "172.239.36.76"];
  const edgeNames = ["vm-780-cooper", "vm-354-timour", "vm-771-seref", "vm-859-katherine", "vm-050-coopgwrenn"];

  console.log("══ Cohort A: 10 random healthy VMs ══");
  console.log(`  ${pad("name", 22)} ${pad("ip", 16)} ${pad("status", 12)} sent     bmc       soul     mfOff     mfVis  err`);
  const aResults: Probe[] = [];
  for (const v of sampleA) {
    const p = await probe(v.ip, v.name, v.ssh_user);
    aResults.push(p);
    console.log(row(p));
  }

  console.log("\n══ Cohort B: Doug (vm-725) ══");
  console.log(row(await probe(dougIp, "vm-725-doug")));

  console.log("\n══ Cohort C: 5 edge_city VMs (consensus demo set) ══");
  const cResults: Probe[] = [];
  for (let i = 0; i < edgeCityIps.length; i++) {
    const p = await probe(edgeCityIps[i], edgeNames[i]);
    cResults.push(p);
    console.log(row(p));
  }

  // Summary
  const allResults = [...aResults, ...cResults];
  const okCount = allResults.filter((p) => p.reachable && p.sentinelCount === 5 && p.bootstrapMaxChars === "35000" && p.memoryFilingVisibleInBootstrap && p.errorLogLines === 0).length;
  console.log(`\n══ SUMMARY ══`);
  console.log(`  reachable:                          ${allResults.filter(p => p.reachable).length}/${allResults.length}`);
  console.log(`  all 5 sentinels present:            ${allResults.filter(p => p.sentinelCount === 5).length}/${allResults.length}`);
  console.log(`  bootstrapMaxChars=35000:            ${allResults.filter(p => p.bootstrapMaxChars === "35000").length}/${allResults.length}`);
  console.log(`  MEMORY_FILING visible in bootstrap: ${allResults.filter(p => p.memoryFilingVisibleInBootstrap).length}/${allResults.length}`);
  console.log(`  zero errors in summary log:         ${allResults.filter(p => p.errorLogLines === 0).length}/${allResults.length}`);
  console.log(`  ALL CHECKS PASSED:                  ${okCount}/${allResults.length}`);

  // Surface any concerning lines
  const erroring = allResults.filter((p) => p.errorLogLines > 0);
  if (erroring.length) {
    console.log(`\nVMs with summary-log errors:`);
    for (const p of erroring) console.log(`  ${p.vm} (${p.ip}): ${p.errorLogLines} lines, tail: ${p.errorLogTail}`);
  }
}

main().catch((e) => { console.error(`FATAL: ${(e as Error).message}`); process.exit(1); });
