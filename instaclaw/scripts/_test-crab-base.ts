/**
 * Base crab silhouette test — 24×24 matching CryptoPunks resolution.
 * Renders JUST the base crab in two styles so we can verify against the logo.
 *
 * Left tile: white-on-black (direct logo comparison)
 * Right tile: crab-red on glass orb (production aesthetic)
 *
 * Run: npx tsx scripts/_test-crab-base.ts
 * Output: /tmp/crab-base.png
 */

import fs from "node:fs/promises";
import sharp from "sharp";

const GRID_SIZE = 24;

// InstaClaw crab — 24×24 base silhouette matching the logo.
// '#' = crab body pixel, '.' = background (transparent / orb bg)
//
// Features (top to bottom):
//   Rows 3-4:   Upper pincer jaw (8-wide horizontal)
//   Rows 5-7:   Pincer mouth (3-row hollow, outer stem only — "grabbing" opening)
//   Rows 8-9:   Lower pincer jaw (8-wide horizontal)
//   Rows 10-11: Arm descending to body (narrow, 3 wide)
//   Rows 12-19: Body (solid, 20-22 wide)
//   Row 20:     Legs (6 distinct leg pairs visible)
//   Row 21:     Outer feet extending down
//
const CRAB_BASE: string[] = [
  "........................", // 0
  "........................", // 1
  "........................", // 2
  "...#######....#######...", // 3 — upper jaw TOP — softened outer corners (7w instead of 8w)
  "..########....########..", // 4 — upper jaw bottom (full 8w)
  "..###..............###..", // 5 — pincer mouth row 1 (stem only)
  "..###..............###..", // 6 — pincer mouth row 2
  "..###..............###..", // 7 — pincer mouth row 3
  "..########....########..", // 8 — lower jaw row 1 (full 8w)
  "..########....########..", // 9 — lower jaw row 2 (full 8w)
  "..###..............###..", // 10 — arm row 1
  "..###..............###..", // 11 — arm row 2
  "...##################...", // 12 — body top — softened corners (18w)
  "..####################..", // 13 — body widening (20w)
  ".######################.", // 14 — body widest (22w)
  ".######################.", // 15 — body
  ".######################.", // 16 — body
  ".######################.", // 17 — body
  "..####################..", // 18 — body narrowing (20w)
  "...##################...", // 19 — body bottom — softened corners (18w)
  "##.####.########.####.##", // 20 — legs (6 visible leg groups)
  "........................", // 21 — (outer feet row REMOVED)
  "........................", // 22
  "........................", // 23
];

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

// Render white-on-black (matches the logo reference style exactly)
function renderLogoStyle(grid: string[]): string {
  const SIZE = 512;
  const FACE_PX = 384; // 384 / 24 = 16px per grid cell (clean arithmetic)
  const PIXEL = FACE_PX / GRID_SIZE;
  const OFFSET = (SIZE - FACE_PX) / 2;

  const pixels: string[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (grid[r][c] === "#") {
        pixels.push(
          `<rect x="${OFFSET + c * PIXEL}" y="${OFFSET + r * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="white"/>`,
        );
      }
    }
  }

  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <rect width="${SIZE}" height="${SIZE}" fill="black"/>
  ${pixels.join("")}
</svg>`;
}

// Render crab-red on glass orb (production aesthetic)
function renderOrbStyle(grid: string[], crabColor: string, bgColor: string): string {
  const SIZE = 512;
  const FACE_PX = 384;
  const PIXEL = FACE_PX / GRID_SIZE;
  const OFFSET = (SIZE - FACE_PX) / 2;

  const pixels: string[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (grid[r][c] === "#") {
        pixels.push(
          `<rect x="${OFFSET + c * PIXEL}" y="${OFFSET + r * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${crabColor}"/>`,
        );
      }
    }
  }

  const bgDark = darkenHex(bgColor, 0.3);

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
  // Assert all rows are the right width
  for (let i = 0; i < CRAB_BASE.length; i++) {
    if (CRAB_BASE[i].length !== GRID_SIZE) {
      throw new Error(`Row ${i} is ${CRAB_BASE[i].length} chars, expected ${GRID_SIZE}: "${CRAB_BASE[i]}"`);
    }
  }
  if (CRAB_BASE.length !== GRID_SIZE) {
    throw new Error(`CRAB_BASE has ${CRAB_BASE.length} rows, expected ${GRID_SIZE}`);
  }

  const logoSvg = renderLogoStyle(CRAB_BASE);
  const orbSvg = renderOrbStyle(CRAB_BASE, "#C94A3F", "#E8DDD3");

  const TILE = 480;
  const GAP = 16;

  const leftTile = await sharp(Buffer.from(logoSvg)).resize(TILE, TILE).png().toBuffer();
  const rightTile = await sharp(Buffer.from(orbSvg)).resize(TILE, TILE).png().toBuffer();

  const canvasWidth = TILE * 2 + GAP * 3;
  const canvasHeight = TILE + GAP * 2;

  const out = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 40, g: 40, b: 44, alpha: 1 },
    },
  })
    .composite([
      { input: leftTile, top: GAP, left: GAP },
      { input: rightTile, top: GAP, left: GAP * 2 + TILE },
    ])
    .png()
    .toBuffer();

  await fs.writeFile("/tmp/crab-base.png", out);
  console.log("Wrote base crab (24×24) → /tmp/crab-base.png");
  console.log("Left: logo style (white on black)");
  console.log("Right: production aesthetic (crab red on glass orb)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
