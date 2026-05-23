/**
 * Index Network JIT (just-in-time) provisioning helper.
 *
 * Closes the post-onboarding race between (a) the user completing
 * /deploying + landing on /edge/intents and (b) the reconciler's
 * stepIndexProvision (v105) firing to mint the user's Index Network
 * API key. The reconciler runs every ~3 min; a user who walks through
 * onboarding in <90 s reliably reaches /edge/intents BEFORE the first
 * reconciler tick, hits `index_api_key IS NULL`, and gets the
 * "your edge city setup isn't fully online yet. give it a minute and
 * try again." error.
 *
 * That error is unacceptable UX after a 7-screen onboarding. This
 * helper eliminates the race by minting the Index API key inline on
 * the FIRST intent submission when the key is missing. Typical
 * additional latency: ~2-5 s (one Index /signup call + one DB write).
 * The user sees "Send it" pending for that window, then success — no
 * visible error, no manual retry.
 *
 * What this DOESN'T do: write the on-disk MCP block in openclaw.json.
 * That's separate — the reconciler's stepIndexProvision owns it. The
 * agent on the VM doesn't need it for the user's first intent (the
 * intent is submitted server-side via lib/index-mcp-client.ts with
 * the just-minted key from the DB). The MCP block lands within the
 * next ~3 min so the AGENT can use Index tools subsequently.
 *
 * Idempotency: if `index_api_key` is already populated (the reconciler
 * beat us to it, or this is a repeat submission), this is a no-op
 * lookup. Never double-signs.
 *
 * Failure mode: returns ok:false so the caller can decide. The
 * existing /api/edge/express-intent error mapping handles it — the
 * user sees the "coming online soon" message, same as today, but
 * only for true Index-Network failures rather than for normal race
 * conditions.
 */
import { getSupabase } from "./supabase";
import { logger } from "./logger";
import {
  callIndexSignup,
  IndexSignupError,
} from "./index-network-client";

export interface JitProvisionResult {
  /** True if the user has valid Index credentials at the end of this
   *  call (either pre-existing or freshly minted). */
  ok: boolean;
  /** Set when ok=true. Stable identifier for the Index user. */
  indexUserId?: string;
  /** Reason for failure; only set when ok=false. Used for logger
   *  classification, not user-facing copy. */
  reason?:
    | "no_vm"
    | "not_edge_city"
    | "user_lookup_failed"
    | "signup_failed"
    | "db_write_failed"
    | "config_error";
  /** Whether this call actually minted credentials (true) vs. found
   *  pre-existing ones (false). For logging only. */
  minted?: boolean;
  /** Short error detail for operator logs. */
  detail?: string;
}

/**
 * Ensure the user has Index Network credentials in the DB. If missing,
 * mint them by calling Index `/signup` directly + writing to DB.
 *
 * Pre-conditions:
 *   - Caller has validated session + user is partner=edge_city
 *   - Caller has done the partner gate (we re-check defensively here)
 *
 * Side effects on success:
 *   - instaclaw_vms.index_user_id, index_api_key, index_provisioned_at
 *     are populated on the user's assigned edge_city VM
 *   - One Index Network /signup call (mints a new user on their side)
 *
 * Side effects on failure: none destructive. The DB is left in its
 * existing state (no partial writes). Caller surfaces the friendly
 * "coming online soon" message.
 *
 * Timeout budget: ~5s (Index /signup typical) + ~500 ms (DB write).
 * Under the 60s Vercel function maxDuration on the parent route.
 */
