/**
 * lib/createUserVM.ts — on-demand per-user VM provisioning.
 *
 * Phase 1B-1 deliverable per docs/cloud-init-builder-plan-2026-05-13.md.
 *
 * Creates a VM bound to a specific user from the start, via the
 * cloud-init bootstrap+fetch path (NOT the legacy pool path).
 *
 * Mints two one-time-use tokens at provision time:
 *   - cloud_init_config_token   (in Linode userdata)
 *   - cloud_init_callback_token (in tarball setup.sh, NOT in userdata)
 *
 * Persists the row with `created_via='on_demand'` BEFORE the Linode call
 * so the cloud-init-config endpoint can read the row when the bootstrap's
 * curl arrives. This row-first atomicity is mandatory — Linode-first
 * would mean the bootstrap fetches before we know which VM is calling.
 *
 * Both paths (legacy pool + on-demand) coexist during rollout. Operators
 * choose which to invoke at signup time (cutover is a separate concern
 * tracked in the Phase 1B-2 follow-up).
 *
 * ── Failure modes ──
 * - Validation throws (step 1)         → no row, no Linode (caller fixes input)
 * - vmName collision on insert         → 3 retries with fresh names, then throw
 * - Linode createServer throws         → row remains 'provisioning' with no IP
 *                                        → cloud-init-poll 30-min timeout marks
 *                                          status='failed'
 * - waitForServer throws (Linode VM exists but not booting)
 *                                      → provider_server_id stamped on row
 *                                        for cleanup, then throw
 * - Row UPDATE with IP fails           → orphaned Linode + row without IP
 *                                        (rare; admin cleanup via Linode UI)
 *
 * ── Pure async function ──
 * No global state. Dependencies (supabase, provider) are injectable via the
 * optional `deps` parameter so tests can substitute mocks without
 * monkey-patching the imports.
 */
import { randomBytes } from "node:crypto";
import { getSupabase } from "./supabase";
import { linodeProvider } from "./providers/linode";
import { buildCloudInitUserdata } from "./cloud-init-userdata";
import { getNextVmNumber, formatVmName } from "./hetzner";
import { assignVMWithSSHCheck } from "./ssh";
import { generateGatewayToken } from "./security";
import { logger } from "./logger";
import type { CloudProvider, ServerResult } from "./providers/types";

// ════════════════════════════════════════════════════════════════════════
// §1. Public types
// ════════════════════════════════════════════════════════════════════════

export interface CreateUserVMParams {
  /** UUID — instaclaw_users.id. Required. */
  userId: string;
  /** Subscription tier. Per Cooper 2026-05-13: NEVER NULL at provision time. */
  tier: string;
  /** Auth mode for the agent's Anthropic API calls. */
  apiMode: "all_inclusive" | "byok";
  /**
   * BYOK only — the user's own Anthropic API key. Required when
   * `apiMode === 'byok'` UNLESS `hasChatGPTOAuth === true` (then the
   * reconciler's stepChatGPTOAuthToken will configure Codex access
   * from instaclaw_users.openai_oauth_access_token instead — see
   * vm-reconcile.ts:11183).
   */
  apiKey?: string | null;
  /**
   * True when the user has a connected ChatGPT Plus/Pro/Team subscription
   * (instaclaw_users.openai_oauth_access_token + openai_oauth_account_id
   * are both set). Threaded from the caller so this function's pre-flight
   * validation doesn't need its own DB lookup. When true, byok-without-
   * apiKey is acceptable — the VM is provisioned in `byok` state and the
   * reconciler upgrades it to `chatgpt_oauth` on its next tick. Default
   * false to preserve back-compat for existing callers.
   */
  hasChatGPTOAuth?: boolean;
  /** Anthropic model string the agent defaults to (e.g., "anthropic/claude-sonnet-4-6"). */
  defaultModel: string;
  /**
   * Telegram bot token minted at signup. Nullable from 2026-05-27 — null
   * is acceptable for channel-first users (iMessage / shared bot) who
   * don't host an on-VM Telegram plugin. validateCreateUserVMParams
   * requires it only when channels.includes("telegram").
   */
  telegramBotToken: string | null;
  /**
   * Telegram bot username (without @). 5-32 chars [A-Za-z0-9_].
   * Nullable for the same reason as telegramBotToken.
   */
  telegramBotUsername: string | null;
  /** Discord bot token. Required iff "discord" is in channels. */
  discordBotToken?: string | null;
  /**
   * Channel allow-list. Default: ["telegram"].
   * - BYOB Telegram: ["telegram"]
   * - Discord-enabled: includes "discord"
   * - Channel-first (iMessage / shared bot): [] — gateway runs without
   *   an on-VM messaging plugin; backend relays via lib/channel-routing
   * Empty array IS valid from 2026-05-27.
   */
  channels?: string[];
  /** Partner tag (edge_city, consensus_2026, etc.). Null for vanilla users. */
  partner?: string | null;
  /** IANA timezone (e.g., "America/New_York"). Optional. */
  userTimezone?: string | null;
  /** Linode region slug. Default LINODE_DEFAULTS.region ("us-east"). */
  region?: string;
}

