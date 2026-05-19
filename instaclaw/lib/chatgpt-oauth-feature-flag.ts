/**
 * Single source of truth for the ChatGPT-OAuth feature flag.
 *
 * Default: OFF. The feature only activates when env explicitly opts in
 * with OPENAI_OAUTH_ENABLED=true. This is the kill switch from the
 * Phase 1 design doc §10.2 — flipping the env var disables the feature
 * across every call site within one Vercel cold-start (~3-5 min).
 *
 * Call sites:
 *   - app/api/auth/openai/device-code/start/route.ts  (returns 503 if disabled)
 *   - app/api/auth/openai/device-code/poll/route.ts   (returns 503 if disabled)
 *   - app/api/cron/refresh-openai-oauth-tokens/route.ts (skip when disabled)
 *   - lib/vm-reconcile.ts:stepChatGPTOAuthToken      (skip when disabled)
 *   - lib/ssh.ts:configureOpenClaw chatgpt_oauth branch (fall back when disabled)
 *
 * Inverse:
 *   - app/api/cron/openai-oauth-graceful-downgrade/route.ts RUNS only
 *     when DISABLED, to clean up users in chatgpt_oauth mode by
 *     downgrading them back to all_inclusive.
 *
 * Disconnect route does NOT check this flag — users should always be
 * able to disconnect a connected account, even if we've globally
 * disabled new connections.
 */

const ENV_VAR = "OPENAI_OAUTH_ENABLED";

export function isChatGPTOAuthEnabled(): boolean {
  return process.env[ENV_VAR] === "true";
}

/**
 * Build a structured "disabled" response object suitable for direct
 * return from an API route handler. Caller wraps in NextResponse.json
 * with status 503 (Service Unavailable).
 */
export function chatGPTOAuthDisabledPayload(): {
  type: "error";
  error: { type: "feature_disabled"; message: string };
} {
  return {
    type: "error",
    error: {
      type: "feature_disabled",
      // Worded carefully: the kill-switch graceful-downgrade cron will
      // tear down existing connections within ~15 min of flag-flip, so we
      // do NOT claim "existing accounts continue to work" — that was the
      // original Day 1 phrasing and proved misleading once the cron + the
      // disconnect helper landed in Day 2. Honest message instead.
      message:
        "ChatGPT subscription connection is temporarily disabled across InstaClaw. " +
        "Your agent is running on Claude in the meantime. " +
        "Reconnect later from Settings once ChatGPT support is restored.",
    },
  };
}
