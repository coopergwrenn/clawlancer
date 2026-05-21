/**
 * POST /api/vm/cloud-init-callback — VM "I'm healthy, mark me assigned" callback.
 *
 * Called by setup.sh §1.38 AFTER the gateway is up and /tmp/.instaclaw-ready
 * is touched. Atomic claim-and-invalidate of the per-VM callback_token
 * transitions the VM row:
 *   - status:           'provisioning' → 'assigned'
 *   - health_status:    NULL/whatever → 'healthy'
 *   - agentbook_wallet_address: optionally backfilled from the POST body
 *   - cloud_init_callback_consumed_at: NULL → now()
 *
 * Companion to /api/vm/cloud-init-config (Day 9-10). Together they form
 * the two-endpoint claim-and-invalidate pair documented in
 * docs/cloud-init-builder-plan-2026-05-13.md §6.2:
 *   - config_token:   one-time-use, in Linode userdata + DB. Consumed when
 *                     the bootstrap fetches the per-VM tarball.
 *   - callback_token: one-time-use, in tarball setup.sh + DB. Consumed
 *                     when setup.sh reports completion. NOT in userdata
 *                     (limits at-rest exposure on Linode's metadata).
 *
 * ── Request contract (matches setup.sh §1.38) ──
 *   Method:  POST
 *   Headers: Content-Type: application/json
 *            X-Cloud-Init-Callback-Token: <hex 32-128>
 *   Body:    { "userId": "<uuid>",
 *              "vmName": "<instaclaw-vm-XXX>",
 *              "agentbookAddress": "<0x-prefixed 40-hex>" OR "",
 *              "status": "healthy" }
 *
 * ── Response codes ──
 *   200 — atomic claim succeeded, VM transitioned
 *   400 — missing/malformed body field or query schema
 *   401 — missing/malformed/wrong/already-consumed token, or
 *         user/vm-name/status mismatch (all collapse to 401 for defense
 *         in depth, same as the cloud-init-config endpoint)
 *   500 — DB write failure after claim
 *
 * ── Retry semantics + idempotency ──
 * setup.sh §1.38 retries the POST up to 3× (10s timeout each + 5s backoff).
 * Three retry-related cases:
 *   (1) First attempt succeeds end-to-end: setup.sh sees 200, CALLBACK_OK=
 *       true, proceeds. The token row's consumed_at is now set.
 *   (2) First attempt commits server-side but its 200 response is lost in
 *       transit (network blip): setup.sh thinks attempt 1 failed and
 *       retries. Without idempotency the retry hits 401 (atomic claim
 *       finds consumed_at != NULL) → setup.sh fails → cloud-init-poll
 *       30-min sweep wrongly marks a HEALTHY VM `status='failed'`.
 *       Day 11-12 fix (2026-05-15): retry's claim-fail triggers an
 *       idempotency-SELECT — if THIS token, for THIS user+vm, already
 *       has consumed_at set AND status='assigned' AND health_status=
 *       'healthy' (the post-successful-callback state we'd have written),
 *       return 200 as if we were the first. Strict (token, user, vm)
 *       tuple match prevents an attacker from exploiting this path.
 *   (3) Three consecutive transit-level failures (server unreachable):
 *       setup.sh exits 1 → /tmp/.instaclaw-failed → cloud-init-poll
 *       eventually marks `status='failed'`. Correct outcome.
 *
 * ── agentbookAddress handling ──
 * Body may include an EVM address (when a future setup.sh on-VM derivation
 * is wired) or an empty string (current Day 11-12 — on-VM-gen path doesn't
 * yet derive the address). Non-empty + EVM-shape-valid → write to the
 * agentbook_wallet_address column. Empty or malformed → SKIP the column
 * update (leave NULL or whatever was there). NEVER write the literal
 * string "undefined" or "" to the column.
 *
 * ── What this endpoint does NOT do ──
 * Status='failed' callbacks: setup.sh's failure path touches
 * /tmp/.instaclaw-failed and exits 1 WITHOUT calling this endpoint.
 * Failure detection is owned by cloud-init-poll (30-min timeout sweep)
 * + SSH-side sentinel probing. This endpoint is success-only.
 *
 * Plan: docs/cloud-init-builder-plan-2026-05-13.md §5 + §6.2 + §12.2.
 * Middleware allow-list: instaclaw/middleware.ts.
 *
 * 2026-05-15 Phase 1A Day 11-12 deliverable.
 */
