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
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    googleId?: string;
  }
}
