/**
 * Canary the PERIODIC_SUMMARY_V1_RESHRINK fix on vm-725 (Doug — has the bug
 * right now, last_periodic_msg_count=48 / current msgs=18, new_msgs=-30).
 *
 * Steps:
 *   1. Push the new strip-thinking.py from lib/ssh.ts STRIP_THINKING_SCRIPT.
 *   2. Verify all 6 sentinels (5 existing + new RESHRINK).
 *   3. Wait up to 90s for the per-minute cron to fire.
 *   4. Read journalctl for "PERIODIC_SUMMARY_V1_RESHRINK" log line.
 *   5. Read the state file and confirm last_periodic_msg_count was rebaseline'd.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

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

const TARGET_VM = process.env.CANARY_VM || "instaclaw-vm-725";

const REQUIRED_SENTINELS = [
  "def trim_failed_turns",
  "SESSION TRIMMED:",
  "def run_periodic_summary_hook",
  "PERIODIC_SUMMARY_V1",
  "PRE_ARCHIVE_SUMMARY_V1",
  "PERIODIC_SUMMARY_V1_RESHRINK",
];

async function main() {
  // Sentinel-grep the local in-memory script first (Rule 23 spirit)
  for (const s of REQUIRED_SENTINELS) {
    if (!STRIP_THINKING_SCRIPT.includes(s)) {
      console.error(`FATAL: in-memory STRIP_THINKING_SCRIPT missing sentinel "${s}". Aborting.`);
      process.exit(1);
    }
  }
  console.log(`✓ all ${REQUIRED_SENTINELS.length} sentinels present in in-memory script (${STRIP_THINKING_SCRIPT.length} chars)`);

  const { data, error } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .eq("name", TARGET_VM)
    .single();
  if (error || !data) { console.error("DB:", error?.message); process.exit(1); }
  const v = data as { name: string; ip_address: string; ssh_user: string };
  console.log(`Target: ${v.name}  ${v.ip_address}`);

  const ssh = new NodeSSH();
  await ssh.connect({ host: v.ip_address, username: v.ssh_user || "openclaw", privateKey: sshKey, readyTimeout: 12_000 });

  // Read pre-state
  const pre = await ssh.execCommand(`cat ~/.openclaw/.session-summary-state.json 2>/dev/null`);
  console.log(`pre-state: ${pre.stdout.trim() || "(missing)"}`);

  // Upload new script (salted tmp path per Rule 23 detection)
  const tmpPath = `/tmp/strip-thinking-${Date.now()}-${process.pid}.py`;
  await ssh.execCommand(`cat > ${tmpPath} << 'STRIPEOF'
${STRIP_THINKING_SCRIPT}
STRIPEOF`);

  // Verify sentinels on the uploaded file
  for (const s of REQUIRED_SENTINELS) {
    const r = await ssh.execCommand(`grep -F -q '${s}' ${tmpPath} && echo OK || echo MISSING`);
    if (!r.stdout.includes("OK")) {
      console.error(`FATAL: uploaded file missing sentinel "${s}"`);
      ssh.dispose();
      process.exit(1);
    }
  }
  console.log("✓ all sentinels present in uploaded file");

  // Atomic move into place
  await ssh.execCommand(`chmod +x ${tmpPath} && mv ${tmpPath} ~/.openclaw/scripts/strip-thinking.py`);
  const sz = await ssh.execCommand(`stat -c %s ~/.openclaw/scripts/strip-thinking.py`);
  console.log(`✓ deployed strip-thinking.py (${sz.stdout.trim()} bytes)`);

  // Wait for cron tick (per-minute) — give it up to 100s
  console.log("\nwaiting for cron tick (up to 100s)...");
  let foundReshrink = false;
  let foundOther = "";
  const start = Date.now();
  while (Date.now() - start < 100_000) {
    await new Promise((r) => setTimeout(r, 5_000));
    const log = await ssh.execCommand(`journalctl --user -u openclaw-gateway --since '2 minutes ago' --no-pager 2>/dev/null | grep -E 'PERIODIC_SUMMARY_V1' | tail -10`);
    if (log.stdout.includes("PERIODIC_SUMMARY_V1_RESHRINK")) {
      foundReshrink = true;
      foundOther = log.stdout.trim();
      break;
    }
    if (log.stdout.trim()) {
      foundOther = log.stdout.trim();
    }
  }

  if (foundReshrink) {
    console.log("\n✅ FIX WORKING — PERIODIC_SUMMARY_V1_RESHRINK fired:");
    console.log(foundOther);
  } else if (foundOther) {
    console.log("\n⚠️  saw OTHER PERIODIC_SUMMARY events (no reshrink, but hook is firing):");
    console.log(foundOther);
  } else {
    console.log("\n⚠️  no PERIODIC_SUMMARY_V1 log lines in 100s window");
  }

  // Read post-state
  const post = await ssh.execCommand(`cat ~/.openclaw/.session-summary-state.json 2>/dev/null`);
  console.log(`\npost-state: ${post.stdout.trim()}`);

  // Confirm if last_periodic_msg_count was rebaselined
  try {
    const preObj = JSON.parse(pre.stdout || "{}");
    const postObj = JSON.parse(post.stdout || "{}");
    const preCount = preObj.last_periodic_msg_count;
    const postCount = postObj.last_periodic_msg_count;
    console.log(`last_periodic_msg_count: ${preCount} -> ${postCount}`);
    if (preCount !== postCount) {
      console.log(`✓ count was REBASELINED (delta = ${(postCount as number) - (preCount as number)})`);
    } else {
      console.log(`(unchanged — may not have ticked yet, or session no longer shrunk)`);
    }
  } catch (e) {
    console.log(`state parse error: ${(e as Error).message}`);
  }

  ssh.dispose();
}
main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
