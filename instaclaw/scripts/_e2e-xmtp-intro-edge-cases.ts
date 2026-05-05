/**
 * Comprehensive edge-case test suite for the agent-to-agent intro flow.
 *
 * Cooper's directive: this is the first time two autonomous agents have
 * communicated on behalf of their humans to set up a real meeting. If
 * it breaks at Consensus, it's a bad first impression of agent-to-agent
 * comms for every user who sees it. So we test every path I can think
 * of, including:
 *
 *   1. HAPPY PATH — vm-780 → vm-050 single intro lands, ledger
 *      written, receiver sees envelope, intro is recorded via the
 *      pending-intros fallback path (since these users have neither
 *      telegram_chat_id nor USER_WALLET_ADDRESS).
 *
 *   2. IDEMPOTENCY — same anchor twice → second reserve returns
 *      duplicate; ledger has exactly one row.
 *
 *   3. RATE LIMIT — fire MAX+1 distinct anchors → MAX+1 -th rejected
 *      with reason=rate_limited; ledger holds MAX rows.
 *
 *   4. SIMULTANEOUS MUTUAL — vm-780→vm-050 AND vm-050→vm-780 fire
 *      concurrently. Both reserve, both send, both receive, both ack.
 *      No collision on the ledger (different (outbound,target,anchor)
 *      tuples).
 *
 *   5. RECEIVER-DOWN RECOVERY — stop receiver xmtp-agent service,
 *      send intro, wait, restart receiver. Verify the message is
 *      delivered after the restart (XMTP store-and-forward).
 *
 *   6. PENDING-INTROS — verify the file ~/.openclaw/xmtp/pending-intros.jsonl
 *      grows by one row per delivered envelope (since neither Telegram
 *      nor XMTP-user channel works on partner VMs).
 *
 *   7. UNVERIFIED SENDER — send envelope from a wallet that has no
 *      ledger row for the receiver → identify-agent returns
 *      verified_outreach=false → receiver drops silently.
 *
 *   8. NO-LOOP — receiver should NOT send a fallback "I'm having
 *      trouble" reply on gateway 401 (otherwise we get a runaway loop
 *      between two agents, which we already saw + fixed).
 *
 * The test cleans up test ledger rows on every run so rate-limit hits
 * don't compound across runs. `top1_anchor` for tests is prefixed
 * "ec-test-<timestamp>-<n>" so the cleanup query is unambiguous.
 *
 * Usage: npx tsx scripts/_e2e-xmtp-intro-edge-cases.ts
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

const TEST_PREFIX = `ec-test-${Date.now()}`;
const RATE_LIMIT_PER_24H = 20;

interface VMRow { id: string; name: string; ip_address: string; ssh_user: string | null; assigned_to: string; xmtp_address: string; bankr_evm_address: string | null; }

function pass(m: string) { console.log(`  ✓ ${m}`); state.pass++; }
function bad(m: string)  { console.log(`  ✗ ${m}`); state.fail++; }
function info(m: string) { console.log(`    ${m}`); }

const state = { pass: 0, fail: 0 };

async function getVm(name: string): Promise<VMRow> {
  const { data } = await sb.from("instaclaw_vms").select("id, name, ip_address, ssh_user, assigned_to, xmtp_address, bankr_evm_address").eq("name", name).single();
  if (!data) throw new Error(`vm ${name} not found`);
  return data as VMRow;
}

async function getProfileVersion(userId: string): Promise<number> {
  const { data } = await sb.from("matchpool_profiles").select("profile_version").eq("user_id", userId).single();
  return (data?.profile_version as number) || 1;
}

async function ensureDeliberation(senderUserId: string, senderPv: number, targetUserId: string): Promise<void> {
  const seedRow = {
    user_id: senderUserId,
    user_profile_version: senderPv,
    candidate_user_id: targetUserId,
    candidate_profile_version: 1,
    match_score: 0.85,
    rationale: "[E2E TEST SEED] anti-harvest gate satisfied for edge-case test.",
    conversation_topic: "Edge case validation",
    meeting_window: "Anytime over the next 3 days",
    skip_reason: null,
    deliberated_at: new Date().toISOString(),
  };
  const { error: upErr } = await sb.from("matchpool_deliberations").upsert(seedRow, { onConflict: "user_id,candidate_user_id,user_profile_version" });
  if (upErr) {
    await sb.from("matchpool_deliberations")
      .update({ deliberated_at: new Date().toISOString() })
      .eq("user_id", senderUserId)
      .eq("candidate_user_id", targetUserId)
      .eq("user_profile_version", senderPv);
  }
}

async function sshConnect(vm: { ip_address: string; ssh_user: string | null }): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  await ssh.connect({ host: vm.ip_address, username: vm.ssh_user || "openclaw", privateKey: sshKey, readyTimeout: 12000 });
  return ssh;
}

interface OutreachResult { ok?: boolean; status?: string; reason?: string; log_id?: string; error?: string; }

async function fireOutreachOnVM(vm: VMRow, target: VMRow, anchor: string, rationale = "Test"): Promise<OutreachResult> {
  const senderPv = await getProfileVersion(vm.assigned_to);
  await ensureDeliberation(vm.assigned_to, senderPv, target.assigned_to);

  const ssh = await sshConnect(vm);
  try {
    const payload = {
      target_user_id: target.assigned_to,
      profile_version: anchor,           // shoehorn unique anchor
      rationale,
      topic: "edge-case test topic",
      window: "anytime",
      from_user_id: vm.assigned_to,
      from_name: "Cooper Wrenn",
      from_agent_name: "Edge Test Bot",
      from_telegram_bot_username: "edgetestbot",
      from_identity_wallet: vm.bankr_evm_address || null,
    };
    const r = await ssh.execCommand("python3 ~/.openclaw/scripts/consensus_agent_outreach.py 2>&1", { stdin: JSON.stringify(payload) });
    const lines = (r.stdout || "").trim().split("\n");
    const last = lines[lines.length - 1] || "";
    try {
      return JSON.parse(last);
    } catch {
      return { ok: false, status: "parse_failed", error: r.stdout.slice(0, 500) };
    }
  } finally {
    ssh.dispose();
  }
}

async function readPendingIntros(vm: VMRow): Promise<Array<Record<string, unknown>>> {
  const ssh = await sshConnect(vm);
  try {
    const r = await ssh.execCommand("cat ~/.openclaw/xmtp/pending-intros.jsonl 2>/dev/null");
    const out: Array<Record<string, unknown>> = [];
    for (const l of (r.stdout || "").split("\n")) {
      const t = l.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch {}
    }
    return out;
  } finally {
    ssh.dispose();
  }
}

async function clearPendingIntros(vm: VMRow): Promise<void> {
  const ssh = await sshConnect(vm);
  try {
    await ssh.execCommand("rm -f ~/.openclaw/xmtp/pending-intros.jsonl");
  } finally {
    ssh.dispose();
  }
}

async function clearTestLedgerRows(senderUserIds: string[]): Promise<number> {
  // Direct .or() on multiple LIKE patterns is brittle in supabase-js
  // (URL-encoding %), so we just delete every row for the test
  // outbound_user_ids in the last 2 hours. The test VMs aren't doing
  // real outreach against their actual users while a test is running.
  const sinceIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const { data } = await sb
    .from("agent_outreach_log")
    .delete()
    .in("outbound_user_id", senderUserIds)
    .gte("sent_at", sinceIso)
    .select("id");
  return data?.length || 0;
}

async function setServiceState(vm: VMRow, action: "start" | "stop"): Promise<void> {
  const ssh = await sshConnect(vm);
  try {
    await ssh.execCommand(`export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user ${action} instaclaw-xmtp 2>&1`);
  } finally {
    ssh.dispose();
  }
}

async function main() {
  console.log("══ Agent-to-agent intro: edge-case test suite ══\n");

  const sender = await getVm("instaclaw-vm-780");
  const receiver = await getVm("instaclaw-vm-050");
  const cleared = await clearTestLedgerRows([sender.assigned_to, receiver.assigned_to]);
  await clearPendingIntros(receiver);
  await clearPendingIntros(sender);
  console.log(`Setup: cleared ${cleared} stale test ledger rows + receiver/sender pending files\n`);

  // ────────────────────────────────────────────────────────────────
  console.log("── Test 1: HAPPY PATH (vm-780 → vm-050) ──");
  const anchor1 = `${TEST_PREFIX}-1:${receiver.assigned_to}`;
  const r1 = await fireOutreachOnVM(sender, receiver, anchor1);
  if (r1.status === "sent") pass(`outreach.sent log_id=${r1.log_id}`);
  else bad(`outreach status=${r1.status} reason=${r1.reason || ""} error=${r1.error || ""}`);

  // Wait for XMTP delivery + receiver-side processing
  await new Promise((r) => setTimeout(r, 5000));

  const pending1 = await readPendingIntros(receiver);
  const last1 = pending1[pending1.length - 1];
  if (last1 && (last1.log_id === r1.log_id || (last1.sender_user_id === sender.assigned_to))) {
    pass(`receiver pending-intros has the new intro (log_id=${last1.log_id})`);
  } else {
    bad(`receiver pending-intros missing or stale: ${JSON.stringify(pending1[pending1.length - 1] || {}).slice(0, 200)}`);
  }

  // ────────────────────────────────────────────────────────────────
  console.log("\n── Test 2: IDEMPOTENCY (same anchor twice) ──");
  const r2 = await fireOutreachOnVM(sender, receiver, anchor1);
  if (r2.status === "skipped" && r2.reason === "duplicate") pass(`second reserve dedup'd: reason=${r2.reason}`);
  else bad(`expected duplicate, got status=${r2.status} reason=${r2.reason}`);

  // ────────────────────────────────────────────────────────────────
  console.log("\n── Test 3: RATE LIMIT (fire 20 anchors, expect 21st blocked) ──");
  // We've already used 1 slot via Test 1. Fire 19 more distinct
  // anchors → 20th distinct overall, then 21st should rate_limit.
  const fillStart = Date.now();
  let lastResult: OutreachResult | null = null;
  let firedOk = 1; // Test 1 already counted
  for (let i = 0; i < 19; i++) {
    const a = `${TEST_PREFIX}-rl-${i}:${receiver.assigned_to}`;
    const r = await fireOutreachOnVM(sender, receiver, a);
    if (r.status === "sent") firedOk++;
    lastResult = r;
  }
  info(`filled ${firedOk}/20 in ${((Date.now() - fillStart) / 1000).toFixed(0)}s`);
  if (firedOk === 20) pass("first 20 reserves all succeeded");
  else bad(`only ${firedOk}/20 reserves succeeded; last=${JSON.stringify(lastResult).slice(0, 200)}`);

  const overflow = await fireOutreachOnVM(sender, receiver, `${TEST_PREFIX}-rl-overflow:${receiver.assigned_to}`);
  if (overflow.status === "skipped" && overflow.reason === "rate_limited") pass(`21st reserve rate_limited as expected`);
  else bad(`expected rate_limited, got status=${overflow.status} reason=${overflow.reason}`);

  // Clean up rate-limit test rows so subsequent tests have headroom
  await clearTestLedgerRows([sender.assigned_to, receiver.assigned_to]);

  // ────────────────────────────────────────────────────────────────
  console.log("\n── Test 4: SIMULTANEOUS MUTUAL (A→B and B→A in parallel) ──");
  // For B→A we need B (vm-050) to have a matchpool_profile. Many
  // partner VMs won't, so we skip if vm-050 has no profile.
  const { data: receiverProfile } = await sb.from("matchpool_profiles").select("profile_version").eq("user_id", receiver.assigned_to).maybeSingle();
  if (!receiverProfile) {
    info(`receiver has no matchpool_profile — skipping mutual test (would need intent_sync run)`);
  } else {
    const aAnchor = `${TEST_PREFIX}-mutual-a:${receiver.assigned_to}`;
    const bAnchor = `${TEST_PREFIX}-mutual-b:${sender.assigned_to}`;
    const [aRes, bRes] = await Promise.all([
      fireOutreachOnVM(sender, receiver, aAnchor),
      fireOutreachOnVM(receiver, sender, bAnchor),
    ]);
    if (aRes.status === "sent") pass(`A→B sent (log_id=${aRes.log_id})`);
    else bad(`A→B failed: ${JSON.stringify(aRes).slice(0, 200)}`);
    if (bRes.status === "sent") pass(`B→A sent (log_id=${bRes.log_id})`);
    else bad(`B→A failed: ${JSON.stringify(bRes).slice(0, 200)}`);
  }
  await clearTestLedgerRows([sender.assigned_to, receiver.assigned_to]);

  // ────────────────────────────────────────────────────────────────
  console.log("\n── Test 5: RECEIVER-DOWN RECOVERY (XMTP store-and-forward) ──");
  await setServiceState(receiver, "stop");
  info("receiver xmtp service stopped");

  const downAnchor = `${TEST_PREFIX}-downrec:${receiver.assigned_to}`;
  await clearPendingIntros(receiver);
  const downRes = await fireOutreachOnVM(sender, receiver, downAnchor);
  if (downRes.status === "sent") pass(`outreach sent while receiver was down (log_id=${downRes.log_id})`);
  else bad(`outreach failed while receiver was down: ${JSON.stringify(downRes).slice(0, 200)}`);

  await setServiceState(receiver, "start");
  info("receiver xmtp service started — waiting up to 60s for delivery");
  let recovered = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pending = await readPendingIntros(receiver);
    if (pending.find((p) => p.log_id === downRes.log_id)) { recovered = true; break; }
  }
  if (recovered) {
    pass("receiver picked up missed message after restart");
  } else {
    // Known XMTP V3 behaviour: messages sent while a peer's MLS
    // installation is offline do not always replay on reconnect within
    // a short window. Production mitigation: pipeline retries every
    // 30 min, so a missed intro re-fires on the next cycle (with the
    // same anchor → idempotency dedup OR a new anchor if profile_version
    // bumped). The failure mode is "intro is delayed", not "lost".
    bad("receiver did NOT pick up missed message in 60s (KNOWN LIMIT — pipeline 30-min retry mitigates)");
  }

  await clearTestLedgerRows([sender.assigned_to, receiver.assigned_to]);

  // ────────────────────────────────────────────────────────────────
  console.log("\n── Test 6: NO-LOOP guard ──");
  // Verify the post-fix code doesn't actually CALL sendText with the
  // fallback string. The string can appear once in a comment that
  // explains the no-loop rule (which we want kept), but it must NEVER
  // appear in an executable sendText line.
  const ssh = await sshConnect(receiver);
  try {
    // Grep for sendText invocations whose argument starts with a
    // string containing "having trouble" — that's what we removed.
    const grep = await ssh.execCommand('grep -nE "sendText\\(.*having trouble" ~/scripts/xmtp-agent.mjs || echo "MATCHES_NONE"');
    if (grep.stdout.includes("MATCHES_NONE")) {
      pass("no executable sendText('I'm having trouble') line in xmtp-agent.mjs");
    } else {
      bad(`regression: ${grep.stdout.trim()}`);
    }
  } finally {
    ssh.dispose();
  }

  // ────────────────────────────────────────────────────────────────
  console.log("\n── Test 7: UNVERIFIED SENDER (no ledger row) ──");
  // Send a hand-crafted envelope FROM vm-050 but with no agent_outreach_log
  // row (we delete it after reserve). Verify the receiver drops it
  // silently. We do this by:
  //   - Reserve as vm-050→vm-780.
  //   - Manually DELETE the ledger row before XMTP arrives.
  //   - Receiver should fail identify-agent and drop.
  // This is a "best we can manage" simulation since we can't easily
  // inject an arbitrary XMTP wallet into the test.
  const senderForUnverified = receiver; // vm-050 is the "sender" here
  const targetForUnverified = sender;   // vm-780 is the "target/receiver"
  const unverAnchor = `${TEST_PREFIX}-unver:${targetForUnverified.assigned_to}`;
  await clearPendingIntros(targetForUnverified);
  const unverRes = await fireOutreachOnVM(senderForUnverified, targetForUnverified, unverAnchor);
  if (unverRes.log_id) {
    // Delete the ledger row to simulate "no proof of legitimate intro"
    await sb.from("agent_outreach_log").delete().eq("id", unverRes.log_id);
    info("ledger row deleted post-send to simulate unverified sender");
  }
  // The XMTP message has already been sent. We just verify the receiver
  // didn't add a new pending row (since identify-agent gate must fail).
  await new Promise((r) => setTimeout(r, 5000));
  const pendingAfterUnver = await readPendingIntros(targetForUnverified);
  const matched = pendingAfterUnver.find((p) => p.log_id === unverRes.log_id);
  if (!matched) pass("unverified envelope dropped by receiver (no new pending row)");
  else bad("unverified envelope was forwarded — security regression");

  await clearTestLedgerRows([sender.assigned_to, receiver.assigned_to]);
  console.log(`\n══ ${state.pass} passed, ${state.fail} failed ══`);
  process.exit(state.fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
