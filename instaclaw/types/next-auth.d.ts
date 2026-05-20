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
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    googleId?: string;
  }
}
