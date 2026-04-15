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

// ── Pixel Art Motif Library ──
// 8x8 grids matching the landing page testimonial avatar style.
// Each motif uses single-char keys mapped to a color palette.

interface PixelMotif {
  grid: string[];
  colorKeys: Record<string, number>; // char → palette index
}

const MOTIFS: Record<string, PixelMotif> = {
  // Lightning bolt — trading/finance
  trading: {
    grid: [
      "    aa  ",
      "   aa   ",
      "  aa    ",
      " aaaaaa ",
      "    aa  ",
      "   aa   ",
      "  aa    ",
      " a      ",
    ],
    colorKeys: { a: 0 },
  },
  // Paintbrush — creative/art
  creative: {
    grid: [
      "      ab",
      "     ab ",
      "    ab  ",
      "   ab   ",
      "  ab    ",
      " cc     ",
      " cc     ",
      " cc     ",
    ],
    colorKeys: { a: 0, b: 1, c: 2 },
  },
  // Brain/nodes — research/data
  research: {
    grid: [
      "  aaaa  ",
      " a aa a ",
      "a a  a a",
      "a  aa  a",
      "a a  a a",
      " a aa a ",
      "  aaaa  ",
      "   aa   ",
    ],
    colorKeys: { a: 0 },
  },
  // Code brackets — engineering
  code: {
    grid: [
      "  a  b  ",
      " a    b ",
      "a      b",
      "a  cc  b",
      "a  cc  b",
      "a      b",
      " a    b ",
      "  a  b  ",
    ],
    colorKeys: { a: 0, b: 0, c: 1 },
  },
  // Network — social/community
  social: {
    grid: [
      " a    a ",
      "  abba  ",
      "  b  b  ",
      "abba bba",
      "  b  b  ",
      "  abba  ",
      " a    a ",
      "        ",
    ],
    colorKeys: { a: 0, b: 1 },
  },
  // Diamond/gem — gaming
  gaming: {
    grid: [
      "   aa   ",
      "  abba  ",
      " ab  ba ",
      "ab    ba",
      " ab  ba ",
      "  abba  ",
      "   ab   ",
      "    a   ",
    ],
    colorKeys: { a: 0, b: 1 },
  },
  // Smile face — meme/degen
  meme: {
    grid: [
      "  aaaa  ",
      " a    a ",
      "a b  b a",
      "a      a",
      "a c  c a",
      "a cccc a",
      " a    a ",
      "  aaaa  ",
    ],
    colorKeys: { a: 0, b: 1, c: 2 },
  },
  // Star/crystal — default
  default: {
    grid: [
      "   aa   ",
      "  abba  ",
      " ab  ba ",
      "aa    aa",
      "aa    aa",
      " ab  ba ",
      "  abba  ",
      "   aa   ",
    ],
    colorKeys: { a: 0, b: 1 },
  },
};

// Color palettes — each has 3 colors: primary, secondary, accent
interface Palette {
  bg: string;
  colors: string[];
}

const PALETTES: Record<string, Palette[]> = {
  trading: [
    { bg: "#FFF3E0", colors: ["#F5A623", "#D4911D", "#FFD54F"] },
    { bg: "#FFF8E1", colors: ["#FFB300", "#FF8F00", "#FFE082"] },
    { bg: "#F3E5F5", colors: ["#E040FB", "#AA00FF", "#EA80FC"] },
  ],
  creative: [
    { bg: "#F3E5F5", colors: ["#9C27B0", "#E040FB", "#6D4C41"] },
    { bg: "#FCE4EC", colors: ["#EC407A", "#F48FB1", "#5D4037"] },
    { bg: "#E8EAF6", colors: ["#5C6BC0", "#9FA8DA", "#4E342E"] },
  ],
  research: [
    { bg: "#E0F7FA", colors: ["#00ACC1", "#4DD0E1", "#26A69A"] },
    { bg: "#E8F5E9", colors: ["#43A047", "#81C784", "#2E7D32"] },
    { bg: "#E0F2F1", colors: ["#009688", "#80CBC4", "#00695C"] },
  ],
  code: [
    { bg: "#E8F5E9", colors: ["#4CAF50", "#81C784", "#1B5E20"] },
    { bg: "#F1F8E9", colors: ["#7CB342", "#AED581", "#33691E"] },
    { bg: "#E0F7FA", colors: ["#00BCD4", "#80DEEA", "#006064"] },
  ],
  social: [
    { bg: "#FBE9E7", colors: ["#FF5722", "#FF8A65", "#E64A19"] },
    { bg: "#FFF3E0", colors: ["#FF9800", "#FFB74D", "#E65100"] },
    { bg: "#FFEBEE", colors: ["#EF5350", "#EF9A9A", "#C62828"] },
  ],
  gaming: [
    { bg: "#E8EAF6", colors: ["#5C6BC0", "#9FA8DA", "#283593"] },
    { bg: "#EDE7F6", colors: ["#7E57C2", "#B39DDB", "#4527A0"] },
    { bg: "#E1F5FE", colors: ["#039BE5", "#81D4FA", "#01579B"] },
  ],
  meme: [
    { bg: "#FCE4EC", colors: ["#F06292", "#1A1A1A", "#E91E63"] },
    { bg: "#FFF9C4", colors: ["#FDD835", "#1A1A1A", "#F57F17"] },
    { bg: "#DCEDC8", colors: ["#8BC34A", "#1A1A1A", "#558B2F"] },
  ],
  default: [
    { bg: "#ECEFF1", colors: ["#78909C", "#B0BEC5", "#37474F"] },
    { bg: "#F5F5F5", colors: ["#9E9E9E", "#E0E0E0", "#424242"] },
    { bg: "#E8EAF6", colors: ["#7986CB", "#C5CAE9", "#303F9F"] },
  ],
};

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

