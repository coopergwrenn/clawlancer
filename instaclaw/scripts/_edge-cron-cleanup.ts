/**
 * E1 one-shot cleanup for the 9 edge_city VMs.
 *
 * Three idempotent actions per VM:
 *
 *   1. Plant `~/.openclaw/workspace/.no-digest` — kills the legacy
 *      daily-digest cron's send path (dispatch-scripts.ts:daily-digest.sh
 *      checks for this file as its first line and exits cleanly).
 *      The legacy digest at 8am LOCAL TZ collided with the new edge
 *      morning-brief at 9am PT, sent a $-mentioning credit-metrics
 *      message that was wrong for sponsor-funded Edge attendees, and
 *      attached a desktop screenshot (intrusive). Replaced fully by
 *      /api/cron/edge-morning-brief (E2 commit f5b03f06).
 *
 *   2. Strip any legacy `daily-news-briefing` OR `digest-scheduler` cron
 *      line. These exist on vm-050 + vm-354 only (legacy from older
 *      provisioning); other edge VMs are clean on this axis.
 *      daily-news-briefing.sh script file doesn't even exist anymore —
 *      cron fires, script not found, no-op. Clean up the dead line.
 *
 *   3. Dedup `edge-esmeralda` and `consensus-2026` git-pull crons —
 *      every edge_city VM has 2-4 identical copies of these. ff-only
 *      is idempotent so functionally harmless, but it's a real
 *      Rule-36-class silent-failure pile-up (the configureOpenClaw
 *      install path's dedup filter wasn't always there, so older
 *      invocations added unfiltered). Keep the FIRST line of each,
 *      drop the rest.
 *
 * Per-VM safety:
 *   - Backup crontab to ~/cron-backups/edge-cleanup-<ts>.crontab BEFORE
 *     any mutation. Recovery path is `crontab ~/cron-backups/<ts>.crontab`.
 *   - Atomic rewrite via `... | crontab -` (single-shot replace).
 *   - Verify post-rewrite: re-read crontab, assert dupe count = 0 + 1
 *     each, legacy lines gone, marker file present.
 *   - Skip cleanly with structured reason if SSH unreachable (no error
 *     for vm-866-class flaky VMs).
 *
 * Idempotent. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/_edge-cron-cleanup.ts --dry-run   # report only
 *   npx tsx scripts/_edge-cron-cleanup.ts             # actually apply
 *
 * Exits 0 if all VMs end in a clean state; non-zero otherwise.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { connectSSH } from "../lib/ssh";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
  health_status: string | null;
  status: string | null;
}

interface VmResult {
  vm: string;
  ip: string;
  status:
    | "cleaned"
    | "already-clean"
    | "ssh-failed"
    | "rewrite-failed"
    | "verify-failed"
    | "exception";
  before: { digestLegacy: number; edgePullDupes: number; consensusPullDupes: number; hasMarker: boolean };
  after?: { digestLegacy: number; edgePullDupes: number; consensusPullDupes: number; hasMarker: boolean };
  detail?: string;
}

/**
 * Bash one-liner that mutates crontab atomically per the spec above.
 * Returns the OLD crontab via `tee` so we can capture it for the backup.
 *
 * Notes on the awk pattern:
 *   - $0 ~ "skills/edge-esmeralda" matches the canonical path
 *   - && $0 ~ "git pull" requires it to be a pull line (not, say, a
 *     `cd skills/edge-esmeralda` from a different cron)
 *   - First match captured, rest skipped (`next`)
 *   - At END, the captured first lines are re-emitted
 *
 * The two `grep -v` filters run BEFORE awk so the digest-related lines
 * never reach the dedup pass.
 */
