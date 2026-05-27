import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { cookies } from "next/headers";
import { getSupabase } from "./supabase";
import { sendWelcomeEmail } from "./email";
import { logger } from "./logger";
import { tagUserAsPartner } from "./partner-tag";
import {
  verifyEdgeVerifiedCookie,
  EDGE_VERIFIED_COOKIE_NAME,
} from "./edge-verified-cookie";
import { verifySignupToken } from "./openai-signup-token";
import { verifyEdgeOtpToken } from "./edge-otp-token";
import authConfig from "./auth.config";

/**
 * NextAuth provider id for the ChatGPT-as-signin Credentials bridge.
 *
 * Exported so the /signin client component + the modal's signup-mode
 * handler can call `signIn(OPENAI_DEVICE_CODE_PROVIDER_ID, { signupToken })`
 * without a hardcoded string drifting between callsites.
 */
export const OPENAI_DEVICE_CODE_PROVIDER_ID = "openai-device-code";

/**
 * NextAuth provider id for the Edge email-OTP Credentials bridge.
 *
 * Exported so /edge/claim's State E (OTP entry) can call
 * `signIn(EDGE_EMAIL_OTP_PROVIDER_ID, { otpToken })` after
 * /api/edge/verify-otp returns the one-shot HMAC token.
 *
 * This provider is ONLY usable by users who passed:
 *   1. /api/edge/verify-ticket (silent /citizens check) → edge_verified cookie set
 *   2. /api/edge/start-email-login (OTP fired)
 *   3. /api/edge/verify-otp (code validated, user upserted, token minted)
 *
 * authorize() below verifies the HMAC token + does a defense-in-depth
 * DB lookup before returning the user object to NextAuth.
 */