export interface CreateUserVMResult {
  /** instaclaw_vms.id (UUID). */
  vmId: string;
  /** instaclaw-vm-XXX name. */
  vmName: string;
  /** Linode instance ID. */
  providerServerId: string;
  /** First IPv4 address. */
  ipAddress: string;
  /** Server-minted config token (also persisted in DB). */
  configToken: string;
  /** Server-minted callback token (also persisted in DB). */
  callbackToken: string;
  /**
   * Gateway auth token minted at provision time (64-char hex via
   * generateGatewayToken). Persisted in instaclaw_vms.gateway_token at
   * Phase A INSERT. buildParamsFromVmRow reads this column to populate
   * the cloud-init tarball's setup.sh (writes it into openclaw.json's
   * `gateway.auth.token`, `.env GATEWAY_TOKEN`, and auth-profiles.json).
   *
   * The pool path mints the equivalent inside configureOpenClaw
   * (lib/ssh.ts:5170). createUserVM skips configureOpenClaw entirely —
   * setup.sh handles config on-VM — so we mint here so the row is never
   * observable in an `assigned`-with-no-token state (per Rule 41 CHECK
   * constraint in supabase/migrations/20260513170000_rule41_assigned_has_gateway_token.sql).
   */
  gatewayToken: string;
}

// Subset of the supabase client surface this function actually uses. Tests
// pass a stub implementing only these. ESLint-disabled on the explicit-any
// because supabase-js's `.from()` chain types are intentionally erased to
// keep this file decoupled from the schema-types generator.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SupabaseLike = any;

export interface CreateUserVMDeps {
  supabase?: SupabaseLike;
  provider?: CloudProvider;
  /**
   * Override the canonical NEXTAUTH_URL source. Production uses process.env;
   * tests inject a fixed value so they don't depend on shell state.
   */
  nextauthUrl?: string;
}

// ════════════════════════════════════════════════════════════════════════
// §2. Validation
// ════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TG_BOT_USERNAME_RE = /^[a-zA-Z0-9_]{5,32}$/;

/**
 * Validate params at the boundary. Throws with a precise pointer to the
 * upstream caller bug. Mirrors buildParamsFromVmRow's required-field
 * policy so a row that passes createUserVM's check will also pass the
 * cloud-init-config endpoint's row→params construction.
 */
export function validateCreateUserVMParams(p: CreateUserVMParams): void {
  if (!p.userId) throw new Error("createUserVM: userId required");
  if (!UUID_RE.test(p.userId)) {
    throw new Error(`createUserVM: userId must be a UUID (got "${p.userId}")`);
  }
  if (typeof p.tier !== "string" || p.tier.trim() === "") {
    throw new Error(
      `createUserVM: tier required (got ${JSON.stringify(p.tier)}). ` +
        "Per Cooper 2026-05-13: tier must never be NULL at provisioning time.",
    );
  }
  if (p.apiMode !== "all_inclusive" && p.apiMode !== "byok") {
    throw new Error(`createUserVM: apiMode must be "all_inclusive" or "byok" (got "${p.apiMode}")`);
  }
  // 2026-05-30: byok with null apiKey AND no OAuth is now a valid
  // pre-provisioning state. The user has paid via Stripe but hasn't yet
  // completed /onboarding/provider (key entry or ChatGPT connect). The VM
  // boots in BYOK mode with an empty Anthropic profile; agent runs but
  // Anthropic calls fail until the user adds a provider (or the
  // reconciler's stepChatGPTOAuthToken installs one from a later connect).
  if (!p.defaultModel) throw new Error("createUserVM: defaultModel required");
  const channels = p.channels ?? ["telegram"];
  if (!Array.isArray(channels)) {
    throw new Error("createUserVM: channels must be an array");
  }
  // Telegram bits required ONLY when on-VM telegram plugin will be loaded.
  // Channel-first users (iMessage / shared bot) pass channels=[] and null
  // telegram tokens — they don't host the plugin; backend relays via
  // lib/channel-routing. Pre-2026-05-27 these were unconditionally required;
  // the loosened gate enables cloud-init for channel-first signups.
  if (channels.includes("telegram")) {
    if (!p.telegramBotToken)
      throw new Error(
        "createUserVM: channels includes 'telegram' but telegramBotToken is missing",
      );
    if (!p.telegramBotUsername)
      throw new Error(
        "createUserVM: channels includes 'telegram' but telegramBotUsername is missing",
      );
    if (!TG_BOT_USERNAME_RE.test(p.telegramBotUsername)) {
      throw new Error(
        `createUserVM: telegramBotUsername "${p.telegramBotUsername}" doesn't match ${TG_BOT_USERNAME_RE}`,
      );
    }
  }
  if (channels.includes("discord") && !p.discordBotToken) {
    throw new Error("createUserVM: channels includes 'discord' but discordBotToken is missing");
  }
}