const CLEANUP_SCRIPT = `
set -e
mkdir -p ~/cron-backups ~/.openclaw/workspace

# 1. Plant the marker (touch is idempotent)
touch ~/.openclaw/workspace/.no-digest

# 2 + 3. Backup current crontab, then rewrite with stripped + deduped form.
crontab -l 2>/dev/null > ~/cron-backups/edge-cleanup-$(date +%s).crontab || echo '' > ~/cron-backups/edge-cleanup-$(date +%s).crontab

crontab -l 2>/dev/null \\
  | grep -v "daily-news-briefing" \\
  | grep -v "digest-scheduler" \\
  | awk '
      BEGIN { seen1=0; seen2=0 }
      $0 ~ "skills/edge-esmeralda" && $0 ~ "git pull" {
        if (!seen1) { first1=$0; seen1=1 }
        next
      }
      $0 ~ "skills/consensus-2026" && $0 ~ "git pull" {
        if (!seen2) { first2=$0; seen2=1 }
        next
      }
      { print }
      END {
        if (seen1) print first1
        if (seen2) print first2
      }
    ' \\
  | crontab -
`;

const PROBE_SCRIPT = `
echo "DIGEST_LEGACY=$(crontab -l 2>/dev/null | grep -cE 'daily-news-briefing|digest-scheduler' || echo 0)"
echo "EDGE_PULL_COUNT=$(crontab -l 2>/dev/null | grep -cE 'skills/edge-esmeralda.*git pull' || echo 0)"
echo "CONSENSUS_PULL_COUNT=$(crontab -l 2>/dev/null | grep -cE 'skills/consensus-2026.*git pull' || echo 0)"
echo -n "MARKER="; if [ -f ~/.openclaw/workspace/.no-digest ]; then echo "yes"; else echo "no"; fi
`;

function parseProbe(output: string): {
  digestLegacy: number;
  edgePullCount: number;
  consensusPullCount: number;
  hasMarker: boolean;
} {
  const lines = output.split("\n");
  const get = (key: string): string =>
    lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? "";
  return {
    digestLegacy: parseInt(get("DIGEST_LEGACY"), 10) || 0,
    edgePullCount: parseInt(get("EDGE_PULL_COUNT"), 10) || 0,
    consensusPullCount: parseInt(get("CONSENSUS_PULL_COUNT"), 10) || 0,
    hasMarker: get("MARKER") === "yes",
  };
}

