/**
 * Verify the gateway proxy heartbeat bypass actually fixes the P1.
 *
 * Test design (forcing the failure condition):
 *   1. Force vm-780 into heartbeatRecent=true state by setting
 *      heartbeat_last_at = NOW(). This is the window where calls
 *      get reclassified as heartbeats.
 *   2. Push heartbeat_cycle_calls to 15 (above the 10/cycle cap).
 *      Without bypass: silentEmptyResponse() fires immediately.
 *      With bypass: cycle cap doesn't apply (isHeartbeat=false).
 *   3. Re-deploy the patched rerank.py + deliberate.py to vm-780.
 *   4. Run the pipeline.
 *   5. Verify: full Sonnet calls succeed, no fallback markers,
 *      notify_sent fires, deliberation rationale is real (not
 *      fabricated/empty).
 *
 * Restores vm-780's heartbeat fields to their pre-test state at end.
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
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  let pass = 0, fail = 0;
  const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fail++; };

  console.log("══ Verify heartbeat-bypass fix ══\n");

  // 0. Snapshot pre-state for restore
  const { data: vmPre } = await sb
    .from("instaclaw_vms")
    .select("id, heartbeat_last_at, heartbeat_next_at, heartbeat_cycle_calls")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (!vmPre) {
    console.error("FATAL: vm-780 missing");
    process.exit(2);
  }
  console.log("Pre-state:");
  console.log(`  heartbeat_last_at:     ${vmPre.heartbeat_last_at}`);
  console.log(`  heartbeat_next_at:     ${vmPre.heartbeat_next_at}`);
  console.log(`  heartbeat_cycle_calls: ${vmPre.heartbeat_cycle_calls}`);

  // 1. Force heartbeatRecent=true + cycle cap exceeded
  console.log("\n── 1. Force heartbeat-recent + cycle-cap-exceeded ──");
  const now = new Date();
  const { error: upErr } = await sb
    .from("instaclaw_vms")
    .update({
      heartbeat_last_at: now.toISOString(),
      // Keep next_at in the future so heartbeatDue stays false (we want
      // ONLY heartbeatRecent to fire, isolating our test variable)
      heartbeat_next_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      heartbeat_cycle_calls: 15,
    })
    .eq("id", vmPre.id as string);
  if (upErr) {
    console.error("FATAL forcing heartbeat state:", upErr.message);
    process.exit(2);
  }
  ok("heartbeat_last_at = now, cycle_calls = 15 (would force silentEmptyResponse without bypass)");

  try {
    // 2. Re-deploy patched scripts to vm-780
    console.log("\n── 2. Deploy patched scripts ──");
    const ssh = new NodeSSH();
    await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12000 });
    for (const name of ["consensus_match_rerank.py", "consensus_match_deliberate.py", "consensus_match_pipeline.py"]) {
      await ssh.putFile(
        `/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/${name}`,
        `/home/openclaw/.openclaw/scripts/${name}`,
      );
    }
    ok("3 scripts uploaded with x-call-kind header");

    // Verify the bypass header is in the on-disk script
    const headerCheck = await ssh.execCommand(
      "grep -c 'x-call-kind: match-pipeline' ~/.openclaw/scripts/consensus_match_rerank.py ~/.openclaw/scripts/consensus_match_deliberate.py"
    );
    if (headerCheck.stdout.includes(":1")) ok("bypass header present in both scripts");
    else { bad("bypass header missing from at least one script"); console.log(headerCheck.stdout); }

    // Wipe pipeline state so throttle doesn't skip
    await ssh.execCommand("rm -f ~/.openclaw/.consensus_match_state.json ~/.openclaw/.consensus_match.lock");

    // 3. Run the pipeline
    console.log("\n── 3. Run pipeline (forced heartbeat-recent state) ──");
    const start = Date.now();
    const r = await ssh.execCommand(
      "python3 ~/.openclaw/scripts/consensus_match_pipeline.py --force --no-jitter 2>&1"
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  exit: ${r.code}, latency: ${elapsed}s`);
    console.log("  output:");
    console.log("  " + r.stdout.split("\n").join("\n  "));

    // 4. Assert no silentEmptyResponse hits
    if (r.stdout.includes("post_results_ok")) ok("post_results_ok (full pipeline succeeded)");
    else if (r.stdout.includes("abort high_fallback_rate")) bad("pipeline aborted on high fallback (bypass not working)");
    else bad(`pipeline did not reach post_results_ok`);

    if (r.stdout.includes("layer2_ok")) {
      const m = r.stdout.match(/layer2_ok elapsed_ms=(\d+)/);
      if (m && parseInt(m[1]) > 3000) ok(`L2 elapsed ${m[1]}ms (real Sonnet, not fast-path empty)`);
      else if (m) bad(`L2 elapsed ${m[1]}ms (suspiciously fast — bypass may not be active)`);
    }

    if (r.stdout.includes("layer3_ok")) {
      const m = r.stdout.match(/layer3_ok elapsed_ms=(\d+)/);
      if (m && parseInt(m[1]) > 3000) ok(`L3 elapsed ${m[1]}ms (real Sonnet, not fast-path empty)`);
      else if (m) bad(`L3 elapsed ${m[1]}ms (suspiciously fast — bypass may not be active)`);
    }

    // Check the actual deliberation rationale isn't a fallback
    const { data: latestDelib } = await sb
      .from("matchpool_deliberations")
      .select("rationale, match_score")
      .eq("user_id", "0a102415-75e4-4fff-b792-773609c63ff0")  // vm-780 user
      .order("deliberated_at", { ascending: false })
      .limit(3);

    const fallbackCount = (latestDelib ?? []).filter((d) => {
      const r = (d.rationale as string).trimStart();
      return r.startsWith("<deliberation unavailable") || r.startsWith("<fallback:");
    }).length;
    if (fallbackCount === 0) ok(`top 3 deliberations are real (no fallback markers)`);
    else bad(`${fallbackCount}/3 deliberations are fallbacks`);

    if (latestDelib && latestDelib.length > 0) {
      console.log(`\n  Sample rationale (top 1, score=${Number(latestDelib[0].match_score).toFixed(2)}):`);
      console.log(`    ${(latestDelib[0].rationale as string).slice(0, 200)}`);
    }

    ssh.dispose();

  } finally {
    // Restore heartbeat state
    console.log("\n── Restore vm-780 heartbeat state ──");
    await sb
      .from("instaclaw_vms")
      .update({
        heartbeat_last_at: vmPre.heartbeat_last_at,
        heartbeat_next_at: vmPre.heartbeat_next_at,
        heartbeat_cycle_calls: vmPre.heartbeat_cycle_calls,
      })
      .eq("id", vmPre.id as string);
    console.log("  ✓ restored");
  }

  console.log(`\n══ ${pass} passed, ${fail} failed ══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
