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
 *   - app/api/cron/refresh-openai-oauth-tokens/route.ts (skip when disabled — Day 16-18)
 *   - lib/vm-reconcile.ts:stepChatGPTOAuthToken      (skip when disabled — Day 11-15)
 *   - lib/ssh.ts:configureOpenClaw chatgpt_oauth branch (fall back when disabled — Day 11-15)
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
 * Response body for the "feature disabled" case. Matches the standard
 * route response shape: `{ status, message? }`. Day 2.5 standardization
 * (audit finding P2-A) — was previously nested as `{ type: "error",
 * error: { type, message } }` which forced 3 different parsers across
 * the routes. Now every OAuth route + the feature-flag helper return
 * the same shape, so the UI state machine is a simple switch(status).
 *
 * Caller wraps in NextResponse.json(payload, { status: 503 }).
 *
 * Honest wording (Day 2.5 fix): does NOT claim "existing connections
 * continue to work" because the kill-switch graceful-downgrade cron
 * tears them down within ~15 min. Users WILL see their agent on Claude.
 */
export function chatGPTOAuthDisabledPayload(): {
  status: "feature_disabled";
  message: string;
} {
  return {
    status: "feature_disabled",
    message:
      "ChatGPT subscription connection is temporarily disabled across InstaClaw. " +
      "Your agent is running on Claude in the meantime. " +
      "Reconnect later from Settings once ChatGPT support is restored.",
  };
}
