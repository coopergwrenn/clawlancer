import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupHuman, isAgentRegistered } from "@/lib/agentbook";
import { logger } from "@/lib/logger";
import type { Address } from "viem";

export const dynamic = "force-dynamic";
export const revalidate = 300; // Cache for 5 minutes

/**
 * GET /.well-known/agent.json?address=0x...
 *
 * Public agent identity manifest per the AgentKit spec.
 * Declares agent capabilities, World ID verification status,
 * and AgentBook registration for any InstaClaw agent by wallet address.
 *
 * Without ?address, returns the platform-level manifest.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");

  // Platform-level manifest (no address specified)
  if (!address) {
    return NextResponse.json({
      schema: "https://agentkit.world/schema/agent.json/v1",
      platform: {
        name: "InstaClaw",
        url: "https://instaclaw.io",
        description: "AI agent marketplace — always-on personal agents with World ID verification",
        agentbook_contract: "0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4",
        agentbook_network: "base",
        world_id_app_id: process.env.NEXT_PUBLIC_WORLD_APP_ID ?? null,
        capabilities: [
          "web-browsing",
          "web-search",
          "prediction-markets",
          "social-media",
          "financial-analysis",
          "code-execution",
          "email-outreach",
          "media-production",
          "computer-use",
        ],
        verification: {
          world_id: true,
          agentbook: true,
          levels: ["orb", "device"],
        },
      },
    }, {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Agent-specific manifest
  if (!address.startsWith("0x")) {
    return NextResponse.json(
      { error: "address must be 0x-prefixed" },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabase();

    // Find VM by wallet address
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select(
        "name, assigned_to, agentbook_registered, agentbook_nullifier_hash, agentbook_wallet_address, telegram_bot_username"
      )
      .eq("agentbook_wallet_address", address)
      .single();

    // Check on-chain registration
    let onChainRegistered = false;
    let onChainNullifier: string | null = null;
    try {
      onChainRegistered = await isAgentRegistered(address as Address);
      if (onChainRegistered) {
        const n = await lookupHuman(address as Address);
        onChainNullifier = n?.toString() ?? null;
      }
    } catch {
      // Contract query failed — use DB data
    }

    // Get user's World ID status if we have a VM match
    let worldIdVerified = false;
    let worldIdLevel: string | null = null;
    let worldIdNullifier: string | null = null;

    if (vm?.assigned_to) {
      const { data: user } = await supabase
        .from("instaclaw_users")
        .select("world_id_verified, world_id_verification_level, world_id_nullifier_hash")
        .eq("id", vm.assigned_to)
        .single();

      if (user?.world_id_verified) {
        worldIdVerified = true;
        worldIdLevel = user.world_id_verification_level;
        worldIdNullifier = user.world_id_nullifier_hash;
      }
    }

    return NextResponse.json({
      schema: "https://agentkit.world/schema/agent.json/v1",
      agent: {
        address,
        platform: "instaclaw",
        platform_url: "https://instaclaw.io",
        name: vm?.name ?? null,
        telegram: vm?.telegram_bot_username ? `@${vm.telegram_bot_username}` : null,
        verification: {
          world_id: {
            verified: worldIdVerified,
            level: worldIdLevel,
            nullifier_hash: worldIdNullifier,
          },
          agentbook: {
            registered: onChainRegistered || vm?.agentbook_registered || false,
            nullifier_hash: onChainNullifier ?? vm?.agentbook_nullifier_hash ?? null,
            contract: "0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4",
            network: "base",
          },
        },
        capabilities: [
          "web-browsing",
          "web-search",
          "prediction-markets",
          "social-media",
          "financial-analysis",
          "code-execution",
          "email-outreach",
          "media-production",
          "computer-use",
        ],
      },
    }, {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    logger.error("agent.json lookup failed", {
      error: String(err),
      address,
      route: ".well-known/agent.json",
    });
    return NextResponse.json(
      { error: "Failed to fetch agent data" },
      { status: 502 }
    );
  }
}
