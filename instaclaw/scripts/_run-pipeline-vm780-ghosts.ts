/**
 * Run the matchpool pipeline on vm-780 once, against the seeded ghost
 * pool. Validates the demo flow end-to-end and leaves real deliberation
 * rationale in matchpool_deliberations + matchpool_cached_top3 for the
 * /consensus/my-matches page to render.
 *
 * Pre-conditions (verify before running):
 *   - vm-780 has a matchpool_profile (run _test-match-pipeline-vm780.ts
 *     first if absent — it POSTs a hand-crafted profile)
 *   - Ghost pool seeded (npx tsx scripts/_seed-consensus-ghost-pool.ts)
 *
 * Output:
 *   - Telemetry on stdout/stderr from the pipeline
 *   - DB rows visible in matchpool_cached_top3 + matchpool_deliberations
 *     for vm-780's user
 *   - /consensus/my-matches page (logged in as vm-780's owner) shows
 *     the top 3 matches with full agent rationale
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

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

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: vm } = await sb
    .from("instaclaw_vms")
    .select("assigned_to")
    .eq("name", "instaclaw-vm-780")
    .single();
  const userId = vm!.assigned_to as string;
  console.log(`vm-780 user: ${userId}`);

  // Wipe prior cached_top3/deliberations so we see a fresh write
  await sb.from("matchpool_cached_top3").delete().eq("user_id", userId);
  await sb.from("matchpool_deliberations").delete().eq("user_id", userId);
  console.log("cleared prior cached_top3 + deliberations");

  // Verify ghost pool size
  const { count: ghostCount } = await sb
    .from("matchpool_profiles")
    .select("user_id", { count: "exact", head: true })
    .eq("partner", "consensus-ghost");
  console.log(`ghost pool size: ${ghostCount}`);
  if (!ghostCount || ghostCount === 0) {
    console.error("FATAL: no ghosts in pool. Run _seed-consensus-ghost-pool.ts first.");
    process.exit(2);
  }

  const ssh = new NodeSSH();
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12000 });

  console.log("\n── Upload pipeline scripts ──");
  for (const name of ["consensus_match_pipeline.py", "consensus_match_rerank.py", "consensus_match_deliberate.py"]) {
    await ssh.putFile(`/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/${name}`, `/tmp/${name}`);
  }
  console.log("  ✓ uploaded");

  // Clear state file from prior runs
  await ssh.execCommand("rm -f ~/.openclaw/.consensus_match_state.json ~/.openclaw/.consensus_match.lock");

  console.log("\n── Run pipeline (--force --no-jitter) ──");
  const start = Date.now();
  const r = await ssh.execCommand("cd /tmp && python3 consensus_match_pipeline.py --force --no-jitter");
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  latency: ${elapsed}s`);
  console.log(`  exit: ${r.code}`);
  console.log(`  telemetry:\n${r.stderr.split("\n").map((l) => "    " + l).join("\n")}`);
  console.log(`  stdout: ${r.stdout.trim()}`);

  // Cleanup uploaded scripts
  await ssh.execCommand(
    "rm -f /tmp/consensus_match_pipeline.py /tmp/consensus_match_rerank.py /tmp/consensus_match_deliberate.py"
  );
  ssh.dispose();

  console.log("\n── Verify DB ──");
  const { data: cached } = await sb
    .from("matchpool_cached_top3")
    .select("top3_user_ids, top3_scores, computed_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!cached) {
    console.log("  ✗ no cached_top3 row");
  } else {
    console.log(`  ✓ cached_top3 has ${cached.top3_user_ids?.length ?? 0} entries`);
    console.log(`    computed_at: ${cached.computed_at}`);
  }

  const { data: delibs } = await sb
    .from("matchpool_deliberations")
    .select("candidate_user_id, match_score, rationale, conversation_topic, meeting_window, skip_reason")
    .eq("user_id", userId)
    .order("match_score", { ascending: false });

  if (delibs && delibs.length > 0) {
    console.log(`\n── Deliberations (${delibs.length} rows) ──`);
    for (const d of delibs) {
      // Resolve agent_id for friendly display
      const { data: cand } = await sb
        .from("matchpool_profiles")
        .select("agent_id")
        .eq("user_id", d.candidate_user_id as string)
        .single();
      const label = cand?.agent_id ?? (d.candidate_user_id as string).slice(0, 12);
      const score = Number(d.match_score).toFixed(2);
      console.log(`\n  ${label}  score=${score}`);
      console.log(`    rationale: ${(d.rationale as string).slice(0, 250)}`);
      if (d.conversation_topic) console.log(`    topic:     ${(d.conversation_topic as string).slice(0, 200)}`);
      if (d.meeting_window) console.log(`    window:    ${(d.meeting_window as string).slice(0, 100)}`);
      if (d.skip_reason) console.log(`    skip:      ${(d.skip_reason as string).slice(0, 150)}`);
    }
  } else {
    console.log("  ✗ no deliberations");
  }

  console.log(`\n══ Visit https://instaclaw.io/consensus/my-matches as the vm-780 owner to see the rendered page ══`);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  process.exit(1);
});
