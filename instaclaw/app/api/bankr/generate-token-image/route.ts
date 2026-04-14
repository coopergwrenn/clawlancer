import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { generateTokenImage, uploadTokenImage } from "@/lib/token-image";
import { logger } from "@/lib/logger";

// DALL-E generation + compositing + upload can take 10-20s
export const maxDuration = 30;

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

  const body = await req.json().catch(() => ({}));
  const tokenName = typeof body.token_name === "string" ? body.token_name.trim() : "";

  if (!tokenName) {
    return NextResponse.json({ error: "token_name is required" }, { status: 400 });
  }

  try {
    // Generate glass orb PFP via DALL-E + compositing
    const imageBuffer = await generateTokenImage(tokenName);

    // Upload to Supabase Storage for a permanent public URL
    const imageUrl = await uploadTokenImage(imageBuffer, userId);

    logger.info("Token PFP generated", { userId, tokenName, imageUrl });

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
