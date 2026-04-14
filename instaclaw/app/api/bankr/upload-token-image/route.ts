import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { compositeGlassOrb, uploadTokenImage } from "@/lib/token-image";
import { logger } from "@/lib/logger";

// Upload + compositing + re-upload
export const maxDuration = 15;

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

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

  try {
    const formData = await req.formData();
    const file = formData.get("image") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image file provided" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Image must be JPG, PNG, or WebP" },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "Image must be under 5MB" },
        { status: 400 }
      );
    }

    // Read file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuffer);

    // Apply glass orb compositing (circle mask + glass overlay)
    // so ALL token PFPs have consistent glass style
    const composited = await compositeGlassOrb(rawBuffer);

    // Upload to Supabase Storage
    const imageUrl = await uploadTokenImage(composited, userId);

    logger.info("Token PFP uploaded", { userId, imageUrl, originalSize: file.size });

    return NextResponse.json({ imageUrl });
  } catch (err) {
    logger.error("Token PFP upload failed", {
      error: String(err),
      userId,
    });
    return NextResponse.json(
      { error: "Image upload failed — you can skip and add one later on Bankr" },
      { status: 500 }
    );
  }
}
