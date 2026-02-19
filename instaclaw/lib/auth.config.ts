import Google from "next-auth/providers/google";
import type { NextAuthConfig } from "next-auth";

/**
 * Edge-compatible auth configuration.
 *
 * This file contains only the provider and session config — no server-side
 * imports (Supabase, cookies, email, etc.). It is imported by middleware.ts
 * which runs in the Edge Runtime where Node.js APIs are not available.
 *
 * The full config with callbacks lives in auth.ts (server-only).
 */
export default {
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/signin",
    error: "/auth-error",
  },
  session: {
    strategy: "jwt",
  },
} satisfies NextAuthConfig;
