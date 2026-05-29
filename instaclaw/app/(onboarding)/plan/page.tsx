"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { LenisProvider } from "@/components/landing/lenis-provider";
import { EdgePartnerBanner, usePartnerCookie } from "@/components/marketing/edge-partner-banner";
import { SupportFooter } from "@/components/marketing/support-footer";

// Brand constants — same values used on /channels and /signin (channels-
// client.tsx and signin-client.tsx import them inline). Kept inline here
// rather than centralized so the page is self-contained at review time.
const CORAL = "#E96F4D";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";

// ChatGPT-paid plan types that qualify for the auto-BYOK pricing surface.
// Source: OpenAI's id_token chatgptPlanType claim, written to
// instaclaw_users.chatgpt_plan_type by openai-oauth-db.ts:379 at signin
// and refreshed on each token-refresh cron tick. "free" is excluded
// because free-tier ChatGPT accounts don't get Codex API access — the
// reconciler's stepChatGPTOAuthToken would attempt to route through
// openai-codex/gpt-5.5 and OpenAI would reject. The plan-type gate
// keeps the UI honest.
const CHATGPT_PAID_PLANS = new Set(["plus", "pro", "team", "enterprise"]);

// Lightweight glass treatment — used for the step indicator orbs and
// the unit callout chip inside each tier card. NOT the same as the
// .liquid-glass-card class (the full wabi recipe used on the Pro tier
// card via /globals.css). Kept inline because small chips don't need
// the full 5-ingredient architecture.
const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow: `
    rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
    rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
    rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
    rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
  `,
} as const;

// Tier data. Names are intentionally Title Case (product-tier proper
// nouns — same convention as Stripe's "Standard", Linear's "Business",
// Vercel's "Pro"). Descriptions + features are lowercase to match the
// page's voice (Cooper's 2026-05-29 locked-in decisions: drop the SaaS
// landing-deck copy in favor of single-beat lowercase phrases).
//
// Pricing is unchanged in this pass — the price-increase + grandfathering
// work is a separate task Cooper called out explicitly. DO NOT modify
// these numbers without re-checking Stripe price IDs + billing/checkout.
const tiers = [
  {
    id: "starter" as const,
    name: "Starter",
    allInclusive: 29,
    byok: 14,
    description: "just exploring.",
    dailyUnits: 600,
    features: [
      "always on. works while you sleep.",
      "learns your preferences.",
      "connect Telegram, Discord, & more.",
    ],
    byokFeatures: [
      "always on. works while you sleep.",
      "learns your preferences.",
      "unlimited usage with your own key.",
    ],
    trial: true,
  },
  {
    id: "pro" as const,
    name: "Pro",
    allInclusive: 99,
    byok: 39,
    description: "everyday use.",
    dailyUnits: 1000,
    features: [
      "2x more daily capacity.",
      "handles complex, multi-step tasks.",
      "priority support.",
    ],
    byokFeatures: [
      "faster VM for quicker responses.",
      "handles complex, multi-step tasks.",
      "priority support.",
    ],
    popular: true,
    trial: true,
  },
  {
    id: "power" as const,
    name: "Power",
    allInclusive: 299,
    byok: 99,
    description: "heavy lifting.",
    dailyUnits: 2500,
    features: [
      "6x more capacity.",
      "run multiple tasks at once.",
      "dedicated 1-on-1 support.",
    ],
    byokFeatures: [
      "top-tier speed and performance.",
      "run multiple tasks at once.",
      "dedicated 1-on-1 support.",
    ],
    trial: true,
  },
];