// ── HSL to Hex conversion ──
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// ── Generate Unique Pixel Art Token PFP ──
// Hash-seeded generative pixel art — like GitHub identicons.
// Same input always produces same output. Different input = visually unique.
// The SOUL.md/MEMORY.md personality text is the seed.
export async function generateTokenImage(
  tokenName: string,
  personalityContext?: string | null
): Promise<Buffer> {
  const crypto = await import("crypto");

  // 1. Create deterministic seed from personality + token name
  const seedInput = `${tokenName}:${personalityContext ?? ""}`;
  const hash = crypto.createHash("sha256").update(seedInput).digest();

  // 2. Derive unique colors from hash (HSL for pastel control)
  const bgHue = ((hash[0] << 8) | hash[1]) % 360;
  const bgLight = hslToHex(bgHue, 28, 92);
  const bgDark = hslToHex(bgHue, 28, 86);

  let fgHue = ((hash[2] << 8) | hash[3]) % 360;
  // Ensure primary color contrasts with background (at least 50° apart)
  if (Math.abs(fgHue - bgHue) < 50) fgHue = (bgHue + 160) % 360;
  const primary = hslToHex(fgHue, 62, 52);
  const secondary = hslToHex((fgHue + 35) % 360, 50, 64);
  const accent = hslToHex((fgHue + 70) % 360, 48, 42);

  // 3. Select base motif from keywords
  const searchText = [tokenName, personalityContext ?? ""].join(" ").toLowerCase();
  let motifKey = "default";
  if (/trad|alpha|bull|bear|chart|profit|fund|capital|hedge|quant|market|stock|forex|whale/.test(searchText)) motifKey = "trading";
  else if (/creat|art|design|paint|draw|music|write|poet|story|muse|canvas/.test(searchText)) motifKey = "creative";
  else if (/research|analys|brain|think|learn|study|data|science|intel|smart|sage|wisdom/.test(searchText)) motifKey = "research";
  else if (/code|dev|hack|build|engineer|tech|cyber|stack|program|bot|auto|machine/.test(searchText)) motifKey = "code";
  else if (/social|community|chat|friend|connect|network|viral|share|media/.test(searchText)) motifKey = "social";
  else if (/game|play|quest|rpg|adventure|level|battle|warrior|knight/.test(searchText)) motifKey = "gaming";
  else if (/meme|degen|moon|ape|pepe|wojak|frog|dog|cat|shib/.test(searchText)) motifKey = "meme";

  const motif = MOTIFS[motifKey] ?? MOTIFS.default;
  const colorMap = [primary, secondary, accent];

  // 4. Build 8x8 grid — motif pixels + hash-derived background pattern
  const PIXEL = 64;
  const SIZE_PX = 8 * PIXEL;
  const svgParts = [
    `<svg width="${SIZE_PX}" height="${SIZE_PX}" viewBox="0 0 ${SIZE_PX} ${SIZE_PX}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">`,
  ];

  for (let y = 0; y < 8; y++) {
    const row = motif.grid[y] ?? "        ";
    for (let x = 0; x < 8; x++) {
      const char = row[x];
      let color: string;

      if (char && char !== " ") {
        // Motif pixel — use hash-derived palette
        const colorIdx = motif.colorKeys[char] ?? 0;
        color = colorMap[colorIdx] ?? primary;
      } else {
        // Background pixel — use hash bit to choose light vs dark shade
        // Creates unique "fingerprint" pattern behind the motif
        const byteIdx = 8 + y; // bytes 8-15 for background pattern
        const bit = (hash[byteIdx] >> x) & 1;
        color = bit ? bgDark : bgLight;
      }

      svgParts.push(
        `<rect x="${x * PIXEL}" y="${y * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`
      );
    }
  }

  svgParts.push("</svg>");
  const svg = svgParts.join("\n");

  // 5. Convert SVG → PNG via sharp
  const sharp = (await import("sharp")).default;
  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(512, 512)
    .png()
    .toBuffer();

  logger.info("Token PFP generated (hash-seeded pixel art)", {
    tokenName,
    motifKey,
    bgHue,
    fgHue,
    hasPersonality: !!personalityContext,
  });

  return pngBuffer;
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
