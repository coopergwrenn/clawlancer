/**
 * Clean-slate reset for shelpinc@gmail.com (user feed3914-033e-458e-ae86-ad5c80b740d6).
 *
 * Two reset modes:
 *
 *   DESTROY mode (default, safest, mirrors prod churn):
 *     1. DELETE the assigned Linode instance via API
 *     2. Update vm row: status=terminated, clear assigned_to + all per-user fields
 *     3. Null user row personalization
 *     4-5. Clear pending_users + oauth_signup_flows for the user
 *     6. Verify pool has ready VMs
 *
 *   RECYCLE mode (--recycle, faster, for tight test loops):
 *     1. Mirror the admin reclaim path (app/api/admin/vms/actions/route.ts:101).
 *        Take VM out of the pool (status=provisioning) → clear per-user fields →
 *        SSH-wipe filesystem via wipeVMForNextUser → ONLY THEN flip to status=ready.
 *        If the wipe fails, VM stays at status=provisioning (pool-excluded) so a
 *        future fresh user CANNOT inherit stale state.
 *     2-5. Same as DESTROY mode (user-row clear, pending_users, oauth_signup_flows).
 *
 * WHY --recycle EXISTS (Charlie #4 follow-up audit, 2026-05-25):
 *
 *   The 2026-05-25 vm-1019 incident traced to a manual DB update that set
 *   assigned_to=null + status=ready WITHOUT running any VM-side cleanup. The
 *   recycled VM kept its prior user's openclaw.json, sessions, telegram bot
 *   token, and gateway state. The next user assigned to it (shelpinc) hit
 *   3 configure failures in a row because configureOpenClaw collided with
 *   the stale state. Auto-release fired, user got reassigned to vm-1028,
 *   and was recovered — but the broken vm-1019 ended up kernel-wedged and
 *   had to be terminated by hand.
 *
 *   Q2 audit confirmed: NO PROD code path sets status=ready on a previously-
 *   assigned VM without first running wipeVMForNextUser (only path is the
 *   admin reclaim route, which gates the ready-flip on wipe success). The
 *   risk is test-tooling only. This --recycle mode closes the gap: any
 *   future operator who wants the fast recycle gets it the SAFE way through
 *   this flag, not via raw SQL.
 *
 * Usage:
 *   npx tsx scripts/_shelpinc-clean-slate-reset.ts                    # dry-run, DESTROY mode
 *   npx tsx scripts/_shelpinc-clean-slate-reset.ts --apply            # execute DESTROY
 *   npx tsx scripts/_shelpinc-clean-slate-reset.ts --recycle          # dry-run, RECYCLE mode
 *   npx tsx scripts/_shelpinc-clean-slate-reset.ts --apply --recycle  # execute RECYCLE
 *
 *   DESTROY is the default because it's prod-equivalent (churn → re-provision
 *   from pool). RECYCLE saves Linode-provisioning time during rapid test loops
 *   but only the VM itself stays; if you want to verify the from-scratch flow
 *   path, use DESTROY.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { wipeVMForNextUser } from "../lib/ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const APPLY = process.argv.includes("--apply");
const RECYCLE = process.argv.includes("--recycle");
const USER_ID = "feed3914-033e-458e-ae86-ad5c80b740d6";
const USER_EMAIL = "shelpinc@gmail.com";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const LINODE_API_TOKEN = process.env.LINODE_API_TOKEN!;
if (!LINODE_API_TOKEN) {
  console.error("FATAL: LINODE_API_TOKEN not set");
  process.exit(1);
}

// ── Fields to NULL on instaclaw_users ──
// All Edge/personalization/onboarding state. Email + google_id + stripe_customer_id
// + name + timezone + referred_by INTENTIONALLY preserved so Cooper can sign in
// again and re-walk the onboarding without losing his Stripe customer / referrer.
// 2026-05-23 v2: column names verified via _dump-table-cols.ts.
// `edge_verified_at` removed — does not exist. `edge_verified_email` is
// the only Edge-identity column on instaclaw_users.
const USER_NULL_FIELDS: Record<string, unknown> = {
  partner: null,
  edge_verified_email: null,
  onboarding_complete: false,
  onboarding_wizard_completed: false,
  onboarding_wizard_completed_at: null,
  onboarding_wizard_step: 0,
  gmail_popup_dismissed: false,
  deployment_lock_at: null,
  index_last_intent_at: null,
  // OAuth-derived state (all currently null but defensive)
  openai_oauth_access_token: null,
  openai_oauth_refresh_token: null,
  openai_oauth_id_token_claims: null,
  openai_oauth_expires_at: null,
  openai_oauth_last_refresh_at: null,
  openai_oauth_account_id: null,
  openai_oauth_originator: null,
  openai_token_version: 0,
  chatgpt_plan_type: null,
  chatgpt_plan_last_seen_at: null,
  // Misc Edge-flow flags
  xmtp_greeting_sent_at: null,
  privacy_mode_until: null,
  telegram_handle: null,
  agentbook_banner_dismissed_at: null,
  agentbook_banner_dismissed_state: null,
  hat_claimed_at: null,
  world_wallet_address: null,
  linking_code: null,
  linking_code_expires_at: null,
  updated_at: new Date().toISOString(),
};

async function getAssignedVms() {
  const { data } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", USER_ID);
  return data ?? [];
}

async function destroyLinode(instanceId: string): Promise<{ ok: boolean; detail: string }> {
  if (!APPLY) return { ok: true, detail: "DRY-RUN: would DELETE" };
  const res = await fetch(
    `https://api.linode.com/v4/linode/instances/${instanceId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${LINODE_API_TOKEN}` },
    },
  );
  if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
  // 404 = already deleted out of band, treat as success
  if (res.status === 404) return { ok: true, detail: "HTTP 404 (already deleted)" };
  const text = await res.text();
  return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
}

async function main() {
  const mode = RECYCLE ? "RECYCLE (wipe + return to pool)" : "DESTROY (delete Linode + terminate row)";
  console.log(`\n${APPLY ? "🔥 APPLYING" : "🧐 DRY-RUN"} clean-slate reset for ${USER_EMAIL} (${USER_ID})`);
  console.log(`Mode: ${mode}\n`);

  // ── 1. Find assigned VMs ──
  const vms = await getAssignedVms();
  console.log(`Step 1/5: ${vms.length} assigned VM(s)`);
  for (const vm of vms) {
    console.log(`  - vm name=${vm.name} id=${vm.id.slice(0, 8)} linode=${vm.provider_server_id} ip=${vm.ip_address}`);
  }

  // ── 2. Either DESTROY or RECYCLE each assigned VM ──
  if (RECYCLE) {
    // RECYCLE: mirror admin reclaim path (app/api/admin/vms/actions/route.ts:101).
    // (a) Take VM out of pool first (status=provisioning)
    // (b) Clear per-user fields BUT preserve provider_server_id, ip_address,
    //     name, region — the VM stays alive, the Linode keeps running
    // (c) SSH-wipe filesystem via wipeVMForNextUser
    // (d) ONLY on wipe success: flip status=ready (back to pool, clean)
    // (e) On wipe failure: leave at status=provisioning (pool-excluded). The
    //     VM is reachable but unsafe to assign; next operator can manually
    //     destroy or retry the wipe.
    console.log(`\nStep 2/5: RECYCLE ${vms.length} VM(s) — wipe filesystem then return to pool`);
    for (const vm of vms) {
      if (!vm.ip_address) {
        console.log(`  ⚠️  vm ${vm.name} has no ip_address — cannot SSH for wipe, skipping`);
        continue;
      }

      // (a)+(b): Out-of-pool + clear per-user fields. provider_server_id +
      //         ip_address PRESERVED — the Linode instance keeps running.
      const recycleClear: Record<string, unknown> = {
        status: "provisioning",
        assigned_to: null,
        health_status: "unknown",
        telegram_bot_token: null,
        telegram_bot_username: null,
        gateway_url: null,
        gateway_token: null,
        partner: null,
        index_user_id: null,
        index_api_key: null,
        index_provisioned_at: null,
        index_provisioned_failed_at: null,
        bankr_evm_address: null,
        bankr_api_key_encrypted: null,
        bankr_token_address: null,
        bankr_token_symbol: null,
        bankr_wallet_id: null,
        bankr_token_image_url: null,
        bankr_token_launched_at: null,
        agentbook_wallet_address: null,
        agentbook_registered: false,
        agentbook_registered_at: null,
        agentbook_tx_hash: null,
        agentbook_nullifier_hash: null,
        agentbook_prompt_sent: false,
        xmtp_address: null,
        edgeos_api_key: null,
        cloud_init_config_consumed_at: null,
        cloud_init_callback_consumed_at: null,
        configure_attempts: 0,
        configure_lock_at: null,
        updated_at: new Date().toISOString(),
      };

      if (APPLY) {
        const { error: clearErr } = await sb
          .from("instaclaw_vms")
          .update(recycleClear)
          .eq("id", vm.id);
        if (clearErr) {
          console.error(`  ⚠️  DB clear failed for vm ${vm.name}: ${clearErr.message} — aborting recycle`);
          continue;
        }
        console.log(`  DB clear vm ${vm.name}: OK (status=provisioning, ${Object.keys(recycleClear).length} fields)`);

        // (c): SSH wipe. wipeVMForNextUser stops the gateway, then wipes
        //      workspace/sessions/backups/media/chromium-state/etc. Safe to
        //      call repeatedly. Returns {success, error?}.
        const wipe = await wipeVMForNextUser({
          id: vm.id,
          ip_address: vm.ip_address,
          ssh_port: vm.ssh_port ?? 22,
          ssh_user: vm.ssh_user ?? "openclaw",
          region: vm.region ?? undefined,
        });

        if (wipe.success) {
          // (d): Flip to ready ONLY after wipe success
          const { error: readyErr } = await sb
            .from("instaclaw_vms")
            .update({ status: "ready", updated_at: new Date().toISOString() })
            .eq("id", vm.id);
          if (readyErr) {
            console.error(`  ⚠️  status=ready flip failed: ${readyErr.message} — vm stays at provisioning`);
          } else {
            console.log(`  ✓ wipe OK + status=ready: vm ${vm.name} back in pool, clean`);
          }
        } else {
          // (e): Wipe failed — leave at provisioning, NOT pool-eligible
          console.error(`  ⚠️  wipe failed: ${wipe.error} — vm stays at provisioning (pool-excluded for safety)`);
        }
      } else {
        console.log(`  DRY-RUN: would recycle vm ${vm.name} (clear ${Object.keys(recycleClear).length} fields, SSH-wipe, then status=ready on wipe success)`);
      }
    }
  } else {
    // DESTROY: Linode DELETE + DB terminated. Existing behavior.
    console.log(`\nStep 2/5: destroy ${vms.length} Linode instance(s) + mark DB rows terminated`);
    for (const vm of vms) {
      if (vm.provider_server_id) {
        const r = await destroyLinode(String(vm.provider_server_id));
        console.log(`  Linode DELETE ${vm.provider_server_id}: ${r.ok ? "OK" : "FAIL"} (${r.detail})`);
        if (!r.ok && APPLY) {
          console.error("  ⚠️  Linode destroy failed — NOT updating DB row (leaves consistent state for retry)");
          continue;
        }
      } else {
        console.log(`  vm ${vm.name} has no provider_server_id, skipping Linode call`);
      }

      // 2026-05-23 v2: column names verified via _dump-table-cols.ts.
      // `bankr_api_key` does NOT exist — actual column is `bankr_api_key_encrypted`.
      // `bankr_token_name` does NOT exist on instaclaw_vms — removed.
      // 2026-05-23 v3: health_status="terminated" rejected by
      // instaclaw_vms_health_status_check CHECK constraint. Valid values
      // (per DISTINCT query on prod): configure_failed, healthy,
      // hibernating, suspended, unhealthy, unknown. Use "unknown" for
      // destroyed-VM rows — semantically "no longer being health-checked".
      // status="terminated" IS valid on the status column (DISTINCT values:
      // assigned, failed, ready, terminated).
      const vmUpdate: Record<string, unknown> = {
        status: "terminated",
        assigned_to: null,
        ip_address: null,
        provider_server_id: null,
        health_status: "unknown",
        telegram_bot_token: null,
        telegram_bot_username: null,
        gateway_url: null,
        gateway_token: null,
        partner: null,
        index_user_id: null,
        index_api_key: null,
        index_provisioned_at: null,
        index_provisioned_failed_at: null,
        bankr_evm_address: null,
        bankr_api_key_encrypted: null,
        bankr_token_address: null,
        bankr_token_symbol: null,
        bankr_wallet_id: null,
        bankr_token_image_url: null,
        bankr_token_launched_at: null,
        agentbook_wallet_address: null,
        agentbook_registered: false,
        agentbook_registered_at: null,
        agentbook_tx_hash: null,
        agentbook_nullifier_hash: null,
        agentbook_prompt_sent: false,
        xmtp_address: null,
        edgeos_api_key: null,
        cloud_init_config_consumed_at: null,
        cloud_init_callback_consumed_at: null,
        configure_attempts: 0,
        configure_lock_at: null,
        updated_at: new Date().toISOString(),
      };
      if (APPLY) {
        const { error } = await sb
          .from("instaclaw_vms")
          .update(vmUpdate)
          .eq("id", vm.id);
        console.log(`  DB update vm ${vm.name}: ${error ? `FAIL ${error.message}` : "OK"}`);
      } else {
        console.log(`  DRY-RUN: would update vm ${vm.name} with ${Object.keys(vmUpdate).length} fields`);
      }
    }
  }

  // ── 3. NULL user row personalization fields ──
  console.log(`\nStep 3/5: null ${Object.keys(USER_NULL_FIELDS).length} fields on user row`);
  if (APPLY) {
    const { error } = await sb
      .from("instaclaw_users")
      .update(USER_NULL_FIELDS)
      .eq("id", USER_ID);
    console.log(`  user update: ${error ? `FAIL ${error.message}` : "OK"}`);
  } else {
    console.log(`  DRY-RUN: would null: ${Object.keys(USER_NULL_FIELDS).slice(0, 10).join(", ")}...`);
  }

  // ── 3b. Cancel any non-canceled Stripe subscriptions ──
  // CRITICAL (2026-05-23 incident): without this step, /api/billing/checkout
  // line 67-87's existingSub branch matches a leftover trialing sub on the
  // next /plan visit, skips Stripe checkout entirely, and returns /deploying
  // with no session_id. /deploying then errors "Payment session not found"
  // because pending_users.stripe_session_id is null. The user is stuck.
  //
  // Cancel on Stripe AND mark local row "canceled" so the .in("status",
  // ["active", "trialing"]) filter at checkout/route.ts:67 misses it on
  // next checkout.
  console.log(`\nStep 3b/5: cancel any leftover Stripe subscriptions`);
  const { data: liveSubs } = await sb
    .from("instaclaw_subscriptions")
    .select("id, stripe_subscription_id, status, tier")
    .eq("user_id", USER_ID)
    .neq("status", "canceled");
  console.log(`  found ${liveSubs?.length ?? 0} non-canceled local sub(s)`);
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY!;
  for (const s of liveSubs ?? []) {
    const stripeId = s.stripe_subscription_id;
    if (!stripeId) {
      console.log(`  skip ${s.id}: no stripe_subscription_id`);
      continue;
    }
    if (APPLY) {
      const res = await fetch(`https://api.stripe.com/v1/subscriptions/${stripeId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${STRIPE_KEY}` },
      });
      // 404 = already gone, treat as success
      const stripeOk = res.ok || res.status === 404;
      console.log(`  Stripe DELETE ${stripeId}: ${stripeOk ? "OK" : `FAIL HTTP ${res.status}`}`);
      if (stripeOk) {
        const { error } = await sb
          .from("instaclaw_subscriptions")
          .update({ status: "canceled", updated_at: new Date().toISOString() })
          .eq("id", s.id);
        console.log(`  DB mark canceled ${s.id.slice(0, 8)}: ${error ? `FAIL ${error.message}` : "OK"}`);
      }
    } else {
      console.log(`  DRY-RUN: would DELETE ${stripeId} on Stripe + mark local row canceled`);
    }
  }

  // ── 4. Clear pending_users for shelpinc ──
  // 2026-05-23 v2: instaclaw_pending_users has user_id (NOT email).
  // Confirmed via _dump-table-cols.ts: 13 cols, keyed by id + user_id +
  // stripe_session_id.
  console.log(`\nStep 4/5: clear pending_users for user_id=${USER_ID.slice(0, 8)}`);
  if (APPLY) {
    const { error, count } = await sb
      .from("instaclaw_pending_users")
      .delete({ count: "exact" })
      .eq("user_id", USER_ID);
    console.log(`  pending_users delete: ${error ? `FAIL ${error.message}` : `OK (${count ?? 0} rows)`}`);
  } else {
    console.log(`  DRY-RUN: would delete pending_users WHERE user_id = '${USER_ID}'`);
  }

  // ── 5. Clear oauth_signup_flows ──
  console.log(`\nStep 5/5: clear oauth_signup_flows for resolved_user_id`);
  if (APPLY) {
    try {
      const { error, count } = await sb
        .from("instaclaw_oauth_signup_flows")
        .delete({ count: "exact" })
        .eq("resolved_user_id", USER_ID);
      console.log(`  oauth_signup_flows delete: ${error ? `FAIL ${error.message}` : `OK (${count ?? 0} rows)`}`);
    } catch (e) {
      console.log(`  oauth_signup_flows delete: SKIP (${e instanceof Error ? e.message : e})`);
    }
  } else {
    console.log(`  DRY-RUN: would delete oauth_signup_flows WHERE resolved_user_id = '${USER_ID}'`);
  }

  // ── Verify pool ──
  const { count: poolReady } = await sb
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready");
  console.log(`\n=== POOL HEALTH ===`);
  console.log(`  ready VMs available: ${poolReady}`);
  if ((poolReady ?? 0) < 1) {
    console.error("  ⚠️  POOL EMPTY — sign-in will fail to assign a VM!");
  } else {
    console.log(`  ✓ pool has capacity for fresh signup`);
  }

  console.log(`\n${APPLY ? "✓ RESET COMPLETE" : "🧐 DRY-RUN COMPLETE — pass --apply to execute"}`);
  if (APPLY) {
    console.log(`\nNext step: Cooper signs in with shelpinc@gmail.com.`);
    console.log(`  → Should land on /signup or /edge claim flow (onboarding_complete=false)`);
    console.log(`  → Walk through /edge ticket claim with coopergrantwrenn@gmail.com email`);
    console.log(`  → After /deploying completes, dashboard fires Edge personalization popup`);
    console.log(`  → Agent's first Telegram message should greet by name (USER.md enrichment)`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
