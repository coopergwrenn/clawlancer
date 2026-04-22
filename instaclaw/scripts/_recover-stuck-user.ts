/**
 * Manual recovery for a stuck paying user (no VM, onboarding_complete=false).
 *
 * Steps:
 *   1. Look up user by email, verify sub=active
 *   2. Verify no VM currently assigned (idempotency safety)
 *   3. Clear any stale deployment_lock_at
 *   4. Upsert instaclaw_pending_users row with tier from sub, default configs
 *   5. Call assignVMWithSSHCheck(userId)
 *   6. Call /api/vm/configure (production) with X-Admin-Key
 *   7. Poll VM row for health_status=healthy + user.onboarding_complete=true
 *   8. Send a test message through the VM's gateway, echo the response
 *
 * Per-step logging so we can diff / verify between users.
 *
 * Usage:
 *   npx tsx scripts/_recover-stuck-user.ts --email=<email>           # dry-run
 *   npx tsx scripts/_recover-stuck-user.ts --email=<email> --exec    # actually do it
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// SAFETY: do NOT use assignVMWithSSHCheck from this script.
// That function quarantines VMs that fail SSH — but local env has no
// SSH_PRIVATE_KEY_B64, so every check would false-negative and kill the
// pool. We call the RPC directly and trust that ready-pool VMs are healthy
// (replenish + health-check crons maintain it). Any real SSH issue will
// surface when /api/vm/configure runs from Vercel (which does have the key).

function arg(name: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const EMAIL = arg("email");
const EXEC = process.argv.includes("--exec");

if (!EMAIL) { console.error("usage: --email=<email> [--exec]"); process.exit(2); }

function log(step: string, msg: string) {
  console.log(`[${new Date().toISOString()}] ${step}: ${msg}`);
}

(async () => {
  console.log(`\n╔══ Manual recovery: ${EMAIL} (${EXEC ? "EXEC" : "DRY-RUN"}) ══╗\n`);

  // ───────── Step 1: look up user + sub ─────────
  log("1", `look up user by email`);
  const { data: user } = await s.from("instaclaw_users")
    .select("id, email, deployment_lock_at, onboarding_complete, onboarding_wizard_step, created_at, user_timezone")
    .eq("email", EMAIL).single();
  if (!user) { log("1", "ABORT: user not found"); process.exit(1); }
  log("1", `user_id=${user.id}  onboarding_complete=${user.onboarding_complete}  deployment_lock_at=${user.deployment_lock_at ?? "null"}`);

  const { data: sub } = await s.from("instaclaw_subscriptions")
    .select("tier, status, payment_status, stripe_subscription_id")
    .eq("user_id", user.id).single();
  if (!sub) { log("1", "ABORT: no subscription row"); process.exit(1); }
  log("1", `sub: tier=${sub.tier} status=${sub.status} payment_status=${sub.payment_status}`);
  if (sub.status !== "active") { log("1", `ABORT: sub.status=${sub.status} (need active)`); process.exit(1); }

  // ───────── Step 2: no existing VM ─────────
  log("2", `check for existing VM assignment`);
  const { data: existingVm } = await s.from("instaclaw_vms")
    .select("id, status, health_status").eq("assigned_to", user.id).maybeSingle();
  if (existingVm) {
    log("2", `ALREADY HAS VM: ${existingVm.id} status=${existingVm.status} health=${existingVm.health_status} — nothing to do`);
    process.exit(0);
  }
  log("2", `no existing VM — safe to proceed`);

  if (!EXEC) { log("*", "DRY-RUN — stopping before state changes"); process.exit(0); }

  // ───────── Step 3: clear stale deployment_lock_at ─────────
  log("3", `clear deployment_lock_at`);
  if (user.deployment_lock_at) {
    await s.from("instaclaw_users").update({ deployment_lock_at: null }).eq("id", user.id);
    log("3", `cleared (was ${user.deployment_lock_at})`);
  } else {
    log("3", `already null — no-op`);
  }

  // ───────── Step 4: skip pending_users insert ─────────
  // configure route at app/api/vm/configure/route.ts:106-178 explicitly supports
  // "no pending row — fall back to defaults from subscription". tier is read from
  // instaclaw_subscriptions, api_mode defaults to all_inclusive, channels=[] is
  // valid ("gateway runs without messaging, user adds later"). No row needed.
  log("4", `skipping pending_users — configure route uses defaults from subscription`);

  // ───────── Step 5: instaclaw_assign_vm RPC (no SSH pre-check from local) ─────────
  log("5", `call instaclaw_assign_vm RPC (bypassing local SSH pre-check)`);
  const t0 = Date.now();
  const { data: vm, error: rpcErr } = await s.rpc("instaclaw_assign_vm", { p_user_id: user.id });
  const assignMs = Date.now() - t0;
  if (rpcErr || !vm) {
    log("5", `ABORT: RPC returned ${rpcErr ? rpcErr.message : "null (pool empty)"} (${assignMs}ms)`);
    process.exit(1);
  }
  if (vm.provider !== "linode") {
    log("5", `ABORT: RPC returned non-Linode VM (provider=${vm.provider}) — this shouldn't happen, NOT quarantining`);
    process.exit(1);
  }
  log("5", `assigned VM id=${vm.id} name=${vm.name} ip=${vm.ip_address} (${assignMs}ms) — SSH check deferred to Vercel configure`);

  // ───────── Step 6: call /api/vm/configure ─────────
  log("6", `POST ${process.env.NEXTAUTH_URL}/api/vm/configure`);
  const t1 = Date.now();
  const configRes = await fetch(`${process.env.NEXTAUTH_URL}/api/vm/configure`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": process.env.ADMIN_API_KEY!,
    },
    body: JSON.stringify({ userId: user.id }),
  });
  const configBody = await configRes.text();
  const configMs = Date.now() - t1;
  log("6", `status=${configRes.status} (${configMs}ms) body=${configBody.slice(0, 400)}`);
  if (!configRes.ok) { log("6", `ABORT: configure returned ${configRes.status}`); process.exit(1); }

  // ───────── Step 7: poll for health + onboarding_complete ─────────
  log("7", `poll VM health + user.onboarding_complete (up to 60s)`);
  const deadline = Date.now() + 60_000;
  let lastState = "";
  let gatewayUrl: string | null = null;
  let gatewayToken: string | null = null;
  while (Date.now() < deadline) {
    const { data: vmNow } = await s.from("instaclaw_vms")
      .select("health_status, config_version, gateway_url, gateway_token").eq("id", vm.id).single();
    const { data: uNow } = await s.from("instaclaw_users")
      .select("onboarding_complete").eq("id", user.id).single();
    const state = `health=${vmNow?.health_status} cfg=v${vmNow?.config_version} gw=${vmNow?.gateway_url ? "set" : "null"} complete=${uNow?.onboarding_complete}`;
    if (state !== lastState) { log("7", state); lastState = state; }
    if (vmNow?.health_status === "healthy" && uNow?.onboarding_complete && vmNow.gateway_url && vmNow.gateway_token) {
      gatewayUrl = vmNow.gateway_url;
      gatewayToken = vmNow.gateway_token;
      log("7", `✓ VM healthy + onboarding_complete=true`);
      break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!gatewayUrl || !gatewayToken) {
    log("7", `TIMEOUT: did not reach healthy state in 60s — inspect manually`);
    process.exit(1);
  }

  // ───────── Step 8: send test message through gateway ─────────
  log("8", `POST ${gatewayUrl}/v1/chat/completions (test message)`);
  const t2 = Date.now();
  const chatRes = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${gatewayToken}`,
      "x-openclaw-model": "claude-sonnet-4-6",
    },
    body: JSON.stringify({
      model: "openclaw",
      max_tokens: 64,
      messages: [{ role: "user", content: "Say the word READY and nothing else." }],
      stream: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const chatMs = Date.now() - t2;
  if (!chatRes.ok) {
    const errBody = await chatRes.text();
    log("8", `FAIL status=${chatRes.status} (${chatMs}ms) body=${errBody.slice(0, 300)}`);
    process.exit(1);
  }
  const chatData = await chatRes.json();
  const reply = chatData.choices?.[0]?.message?.content ?? "(no content)";
  log("8", `status=${chatRes.status} (${chatMs}ms)`);
  log("8", `agent replied: "${reply.trim()}"`);

  console.log(`\n╚══ RECOVERY SUCCESS: ${EMAIL} ══╝\n`);
})();
