"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { LenisProvider } from "@/components/landing/lenis-provider";
import { SupportFooter } from "@/components/marketing/support-footer";
import { ChatGPTConnectModal } from "@/components/dashboard/chatgpt-connect-modal";

/**
 * Anthropic API key prefix regex — loose. Mirrors the equivalent regex
 * in /api/onboarding/save-provider so client + server agree on shape.
 * We deliberately don't tighten this — Anthropic's segment scheme has
 * changed (sk-ant-api03-…, sk-ant-api04-…, older sk-ant-… without a
 * segment all exist in the wild) and the real validation is the first
 * API call from the VM.
 */
const ANTHROPIC_KEY_PREFIX_RE = /^sk-ant-[A-Za-z0-9_-]{8,}$/;

// Brand constants — same set as /channels / /signin / /plan. Inline
// keeps the page self-contained for design review (a future palette
// change would update these three lines across all four onboarding
// surfaces in parallel — keeps the diff trail explicit).
const CORAL = "#E96F4D";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";

// Step indicator orb — duplicated from /plan because the wabi-sabi
// pass keeps each onboarding page typographically self-contained
// rather than factoring into a shared component. If we ever change
// the orb visual, /plan + this page need to update together — easy
// to grep for via "globe-shimmer" / "globe-glow".
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

interface ProviderClientProps {
  /**
   * Stripe Checkout Session id passed through from billing/checkout's
   * success_url. Null when the page is opened directly (e.g. from
   * /settings or a bookmark). We thread it forward when redirecting to
   * /deploying / /onboarding/done so post-redirect verification still
   * works for users who came through Stripe.
   */
  stripeSessionId: string | null;
}

interface ProviderStatus {
  pendingId: string | null;
  apiMode: "byok" | "all_inclusive" | null;
  channel: string | null;
  hasAnthropicKey: boolean;
  hasChatGPTOAuth: boolean;
  chatgptPlanType: string | null;
}

