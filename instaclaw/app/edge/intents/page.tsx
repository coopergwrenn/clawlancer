import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { createMetadata } from "@/lib/seo";
import { IntentsClient } from "./intents-client";
import { SupportFooter } from "@/components/marketing/support-footer";

/**
 * /edge/intents — the final step of the Edge Esmeralda onboarding.
 *
 * Server-side gate: only Edge attendees who haven't yet expressed an
 * intent render the form. Everyone else is bounced to /dashboard. The
 * gate is enforced server-side here AND in the dashboard layout's
 * useEffect (defense in depth — catches direct nav, refresh, deep-links).
 *
 * Visual language matches /edge/claim's verified reveal exactly: same
 * Edge palette (inherited from /edge/layout.tsx), same headline cadence
 * (2-line, period lands on line 2), same ✓-marked eyebrow after the
 * submission moment. The arc from /edge/claim → /edge/intents is:
 *
 *   /edge/claim initial   "Claim your / agent."
 *   /edge/claim verified  "Reserved / for the village."
 *   /edge/intents initial "Tell your / agent."
 *   /edge/intents sent    "Your agent / knows."
 *
 * Four beats, one rhythm — the whole 28-day journey told in 8 words.
 *
 * Hands off the actual form widget to IntentsClient (a thin wrapper
 * over the shared IntentForm component from /edge/dashboard). Page
 * owns chrome (top bar, footer); client owns the state machine +
 * page-level morph animation.
 */

export const metadata = createMetadata({
  title: "Tell your Edge Esmeralda agent what you're here for",
  description:
    "Your village agent is ready. Tell it once, in your own words, what you're here for — it'll start finding people who overlap with you across the 28-day Edge Esmeralda village.",
  path: "/edge/intents",
  ogTitle: "Tell your Edge Esmeralda agent what you're here for",
  ogImage: "/edge/og-edge.png",
});

export default async function EdgeIntentsPage() {
  // 1. Auth — unauthenticated users get bounced to signin with this
  //    URL preserved so they return here after OAuth.
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/signin?callbackUrl=%2Fedge%2Fintents");
  }

  // 2. Partner + intent-status check — single DB read.
  //    Non-Edge users shouldn't be here at all; Edge users who've
  //    already submitted bypass the gate.
  const supabase = getSupabase();
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("partner, index_last_intent_at")
    .eq("id", session.user.id)
    .maybeSingle();

  if (!user || user.partner !== "edge_city") {
    redirect("/dashboard");
  }
  if (user.index_last_intent_at !== null) {
    // One-shot gate: once they've submitted ANY intent, they manage
    // additional intents from the dashboard's adaptive section (FUP-3b).
    // Re-entering this page would feel like a retread of the onboarding
    // they already completed.
    redirect("/dashboard");
  }

  return (
    <main className="relative min-h-screen flex flex-col">
      {/* ── Top bar ── */}
      <header
        className="relative z-10 px-4 sm:px-8 py-5 sm:py-6"
        style={{ borderBottom: "1px solid var(--edge-line-soft)" }}
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <Link
            href="/edge"
            aria-label="Edge Esmeralda - back to landing"
            className="flex items-center"
          >
            <Image
              src="/edge/edge-esmeralda-wordmark.svg"
              alt="Edge Esmeralda"
              width={180}
              height={58}
              priority
              style={{ height: "32px", width: "auto" }}
            />
          </Link>

          <span
            className="hidden sm:inline text-[11px] uppercase tracking-[0.18em]"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            May 30 – Jun 27, 2026
          </span>
        </div>
      </header>

      {/* ── Gate body — IntentsClient owns the state machine + morph ── */}
      <IntentsClient />

      {/* ── Compact footer ── */}
      <footer
        className="relative z-10 px-4 sm:px-8 py-7 sm:py-8"
        style={{ borderTop: "1px solid var(--edge-line-soft)" }}
      >
        <div
          className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em]"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          <span>
            Edge Esmeralda · May 30 – Jun 27 · Powered by{" "}
            <Link
              href="/"
              className="underline-offset-4 hover:underline"
              style={{ color: "var(--edge-ink)" }}
            >
              InstaClaw
            </Link>
          </span>
          <div className="flex items-center gap-4 sm:gap-5">
            <SupportFooter />
            <span>Final step</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
