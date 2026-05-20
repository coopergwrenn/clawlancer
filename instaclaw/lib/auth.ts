import NextAuth from "next-auth";
import { cookies } from "next/headers";
import { getSupabase } from "./supabase";
import { sendWelcomeEmail } from "./email";
import { logger } from "./logger";
import { tagUserAsPartner } from "./partner-tag";
import {
  verifyEdgeVerifiedCookie,
  EDGE_VERIFIED_COOKIE_NAME,
} from "./edge-verified-cookie";
import authConfig from "./auth.config";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google") return false;

      const supabase = getSupabase();

      // Read sign-up cookies once at the top. Both are used by:
      //   - branch 1 (existing Google-linked user) — partnerCookie applies via helper
      //   - branch 2 (wallet user linking Google) — partnerCookie applies via helper
      //   - branch 3 (new user) — both written into the INSERT statement
      // Centralizing the read prevents the dual-account bug Cooper traced
      // 2026-04-30: prior to this fix the cookie was only read inside branch 3,
      // so existing users got their cookie silently ignored on sign-in.
      const cookieStore = await cookies();
      const referralCode = cookieStore.get("instaclaw_referral_code")?.value ?? null;
      const partnerCookie = cookieStore.get("instaclaw_partner")?.value ?? null;

      // Edge verification cookie (signed HMAC-SHA256, 15-min TTL). Set by
      // POST /api/edge/verify-ticket after a successful EdgeOS attendee
      // lookup. Only honored if (a) signature is valid, (b) not expired,
      // and (c) the verified email matches the user's signin email — we
      // refuse to claim a verified-as-X cookie for a signed-in-as-Y user.
      // Both null-equality cases (no cookie, expired) fall through silently
      // and the user takes the normal non-Edge signup path.
      const edgeVerifiedCookieRaw =
        cookieStore.get(EDGE_VERIFIED_COOKIE_NAME)?.value ?? null;
      const edgeVerifiedResult = verifyEdgeVerifiedCookie(edgeVerifiedCookieRaw);
      const signinEmail = user.email?.trim().toLowerCase() ?? null;
      const edgeVerifiedEmail =
        edgeVerifiedResult.ok &&
        edgeVerifiedResult.email &&
        signinEmail &&
        edgeVerifiedResult.email === signinEmail
          ? edgeVerifiedResult.email
          : null;
      if (edgeVerifiedCookieRaw && !edgeVerifiedEmail) {
        // Cookie was set but didn't validate / didn't match. Log once for
        // monitoring — if this fires frequently, the gate's cookie minting
        // and the signin email-normalization are diverging.
        logger.warn("signIn: edge_verified cookie present but rejected", {
          route: "auth/signIn",
          reason: edgeVerifiedResult.reason,
          cookieEmail: edgeVerifiedResult.email,
          signinEmail,
        });
      }

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

      if (existing) {
        // Apply partner cookie if present — closes the dual-account hole.
        // Until 2026-05-12 this branch returned without reading the cookie,
        // so a user who clicked /edge claim while logged out, then signed
        // back in with their existing Google account, ended up with no
        // partner tag despite the cookie being set. tagUserAsPartner is
        // idempotent + error-resilient: it never throws and never blocks
        // sign-in even if the partner-tag write fails.
        if (partnerCookie) {
          const result = await tagUserAsPartner(supabase, existing.id, partnerCookie);
          if (!result.ok) {
            logger.warn("partner-tag failed on existing-user signIn (non-blocking)", {
              userId: existing.id,
              partnerCookie,
              error: result.error,
              route: "auth/signIn",
            });
          }
        }

        // Edge ticket: if the signed cookie validates, write the column.
        // Non-blocking: a unique-violation (23505) means somebody else
        // already claimed this email — log and continue, don't fail
        // sign-in (the user's flow into the dashboard works without the
        // column; the duplicate-claim risk is mitigated downstream).
        if (edgeVerifiedEmail) {
          const { error: edgeWriteErr } = await supabase
            .from("instaclaw_users")
            .update({ edge_verified_email: edgeVerifiedEmail })
            .eq("id", existing.id)
            .or(
              `edge_verified_email.is.null,edge_verified_email.eq.${edgeVerifiedEmail}`,
            );
          if (edgeWriteErr) {
            logger.warn("edge_verified_email write failed on existing-user signIn", {
              userId: existing.id,
              code: edgeWriteErr.code,
              error: String(edgeWriteErr.message),
              route: "auth/signIn",
            });
          }
        }
        return true;
      }

      // ── Account linking: check if a wallet-linked user exists with this email ──
      // Mini app users create accounts via World wallet with an email but no google_id.
      // When they later sign in with Google to subscribe, we link Google to their
      // existing account instead of creating a duplicate.
      const userEmail = user.email?.toLowerCase();
      if (userEmail) {
        const { data: walletUser } = await supabase
          .from("instaclaw_users")
          .select("id, google_id, world_wallet_address")
          .eq("email", userEmail)
          .single();

        if (walletUser && !walletUser.google_id) {
          // Found existing user with this email but no Google linked — link now
          const { error: linkErr } = await supabase
            .from("instaclaw_users")
            .update({
              google_id: account.providerAccountId,
              name: user.name || undefined,
              onboarding_complete: true,
            })
            .eq("id", walletUser.id);

          if (linkErr) {
            logger.error("Failed to link Google to wallet user", {
              error: String(linkErr),
              userId: walletUser.id,
              route: "auth/signIn",
            });
          } else {
            logger.info("Linked Google account to existing wallet user", {
              userId: walletUser.id,
              email: userEmail,
              hasWallet: !!walletUser.world_wallet_address,
              route: "auth/signIn",
            });
          }

          // Apply partner cookie if present — closes the dual-account hole
          // for wallet-only mini-app users coming through a partner portal.
          // Runs even if linkErr occurred above (the user record still exists
          // and should reflect the partner tag).
          if (partnerCookie) {
            const result = await tagUserAsPartner(supabase, walletUser.id, partnerCookie);
            if (!result.ok) {
              logger.warn("partner-tag failed on wallet-user signIn (non-blocking)", {
                userId: walletUser.id,
                partnerCookie,
                error: result.error,
                route: "auth/signIn",
              });
            }
          }

          // Edge ticket — same mechanism as the Google-only branch above.
          if (edgeVerifiedEmail) {
            const { error: edgeWriteErr } = await supabase
              .from("instaclaw_users")
              .update({ edge_verified_email: edgeVerifiedEmail })
              .eq("id", walletUser.id)
              .or(
                `edge_verified_email.is.null,edge_verified_email.eq.${edgeVerifiedEmail}`,
              );
            if (edgeWriteErr) {
              logger.warn("edge_verified_email write failed on wallet-user signIn", {
                userId: walletUser.id,
                code: edgeWriteErr.code,
                error: String(edgeWriteErr.message),
                route: "auth/signIn",
              });
            }
          }
          return true;
        }
      }

      // Create the user row (new user — referralCode + partnerCookie were
      // read at the top of this callback and are reused here). The
      // edge_verified_email column carries through the EdgeOS ticket gate
      // signed cookie — only written when verified, otherwise NULL so
      // non-Edge signups never trip the partial UNIQUE constraint.
      const { error } = await supabase.from("instaclaw_users").insert({
        email: userEmail,
        name: user.name,
        google_id: account.providerAccountId,
        invited_by: null,
        referred_by: referralCode ? decodeURIComponent(referralCode).trim().toLowerCase() : null,
        ...(partnerCookie ? { partner: partnerCookie } : {}),
        ...(edgeVerifiedEmail ? { edge_verified_email: edgeVerifiedEmail } : {}),
      });

      if (error) {
        // 23505 on the GOOGLE_ID column = user already exists (race
        // condition during signup). 23505 on edge_verified_email = the
        // email was claimed by someone else between the gate and the
        // signin callback. Both are surfaced as `return true` because
        // the user's account is created (or already exists) and the
        // dashboard layout will figure out the rest — we don't fail
        // sign-in over a non-Edge column conflict.
        if (error.code === "23505") {
          if (error.message?.includes("edge_verified_email")) {
            logger.warn("edge_verified_email already claimed during new-user insert", {
              email: userEmail,
              error: String(error.message),
              route: "auth/signIn",
            });
            // Retry the insert without the edge column so the user account
            // still gets created — they keep their account, just no Edge
            // tag. The gate UI will have already surfaced "already_claimed"
            // before they got here in most cases.
            const { error: retryErr } = await supabase.from("instaclaw_users").insert({
              email: userEmail,
              name: user.name,
              google_id: account.providerAccountId,
              invited_by: null,
              referred_by: referralCode ? decodeURIComponent(referralCode).trim().toLowerCase() : null,
              ...(partnerCookie ? { partner: partnerCookie } : {}),
            });
            if (retryErr && retryErr.code !== "23505") {
              logger.error("retry insert (without edge col) failed", {
                error: String(retryErr.message),
                route: "auth/signIn",
              });
              return false;
            }
          }
          return true;
        }
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
          .select("id, onboarding_complete, partner, index_last_intent_at")
          .eq("google_id", token.googleId)
          .single();

        if (data) {
          session.user.id = data.id;
          session.user.onboardingComplete = data.onboarding_complete ?? false;
          // partner is exposed so client components can conditionally render
          // partner-specific UI (e.g., the Edge City nav item) without a
          // round-trip — see app/(dashboard)/layout.tsx primaryNav.
          session.user.partner = (data.partner as string | null) ?? null;
          // indexLastIntentAt drives the /edge/intents mandatory-intent gate.
          // NULL means "hasn't expressed any intent yet" — Edge attendees in
          // this state must pass through /edge/intents before /dashboard.
          // The dashboard layout enforces this universally; /deploying's
          // post-provision redirect routes Edge users here too. See FUP-3a.
          session.user.indexLastIntentAt =
            (data.index_last_intent_at as string | null) ?? null;
        }
      }
      return session;
    },
  },
});
