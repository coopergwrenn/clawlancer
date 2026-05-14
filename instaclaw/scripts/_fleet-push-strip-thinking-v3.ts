/**
 * One-shot fleet-push of strip-thinking.py to every (healthy, assigned) VM.
 *
 * Why: Rule 45 fix (eaf5617a, 2026-05-14) updated the embedded template in
 * `lib/ssh.ts:STRIP_THINKING_SCRIPT`, but the reconciler's `stepFiles` only
 * runs on VMs with `config_version < VM_MANIFEST.version`. VMs at cv=current
 * are excluded by the cron filter at `app/api/cron/reconcile-fleet/route.ts:272`
 * — they will NEVER receive a template-only change without either a manifest
 * bump or a fleet-push.
 *
 * Diagnostic from `_clean-disk-batch2.ts` confirmed 7/8 sampled VMs still had
 * the OLD strip-thinking.py. Without this push their disks WILL refill on the
 * next heavy session (Rule 45 / CLAUDE.md Root Cause 0).
 *
 * This script mirrors the canonical deploy logic from
 * `_deploy-strip-thinking-hotfix.ts` (2026-05-03):
 *   1. Import STRIP_THINKING_SCRIPT from lib/ssh.ts (single source of truth).
 *   2. Validate sentinels in-process BEFORE any SSH — refuse to ship if a
 *      load-bearing marker is missing (Rule 23 protection).
 *   3. Per VM:
 *      a. md5sum the current file — skip if already current (idempotent).
 *      b. Pre-flight disk check — skip if disk >97% (would ENOSPC).
 *      c. base64-decode to /tmp/strip-thinking-<vm.id>-<ts>.py.
 *      d. python3 -m py_compile syntax check.
 *      e. Sentinel grep on the new file.
 *      f. cp -p existing to .bak-<ts> (recoverable on regret).
 *      g. chmod +x; atomic mv into place.
 *      h. md5 verify post-write.
 *   4. Concurrency 5; waves of 20; per-VM hard timeout 60s.
 *
 * Safety:
 *   - Does NOT touch cv. The reconciler still owns cv bumps.
 *   - Does NOT touch any other file or service.
 *   - Does NOT restart the gateway. strip-thinking.py is invoked by per-minute
 *     cron; next tick picks up the new file naturally.
 *   - Skips disk-critical VMs (>97%) — they need disk cleanup first.
 *   - Backups left in place on EVERY VM (.bak-<ts>) for 7-day post-mortem.
 *   - Sentinel-validated pre-push and post-push.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()])
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Sentinel validation — refuse to ship a script that doesn't carry the
// fixes that justify the rollout. Each pair = one load-bearing fix.
const REQUIRED_SENTINELS = [
  // Rule 45 (eaf5617a) — session-backup runaway loop fix
  "SESSION_BACKUP_COOLDOWN_SEC", "SESSION_BACKUP_MAX_PER_SESSION",
  // Rule 22 (a495680d) — trim-not-nuke
  "def trim_failed_turns", "SESSION TRIMMED:",
  // 2026-05-03 periodic memory + pre-archive safety
  "def run_periodic_summary_hook", "PERIODIC_SUMMARY_V1",
  "PRE_ARCHIVE_SUMMARY_V1",
];
for (const s of REQUIRED_SENTINELS) {
  if (!STRIP_THINKING_SCRIPT.includes(s)) {
    console.error(`FATAL: STRIP_THINKING_SCRIPT is missing sentinel "${s}" — did you save lib/ssh.ts?`);
    process.exit(1);
  }
}

const SCRIPT = STRIP_THINKING_SCRIPT;
const SCRIPT_MD5 = createHash("md5").update(SCRIPT).digest("hex");
const SCRIPT_B64 = Buffer.from(SCRIPT, "utf-8").toString("base64");
const REMOTE_PATH = "$HOME/.openclaw/scripts/strip-thinking.py";

console.log(`STRIP_THINKING_SCRIPT: ${SCRIPT.length} bytes, md5=${SCRIPT_MD5}`);
console.log(`Sentinels OK (${REQUIRED_SENTINELS.length} markers verified)`);

type VM = { id: string; name: string; ip_address: string };
type PushResult = { ok: boolean; status: string; ms: number };

const TS = new Date().toISOString().replace(/[:.]/g, "-");

async function pushToVm(vm: VM): Promise<PushResult> {
  const start = Date.now();
  const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: "openclaw",
      privateKey: sshKey,
      readyTimeout: 15000,
    });
  } catch (e: any) {
    return { ok: false, status: `ssh-connect-fail: ${(e?.message || String(e)).slice(0, 80)}`, ms: Date.now() - start };
  }

  try {
    // Idempotency: skip if md5 already matches
    const cur = await ssh.execCommand(`md5sum ${REMOTE_PATH} 2>/dev/null | awk '{print $1}'`);
    if (cur.stdout.trim() === SCRIPT_MD5) {
      ssh.dispose();
      return { ok: true, status: "already-current", ms: Date.now() - start };
    }

    // Pre-flight: disk space (≥97% means even /tmp writes will likely ENOSPC)
    const diskRes = await ssh.execCommand(`df / | tail -1 | awk '{print $5}' | tr -d '%'`);
    const diskPct = parseInt(diskRes.stdout.trim(), 10);
    if (Number.isFinite(diskPct) && diskPct >= 97) {
      ssh.dispose();
      return { ok: false, status: `disk-too-full: ${diskPct}%`, ms: Date.now() - start };
    }

    // Atomic write: base64-decode to a per-VM tmp on the SAME filesystem as
    // destination (so the final mv is atomic on POSIX), then py_compile,
    // sentinel grep, backup, install.
    const tmpPath = `$HOME/.openclaw/scripts/.strip-thinking.py.new-${vm.id}-${TS}`;
    const bakPath = `${REMOTE_PATH}.bak-${TS}`;

    const cmd = `
set -eu
mkdir -p $HOME/.openclaw/scripts

# 1. Decode new content to tmp file in the destination directory.
echo '${SCRIPT_B64}' | base64 -d > "${tmpPath}"
chmod +x "${tmpPath}"

# 2. Syntax check (py_compile fails non-zero on parse error).
python3 -m py_compile "${tmpPath}"

# 3. Sentinel grep — abort if any expected marker is missing on disk.
grep -q 'SESSION_BACKUP_COOLDOWN_SEC' "${tmpPath}"
grep -q 'SESSION_BACKUP_MAX_PER_SESSION' "${tmpPath}"
grep -q 'def trim_failed_turns' "${tmpPath}"
grep -q 'SESSION TRIMMED:' "${tmpPath}"
grep -q 'PERIODIC_SUMMARY_V1' "${tmpPath}"

# 4. Backup current (if any).
if [ -f ${REMOTE_PATH} ]; then
  cp -p ${REMOTE_PATH} "${bakPath}"
fi

# 5. Atomic install (same filesystem → POSIX guarantees rename atomicity).
mv "${tmpPath}" ${REMOTE_PATH}

# 6. Post-write md5 verification (script side will compare to expected).
md5sum ${REMOTE_PATH} | awk '{print $1}'
`;
    const r = await ssh.execCommand(`bash -c '${cmd.replace(/'/g, "'\\''")}'`, { execOptions: { pty: false } });
    if (r.code !== 0) {
      ssh.dispose();
      return { ok: false, status: `deploy-failed code=${r.code}: ${r.stderr.slice(0, 120) || r.stdout.slice(-120)}`, ms: Date.now() - start };
    }

    // The final line of stdout is the md5 from step 6.
    const lines = r.stdout.trim().split("\n");
    const newMd5 = lines[lines.length - 1].trim();
    if (newMd5 !== SCRIPT_MD5) {
      ssh.dispose();
      return { ok: false, status: `md5-mismatch: expected ${SCRIPT_MD5.slice(0, 8)} got ${newMd5.slice(0, 8)}`, ms: Date.now() - start };
    }

    // Sentinel count verification (defense in depth — confirms grep above
    // would have caught anything but also surfaces hit count for telemetry).
    const sentinel = await ssh.execCommand(`grep -c SESSION_BACKUP_COOLDOWN_SEC ${REMOTE_PATH}`);
    const hits = parseInt(sentinel.stdout.trim(), 10) || 0;

    ssh.dispose();
    return { ok: true, status: `deployed (md5 ${newMd5.slice(0, 8)} sentinel-hits=${hits})`, ms: Date.now() - start };
  } catch (e: any) {
    try { ssh.dispose(); } catch {}
    return { ok: false, status: `exception: ${(e?.message || String(e)).slice(0, 120)}`, ms: Date.now() - start };
  }
}

async function pushToVmWithTimeout(vm: VM, timeoutMs: number): Promise<PushResult> {
  return Promise.race([
    pushToVm(vm),
    new Promise<PushResult>((resolve) =>
      setTimeout(() => resolve({ ok: false, status: `hard-timeout ${timeoutMs}ms`, ms: timeoutMs }), timeoutMs),
    ),
  ]);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const limit = (() => {
    const arg = argv.find((a) => a.startsWith("--limit="));
    return arg ? parseInt(arg.slice("--limit=".length), 10) : null;
  })();
  const onlyNamesArg = argv.find((a) => a.startsWith("--only="));
  const onlyNames = onlyNamesArg ? onlyNamesArg.slice("--only=".length).split(",") : null;

  let q = sb
    .from("instaclaw_vms")
    .select("id,name,ip_address")
    .eq("health_status", "healthy")
    .eq("status", "assigned");
  if (onlyNames) q = q.in("name", onlyNames);
  const { data: vmsRaw } = await q.order("name");
  let vms = (vmsRaw || []) as VM[];
  if (limit) vms = vms.slice(0, limit);

  console.log(`Target: ${vms.length} VMs${dryRun ? " (DRY RUN — no SSH)" : ""}`);
  if (dryRun) {
    for (const v of vms) console.log(`  ${v.name}  ${v.ip_address}`);
    return;
  }

  const concurrency = 5;
  const waveSize = 20;
  const perVmTimeoutMs = 60000;
  const results: { vm: VM; r: PushResult }[] = [];
  const t0 = Date.now();

  for (let waveStart = 0; waveStart < vms.length; waveStart += waveSize) {
    const wave = vms.slice(waveStart, waveStart + waveSize);
    console.log(`\n══ Wave ${Math.floor(waveStart / waveSize) + 1}/${Math.ceil(vms.length / waveSize)}: ${wave.length} VMs ══`);
    for (let i = 0; i < wave.length; i += concurrency) {
      const slice = wave.slice(i, i + concurrency);
      const sliceResults = await Promise.all(
        slice.map(async (vm) => {
          const r = await pushToVmWithTimeout(vm, perVmTimeoutMs);
          const tag = r.ok ? (r.status === "already-current" ? "≡" : "✓") : "✗";
          console.log(`  [${tag}] ${vm.name.padEnd(20)} ${String(r.ms).padStart(5)}ms  ${r.status}`);
          return { vm, r };
        }),
      );
      results.push(...sliceResults);
    }
  }

  // Summary
  const ok = results.filter((x) => x.r.ok);
  const fail = results.filter((x) => !x.r.ok);
  const already = results.filter((x) => x.r.status === "already-current");
  const deployedNew = ok.length - already.length;
  console.log(`\n${"═".repeat(60)}\n══ SUMMARY ══\n${"═".repeat(60)}`);
  console.log(`  Total: ${results.length}`);
  console.log(`  Deployed (new):  ${deployedNew}`);
  console.log(`  Already current: ${already.length}`);
  console.log(`  Failed:          ${fail.length}`);
  console.log(`  Wall-clock:      ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (fail.length) {
    console.log("\nFailures:");
    for (const x of fail) console.log(`  ${x.vm.name.padEnd(20)} ${x.r.status}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
