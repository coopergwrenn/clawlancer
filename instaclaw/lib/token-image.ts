/**
 * Token PFP generation — glass orb style with personality-driven variation.
 *
 * Architecture:
 * 1. DALL-E generates a flat icon on a solid color background (motif + color from token name)
 * 2. We mask the image to a circle
 * 3. We composite a pre-made glass orb overlay on top
 * 4. Upload the result to Supabase Storage
 *
 * Result: every token PFP has the IDENTICAL glass orb shell (consistent brand),
 * with varied inner content (personality-driven). Matches the 3D glass orbs on
 * the InstaClaw landing page.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// ── Glass Orb SVG Overlay ──
// Transparent PNG with glass effects only: specular highlight, rim light,
// bottom shadow, caustic refraction. Composited ON TOP of the inner content.
const GLASS_ORB_SVG = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="mainHighlight" cx="0.35" cy="0.3" r="0.35">
      <stop offset="0%" stop-color="white" stop-opacity="0.45"/>
      <stop offset="50%" stop-color="white" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="specDot" cx="0.32" cy="0.27" r="0.06">
      <stop offset="0%" stop-color="white" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="rimLight" cx="0.5" cy="0.5" r="0.5">
      <stop offset="88%" stop-color="white" stop-opacity="0"/>
      <stop offset="94%" stop-color="white" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="white" stop-opacity="0.02"/>
    </radialGradient>
    <radialGradient id="bottomShadow" cx="0.5" cy="0.72" r="0.35">
      <stop offset="0%" stop-color="black" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="black" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="caustic" cx="0.55" cy="0.78" r="0.15">
      <stop offset="0%" stop-color="white" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="512" cy="512" r="490" fill="url(#rimLight)"/>
  <circle cx="512" cy="512" r="490" fill="url(#bottomShadow)"/>
  <circle cx="512" cy="512" r="490" fill="url(#mainHighlight)"/>
  <circle cx="512" cy="512" r="490" fill="url(#specDot)"/>
  <circle cx="512" cy="512" r="490" fill="url(#caustic)"/>
</svg>`;

const SIZE = 1024;
const ORB_RADIUS = 490;

// ── Theme Classifier ──
// Maps token name keywords to a DALL-E motif + background color.
// The motif determines WHAT's inside the glass orb.
// The color determines the background fill of the orb.

interface Theme {
  motif: string;
  colorName: string;
  bgHex: string;
}

export function getThemeFromName(tokenName: string): Theme {
  const lower = tokenName.toLowerCase();

  if (/trad|alpha|bull|bear|chart|profit|fund|capital|hedge|quant|market|stock|forex|whale/.test(lower))
    return { motif: "rising chart line with a small lightning bolt", colorName: "golden amber", bgHex: "#f5a623" };

  if (/creat|art|design|paint|draw|music|write|poet|story|muse|canvas/.test(lower))
    return { motif: "flowing brush stroke spiral", colorName: "soft lavender purple", bgHex: "#b794f6" };

  if (/research|analys|brain|think|learn|study|data|science|intel|smart|sage|wisdom/.test(lower))
    return { motif: "connected neural nodes", colorName: "soft teal", bgHex: "#81e6d9" };

  if (/code|dev|hack|build|engineer|tech|cyber|stack|program|bot|auto|machine/.test(lower))
    return { motif: "code angle brackets and cursor", colorName: "soft mint green", bgHex: "#9ae6b4" };

  if (/social|community|chat|friend|connect|network|viral|share|media/.test(lower))
    return { motif: "interconnected dots constellation", colorName: "warm coral", bgHex: "#fc8181" };

  if (/game|play|quest|rpg|adventure|level|battle|warrior|knight/.test(lower))
    return { motif: "a geometric crystal gem", colorName: "soft indigo", bgHex: "#a3bffa" };

  if (/meme|degen|moon|ape|pepe|wojak|frog|dog|cat|shib/.test(lower))
    return { motif: "a playful smiling face", colorName: "warm peach", bgHex: "#fbb6ce" };

  // Default: abstract geometric
  return { motif: "abstract geometric crystal facets", colorName: "warm silver", bgHex: "#cbd5e0" };
}

// ── DALL-E Prompt Builder ──
export function buildDallePrompt(tokenName: string, personalityContext?: string): string {
  const theme = getThemeFromName(tokenName);

  // If we have personality context from SOUL.md/MEMORY.md, use it to enrich the motif
  let motifDescription = theme.motif;
  if (personalityContext) {
    motifDescription = `${theme.motif}, with subtle visual hints reflecting this agent's personality: ${personalityContext}`;
  }

  return `A 3D glass orb avatar, like a polished crystal marble. Inside the translucent glass sphere is a cute, minimalist ${motifDescription} symbol in soft ${theme.colorName} tones. The sphere has a prominent bright white specular highlight dot on the upper left, a soft gradient from light (top-left) to shadow (bottom-right) across the surface, and visible glass depth and refraction. Warm, soft lighting. Light neutral gray (#f0f0f0) background. The orb should look like a physical glass marble. Photorealistic 3D render, perfectly centered, square format, 1024x1024. No text, no labels.`;
}

// ── Glass Orb Compositing ──
// Takes a raw image buffer (from DALL-E or user upload), masks to circle,
// applies the glass overlay, returns the final PNG buffer.
export async function compositeGlassOrb(innerImageBuffer: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  // 1. Resize inner image to fill the orb area
  const inner = await sharp(innerImageBuffer)
    .resize(SIZE, SIZE, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();

  // 2. Create circular mask
  const circleMask = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}">
      <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${ORB_RADIUS}" fill="white"/>
    </svg>`
  );

  // 3. Apply circular mask to inner image
  const maskedInner = await sharp(inner)
    .composite([{
      input: await sharp(circleMask).png().toBuffer(),
      blend: "dest-in",
    }])
    .png()
    .toBuffer();

  // 4. Convert glass overlay SVG to PNG
  const glassOverlayPng = await sharp(Buffer.from(GLASS_ORB_SVG))
    .png()
    .toBuffer();

  // 5. Composite: transparent bg + masked inner + glass overlay
  const result = await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .composite([
      { input: maskedInner, top: 0, left: 0 },
      { input: glassOverlayPng, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();

  return result;
}

// ── Read Agent Personality from VM ──
// SSHes into the VM and reads the first ~500 chars of SOUL.md + MEMORY.md.
// Returns a short personality summary for the DALL-E prompt, or null if SSH fails.
export async function readAgentPersonality(
  vm: { id: string; ip_address: string; ssh_port: number; ssh_user: string }
): Promise<string | null> {
  try {
    const { connectSSH } = await import("@/lib/ssh");
    const ssh = await connectSSH(vm as import("@/lib/ssh").VMRecord, { skipDuplicateIPCheck: true });
    try {
      const result = await ssh.execCommand([
        'SOUL=$(head -c 500 "$HOME/.openclaw/workspace/SOUL.md" 2>/dev/null || echo "")',
        'MEM=$(head -c 500 "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null || echo "")',
        'echo "SOUL:$SOUL"',
        'echo "---SPLIT---"',
        'echo "MEM:$MEM"',
      ].join("\n"));

      const output = result.stdout ?? "";
      const parts = output.split("---SPLIT---");
      const soul = (parts[0] ?? "").replace("SOUL:", "").trim();
      const mem = (parts[1] ?? "").replace("MEM:", "").trim();

      if (!soul && !mem) return null;

      // Extract key phrases — strip markdown formatting, keep substance
      const combined = [soul, mem].join(" ")
        .replace(/[#*`\-\[\]()>]/g, " ")  // strip markdown
        .replace(/\s+/g, " ")              // collapse whitespace
        .trim()
        .slice(0, 400);                    // keep it concise for the prompt

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

// ── Generate Token PFP with DALL-E ──
// DALL-E generates the FULL 3D glass orb (no compositing needed).
// The prompt asks for a photorealistic glass marble with the motif inside.
// If personalityContext is provided (from SOUL.md/MEMORY.md), it enriches the motif.
export async function generateTokenImage(
  tokenName: string,
  personalityContext?: string | null
): Promise<Buffer> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = buildDallePrompt(tokenName, personalityContext ?? undefined);

  logger.info("Generating token PFP", { tokenName, hasPersonality: !!personalityContext, prompt: prompt.slice(0, 150) });

  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
  });

  const imageUrl = response.data?.[0]?.url;
  if (!imageUrl) throw new Error("DALL-E returned no image URL");

  // Download the generated image — DALL-E renders the full 3D glass orb
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Failed to download DALL-E image: ${imageRes.status}`);
  return Buffer.from(await imageRes.arrayBuffer());
}

// ── Upload to Supabase Storage ──
export async function uploadTokenImage(
  imageBuffer: Buffer,
  userId: string
): Promise<string> {
  const supabase = getSupabase();
  const fileName = `${userId}_${Date.now()}.png`;

  const { error } = await supabase.storage
    .from("token-images")
    .upload(fileName, imageBuffer, {
      contentType: "image/png",
      upsert: false,
    });

  if (error) {
    logger.error("Supabase Storage upload failed", { error: error.message, fileName });
    throw new Error(`Image upload failed: ${error.message}`);
  }

  const { data: urlData } = supabase.storage
    .from("token-images")
    .getPublicUrl(fileName);

  return urlData.publicUrl;
}
