/**
 * Fleet-wide watchdog disable — REMOVES silence-watchdog, vm-watchdog,
 * and openclaw-config-watchdog cron entries from every healthy assigned VM.
 *
 * == Why ==
 *
 * silence-watchdog.py (SILENCE_THRESHOLD_SEC=60) is killing gateways
 * mid-LLM-call on every gpt-5.5 cold-start signup. Per Phase 1 diagnosis
 * 2026-05-23: it's the actual root cause of "agent reacts emoji but
 * never responds" on chatgpt_oauth VMs. The 60s threshold predates
 * v113's 41-skill SOUL.md cold-start budget (60-90s for first message).
 *
 * vm-watchdog.py also has restart_gateway() paths that can fire on
 * healthy VMs during cold-start (despite the recent 120s
 * GATEWAY_STARTUP_GRACE_SEC bump — still can flag agent-stale and
 * restart). Per Cooper's 2026-05-23 directive: kill it too.
 *
 * openclaw-config-watchdog (sudo, every 5min) restores openclaw.json
 * from backup when corrupt + restarts gateway. Per Cooper's directive:
 * kill this too. (Operator note: this removes corruption recovery —
 * if openclaw.json gets nuked on a VM, no auto-restore.)
 *
 * Per CLAUDE.md P1-10, these crons were SUPPOSED to be disabled
 * fleet-wide via the 2026-05-01 SSH push, but several VMs (vm-892
 * audit + vm-1016 today) still have them active. This script catches
 * the stragglers AND provides Cooper instant relief on vm-1016 for
 * tonight's Edge testing.
 *
 * == Mechanism ==
 *
 * For each VM in the target list:
 *   1. Pull current crontab
 *   2. Remove any lines matching any of the markers (silence-watchdog.py,
 *      vm-watchdog.py, openclaw-config-watchdog)
 *   3. Install the modified crontab
 *   4. Verify the modified crontab no longer contains the markers
 *
 * Idempotent: if a VM already has the crons removed, the script no-ops
 * cleanly. Safe to re-run.
 *
 * Doesn't delete the script files (~/.openclaw/scripts/silence-watchdog.py
 * etc.) — leaves them on disk so we can re-enable via manual cron edit
 * if needed for emergency.
 *
 * == Usage ==
 *
 * Dry-run all healthy+assigned VMs:
 *   npx tsx scripts/_fleet-disable-watchdogs.ts
 *
 * Apply to ONE specific VM (use during canary):
 *   npx tsx scripts/_fleet-disable-watchdogs.ts --apply --only=instaclaw-vm-1016
 *
 * Apply to all healthy+assigned VMs (after canary verifies):
 *   npx tsx scripts/_fleet-disable-watchdogs.ts --apply
 *
 * == Companion ==
 *
 * Permanent fix lives in lib/vm-manifest.ts:cronJobsRemove[] + stepCronJobs
 * extension (shipped in companion commit). The fleet-push is the
 * fast-path for existing VMs; the manifest is the steady-state contract.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* file missing — fine for some environments */
  }
}

const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").replace(
  "--only=",
  "",
);

const MARKERS = [
  "silence-watchdog.py",
  "vm-watchdog.py",
  "openclaw-config-watchdog",
];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function processVm(vm: {
  id: string;
  name: string;
  ip_address: string;
}): Promise<{ ok: boolean; removed: number; detail: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      port: 22,
      username: "openclaw",
      privateKey: Buffer.from(
        process.env.SSH_PRIVATE_KEY_B64 ?? "",
        "base64",
      ).toString("utf-8"),
      readyTimeout: 8000,
    });

    const crontab = await ssh.execCommand("crontab -l 2>/dev/null");
    if (!crontab.stdout && crontab.code !== 0) {
      return {
        ok: false,
        removed: 0,
        detail: "crontab -l returned no output",
      };
    }
    const before = crontab.stdout;
    const lines = before.split("\n");
    const after = lines.filter(
      (l) => !MARKERS.some((m) => l.includes(m)),
    );
    const removed = lines.length - after.length;

    if (removed === 0) {
      ssh.dispose();
      return {
        ok: true,
        removed: 0,
        detail: "already clean (no marker matches)",
      };
    }

    if (!APPLY) {
      ssh.dispose();
      return {
        ok: true,
        removed,
        detail: `DRY-RUN: would remove ${removed} lines`,
      };
    }

    // Install via stdin to crontab so we don't have to manage a tmp file.
    // The `-` arg tells crontab to read from stdin. crontab REQUIRES a
    // trailing newline before EOF or it rejects the install. Guarantee one.
    const newCrontab = after.join("\n").replace(/\n*$/, "\n");
    const installRes = await ssh.execCommand("crontab -", {
      stdin: newCrontab,
    });
    if (installRes.code !== 0) {
      ssh.dispose();
      return {
        ok: false,
        removed: 0,
        detail: `crontab install failed: ${installRes.stderr.slice(0, 200)}`,
      };
    }

    // Verify
    const verify = await ssh.execCommand("crontab -l 2>/dev/null");
    const stillPresent = MARKERS.filter((m) => verify.stdout.includes(m));
    ssh.dispose();
    if (stillPresent.length > 0) {
      return {
        ok: false,
        removed,
        detail: `verify FAILED — still present: ${stillPresent.join(",")}`,
      };
    }
    return { ok: true, removed, detail: "OK + verified" };
  } catch (err) {
    try {
      ssh.dispose();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      removed: 0,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

async function main() {
  console.log(`\n${APPLY ? "🔥 APPLYING" : "🧐 DRY-RUN"} watchdog disable`);
  console.log(`Markers to remove: ${MARKERS.join(", ")}`);
  console.log(`Target: ${ONLY ? ONLY : "all healthy+assigned VMs"}\n`);

  let query = sb
    .from("instaclaw_vms")
    .select("id, name, ip_address")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("ip_address", "is", null);
  if (ONLY) query = query.eq("name", ONLY);
  const { data: vms, error } = await query;
  if (error || !vms) {
    console.error("VM query failed:", error?.message);
    process.exit(1);
  }
  console.log(`Found ${vms.length} target VM(s)\n`);

  // Concurrency: 5 at a time (matches snapshot bake convention; gentle on
  // SSH connections + Supabase capacity).
  const CONCURRENCY = 5;
  let totalRemoved = 0;
  let totalOk = 0;
  let totalFail = 0;
  const failures: { name: string; detail: string }[] = [];

  for (let i = 0; i < vms.length; i += CONCURRENCY) {
    const batch = vms.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((vm) =>
        processVm(vm as { id: string; name: string; ip_address: string }),
      ),
    );
    batch.forEach((vm, idx) => {
      const r = results[idx];
      const status = r.ok ? "✓" : "✗";
      console.log(
        `  ${status} ${vm.name.padEnd(20)} removed=${r.removed} ${r.detail}`,
      );
      if (r.ok) {
        totalOk++;
        totalRemoved += r.removed;
      } else {
        totalFail++;
        failures.push({ name: vm.name, detail: r.detail });
      }
    });
  }

  console.log(`\n=== Summary ===`);
  console.log(`  total VMs:       ${vms.length}`);
  console.log(`  successful:      ${totalOk}`);
  console.log(`  failed:          ${totalFail}`);
  console.log(`  cron lines removed: ${totalRemoved}`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures)
      console.log(`    ${f.name}: ${f.detail.slice(0, 120)}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
