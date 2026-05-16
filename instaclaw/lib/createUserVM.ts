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
  /** BYOK only — the user's own Anthropic API key. Required when apiMode='byok'. */
  apiKey?: string | null;
  /** Anthropic model string the agent defaults to (e.g., "anthropic/claude-sonnet-4-6"). */
  defaultModel: string;
  /** Telegram bot token minted at signup. */
  telegramBotToken: string;
  /** Telegram bot username (without @). 5-32 chars [A-Za-z0-9_]. */
  telegramBotUsername: string;
  /** Discord bot token. Required iff "discord" is in channels. */
  discordBotToken?: string | null;
  /** Channel allow-list. Default: ["telegram"]. Non-empty required. */
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
  if (p.apiMode === "byok" && !p.apiKey) {
    throw new Error('createUserVM: apiMode="byok" requires apiKey to be set');
  }
  if (!p.defaultModel) throw new Error("createUserVM: defaultModel required");
  if (!p.telegramBotToken) throw new Error("createUserVM: telegramBotToken required");
  if (!p.telegramBotUsername) throw new Error("createUserVM: telegramBotUsername required");
  if (!TG_BOT_USERNAME_RE.test(p.telegramBotUsername)) {
    throw new Error(
      `createUserVM: telegramBotUsername "${p.telegramBotUsername}" doesn't match ${TG_BOT_USERNAME_RE}`,
    );
  }
  const channels = p.channels ?? ["telegram"];
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error("createUserVM: channels must be a non-empty array (default ['telegram'])");
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

  for (let attempt = 0; attempt < MAX_NAME_COLLISION_RETRIES; attempt++) {
    const candidate = await allocateVmName(supabase);
    const ct = mintToken();
    const cb = mintToken();

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
        provider: "linode",
        ssh_port: 22,
        ssh_user: "openclaw",
        region,
        tier: p.tier,
        api_mode: p.apiMode,
        api_key: p.apiKey ?? null,
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
  };
}
