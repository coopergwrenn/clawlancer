import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { findPotentialExistingAgent, supabase } from "@/lib/supabase";

/**
 * POST /api/link/check-duplicate — Check if this user might already have an agent
 * under a different account (e.g., they signed up on instaclaw.io with Google).
 * Called before provisioning to prevent duplicate VMs.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const { nullifierHash, email } = await req.json();

    const match = await findPotentialExistingAgent(
      session.userId,
      nullifierHash,
      email
    );

    if (match) {
      return NextResponse.json({
        hasPotentialDuplicate: true,
        matchedBy: match.matchedBy,
        // Don't expose the other userId — just flag the match
      });
    }

    return NextResponse.json({ hasPotentialDuplicate: false });
  } catch (err) {
    console.error("Check duplicate error:", err);
    return NextResponse.json(
      { error: "Check failed" },
      { status: 500 }
    );
  }
}