// Cache-bust: 2026-05-15 — initial deploy of cloud-init-callback endpoint.

import { NextRequest, NextResponse, after } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// 2026-05-16 bumped 30 → 300 to accommodate `after()` background TLS upgrade
// (lib/ssh.ts:setupTLSBackground). The response itself still resolves in <1s
// (parse + peek + atomic claim + 2 supplemental updates). The 300s budget is
// reserved for the after()-block: GoDaddy DNS A record create + apt-get install
// caddy + Caddyfile write + caddy restart. Empirically configure/route.ts uses
// the same 300s ceiling for the same workload (line 11). Vercel bills actual
// elapsed time, not the reservation, so the bump is cost-neutral on fast paths.
//
// Why 300 specifically: Rule 11 calls out 300s as the Vercel Pro max. apt-get
// install on a cold Linode VM has hit 90-120s in observed runs; setupTLS itself
// adds ~20-40s for Caddyfile + restart. 300s leaves headroom for slow days.
export const maxDuration = 300;

// ── Input validation regexes (mirror cloud-init-config for consistency) ──
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VM_NAME_RE = /^instaclaw-vm-[a-zA-Z0-9_-]+$/;
// callback_token minted via randomBytes(32).toString("hex") = 64 hex chars.
// Accept 32-128 for forward-compat.
const HEX_TOKEN_RE = /^[a-fA-F0-9]{32,128}$/;
// EVM address: 0x-prefixed 40 hex chars. Don't checksum-verify (downstream
// consumers accept either case).
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
// IPv4 dotted-quad. Each octet 0-255. Defensive — setup.sh derives IP
// from `ip -4 -o addr show eth0` so input is generally clean, but we
// validate at the boundary to refuse anything ill-formed before we
// concat it into gateway_url. IPv6 is intentionally rejected (gateway
// URL pattern is http://{ip}:18789 which doesn't bracket — IPv6 needs
// [host] syntax we don't currently produce anywhere in the codebase).
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

interface CallbackBody {
  userId?: unknown;
  vmName?: unknown;
  agentbookAddress?: unknown;
  status?: unknown;
  /**
   * 2026-05-21 Fix B: optional VM-reported IP. setup.sh on the VM now
   * derives its own IP (`ip -4 -o addr show eth0`) and sends it here so
   * the callback no longer races createUserVM Phase C's UPDATE. When
   * present + valid, this IP is used for gateway_url and (if the DB row
   * has ip_address NULL) written to the row as part of the §4 atomic
   * claim. Backward-compat: callers who don't send ipAddress still work
   * if the DB row has ip_address from Phase C (legacy path).
   */
  ipAddress?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Extract + shape-validate token header ──
  const callbackToken = req.headers.get("X-Cloud-Init-Callback-Token");
  if (!callbackToken || !HEX_TOKEN_RE.test(callbackToken)) {
    if (callbackToken) {
      // Shape-mismatch: log prefix for forensic correlation (a legit-but-
      // typo token gives the operator a breadcrumb). Missing-header is
      // silent so DDoS noise doesn't fill the log.
      logger.warn("cloud-init-callback: rejected malformed token", {
        route: "vm/cloud-init-callback",
        tokenLen: callbackToken.length,
      });
    }
    return new NextResponse("unauthorized", { status: 401 });
  }