// ════════════════════════════════════════════════════════════════════════
// §3. Token minting
// ════════════════════════════════════════════════════════════════════════

/**
 * Mint a one-time-use token: 32 bytes of cryptographic randomness,
 * hex-encoded → 64 ASCII chars. Matches the format the endpoints validate
 * (HEX_TOKEN_RE in cloud-init-config + cloud-init-callback route handlers).
 */
function mintToken(): string {
  return randomBytes(32).toString("hex");
}

// ════════════════════════════════════════════════════════════════════════
// §4. Name allocation
// ════════════════════════════════════════════════════════════════════════

/**
 * Pick the next available vmName by querying the most-recent 200 existing
 * names and computing `instaclaw-vm-${maxNum + 1}`. Race-safety against
 * concurrent createUserVM calls is handled at the DB layer via the
 * UNIQUE constraint on instaclaw_vms.name — the caller retries on
 * 23505 unique_violation.
 *
 * The 200-row sample is a finite-history lookback. If two concurrent
 * provisioners both compute the same next number, exactly one wins at
 * the INSERT; the other gets 23505 and retries with a fresh sample
 * (which now includes the winner's name).
 */
async function allocateVmName(supabase: SupabaseLike): Promise<string> {
  const { data: existing } = await supabase
    .from("instaclaw_vms")
    .select("name")
    .order("created_at", { ascending: false })
    .limit(200);
  const names = (existing ?? []).map((v: { name: string | null }) => v.name).filter(Boolean) as string[];
  const num = getNextVmNumber(names);
  return formatVmName(num);
}

// ════════════════════════════════════════════════════════════════════════
// §5. Main
// ════════════════════════════════════════════════════════════════════════

const MAX_NAME_COLLISION_RETRIES = 3;