export const EDGE_EMAIL_OTP_PROVIDER_ID = "edge-email-otp";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  // ─────────────────────────────────────────────────────────────────────
  // Providers
  //
  // Google lives in auth.config.ts (edge-imported by middleware). The
  // Credentials provider for ChatGPT signup lives HERE in auth.ts
  // because its authorize() callback uses Supabase + the signSignupToken
  // helper, neither of which is edge-runtime compatible. Middleware
  // doesn't need to know about the Credentials provider — it only checks
  // session validity via the JWT cookie, which is provider-agnostic.
  //
  // Adding Credentials does NOT change Google sign-in behavior. The two
  // providers are independent; users who chose Google continue through
  // the existing signIn → jwt → session callback chain unchanged.
  // ─────────────────────────────────────────────────────────────────────
  providers: [
    ...authConfig.providers,
    Credentials({
      id: OPENAI_DEVICE_CODE_PROVIDER_ID,
      name: "ChatGPT",
      credentials: {
        // One-shot HMAC-signed token minted by /api/auth/openai/signup/poll
        // on successful device-code completion. 60s exp. Contains the
        // resolved instaclaw_users.id in the `sub` claim.
        signupToken: { label: "Signup Token", type: "text" },
      },
      async authorize(rawCredentials) {
        const signupToken =
          typeof rawCredentials?.signupToken === "string"
            ? rawCredentials.signupToken
            : null;
        if (!signupToken) {
          logger.warn("openai-device-code authorize: missing signupToken");
          return null;
        }

        // 1. Verify the HMAC signature + exp + audience claim.
        //    Any failure here → return null → NextAuth refuses sign-in.
        //    No retry, no surface — the user just sees /signin again.
        const verifyResult = verifySignupToken(signupToken);
        if (!verifyResult.ok || !verifyResult.userId) {
          logger.warn("openai-device-code authorize: signupToken verification failed", {
            reason: verifyResult.reason,
            // Prefix only — token is session-equivalent (Rule 53)
            tokenPrefix: signupToken.slice(0, 12),
          });
          return null;
        }

        // 2. Defense-in-depth DB lookup — confirm the user actually exists.
        //    If NEXTAUTH_SECRET ever leaks, a forger could produce a valid
        //    signupToken for any user.id. The DB lookup is the final gate
        //    that ensures the id corresponds to a real account.
        const supabase = getSupabase();
        const { data: user, error } = await supabase
          .from("instaclaw_users")
          .select("id, email, name")
          .eq("id", verifyResult.userId)
          .maybeSingle();

        if (error) {
          logger.error("openai-device-code authorize: user lookup failed", {
            userId: verifyResult.userId,
            error: error.message,
          });
          return null;
        }
        if (!user) {
          logger.warn("openai-device-code authorize: user not found in DB", {
            userId: verifyResult.userId,
          });
          return null;
        }

        // 3. Return the user object — NextAuth creates the JWT + session
        //    cookie from this. The signIn callback fires next (see below).
        return {
          id: user.id as string,
          email: (user.email as string | null) ?? undefined,
          name: (user.name as string | null) ?? undefined,
        };
      },
    }),
    Credentials({
      id: EDGE_EMAIL_OTP_PROVIDER_ID,
      name: "Edge Email Code",
      credentials: {
        // One-shot HMAC-signed token minted by /api/edge/verify-otp on
        // successful 6-digit-code validation. 60s exp. Contains the
        // resolved instaclaw_users.id in the `sub` claim. Same shape as
        // openai-signup-token but with `aud: "edge-otp"` for cross-
        // purpose-reuse defense.
        otpToken: { label: "Edge OTP Token", type: "text" },
      },
      async authorize(rawCredentials) {
        const otpToken =
          typeof rawCredentials?.otpToken === "string"
            ? rawCredentials.otpToken
            : null;
        if (!otpToken) {
          logger.warn("edge-email-otp authorize: missing otpToken");
          return null;
        }

        // 1. Verify HMAC + exp + audience claim.
        const verifyResult = verifyEdgeOtpToken(otpToken);
        if (!verifyResult.ok || !verifyResult.userId) {
          logger.warn("edge-email-otp authorize: token verification failed", {
            reason: verifyResult.reason,
            // Prefix only — token is session-equivalent (Rule 53)
            tokenPrefix: otpToken.slice(0, 12),
          });
          return null;
        }

        // 2. Defense-in-depth DB lookup — confirm the user actually exists.
        const supabase = getSupabase();
        const { data: user, error } = await supabase
          .from("instaclaw_users")
          .select("id, email, name")
          .eq("id", verifyResult.userId)
          .maybeSingle();

        if (error) {
          logger.error("edge-email-otp authorize: user lookup failed", {
            userId: verifyResult.userId,
            error: error.message,
          });
          return null;
        }
        if (!user) {
          logger.warn("edge-email-otp authorize: user not found in DB", {
            userId: verifyResult.userId,
          });
          return null;
        }

        return {
          id: user.id as string,
          email: (user.email as string | null) ?? undefined,
          name: (user.name as string | null) ?? undefined,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      // ─────────────────────────────────────────────────────────────────
      // Provider routing.
      //
      // Three paths:
      //   - "google": full identity-resolution + user-creation logic below
      //   - OPENAI_DEVICE_CODE_PROVIDER_ID ("openai-device-code"): the user
      //     was ALREADY resolved by /api/auth/openai/signup/poll's
      //     resolveSignupUser. The Credentials provider's authorize()
      //     verified the signupToken and confirmed the user exists.
      //     Nothing further needed here — return true and let NextAuth
      //     build the session.
      //   - anything else: refuse (defense-in-depth against unregistered
      //     providers somehow firing).
      // ─────────────────────────────────────────────────────────────────
      if (account?.provider === OPENAI_DEVICE_CODE_PROVIDER_ID) {
        logger.info("openai-device-code signIn: session established", {
          userId: user.id,
        });
        return true;
      }
      if (account?.provider === EDGE_EMAIL_OTP_PROVIDER_ID) {
        // The user was ALREADY upserted by /api/edge/verify-otp before the
        // otpToken was minted. authorize() above verified the token + the
        // DB lookup. Nothing further needed here — the edge_verified_email
        // column, partner=edge_city tag, and ticket binding are all already
        // written. Return true and let NextAuth build the session.
        logger.info("edge-email-otp signIn: session established", {
          userId: user.id,
        });
        return true;
      }
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
      // lookup. The cookie's email is the EDGE-ATTENDEE-IDENTITY email
      // (the email registered with EdgeOS for Edge Esmeralda 2026).
      // The Google OAuth signin email is the GOOGLE-ACCOUNT-IDENTITY
      // email. These are two trusted identities that BOTH belong on the
      // same user record:
      //
      //   - Google email → user.email + user.google_id
      //   - Cookie email → user.edge_verified_email
      //
      // Pre-2026-05-22 the code required `cookie.email === signinEmail`
      // which dropped the cookie for any Edge attendee whose Google
      // account was registered under a different email than their Edge
      // ticket — a very common pattern (event email vs personal Gmail).
      // Mirror of the same fix shipped to resolveSignupUser today for
      // the OpenAI device-code path. The 2026-05-22 Cooper-shelpinc
      // incident exposed this on the OpenAI path; the same bug shape
      // lurks here on the Google path until this fix.
      //
      // Defense in depth preserved: the cookie is still HMAC-signed and
      // un-expired (15-min TTL). The downstream UPDATE's OR-guard on
      // edge_verified_email (`is.null,eq.<value>`) prevents overwriting
      // a different user's already-claimed value.
      const edgeVerifiedCookieRaw =
        cookieStore.get(EDGE_VERIFIED_COOKIE_NAME)?.value ?? null;
      const edgeVerifiedResult = verifyEdgeVerifiedCookie(edgeVerifiedCookieRaw);
      const signinEmail = user.email?.trim().toLowerCase() ?? null;
      const edgeVerifiedEmail =
        edgeVerifiedResult.ok && edgeVerifiedResult.email
          ? edgeVerifiedResult.email
          : null;
      if (edgeVerifiedCookieRaw && !edgeVerifiedEmail) {
        // Cookie was set but didn't validate (bad signature or expired).
        // Log for monitoring — if this fires frequently, the gate's cookie
        // minting is diverging from the verification step.
        logger.warn("signIn: edge_verified cookie present but invalid", {
          route: "auth/signIn",
          reason: edgeVerifiedResult.reason,
        });
      }
      // Diagnostic — surface cross-identity case so we can monitor how
      // often Edge-attendee-email differs from Google-account-email in
      // production. Domain-only for privacy.
      if (edgeVerifiedEmail && signinEmail && edgeVerifiedEmail !== signinEmail) {
        logger.info("signIn: edge_verified_email ≠ google signin email — honoring both", {
          route: "auth/signIn",
          edgeVerifiedEmailDomain: edgeVerifiedEmail.split("@")[1] ?? "?",
          signinEmailDomain: signinEmail.split("@")[1] ?? "?",
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

    async jwt({ token, account, user }) {
      // The `account` arg is non-null on the initial sign-in invocation
      // only. On subsequent JWT decodes (subsequent requests), we have
      // only `token` — already populated from the initial call.
      if (account) {
        if (account.provider === "google") {
          // Google's providerAccountId IS the user's Google sub — the
          // stable identifier the session callback uses to look up the
          // instaclaw_users row.
          token.googleId = account.providerAccountId;
        } else if (account.provider === OPENAI_DEVICE_CODE_PROVIDER_ID) {
          // Credentials provider: `user.id` is the instaclaw_users.id
          // we returned from authorize(). Store it under a distinct key
          // (`instaclawUserId`) so the session callback can branch on
          // which provider issued the JWT and use the right lookup.
          //
          // We intentionally avoid using NextAuth's default `token.sub`
          // field because the session callback's existing Google path
          // doesn't read `sub` — co-existence with the existing path is
          // easier with a separate, explicit field.
          if (user?.id) {
            token.instaclawUserId = user.id;
          }
        } else if (account.provider === EDGE_EMAIL_OTP_PROVIDER_ID) {
          // Same shape as the OpenAI Credentials path — store the
          // instaclaw_users.id under the same key. The session callback
          // already handles `token.instaclawUserId` for both Credentials
          // providers via the shared `else if (token.instaclawUserId)`
          // branch — no session-callback changes needed.
          if (user?.id) {
            token.instaclawUserId = user.id;
          }
        }
      }
      return token;
    },

    async session({ session, token }) {
      // ─────────────────────────────────────────────────────────────────
      // Session hydration — two lookup paths, same downstream shape.
      //
      // Google-authed users: token.googleId is set; look up by google_id.
      // ChatGPT-authed users: token.instaclawUserId is set; look up by id.
      //
      // BOTH paths populate the SAME session.user fields (id,
      // onboardingComplete, partner, indexLastIntentAt) so downstream
      // code (dashboard layout, /edge/intents gate, billing/checkout)
      // treats both identically. This is the "indistinguishable by the
      // time they hit /deploying" invariant from Cooper's spec.
      // ─────────────────────────────────────────────────────────────────
      const supabase = getSupabase();
      let userRow: {
        id: string;
        onboarding_complete: boolean | null;
        partner: string | null;
        index_last_intent_at: string | null;
        preferred_channel: string | null;
      } | null = null;

      if (token.googleId) {
        // Google path (existing — unchanged)
        const { data } = await supabase
          .from("instaclaw_users")
          .select("id, onboarding_complete, partner, index_last_intent_at, preferred_channel")
          .eq("google_id", token.googleId)
          .single();
        userRow = data
          ? {
              id: data.id as string,
              onboarding_complete: data.onboarding_complete as boolean | null,
              partner: data.partner as string | null,
              index_last_intent_at: data.index_last_intent_at as string | null,
              preferred_channel: data.preferred_channel as string | null,
            }
          : null;
      } else if (token.instaclawUserId) {
        // ChatGPT path (new — Credentials provider)
        const { data } = await supabase
          .from("instaclaw_users")
          .select("id, onboarding_complete, partner, index_last_intent_at, preferred_channel")
          .eq("id", token.instaclawUserId as string)
          .single();
        userRow = data
          ? {
              id: data.id as string,
              onboarding_complete: data.onboarding_complete as boolean | null,
              partner: data.partner as string | null,
              index_last_intent_at: data.index_last_intent_at as string | null,
              preferred_channel: data.preferred_channel as string | null,
            }
          : null;
      }

      if (userRow) {
        session.user.id = userRow.id;
        session.user.onboardingComplete = userRow.onboarding_complete ?? false;
        // partner is exposed so client components can conditionally render
        // partner-specific UI (e.g., the Edge City nav item) without a
        // round-trip — see app/(dashboard)/layout.tsx primaryNav.
        session.user.partner = userRow.partner ?? null;
        // indexLastIntentAt drives the /edge/intents mandatory-intent gate.
        // NULL means "hasn't expressed any intent yet" — Edge attendees in
        // this state must pass through /edge/intents before /dashboard.
        // The dashboard layout enforces this universally; /deploying's
        // post-provision redirect routes Edge users here too. See FUP-3a.
        session.user.indexLastIntentAt = userRow.index_last_intent_at ?? null;
        // preferred_channel: 'web' for users who chose "skip to your
        // command center" on /channels; 'imessage' / 'telegram' set by
        // /api/onboarding/done/submit at end of channel-first flow; NULL
        // for legacy users created before this column was populated.
        // Drives Phase 2 surfaces — dashboard nudge banner, AGENTS.md
        // WEB_ONLY_USER section, settings page copy.
        session.user.preferredChannel = userRow.preferred_channel ?? null;
      }
      return session;
    },
  },
});
