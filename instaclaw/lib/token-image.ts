/**
 * Token PFP generation — hand-crafted pixel art faces in glass orbs.
 *
 * Matches the landing page testimonial avatar style exactly:
 *   - 8×8 grid rendered crisp
 *   - Glass orb container: radial gradient bg + highlight reflection + darker rim
 *   - Curated color palettes (hair, skin, eyes, mouth, shirt, bg) from landing page
 *
 * SHA-256 hash of (tokenName + SOUL.md/MEMORY.md + variation) selects:
 *   - 1 of N hand-crafted face templates (guaranteed face-shaped)
 *   - Color combo from curated palettes
 *
 * Same agent = same face. Regenerate increments variation for a new combo.
 * Zero cost, <5ms generation, ~10KB PNG.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// ── Hand-crafted 8×8 face templates ──
// h=hair, s=skin, e=eye, g=glasses, m=mouth, b=shirt, t=hat, space=background (orb bg)

const FACE_TEMPLATES: string[][] = [
  // 0: Male short hair (from landing — James K.)
  ["  hhhh  ", " hhhhhh ", " hssssh ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 1: Female long hair (from landing — Sarah M. / Priya R. / Rachel S.)
  ["  hhhh  ", " hhhhhh ", "hhsssshh", "h sese h", "h ssss h", "h smms h", "   ss   ", "  bbbb  "],
  // 2: Male bearded (from landing — Danny W.)
  ["  hhhh  ", " hhhhhh ", " hssssh ", "  sese  ", "  ssss  ", "  hmmh  ", "   hh   ", "  bbbb  "],
  // 3: Female bangs (from landing — Ava L.)
  ["  hhhh  ", " hhhhhh ", "hhsssshh", "h sese h", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 4: Tall hair (from landing — Marcus T.)
  [" hhhhhh ", " hhhhhh ", " hssssh ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 5: Big curly female
  [" hhhhhh ", "hhhhhhhh", "hhsssshh", "h sese h", "h ssss h", "h smms h", "   ss   ", "  bbbb  "],
  // 6: Side part
  [" hhhhh  ", "hhhhhhh ", " hssssh ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 7: Male with glasses
  ["  hhhh  ", " hhhhhh ", " hssssh ", "  gege  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 8: Female with glasses
  ["  hhhh  ", " hhhhhh ", "hhsssshh", "h gege h", "h ssss h", "h smms h", "   ss   ", "  bbbb  "],
  // 9: Mohawk
  ["   hh   ", "  hhhh  ", "  ssss  ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 10: Beanie (pulled down to ears)
  ["        ", " tttttt ", "tttttttt", " tssss t", "  sese  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 11: Cap (brim over forehead)
  ["  tttt  ", " tttttt ", "ttttttt ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 12: Spiky
  [" h hh h ", " hhhhhh ", " hssssh ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 13: Pigtails
  ["hh hh hh", " hhhhhh ", "hhsssshh", "h sese h", "h ssss h", "h smms h", "   ss   ", "  bbbb  "],
  // 14: Long beard warrior
  ["  hhhh  ", " hhhhhh ", "hhsssshh", "h sese h", "h ssss h", "h hmmh h", "  hhhh  ", "  bbbb  "],
  // 15: Buzz cut
  ["        ", "  hhhh  ", " hssssh ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 16: Bald
  ["        ", "   ss   ", " ssssss ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 17: Undercut
  ["  hhhh  ", "  hhhh  ", " hssssh ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 18: Messy/tousled
  [" h hhh h", "hhhhhhhh", " hssssh ", "  sese  ", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 19: Short bob + bangs
  ["  hhhh  ", " hhhhhh ", "hhhhhhhh", "h sese h", "  ssss  ", "  smms  ", "   ss   ", "  bbbb  "],
  // 20: Female bearded (yes, some people)
  ["  hhhh  ", " hhhhhh ", "hhsssshh", "h sese h", "h ssss h", "h hmmh h", "   hh   ", "  bbbb  "],
];

// ── Curated color palettes (from landing page testimonials) ──

const HAIR_COLORS = [
  "#5C3A1E", "#2C1810", "#1A1A2A", "#D4A017",
  "#6B4226", "#A0522D", "#4A3728", "#C4A45A",
  "#8B6914", "#333333", "#5A5A5A", "#3B2F2F",
  "#7B3F00", "#D4741C", "#E8DDB5", "#1A1A1A",
];

const SKIN_TONES = [
  "#F5D0A9", "#FADDBA", "#FFE0BD", "#EDC9A3",
  "#C68642", "#D4A574", "#8D6E4C", "#6B4C3B",
];

const EYE_COLORS = [
  "#1A1A1A", "#1A1A1A", "#1A1A1A",
  "#4A3728", "#4A3728",
  "#2E4A6B", "#2E6B4F",
];

const MOUTH_COLORS = [
  "#CC6666", "#B85C5C", "#E8888A",
  "#A0522D", "#D4736C", "#997766", "#C85C5C",
];

const SHIRT_COLORS = [
  "#6B8E9B", "#4A6FA5", "#B8860B", "#E8734A",
  "#7CB68E", "#333333", "#9B6B8E", "#5B7553",
  "#4A4A6A", "#5A8FA5", "#8B5A3C", "#4A8F5A",
  "#D4A017", "#5B8DB0",
];

const BG_COLORS = [
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA",
  "#D8E5D5", "#DDDDDD", "#E5D5DE", "#D5E0D5",
  "#D8D5E0", "#D5E0E5", "#E5DFD5", "#DAE0D5",
];

const HAT_COLORS = [
  "#2C3E50", "#E74C3C", "#27AE60", "#2980B9",
  "#8B4513", "#333333", "#E67E22", "#9B59B6",
  "#D4A017", "#B85C5C",
];

interface FaceConfig {
  template: number;
  hairColor: string;
  skinTone: string;
  eyeColor: string;
  mouthColor: string;
  shirtColor: string;
  bgColor: string;
  hatColor: string;
  glassesColor: string;
}

function hashToFaceConfig(hash: Buffer): FaceConfig {
  return {
    template: hash[0] % FACE_TEMPLATES.length,
    hairColor: HAIR_COLORS[hash[1] % HAIR_COLORS.length],
    skinTone: SKIN_TONES[hash[2] % SKIN_TONES.length],
    eyeColor: EYE_COLORS[hash[3] % EYE_COLORS.length],
    mouthColor: MOUTH_COLORS[hash[4] % MOUTH_COLORS.length],
    shirtColor: SHIRT_COLORS[hash[5] % SHIRT_COLORS.length],
    bgColor: BG_COLORS[hash[6] % BG_COLORS.length],
    hatColor: HAT_COLORS[hash[7] % HAT_COLORS.length],
    glassesColor: "#1A1A2A",
  };
}

function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mult = Math.max(0, 1 - factor);
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(v * mult).toString(16).padStart(2, "0"))
      .join("")
  );
}

function renderSVG(config: FaceConfig): string {
  const template = FACE_TEMPLATES[config.template];
  const SIZE = 512;
  const FACE_SIZE = 384;
  const PIXEL = FACE_SIZE / 8;
  const OFFSET = (SIZE - FACE_SIZE) / 2;

  const colorMap: Record<string, string> = {
    h: config.hairColor,
    s: config.skinTone,
    e: config.eyeColor,
    g: config.glassesColor,
    m: config.mouthColor,
    b: config.shirtColor,
    t: config.hatColor,
  };

  const pixels: string[] = [];
  for (let y = 0; y < template.length; y++) {
    const row = template[y];
    for (let x = 0; x < row.length; x++) {
      const char = row[x];
      if (char === " ") continue;
      const color = colorMap[char];
      if (!color) continue;
      pixels.push(
        `<rect x="${OFFSET + x * PIXEL}" y="${OFFSET + y * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`,
      );
    }
  }

  const bgLight = config.bgColor;
  const bgDark = darkenHex(config.bgColor, 0.3);

  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <radialGradient id="orbBg" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${bgLight}" stop-opacity="1"/>
      <stop offset="55%" stop-color="${bgLight}" stop-opacity="0.94"/>
      <stop offset="100%" stop-color="${bgDark}" stop-opacity="1"/>
    </radialGradient>
    <radialGradient id="highlight" cx="28%" cy="22%" r="30%">
      <stop offset="0%" stop-color="white" stop-opacity="0.65"/>
      <stop offset="45%" stop-color="white" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="rim" cx="50%" cy="50%" r="50%">
      <stop offset="88%" stop-color="black" stop-opacity="0"/>
      <stop offset="96%" stop-color="black" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.18"/>
    </radialGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#orbBg)" shape-rendering="auto"/>
  <g>${pixels.join("")}</g>
  <ellipse cx="${SIZE * 0.3}" cy="${SIZE * 0.2}" rx="${SIZE * 0.2}" ry="${SIZE * 0.11}" fill="url(#highlight)" shape-rendering="auto"/>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#rim)" shape-rendering="auto"/>
</svg>`;
}

// ── Read Agent Personality from VM ──
export async function readAgentPersonality(
  vm: { id: string; ip_address: string; ssh_port: number; ssh_user: string },
): Promise<string | null> {
  try {
    const { connectSSH } = await import("@/lib/ssh");
    const ssh = await connectSSH(vm as import("@/lib/ssh").VMRecord, { skipDuplicateIPCheck: true });
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

// ── Generate Unique Face PFP ──
export async function generateTokenImage(
  tokenName: string,
  personalityContext?: string | null,
  variation?: number,
): Promise<Buffer> {
  const crypto = await import("crypto");
  const seedInput = `${tokenName}:${personalityContext ?? ""}:${variation ?? 0}`;
  const hash = crypto.createHash("sha256").update(seedInput).digest();
  const config = hashToFaceConfig(hash);
  const svg = renderSVG(config);

  const sharp = (await import("sharp")).default;
  const pngBuffer = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();

  logger.info("Token face PFP generated", {
    tokenName,
    template: config.template,
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
