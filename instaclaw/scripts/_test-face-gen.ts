/**
 * Two-axis consistency test — rows = different agent personalities, cols = variations.
 * Verifies same personality → same character across regens; different personality → different character.
 * Output: /tmp/face-test-grid.png
 */

import fs from "node:fs/promises";
import sharp from "sharp";
import {
  buildFaceGrid,
  hashToPalette,
  renderFaceSVG,
  personalityHashBuffer,
  variationHashBuffer,
  computePersonalityHashHex,
} from "../lib/token-image-generator";

const PERSONALITIES = [
  "aggressive trader focused on crypto DeFi and polymarket perpetual swaps",
  "artistic creative designer who loves music film and photography experiences",
  "curious researcher studying AI safety alignment and cognitive science topics",
  "stoic philosopher reading ancient texts meditating on virtue ethics daily",
  "mischievous hacker pen testing security systems finding zero day exploits",
  "wild chaotic degenerate meme coin trader moonshot bagholder diamond hands",
];

const COLS = 4;
const ROWS = PERSONALITIES.length;
const TILE = 320;
const GAP = 10;

async function main() {
  const tiles: Array<{ buffer: Buffer; row: number; col: number }> = [];

  for (let r = 0; r < ROWS; r++) {
    const hashHex = computePersonalityHashHex(PERSONALITIES[r]);
    for (let v = 0; v < COLS; v++) {
      const pHash = personalityHashBuffer(hashHex);
      const vHash = variationHashBuffer(hashHex, v);
      const grid = buildFaceGrid(pHash, vHash);
      const palette = hashToPalette(pHash, vHash);
      const svg = renderFaceSVG(grid, palette);
      const png = await sharp(Buffer.from(svg)).resize(TILE, TILE).png().toBuffer();
      tiles.push({ buffer: png, row: r, col: v });
    }
  }

  const canvasWidth = COLS * TILE + (COLS + 1) * GAP;
  const canvasHeight = ROWS * TILE + (ROWS + 1) * GAP;

  const composites = tiles.map((t) => ({
    input: t.buffer,
    top: GAP + t.row * (TILE + GAP),
    left: GAP + t.col * (TILE + GAP),
  }));

  const gridBuffer = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 18, g: 18, b: 22, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const outPath = "/tmp/face-test-grid.png";
  await fs.writeFile(outPath, gridBuffer);
  console.log(`Wrote ${ROWS}×${COLS} = ${ROWS * COLS} faces → ${outPath}`);
  console.log("Each row = same personality across 4 variations — should look like SAME character.");
  console.log("Different rows = different personalities — should look like DIFFERENT characters.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
