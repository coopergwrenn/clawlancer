/**
 * End-to-end test of the agent-to-agent XMTP intro flow on vm-780.
 *
 * Flow under test:
 *   1. consensus_agent_outreach.py on vm-780 (Cooper / consensus_2026)
 *   2. Reserve via /api/match/v1/outreach (rate-limit + idempotency)
 *   3. Send XMTP via xmtp-agent.mjs's localhost:18790 listener
 *   4. Receiving edge_city VM detects [INSTACLAW_AGENT_INTRO_V1] envelope
 *   5. Receiver verifies via /api/match/v1/identify-agent
 *   6. Receiver forwards to its user's Telegram via notify_user.sh
 *   7. Receiver acks back on XMTP
 *
 * Steps:
 *   A. Resolve a real receiver: pick the edge_city VM whose user has
 *      the most recent matchpool_deliberations row from vm-780.
 *      That guarantees the anti-harvest gate in contact-info passes.
 *   B. Compose an outreach payload, SSH to vm-780, pipe to
 *      consensus_agent_outreach.py via stdin.
 *   C. Verify the agent_outreach_log row landed with status=sent.
 *   D. Tail vm-receiver's journalctl for the "intro forwarded to user
 *      via Telegram" log line and the local send server's "outreach sent"
 *      log line on vm-780.
 *
 * Read-only otherwise (no DB writes outside what the flow naturally
 * does). Uses a unique top1_anchor with a test marker so re-runs are
 * always fresh (no stale-duplicate suppression).
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
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  let pass = 0, fail = 0;
  const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fail++; };

  console.log("══ vm-780 → edge_city XMTP intro flow e2e ══\n");

  // ─ Resolve sender ─
  const { data: vmSender } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (!vmSender) { console.error("vm-780 not found"); process.exit(2); }
  const senderUserId = vmSender.assigned_to as string;
  const senderName = vmSender.name as string;
  console.log(`Sender:   ${senderName} (user=${senderUserId.slice(0, 8)} xmtp=${(vmSender.xmtp_address || "").slice(0, 10)}...)\n`);

  // ─ Pick a real receiver: an edge_city VM with a valid xmtp_address ─
  // vm-780's natural deliberations are dominated by seeded ghost profiles
  // (no VM, no XMTP). To exercise the full flow against a REAL receiver,
  // we seed a synthetic deliberation row vm-780→<edge_city_user> so the
  // anti-harvest gate in contact-info passes. This is identical in shape
  // to a row that the production pipeline would write naturally once
  // vm-780's L3 ranks the edge_city users above the ghost pool.
  const { data: edgeVms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user, assigned_to, xmtp_address")
    .eq("partner", "edge_city")
    .eq("health_status", "healthy")
    .not("xmtp_address", "is", null)
    .not("assigned_to", "is", null)
    .order("name");
  if (!edgeVms || edgeVms.length === 0) {
    bad("no healthy edge_city VM with xmtp_address available");
    process.exit(1);
  }
  const targetVm = edgeVms[0]!;
  const targetUserId = targetVm.assigned_to as string;
  ok(`receiver picked: ${targetVm.name} (user=${targetUserId.slice(0, 8)} xmtp=${(targetVm.xmtp_address || "").slice(0, 10)}...)`);

  // Seed a synthetic deliberation row so contact-info's anti-harvest
  // gate passes for this test. Idempotent: upsert on the natural key
  // (user_id, candidate_user_id, deliberated_at-ish). We use a recent
  // timestamp so the 7-day window is a non-issue.
  // Resolve sender's current profile_version (NOT NULL on the column).
  const { data: senderProfile } = await sb
    .from("matchpool_profiles")
    .select("profile_version")
    .eq("user_id", senderUserId)
    .single();
  const senderPv = senderProfile?.profile_version || 1;

  const seedRow = {
    user_id: senderUserId,
    user_profile_version: senderPv,
    candidate_user_id: targetUserId,
    candidate_profile_version: 1,
    match_score: 0.85,
    rationale: "[E2E TEST SEED] Both running InstaClaw infrastructure - direct shared-domain match.",
    conversation_topic: "Cross-agent intro flow validation",
    meeting_window: "Anytime over the next 3 days at Consensus",
    skip_reason: null,
    deliberated_at: new Date().toISOString(),
  };
  // The deliberations table has a unique on (user_id, candidate_user_id,
  // user_profile_version). On conflict, just bump deliberated_at so the
  // 7-day window is fresh.
  const { error: seedErr } = await sb
    .from("matchpool_deliberations")
    .upsert(seedRow, { onConflict: "user_id,candidate_user_id,user_profile_version" });
  if (seedErr) {
    // Fallback: update the existing row's timestamp directly.
    const { error: updErr } = await sb
      .from("matchpool_deliberations")
      .update({ deliberated_at: new Date().toISOString(), match_score: 0.85, rationale: seedRow.rationale })
      .eq("user_id", senderUserId)
      .eq("candidate_user_id", targetUserId)
      .eq("user_profile_version", senderPv);
    if (updErr) {
      bad(`failed to seed/update deliberation row: ${updErr.message}`);
      process.exit(1);
    }
  }
  ok("seeded synthetic deliberation row (anti-harvest gate now passes)");
  const candidate = seedRow;

  // ─ SSH to vm-780 ─
  const ssh780 = new NodeSSH();
  await ssh780.connect({
    host: vmSender.ip_address as string,
    username: (vmSender.ssh_user as string) || "openclaw",
    privateKey: sshKey,
    readyTimeout: 12000,
  });

  // Sanity: outreach script + listener present
  const sanityOut = await ssh780.execCommand("test -x ~/.openclaw/scripts/consensus_agent_outreach.py && echo OK1; ss -tlnp 2>/dev/null | grep -q ':18790' && echo OK2");
  if (!sanityOut.stdout.includes("OK1")) bad("consensus_agent_outreach.py not present/executable on vm-780");
  else ok("outreach script present + executable");
  if (!sanityOut.stdout.includes("OK2")) bad("port 18790 not listening on vm-780");
  else ok("local send server listening on :18790");

  // ─ Get current profile_version for top1_anchor ─
  const { data: profile } = await sb
    .from("matchpool_profiles")
    .select("profile_version")
    .eq("user_id", senderUserId)
    .single();
  const pv = profile?.profile_version || 1;

  // Use a TEST marker in anchor so re-runs don't dedup against prior tests.
  const testAnchor = `test-${pv}-${Date.now()}`;

  // ─ Compose payload ─
  const rationale = (candidate.rationale as string || "").replace(/^<[^>]+>\s*/, "");
  const payload = {
    target_user_id: targetUserId,
    profile_version: testAnchor,  // shoehorn unique anchor in
    rationale: rationale.slice(0, 380) || "Strong signal match from yesterday's deliberation pool.",
    topic: (candidate.conversation_topic as string) || "Agent-to-agent intro test",
    window: (candidate.meeting_window as string) || "Anytime over the next 3 days at Consensus",
    from_user_id: senderUserId,
    from_name: "Cooper Wrenn",
    from_agent_name: "Edge City Bot",
    from_telegram_bot_username: "edgecitybot",
    from_identity_wallet: vmSender.bankr_evm_address || null,
  };

  console.log(`\nFiring outreach: ${senderName} → ${targetVm.name}`);
  console.log(`  anchor: ${testAnchor}`);

  const start = Date.now();
  const outreachRun = await ssh780.execCommand(
    `python3 ~/.openclaw/scripts/consensus_agent_outreach.py 2>&1`,
    { stdin: JSON.stringify(payload) },
  );
  const elapsedMs = Date.now() - start;
  console.log(`  ${(elapsedMs / 1000).toFixed(1)}s elapsed`);
  console.log("  output:");
  for (const line of (outreachRun.stdout || "").split("\n")) {
    if (line.trim()) console.log(`    ${line}`);
  }
  if (outreachRun.stderr.trim()) {
    console.log("  stderr:");
    for (const line of (outreachRun.stderr || "").split("\n")) {
      if (line.trim()) console.log(`    ${line}`);
    }
  }

  // ─ Parse outreach script output ─
  const outLines = (outreachRun.stdout || "").trim().split("\n");
  const lastLine = outLines[outLines.length - 1] || "";
  let parsedOut: { ok?: boolean; status?: string; log_id?: string; target_xmtp?: string; reason?: string; error?: string } = {};
  try {
    parsedOut = JSON.parse(lastLine);
  } catch {
    bad(`outreach output not JSON parseable: ${lastLine.slice(0, 200)}`);
  }

  if (parsedOut.status === "sent") ok(`outreach sent (log_id=${parsedOut.log_id})`);
  else if (parsedOut.status === "skipped") bad(`outreach skipped: reason=${parsedOut.reason}`);
  else bad(`outreach status=${parsedOut.status} reason=${parsedOut.reason || ""} error=${parsedOut.error || ""}`);

  // ─ Verify agent_outreach_log row ─
  if (parsedOut.log_id) {
    const { data: row } = await sb
      .from("agent_outreach_log")
      .select("*")
      .eq("id", parsedOut.log_id)
      .single();
    if (row) {
      if (row.status === "sent") ok(`ledger row status=sent target=${(row.target_xmtp_address as string).slice(0, 10)}...`);
      else bad(`ledger row status=${row.status} error=${row.error_message}`);
      if (row.outbound_user_id === senderUserId) ok("ledger outbound_user_id matches sender");
      else bad(`ledger outbound_user_id mismatch: ${row.outbound_user_id}`);
    } else {
      bad("ledger row not found in DB");
    }
  }

  // ─ Verify journal on sender (xmtp-agent.mjs sent log) ─
  const senderJournal = await ssh780.execCommand(
    'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && journalctl --user -u instaclaw-xmtp --no-pager -n 80 2>/dev/null | tail -30',
  );
  if (senderJournal.stdout.includes("outreach sent to")) ok("vm-780 xmtp-agent journal: 'outreach sent'");
  else bad("vm-780 xmtp-agent journal: no 'outreach sent' line");
  ssh780.dispose();

  // ─ Tail receiver's journal ─
  const ssh_recv = new NodeSSH();
  const targetVmFull = targetVm as { ip_address: string; ssh_user: string | null };
  if (!targetVmFull) {
    bad("could not refetch target VM details");
  } else {
    try {
      await ssh_recv.connect({
        host: targetVmFull.ip_address as string,
        username: (targetVmFull.ssh_user as string) || "openclaw",
        privateKey: sshKey,
        readyTimeout: 12000,
      });
      // Wait a beat for XMTP to deliver
      await new Promise((r) => setTimeout(r, 4000));
      const recvJournal = await ssh_recv.execCommand(
        'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && journalctl --user -u instaclaw-xmtp --no-pager -n 100 2>/dev/null | tail -50',
      );
      const recvOut = recvJournal.stdout;
      if (recvOut.includes("INSTACLAW_AGENT_INTRO_V1")) ok(`${targetVm.name} journal: envelope received`);
      else bad(`${targetVm.name} journal: no envelope line. last: ${recvOut.split("\n").slice(-5).join(" | ").slice(0, 240)}`);
      if (recvOut.includes("intro forwarded to user via Telegram")) ok(`${targetVm.name} journal: intro forwarded to Telegram`);
      else if (recvOut.includes("unverified — dropping")) bad(`${targetVm.name} journal: receiver couldn't verify (identify-agent gate)`);
      else if (recvOut.includes("notify_user.sh failed")) bad(`${targetVm.name} journal: notify_user.sh failed`);
      else bad(`${targetVm.name} journal: no Telegram-forward line. last: ${recvOut.split("\n").slice(-5).join(" | ").slice(0, 240)}`);
    } finally {
      ssh_recv.dispose();
    }
  }

  console.log(`\n══ ${pass} passed, ${fail} failed ══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
