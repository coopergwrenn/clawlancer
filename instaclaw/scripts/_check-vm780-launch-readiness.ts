/**
 * Read-only launch-readiness audit for vm-780 (@edgecitybot, Cooper).
 *
 * Verifies every preconditions for the Consensus 2026 demo WITHOUT
 * sending a real chat message — gbrain is investigating an "insufficient
 * balance (1008)" billing error in flight, so any real /v1/chat/completions
 * call would 1008 fail and burn a debug attempt.
 *
 * Checks (all SSH-side, no gateway hits):
 *   1. consensus-2026 skill enabled (DB)
 *   2. matchpool_profile present + recent profile_version (DB)
 *   3. recent matchpool_deliberations + cached_top3 (DB)
 *   4. XMTP intro flow files deployed with sentinels (Rule 23)
 *   5. instaclaw-xmtp service active + listening on :18790
 *   6. xmtp_address matches what's in the DB
 *   7. telegram_bot_username + chat_id populated (DB)
 *   8. journalctl tail for the 1008 billing error pattern
 *   9. cron entries: consensus_match_pipeline + intent_sync present
 *
 * Output: per-check pass/warn/fail with a final readiness score.
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

let pass = 0, warn = 0, fail = 0;
function ok(m: string) { console.log(`  ✓ ${m}`); pass++; }
function wrn(m: string) { console.log(`  ⚠ ${m}`); warn++; }
function bad(m: string) { console.log(`  ✗ ${m}`); fail++; }

async function run() {
  console.log("══ vm-780 launch-readiness audit ══\n");

  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-780").single();
  if (!vm) { console.error("vm-780 not found"); process.exit(2); }
  console.log(`vm-780: ip=${vm.ip_address} cv=${vm.config_version} health=${vm.health_status}\n`);
  const userId = vm.assigned_to as string;

  // ─ 1. consensus-2026 skill ─
  // Two-step lookup: find the skill row by slug, then check vm_skills
  // for that skill_id. PostgREST's nested `eq("table.col", v)` filter
  // doesn't reliably work for non-foreign-key joins.
  console.log("── 1. consensus-2026 skill state ──");
  const { data: skill } = await sb
    .from("instaclaw_skills")
    .select("id, slug, name, category")
    .eq("slug", "consensus-2026")
    .maybeSingle();
  if (!skill) {
    bad("instaclaw_skills row for slug=consensus-2026 not found");
  } else {
    const { data: vmSkill } = await sb
      .from("instaclaw_vm_skills")
      .select("*")
      .eq("vm_id", vm.id)
      .eq("skill_id", skill.id)
      .maybeSingle();
    if (vmSkill?.enabled) ok(`consensus-2026 skill enabled (installed ${vmSkill.installed_at}, updated ${vmSkill.updated_at})`);
    else if (vmSkill) wrn("consensus-2026 skill row exists but enabled=false");
    else bad("instaclaw_vm_skills row missing for vm-780");
  }

  // ─ 2. matchpool_profile ─
  console.log("\n── 2. matchpool_profile ──");
  const { data: profile } = await sb
    .from("matchpool_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (profile) {
    ok(`profile exists pv=${profile.profile_version} tier=${profile.consent_tier} model=${profile.embedding_model}`);
    const ageH = (Date.now() - new Date(profile.intent_extracted_at as string).getTime()) / 3.6e6;
    if (ageH < 24) ok(`intent extracted ${ageH.toFixed(1)}h ago (fresh)`);
    else wrn(`intent extracted ${ageH.toFixed(1)}h ago — may want a fresh intent_sync`);
  } else {
    bad("no matchpool_profile row");
  }

  // ─ 3. recent deliberations + cached_top3 ─
  console.log("\n── 3. recent deliberations + cached_top3 ──");
  const { data: cached } = await sb.from("matchpool_cached_top3").select("top3_user_ids, computed_at").eq("user_id", userId).maybeSingle();
  if (cached?.top3_user_ids && Array.isArray(cached.top3_user_ids) && cached.top3_user_ids.length > 0) {
    const ageM = (Date.now() - new Date(cached.computed_at as string).getTime()) / 60000;
    ok(`cached_top3 has ${cached.top3_user_ids.length} entries, ${ageM.toFixed(0)} min old`);
  } else {
    bad("cached_top3 missing or empty");
  }
  const { data: delibs, count } = await sb
    .from("matchpool_deliberations")
    .select("candidate_user_id, deliberated_at", { count: "exact", head: false })
    .eq("user_id", userId)
    .gte("deliberated_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .order("deliberated_at", { ascending: false })
    .limit(5);
  if ((count ?? 0) > 0) ok(`${count} deliberations in last 24h, latest at ${delibs?.[0]?.deliberated_at}`);
  else bad("no deliberations in last 24h");

  // ─ 4-7 + 8 + 9: SSH-side checks ─
  const ssh = new NodeSSH();
  await ssh.connect({
    host: vm.ip_address as string,
    username: (vm.ssh_user as string) || "openclaw",
    privateKey: sshKey,
    readyTimeout: 12000,
  });
  try {
    // ─ 4. XMTP intro flow file sentinels ─
    console.log("\n── 4. XMTP intro flow files (Rule 23 sentinels) ──");
    const sentChecks = [
      ["~/scripts/xmtp-agent.mjs", ["[INSTACLAW_AGENT_INTRO_V1]", "ackIntroToServer", "readSeenLogIds"]],
      ["~/.openclaw/scripts/consensus_match_pipeline.py", ["poll_my_intros", "retry_unacked_outreach", "MY_INTROS_URL"]],
      ["~/.openclaw/scripts/consensus_agent_outreach.py", ["build_envelope", "INSTACLAW_AGENT_INTRO_V1", "get_self_xmtp_address"]],
    ] as const;
    for (const [path, sentinels] of sentChecks) {
      let allPresent = true;
      for (const s of sentinels) {
        const enc = Buffer.from(s, "utf-8").toString("base64");
        const r = await ssh.execCommand(`pattern=$(echo '${enc}' | base64 -d) && grep -Fq "$pattern" ${path} 2>/dev/null && echo OK || echo MISS`);
        if (!r.stdout.includes("OK")) {
          bad(`${path}: missing sentinel "${s}"`);
          allPresent = false;
        }
      }
      if (allPresent) ok(`${path}: all ${sentinels.length} sentinels present`);
    }

    // ─ 5. service + port ─
    console.log("\n── 5. instaclaw-xmtp service + local listener ──");
    const status = await ssh.execCommand('export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user is-active instaclaw-xmtp');
    if (status.stdout.trim() === "active") ok("instaclaw-xmtp service: active");
    else bad(`instaclaw-xmtp service: ${status.stdout.trim()}`);
    const port = await ssh.execCommand("ss -tlnp 2>/dev/null | grep -q ':18790' && echo OK || echo MISS");
    if (port.stdout.includes("OK")) ok("local send listener on :18790");
    else bad("local send listener NOT bound on :18790");

    // ─ 6. xmtp_address matches DB ─
    console.log("\n── 6. xmtp_address parity ──");
    const onDisk = (await ssh.execCommand("cat ~/.openclaw/xmtp/address 2>/dev/null")).stdout.trim();
    if (onDisk && onDisk.toLowerCase() === (vm.xmtp_address as string).toLowerCase()) {
      ok(`xmtp_address parity: ${onDisk.slice(0, 12)}...`);
    } else {
      bad(`xmtp_address mismatch: disk=${onDisk.slice(0, 12)} vs db=${(vm.xmtp_address as string).slice(0, 12)}`);
    }

    // ─ 7. telegram fields ─
    console.log("\n── 7. telegram delivery preconditions ──");
    if (vm.telegram_bot_username) ok(`bot @${vm.telegram_bot_username}`);
    else bad("no telegram_bot_username");
    if (vm.telegram_chat_id) ok(`chat_id=${vm.telegram_chat_id} (real-time Telegram delivery WILL fire)`);
    else wrn("telegram_chat_id NULL — intros will fall through to XMTP-user / pending-intros");

    // ─ 8. 1008 billing error pattern ─
    // gbrain is investigating; this check just confirms the symptom is
    // present so we know to defer real-message tests until that's
    // resolved. Reported as warn (not fail) since it's tracked elsewhere.
    console.log("\n── 8. 1008 billing error journal scan (gbrain is investigating) ──");
    const journal = await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && journalctl --user --since="2 hours ago" 2>/dev/null | grep -cE "1008|insufficient.balance" || echo 0',
    );
    const errCount = parseInt(journal.stdout.trim(), 10) || 0;
    if (errCount === 0) ok("no 1008 errors in last 2h journal");
    else wrn(`${errCount} '1008 / insufficient balance' lines in last 2h — gbrain has it`);

    // ─ 9. cron entries ─
    console.log("\n── 9. cron entries (pipeline + intent_sync) ──");
    const cron = await ssh.execCommand("crontab -l 2>/dev/null");
    if (cron.stdout.includes("consensus_match_pipeline.py")) ok("cron: consensus_match_pipeline.py");
    else bad("cron: consensus_match_pipeline.py missing");
    if (cron.stdout.includes("consensus_intent_sync.py")) ok("cron: consensus_intent_sync.py");
    else wrn("cron: consensus_intent_sync.py missing");
  } finally {
    ssh.dispose();
  }

  console.log(`\n══ ${pass} pass, ${warn} warn, ${fail} fail ══`);
  if (fail > 0) {
    console.log("\nLAUNCH BLOCKERS PRESENT — resolve before announcing.");
    process.exit(1);
  } else if (warn > 0) {
    console.log("\nWARNINGS — review but not blocking.");
  } else {
    console.log("\nvm-780 ready for launch.");
  }
}

run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
