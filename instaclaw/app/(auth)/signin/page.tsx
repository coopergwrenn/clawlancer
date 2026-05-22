"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ChatGPTConnectModal } from "@/components/dashboard/chatgpt-connect-modal";
import { EdgePartnerBanner } from "@/components/marketing/edge-partner-banner";
import { SupportFooter } from "@/components/marketing/support-footer";

function SignInContent() {
  // Honor `?callbackUrl=` URL param so partner-flow links like
  // /signin?callbackUrl=/api/partner/tag-redirect can route the user back
  // to a specific post-auth handler. Falls back to /dashboard for the
  // default "just sign me in" path.
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") || "/dashboard";

  // ChatGPT-as-signin opens the device-code modal in signup mode. The
  // modal handles the full polling + identity-resolution + signIn() flow
  // — see chatgpt-connect-modal.tsx and lib/openai-signup-* for the
  // backend bridge. On success the modal calls signIn("openai-device-code",
  // {signupToken, callbackUrl}) which establishes a NextAuth session via
  // the Credentials provider and redirects to callbackUrl.
  const [chatgptModalOpen, setChatgptModalOpen] = useState(false);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: "#f8f7f4",
        color: "#333334",
      }}
    >
      {/* EdgePartnerBanner — F4 audit fix 2026-05-22. Closes the brand
          seam between /edge/setup (olive Edge palette) and /signin
          (previously: bare cream/orange InstaClaw chrome with no Edge
          signal). The banner reads the instaclaw_partner cookie and
          renders nothing for non-partner users — so this addition is
          invisible to the 99% of /signin visitors who aren't Edge
          attendees and load-bearing for the 1% who are. */}
      <EdgePartnerBanner />

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md space-y-10">
        {/* Logo */}
        <Link href="/" className="flex items-center justify-center gap-2">
          <Image src="/logo.png" alt="Instaclaw" width={40} height={40} unoptimized style={{ imageRendering: "pixelated" }} />
          <span
            className="text-2xl tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Instaclaw
          </span>
        </Link>

        {/* Heading.
            Neutral wording so the page reads correctly for BOTH first-time
            signups (Edge attendees hitting /signin via /edge/setup) and
            returning users hitting /signin to sign back in. "Welcome Back"
            was returning-user-specific; "Sign in" works for both because
            both the Google and ChatGPT buttons SAY "Sign in with X" — and
            those flows create-or-link the account underneath, so the user
            doesn't need to know whether they're signing in or signing up.
            The subtitle says "or create" to make that intent explicit. */}
        <div className="text-center space-y-3">
          <h1
            className="text-4xl sm:text-5xl font-normal tracking-[-1px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Sign in
          </h1>
          <p className="text-base" style={{ color: "#6b6b6b" }}>
            Sign in or create your Instaclaw account.
          </p>
        </div>

        {/* Auth choices — Google and ChatGPT are equal-weight options.
            Stacked vertically with matching styling: white bg, subtle
            border, identical padding + radius. The user picks one. No
            "preferred" treatment, no "or" separator — both are first-class. */}
        <div className="space-y-3">
          {/* Google sign-in */}
          <button
            onClick={() => signIn("google", { callbackUrl })}
            className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-3 hover:bg-[#fafafa]"
            style={{
              background: "#ffffff",
              color: "#333334",
              border: "1px solid rgba(0, 0, 0, 0.1)",
            }}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.10z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>

          {/* ChatGPT sign-in — equal weight to Google. Sparkles icon
              matches the existing /settings ChatGPT-connection panel + the
              modal's brand cue (we deliberately don't ship OpenAI's logo
              mark for trademark hygiene; Sparkles reads as "AI-flavored
              auth" without ambiguity). */}
          <button
            onClick={() => setChatgptModalOpen(true)}
            className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-3 hover:bg-[#fafafa]"
            style={{
              background: "#ffffff",
              color: "#333334",
              border: "1px solid rgba(0, 0, 0, 0.1)",
            }}
          >
            <Sparkles className="w-5 h-5" style={{ color: "#10a37f" }} />
            Sign in with ChatGPT
          </button>
        </div>

        {/* Link to signup */}
        <p className="text-sm text-center" style={{ color: "#6b6b6b" }}>
          Have an invite code?{" "}
          <Link
            href="/signup"
            className="underline transition-opacity hover:opacity-70"
            style={{ color: "#333334" }}
          >
            Use it here
          </Link>
        </p>

        {/* Support footer — F3 audit fix 2026-05-22. /signin was the
            only auth surface with no escape hatch when something goes
            wrong (OAuth fails, ChatGPT modal errors, network issue,
            etc.). Small centered line, deferential opacity, inherits
            the parent's muted gray color. */}
        <p
          className="text-[12px] text-center"
          style={{ color: "#6b6b6b" }}
        >
          <SupportFooter />
        </p>
        </div>
      </div>

      {/* ChatGPT signup-mode modal. Mounted at this level so it can
          render over the entire /signin viewport (its own backdrop +
          focus trap handle modal etiquette). Closed initially; opened
          by the ChatGPT button above. */}
      <ChatGPTConnectModal
        isOpen={chatgptModalOpen}
        onClose={() => setChatgptModalOpen(false)}
        mode="signup"
        signupCallbackUrl={callbackUrl}
      />
    </div>
  );
}

export default function SignInPage() {
  // useSearchParams suspends — Next requires the consumer to be inside a
  // Suspense boundary so the page can statically prerender the shell.
  return (
    <Suspense
      fallback={
        <div
          className="min-h-screen flex items-center justify-center px-4"
          style={{ background: "#f8f7f4" }}
        />
      }
    >
      <SignInContent />
    </Suspense>
  );
}
