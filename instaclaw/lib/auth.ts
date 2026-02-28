import NextAuth from "next-auth";
import { cookies } from "next/headers";
import { getSupabase } from "./supabase";
import { sendWelcomeEmail } from "./email";
import { logger } from "./logger";
import authConfig from "./auth.config";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google") return false;

      const supabase = getSupabase();

      // Check if the user already exists
      const { data: existing, error: existingError } = await supabase
        .from("instaclaw_users")
        .select("id")
        .eq("google_id", account.providerAccountId)
        .single();

      if (existingError) {
        logger.error("AUTH_DEBUG: existing user lookup failed", {
          route: "auth/signIn",
          email: user.email,
          googleId: account.providerAccountId,
          error: String(existingError),
          code: existingError.code,
        });
      }

      if (existing) return true;

      logger.error("AUTH_DEBUG: user not found — falling through to invite check", {
        route: "auth/signIn",
        email: user.email,
        googleId: account.providerAccountId,
        existingData: JSON.stringify(existing),
      });

      // Read the invite code from the cookie set before OAuth redirect
      const cookieStore = await cookies();
      const inviteCode = cookieStore.get("instaclaw_invite_code")?.value;

      // NEW users MUST have a valid invite code
      if (!inviteCode) {
        logger.error("Sign-up rejected: no invite code", { email: user.email, route: "auth/signIn" });
        return false;
      }

      const normalizedCode = decodeURIComponent(inviteCode).trim().toUpperCase();
      const { data: invite } = await supabase
        .from("instaclaw_invites")
        .select("id, max_uses, times_used, expires_at, is_active")
        .eq("code", normalizedCode)
        .single();

      if (
        !invite ||
        !invite.is_active ||
        invite.times_used >= invite.max_uses ||
        (invite.expires_at && new Date(invite.expires_at) < new Date())
      ) {
        logger.error("Sign-up rejected: invalid invite code", { email: user.email, code: normalizedCode, route: "auth/signIn" });
        return false;
      }

      // Read optional ambassador referral code from cookie
      const referralCode = cookieStore.get("instaclaw_referral_code")?.value ?? null;

      // Create the user row
      const { error } = await supabase.from("instaclaw_users").insert({
        email: user.email?.toLowerCase(),
        name: user.name,
        google_id: account.providerAccountId,
        invited_by: inviteCode ? decodeURIComponent(inviteCode) : null,
        referred_by: referralCode ? decodeURIComponent(referralCode).trim().toLowerCase() : null,
      });

      if (error) {
        // Unique constraint = user already exists (race condition)
        if (error.code === "23505") return true;
        logger.error("Error creating user", { error: String(error), route: "auth/signIn" });
        return false;
      }

      // Send welcome email (fire and forget)
      if (user.email) {
        sendWelcomeEmail(user.email, user.name ?? "").catch((err) =>
          logger.error("Failed to send welcome email", { error: String(err), route: "auth/signIn" })
        );
      }

      // Consume the invite code: increment times_used, append user to used_by
      if (inviteCode) {
        const normalized = decodeURIComponent(inviteCode)
          .trim()
          .toUpperCase();

        // Get the invite record
        const { data: invite } = await supabase
          .from("instaclaw_invites")
          .select("id, times_used, used_by")
          .eq("code", normalized)
          .single();

        if (invite) {
          // Get the newly created user's ID for used_by
          const { data: newUser } = await supabase
            .from("instaclaw_users")
            .select("id")
            .eq("google_id", account.providerAccountId)
            .single();

          const updatedUsedBy = [
            ...(invite.used_by ?? []),
            ...(newUser ? [newUser.id] : []),
          ];

          await supabase
            .from("instaclaw_invites")
            .update({
              times_used: (invite.times_used ?? 0) + 1,
              used_by: updatedUsedBy,
            })
            .eq("id", invite.id);
        }
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
});
