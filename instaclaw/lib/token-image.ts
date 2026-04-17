/**
 * Token PFP generation — procedural pixel art faces.
 *
 * Architecture:
 * 1. SHA-256 hash of personality text (SOUL.md + MEMORY.md) + token name → deterministic seed
 * 2. Hash bytes determine: hair style, hair color, skin tone, expression, shirt, accessories
 * 3. 8x8 pixel art face rendered as SVG → converted to PNG via sharp
 * 4. Uploaded to Supabase Storage
 *
 * Same agent = same face (deterministic). Different agent = different face (unique hash).
 * Matches the landing page testimonial avatar style exactly.
 *
 * Zero cost, <5ms generation, ~10KB output.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// ── Color Palettes ──

const HAIR_COLORS = [
  "#1A1A2A", // black
  "#2C1810", // dark brown
  "#5C3A1E", // brown
  "#6B4226", // auburn
  "#8B6914", // dark blonde
  "#C4A45A", // light blonde
  "#D4A017", // golden
  "#A0522D", // copper
  "#4A3728", // espresso
  "#808080", // silver
  "#CC3333", // red
  "#3366CC", // blue
  "#339966", // green
  "#CC66CC", // purple
  "#FF6B35", // orange
  "#1E90FF", // bright blue
];

const SKIN_TONES = [
  "#FFE0BD", // very light
  "#FADDBA", // light
  "#F5D0A9", // light-medium
  "#D4A574", // medium
  "#C68642", // medium-dark
  "#8D6E4C", // dark
  "#6B4C3B", // very dark
];

const EYE_COLORS = [
  "#1A1A1A", // black
  "#4A3728", // brown
  "#2E6B4F", // green
  "#2E4A6B", // blue
  "#1A1A1A", // black (weighted)
  "#4A3728", // brown (weighted)
];

const MOUTH_COLORS: Record<string, string[]> = {
  happy: ["#CC6666", "#E8888A", "#D4736C"],
  neutral: ["#B85C5C", "#A0522D", "#997766"],
  surprised: ["#444444", "#333333", "#555555"],
};

// ── Face Templates (8x8 grids) ──
// h=hair, s=skin, e=eye, m=mouth, b=shirt, t=hat, space=background

const HAIR_TEMPLATES: string[][] = [
  // 0: Short male
  ["  hhhh  ", " hhhhhh ", " hssssh ", "  sese  "],
  // 1: Long female
  ["  hhhh  ", " hhhhhh ", "hhsssshh", "h sese h"],
  // 2: Mohawk
  ["   hh   ", "  hhhh  ", " hssssh ", "  sese  "],
  // 3: Big/curly
  [" hhhhhh ", "hhhhhhhh", "hhsssshh", "h sese h"],
  // 4: Bald
  ["        ", "  ssss  ", " ssssss ", "  sese  "],
  // 5: Side part
  [" hhhhh  ", "hhhhhhh ", " hssssh ", "  sese  "],
  // 6: Bob
  ["  hhhh  ", " hhhhhh ", "hhsssshh", "  sese  "],
  // 7: Spiky
  [" h hh h ", " hhhhhh ", " hssssh ", "  sese  "],
  // 8: Swept
  ["   hhhh ", "  hhhhhh", " hssssh ", "  sese  "],
  // 9: Pigtails
  ["hh hh hh", " hhhhhh ", "hhsssshh", "h sese h"],
];

// Lower face templates based on hair type
// "short" = no side hair on cheeks, "long" = side hair on cheeks
function getLowerFace(isLongHair: boolean, expression: string, hasBeard: boolean): string[] {
  const side = isLongHair ? "h" : " ";
  const cheekRow = `${side} ssss ${side}`;

  let mouthRow: string;
  switch (expression) {
    case "happy":
      mouthRow = `${side} smms ${side}`;
      break;
    case "neutral":
      mouthRow = `${side} snns ${side}`;
      break;
    case "surprised":
      mouthRow = `${side} soos ${side}`;
      break;
    case "smirk":
      mouthRow = `${side} ssms ${side}`;
      break;
    default:
      mouthRow = `${side} smms ${side}`;
  }

  let neckRow = "   ss   ";
  if (hasBeard) {
    mouthRow = `${side} hmmh ${side}`;
    neckRow = "   hh   ";
  }

  return [cheekRow, mouthRow, neckRow, "  bbbb  "];
}

// ── HSL to Hex ──
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

// ── Face Config from Hash ──

interface FaceConfig {
  hairStyle: number;
  hairColor: string;
  skinTone: string;
  eyeColor: string;
  mouthColor: string;
  expression: string;
  shirtColor: string;
  bgColor: string;
  hasBeard: boolean;
  hasHat: boolean;
  hatColor: string;
}

function hashToFaceConfig(hash: Buffer): FaceConfig {
  const expressions = ["happy", "neutral", "surprised", "smirk"];
  const expression = expressions[hash[4] % expressions.length];

  const mouthPalette = MOUTH_COLORS[expression === "smirk" ? "happy" : expression] ?? MOUTH_COLORS.happy;

  return {
    hairStyle: hash[0] % HAIR_TEMPLATES.length,
    hairColor: HAIR_COLORS[hash[1] % HAIR_COLORS.length],
    skinTone: SKIN_TONES[hash[2] % SKIN_TONES.length],
    eyeColor: EYE_COLORS[hash[3] % EYE_COLORS.length],
    expression,
    mouthColor: mouthPalette[hash[5] % mouthPalette.length],
    shirtColor: hslToHex(((hash[6] << 8) | hash[7]) % 360, 55, 52),
    bgColor: hslToHex(((hash[8] << 8) | hash[9]) % 360, 28, 91),
    hasBeard: hash[10] % 5 === 0,
    hasHat: hash[11] % 5 === 0,
    hatColor: hslToHex(((hash[12] << 8) | hash[13]) % 360, 50, 45),
  };
}

// ── Build the 8x8 Grid ──

function buildFaceGrid(config: FaceConfig): { grid: string[]; colors: Record<string, string> } {
  const hairTop = HAIR_TEMPLATES[config.hairStyle];
  const isLongHair = [1, 3, 6, 9].includes(config.hairStyle);
  const lowerFace = getLowerFace(isLongHair, config.expression, config.hasBeard);

  let grid = [...hairTop, ...lowerFace];

  // Apply hat: replace row 0 with hat, and make row 1 partially hat
  if (config.hasHat && config.hairStyle !== 4) {
    // Hat brim spans the full width of the hair
    const originalRow0 = grid[0];
    grid[0] = originalRow0.replace(/h/g, "t");
    // Top of row 1 also becomes hat
    const row1 = grid[1];
    grid[1] = row1.replace(/h/g, (_, idx) => idx < 2 || idx > 5 ? "h" : "t");
  }

  const colors: Record<string, string> = {
    h: config.hairColor,
    s: config.skinTone,
    e: config.eyeColor,
    m: config.mouthColor,
    n: config.mouthColor, // neutral mouth uses same key
    o: config.mouthColor, // surprised mouth
    b: config.shirtColor,
    t: config.hatColor,
  };

  return { grid, colors };
}

// ── Read Agent Personality from VM ──
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

      const combined = [soul, mem].join(" ")
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

// ── Generate Unique Face PFP ──
export async function generateTokenImage(
  tokenName: string,
  personalityContext?: string | null,
  variation?: number
): Promise<Buffer> {
  const crypto = await import("crypto");

  // Deterministic seed from personality + token name + variation
  const seedInput = `${tokenName}:${personalityContext ?? ""}:${variation ?? 0}`;
  const hash = crypto.createHash("sha256").update(seedInput).digest();

  // Build face from hash
  const config = hashToFaceConfig(hash);
  const { grid, colors } = buildFaceGrid(config);

  // Render SVG
  const PIXEL = 64;
  const SIZE_PX = 8 * PIXEL;
  const svgParts = [
    `<svg width="${SIZE_PX}" height="${SIZE_PX}" viewBox="0 0 ${SIZE_PX} ${SIZE_PX}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">`,
    `<rect width="${SIZE_PX}" height="${SIZE_PX}" fill="${config.bgColor}"/>`,
  ];

  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    for (let x = 0; x < row.length; x++) {
      const char = row[x];
      if (char === " ") continue;
      const color = colors[char];
      if (!color) continue;
      svgParts.push(
        `<rect x="${x * PIXEL}" y="${y * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`
      );
    }
  }

  svgParts.push("</svg>");
  const svg = svgParts.join("\n");

  // Convert SVG → PNG via sharp
  const sharp = (await import("sharp")).default;
  const pngBuffer = await sharp(Buffer.from(svg))
    .resize(512, 512)
    .png()
    .toBuffer();

  logger.info("Token face PFP generated", {
    tokenName,
    hairStyle: config.hairStyle,
    expression: config.expression,
    hasBeard: config.hasBeard,
    hasHat: config.hasHat,
    variation: variation ?? 0,
    hasPersonality: !!personalityContext,
  });

  return pngBuffer;
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
    `<svg width="${SIZE}" height="${SIZE}"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${ORB_RADIUS}" fill="white"/></svg>`
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
