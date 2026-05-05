/**
 * 2-hour soak audit: did the periodic_summary path in strip-thinking.py
 * actually fire on the fleet after the 2026-05-02 hotfix?
 *
 * The fix (Layer 2 of the cross-session memory work) is supposed to
 * inject a USER_FACTS / SESSION_LOG block into MEMORY.md or
 * session-log.md every 2 hours of conversational activity. If it
 * never fires, users who churn through long sessions silently lose
 * context across rotations even with the trim-not-nuke fix.
 *
 * Evidence we look for, per VM:
 *   1. ~/.openclaw/workspace/memory/session-log.md > 0 bytes
 *   2. ~/.openclaw/workspace/memory/active-tasks.md > 0 bytes
 *   3. MEMORY.md mtime within last 24h (proxy for "recently mutated by
 *      the cron, not just initial template")
 *   4. journalctl strip-thinking.py output mentions "periodic_summary"
 *      or "USER_FACTS" or "session_log" in the last 24h.
 *
 * Sample size: 30 random healthy assigned VMs. We don't audit the
 * full fleet because:
 *   - The cron runs every minute on every VM; sample is sufficient
 *   - SSH per-VM is slow (~3s); 200+ VMs = >10 min wall time
 *   - The question is "does it fire on a representative slice?",
 *     not "exhaustive enumeration"
 *
 * Output: per-VM YES/NO/PARTIAL row, plus a final ratio.
 *   YES     = at least one of {session-log non-empty, MEMORY.md
 *              recently mutated, journal mentions periodic_summary}
 *   PARTIAL = some signals present but session-log + active-tasks
 *              both empty (means the cron logic ran but didn't
 *              actually populate the files — investigate)
 *   NO      = no evidence the cron has fired at all
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

interface Result {
  name: string;
  session_log_bytes: number;
  active_tasks_bytes: number;
  memory_mtime_age_hours: number | null;
  journal_periodic_lines: number;
  classification: "YES" | "PARTIAL" | "NO" | "ERROR";
  detail?: string;
}

async function auditVM(vm: { name: string; ip_address: string; ssh_user: string | null }): Promise<Result> {
  const result: Result = {
    name: vm.name,
    session_log_bytes: 0,
    active_tasks_bytes: 0,
    memory_mtime_age_hours: null,
    journal_periodic_lines: 0,
    classification: "ERROR",
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: vm.ssh_user || "openclaw",
      privateKey: sshKey,
      readyTimeout: 10000,
    });

    const r = await ssh.execCommand(`
      sl=$(stat -c %s ~/.openclaw/workspace/memory/session-log.md 2>/dev/null || echo 0)
      at=$(stat -c %s ~/.openclaw/workspace/memory/active-tasks.md 2>/dev/null || echo 0)
      mm=$(stat -c %Y ~/.openclaw/workspace/MEMORY.md 2>/dev/null || echo 0)
      jp=$(journalctl --user --since="24 hours ago" 2>/dev/null | grep -cE "periodic_summary|USER_FACTS|session_log" || echo 0)
      now=$(date +%s)
      echo "sl=$sl at=$at mm_age_s=$((now - mm)) jp=$jp"
    `);
    const m = r.stdout.match(/sl=(\d+) at=(\d+) mm_age_s=(\d+) jp=(\d+)/);
    if (!m) {
      result.detail = `parse failed: ${r.stdout.slice(0, 100)}`;
      return result;
    }
    result.session_log_bytes = parseInt(m[1], 10);
    result.active_tasks_bytes = parseInt(m[2], 10);
    const ageS = parseInt(m[3], 10);
    result.memory_mtime_age_hours = ageS > 0 ? ageS / 3600 : null;
    result.journal_periodic_lines = parseInt(m[4], 10);

    const recentMutated = result.memory_mtime_age_hours !== null && result.memory_mtime_age_hours < 24;
    const hasContent = result.session_log_bytes > 0 || result.active_tasks_bytes > 0;
    const hasJournalSignal = result.journal_periodic_lines > 0;

    if (hasContent || hasJournalSignal) {
      result.classification = "YES";
    } else if (recentMutated) {
      result.classification = "PARTIAL";
      result.detail = "MEMORY.md recently mutated but no session-log/active-tasks content";
    } else {
      result.classification = "NO";
    }
    return result;
  } catch (e) {
    result.detail = e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100);
    return result;
  } finally {
    ssh.dispose();
  }
}

async function main() {
  console.log("══ Soak audit: periodic_summary / cross-session memory ══\n");

  // Sample 30 healthy assigned VMs at random — same script vs whole
  // fleet is the question, not exhaustive enumeration.
  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .eq("health_status", "healthy")
    .not("assigned_to", "is", null)
    .order("name");
  if (error) throw new Error(`vm query: ${error.message}`);
  if (!vms || vms.length === 0) {
    console.log("No healthy assigned VMs found.");
    process.exit(0);
  }

  const SAMPLE_SIZE = 30;
  // Deterministic spread: take every Nth row across the sorted list.
  const stride = Math.max(1, Math.floor(vms.length / SAMPLE_SIZE));
  const sample: typeof vms = [];
  for (let i = 0; i < vms.length && sample.length < SAMPLE_SIZE; i += stride) {
    sample.push(vms[i]);
  }
  console.log(`Sampling ${sample.length} of ${vms.length} healthy assigned VMs (stride=${stride})\n`);

  const CONCURRENCY = 5;
  const results: Result[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < sample.length) {
      const i = cursor++;
      const vm = sample[i];
      const r = await auditVM(vm as { name: string; ip_address: string; ssh_user: string | null });
      const tag =
        r.classification === "YES" ? "✓"
        : r.classification === "PARTIAL" ? "·"
        : r.classification === "NO" ? "✗"
        : "?";
      console.log(
        `  ${tag} ${r.name.padEnd(22)} sl=${String(r.session_log_bytes).padStart(5)}b at=${String(r.active_tasks_bytes).padStart(4)}b memory_age=${(r.memory_mtime_age_hours || -1).toFixed(1)}h journal_lines=${r.journal_periodic_lines}${r.detail ? ` (${r.detail.slice(0, 70)})` : ""}`,
      );
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const yes = results.filter((r) => r.classification === "YES").length;
  const partial = results.filter((r) => r.classification === "PARTIAL").length;
  const no = results.filter((r) => r.classification === "NO").length;
  const err = results.filter((r) => r.classification === "ERROR").length;

  console.log(`\n══ ${yes} YES, ${partial} PARTIAL, ${no} NO, ${err} ERROR ══`);
  console.log(`fire rate: ${((yes / Math.max(1, results.length - err)) * 100).toFixed(0)}% of evaluable VMs`);

  if (no > 0) {
    console.log("\nNO candidates (no evidence of periodic_summary firing):");
    for (const r of results.filter((rr) => rr.classification === "NO")) {
      console.log(`  ${r.name}`);
    }
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
