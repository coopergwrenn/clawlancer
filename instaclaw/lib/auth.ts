import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getSupabase } from "./supabase";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  pages: {
    signIn: "/signup",
  },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google") return false;

      const supabase = getSupabase();

      // Check if the user already exists
      const { data: existing } = await supabase
        .from("instaclaw_users")
        .select("id")
        .eq("google_id", account.providerAccountId)
        .single();

      if (existing) return true;

      // Check if there's a pending invite (stored in session/cookie before OAuth)
      // The invite code is validated before the OAuth redirect, so we allow sign-in
      // and create the user row. The invite code is consumed in the signup page flow.
      const { error } = await supabase.from("instaclaw_users").insert({
        email: user.email?.toLowerCase(),
        name: user.name,
        google_id: account.providerAccountId,
      });

      if (error) {
        // Unique constraint = user already exists (race condition)
        if (error.code === "23505") return true;
        console.error("Error creating user:", error);
        return false;
      }

      return true;
    },

    async jwt({ token, account }) {
      if (account) {
        token.googleId = account.providerAccountId;
      }
      return token;
    },

    async session({ session, token }) {
      if (token.googleId) {
        const supabase = getSupabase();
        const { data } = await supabase
          .from("instaclaw_users")
          .select("id, onboarding_complete")
          .eq("google_id", token.googleId)
          .single();

        if (data) {
          session.user.id = data.id;
          session.user.onboardingComplete = data.onboarding_complete ?? false;
        }
      }
      return session;
    },
  },
  session: {
    strategy: "jwt",
  },
});
