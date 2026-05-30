import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { createMetadata } from "@/lib/seo";
import { ProviderClient } from "./provider-client";

/**
 * /onboarding/provider — post-Stripe provider configuration step.
 *
 * This page is conditionally inserted into the post-checkout redirect
 * chain by /api/billing/checkout when a BYOK user lands without a
 * provider configured (no pending_users.api_key AND no
 * instaclaw_users.openai_oauth_account_id). All-inclusive users and
 * pre-connected ChatGPT users bypass it via direct success_url to
 * /deploying or /onboarding/done.
 *
 * Server responsibilities are intentionally minimal:
 *   1. Enforce auth (middleware also enforces, but defense-in-depth).
 *   2. Hand off to the client which fetches /api/onboarding/provider-
 *      status to render the right state (configure UI vs short-circuit).
 *
 * The page is safe to bookmark and revisit — the client always re-
 * checks server state on mount, so if the user already configured a
 * provider in another tab / /settings, they're redirected forward.
 */

export const metadata = createMetadata({
  title: "Connect your AI provider",
  description:
    "Connect your Anthropic API key or ChatGPT Plus/Pro/Team subscription to power your InstaClaw agent.",
  path: "/onboarding/provider",
});

interface PageProps {
  searchParams: Promise<{ stripe?: string }>;
}

export default async function ProviderPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const stripeId = typeof params.stripe === "string" ? params.stripe : null;

  const session = await auth();
  if (!session?.user?.id) {
    // Preserve the original destination so post-signin lands back here
    // with the same query params. Stripe's session id is short-lived
    // (24h) so by the time the user authenticates the stripe param
    // may be stale, but that's acceptable — the Provider client
    // doesn't require it (the redirect target is derived from
    // pending.channel, not from the stripe id).
    const next = stripeId
      ? `/onboarding/provider?stripe=${encodeURIComponent(stripeId)}`
      : "/onboarding/provider";
    redirect(`/signin?callbackUrl=${encodeURIComponent(next)}`);
  }

  return <ProviderClient stripeSessionId={stripeId} />;
}