export default function PlanPage() {
  const router = useRouter();
  // Edge attendees get a different headline + body on this page. The
  // animated orange marketing copy ("never sleeps, never forgets...")
  // is non-Edge brand voice and doesn't acknowledge that Edge attendees
  // are sponsor-funded through June 30 — for them, the framing is
  // "your Pro plan is already selected and covered," not "choose among
  // these tiers." usePartnerCookie reads instaclaw_partner client-side
  // (set by /edge/claim's verify-ticket success); resolves to
  // "edge_city" for Edge attendees, null otherwise. SSR renders the
  // non-Edge variant to avoid hydration flash, then swaps for the 1% of
  // visitors who came through Edge.
  const partner = usePartnerCookie();
  const isEdge = partner === "edge_city";

  // Session — drives the ChatGPT-aware pricing surface. session.user
  // gets chatgptPlanType + connectedChatGPT from the lib/auth.ts session
  // callback (STEP 1 of this polish pass, commit c811a659). Both fields
  // are optional — `undefined` is treated identically to false / null,
  // so the legacy non-ChatGPT path is the default for users on legacy
  // sessions or where the fields are unset.
  const { data: session } = useSession();
  const isChatGPTUser = !!(
    session?.user?.connectedChatGPT &&
    CHATGPT_PAID_PLANS.has(session?.user?.chatgptPlanType ?? "")
  );
  // Lowercase plan-type for display. OpenAI returns lowercase ("plus",
  // "pro", etc.) but we normalize defensively in case of casing drift.
  const chatgptPlanDisplay = (
    session?.user?.chatgptPlanType ?? ""
  ).toLowerCase();

  const [selectedTier, setSelectedTier] = useState<string>("pro");
  const [apiMode, setApiMode] = useState<"all_inclusive" | "byok">(
    "all_inclusive"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [hydrated, setHydrated] = useState(false);

  // ChatGPT-user auto-BYOK. When isChatGPTUser is true, the reconciler's
  // stepChatGPTOAuthToken (vm-reconcile.ts:11183) will route the agent
  // through the user's own Codex access, so pricing must reflect BYOK
  // semantics (we don't pay Anthropic for them). This effect runs AFTER
  // the existing sessionStorage hydration effect below so it wins
  // regardless of saved state, AND it writes back to sessionStorage so
  // /api/onboarding/save + /api/billing/checkout see the corrected
  // value. Idempotent — short-circuits when apiMode is already "byok".
  useEffect(() => {
    if (!isChatGPTUser) return;
    if (apiMode === "byok") return;
    setApiMode("byok");
    try {
      const stored = sessionStorage.getItem("instaclaw_onboarding");
      if (stored) {
        const data = JSON.parse(stored);
        data.apiMode = "byok";
        sessionStorage.setItem("instaclaw_onboarding", JSON.stringify(data));
      }
    } catch {
      /* SSR snapshot / private mode — non-fatal */
    }
  }, [isChatGPTUser, apiMode]);

  // Hydration / first-visit state.
  //
  // 2026-05-29 routing-bug fix: this effect previously redirected to
  // /connect when no pending row existed for the user. That broke the
  // new onboarding flow Cooper finalized today:
  //
  //   /signin → /plan → stripe checkout → /deploying → /onboarding/done
  //
  // /connect is now a LEGACY power-user path (BYOB Telegram bot creation).
  // It's still reachable via the "use the legacy setup" footnote at the
  // bottom of this page + the same link on /channels, but it is NOT a
  // prerequisite for /plan.
  //
  // Three entry shapes this effect handles:
  //
  //  1. sessionStorage already populated (user is mid-flow, e.g. they
  //     went /channels → /onboarding/web → /plan, or /edge/claim →
  //     /connect → /plan): hydrate apiMode from storage, done.
  //  2. No sessionStorage, but pending row exists in DB (refresh/new
  //     tab of an in-flight session): rebuild sessionStorage from the
  //     DB row + hydrate apiMode.
  //  3. No sessionStorage, no pending row (the NEW /signin → /plan
  //     flow — most users post-Cooper's onboarding redesign): seed
  //     sessionStorage with web-channel defaults so handleCheckout's
  //     downstream /api/onboarding/save call gets channels:["web"]
  //     (passes the at-least-one-channel validation at the save
  //     endpoint) and the agent provisions in the same shape as the
  //     /onboarding/web silent-provision path (channels_enabled=[],
  //     no telegram/discord tokens, dashboard-only access). The user
  //     can later opt into a messaging channel via /channels.
  //
  // Edge flow uses the SAME flow as everyone else post-2026-05-29:
  // /edge/claim → /signin (callbackUrl="/plan" — claim-client.tsx
  // Google/email-OTP/ChatGPT-modal all updated) → /plan with the Edge
  // variant (olive headline + sponsor framing + olive CTA — gated on
  // partner=edge_city via the existing isEdge branch above). Edge
  // attendees hit Case 3 (no pending row) and the web-channel seed
  // applies — they provision with channels_enabled=[] (dashboard-only)
  // unless they opt into a messaging channel later via /channels.
  useEffect(() => {
    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (stored) {
      // Case 1 — sessionStorage present
      const data = JSON.parse(stored);
      setApiMode(data.apiMode ?? "all_inclusive");
      setHydrated(true);
      return;
    }

    // No sessionStorage — try to restore from DB (handles refresh / new
    // tab in flows that DID create a pending row earlier — Edge, /channels
    // skip-to-command-center, legacy /connect).
    fetch("/api/onboarding/wizard-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.pending) {
          // Case 2 — pending row in DB; rebuild sessionStorage.
          const restored = {
            botToken: data.pending.telegram_bot_token ?? "",
            channels: data.pending.telegram_bot_token
              ? ["telegram"]
              : data.pending.discord_bot_token
                ? ["discord"]
                : [],
            apiMode: data.pending.api_mode ?? "all_inclusive",
            model: data.pending.default_model ?? "claude-sonnet-4-6",
          };
          sessionStorage.setItem(
            "instaclaw_onboarding",
            JSON.stringify(restored),
          );
          setApiMode(restored.apiMode as "all_inclusive" | "byok");
          setHydrated(true);
        } else {
          // Case 3 — no prior state. Seed web-channel defaults so
          // handleCheckout's /api/onboarding/save call passes the
          // at-least-one-channel validation. /plan is now this user's
          // first onboarding page; previously they'd be bounced to
          // /connect, but that's no longer a required step.
          const seed = {
            botToken: "",
            channels: ["web"],
            apiMode: "all_inclusive",
            model: "claude-sonnet-4-6",
          };
          sessionStorage.setItem(
            "instaclaw_onboarding",
            JSON.stringify(seed),
          );
          setApiMode("all_inclusive");
          setHydrated(true);
        }
      })
      .catch(() => {
        // Network error reading wizard-status — same conservative seed
        // as Case 3. Better to let the user proceed and have
        // handleCheckout retry the save than to dead-end them at /connect
        // (which would now itself be confusing).
        const seed = {
          botToken: "",
          channels: ["web"],
          apiMode: "all_inclusive",
          model: "claude-sonnet-4-6",
        };
        try {
          sessionStorage.setItem(
            "instaclaw_onboarding",
            JSON.stringify(seed),
          );
        } catch {
          /* private mode — non-fatal, useState defaults still apply */
        }
        setApiMode("all_inclusive");
        setHydrated(true);
      });
  }, [router]);

  function handleToggleApiMode() {
    const newMode = apiMode === "all_inclusive" ? "byok" : "all_inclusive";
    setApiMode(newMode);

    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (stored) {
      const data = JSON.parse(stored);
      data.apiMode = newMode;
      sessionStorage.setItem("instaclaw_onboarding", JSON.stringify(data));
    }
  }

  async function handleCheckout() {
    setLoading(true);
    setError("");

    const stored = sessionStorage.getItem("instaclaw_onboarding");
    if (stored) {
      const data = JSON.parse(stored);
      data.tier = selectedTier;
      data.apiMode = apiMode;
      sessionStorage.setItem("instaclaw_onboarding", JSON.stringify(data));
    }

    try {
      const onboarding = JSON.parse(
        sessionStorage.getItem("instaclaw_onboarding") ?? "{}"
      );

      const saveRes = await fetch("/api/onboarding/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: onboarding.botToken,
          discordToken: onboarding.discordToken,
          slackToken: onboarding.slackToken,
          slackSigningSecret: onboarding.slackSigningSecret,
          whatsappToken: onboarding.whatsappToken,
          whatsappPhoneNumberId: onboarding.whatsappPhoneNumberId,
          channels: onboarding.channels,
          apiMode,
          apiKey: onboarding.apiKey,
          model: onboarding.model,
          tier: selectedTier,
        }),
      });

      if (!saveRes.ok) {
        const err = await saveRes.json();
        setLoading(false);
        setError(err.error || "Failed to save configuration. Please try again.");
        return;
      }
    } catch {
      setLoading(false);
      setError("Network error saving configuration. Please try again.");
      return;
    }

    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: selectedTier,
          apiMode,
          trial: true,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setLoading(false);
        setError(err.error || `Checkout failed (${res.status}). Please try again or contact support.`);
        return;
      }

      const data = await res.json();

      if (data.url) {
        // Small delay to ensure the user sees the loading state
        // Then redirect to Stripe checkout
        setTimeout(() => {
          window.location.href = data.url;
        }, 500);
      } else {
        setLoading(false);
        setError("Stripe checkout URL not received. Please try again or contact support.");
      }
    } catch (err) {
      setLoading(false);
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(`Network error creating checkout: ${errorMsg}. Please check your connection and try again.`);
    }
  }

  return (
    <LenisProvider>
      <div
        className="min-h-screen"
        style={{
          color: CARD_INK,
          /* Warm-sand atmosphere — verbatim from /channels and /signin
           * (channels-client.tsx:58-64, signin-client.tsx:58-64).
           * Layered radial gradients (coral 18% top / blue 14%
           * bottom-left / faint green 8% top-right) over the cream
           * linear base. Closes the visual seam between /signin →
           * /plan → /deploying so by the time the user is choosing a
           * tier they feel like they're still in the same room they
           * signed in from. */
          background: `
            radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
            radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
            radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
            linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
            ${CREAM_BG}
          `,
        }}
      >
        <EdgePartnerBanner />
        {/* Step Indicator */}
        <div
          className="sticky top-0 z-10 py-4"
          style={{
            background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.6))",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            borderBottom: "1px solid rgba(0, 0, 0, 0.06)",
          }}
        >
          <div className="max-w-5xl mx-auto px-6">
            <div className="flex items-center justify-center gap-2">
              {[
                { num: 1, label: "Sign in" },
                { num: 2, label: "Plan" },
                { num: 3, label: "Deploy" },
              ].map((step, i) => (
                <div key={step.num} className="flex items-center">
                  <div className="flex flex-col items-center">
                    {step.num === 2 ? (
                      /* Active step — glowing glass orb */
                      <span
                        className="relative flex items-center justify-center w-10 h-10 rounded-full overflow-hidden shrink-0"
                        style={{
                          background: "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)",
                          boxShadow: `
                            inset 0 -2px 4px rgba(0,0,0,0.3),
                            inset 0 2px 4px rgba(255,255,255,0.5),
                            inset 0 0 3px rgba(0,0,0,0.15),
                            0 1px 4px rgba(0,0,0,0.15)
                          `,
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full"
                          style={{
                            background: "linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.4) 55%, transparent 80%)",
                            backgroundSize: "300% 100%",
                            animation: "globe-shimmer 4s linear infinite",
                          }}
                        />
                        <span
                          className="absolute top-[3px] left-[5px] w-[14px] h-[8px] rounded-full pointer-events-none"
                          style={{
                            background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
                          }}
                        />
                        <span
                          className="absolute inset-[-3px] rounded-full"
                          style={{
                            background: "radial-gradient(circle, rgba(220,103,67,0.4) 0%, transparent 70%)",
                            animation: "globe-glow 4s ease-in-out infinite",
                          }}
                        />
                        <span className="relative text-sm font-semibold" style={{ color: "#ffffff" }}>
                          {step.num}
                        </span>
                      </span>
                    ) : step.num < 2 ? (
                      /* Completed step — green glass orb */
                      <span
                        className="relative flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold overflow-hidden"
                        style={{
                          background: "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.6), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
                          boxShadow: "rgba(34,197,94,0.3) 0px 2px 8px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                          color: "#ffffff",
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full pointer-events-none"
                          style={{
                            background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                          }}
                        />
                        <span className="relative">✓</span>
                      </span>
                    ) : (
                      /* Future step — glass orb */
                      <span
                        className="flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold"
                        style={{
                          ...glassStyle,
                          color: "#999999",
                        }}
                      >
                        {step.num}
                      </span>
                    )}
                    <span
                      className="text-xs mt-1.5 font-medium"
                      style={{ color: step.num === 2 ? "#333334" : "#999999" }}
                    >
                      {step.label}
                    </span>
                  </div>
                  {i < 2 && (
                    /* Connector between adjacent step orbs. The completed
                       connector (step 1 → step 2) stays green to match
                       the green completion-checkmark orb on either
                       side. The "in-progress" connector (step 2 → step
                       3) was previously a kinetic coral shimmer (300%
                       bg + 2s infinite animation) — too kinetic for
                       the wabi-sabi pass. Replaced with a static
                       muted-ink hairline so the eye doesn't get pulled
                       here while the user is reading tier copy. The
                       active step's own glowing orb (preserved
                       unchanged below) is the only animated element
                       remaining on the page. */
                    <div
                      className="w-16 mx-3 mb-5 rounded-full"
                      style={{
                        height: "2px",
                        background:
                          step.num < 2 ? "#22c55e" : "rgba(0, 0, 0, 0.06)",
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="text-center mb-8">
          {/* Headline. Edge attendees see "Your plan." in olive ink
              (existing palette + framing — first month sponsored by
              Edge Esmeralda; tier is pre-selected; the body block
              below communicates the trust frame). Non-Edge users get
              the lowercase serif clamp matching /channels' "pick a
              channel." and /signin's "sign in." — same typographic
              register so the three pages read as a single book. */}
          <h1
            className="font-normal mb-4"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: isEdge ? undefined : "clamp(44px, 12vw, 60px)",
              lineHeight: isEdge ? undefined : 1.0,
              letterSpacing: isEdge ? undefined : "-1.8px",
              color: isEdge ? "#29311E" : CARD_INK,
            }}
          >
            {isEdge ? "Your plan." : "choose a plan."}
          </h1>
          {/* Body block. Three audience branches:
              1) Edge attendees: olive-ink trust framing (Pro pre-selected,
                 first month sponsored by Edge Esmeralda, $0 today + cancel
                 anytime). Verbatim from the 2026-05-22 three-auth-paths
                 Edge spec — Timour-call-tested copy, do not touch without
                 talking to him.
              2) ChatGPT users (signed in via /signin's ChatGPT-OAuth path,
                 plan_type in CHATGPT_PAID_PLANS): a single quiet line
                 declaring their agent will run on their own ChatGPT
                 subscription. Replaces the toggle entirely — they don't
                 need to choose all-inclusive vs BYOK because the
                 reconciler will auto-route through Codex anyway. Delivers
                 on /signin's "have ChatGPT Plus? get a lower plan price."
                 nudge — pricing flips to BYOK (cheaper) silently below.
              3) Non-Edge, non-ChatGPT users: quiet "3 days free. cancel
                 anytime." subtitle (replaces the prior kinetic
                 squiggle/circle/highlighter marketing copy — too kinetic
                 for the wabi-sabi pass) + the All-Inclusive ↔ BYOK toggle
                 with lowercase labels + the lowercase BYOK explanation. */}
          {isEdge ? (
            <div>
              <p
                className="text-base mb-3"
                style={{ color: "#5a6240", textWrap: "balance" }}
              >
                Your first month is{" "}
                <span style={{ color: "#0f1a12", fontWeight: 600 }}>free</span>,
                courtesy of Edge Esmeralda.
              </p>
              <p
                className="text-sm flex items-baseline gap-3 mb-3"
                style={{ color: "#5a6240" }}
              >
                <span
                  className="line-through opacity-60"
                  style={{ fontSize: "0.95rem" }}
                >
                  $99/mo
                </span>
                <span
                  style={{ color: "#0f1a12", fontWeight: 700, fontSize: "1.05rem" }}
                >
                  $0 due today
                </span>
              </p>
              <p
                className="text-sm"
                style={{ color: "#5a6240", textWrap: "balance" }}
              >
                Add a payment method so your agent stays active after your free
                month. Cancel anytime.
              </p>
            </div>
          ) : (
            <>
              {/* Quiet subtitle — replaces the kinetic marketing copy. */}
              <p
                className="mx-auto"
                style={{
                  fontSize: 17,
                  lineHeight: 1.5,
                  color: MUTED_INK,
                  maxWidth: 380,
                }}
              >
                3 days free. cancel anytime.
              </p>

              {/* Toggle area — ChatGPT users see a static line declaring
                  their existing subscription is in use; everyone else
                  sees the All-Inclusive ↔ BYOK toggle. */}
              {isChatGPTUser ? (
                <p
                  className="mt-6 text-center"
                  style={{
                    fontSize: 13,
                    color: SUBTLE_INK,
                    lineHeight: 1.5,
                  }}
                >
                  using your chatgpt {chatgptPlanDisplay} subscription.
                </p>
              ) : (
                <>
                  <div
                    className="inline-flex items-center gap-3 text-sm mt-6 px-6 py-2.5 rounded-full"
                    style={glassStyle}
                  >
                    <span
                      className="font-medium"
                      style={{
                        color: apiMode === "byok" ? SUBTLE_INK : CARD_INK,
                      }}
                    >
                      all-inclusive
                    </span>
                    <button
                      type="button"
                      onClick={handleToggleApiMode}
                      aria-label="toggle pricing mode"
                      className="relative w-12 h-6 rounded-full transition-all cursor-pointer"
                      style={{
                        background:
                          "linear-gradient(-75deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.1))",
                        boxShadow: `
                          rgba(0, 0, 0, 0.15) 0px 1px 2px 0px inset,
                          rgba(255, 255, 255, 0.1) 0px -1px 1px 0px inset
                        `,
                      }}
                    >
                      <span
                        className="absolute top-1 w-4 h-4 rounded-full transition-all duration-200 ease-out"
                        style={{
                          left: apiMode === "byok" ? "28px" : "4px",
                          background:
                            "linear-gradient(-75deg, rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0.85))",
                          boxShadow: `
                            rgba(0, 0, 0, 0.1) 0px 1px 3px 0px,
                            rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset,
                            rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset
                          `,
                          backdropFilter: "blur(4px)",
                          WebkitBackdropFilter: "blur(4px)",
                        }}
                      />
                    </button>
                    <span
                      className="font-medium"
                      style={{
                        color: apiMode === "byok" ? CARD_INK : SUBTLE_INK,
                      }}
                    >
                      byok
                    </span>
                  </div>
                  {apiMode === "byok" && (
                    <p
                      className="mt-3"
                      style={{
                        fontSize: 12,
                        color: SUBTLE_INK,
                        lineHeight: 1.4,
                      }}
                    >
                      bring your own anthropic key. lower price, you pay
                      anthropic directly.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Tier grid — three cards, restrained hierarchy.
            Pro (tier.popular === true) gets the FULL liquid-glass-card
            treatment (refraction substrate + transparent + sheen + 4-layer
            box-shadow + conic-gradient rim + sibling drop-shadow ring) —
            same material as /channels' channel cards and /signin's OAuth
            pills. Starter and Power get the simpler flat-white treatment.
            The material differentiation IS the "this is the recommended
            tier" signal — no "POPULAR" badge billboard, no orange
            gradient pill, no urgency cue. The eye is drawn to Pro
            because it literally floats; the other two sit flat.
            A tiny lowercase "most popular." label sits at the top of
            the Pro card (11px subtle-ink, no background, single line,
            period) as a descriptive confirmation of what the material
            is signaling — not as promotional copy.
            Selected state: a 2px coral ring offset outside the card
            (works on both glass and flat without fighting the conic
            rim) + the price shifts to coral. No spinning border, no
            scale animation. Tier names stay Title Case (proper-noun
            product-tier labels — same convention as Stripe/Linear/
            Vercel) — descriptions + features are lowercase per the
            page's voice. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
          {tiers.map((tier) => {
            const price = apiMode === "byok" ? tier.byok : tier.allInclusive;
            const isSelected = selectedTier === tier.id;
            const isPopular = !!tier.popular;

            const cardInner = (
              <div className="text-left relative p-6 h-full">
                {isPopular && (
                  /* Quiet label. 11px SUBTLE_INK, no pill background,
                     period at end. The material differentiation does
                     the heavy lifting; this just confirms the signal
                     in words for users who scan text first. */
                  <p
                    className="mb-3"
                    style={{
                      fontSize: 11,
                      color: SUBTLE_INK,
                      letterSpacing: "0.04em",
                      lineHeight: 1.4,
                    }}
                  >
                    most popular.
                  </p>
                )}
                {/* Trial label REMOVED from the card top (2026-05-29
                    wabi-sabi pass). The "3 days free" message lives on
                    THREE places already: the page subtitle ("3 days
                    free. cancel anytime."), the per-card "free for 3
                    days." below the price, and Stripe's checkout UI.
                    A fourth repetition inside each tier card was
                    visual noise — dropped to let the price + features
                    breathe. */}

                <div className="mb-4">
                  <h3
                    className="text-xl font-normal mb-1"
                    style={{
                      fontFamily: "var(--font-serif)",
                      color: CARD_INK,
                      letterSpacing: "-0.3px",
                    }}
                  >
                    {tier.name}
                  </h3>
                  <p
                    style={{
                      fontSize: 12,
                      color: SUBTLE_INK,
                      lineHeight: 1.4,
                    }}
                  >
                    {tier.description}
                  </p>
                </div>

                <div className="mb-6">
                  <div className="flex items-baseline">
                    <span
                      className="text-4xl font-normal"
                      style={{
                        fontFamily: "var(--font-serif)",
                        color: isSelected ? CORAL : CARD_INK,
                        letterSpacing: "-1px",
                      }}
                    >
                      ${price}
                    </span>
                    <span
                      className="text-sm ml-1"
                      style={{ color: MUTED_INK }}
                    >
                      /mo
                    </span>
                  </div>
                  {tier.trial && (
                    <p
                      className="mt-1"
                      style={{
                        fontSize: 12,
                        color: SUBTLE_INK,
                      }}
                    >
                      free for 3 days.
                    </p>
                  )}
                </div>

                {/* Units / unlimited callout — lowercase rewrite per
                    Cooper's locked-in decision G (keep units count,
                    rewrite explanation lowercase). "haiku/sonnet"
                    technical jargon → "fast/smart messages" which is
                    parseable to anyone, not just users who know our
                    model lineup. */}
                <div
                  className="mb-4 py-2.5 px-3 rounded-md"
                  style={glassStyle}
                >
                  {apiMode === "all_inclusive" ? (
                    <>
                      <p
                        className="text-xs font-semibold"
                        style={{ color: CORAL }}
                      >
                        {tier.dailyUnits.toLocaleString()} units/day
                      </p>
                      <p
                        className="text-[10px] mt-0.5"
                        style={{ color: SUBTLE_INK }}
                      >
                        about {tier.dailyUnits.toLocaleString()} fast
                        messages, or {Math.floor(tier.dailyUnits / 4)}{" "}
                        smart ones.
                      </p>
                    </>
                  ) : (
                    <>
                      <p
                        className="text-xs font-semibold"
                        style={{ color: CARD_INK }}
                      >
                        unlimited usage
                      </p>
                      <p
                        className="text-[10px] mt-0.5"
                        style={{ color: SUBTLE_INK }}
                      >
                        pay anthropic directly for what you use.
                      </p>
                    </>
                  )}
                </div>

                <div className="space-y-2">
                  {(apiMode === "byok"
                    ? tier.byokFeatures
                    : tier.features
                  ).map((f) => (
                    <div
                      key={f}
                      className="text-xs flex items-start"
                      style={{ color: MUTED_INK, lineHeight: 1.5 }}
                    >
                      <span
                        className="mr-2 shrink-0"
                        style={{ color: CORAL }}
                      >
                        ✓
                      </span>
                      <span>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            );

            // Selected state — calm coral ring offset outside the card
            // boundary. Works on BOTH the glass Pro card and the flat
            // Starter/Power cards without fighting the glass conic rim.
            // 2026-05-29 redesign: replaces the prior `.glow-wrap`/`.glow-border`/
            // `.glow-spinner` spinning-border CSS (kinetic, marketing-y).
            // No animation; the ring is static — the user's choice
            // doesn't need to celebrate itself.
            const selectedRing = isSelected
              ? `0 0 0 2px ${CORAL}, 0 8px 24px rgba(233, 111, 77, 0.12)`
              : undefined;

            if (isPopular) {
              // Pro tier — full liquid-glass-card architecture (3 DOM
              // elements: root + surface + sibling shadow). Class is
              // defined in globals.css under the .liquid-glass-card
              // block (lines 990-1095). Selected state adds a coral
              // ring via inline boxShadow — does not interfere with
              // the conic-gradient rim because that's an ::after, not
              // a box-shadow.
              return (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => setSelectedTier(tier.id)}
                  className="text-left cursor-pointer p-0"
                  style={{
                    background: "transparent",
                    border: "none",
                  }}
                >
                  <div
                    className="liquid-glass-card-root"
                    style={{
                      minHeight: "auto",
                      boxShadow: selectedRing,
                      borderRadius: 12,
                      transition: "box-shadow 200ms ease",
                    }}
                  >
                    <div className="liquid-glass-card">{cardInner}</div>
                    <div
                      aria-hidden
                      className="liquid-glass-card-shadow"
                    />
                  </div>
                </button>
              );
            }

            // Starter + Power — simpler flat white card. The material
            // differentiation from Pro is what signals "Pro is special";
            // these cards just need to be legible and quietly present.
            return (
              <button
                key={tier.id}
                type="button"
                onClick={() => setSelectedTier(tier.id)}
                className="text-left cursor-pointer p-0"
                style={{
                  background: "transparent",
                  border: "none",
                }}
              >
                <div
                  className="rounded-xl transition-all duration-200"
                  style={{
                    background: "#ffffff",
                    border: `1px solid ${
                      isSelected ? "transparent" : "rgba(0, 0, 0, 0.06)"
                    }`,
                    boxShadow:
                      selectedRing ?? "0 1px 3px rgba(0, 0, 0, 0.04)",
                  }}
                >
                  {cardInner}
                </div>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="text-sm text-center mb-6" style={{ color: "#ef4444" }}>
            {error}
          </p>
        )}

        <button
          onClick={handleCheckout}
          disabled={loading}
          className="w-full px-6 py-4 rounded-lg font-semibold transition-all cursor-pointer disabled:opacity-50"
          style={{
            // 2026-05-22 W2 polish: Continue/Confirm CTA was orange-gradient for
            // everyone, including Edge attendees who'd just come through the
            // olive Edge funnel. Same brand-seam class F4 (commit 074f3bd6)
            // closed for /signin's EdgePartnerBanner. Edge users now get the
            // olive solid; non-Edge users keep the kinetic orange gradient.
            // Shadow + brand-orange highlight glow swapped to olive tones to
            // match. Headline + body for Edge already done in aa96584d.
            // --edge-olive is scoped under /edge/* via app/edge/layout.tsx; /plan
            // is under (onboarding), so the var is undefined here. Use the
            // canonical olive hex (#0f1a12) literal — matches every /edge
            // primary CTA + the Edge terminal's claim-client.tsx solid buttons.
            background: isEdge
              ? "#0f1a12"
              : "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            boxShadow: isEdge
              ? `
                rgba(255,255,255,0.18) 0px -1px 1px 0px inset,
                rgba(41,49,30,0.35) 0px 4px 16px 0px
              `
              : `
              rgba(255,255,255,0.2) 0px 2px 2px 0px inset,
              rgba(255,255,255,0.3) 0px -1px 1px 0px inset,
              rgba(220,103,67,0.35) 0px 4px 16px 0px,
              rgba(255,255,255,0.08) 0px 0px 1.6px 4px inset
            `,
            color: "#ffffff",
            fontSize: "15px",
            letterSpacing: "0.01em",
          }}
        >
          {loading ? (
            <span className="flex items-center gap-2 justify-center">
              <svg
                className="animate-spin h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              creating checkout session...
            </span>
          ) : "start free trial"}
        </button>

        {/* Enterprise section — quiet, confident, self-selecting.
            Sits below the primary CTA so the tier-selection decision
            flow isn't interrupted; the user who needs this section
            has already scrolled past the three tiers and is looking
            for an alternative path. No card boundary (lives in the
            warm-sand atmosphere directly — the visual distinction
            from the tier cards above is the LACK of a card, not a
            different card style). Two-column on desktop, stacked on
            mobile. Restraint over flash. No "Enterprise" eyebrow
            label, no "Contact Sales" CTA, no client logos, no
            urgency cues. The headline is declarative
            ("if it's bigger than one agent."), which is
            self-selecting: the wrong audience skips past, the right
            audience leans in.
            CTA links to https://cal.com/cooperwrenn (founder's Cal
            link — this audience hates SDR funnels; direct line to
            engineering is the closer). Glass pill via the
            .liquid-glass-signin class (recipe from /signin's OAuth
            buttons) — secondary to the primary coral CTA above; the
            material is premium without competing for the same
            attention. */}
        <section
          aria-labelledby="enterprise-heading"
          className="mt-20 pb-4 grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-12"
        >
          <div>
            <h2
              id="enterprise-heading"
              className="font-normal mb-4"
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: "clamp(28px, 4.5vw, 36px)",
                lineHeight: 1.05,
                letterSpacing: "-0.5px",
                color: CARD_INK,
              }}
            >
              if it&apos;s bigger than one agent.
            </h2>
            <p
              style={{
                fontSize: 16,
                lineHeight: 1.6,
                color: MUTED_INK,
                maxWidth: "28rem",
              }}
            >
              running a fund. building a defi product. scaling agents
              across a team. the tiers above won&apos;t quite fit — and
              that&apos;s fine. let&apos;s talk about what will.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            {/* Capability beats. Em-dash prefix (not checkmarks — those
                read as feature-comparison-table copy; em-dashes are
                quieter typography that lets the words breathe). Four
                beats not three: each maps to one of the four buyer
                archetypes Cooper named (crypto fund / defi protocol /
                private deployment / team-of-many-agents). */}
            <ul
              className="space-y-2.5"
              style={{
                fontSize: 14,
                lineHeight: 1.6,
                color: MUTED_INK,
              }}
            >
              <li>— private cloud or your own infrastructure</li>
              <li>— multi-agent coordination across your team</li>
              <li>— custom skills, built around your product</li>
              <li>— direct support from the people who built it</li>
            </ul>

            <div className="liquid-glass-signin-root" style={{ maxWidth: 240 }}>
              <Link
                href="https://cal.com/cooperwrenn"
                target="_blank"
                rel="noopener noreferrer"
                className="liquid-glass-signin"
                style={{
                  textDecoration: "none",
                  fontFamily: "inherit",
                  letterSpacing: "-0.15px",
                }}
              >
                book a call. <span aria-hidden style={{ marginLeft: 4 }}>→</span>
              </Link>
              <div aria-hidden className="liquid-glass-signin-shadow" />
            </div>
          </div>
        </section>

        {/* Legacy-setup footnote (2026-05-29 routing-bug fix).
            /plan is no longer gated behind /connect (the BYOB Telegram
            bot creation page). Users who specifically want to bring
            their own Telegram bot can still reach /connect via this
            link. Same register as /channels' "use the legacy setup"
            footnote (channels-client.tsx:282-298) — 13px SUBTLE_INK,
            lowercase, single underlined link in MUTED_INK. Hidden
            for Edge attendees because they ALREADY came through
            /connect en route here (claim-client.tsx:296 →
            connect/page.tsx:289 → /plan), so the link would be
            confusing for them. */}
        {!isEdge && (
          <p
            className="mt-10 text-center"
            style={{ fontSize: 13, color: SUBTLE_INK, lineHeight: 1.5 }}
          >
            want your own Telegram bot?{" "}
            <Link
              href="/connect"
              className="transition-opacity hover:opacity-70"
              style={{
                color: MUTED_INK,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              use the legacy setup
            </Link>
            .
          </p>
        )}

        {/* Support footer — F3 audit fix 2026-05-22. /plan is where the
            Stripe checkout creation can fail (network, deployment lock,
            existing-sub edge case) and previously the only escape was
            the inline error message. SupportFooter gives attendees a
            persistent contact path. */}
        <div
          className="mt-6 text-center"
          style={{ fontSize: 12, color: SUBTLE_INK }}
        >
          <SupportFooter />
        </div>
        </div>
      </div>
    </LenisProvider>
  );
}
