import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      onboardingComplete: boolean;
      // Partner tag from instaclaw_users.partner. NULL for non-partner users.
      // Drives conditional UI (e.g., Edge City nav item in the dashboard).
      partner?: string | null;
      // Timestamp of the user's most-recent successful /api/edge/express-intent
      // submission. NULL for users who haven't expressed any intent yet.
      // ISO 8601 string when present. Drives the /edge/intents mandatory
      // onboarding gate — see app/(dashboard)/layout.tsx + /edge/intents/page.tsx.
      indexLastIntentAt?: string | null;
      // User's chosen messaging channel preference. 'web' when the user
      // clicked "skip to your command center" on /channels; 'imessage' or
      // 'telegram' set at the end of the channel-first onboarding flow
      // (/api/onboarding/done/submit). NULL for legacy users created
      // before this column was populated. Phase 2 banner + AGENTS.md
      // WEB_ONLY_USER section branch on `preferredChannel === 'web'`.
      preferredChannel?: string | null;
      // Last time the user dismissed the "connect a channel" nudge banner
      // on /dashboard (ISO 8601 string, or null if never dismissed). The
      // banner re-appears if null OR older than 14 days. Set by POST
      // /api/onboarding/dismiss-channel-nudge. The 14-day cadence vs the
      // 7-day default elsewhere: web-only users chose deliberately at
      // /channels; 7 is the right cadence for accidental states, 14 for
      // deliberate ones.
      dismissedChannelNudgeAt?: string | null;
      // Raw chatgpt_plan_type string from OpenAI's id_token claim,
      // refreshed on each token-refresh cron tick. Observed values:
      // "free" / "plus" / "pro" / "team" / "enterprise" (OpenAI doesn't
      // publish the enum). NULL for users who never connected ChatGPT
      // and for users whose tokens were nulled by disconnectUser. Drives
      // /plan's auto-BYOK-pricing path — paired with connectedChatGPT,
      // only the paid plan types ("plus" / "pro" / "team" / "enterprise")
      // surface the ChatGPT-aware UX; "free" or NULL fall back to the
      // default toggle. Source: lib/auth.ts session callback.
      chatgptPlanType?: string | null;
      // True iff the user currently has live ChatGPT OAuth tokens stored
      // on instaclaw_users (derived from openai_oauth_account_id !== null
      // — see lib/auth.ts session callback for the rationale on using
      // account_id over the encrypted token). Combined with chatgptPlanType
      // to gate the /plan auto-BYOK pricing path. Defaults to false on
      // sessions where the field hasn't been set (legacy paths, edge
      // cases) — consumers should treat undefined === false.
      connectedChatGPT?: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /**
     * Google provider sub. Set by the jwt callback when account.provider
     * === "google" on initial sign-in. Used by the session callback to
     * look up the instaclaw_users row by google_id.
     */
    googleId?: string;
    /**
     * instaclaw_users.id. Set by the jwt callback when account.provider
     * === OPENAI_DEVICE_CODE_PROVIDER_ID ("openai-device-code") on
     * initial sign-in. Used by the session callback to look up the row
     * directly by id (since OpenAI-authed users have google_id=null and
     * the existing google_id lookup wouldn't find them).
     *
     * Exactly one of googleId / instaclawUserId is set per token. The
     * session callback branches on which is present and falls through
     * to the other if absent — keeps the two paths independent.
     */
    instaclawUserId?: string;
  }
}
