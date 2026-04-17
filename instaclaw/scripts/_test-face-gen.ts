/**
 * Visual test — generate 24 random faces and composite into a 6×4 grid PNG.
 * Run: npx tsx scripts/_test-face-gen.ts
 * Output: /tmp/face-test-grid.png
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import sharp from "sharp";
import { buildFaceGrid, hashToPalette, renderFaceSVG } from "../lib/token-image-generator";

const COLS = 6;
const ROWS = 4;
const TILE = 256;
const GAP = 8;

async function main() {
  const count = COLS * ROWS;
  const tiles: Buffer[] = [];

  for (let i = 0; i < count; i++) {
    const hash = crypto.randomBytes(32);
    const grid = buildFaceGrid(hash);
    const palette = hashToPalette(hash);
    const svg = renderFaceSVG(grid, palette);
    const png = await sharp(Buffer.from(svg)).resize(TILE, TILE).png().toBuffer();
    tiles.push(png);
  }

  const canvasWidth = COLS * TILE + (COLS + 1) * GAP;
  const canvasHeight = ROWS * TILE + (ROWS + 1) * GAP;

  const composites = tiles.map((buffer, i) => ({
    input: buffer,
    top: GAP + Math.floor(i / COLS) * (TILE + GAP),
    left: GAP + (i % COLS) * (TILE + GAP),
  }));

  const gridBuffer = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 24, g: 24, b: 28, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const outPath = "/tmp/face-test-grid.png";
  await fs.writeFile(outPath, gridBuffer);
  console.log(`Wrote ${count} faces → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