export async function ensureIndexCredentials(
  userId: string,
): Promise<JitProvisionResult> {
  const supabase = getSupabase();

  // 1. Look up user's assigned edge_city VM. Use .select("*") per Rule 19
  //    — column-grant misconfig would otherwise silently return null for
  //    index_api_key and cause us to repeat the signup loop forever.
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", userId)
    .eq("partner", "edge_city")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (vmErr) {
    logger.warn("[index-jit] vm lookup failed", {
      userIdPrefix: userId.slice(0, 8),
      err: vmErr.message,
    });
    return {
      ok: false,
      reason: "user_lookup_failed",
      detail: vmErr.message.slice(0, 200),
    };
  }
  if (!vm) {
    // The /edge/intents page shouldn't be reachable without an assigned
    // VM (the dashboard layout gates on it). But defense in depth: return
    // a clean error rather than crashing on null access below.
    return { ok: false, reason: "no_vm" };
  }
  if (vm.partner !== "edge_city") {
    return { ok: false, reason: "not_edge_city" };
  }

  // 2. Already provisioned? Short-circuit.
  if (vm.index_user_id && vm.index_api_key) {
    return {
      ok: true,
      indexUserId: vm.index_user_id as string,
      minted: false,
    };
  }

  // 3. Need to mint. Validate Index env first — if missing, log loud
  //    + return config_error so the operator notices in Vercel logs
  //    rather than the user seeing the same "coming online soon" copy.
  const networkId = process.env.INDEX_NETWORK_ID?.trim();
  const masterKey = process.env.INDEX_NETWORK_MASTER_KEY?.trim();
  if (!networkId || !masterKey) {
    logger.error(
      "[index-jit] INDEX_NETWORK_ID or INDEX_NETWORK_MASTER_KEY not set",
      {
        userIdPrefix: userId.slice(0, 8),
        hasNetworkId: !!networkId,
        hasMasterKey: !!masterKey,
      },
    );
    return { ok: false, reason: "config_error" };
  }

  // 4. Load user profile for the signup body. Email is required by Index;
  //    name + telegram_handle are optional enrichment that helps their
  //    discovery graph.
  const { data: user, error: userErr } = await supabase
    .from("instaclaw_users")
    .select("email, name, telegram_handle")
    .eq("id", userId)
    .single();

  if (userErr || !user?.email) {
    logger.warn("[index-jit] user profile lookup failed", {
      userIdPrefix: userId.slice(0, 8),
      err: userErr?.message ?? "no email",
    });
    return {
      ok: false,
      reason: "user_lookup_failed",
      detail: userErr?.message?.slice(0, 200) ?? "no email",
    };
  }

  const socials: Array<{ label: string; value: string }> = [];
  if (
    user.telegram_handle &&
    typeof user.telegram_handle === "string" &&
    user.telegram_handle.trim().length > 0
  ) {
    socials.push({ label: "telegram", value: user.telegram_handle.trim() });
  }

  // 5. Call Index /signup. Mirrors stepIndexProvision's pattern with one
  //    retry on transient 5xx (rare but real during Index's pre-event
  //    onboarding waves). No third retry — past the 5-10 s budget we
  //    surrender and let the user see the friendly fallback.
  let signupResp;
  try {
    signupResp = await callIndexSignup(
      {
        email: user.email,
        name: user.name ?? undefined,
        socials: socials.length > 0 ? socials : undefined,
      },
      { networkId, masterKey },
    );
  } catch (err) {
    if (err instanceof IndexSignupError && err.retryable) {
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        signupResp = await callIndexSignup(
          {
            email: user.email,
            name: user.name ?? undefined,
            socials: socials.length > 0 ? socials : undefined,
          },
          { networkId, masterKey },
        );
      } catch (err2) {
        logger.warn("[index-jit] signup retry failed", {
          userIdPrefix: userId.slice(0, 8),
          err: err2 instanceof Error ? err2.message.slice(0, 200) : String(err2),
        });
        return {
          ok: false,
          reason: "signup_failed",
          detail: err2 instanceof Error ? err2.message.slice(0, 200) : String(err2),
        };
      }
    } else {
      logger.warn("[index-jit] signup failed (non-retryable)", {
        userIdPrefix: userId.slice(0, 8),
        err: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      return {
        ok: false,
        reason: "signup_failed",
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      };
    }
  }

  // 6. Defense-in-depth apiKey shape validation — same regex stepIndexProvision
  //    uses. If Index returns an unexpected shape, fail cleanly rather than
  //    persisting garbage that would break the IndexMcpClient downstream.
  if (!/^[A-Za-z0-9_\-=.+/]{16,}$/.test(signupResp.apiKey)) {
    logger.warn("[index-jit] signup returned unexpected apiKey shape", {
      userIdPrefix: userId.slice(0, 8),
      len: signupResp.apiKey.length,
      prefix: signupResp.apiKey.slice(0, 5),
    });
    return {
      ok: false,
      reason: "signup_failed",
      detail: "unexpected apiKey shape",
    };
  }

  // 7. Persist to DB. ORDER MATTERS: write DB BEFORE doing anything else
  //    so the next reconciler tick (which checks `hasLocalCreds` from the
  //    DB row) sees the credentials and skips its own signup — preventing
  //    a duplicate Index account.
  const { error: dbErr } = await supabase
    .from("instaclaw_vms")
    .update({
      index_user_id: signupResp.user.id,
      index_api_key: signupResp.apiKey,
      index_provisioned_at: new Date().toISOString(),
      index_provisioned_failed_at: null,
    })
    .eq("id", vm.id);

  if (dbErr) {
    logger.error("[index-jit] DB write failed AFTER signup", {
      userIdPrefix: userId.slice(0, 8),
      vmId: (vm.id as string).slice(0, 8),
      err: dbErr.message,
      indexUserIdPrefix: signupResp.user.id.slice(0, 8),
    });
    return {
      ok: false,
      reason: "db_write_failed",
      detail: dbErr.message.slice(0, 200),
    };
  }

  logger.info("[index-jit] minted credentials inline", {
    userIdPrefix: userId.slice(0, 8),
    vmId: (vm.id as string).slice(0, 8),
    indexUserIdPrefix: signupResp.user.id.slice(0, 8),
  });

  return {
    ok: true,
    indexUserId: signupResp.user.id,
    minted: true,
  };
}