async function cleanupOne(vm: VmRow, dryRun: boolean): Promise<VmResult> {
  if (!vm.ip_address) {
    return {
      vm: vm.name,
      ip: "?",
      status: "ssh-failed",
      before: { digestLegacy: 0, edgePullDupes: 0, consensusPullDupes: 0, hasMarker: false },
      detail: "no ip_address in DB",
    };
  }

  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (err) {
    return {
      vm: vm.name,
      ip: vm.ip_address,
      status: "ssh-failed",
      before: { digestLegacy: 0, edgePullDupes: 0, consensusPullDupes: 0, hasMarker: false },
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }

  try {
    // Pre-probe
    const preRaw = (await ssh.execCommand(PROBE_SCRIPT)).stdout;
    const pre = parseProbe(preRaw);
    const before = {
      digestLegacy: pre.digestLegacy,
      edgePullDupes: Math.max(0, pre.edgePullCount - 1),
      consensusPullDupes: Math.max(0, pre.consensusPullCount - 1),
      hasMarker: pre.hasMarker,
    };

    const isClean =
      before.digestLegacy === 0 &&
      before.edgePullDupes === 0 &&
      before.consensusPullDupes === 0 &&
      before.hasMarker;

    if (isClean) {
      return { vm: vm.name, ip: vm.ip_address, status: "already-clean", before };
    }

    if (dryRun) {
      return {
        vm: vm.name,
        ip: vm.ip_address,
        status: "cleaned",
        before,
        detail: "[dry-run] would clean",
      };
    }

    // Mutate
    const cleanup = await ssh.execCommand(CLEANUP_SCRIPT);
    if (cleanup.code !== 0) {
      return {
        vm: vm.name,
        ip: vm.ip_address,
        status: "rewrite-failed",
        before,
        detail: (cleanup.stderr || cleanup.stdout).slice(0, 200),
      };
    }

    // Post-probe (verify)
    const postRaw = (await ssh.execCommand(PROBE_SCRIPT)).stdout;
    const post = parseProbe(postRaw);
    const after = {
      digestLegacy: post.digestLegacy,
      edgePullDupes: Math.max(0, post.edgePullCount - 1),
      consensusPullDupes: Math.max(0, post.consensusPullCount - 1),
      hasMarker: post.hasMarker,
    };

    const verifiedClean =
      after.digestLegacy === 0 &&
      after.edgePullDupes === 0 &&
      after.consensusPullDupes === 0 &&
      after.hasMarker;

    if (!verifiedClean) {
      return {
        vm: vm.name,
        ip: vm.ip_address,
        status: "verify-failed",
        before,
        after,
        detail: `post-rewrite still dirty: digestLegacy=${after.digestLegacy} edgeDupes=${after.edgePullDupes} consensusDupes=${after.consensusPullDupes} marker=${after.hasMarker}`,
      };
    }

    return { vm: vm.name, ip: vm.ip_address, status: "cleaned", before, after };
  } catch (err) {
    return {
      vm: vm.name,
      ip: vm.ip_address,
      status: "exception",
      before: { digestLegacy: 0, edgePullDupes: 0, consensusPullDupes: 0, hasMarker: false },
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("partner", "edge_city")
    .eq("status", "assigned")
    .order("name");
  if (error) {
    console.error("supabase err:", error.message);
    process.exit(2);
  }

  const fleet = (vms ?? []) as VmRow[];
  console.log(`Targets: ${fleet.length} edge_city VMs (assigned)`);
  console.log(`Mode:    ${dryRun ? "DRY-RUN (no changes)" : "LIVE (mutating)"}`);
  console.log("");
  console.log(
    "vm".padEnd(22) +
      "ip".padEnd(18) +
      "status".padEnd(18) +
      "before(legacy/edgeDupes/consDupes/marker) → after",
  );
  console.log("─".repeat(110));

  const results: VmResult[] = [];
  for (const vm of fleet) {
    process.stdout.write(`${vm.name.padEnd(22)}${(vm.ip_address ?? "?").padEnd(18)}`);
    const r = await cleanupOne(vm, dryRun);
    results.push(r);
    const beforeStr = `${r.before.digestLegacy}/${r.before.edgePullDupes}/${r.before.consensusPullDupes}/${r.before.hasMarker ? "Y" : "N"}`;
    const afterStr = r.after
      ? `${r.after.digestLegacy}/${r.after.edgePullDupes}/${r.after.consensusPullDupes}/${r.after.hasMarker ? "Y" : "N"}`
      : "—";
    console.log(
      `${r.status.padEnd(18)}${beforeStr.padEnd(20)} → ${afterStr}${r.detail ? `  (${r.detail.slice(0, 80)})` : ""}`,
    );
  }

  console.log("");
  console.log("─".repeat(110));
  const cleaned = results.filter((r) => r.status === "cleaned").length;
  const alreadyClean = results.filter((r) => r.status === "already-clean").length;
  const failed = results.filter(
    (r) =>
      r.status === "ssh-failed" ||
      r.status === "rewrite-failed" ||
      r.status === "verify-failed" ||
      r.status === "exception",
  ).length;
  console.log(
    `SUMMARY: cleaned=${cleaned} already-clean=${alreadyClean} failed=${failed}${dryRun ? " (dry-run)" : ""}`,
  );

  if (failed > 0) {
    console.log("");
    console.log("FAILURES:");
    for (const r of results.filter(
      (r) =>
        r.status === "ssh-failed" ||
        r.status === "rewrite-failed" ||
        r.status === "verify-failed" ||
        r.status === "exception",
    )) {
      console.log(`  ${r.vm} (${r.ip}): ${r.status} — ${r.detail}`);
    }
    process.exit(1);
  }

  console.log("All VMs in clean state.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(99);
});