export async function createUserVM(
  p: CreateUserVMParams,
  deps: CreateUserVMDeps = {},
): Promise<CreateUserVMResult> {
  validateCreateUserVMParams(p);

  const supabase = deps.supabase ?? getSupabase();
  const provider = deps.provider ?? linodeProvider;
  const nextauthUrl = deps.nextauthUrl ?? process.env.NEXTAUTH_URL;
  if (!nextauthUrl) {
    throw new Error(
      "createUserVM: NEXTAUTH_URL not set in process.env (and no override passed via deps). " +
        "Vercel project misconfigured — every env (production / preview / development) " +
        "must have NEXTAUTH_URL set to the canonical https://instaclaw.io URL.",
    );
  }

  const channels = p.channels ?? ["telegram"];
  const region = p.region ?? "us-east";

  // ── Phase A: allocate name + insert row (retry on UNIQUE collision) ──
  let vmName = "";
  let vmId = "";
  let configToken = "";
  let callbackToken = "";
  let gatewayToken = "";

  for (let attempt = 0; attempt < MAX_NAME_COLLISION_RETRIES; attempt++) {
    const candidate = await allocateVmName(supabase);
    const ct = mintToken();
    const cb = mintToken();
    // Pool-path parity: configureOpenClaw mints gateway_token via
    // generateGatewayToken() at lib/ssh.ts:5170. We mint it HERE (Phase A
    // INSERT) so buildParamsFromVmRow's `requireStr("gateway_token")` read
    // never throws on a freshly-provisioned cloud-init row.
    const gw = generateGatewayToken();

    // Row-first atomicity: insert with the per-VM tokens so the cloud-init-
    // config endpoint can claim against the row when the bootstrap's curl
    // arrives. NO ip_address / provider_server_id yet — those land in Phase C.
    const { data, error } = await supabase
      .from("instaclaw_vms")
      .insert({
        name: candidate,
        assigned_to: p.userId,
        status: "provisioning",
        created_via: "on_demand",
        cloud_init_config_token: ct,
        cloud_init_callback_token: cb,
        gateway_token: gw,
        provider: "linode",
        ssh_port: 22,
        ssh_user: "openclaw",
        region,
        tier: p.tier,
        api_mode: p.apiMode,
        // Belt-and-suspenders for the 2026-06-02 gbrain default flip: set the
        // flag explicitly at assignment so the DB column reflects reality
        // (true, not NULL) for observability/audits. Functionally redundant
        // with isGbrainEligibleForVM's new NULL→true default, but makes intent
        // explicit and survives any future re-narrowing of that default.
        // Atomic part of the row INSERT — no added failure surface.
        gbrain_enabled: true,
        // 2026-05-21 P0: removed `api_key: p.apiKey ?? null` — the column
        // never existed on instaclaw_vms (verified 126-col schema probe vs
        // 'api_key' lookup returns false). The INSERT failed for shelpinc's
        // signup with PostgREST 'Could not find the api_key column in the
        // schema cache'. For all_inclusive users (most signups), apiKey is
        // null anyway. For BYOK users, the api_key needs to be routed
        // through pending_users.api_key to the tarball builder — separate
        // migration needed to either ADD the column (and re-introduce this
        // INSERT) or refactor buildParamsFromVmRow to read from
        // pending_users instead. Flagged in task #126.
        default_model: p.defaultModel,
        telegram_bot_token: p.telegramBotToken,
        telegram_bot_username: p.telegramBotUsername,
        discord_bot_token: p.discordBotToken ?? null,
        channels_enabled: channels,
        partner: p.partner ?? null,
        user_timezone: p.userTimezone ?? null,
      })
      .select("id, name")
      .single();

    if (!error && data) {
      vmName = (data as { name: string }).name;
      vmId = (data as { id: string }).id;
      configToken = ct;
      callbackToken = cb;
      gatewayToken = gw;
      break;
    }

    // PostgREST surfaces Postgres UNIQUE-violation as code "23505"
    // (mapped from Supabase's error.code field for the underlying SQL
    // state). On collision, log + retry with a fresh name lookup. Any
    // OTHER error is non-recoverable.
    if (error?.code === "23505") {
      logger.warn("createUserVM: name collision, retrying", {
        route: "lib/createUserVM",
        candidate,
        attempt: attempt + 1,
        maxAttempts: MAX_NAME_COLLISION_RETRIES,
      });
      continue;
    }
    throw new Error(
      `createUserVM: row insert failed: ${error?.message ?? "unknown supabase error"}`,
    );
  }

  if (!vmName) {
    throw new Error(
      `createUserVM: vmName allocation failed after ${MAX_NAME_COLLISION_RETRIES} attempts ` +
        `— too many concurrent provisioners or vm-numbering is broken. Investigate.`,
    );
  }

  // ── Phase B: build user_data + Linode createServer ──
  const userData = buildCloudInitUserdata({
    userId: p.userId,
    vmName,
    configToken,
    nextauthUrl,
  });

  let providerId: string;
  try {
    const created: ServerResult = await provider.createServer({ name: vmName, userData });
    providerId = created.providerId;
  } catch (createErr) {
    // Row remains in 'provisioning' state with no IP / no provider_server_id.
    // cloud-init-poll's 30-min timeout sweep will mark status='failed' and
    // clear assigned_to. Acceptable per the failure-mode contract.
    logger.error("createUserVM: Linode createServer failed (row stays provisioning)", {
      route: "lib/createUserVM",
      vmId,
      vmName,
      error: createErr instanceof Error ? createErr.message : String(createErr),
    });
    throw createErr;
  }

  // Stamp provider_server_id immediately so admin can locate the Linode
  // for cleanup if waitForServer hangs or the IP-update fails below.
  // Best-effort: a failed stamp leaves the Linode orphan-discoverable
  // only via name-prefix scan; logged but doesn't throw.
  try {
    const { error: stampErr } = await supabase
      .from("instaclaw_vms")
      .update({ provider_server_id: providerId })
      .eq("id", vmId);
    if (stampErr) {
      logger.warn("createUserVM: provider_server_id stamp failed (non-fatal)", {
        route: "lib/createUserVM",
        vmId,
        vmName,
        providerId,
        error: stampErr.message,
      });
    }
  } catch (stampThrow) {
    logger.warn("createUserVM: provider_server_id stamp threw (non-fatal)", {
      route: "lib/createUserVM",
      vmId,
      vmName,
      providerId,
      error: stampThrow instanceof Error ? stampThrow.message : String(stampThrow),
    });
  }

  let ready: ServerResult;
  try {
    ready = await provider.waitForServer(providerId);
  } catch (waitErr) {
    logger.error("createUserVM: waitForServer failed (Linode exists, row has provider_server_id)", {
      route: "lib/createUserVM",
      vmId,
      vmName,
      providerId,
      error: waitErr instanceof Error ? waitErr.message : String(waitErr),
    });
    throw waitErr;
  }

  // ── Phase C: finalize row with IP + server_type ──
  // server_type comes from Linode (whatever type was assigned —
  // linodeProvider uses LINODE_DEFAULTS.type which is "g6-dedicated-2"
  // per CLAUDE.md). Mirrors the pool path (admin/provision/route.ts:106
  // sets `server_type: ready.serverType` for consistency).
  const { error: ipUpdateErr } = await supabase
    .from("instaclaw_vms")
    .update({ ip_address: ready.ip, server_type: ready.serverType })
    .eq("id", vmId);
  if (ipUpdateErr) {
    // Orphaned: Linode VM running + row exists with provider_server_id but
    // no IP. Admin must reconcile via Linode UI or a sweep cron. Rare path.
    logger.error("createUserVM: IP update failed (orphan Linode + row without IP)", {
      route: "lib/createUserVM",
      vmId,
      vmName,
      providerId,
      ip: ready.ip,
      error: ipUpdateErr.message,
    });
    throw new Error(`createUserVM: row IP update failed: ${ipUpdateErr.message}`);
  }

  logger.info("createUserVM: provisioned", {
    route: "lib/createUserVM",
    vmId,
    vmName,
    providerId,
    ip: ready.ip,
    tier: p.tier,
    partner: p.partner ?? null,
    configTokenPrefix: configToken.slice(0, 8),
  });

  return {
    vmId,
    vmName,
    providerServerId: providerId,
    ipAddress: ready.ip,
    configToken,
    callbackToken,
    gatewayToken,
  };
}

