/**
 * Public read-only endpoint that surfaces the Bankr maintenance flag to
 * unauthenticated client components (e.g. the marketing /token page).
 *
 * The dashboard cards (BankrWalletCard, AgentWalletFundingCard) read the
 * same flag via /api/vm/status which already requires auth. This endpoint
 * exists ONLY for surfaces that legitimately render before sign-in.
 *
 * Why a dedicated endpoint instead of NEXT_PUBLIC_BANKR_MAINTENANCE:
 *   - Flipping the env via Vercel doesn't require a redeploy IF the
 *     consumer fetches at request time (this endpoint is force-dynamic)
 *   - Single source of truth (isBankrMaintenance) — env var name lives
 *     in one place, lib/bankr-maintenance.ts
 *   - Keeps the operational env var out of client bundles
 *
 * Returns { maintenance: boolean }. Cache headers prevent CDN caching so
 * the flag flips immediately on next client poll.
 */
import { NextResponse } from "next/server";
import { isBankrMaintenance } from "@/lib/bankr-maintenance";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { maintenance: isBankrMaintenance() },
    {
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
    },
  );
}
