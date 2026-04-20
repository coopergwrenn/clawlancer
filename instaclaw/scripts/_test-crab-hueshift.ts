/**
 * Test the new Candidate-02-based generator with hue shifts + varied backgrounds.
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  buildCrabImage,
  personalityHashBuffer,
  variationHashBuffer,
  computePersonalityHashHex,
} from "../lib/token-image-generator";

async function main() {
  // Test 1: same personality, 4 regens → same shell color, different bgs
  console.log("Test 1: same agent, 4 regens (should lock shell, vary bg)");
  const hashHex1 = computePersonalityHashHex("trader:crypto:defi");
  const consistencyTiles: Buffer[] = [];
  for (let v = 0; v < 4; v++) {
    const pH = personalityHashBuffer(hashHex1);
    const vH = variationHashBuffer(hashHex1, v);
    const png = await buildCrabImage(pH, vH);
    consistencyTiles.push(await sharp(png).resize(256, 256).png().toBuffer());
  }

  // Test 2: 12 different agents, variation 0 each → diverse shell colors
  console.log("Test 2: 12 different agents, variation 0 (should show shell color variety)");
  const diversityTiles: Buffer[] = [];
  for (let i = 0; i < 12; i++) {
    const hash = crypto.randomBytes(32);
    const hashHex = hash.toString("hex").slice(0, 32);
    const pH = personalityHashBuffer(hashHex);
    const vH = variationHashBuffer(hashHex, 0);
    const png = await buildCrabImage(pH, vH);
    diversityTiles.push(await sharp(png).resize(256, 256).png().toBuffer());
  }

  // Composite into two rows
  const TILE = 256;
  const GAP = 6;
  const COLS_1 = 4;  // consistency row
  const COLS_2 = 6;  // diversity grid
  const ROWS_2 = 2;

  const row1Width = COLS_1 * TILE + (COLS_1 + 1) * GAP;
  const row1Height = TILE + 2 * GAP;

  const row2Width = COLS_2 * TILE + (COLS_2 + 1) * GAP;
  const row2Height = ROWS_2 * TILE + (ROWS_2 + 1) * GAP;

  const totalWidth = Math.max(row1Width, row2Width);
  const totalHeight = row1Height + row2Height + 40;

  const composites = [
    // Consistency row
    ...consistencyTiles.map((b, i) => ({
      input: b,
      top: GAP,
      left: GAP + i * (TILE + GAP),
    })),
    // Diversity grid (offset below)
    ...diversityTiles.map((b, i) => ({
      input: b,
      top: row1Height + 40 + GAP + Math.floor(i / COLS_2) * (TILE + GAP),
      left: GAP + (i % COLS_2) * (TILE + GAP),
    })),
  ];

  const out = await sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 18, g: 18, b: 22, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  await fs.writeFile("/tmp/crab-hueshift-test.png", out);
  console.log("Wrote /tmp/crab-hueshift-test.png");
  console.log("Top row: same agent × 4 regens (locked shell + varied bg)");
  console.log("Bottom grid: 12 different agents (shell variety)");
}

main().catch((err) => { console.error(err); process.exit(1); });
