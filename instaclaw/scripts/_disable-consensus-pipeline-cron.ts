/**
 * Disable the consensus_match_pipeline.py cron on every healthy assigned VM.
 *
 * URGENT 2026-05-15: the Vercel CONSENSUS_INTRO_FLOW_ENABLED=false kill
 * switch blocks new XMTP outreach SENDS via the API reserve, but the
 * pipeline's own user-notify path (maybe_send_match_notification → Telegram
 * via ~/scripts/notify_user.sh) is NOT gated by the API kill switch. The
 * pipeline keeps running every 30min on each VM, finding matches, and
 * telling the OWNER about them — which reads as "5 connection requests in
 * 4 hours" from the owner's Telegram inbox.
 *
 * Solution: disable the cron line. Reversible — to re-enable, run
 * `_reenable-consensus-pipeline-cron.ts` or let the next reconcile cycle
 * re-install (assuming we don't ALSO disable in vm-manifest.ts).
 *
 * Safety:
 *  - --dry-run lists VMs that WOULD be touched; no SSH changes.
 *  - --test-vm <name> runs on a single VM, prints before+after crontab.
 *  - default mode: concurrency=3 across the fleet (CLAUDE.md fleet-ops rule).
 *  - Each VM does (crontab -l | grep -vF 'consensus_match_pipeline.py' | crontab -)
 *    which removes ONLY lines containing the marker. Idempotent. Other
 *    crons untouched.
 *  - Verifies remaining crontab does NOT contain the marker before
 *    reporting success.
 *
 * Usage:
 *   npx tsx scripts/_disable-consensus-pipeline-cron.ts --dry-run
 *   npx tsx scripts/_disable-consensus-pipeline-cron.ts --test-vm instaclaw-vm-050
 *   npx tsx scripts/_disable-consensus-pipeline-cron.ts        # fleet rollout
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
  status: "OK" | "ALREADY_DISABLED" | "VERIFY_FAILED" | "SSH_ERROR" | "SKIPPED";
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

  // Fleet selection: healthy assigned VMs only. Skip unassigned (no user
  // running the pipeline anyway), hibernating (won't get our cron change
  // until wake), and configure_failed (can't SSH reliably).
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

        // BEFORE: count current crontab lines + check marker presence
        const before = await ssh.execCommand(
          `crontab -l 2>/dev/null | tee /tmp/_crontab_before.txt | wc -l && grep -c '${MARKER}' /tmp/_crontab_before.txt 2>/dev/null || echo 0`,
        );
        const beforeLines = before.stdout.trim().split("\n");
        r.before_lines = parseInt(beforeLines[0], 10) || 0;
        const beforeMarkerCount = parseInt(beforeLines[1], 10) || 0;

        if (beforeMarkerCount === 0) {
          r.status = "ALREADY_DISABLED";
          r.detail = "marker not present in crontab";
          results.push(r);
          continue;
        }

        // ACTION: remove the marker line(s) from crontab
        const action = await ssh.execCommand(
          `(crontab -l 2>/dev/null | grep -vF '${MARKER}') | crontab -`,
        );
        if (action.code !== 0) {
          r.status = "SSH_ERROR";
          r.detail = `crontab write rc=${action.code} stderr=${action.stderr.slice(0, 150)}`;
          results.push(r);
          continue;
        }

        // VERIFY: re-read crontab and confirm marker absent
        const after = await ssh.execCommand(
          `crontab -l 2>/dev/null | tee /tmp/_crontab_after.txt | wc -l && grep -c '${MARKER}' /tmp/_crontab_after.txt 2>/dev/null || echo 0`,
        );
        const afterLines = after.stdout.trim().split("\n");
        r.after_lines = parseInt(afterLines[0], 10) || 0;
        const afterMarkerCount = parseInt(afterLines[1], 10) || 0;
        if (afterMarkerCount > 0) {
          r.status = "VERIFY_FAILED";
          r.detail = `marker still present (${afterMarkerCount}) after write`;
        } else {
          r.status = "OK";
        }
        results.push(r);

        // TEST_VM mode: show full crontab before+after for inspection
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

  // Summary
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log("\n=== Summary ===");
  console.log(JSON.stringify(counts, null, 2));

  // Detail dump for non-OK results
  const failures = results.filter((r) => r.status !== "OK" && r.status !== "ALREADY_DISABLED");
  if (failures.length > 0) {
    console.log("\n=== Failures (review and re-run targeted) ===");
    failures.forEach((r) => console.log(`  ${r.name}: ${r.status} ${r.detail || ""}`));
  }

  // Persist results JSON for forensic
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = `/tmp/_disable-consensus-pipeline-cron-${ts}.json`;
  writeFileSync(outFile, JSON.stringify({ counts, results }, null, 2));
  console.log(`\nresults file: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