export function ProviderClient({ stripeSessionId }: ProviderClientProps) {
  const router = useRouter();
  const { update: updateSession } = useSession();

  // ── State machine ─────────────────────────────────────────────────
  // The page has three terminal states:
  //   "loading"  — fetching provider-status on mount or in-flight save
  //   "ready"    — show the configure UI (Anthropic input + ChatGPT
  //                button + skip)
  //   "redirect" — short-circuit (already configured / saved / skipped)
  //
  // We don't explicitly track "redirect" — once we know where to go, we
  // call router.replace and unmount. Loading flag covers both initial
  // fetch and save-in-flight (they look identical to the user — a
  // spinner — and they're mutually exclusive).
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Anthropic key inputs
  const [anthropicKey, setAnthropicKey] = useState("");
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [keyError, setKeyError] = useState("");

  // ChatGPT modal control + a transient "syncing your connection"
  // loading state shown after the modal closes but before we redirect.
  // The modal's onConnected fires when OAuth completes — we then post
  // to save-provider (no apiKey) which triggers configure + we
  // navigate forward.
  const [chatgptModalOpen, setChatgptModalOpen] = useState(false);

  // Global error banner — surfaces network failures, server errors,
  // and the rare "ChatGPT modal succeeded but save-provider couldn't
  // confirm OAuth state" case. Cleared on any retry.
  const [pageError, setPageError] = useState("");

  /**
   * Compute the destination after the user has a provider configured
   * (or has skipped). Channel-onboarding users (iMessage / Telegram
   * shared bot / etc.) land on /onboarding/done; the rest go to
   * /deploying. We pass the Stripe session id through so the destination
   * page can call /api/checkout/verify if it hasn't been verified yet.
   */
  const computeNext = useCallback(
    (s: ProviderStatus): string => {
      if (s.channel && s.pendingId) {
        const stripeParam = stripeSessionId
          ? `&stripe=${encodeURIComponent(stripeSessionId)}`
          : "";
        return `/onboarding/done?session=${encodeURIComponent(s.pendingId)}${stripeParam}`;
      }
      return stripeSessionId
        ? `/deploying?session_id=${encodeURIComponent(stripeSessionId)}`
        : "/deploying";
    },
    [stripeSessionId],
  );

  /**
   * Mount effect — fetch the user's provider state. Three outcomes:
   *
   *   - apiMode is "all_inclusive" → user shouldn't be on this page;
   *     redirect forward immediately. (Defense in depth — the
   *     billing/checkout success_url branch already filters this case,
   *     but if a user bookmarks /onboarding/provider they could hit
   *     this state legitimately.)
   *
   *   - Already has a provider (api_key OR OAuth) → redirect forward.
   *     Handles refresh / re-visit after configuring.
   *
   *   - BYOK + no provider → render the configure UI.
   */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/onboarding/provider-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ProviderStatus | null) => {
        if (cancelled) return;
        if (!data) {
          setPageError("Couldn't load your account. Please refresh.");
          setLoading(false);
          return;
        }
        // No pending row at all → user hasn't gone through /plan. Send
        // them to dashboard (signed-in but uncommitted state) so they
        // can pick up the flow from there.
        if (!data.apiMode) {
          router.replace("/dashboard");
          return;
        }
        // All-inclusive — no provider config needed.
        if (data.apiMode === "all_inclusive") {
          router.replace(computeNext(data));
          return;
        }
        // BYOK + already configured (Anthropic key set OR ChatGPT OAuth).
        if (data.hasAnthropicKey || data.hasChatGPTOAuth) {
          router.replace(computeNext(data));
          return;
        }
        // BYOK + no provider — render the configure UI.
        setStatus(data);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPageError("Network error. Please refresh and try again.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router, computeNext]);

  /**
   * Anthropic-key submit. Validates loose prefix client-side (the same
   * regex on the server is authoritative), POSTs to save-provider, and
   * redirects forward on 200. Errors are inline at the input.
   */
  const submitAnthropicKey = useCallback(async () => {
    setKeyError("");
    setPageError("");
    const trimmed = anthropicKey.trim();
    if (!trimmed) {
      setKeyError("Enter your Anthropic API key.");
      return;
    }
    if (!ANTHROPIC_KEY_PREFIX_RE.test(trimmed)) {
      setKeyError(
        "That doesn't look like an Anthropic key. Keys start with sk-ant-…",
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/onboarding/save-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSaving(false);
        setKeyError(
          body?.error ?? "Couldn't save the key. Please try again.",
        );
        return;
      }
      if (!status) return;
      router.replace(computeNext(status));
    } catch {
      setSaving(false);
      setPageError("Network error saving key. Please try again.");
    }
  }, [anthropicKey, computeNext, router, status]);

  /**
   * ChatGPT modal onConnected handler. Fires once the device-code OAuth
   * completes and the token is persisted server-side. We:
   *   1. Close the modal.
   *   2. Refresh the NextAuth session so chatgpt_plan_type +
   *      openai_oauth_account_id flow into session.user (used by other
   *      pages, e.g. /dashboard's banner).
   *   3. POST to save-provider with no apiKey — the endpoint verifies
   *      OAuth is set in DB, then fires configure server-side.
   *   4. Redirect forward.
   */
  const onChatGPTConnected = useCallback(async () => {
    setChatgptModalOpen(false);
    setSaving(true);
    setPageError("");
    try {
      void updateSession();
      const res = await fetch("/api/onboarding/save-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setSaving(false);
        setPageError(
          body?.error ??
            "Connected to ChatGPT, but couldn't confirm with the server. Please refresh.",
        );
        return;
      }
      if (!status) return;
      router.replace(computeNext(status));
    } catch {
      setSaving(false);
      setPageError(
        "Network error after connecting ChatGPT. Please refresh and try again.",
      );
    }
  }, [computeNext, router, status, updateSession]);

  /**
   * Skip handler. The user explicitly chose to defer provider setup.
   * We redirect forward without touching pending_users — the VM will
   * provision in BYOK mode with no Anthropic key, agent boots but
   * Anthropic calls fail at message time. The user can return via
   * /settings (or this URL) anytime to add their credential.
   *
   * Phase B will add a dashboard banner reminding skipped users that
   * their agent is half-configured. For Phase A this is honest: we
   * tell them on the page what will happen.
   */
  const skip = useCallback(() => {
    if (!status) return;
    router.replace(computeNext(status));
  }, [computeNext, router, status]);

  // ── Render ────────────────────────────────────────────────────────

  if (loading || !status) {
    return (
      <LenisProvider>
        <div
          className="min-h-screen flex items-center justify-center"
          style={{
            color: CARD_INK,
            background: `
              radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
              radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
              radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
              linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
              ${CREAM_BG}
            `,
          }}
        >
          {pageError ? (
            <p
              className="text-center px-6"
              style={{ color: MUTED_INK, fontSize: 14, lineHeight: 1.5 }}
            >
              {pageError}
            </p>
          ) : (
            <Loader2
              className="animate-spin"
              size={22}
              style={{ color: SUBTLE_INK }}
              aria-label="Loading"
            />
          )}
        </div>
      </LenisProvider>
    );
  }

  return (
    <LenisProvider>
      <div
        className="min-h-screen"
        style={{
          color: CARD_INK,
          /* Same warm-sand atmosphere as /plan, /signin, /channels —
             keeps the four-page onboarding sequence visually unified. */
          background: `
            radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
            radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
            radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
            linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
            ${CREAM_BG}
          `,
        }}
      >
        {/* Step indicator — same 3-step pattern as /plan. Provider sits
            inside step 3 (Deploy); we deliberately don't add a 4th step
            so the page feels like part of the deploy flow, not a new
            ceremony. Sign in ✓, Plan ✓, Deploy active (glowing orb). */}
        <div
          className="sticky top-0 z-10 py-4"
          style={{
            background:
              "linear-gradient(-75deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.6))",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            borderBottom: "1px solid rgba(0, 0, 0, 0.06)",
          }}
        >
          <div className="max-w-5xl mx-auto px-6">
            <div className="flex items-center justify-center gap-2">
              {[
                { num: 1, label: "Sign in", state: "done" as const },
                { num: 2, label: "Plan", state: "done" as const },
                { num: 3, label: "Deploy", state: "active" as const },
              ].map((step, i) => (
                <div key={step.num} className="flex items-center">
                  <div className="flex flex-col items-center">
                    {step.state === "active" ? (
                      <span
                        className="relative flex items-center justify-center w-10 h-10 rounded-full overflow-hidden shrink-0"
                        style={{
                          background:
                            "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)",
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
                            background:
                              "linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.4) 55%, transparent 80%)",
                            backgroundSize: "300% 100%",
                            animation: "globe-shimmer 4s linear infinite",
                          }}
                        />
                        <span
                          className="absolute top-[3px] left-[5px] w-[14px] h-[8px] rounded-full pointer-events-none"
                          style={{
                            background:
                              "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
                          }}
                        />
                        <span
                          className="absolute inset-[-3px] rounded-full"
                          style={{
                            background:
                              "radial-gradient(circle, rgba(220,103,67,0.4) 0%, transparent 70%)",
                            animation: "globe-glow 4s ease-in-out infinite",
                          }}
                        />
                        <span
                          className="relative text-sm font-semibold"
                          style={{ color: "#ffffff" }}
                        >
                          {step.num}
                        </span>
                      </span>
                    ) : (
                      <span
                        className="relative flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold overflow-hidden"
                        style={{
                          background:
                            "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.6), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
                          boxShadow:
                            "rgba(34,197,94,0.3) 0px 2px 8px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                          color: "#ffffff",
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full pointer-events-none"
                          style={{
                            background:
                              "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                          }}
                        />
                        <span className="relative">✓</span>
                      </span>
                    )}
                    <span
                      className="text-xs mt-1.5 font-medium"
                      style={{
                        color: step.state === "active" ? CARD_INK : "#999999",
                      }}
                    >
                      {step.label}
                    </span>
                  </div>
                  {i < 2 && (
                    <div
                      className="w-16 mx-3 mb-5 rounded-full"
                      style={{
                        height: "2px",
                        background: "#22c55e",
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <main className="max-w-xl mx-auto px-6 pt-10 pb-16">
          <div className="text-center mb-10">
            <h1
              className="font-normal mb-4"
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: "clamp(40px, 10vw, 56px)",
                lineHeight: 1.0,
                letterSpacing: "-1.6px",
                color: CARD_INK,
              }}
            >
              connect your provider.
            </h1>
            <p
              className="mx-auto"
              style={{
                fontSize: 17,
                lineHeight: 1.5,
                color: MUTED_INK,
                maxWidth: 460,
              }}
            >
              bring your own anthropic key or chatgpt subscription. you pay the
              provider directly.
            </p>
          </div>

          {pageError && (
            <p
              className="text-center mb-6"
              style={{ color: "#d04444", fontSize: 13, lineHeight: 1.5 }}
            >
              {pageError}
            </p>
          )}

          {/* ── Anthropic key section ───────────────────────────── */}
          <section className="mb-8" aria-labelledby="provider-anthropic-label">
            <label
              id="provider-anthropic-label"
              htmlFor="provider-anthropic-input"
              className="block mb-3"
              style={{
                fontSize: 12,
                color: SUBTLE_INK,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              anthropic api key
            </label>
            <div className="relative">
              <input
                id="provider-anthropic-input"
                type={showAnthropicKey ? "text" : "password"}
                value={anthropicKey}
                onChange={(e) => {
                  setAnthropicKey(e.target.value);
                  if (keyError) setKeyError("");
                }}
                onBlur={() => {
                  const trimmed = anthropicKey.trim();
                  if (trimmed && !ANTHROPIC_KEY_PREFIX_RE.test(trimmed)) {
                    setKeyError(
                      "That doesn't look like an Anthropic key. Keys start with sk-ant-…",
                    );
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !saving) {
                    e.preventDefault();
                    void submitAnthropicKey();
                  }
                }}
                placeholder="sk-ant-api03-…"
                aria-label="Anthropic API key"
                disabled={saving}
                className="w-full font-mono outline-none"
                style={{
                  padding: "14px 48px 14px 18px",
                  borderRadius: 9999,
                  background: "rgba(255, 255, 255, 0.75)",
                  border: `1px solid ${
                    keyError ? "rgba(220,60,60,0.45)" : "rgba(0, 0, 0, 0.08)"
                  }`,
                  color: CARD_INK,
                  fontSize: 14,
                  letterSpacing: "-0.1px",
                  boxShadow: keyError
                    ? "0 0 0 3px rgba(220,60,60,0.10)"
                    : "0 1px 2px rgba(0, 0, 0, 0.03)",
                  transition:
                    "border-color 0.18s ease, box-shadow 0.18s ease",
                }}
              />
              <button
                type="button"
                onClick={() => setShowAnthropicKey(!showAnthropicKey)}
                aria-label={
                  showAnthropicKey ? "Hide API key" : "Show API key"
                }
                disabled={saving}
                className="absolute top-1/2 -translate-y-1/2 cursor-pointer"
                style={{
                  right: 16,
                  color: SUBTLE_INK,
                  display: "flex",
                  alignItems: "center",
                  padding: 4,
                }}
              >
                {showAnthropicKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {keyError && (
              <p
                className="mt-2 text-center"
                style={{
                  fontSize: 12,
                  color: "rgba(180, 50, 50, 0.85)",
                  lineHeight: 1.4,
                }}
              >
                {keyError}
              </p>
            )}

            <div
              className="liquid-glass-signin-root cta-coral mt-5 mx-auto"
              style={{ maxWidth: 360 }}
            >
              <button
                onClick={submitAnthropicKey}
                disabled={saving}
                className="liquid-glass-signin"
                style={
                  saving ? { opacity: 0.5, cursor: "not-allowed" } : undefined
                }
              >
                {saving ? (
                  <span className="flex items-center gap-2 justify-center">
                    <Loader2 className="animate-spin" size={16} />
                    saving...
                  </span>
                ) : (
                  "save and continue"
                )}
              </button>
              <div aria-hidden className="liquid-glass-signin-shadow" />
            </div>
          </section>

          {/* ── OR divider ──────────────────────────────────────── */}
          <div
            className="mx-auto mb-8 flex items-center gap-4"
            style={{ maxWidth: 460 }}
            aria-hidden
          >
            <div
              style={{
                flex: 1,
                height: 1,
                background: "rgba(0, 0, 0, 0.08)",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: SUBTLE_INK,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              or
            </span>
            <div
              style={{
                flex: 1,
                height: 1,
                background: "rgba(0, 0, 0, 0.08)",
              }}
            />
          </div>

          {/* ── ChatGPT section ─────────────────────────────────── */}
          <section className="mb-12">
            <div
              className="liquid-glass-signin-root mx-auto"
              style={{ maxWidth: 460 }}
            >
              <button
                onClick={() => {
                  setPageError("");
                  setChatgptModalOpen(true);
                }}
                disabled={saving}
                className="liquid-glass-signin"
                style={
                  saving ? { opacity: 0.5, cursor: "not-allowed" } : undefined
                }
              >
                connect your chatgpt plus/pro/team subscription
              </button>
              <div aria-hidden className="liquid-glass-signin-shadow" />
            </div>
            <p
              className="text-center mt-3"
              style={{ fontSize: 12, color: SUBTLE_INK, lineHeight: 1.5 }}
            >
              we&apos;ll route your agent through chatgpt with your account&apos;s
              built-in usage.
            </p>
          </section>

          {/* ── Skip footer ──────────────────────────────────────
              Underlined link in muted ink, with the consequence
              spelled out plainly underneath. We deliberately don't
              wrap the link in a confirmation modal — the consequence
              text is enough. Cooper's spec: skip is a real option,
              not a hidden one. */}
          <div className="text-center">
            <button
              type="button"
              onClick={skip}
              disabled={saving}
              className="underline cursor-pointer"
              style={{
                fontSize: 13,
                color: MUTED_INK,
                letterSpacing: "-0.1px",
                textUnderlineOffset: 3,
                background: "transparent",
                border: "none",
              }}
            >
              i&apos;ll do this later
            </button>
            <p
              className="mt-2 mx-auto"
              style={{
                fontSize: 11,
                color: SUBTLE_INK,
                lineHeight: 1.5,
                maxWidth: 380,
              }}
            >
              your agent won&apos;t be able to chat until you connect a provider.
              you can do this anytime from settings.
            </p>
          </div>

          <div
            className="mt-10 text-center"
            style={{ fontSize: 12, color: SUBTLE_INK }}
          >
            <SupportFooter />
          </div>
        </main>
      </div>

      {/* ChatGPT Connect modal (connect mode — user has a session,
          we just need to attach OAuth to their account). onConnected
          fires after the device-code completes; we refresh the
          NextAuth session, ping save-provider to trigger configure,
          and redirect forward. */}
      <ChatGPTConnectModal
        isOpen={chatgptModalOpen}
        onClose={() => setChatgptModalOpen(false)}
        onConnected={() => {
          void onChatGPTConnected();
        }}
      />
    </LenisProvider>
  );
}
