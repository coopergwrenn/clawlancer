/**
 * Token PFP generation — layered procedural pixel art faces in glass orbs.
 *
 * Pure generation lives in `token-image-generator.ts` (no env deps).
 * This file wires it up to crypto, sharp, Supabase, and SSH.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  buildFaceGrid,
  hashToPalette,
  renderFaceSVG,
  computePersonalityHashHex,
  personalityHashBuffer,
  variationHashBuffer,
} from "@/lib/token-image-generator";

// ── Read Agent Personality from VM ──
export async function readAgentPersonality(vm: {
  id: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
}): Promise<string | null> {
  try {
    const { connectSSH } = await import("@/lib/ssh");
    const ssh = await connectSSH(vm as import("@/lib/ssh").VMRecord, {
      skipDuplicateIPCheck: true,
    });
    try {
      const result = await ssh.execCommand(
        [
          'SOUL=$(head -c 500 "$HOME/.openclaw/workspace/SOUL.md" 2>/dev/null || echo "")',
          'MEM=$(head -c 500 "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null || echo "")',
          'echo "SOUL:$SOUL"',
          'echo "---SPLIT---"',
          'echo "MEM:$MEM"',
        ].join("\n"),
      );

      const output = result.stdout ?? "";
      const parts = output.split("---SPLIT---");
      const soul = (parts[0] ?? "").replace("SOUL:", "").trim();
      const mem = (parts[1] ?? "").replace("MEM:", "").trim();

      if (!soul && !mem) return null;

      const combined = [soul, mem]
        .join(" ")
        .replace(/[#*`\-\[\]()>]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400);

      if (combined.length < 20) return null;

      logger.info("Agent personality read", { vmId: vm.id, length: combined.length });
      return combined;
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.warn("Could not read agent personality (non-fatal)", {
      error: String(err),
      vmId: vm.id,
    });
    return null;
  }
}

// ── Generate Token Image ──
// Two code paths:
//   (A) First call — pass personalityContext text; we hash it, use it, return the hex hash.
//   (B) Regenerate — pass personalityHashHex (cached client-side); we skip re-hashing the text.
export async function generateTokenImage(
  tokenName: string,
  opts: {
    personalityContext?: string | null;
    personalityHashHex?: string | null;
    variation?: number;
  } = {},
): Promise<{ buffer: Buffer; personalityHashHex: string }> {
  const variation = opts.variation ?? 0;

  // Derive personality hash hex — from cache if provided, from text if not, from token name as fallback
  let pHashHex: string;
  if (opts.personalityHashHex) {
    pHashHex = opts.personalityHashHex;
  } else if (opts.personalityContext && opts.personalityContext.length >= 20) {
    pHashHex = computePersonalityHashHex(opts.personalityContext);
  } else {
    pHashHex = computePersonalityHashHex(`fallback:${tokenName}`);
  }

  const pHash = personalityHashBuffer(pHashHex);
  const vHash = variationHashBuffer(pHashHex, variation);

  const grid = buildFaceGrid(pHash, vHash);
  const palette = hashToPalette(pHash, vHash);
  const svg = renderFaceSVG(grid, palette);

  const sharp = (await import("sharp")).default;
  const pngBuffer = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();

  logger.info("Token face PFP generated", {
    tokenName,
    variation,
    fromCache: !!opts.personalityHashHex,
    hasPersonalityText: !!opts.personalityContext,
  });

  return { buffer: pngBuffer, personalityHashHex: pHashHex };
}

// ── Glass Orb Compositing (for user uploads only) ──
const GLASS_ORB_SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="mainHighlight" cx="0.35" cy="0.3" r="0.35">
      <stop offset="0%" stop-color="white" stop-opacity="0.45"/>
      <stop offset="50%" stop-color="white" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="rimLight" cx="0.5" cy="0.5" r="0.5">
      <stop offset="88%" stop-color="white" stop-opacity="0"/>
      <stop offset="94%" stop-color="white" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="white" stop-opacity="0.02"/>
    </radialGradient>
  </defs>
  <circle cx="512" cy="512" r="490" fill="url(#rimLight)"/>
  <circle cx="512" cy="512" r="490" fill="url(#mainHighlight)"/>
</svg>`;

const SIZE = 1024;
const ORB_RADIUS = 490;

export async function compositeGlassOrb(innerImageBuffer: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const inner = await sharp(innerImageBuffer)
    .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  const circleMask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${ORB_RADIUS}" fill="white"/></svg>`,
  );
  const maskedInner = await sharp(inner)
    .composite([{ input: await sharp(circleMask).png().toBuffer(), blend: "dest-in" }])
    .png()
    .toBuffer();
  const glassOverlayPng = await sharp(Buffer.from(GLASS_ORB_SVG)).png().toBuffer();
  return sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .composite([
      { input: maskedInner, top: 0, left: 0 },
      { input: glassOverlayPng, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

// ── Upload to Supabase Storage ──
export async function uploadTokenImage(imageBuffer: Buffer, userId: string): Promise<string> {
  const supabase = getSupabase();
  const fileName = `${userId}_${Date.now()}.png`;

  const { error } = await supabase.storage.from("token-images").upload(fileName, imageBuffer, {
    contentType: "image/png",
    upsert: false,
  });

  if (error) {
    logger.error("Supabase Storage upload failed", { error: error.message, fileName });
    throw new Error(`Image upload failed: ${error.message}`);
  }

  const { data: urlData } = supabase.storage.from("token-images").getPublicUrl(fileName);

  return urlData.publicUrl;
}
