import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { generateTokenImage, uploadTokenImage, readAgentPersonality } from "@/lib/token-image";
import { logger } from "@/lib/logger";

// SSH (~5s) + DALL-E (~20s) + upload (~2s) = ~27s. 45s gives headroom.
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  // Accept NextAuth session (web app) OR X-Mini-App-Token (World mini app)
  let userId: string | undefined;
  const session = await auth();
  if (session?.user?.id) {
    userId = session.user.id;
  } else {
    const { validateMiniAppToken } = await import("@/lib/security");
    const miniAppUserId = await validateMiniAppToken(req);
    if (miniAppUserId) userId = miniAppUserId;
  }
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.BANKR_TOKENIZE_ENABLED !== "true") {
    return NextResponse.json({ error: "Token launching is coming soon!" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const tokenName = typeof body.token_name === "string" ? body.token_name.trim() : "";

  if (!tokenName) {
    return NextResponse.json({ error: "token_name is required" }, { status: 400 });
  }

  try {
    // Step 1: Read agent personality from VM (SOUL.md + MEMORY.md)
    // Non-fatal — if SSH fails, we generate without personality context
    let personalityContext: string | null = null;
    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", userId)
      .single();

    if (vm?.ip_address) {
      personalityContext = await readAgentPersonality(vm);
    }

    // Step 2: Generate glass orb PFP via DALL-E (with personality-enriched prompt)
    const imageBuffer = await generateTokenImage(tokenName, personalityContext);

    // Step 3: Upload to Supabase Storage for a permanent public URL
    const imageUrl = await uploadTokenImage(imageBuffer, userId);

    logger.info("Token PFP generated", {
      userId,
      tokenName,
      hasPersonality: !!personalityContext,
      imageUrl,
    });

    return NextResponse.json({ imageUrl });
  } catch (err) {
    logger.error("Token PFP generation failed", {
      error: String(err),
      userId,
      tokenName,
    });
    return NextResponse.json(
      { error: "Image generation failed — you can skip and add one later on Bankr" },
      { status: 500 }
    );
  }
}
