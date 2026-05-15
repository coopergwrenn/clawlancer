/**
 * Re-enable the consensus_match_pipeline.py cron on every healthy assigned VM.
 *
 * MIRROR OF: scripts/_disable-consensus-pipeline-cron.ts (2026-05-15).
 * BEFORE RUNNING: read docs/intent-matchmaking-reenable-runbook.md from
 * start to finish. The script alone is not a re-enable — the runbook has
 * 7 ordered prerequisites (retry-path bug fix, manifest un-comment, Vercel
 * env-var removal, redeploy, single-VM verification). Skipping any of them
 * re-creates the 2026-05-15 Timour-spam incident or worse (XMTP intros
 * going out while CONSENSUS_INTRO_FLOW_ENABLED=false is half-flipped).
 *
 * What this script does:
 *   - SSH each healthy assigned VM (concurrency=3 per CLAUDE.md rule)
 *   - If the marker `consensus_match_pipeline.py` is already in crontab,
 *     report ALREADY_ENABLED (idempotent — safe to re-run).
 *   - Else: append the exact cron line we removed on 2026-05-15:
 *       */30 * * * * python3 ~/.openclaw/scripts/consensus_match_pipeline.py >> /tmp/consensus_match.log 2>&1
 *   - Verify post-write that the marker is present, log OK or VERIFY_FAILED.
 *
 * The cron line is hardcoded here AND in vm-manifest.ts; both must agree.
 * If you change one, change the other.
 *
 * Safety modes:
 *   - --dry-run        list VMs that WOULD be touched; no SSH writes
 *   - --test-vm <name> run on a single VM; print before+after crontab
 *   - (default)        fleet rollout at concurrency=3
 *
 * Usage:
 *   npx tsx scripts/_reenable-consensus-pipeline-cron.ts --dry-run
 *   npx tsx scripts/_reenable-consensus-pipeline-cron.ts --test-vm instaclaw-vm-050
 *   npx tsx scripts/_reenable-consensus-pipeline-cron.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { NodeSSH } from "node-ssh";
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

const DRY_RUN = process.argv.includes("--dry-run");
const TEST_VM_ARG = process.argv.findIndex((a) => a === "--test-vm");
const TEST_VM = TEST_VM_ARG !== -1 ? process.argv[TEST_VM_ARG + 1] : null;
const CONCURRENCY = 3;
const MARKER = "consensus_match_pipeline.py";
// MUST match the cron entry in lib/vm-manifest.ts. If you change one,
// change the other. The reconciler installs from the manifest using the
// same base64-encode-via-stdin pattern below.
const CRON_LINE =
  "*/30 * * * * python3 ~/.openclaw/scripts/consensus_match_pipeline.py >> /tmp/consensus_match.log 2>&1";

type VmRow = {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_user: string | null;
  health_status: string;
  assigned_to: string | null;
};

type ResultRow = {
  name: string;
  status: "OK" | "ALREADY_ENABLED" | "VERIFY_FAILED" | "SSH_ERROR" | "SKIPPED";
  before_lines: number;
  after_lines: number;
  detail?: string;
};