// ════════════════════════════════════════════════════════════════════════
// §6. assignOrProvisionUserVm — the wire-up wrapper (Phase 1B-1)
// ════════════════════════════════════════════════════════════════════════
//
// Single switch between the legacy pool path (assignVMWithSSHCheck) and
// the new cloud-init path (createUserVM). Gated by the env-var
// CLOUD_INIT_ONDEMAND_ENABLED. Three callsites use this wrapper:
//   - app/api/billing/webhook/route.ts:469 (Stripe checkout-completed)
//   - app/api/cron/process-pending/route.ts:276 (Pass 0 orphan recovery)
//   - app/api/cron/process-pending/route.ts:371 (Pass 1 pending retry)
//
// Both paths return a uniform shape; callers branch on `path` to decide
// whether to call /api/vm/configure (pool) or skip (cloud-init —
// setup.sh handles configure on-VM).
//
// Error semantics (Cooper's directive 2026-05-15):
//   - Pool empty                 → return null (existing contract).
//   - Cloud-init config errors   → THROW clear error (missing
//     pending_users, missing telegram_bot_*). Caller wraps in try/catch;
//     log it loudly, treat as "send pending email + retry next cycle".
//   - Cloud-init transient errors (Linode rate-limit, etc.) → THROW.
//     Same caller treatment.
//
// The throw vs null split is deliberate: null is the "no VM, try later"
// signal that callers' existing fallback path already handles. Throws
// signal "something is wrong upstream" and surface in logs for operator
// attention — but the caller's try/catch keeps the webhook/cron from
// crashing on permanent state corruption.

/**
 * Subset of the pool-VM row shape returned by `assignVMWithSSHCheck`'s
 * underlying RPC. Cloud-init path constructs an equivalent partial in
 * memory so callers can use the same `result.vm.*` field access.
 */
export interface AssignedVmShape {
  id: string;
  ip_address: string;
  /** Optional — present when known; SSH-side bot username for VM-ready emails. */
  telegram_bot_username?: string;
  /** Pool RPC may include other columns; permissive to avoid coupling. */
  [key: string]: unknown;
}

export interface AssignOrProvisionResult {
  vmId: string;
  ipAddress: string;
  /**
   * Discriminator. Callers branch to decide whether to run /api/vm/configure.
   *
   * - "pool"       — VM claimed atomically from the ready pool via
   *                  instaclaw_assign_vm RPC. Fast path (~30s to working).
   *                  Caller should run /api/vm/configure to wire up
   *                  channel-specific tokens, gateway, wallets, etc.
   * - "cloud-init" — pool was empty + CLOUD_INIT_ONDEMAND_ENABLED=true.
   *                  Slow path (~5-10 min for VM to boot + bonjour to
   *                  settle). Caller does NOT run configure (cloud-init
   *                  bakes the same config into the boot script).
   * - "existing"   — user ALREADY HAS an assigned VM. We refuse to
   *                  create a duplicate and return the existing row.
   *                  P1 billing-leak fix (2026-05-28): a signed-in user
   *                  could open incognito, /start a new Telegram bot,
   *                  trigger inbound webhook → pending row → /auth →
   *                  assignOrProvisionUserVm fired a SECOND time on the
   *                  same user_id, pool-claimed another VM, and the
   *                  existing-sub branch in /api/billing/checkout skipped
   *                  Stripe — net result: two VMs under one subscription.
   *                  Caller should NOT run configure (the existing VM is
   *                  already configured) — it should route the user
   *                  to /dashboard or /deploying based on health_status.
   */
  path: "pool" | "cloud-init" | "existing";
  /** Partial row. Always includes id + ip_address; pool path includes everything
   *  the underlying RPC returned; cloud-init includes telegram_bot_username;
   *  existing includes id, ip_address, status, health_status, telegram_bot_username. */
  vm: AssignedVmShape;
}

