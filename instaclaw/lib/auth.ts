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

      // New user — read optional ambassador referral code from cookie
      const cookieStore = await cookies();
      const referralCode = cookieStore.get("instaclaw_referral_code")?.value ?? null;

      // Create the user row
      const { error } = await supabase.from("instaclaw_users").insert({
        email: user.email?.toLowerCase(),
        name: user.name,
        google_id: account.providerAccountId,
        invited_by: null,
        referred_by: referralCode ? decodeURIComponent(referralCode).trim().toLowerCase() : null,
      });

      if (error) {
        // Unique constraint = user already exists (race condition)
        if (error.code === "23505") return true;
        logger.error("Error creating user", { error: String(error), route: "auth/signIn" });
        return false;
      }

      // Record signup in ambassador referrals table
      if (referralCode) {
        try {
          const decodedRef = decodeURIComponent(referralCode).trim().toLowerCase();
          const { data: ambassador } = await supabase
            .from("instaclaw_ambassadors")
            .select("id")
            .eq("referral_code", decodedRef)
            .eq("status", "approved")
            .single();

          if (ambassador) {
            // Get the newly created user's ID
            const { data: newUser } = await supabase
              .from("instaclaw_users")
              .select("id")
              .eq("google_id", account.providerAccountId)
              .single();

            if (newUser) {
              // Look up the user's waitlist row by email to find their specific referral record
              const userEmail = user.email?.toLowerCase();
              let matchedRefId: string | null = null;

              if (userEmail) {
                const { data: waitlistRow } = await supabase
                  .from("instaclaw_waitlist")
                  .select("id, created_at")
                  .ilike("email", userEmail)
                  .eq("ref_code", decodedRef)
                  .single();

                if (waitlistRow) {
                  // Find the referral row created at waitlist time for this ambassador
                  const { data: waitlistRef } = await supabase
                    .from("instaclaw_ambassador_referrals")
                    .select("id")
                    .eq("ambassador_id", ambassador.id)
                    .eq("ref_code", decodedRef)
                    .is("referred_user_id", null)
                    .gte("waitlisted_at", new Date(new Date(waitlistRow.created_at).getTime() - 5000).toISOString())
                    .lte("waitlisted_at", new Date(new Date(waitlistRow.created_at).getTime() + 5000).toISOString())
                    .limit(1)
                    .single();

                  if (waitlistRef) matchedRefId = waitlistRef.id;
                }
              }

              if (matchedRefId) {
                // Update the specific waitlist referral row for this user
                await supabase
                  .from("instaclaw_ambassador_referrals")
                  .update({
                    referred_user_id: newUser.id,
                    signed_up_at: new Date().toISOString(),
                  })
                  .eq("id", matchedRefId);
              } else {
                // No waitlist row found — direct signup or waitlist without ref
                // Upsert to handle race condition with webhook (Bug 3)
                await supabase.from("instaclaw_ambassador_referrals").upsert({
                  ambassador_id: ambassador.id,
                  referred_user_id: newUser.id,
                  ref_code: decodedRef,
                  signed_up_at: new Date().toISOString(),
                }, { onConflict: "ambassador_id,referred_user_id", ignoreDuplicates: false });
              }
            }
          }
        } catch (refErr) {
          logger.error("Failed to record referral signup", { error: String(refErr), route: "auth/signIn" });
        }
      }

      // Send welcome email (fire and forget)
      if (user.email) {
        sendWelcomeEmail(user.email, user.name ?? "").catch((err) =>
          logger.error("Failed to send welcome email", { error: String(err), route: "auth/signIn" })
        );
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
