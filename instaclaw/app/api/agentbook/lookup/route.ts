import { NextRequest, NextResponse } from "next/server";
import { lookupHuman } from "@/lib/agentbook";
import { logger } from "@/lib/logger";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

/**
 * GET /api/agentbook/lookup?address=0x...
 *
 * Public endpoint — checks if a wallet is registered in AgentBook on Base.
 * Returns the human nullifier hash if registered, null if not.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");

  if (!address || !address.startsWith("0x")) {
    return NextResponse.json(
      { error: "address query parameter required (0x...)" },
      { status: 400 }
    );
  }

  try {
    const nullifier = await lookupHuman(address as Address);

    return NextResponse.json({
      address,
      registered: nullifier !== null,
      nullifierHash: nullifier?.toString() ?? null,
    });
  } catch (err) {
    logger.error("AgentBook lookup failed", {
      error: String(err),
      address,
      route: "agentbook/lookup",
    });
    return NextResponse.json(
      { error: "Failed to query AgentBook contract" },
      { status: 502 }
    );
  }
}