export interface AssignOrProvisionDeps {
  supabase?: SupabaseLike;
  /** Inject for tests: substitute the pool-assign function. */
  poolAssignFn?: (userId: string) => Promise<AssignedVmShape | null>;
  /** Inject for tests: substitute createUserVM. */
  createUserVMFn?: typeof createUserVM;
  /** Inject for tests: override the env-var flag value. When undefined,
   *  reads process.env.CLOUD_INIT_ONDEMAND_ENABLED at call time. */
  flagOverride?: string;
  /** Override the canonical NEXTAUTH_URL source (passed through to
   *  createUserVM when cloud-init path takes over). */
  nextauthUrl?: string;
}

export async function assignOrProvisionUserVm(
  userId: string,
  deps: AssignOrProvisionDeps = {},
): Promise<AssignOrProvisionResult | null> {
  const supabase = deps.supabase ?? getSupabase();
  const poolAssignFn = deps.poolAssignFn ?? assignVMWithSSHCheck;
  const createUserVMFn = deps.createUserVMFn ?? createUserVM;
  const flag = deps.flagOverride ?? process.env.CLOUD_INIT_ONDEMAND_ENABLED ?? "";
  const useCloudInit = flag === "true";

  // ═════════════════════════════════════════════════════════════════════
  // LAYER 1 — billing-leak guard (P1 fix, 2026-05-28).
  // ═════════════════════════════════════════════════════════════════════
  //
  // Vulnerability: a signed-in user could open incognito, /start a new
  // Telegram bot, trigger the inbound webhook → pending row → /auth →
  // assignOrProvisionUserVm fired a SECOND time on the same user_id.
  // The pool RPC happily claimed another VM (it has no user-existing
  // check — instaclaw_assign_vm only filters status='ready'); the
  // existing-sub branch at /api/billing/checkout skipped Stripe; net
  // result: two VMs under one subscription. Same attack works via the
  // /onboarding/web skip path, /api/checkout/verify, /api/vm/assign,
  // and /api/billing/webhook subscription.created — every caller of
  // this function was a leak.
  //
  // The fix lives HERE (the chokepoint) so every caller is protected
  // without requiring 6 separate edits + 6 chances to miss one. If a
  // future code path adds a new call site, the guard catches it too.
  //
  // What counts as "user already has a VM":
  //   - status='assigned'    — active VM (any health: healthy,
  //                            hibernating, suspended, configure_failed,
  //                            unknown). All of these are "user has a
  //                            VM — don't create another."
  //   - status='provisioning'— in-flight cloud-init for this user.
  //                            Starting a second cloud-init would race.
  //
  // What does NOT count (allows new provision):
  //   - status='terminated'  — VM destroyed, user legitimately needs a
  //                            new one
  //   - status='destroyed'   — same
  //   - status='failed'      — never provisioned successfully; new
  //                            attempt allowed
  //   - status='frozen'      — archived to R2. Thaw path (lib/vm-freeze-
  //                            thaw.ts:thawVM) is the correct recovery,
  //                            not a fresh provision. This guard
  //                            doesn't intercept frozen state — the
  //                            thaw flow is handled separately by the
  //                            dashboard layout + /deploying retry UI.
  //
  // Race-safety note: this is a SELECT-then-POOL-CLAIM pattern, which
  // is sequentially safe but not concurrent-safe. Two simultaneous
  // calls could both see no-existing-VM and both pool-claim. The
  // realistic attack (incognito second browser, separate request)
  // is sequential and caught here. Concurrent-safe defense needs a
  // partial UNIQUE INDEX on instaclaw_vms(assigned_to) WHERE
  // status='assigned' — tracked as a P2 schema follow-up.
  const { data: existingVm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, status, health_status, telegram_bot_username")
    .eq("assigned_to", userId)
    .in("status", ["assigned", "provisioning"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingVm) {
    logger.warn(
      "assignOrProvisionUserVm: user already has an active VM — refusing to create a duplicate (returning existing)",
      {
        route: "lib/createUserVM",
        userId,
        existingVmId: String(existingVm.id),
        existingStatus: existingVm.status,
        existingHealth: existingVm.health_status,
      },
    );
    return {
      vmId: String(existingVm.id),
      ipAddress: String(existingVm.ip_address ?? ""),
      path: "existing",
      vm: existingVm as AssignedVmShape,
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  // POOL FIRST — try pool path regardless of CLOUD_INIT_ONDEMAND_ENABLED.
  // ═════════════════════════════════════════════════════════════════════
  //
  // 2026-05-22: changed semantics. Previously CLOUD_INIT_ONDEMAND_ENABLED
  // was a hard toggle (when true, EVERY signup went through cloud-init
  // even when pool VMs were available). That sacrificed ~5-10 min of UX
  // per signup unnecessarily.
  //
  // New semantics: pool path is the ALWAYS-PREFERRED fast path. Pool VMs
  // are pre-warmed and reach "working bot" in ~30 seconds via the
  // assignVMWithSSHCheck → configureOpenClaw flow. Cloud-init is the
  // FALLBACK when the pool is empty (~5-10 min from cold Linode boot,
  // bonjour, channel init, etc).
  //
  // CLOUD_INIT_ONDEMAND_ENABLED is now the gate on the FALLBACK only.
  // When the pool is empty:
  //   - flag=true  → cloud-init takes over, user gets a VM in 5-10 min
  //                  instead of the "pending email" experience.
  //   - flag=false → legacy behavior. Return null so the caller sends
  //                  pending email + process-pending retries.
  //
  // This is the Edge Esmeralda architecture: pool serves the common case
  // (most attendees in a 30s window), cloud-init is the safety net for
  // surge moments that exceed pool capacity.
  //
  // assignVMWithSSHCheck atomically claims a status='ready' VM via the
  // `instaclaw_assign_vm` Postgres RPC. Returns null when pool is empty.
  // Any error in this function propagates up (no swallowing — caller
  // decides whether to retry vs send pending email).
  const poolVm = await poolAssignFn(userId);
  if (poolVm) {
    logger.info("assignOrProvisionUserVm: pool path (fast)", {
      route: "lib/createUserVM",
      userId,
      vmId: String(poolVm.id),
    });
    // Belt-and-suspenders for the 2026-06-02 gbrain default flip: the pool
    // is claimed via the `instaclaw_assign_vm` RPC, which doesn't touch
    // gbrain_enabled, so a pool VM lands with the snapshot's NULL. Set it
    // true explicitly so the DB reflects reality. Best-effort + non-fatal:
    // isGbrainEligibleForVM's NULL→true default already makes the VM
    // eligible, so a failure here is purely cosmetic (loses the explicit
    // flag, not the capability). Never block assignment on it.
    try {
      await supabase
        .from("instaclaw_vms")
        .update({ gbrain_enabled: true })
        .eq("id", poolVm.id);
    } catch (e) {
      logger.warn("assignOrProvisionUserVm: gbrain_enabled set failed (non-fatal; NULL→true default covers it)", {
        route: "lib/createUserVM",
        vmId: String(poolVm.id),
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return {
      vmId: String(poolVm.id),
      ipAddress: String(poolVm.ip_address),
      path: "pool",
      vm: poolVm,
    };
  }

  // Pool is empty. Fall back based on CLOUD_INIT_ONDEMAND_ENABLED flag.
  if (!useCloudInit) {
    // Legacy behavior (cloud-init NOT enabled): return null so the caller
    // sends the pending email + process-pending retries until pool has
    // capacity again.
    logger.info("assignOrProvisionUserVm: pool empty + cloud-init disabled → null", {
      route: "lib/createUserVM",
      userId,
    });
    return null;
  }

  // ── Cloud-init fallback (Phase 1B-1, 2026-05-22 demoted to fallback) ──
  //
  // Pool was empty AND CLOUD_INIT_ONDEMAND_ENABLED=true → provision a
  // fresh per-user VM via cloud-init. Slower (~5-10 min) but unblocks the
  // user immediately instead of waiting for pool replenishment.
  //
  // Reads per-user config from pending_users + instaclaw_users, mirrors
  // the fallback chain at /api/vm/configure:206-217, calls createUserVM.
  //
  // Validation errors (missing pending_users row, missing telegram_bot_*)
  // throw with a clear pointer to the upstream signup-flow bug. Linode/DB
  // errors inside createUserVM also throw — caller's try/catch normalizes
  // both classes to a "send pending email + retry" outcome.
  logger.info("assignOrProvisionUserVm: pool empty → cloud-init fallback (slow)", {
    route: "lib/createUserVM",
    userId,
  });
  const { data: pending, error: pendingErr } = await supabase
    .from("instaclaw_pending_users")
    .select(
      "tier, api_mode, api_key, default_model, telegram_bot_token, telegram_bot_username, discord_bot_token, channel, channel_identity",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingErr) {
    throw new Error(
      `assignOrProvisionUserVm: pending_users lookup failed for userId=${userId}: ` +
        pendingErr.message,
    );
  }
  if (!pending) {
    throw new Error(
      `assignOrProvisionUserVm: no pending_users row for userId=${userId}. ` +
        "User reached the VM-provision trigger (Stripe webhook or process-pending) " +
        "but pending_users was never populated. Check /api/onboarding/save and " +
        "the signup wizard's bot-capture step. process-pending will retry next cycle.",
    );
  }

  // ─── Channel-first vs BYOB routing ──
  //
  // BYOB (legacy /signup → /connect path, pending.channel === null):
  //   - User created a bot via BotFather, pasted the token at /connect.
  //   - VM hosts the telegram plugin → channels=["telegram"], token required.
  //   - Missing token here means the signup wizard didn't capture it →
  //     throw clearly so the operator + retry logic can fix upstream.
  //
  // Channel-first (iMessage / shared bot, pending.channel !== null):
  //   - Inbound webhook created the pending row from a phone/chat_id; no
  //     BotFather token exists for this user.
  //   - VM runs WITHOUT a telegram plugin → channels=[], tokens=null.
  //   - Backend relays inbound/outbound via lib/channel-routing.
  //   - Cloud-init tarball builder handles null tokens + empty channels
  //     from 2026-05-27 (the P0-2 workaround that returned null here is
  //     no longer needed).
  const isChannelFirst = !!pending.channel;
  if (!isChannelFirst) {
    // BYOB-only strict checks (Cooper directive 2026-05-15): telegram_bot_*
    // are user-supplied and have no sane fallback. Throw a clear error
    // rather than silently provisioning a VM that won't work.
    if (!pending.telegram_bot_token) {
      throw new Error(
        `assignOrProvisionUserVm: pending_users.telegram_bot_token NULL for userId=${userId} ` +
          "(BYOB path). User must complete bot-token capture (signup wizard step). " +
          "process-pending will retry next cycle once the value is persisted.",
      );
    }
    if (!pending.telegram_bot_username) {
      throw new Error(
        `assignOrProvisionUserVm: pending_users.telegram_bot_username NULL for userId=${userId} ` +
          "(BYOB path).",
      );
    }
  }

  const { data: user, error: userErr } = await supabase
    .from("instaclaw_users")
    .select(
      "partner, user_timezone, openai_oauth_access_token, openai_oauth_account_id",
    )
    .eq("id", userId)
    .maybeSingle();
  if (userErr) {
    // Soft failure — log + continue with undefined partner/timezone.
    // user row should always exist by the time we reach here (signup
    // creates it before checkout), but defensive against a transient
    // PostgREST error.
    logger.warn("assignOrProvisionUserVm: instaclaw_users lookup error (proceeding with nulls)", {
      route: "lib/createUserVM",
      userId,
      error: userErr.message,
    });
  }

  // Fallback chain mirrors /api/vm/configure:206-217 byte-for-byte.
  const tier = pending.tier ?? "starter";
  const apiMode = (pending.api_mode ?? "all_inclusive") as "all_inclusive" | "byok";
  const defaultModel = pending.default_model ?? "anthropic/claude-sonnet-4-6";

  // hasChatGPTOAuth: read from instaclaw_users — when true, byok-without-
  // apiKey is acceptable. The reconciler's stepChatGPTOAuthToken pushes
  // the OAuth token to disk on the first reconcile tick after VM is up
  // (vm-reconcile.ts:11183), upgrading api_mode "byok" → "chatgpt_oauth".
  const hasChatGPTOAuth = !!(
    user?.openai_oauth_access_token && user?.openai_oauth_account_id
  );

  // channels: channel-first users have NO on-VM messaging plugin (backend
  // relays via lib/channel-routing). BYOB users have ["telegram"]; if
  // discord_bot_token is present, also include "discord".
  const cloudInitChannels: string[] = isChannelFirst ? [] : ["telegram"];
  if (!isChannelFirst && pending.discord_bot_token) {
    cloudInitChannels.push("discord");
  }

  logger.info("assignOrProvisionUserVm: cloud-init path", {
    route: "lib/createUserVM",
    userId,
    tier,
    apiMode,
    hasChatGPTOAuth,
    partner: user?.partner ?? null,
    isChannelFirst,
    channelFirstChannel: pending.channel ?? null,
    cloudInitChannels,
  });

  const result = await createUserVMFn(
    {
      userId,
      tier,
      apiMode,
      apiKey: pending.api_key,
      hasChatGPTOAuth,
      defaultModel,
      telegramBotToken: pending.telegram_bot_token ?? null,
      telegramBotUsername: pending.telegram_bot_username ?? null,
      discordBotToken: pending.discord_bot_token,
      channels: cloudInitChannels,
      partner: user?.partner ?? null,
      userTimezone: user?.user_timezone ?? null,
    },
    deps.nextauthUrl ? { nextauthUrl: deps.nextauthUrl } : undefined,
  );

  return {
    vmId: result.vmId,
    ipAddress: result.ipAddress,
    path: "cloud-init",
    vm: {
      id: result.vmId,
      ip_address: result.ipAddress,
      telegram_bot_username: pending.telegram_bot_username,
    },
  };
}
