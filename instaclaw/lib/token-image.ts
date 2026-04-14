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
    return { motif: "ascending candlestick chart lines with a glowing lightning bolt", colorName: "deep navy blue", bgHex: "#0f1729" };

  if (/creat|art|design|paint|draw|music|write|poet|story|muse|canvas/.test(lower))
    return { motif: "flowing luminous paint brush strokes forming an abstract spiral", colorName: "deep royal purple", bgHex: "#1a0d2e" };

  if (/research|analys|brain|think|learn|study|data|science|intel|smart|sage|wisdom/.test(lower))
    return { motif: "glowing neural network nodes connected by soft light paths", colorName: "deep ocean teal", bgHex: "#0a1e2d" };

  if (/code|dev|hack|build|engineer|tech|cyber|stack|program|bot|auto|machine/.test(lower))
    return { motif: "minimal code angle brackets and a blinking cursor with faint circuit traces", colorName: "deep forest green", bgHex: "#0a1a0f" };

  if (/social|community|chat|friend|connect|network|viral|share|media/.test(lower))
    return { motif: "interconnected glowing dots forming a small constellation", colorName: "warm dark amber", bgHex: "#1f150a" };

  if (/game|play|quest|rpg|adventure|level|battle|warrior|knight/.test(lower))
    return { motif: "a geometric crystal gem emitting soft prismatic light rays", colorName: "deep indigo", bgHex: "#120a2e" };

  if (/meme|degen|moon|ape|pepe|wojak|frog|dog|cat|shib/.test(lower))
    return { motif: "a playful abstract face made of simple geometric shapes, smiling", colorName: "deep warm crimson", bgHex: "#1f0a0a" };

  // Default: abstract geometric
  return { motif: "abstract geometric crystal facets with subtle prismatic light reflections", colorName: "dark charcoal", bgHex: "#141118" };
}

// ── DALL-E Prompt Builder ──
export function buildDallePrompt(tokenName: string): string {
  const theme = getThemeFromName(tokenName);
  return `A minimalist ${theme.motif} icon centered on a solid ${theme.colorName} (#${theme.bgHex.slice(1)}) background. Clean, simple design with subtle luminous glow effects. The icon should be centered and occupy about 60% of the frame. No text, no labels, no 3D sphere, no glass effects. Flat iconic style, square format, 1024x1024.`;
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

// ── Generate Token PFP with DALL-E ──
export async function generateTokenImage(tokenName: string): Promise<Buffer> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const prompt = buildDallePrompt(tokenName);

  logger.info("Generating token PFP", { tokenName, prompt: prompt.slice(0, 100) });

  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
  });

  const imageUrl = response.data?.[0]?.url;
  if (!imageUrl) throw new Error("DALL-E returned no image URL");

  // Download the generated image
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Failed to download DALL-E image: ${imageRes.status}`);
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

  // Composite with glass orb overlay
  return compositeGlassOrb(imageBuffer);
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
