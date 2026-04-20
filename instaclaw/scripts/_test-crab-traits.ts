/**
 * Crab traits test — Layers 1 & 2: shell color + body patterns.
 * Generates 24 random crab variations to verify the trait system works.
 *
 * Run: npx tsx scripts/_test-crab-traits.ts
 * Output: /tmp/crab-traits.png
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";

const GRID_SIZE = 24;

// v7 canonical base — locked silhouette
const CRAB_BASE: string[] = [
  "........................",
  "........................",
  "........................",
  "...#######....#######...",
  "..########....########..",
  "..###..............###..",
  "..###..............###..",
  "..###..............###..",
  "..########....########..",
  "..########....########..",
  "..###..............###..",
  "..###..............###..",
  "...##################...",
  "..####################..",
  ".######################.",
  ".######################.",
  ".######################.",
  ".######################.",
  "..####################..",
  "...##################...",
  "##.####.########.####.##",
  "........................",
  "........................",
  "........................",
];

// ── Layer 1: Shell color palette ──
// 20 slots weighted by rarity (position in array = rarity tier)
const SHELL_COLORS = [
  // Common — natural crab (12 slots)
  "#C94A3F", "#8B2E23", "#E67E22", "#DC143C", "#FF6F61",
  "#A0522D", "#B22222", "#CD5C5C", "#F08080", "#FA8072",
  "#D2691E", "#CD853F",
  // Uncommon — fantasy (5 slots)
  "#3B82F6", "#06A77D", "#9D4EDD", "#FF69B4", "#20C997",
  // Rare — metallic (3 slots)
  "#FFD700", "#C0C0C0", "#1A1A1A",
];

// ── Background colors for the glass orb ──
const BG_COLORS = [
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA",
  "#D8E5D5", "#DDDDDD", "#E5D5DE", "#D5E0D5",
  "#D8D5E0", "#D5E0E5", "#E5DFD5", "#DAE0D5",
];

// ── Layer 2: Body patterns ──
type Pattern = "solid" | "stripes" | "spots" | "camo" | "galaxy";

function pickPattern(hash: Buffer): Pattern {
  const byte = hash[4] % 100;
  if (byte < 70) return "solid";
  if (byte < 82) return "stripes";
  if (byte < 90) return "spots";
  if (byte < 95) return "camo";
  return "galaxy";
}

// Body region (where patterns are allowed): rows 12-19
function isBodyPixel(c: number, r: number): boolean {
  if (r < 12 || r > 19) return false;
  return CRAB_BASE[r][c] === "#";
}

function getPatternPixels(pattern: Pattern, hash: Buffer): Set<string> {
  const pixels = new Set<string>();
  if (pattern === "solid") return pixels;

  if (pattern === "stripes") {
    // 3 horizontal bands
    for (const r of [13, 15, 17]) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (isBodyPixel(c, r)) pixels.add(`${c},${r}`);
      }
    }
  }

  if (pattern === "spots") {
    // 6-8 scattered spots
    const numSpots = 6 + (hash[5] % 3);
    for (let i = 0; i < numSpots; i++) {
      const r = 12 + (hash[(10 + i) % 32] % 8);
      const c = 2 + (hash[(18 + i) % 32] % 20);
      if (isBodyPixel(c, r)) pixels.add(`${c},${r}`);
    }
  }

  if (pattern === "camo") {
    // 5 irregular 2x2 patches
    const patches: Array<[number, number]> = [
      [3, 13], [10, 14], [17, 15], [6, 17], [14, 18],
    ];
    for (const [startC, startR] of patches) {
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          const c = startC + dc;
          const r = startR + dr;
          if (isBodyPixel(c, r)) pixels.add(`${c},${r}`);
        }
      }
    }
  }

  if (pattern === "galaxy") {
    // Checkerboard effect across the body
    for (let r = 12; r <= 19; r++) {
      for (let c = 0; c < GRID_SIZE; c++) {
        if (isBodyPixel(c, r) && (r + c) % 2 === 0) {
          pixels.add(`${c},${r}`);
        }
      }
    }
  }

  return pixels;
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

function renderCrabSVG(shellColor: string, bgColor: string, patternPixels: Set<string>): string {
  const SIZE = 512;
  const FACE_PX = 384;
  const PIXEL = FACE_PX / GRID_SIZE;
  const OFFSET = (SIZE - FACE_PX) / 2;

  const patternColor = darkenHex(shellColor, 0.35);
  const bgDark = darkenHex(bgColor, 0.3);

  const pixels: string[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (CRAB_BASE[r][c] !== "#") continue;
      const color = patternPixels.has(`${c},${r}`) ? patternColor : shellColor;
      pixels.push(
        `<rect x="${OFFSET + c * PIXEL}" y="${OFFSET + r * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`,
      );
    }
  }

  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <radialGradient id="orbBg" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${bgColor}" stop-opacity="1"/>
      <stop offset="55%" stop-color="${bgColor}" stop-opacity="0.94"/>
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

async function main() {
  const COUNT = 20;
  const COLS = 5;
  const ROWS = 4;
  const TILE = 300;
  const GAP = 10;

  const crabs: Buffer[] = [];
  for (let i = 0; i < COUNT; i++) {
    const hash = crypto.randomBytes(32);
    const shellColor = SHELL_COLORS[hash[0] % SHELL_COLORS.length];
    const bgColor = BG_COLORS[hash[1] % BG_COLORS.length];
    const pattern = pickPattern(hash);
    const patternPixels = getPatternPixels(pattern, hash);

    const svg = renderCrabSVG(shellColor, bgColor, patternPixels);
    const png = await sharp(Buffer.from(svg)).resize(TILE, TILE).png().toBuffer();
    crabs.push(png);
  }

  const canvasW = COLS * TILE + (COLS + 1) * GAP;
  const canvasH = ROWS * TILE + (ROWS + 1) * GAP;

  const composites = crabs.map((b, i) => ({
    input: b,
    top: GAP + Math.floor(i / COLS) * (TILE + GAP),
    left: GAP + (i % COLS) * (TILE + GAP),
  }));

  const out = await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 18, g: 18, b: 22, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  await fs.writeFile("/tmp/crab-traits.png", out);
  console.log(`Wrote ${COUNT} crab variations → /tmp/crab-traits.png`);
  console.log("Layers active: shell color (20 options) + body pattern (5 types)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
