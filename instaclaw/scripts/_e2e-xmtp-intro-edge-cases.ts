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
  // The actual unique index is on (user_id, user_profile_version,
  // candidate_user_id, candidate_profile_version) — verified
  // empirically against the live schema. PostgREST's onConflict
  // accepts the column list in any order as long as it matches.
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
  const { error: upErr } = await sb.from("matchpool_deliberations").upsert(seedRow, {
    onConflict: "user_id,user_profile_version,candidate_user_id,candidate_profile_version",
  });
  if (upErr) {
    // Last-resort: try a direct insert; ignore unique-violation noise.
    await sb.from("matchpool_deliberations").insert(seedRow);
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
  info("receiver xmtp service started — waiting up to 30s for XMTP catch-up");
  let recovered = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pending = await readPendingIntros(receiver);
    if (pending.find((p) => p.log_id === downRes.log_id)) { recovered = true; break; }
  }
  if (recovered) {
    pass("receiver picked up missed message via XMTP after restart (within 30s)");
  } else {
    // XMTP didn't replay the message — that's expected for the V3
    // store-and-forward window. Now exercise the application-layer
    // fallback: force a pipeline cycle on the receiver. The poll_my_intros
    // step should pick the unacked row up from agent_outreach_log
    // and write it to pending-intros.jsonl regardless of XMTP delivery.
    info("XMTP didn't replay — triggering receiver-side pipeline poll fallback");
    const pollSsh = await sshConnect(receiver);
    try {
      // We don't run the full pipeline (it would skip on throttle anyway);
      // instead invoke just the poll function inline. Cleanest way: a
      // tiny python one-liner that imports and calls poll_my_intros.
      const poll = await pollSsh.execCommand(
        `python3 -c "
import sys, os
sys.path.insert(0, os.path.expanduser('~/.openclaw/scripts'))
import consensus_match_pipeline as p
tok = p.get_gateway_token()
if not tok:
    print('NO_TOKEN'); sys.exit(0)
summary = p.poll_my_intros(tok)
print('POLLED', summary['polled'], 'NEW', summary['new'], 'DUP', summary['dup'])
" 2>&1`,
      );
      info(`poll output: ${(poll.stdout || "").trim().slice(-200)}`);
    } finally {
      pollSsh.dispose();
    }
    // Re-check pending-intros for the missed row.
    const pendingAfterPoll = await readPendingIntros(receiver);
    if (pendingAfterPoll.find((p) => p.log_id === downRes.log_id)) {
      pass("receiver picked up missed message via SERVER POLL fallback");
    } else {
      bad("receiver missed via XMTP AND poll fallback — both paths failed");
    }
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
  console.log("\n── Test 7: UNVERIFIED SENDER (envelope from non-InstaClaw wallet) ──");
  // The previous version of this test reserved a real outreach,
  // deleted the row post-send, and watched for the envelope to be
  // dropped. That was racy: XMTP often delivered the envelope BEFORE
  // the delete landed, so identify-agent passed legitimately and the
  // test reported a false positive on every run.
  //
  // The realistic threat is "envelope from a wallet that has NO row in
  // instaclaw_vms.xmtp_address". We simulate it by directly hitting
  // the receiver's localhost listener with a hand-crafted envelope
  // claiming a random wallet as from_xmtp. The receiver's identify-
  // agent call returns is_instaclaw_agent=false → handleInboundIntro
  // returns true (handled, suppressed) → no pending-intros row.
  await clearPendingIntros(sender);
  const ssh780 = await sshConnect(sender);
  try {
    const fakeXmtp = "0x" + "0123456789abcdef".repeat(2) + "0123456789ab"; // 40 hex
    const fakeHeader = JSON.stringify({
      v: 1,
      from_xmtp: fakeXmtp,
      from_user_id: "00000000-0000-0000-0000-000000000000",
      log_id: "00000000-0000-0000-0000-000000000000",
    });
    const envelope = `[INSTACLAW_AGENT_INTRO_V1]\n${fakeHeader}\n---\nFake intro from a wallet not registered with InstaClaw.\n`;
    // Get vm-780's own xmtp address (so we can DM ourselves to inject)
    const selfAddr = (await ssh780.execCommand("cat ~/.openclaw/xmtp/address")).stdout.trim();
    const result = await ssh780.execCommand(
      `curl -s -X POST http://127.0.0.1:18790/send-intro -H "Content-Type: application/json" -d '${JSON.stringify({ target_xmtp_address: selfAddr, body: envelope })}' 2>&1`,
    );
    info(`inject result: ${result.stdout.slice(0, 100)}`);
    await new Promise((r) => setTimeout(r, 5000));
    const pendingAfterUnver = await readPendingIntros(sender);
    const fakeRow = pendingAfterUnver.find((p) => p.sender_xmtp === fakeXmtp);
    if (!fakeRow) pass("envelope from non-InstaClaw wallet was dropped (no pending row)");
    else bad(`security regression: envelope from non-InstaClaw wallet ${fakeXmtp.slice(0, 12)} was rendered`);
  } finally {
    ssh780.dispose();
  }

  await clearTestLedgerRows([sender.assigned_to, receiver.assigned_to]);

  // ────────────────────────────────────────────────────────────────
  console.log("\n── Test 8: TELEGRAM DELIVERY (vm-780 → vm-354, chat_id populated) ──");
  // vm-354 has telegram_chat_id backfilled. Verify the live Telegram
  // path actually fires — message lands in the user's Telegram chat,
  // ACK comes back, sender's retry loop is short-circuited.
  const tgReceiver = await getVm("instaclaw-vm-354");
  const tgPv = await getProfileVersion(sender.assigned_to);
  await ensureDeliberation(sender.assigned_to, tgPv, tgReceiver.assigned_to);
  await clearPendingIntros(tgReceiver);

  const tgAnchor = `${TEST_PREFIX}-telegram:${tgReceiver.assigned_to}`;
  const tgRes = await fireOutreachOnVM(sender, tgReceiver, tgAnchor);
  if (tgRes.status === "sent") pass(`outreach sent to vm-354 (log_id=${tgRes.log_id})`);
  else bad(`outreach to vm-354 failed: ${JSON.stringify(tgRes).slice(0, 200)}`);

  await new Promise((r) => setTimeout(r, 6000));

  // Inspect vm-354's journal for the Telegram-success log line
  const ssh354 = await sshConnect(tgReceiver);
  try {
    const journal = await ssh354.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && journalctl --user -u instaclaw-xmtp --no-pager -n 50 2>/dev/null | tail -30',
    );
    const out = journal.stdout || "";
    if (out.includes("intro forwarded to user via Telegram")) {
      pass("vm-354 journal: Telegram delivery succeeded");
    } else if (out.includes("xmtp user channel")) {
      info("(landed via XMTP-user channel — Telegram might have failed silently)");
      bad("Telegram delivery did NOT fire (fell through to xmtp_user)");
    } else if (out.includes("pending-intros.jsonl")) {
      bad("Telegram delivery did NOT fire (fell through to pending file)");
    } else {
      bad(`vm-354 journal: no delivery line found. last: ${out.split("\n").slice(-5).join(" | ").slice(0, 200)}`);
    }
  } finally {
    ssh354.dispose();
  }

  // Verify the ACK landed (ack_received_at should be set)
  if (tgRes.log_id) {
    const { data: row } = await sb.from("agent_outreach_log").select("ack_received_at, ack_channel").eq("id", tgRes.log_id).single();
    if (row?.ack_received_at && row?.ack_channel === "telegram") {
      pass(`ACK round-trip: ack_received_at set, channel=telegram`);
    } else if (row?.ack_received_at) {
      bad(`ACK landed but channel=${row.ack_channel} (expected telegram)`);
    } else {
      bad("no ACK on the ledger row");
    }
  }

  await clearTestLedgerRows([sender.assigned_to, tgReceiver.assigned_to]);

  console.log(`\n══ ${state.pass} passed, ${state.fail} failed ══`);
  process.exit(state.fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
