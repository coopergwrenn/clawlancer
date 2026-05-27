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