  // ── 2. Parse + shape-validate body ──
  let body: CallbackBody;
  try {
    body = (await req.json()) as CallbackBody;
  } catch {
    return new NextResponse("invalid json", { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return new NextResponse("invalid body", { status: 400 });
  }

  const userId = typeof body.userId === "string" ? body.userId : "";
  const vmName = typeof body.vmName === "string" ? body.vmName : "";
  const status = typeof body.status === "string" ? body.status : "";
  // agentbookAddress is OPTIONAL — may be empty string (current Day 11-12
  // on-VM-gen path), a valid EVM address (future on-VM derivation), or
  // genuinely absent (forward-compat). Treat all non-string as undefined.
  const agentbookAddressRaw =
    typeof body.agentbookAddress === "string" ? body.agentbookAddress : "";

  if (!userId || !vmName || !status) {
    return new NextResponse("missing body fields", { status: 400 });
  }
  if (!UUID_RE.test(userId)) {
    return new NextResponse("invalid userId", { status: 400 });
  }
  if (!VM_NAME_RE.test(vmName)) {
    return new NextResponse("invalid vmName", { status: 400 });
  }
  // status: setup.sh only ever posts "healthy" (failure paths don't call
  // this endpoint). Defensive — reject anything else with a clear 400 so
  // a future setup.sh that grows new statuses without an endpoint update
  // surfaces visibly.
  if (status !== "healthy") {
    return new NextResponse(`unsupported status: ${status}`, { status: 400 });
  }

  // Validate agentbookAddress shape ONLY when non-empty. Empty is the
  // expected current value (on-VM-gen omits derivation; column-update
  // is skipped below). A non-empty bad value is a real bug to surface.
  let agentbookAddressForUpdate: string | undefined;
  if (agentbookAddressRaw) {
    if (!EVM_ADDRESS_RE.test(agentbookAddressRaw)) {
      logger.warn("cloud-init-callback: rejected malformed agentbookAddress", {
        route: "vm/cloud-init-callback",
        userId,
        vmName,
        addressPrefix: agentbookAddressRaw.slice(0, 20),
        addressLen: agentbookAddressRaw.length,
      });
      return new NextResponse("invalid agentbookAddress", { status: 400 });
    }
    agentbookAddressForUpdate = agentbookAddressRaw;
  }

  // ── 2026-05-21 Fix B: parse + validate VM-reported ipAddress ──
  // Optional field. setup.sh derives the IP locally; route uses it to
  // close the race with createUserVM Phase C's UPDATE. Validation is
  // strict — invalid IPv4 returns 400 (clear signal to forensic debug).
  // Missing is OK (backward-compat with pre-Fix-B setup.sh and the
  // pool-path test surface).
  const ipAddressFromBodyRaw =
    typeof body.ipAddress === "string" ? body.ipAddress.trim() : "";
  let ipAddressFromBody: string | undefined;
  if (ipAddressFromBodyRaw) {
    if (!IPV4_RE.test(ipAddressFromBodyRaw)) {
      logger.warn("cloud-init-callback: rejected malformed ipAddress", {
        route: "vm/cloud-init-callback",
        userId,
        vmName,
        ipAddressRaw: ipAddressFromBodyRaw.slice(0, 40),
      });
      return new NextResponse("invalid ipAddress", { status: 400 });
    }
    ipAddressFromBody = ipAddressFromBodyRaw;
  }

  const supabase = getSupabase();

  // ── 3. Pre-claim read — auth via token + verify row exists ──
  //
  // Pre-Fix-B (2026-05-21) this peek required ip_address NOT NULL,
  // because the §4 UPDATE relied on the DB-stored IP to construct
  // gateway_url. That assumption broke whenever createUserVM Phase C's
  // UPDATE didn't complete before setup.sh's callback fired (which
  // happened reliably whenever billing/webhook hit its 90s maxDuration
  // ceiling while Phase C was still polling Linode for boot).
  //
  // Post-Fix-B: setup.sh sends its own IP in the body. Route accepts
  // either source. The peek now only verifies the row exists and the
  // token matches — that's sufficient auth (32-byte random token is
  // unique per VM, mint-time bound to assigned_to + name).
  const { data: rowPeek } = await supabase
    .from("instaclaw_vms")
    .select("ip_address")
    .eq("cloud_init_callback_token", callbackToken)
    .eq("assigned_to", userId)
    .eq("name", vmName)
    .maybeSingle();

  if (!rowPeek) {
    logger.warn("cloud-init-callback: pre-claim peek failed (no row for token)", {
      route: "vm/cloud-init-callback",
      userId,
      vmName,
      tokenPrefix: callbackToken.slice(0, 8),
    });
    return new NextResponse("unauthorized", { status: 401 });
  }

  // Resolve effective IP: body-supplied (new, race-free) wins over
  // DB-stored (legacy Phase-C path, still works). At least one must
  // be present — otherwise we can't construct gateway_url.
  const ipAddressFromDb = (rowPeek as { ip_address?: string | null }).ip_address ?? null;
  const ipAddress = ipAddressFromBody ?? (ipAddressFromDb && IPV4_RE.test(ipAddressFromDb) ? ipAddressFromDb : null);
  if (!ipAddress) {
    logger.warn("cloud-init-callback: no usable IP (body empty + DB NULL)", {
      route: "vm/cloud-init-callback",
      userId,
      vmName,
      tokenPrefix: callbackToken.slice(0, 8),
    });
    return new NextResponse("missing ipAddress", { status: 400 });
  }

  // GATEWAY_PORT is exported from lib/ssh.ts:221 as 18789. Inlined here
  // (rather than imported) to keep this route handler's bundle small —
  // lib/ssh.ts pulls SSH client deps that don't belong on the edge of
  // a 30s-budget callback endpoint. If the port ever changes, BOTH this
  // literal AND lib/ssh.ts:221 must be updated.
  const gatewayUrl = `http://${ipAddress}:18789`;

  // ── 4. Atomic claim-and-invalidate + state transition ──
  // Single UPDATE with all WHERE clauses ensuring race-safety:
  //   - cloud_init_callback_token = X     (auth)
  //   - cloud_init_callback_consumed_at IS NULL  (one-time-use)
  //   - assigned_to = userId              (token belongs to this user)
  //   - name = vmName                     (token belongs to this VM)
  //   - status = 'provisioning'           (transition source state)
  //
  // The status='provisioning' guard prevents two race scenarios:
  //   (a) cloud-init-poll fires first and flips to 'ready' (legacy pool
  //       path) — our UPDATE finds no match, returns 401, setup.sh's
  //       retry also fails. Operator handles. Acceptable canary edge case.
  //   (b) Token is stolen and replayed AFTER the legitimate callback
  //       already succeeded — status is no longer 'provisioning' so the
  //       replay finds no match. Defense in depth (the consumed_at IS
  //       NULL guard already covers this; status check is belt-and-
  //       suspenders).
  //
  // ── Column set parity with configureOpenClaw (lib/ssh.ts:7615-7651) ──
  // gateway_url + control_ui_url     — P0-A fix (above)
  // health_status='healthy'           — pool path sets in vmUpdate
  // status='assigned'                  — pool path: instaclaw_assign_vm RPC
  // assigned_at=NOW                    — pool path: RPC at migration
  //                                       20260319_fix_vm_reclaim_and_assign_hygiene.sql:35
  // last_health_check=NOW              — vmUpdate line 7620
  // last_gateway_restart=NOW           — vmUpdate line 7640
  // ssh_fail_count=0                   — vmUpdate line 7621
  // health_fail_count=0                — vmUpdate line 7622
  // heartbeat_next_at=NOW+3h           — vmUpdate line 7646 (CRITICAL:
  //                                       configureOpenClaw THROWS
  //                                       PROVISIONING_BLOCKED if NULL
  //                                       on subsequent reconfigure —
  //                                       lib/ssh.ts:7754-7762)
  // heartbeat_interval='3h'            — vmUpdate line 7647
  // heartbeat_cycle_calls=0            — vmUpdate line 7648
  // config_version=0                    — DB default 0 (verified); reconciler
  //                                       picks up and pushes manifest content
  //                                       per Rule 47 continuous reconciliation
  // agentbook_wallet_address (cond.)   — vmUpdate line 7650
  // ip_address                          — 2026-05-21 Fix B: always set
  //                                       from effective IP (body or
  //                                       DB) so the row's ip_address
  //                                       is non-NULL after callback
  //                                       regardless of Phase C's
  //                                       completion status. Idempotent
  //                                       when DB already had the same
  //                                       IP (Phase C completed first);
  //                                       fills the gap when Phase C's
  //                                       UPDATE got killed by webhook
  //                                       maxDuration.
  const nowIso = new Date().toISOString();
  const HEARTBEAT_INITIAL_DELAY_MS = 10_800_000; // 3h — matches lib/ssh.ts:7646
  const update: Record<string, unknown> = {
    cloud_init_callback_consumed_at: nowIso,
    health_status: "healthy",
    status: "assigned",
    assigned_at: nowIso,
    ip_address: ipAddress,
    gateway_url: gatewayUrl,
    control_ui_url: gatewayUrl,
    last_health_check: nowIso,
    last_gateway_restart: nowIso,
    ssh_fail_count: 0,
    health_fail_count: 0,
    heartbeat_next_at: new Date(Date.now() + HEARTBEAT_INITIAL_DELAY_MS).toISOString(),
    heartbeat_interval: "3h",
    heartbeat_cycle_calls: 0,
  };
  // Only include agentbook_wallet_address when we have a validated non-empty
  // value. Skipping the key entirely leaves whatever was previously in the
  // column (NULL for fresh VMs; an earlier value for re-runs in unusual
  // operator-intervention paths).
  if (agentbookAddressForUpdate) {
    update.agentbook_wallet_address = agentbookAddressForUpdate;
  }

  const { data: vm, error: claimErr } = await supabase
    .from("instaclaw_vms")
    .update(update)
    .eq("cloud_init_callback_token", callbackToken)
    .eq("assigned_to", userId)
    .eq("name", vmName)
    .eq("status", "provisioning")
    .is("cloud_init_callback_consumed_at", null)
    // telegram_bot_username included so we can feed it to sendVMReadyEmail
    // in the after() block below without an extra round-trip. Always-set by
    // createUserVM Phase A INSERT (telegram_bot_token is a required field for
    // the cloud-init signup path; the username is paired with it).
    .select("id, name, partner, agentbook_wallet_address, gateway_url, telegram_bot_username")
    .single();

  if (claimErr || !vm) {
    // The atomic claim found 0 matching rows. Four legitimate causes:
    //   (a) Wrong token         — attacker without the real value
    //   (b) user/vm-name mismatch — token doesn't belong to this VM
    //   (c) status != 'provisioning' — already transitioned elsewhere
    //   (d) consumed_at NOT NULL — already-consumed retry
    //
    // Case (d) is BENIGN and EXPECTED: setup.sh §1.38 retries the curl
    // POST up to 3× with 10s timeout each. If attempt 1's response was
    // lost between server-commit and client-receipt (network blip), the
    // DB IS already in the post-success state but the bootstrap thinks
    // attempt 1 failed and retries. Without idempotency, the retry hits
    // 401 → setup.sh marks the VM failed → cloud-init-poll wrongly
    // marks a HEALTHY VM `status='failed'` at the 30-min timeout sweep.
    //
    // Idempotency check: if THIS exact token, for THIS user+vm, was
    // already consumed AND the row is now in the post-callback state
    // we'd have written (status='assigned' AND health_status='healthy'),
    // the prior call succeeded — return 200 as if we were the first.
    // The strict (token, user, vm) tuple match prevents abuse: an
    // attacker without the real token can never make this SELECT match.
    const { data: priorVm, error: priorErr } = await supabase
      .from("instaclaw_vms")
      .select("id, name, partner, agentbook_wallet_address, cloud_init_callback_consumed_at, gateway_url")
      .eq("cloud_init_callback_token", callbackToken)
      .eq("assigned_to", userId)
      .eq("name", vmName)
      .eq("status", "assigned")
      .eq("health_status", "healthy")
      .not("cloud_init_callback_consumed_at", "is", null)
      .not("gateway_url", "is", null)
      .single();

    if (!priorErr && priorVm) {
      logger.info("cloud-init-callback: idempotent retry — already healthy/assigned", {
        route: "vm/cloud-init-callback",
        userId,
        vmName,
        vmId: (priorVm as { id: string }).id,
        tokenPrefix: callbackToken.slice(0, 8),
        priorConsumedAt: (priorVm as { cloud_init_callback_consumed_at: string }).cloud_init_callback_consumed_at,
      });
      return NextResponse.json({ ok: true, idempotent: true });
    }

    // Not an idempotent retry — genuine auth failure. Internal log
    // captures truncated token prefix for correlation; response body
    // is uniform per the same defense-in-depth pattern as the config
    // endpoint.
    logger.warn("cloud-init-callback: claim failed", {
      route: "vm/cloud-init-callback",
      userId,
      vmName,
      tokenPrefix: callbackToken.slice(0, 8),
      reasonCode: claimErr?.code ?? "no_match",
    });
    return new NextResponse("unauthorized", { status: 401 });
  }

  // ── 5. Rule 33 supplemental: mark user onboarded + consume pending row ──
  //
  // Mirrors the pool path's /api/vm/configure handler at lines 659-674:
  //
  //     await supabase.from("instaclaw_users").update({
  //       onboarding_complete: true,
  //       deployment_lock_at: null,
  //     }).eq("id", userId);
  //
  //     if (pending) {
  //       await supabase.from("instaclaw_pending_users")
  //         .update({ consumed_at: new Date().toISOString() })
  //         .eq("user_id", userId);
  //     }
  //
  // Without this block, every cloud-init signup creates the exact Rule 33
  // trap state CLAUDE.md documents: VM works, but dashboard layout's
  // redirect (`session.user.onboardingComplete === false` at
  // app/(dashboard)/layout.tsx:73) bounces the user to /connect on every
  // dashboard mount. The user never sees the dashboard, the funnel never
  // completes, and the stuck-onboarding health-check alert fires.
  //
  // Best-effort: catch + log on either UPDATE failure, but return 200 so
  // setup.sh doesn't retry the callback. The VM is genuinely healthy at
  // this point; the upstream onboarding state lagging is recoverable by
  // process-pending Pass 5 (24h purge of stale pending) or operator
  // surgery, but a stuck setup.sh retrying forever is not.
  try {
    const { error: userUpdErr } = await supabase
      .from("instaclaw_users")
      .update({ onboarding_complete: true, deployment_lock_at: null })
      .eq("id", userId);
    if (userUpdErr) {
      logger.error("cloud-init-callback: instaclaw_users update failed (Rule 33 trap-state risk)", {
        route: "vm/cloud-init-callback",
        userId,
        vmId: (vm as { id: string }).id,
        error: userUpdErr.message,
      });
    }
  } catch (e) {
    logger.error("cloud-init-callback: instaclaw_users update threw (Rule 33 trap-state risk)", {
      route: "vm/cloud-init-callback",
      userId,
      vmId: (vm as { id: string }).id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  try {
    const { error: pendingUpdErr } = await supabase
      .from("instaclaw_pending_users")
      .update({ consumed_at: nowIso })
      .eq("user_id", userId);
    if (pendingUpdErr) {
      // Pending consumption is non-load-bearing: the user is fully
      // onboarded (per the user_users update above). Process-pending
      // Pass 5 (24h consumed-purge) handles cleanup either way.
      logger.warn("cloud-init-callback: pending_users.consumed_at update failed (non-fatal)", {
        route: "vm/cloud-init-callback",
        userId,
        vmId: (vm as { id: string }).id,
        error: pendingUpdErr.message,
      });
    }
  } catch (e) {
    logger.warn("cloud-init-callback: pending_users.consumed_at update threw (non-fatal)", {
      route: "vm/cloud-init-callback",
      userId,
      vmId: (vm as { id: string }).id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 6. Fetch email for VM-ready notification (best-effort, sync) ──
  //
  // Captures the user's email synchronously before scheduling after() so
  // the closure has it in scope without an extra round-trip from background.
  // We do this OUTSIDE after() because:
  //   - The query is cheap (~50ms PostgREST GET by primary key)
  //   - If email lookup fails, we log + continue (email send is best-effort)
  //   - Having the value captured pre-after() means the after() closure stays
  //     side-effect-free re. the supabase client lifecycle
  let userEmailForNotify: string | undefined;
  try {
    const { data: userRowEmail, error: userEmailErr } = await supabase
      .from("instaclaw_users")
      .select("email")
      .eq("id", userId)
      .maybeSingle();
    if (userEmailErr) {
      logger.warn("cloud-init-callback: failed to fetch user email for VM-ready notify (non-fatal)", {
        route: "vm/cloud-init-callback",
        userId,
        vmId: (vm as { id: string }).id,
        error: userEmailErr.message,
      });
    } else {
      userEmailForNotify = (userRowEmail as { email?: string | null } | null)?.email ?? undefined;
    }
  } catch (e) {
    logger.warn("cloud-init-callback: user email fetch threw (non-fatal)", {
      route: "vm/cloud-init-callback",
      userId,
      vmId: (vm as { id: string }).id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 7. Background: VM-ready email + TLS upgrade (after() block) ──
  //
  // Mirrors the pool path's two background tasks:
  //   - process-pending Pass 1 line 432-437: sendVMReadyEmail after configure
  //   - configure/route.ts:681: setupTLSBackground for HTTPS upgrade
  //
  // Both run in the same after() block (Next.js fires them post-response so
  // the user's setup.sh sees the 200 immediately, no latency tax). Email runs
  // first because it's fast (~200ms); TLS install can take 30-120s.
  //
  // Failure semantics:
  //   - Email: sendVMReadyEmail has built-in 24h dedup (lib/email.ts:229-247)
  //     and Resend error handling. If it throws here we log + continue to TLS.
  //   - TLS: setupTLSBackground NEVER throws (lib/ssh.ts:9746-9753 wraps in
  //     try/catch). On TLS failure VM stays on HTTP — functional. Idempotent
  //     fast-path skip at lib/ssh.ts:9691 makes retries safe.
  //
  // Dynamic imports keep lib/ssh.ts (9700+ lines, pulls node-ssh) and
  // lib/email.ts (pulls Resend SDK) out of the callback route's cold-start
  // bundle. They only load when after() fires.
  //
  // try/catch around after() itself is a test-compat shim: Next's after()
  // throws "called outside a request scope" when invoked synthetically. In
  // production every invocation IS inside a request scope so the catch never
  // hits; the only effect is that integration tests work without crashing.
  const vmRecord = {
    id: (vm as { id: string }).id,
    ip_address: ipAddress, // from §3 pre-claim peek
    ssh_port: 22, // createUserVM Phase A INSERT sets this constant
    ssh_user: "openclaw", // createUserVM Phase A INSERT sets this constant
    assigned_to: userId, // from §4 atomic claim WHERE clause
  };
  const tlsHostname = `${(vm as { id: string }).id}.vm.instaclaw.io`;
  const tgBotUsername = (vm as { telegram_bot_username?: string | null }).telegram_bot_username ?? undefined;
  const dashboardUrl = `${process.env.NEXTAUTH_URL}/dashboard`;
  try {
    after(async () => {
      // ─ Email (fast, ~200ms with Resend) ─
      if (userEmailForNotify) {
        try {
          const { sendVMReadyEmail } = await import("@/lib/email");
          await sendVMReadyEmail(userEmailForNotify, dashboardUrl, tgBotUsername);
          logger.info("cloud-init-callback: VM-ready email sent", {
            route: "vm/cloud-init-callback",
            vmId: vmRecord.id,
            emailPrefix: userEmailForNotify.slice(0, 3) + "***",
          });
        } catch (e) {
          logger.warn("cloud-init-callback: VM-ready email failed (non-fatal — TLS continues)", {
            route: "vm/cloud-init-callback",
            vmId: vmRecord.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      } else {
        logger.warn("cloud-init-callback: skipping VM-ready email (no email available)", {
          route: "vm/cloud-init-callback",
          vmId: vmRecord.id,
          userId,
        });
      }
      // ─ TLS (slow, 30-120s for Caddy install) ─
      const { setupTLSBackground } = await import("@/lib/ssh");
      await setupTLSBackground(vmRecord, tlsHostname);
    });
  } catch (e) {
    logger.warn("cloud-init-callback: after() unavailable — VM-ready email + TLS upgrade skipped this invocation", {
      route: "vm/cloud-init-callback",
      vmId: vmRecord.id,
      hostname: tlsHostname,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // ── 8. Success — VM is now healthy + assigned + user onboarded ──
  // The DB state transition is committed. Any downstream consumer (admin
  // dashboard, reconciler eligibility query, billing, etc.) sees the VM as
  // a live, healthy, user-assigned VM from this moment on. The user
  // session's onboarding_complete will read true on next dashboard mount.
  logger.info("cloud-init-callback: VM transitioned to assigned/healthy", {
    route: "vm/cloud-init-callback",
    vmId: (vm as { id: string }).id,
    vmName: (vm as { name: string | null }).name,
    partner: (vm as { partner: string | null }).partner,
    gatewayUrl: (vm as { gateway_url: string | null }).gateway_url,
    agentbookAddressWritten: agentbookAddressForUpdate != null,
  });

  return NextResponse.json({ ok: true });
}
