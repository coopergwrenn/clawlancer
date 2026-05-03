/**
 * P1 audit: confirm or refute the "MEMORY_FILING_SYSTEM is truncated" theory.
 *
 * Hypothesis: SOUL.md exceeds bootstrapMaxChars (30,000). The agent's bootstrap
 * context cuts the tail. The memory-writing instructions live in
 * SOUL_MD_MEMORY_FILING_SYSTEM which is concatenated LAST. So the agent
 * literally never sees "write a session-log.md summary at end of conversation"
 * — and consequently never does it. Even users with months of activity have
 * empty session-log.md / active-tasks.md, so when sessions DO legitimately
 * rotate (200KB size cap, true crash loops), they lose everything.
 *
 * What we measure across the healthy fleet:
 *   1. SOUL.md byte size — is it really over 30K?
 *   2. Does MEMORY_FILING_SYSTEM marker appear in the file? Where (offset)?
 *      If offset > 30000, the section is truncated out of bootstrap.
 *   3. session-log.md size — is it just the template (~few hundred bytes)
 *      or has the agent written to it (>2KB suggests real content)?
 *   4. active-tasks.md size — same.
 *   5. MEMORY.md size — different file, different purpose, but worth tracking.
 *
 * Output: per-VM table + summary stats. Read-only — no writes anywhere.
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

const CONCURRENCY = 10;
const PER_VM_DEADLINE_MS = 25_000;
const BOOTSTRAP_MAX_CHARS = 30_000;
// Empirical thresholds — template files are ~few-hundred-byte boilerplate;
// real content moves the file well past that.
const SESSION_LOG_TEMPLATE_MAX = 1_200;
const ACTIVE_TASKS_TEMPLATE_MAX = 1_200;

interface Sample {
  vm: string;
  ip: string;
  status: "ok" | "ssh_fail" | "timeout";
  reason?: string;
  soulSize?: number;
  soulOverCap?: boolean;
  memoryFilingOffset?: number; // byte offset where "MEMORY FILING SYSTEM" header starts
  memoryFilingTruncated?: boolean; // offset > 30000
  sessionLogSize?: number;
  sessionLogIsTemplate?: boolean;
  activeTasksSize?: number;
  activeTasksIsTemplate?: boolean;
  memoryMdSize?: number;
}

async function fetchVMs() {
  const { data } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .is("frozen_at", null)
    .is("lifecycle_locked_at", null)
    .not("ip_address", "is", null)
    .not("gateway_token", "is", null)
    .order("name");
  return data || [];
}

async function probeVM(vm: { id: string; name: string; ip_address: string; ssh_user: string | null }): Promise<Sample> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: vm.ssh_user || "openclaw",
      privateKey: sshKey,
      readyTimeout: 10_000,
    });
  } catch (e) {
    return { vm: vm.name, ip: vm.ip_address, status: "ssh_fail", reason: (e as Error).message.slice(0, 80) };
  }
  try {
    // Combined probe — single round-trip, all measurements in one shell call.
    const r = await ssh.execCommand(`
SOUL=$HOME/.openclaw/workspace/SOUL.md
SLOG=$HOME/.openclaw/workspace/memory/session-log.md
ATASK=$HOME/.openclaw/workspace/memory/active-tasks.md
MMD=$HOME/.openclaw/workspace/MEMORY.md
SOULSZ=$(wc -c < "$SOUL" 2>/dev/null || echo 0)
SLOGSZ=$(wc -c < "$SLOG" 2>/dev/null || echo 0)
ATASKSZ=$(wc -c < "$ATASK" 2>/dev/null || echo 0)
MMDSZ=$(wc -c < "$MMD" 2>/dev/null || echo 0)
# Locate "## Memory" / "MEMORY FILING SYSTEM" header in SOUL.md and report byte offset.
# Try a few sentinel patterns the manifest uses for the memory section.
MOFFSET=$(grep -bn -m 1 -E "MEMORY FILING SYSTEM|## .* Memory|MEMORY_FILING_SYSTEM" "$SOUL" 2>/dev/null | head -1 | cut -d: -f1)
[ -z "$MOFFSET" ] && MOFFSET=-1
echo "SOUL=$SOULSZ MFOFFSET=$MOFFSET SLOG=$SLOGSZ ATASK=$ATASKSZ MMD=$MMDSZ"
    `, { execOptions: { pty: false } });
    const stdout = (r.stdout || "").trim();
    const m = stdout.match(/SOUL=(\d+) MFOFFSET=(-?\d+) SLOG=(\d+) ATASK=(\d+) MMD=(\d+)/);
    if (!m) {
      return { vm: vm.name, ip: vm.ip_address, status: "timeout", reason: `unexpected output: ${stdout.slice(0, 80)}` };
    }
    const [, soulStr, mfStr, slogStr, atStr, mmdStr] = m;
    const soulSize = parseInt(soulStr, 10);
    const mfOffset = parseInt(mfStr, 10);
    const slogSize = parseInt(slogStr, 10);
    const atSize = parseInt(atStr, 10);
    const mmdSize = parseInt(mmdStr, 10);
    return {
      vm: vm.name,
      ip: vm.ip_address,
      status: "ok",
      soulSize,
      soulOverCap: soulSize > BOOTSTRAP_MAX_CHARS,
      memoryFilingOffset: mfOffset,
      memoryFilingTruncated: mfOffset >= 0 && mfOffset > BOOTSTRAP_MAX_CHARS,
      sessionLogSize: slogSize,
      sessionLogIsTemplate: slogSize <= SESSION_LOG_TEMPLATE_MAX,
      activeTasksSize: atSize,
      activeTasksIsTemplate: atSize <= ACTIVE_TASKS_TEMPLATE_MAX,
      memoryMdSize: mmdSize,
    };
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
}

async function withDeadline<T>(fn: () => Promise<T>, ms: number): Promise<{ ok: true; v: T } | { ok: false; reason: string }> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const dl = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); });
  try {
    const v = await Promise.race([fn(), dl]);
    return { ok: true, v };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (t) clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const vms = await fetchVMs();
  console.log(`Surveying ${vms.length} healthy assigned linode VMs (concurrency=${CONCURRENCY})…\n`);

  const samples: Sample[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= vms.length) return;
      const vm = vms[idx];
      const r = await withDeadline(() => probeVM(vm), PER_VM_DEADLINE_MS);
      const sample: Sample = r.ok ? r.v : { vm: vm.name, ip: vm.ip_address, status: "timeout", reason: r.reason };
      samples.push(sample);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  samples.sort((a, b) => a.vm.localeCompare(b.vm));

  // ── Summary stats ──
  const ok = samples.filter((s) => s.status === "ok");
  const fail = samples.filter((s) => s.status !== "ok");
  console.log(`Probed ${samples.length}. Reachable: ${ok.length}. SSH/timeout fails: ${fail.length}\n`);

  if (ok.length === 0) {
    console.log("No reachable VMs — abort.");
    return;
  }

  const overCap = ok.filter((s) => s.soulOverCap);
  const memTrunc = ok.filter((s) => s.memoryFilingTruncated);
  const memHasOffset = ok.filter((s) => (s.memoryFilingOffset ?? -1) > 0);
  const slogEmpty = ok.filter((s) => s.sessionLogIsTemplate);
  const atEmpty = ok.filter((s) => s.activeTasksIsTemplate);
  const bothEmpty = ok.filter((s) => s.sessionLogIsTemplate && s.activeTasksIsTemplate);

  console.log("══ SOUL.md size distribution ══");
  console.log(`  total reachable:         ${ok.length}`);
  console.log(`  over bootstrap cap (>30000): ${overCap.length} / ${ok.length} (${(100 * overCap.length / ok.length).toFixed(0)}%)`);
  if (overCap.length > 0) {
    const sizes = overCap.map((s) => s.soulSize!).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    const max = sizes[sizes.length - 1];
    console.log(`  among over-cap: median=${median}, max=${max}, min=${sizes[0]}`);
  }

  console.log("\n══ Memory-filing section position ══");
  console.log(`  VMs where MEMORY_FILING marker found in SOUL.md: ${memHasOffset.length} / ${ok.length}`);
  console.log(`  VMs where the marker is past the 30K cap (TRUNCATED OUT OF BOOTSTRAP): ${memTrunc.length} / ${ok.length}`);
  if (memHasOffset.length > 0) {
    const offsets = memHasOffset.map((s) => s.memoryFilingOffset!).sort((a, b) => a - b);
    const median = offsets[Math.floor(offsets.length / 2)];
    console.log(`  marker offset distribution: min=${offsets[0]}, median=${median}, max=${offsets[offsets.length - 1]}`);
  }

  console.log("\n══ Cross-session memory file emptiness ══");
  console.log(`  session-log.md is template-only (≤${SESSION_LOG_TEMPLATE_MAX} bytes): ${slogEmpty.length} / ${ok.length} (${(100 * slogEmpty.length / ok.length).toFixed(0)}%)`);
  console.log(`  active-tasks.md is template-only (≤${ACTIVE_TASKS_TEMPLATE_MAX} bytes): ${atEmpty.length} / ${ok.length} (${(100 * atEmpty.length / ok.length).toFixed(0)}%)`);
  console.log(`  BOTH empty (cross-session memory effectively non-functional): ${bothEmpty.length} / ${ok.length} (${(100 * bothEmpty.length / ok.length).toFixed(0)}%)`);

  // The smoking gun: are the VMs with empty memory the same VMs where MEMORY_FILING is truncated?
  console.log("\n══ Cross-tab: empty-memory ↔ truncated-instructions ══");
  const emptyAndTrunc = bothEmpty.filter((s) => s.memoryFilingTruncated).length;
  const emptyButNotTrunc = bothEmpty.filter((s) => !s.memoryFilingTruncated).length;
  const populatedButTrunc = ok.filter((s) => s.memoryFilingTruncated && !(s.sessionLogIsTemplate && s.activeTasksIsTemplate)).length;
  console.log(`  empty memory + truncated instructions:  ${emptyAndTrunc}  ← supports theory`);
  console.log(`  empty memory + instructions reachable:  ${emptyButNotTrunc}  ← LLM-compliance issue (separate bug)`);
  console.log(`  memory populated DESPITE truncated instr: ${populatedButTrunc}  ← agents that figured it out anyway`);

  console.log("\n══ MEMORY.md sizes (non-bootstrapped — agent reads on demand) ══");
  const mmdNonEmpty = ok.filter((s) => (s.memoryMdSize ?? 0) > 1500);
  console.log(`  MEMORY.md > 1500 bytes (real content): ${mmdNonEmpty.length} / ${ok.length}`);

  // ── Per-VM table (top 25, mostly the over-cap ones) ──
  console.log("\n══ Per-VM detail (first 25 over-cap VMs by SOUL size, descending) ══");
  const sortedOverCap = [...overCap].sort((a, b) => (b.soulSize ?? 0) - (a.soulSize ?? 0)).slice(0, 25);
  console.log("  vm                   soul   over   mfOff  trunc  slog  at   mmd");
  for (const s of sortedOverCap) {
    const truncFlag = s.memoryFilingTruncated ? "YES" : "no ";
    const slogTpl = s.sessionLogIsTemplate ? "T" : `${s.sessionLogSize}`;
    const atTpl = s.activeTasksIsTemplate ? "T" : `${s.activeTasksSize}`;
    console.log(
      `  ${s.vm.padEnd(20)} ${String(s.soulSize ?? 0).padStart(5)}  +${String((s.soulSize ?? 0) - BOOTSTRAP_MAX_CHARS).padStart(4)}  ${String(s.memoryFilingOffset ?? -1).padStart(5)}  ${truncFlag}    ${slogTpl.padEnd(4)}  ${atTpl.padEnd(4)}  ${s.memoryMdSize ?? 0}`,
    );
  }

  if (fail.length > 0) {
    console.log(`\n══ Probe failures (${fail.length}) ══`);
    for (const f of fail.slice(0, 8)) console.log(`  ${f.vm.padEnd(20)} ${f.ip.padEnd(16)} ${f.status}: ${f.reason}`);
  }
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