async function main() {
  const sshKey = Buffer.from(
    process.env.SSH_PRIVATE_KEY_B64!,
    "base64",
  ).toString("utf-8");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  let q = sb
    .from("instaclaw_vms")
    .select("id,name,ip_address,ssh_user,health_status,assigned_to")
    .eq("health_status", "healthy")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null);
  if (TEST_VM) q = q.eq("name", TEST_VM);
  const { data: vms, error } = await q;
  if (error || !vms) {
    console.error("DB error", error);
    process.exit(1);
  }

  console.log(
    `mode=${DRY_RUN ? "DRY_RUN" : TEST_VM ? "TEST_VM" : "FLEET"} candidates=${vms.length} marker='${MARKER}'`,
  );
  if (DRY_RUN) {
    console.log("\nDry run — these VMs would be touched:");
    (vms as VmRow[]).slice(0, 20).forEach((v) => console.log(`  ${v.name} (${v.ip_address})`));
    if (vms.length > 20) console.log(`  ... and ${vms.length - 20} more`);
    return;
  }

  // Base64-encode the cron line to avoid shell-quoting issues with the
  // crontab heredoc pattern. Mirrors the reconciler's
  // `echo '${b64}' | base64 -d` install path in lib/ssh.ts.
  const cronB64 = Buffer.from(CRON_LINE + "\n").toString("base64");

  const results: ResultRow[] = [];
  let idx = 0;

  async function worker() {
    while (idx < vms.length) {
      const myIdx = idx++;
      const vm = vms[myIdx] as VmRow;
      const r: ResultRow = {
        name: vm.name,
        status: "SSH_ERROR",
        before_lines: 0,
        after_lines: 0,
      };
      const ssh = new NodeSSH();
      try {
        await ssh.connect({
          host: vm.ip_address!,
          username: vm.ssh_user || "openclaw",
          privateKey: sshKey,
          readyTimeout: 10000,
        });

        // BEFORE: count crontab lines + check marker presence
        const before = await ssh.execCommand(
          `crontab -l 2>/dev/null | tee /tmp/_crontab_before.txt | wc -l && grep -c '${MARKER}' /tmp/_crontab_before.txt 2>/dev/null || echo 0`,
        );
        const beforeLines = before.stdout.trim().split("\n");
        r.before_lines = parseInt(beforeLines[0], 10) || 0;
        const beforeMarkerCount = parseInt(beforeLines[1], 10) || 0;

        if (beforeMarkerCount > 0) {
          // Idempotent — already installed. Don't append a duplicate.
          r.status = "ALREADY_ENABLED";
          r.detail = `marker present (${beforeMarkerCount})`;
          results.push(r);
          continue;
        }

        // ACTION: append the cron line (preserves all existing entries)
        const action = await ssh.execCommand(
          `(crontab -l 2>/dev/null; echo '${cronB64}' | base64 -d) | crontab -`,
        );
        if (action.code !== 0) {
          r.status = "SSH_ERROR";
          r.detail = `crontab write rc=${action.code} stderr=${action.stderr.slice(0, 150)}`;
          results.push(r);
          continue;
        }

        // VERIFY: re-read crontab and confirm marker present
        const after = await ssh.execCommand(
          `crontab -l 2>/dev/null | tee /tmp/_crontab_after.txt | wc -l && grep -c '${MARKER}' /tmp/_crontab_after.txt 2>/dev/null || echo 0`,
        );
        const afterLines = after.stdout.trim().split("\n");
        r.after_lines = parseInt(afterLines[0], 10) || 0;
        const afterMarkerCount = parseInt(afterLines[1], 10) || 0;
        if (afterMarkerCount === 0) {
          r.status = "VERIFY_FAILED";
          r.detail = "marker still absent after append";
        } else {
          r.status = "OK";
        }
        results.push(r);

        if (TEST_VM) {
          const beforeFull = await ssh.execCommand(`cat /tmp/_crontab_before.txt`);
          const afterFull = await ssh.execCommand(`cat /tmp/_crontab_after.txt`);
          console.log("\n----- BEFORE crontab -----");
          console.log(beforeFull.stdout);
          console.log("----- AFTER crontab -----");
          console.log(afterFull.stdout);
        }
      } catch (e: any) {
        r.detail = `ssh exception: ${e?.message?.slice(0, 200) || String(e).slice(0, 200)}`;
        results.push(r);
      } finally {
        ssh.dispose();
      }
      process.stderr.write(`${myIdx + 1}/${vms.length} ${vm.name} → ${r.status}\n`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log("\n=== Summary ===");
  console.log(JSON.stringify(counts, null, 2));

  const failures = results.filter((r) => r.status !== "OK" && r.status !== "ALREADY_ENABLED");
  if (failures.length > 0) {
    console.log("\n=== Failures (review and re-run targeted) ===");
    failures.forEach((r) => console.log(`  ${r.name}: ${r.status} ${r.detail || ""}`));
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = `/tmp/_reenable-consensus-pipeline-cron-${ts}.json`;
  writeFileSync(outFile, JSON.stringify({ counts, results }, null, 2));
  console.log(`\nresults file: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
