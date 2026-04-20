/**
 * Test the full trait-overlay system. Renders 12 crabs with deliberate
 * seeds to show coverage of different traits.
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  buildCrabImage,
  personalityHashBuffer,
  variationHashBuffer,
} from "../lib/token-image-generator";

async function main() {
  const COUNT = 12;
  const COLS = 4;
  const ROWS = 3;
  const TILE = 400;
  const GAP = 10;

  // Use a mix of seeds to force variety — handcrafted hashes to show off different
  // trait combinations (specific bytes hit specific trait indices)
  const seeds = [
    // Try a range of personality hashes that hit different eye/eyewear combos
    "0102030405060708090a0b0c0d0e0f10",
    "1112131415161718191a1b1c1d1e1f20",
    "2122232425262728292a2b2c2d2e2f30",
    "3132333435363738393a3b3c3d3e3f40",
    "4142434445464748494a4b4c4d4e4f50",
    "5152535455565758595a5b5c5d5e5f60",
    "6162636465666768696a6b6c6d6e6f70",
    "7172737475767778797a7b7c7d7e7f80",
    "8182838485868788898a8b8c8d8e8f90",
    "9192939495969798999a9b9c9d9e9fa0",
    "a1a2a3a4a5a6a7a8a9aaabacadaeafb0",
    "b1b2b3b4b5b6b7b8b9babbbcbdbebfc0",
  ];

  const tiles: Buffer[] = [];
  for (let i = 0; i < COUNT; i++) {
    const pH = personalityHashBuffer(seeds[i]);
    // Different variation index for each so they each show different variation traits
    const vH = variationHashBuffer(seeds[i], i);
    const png = await buildCrabImage(pH, vH);
    tiles.push(await sharp(png).resize(TILE, TILE).png().toBuffer());
  }

  const canvasW = COLS * TILE + (COLS + 1) * GAP;
  const canvasH = ROWS * TILE + (ROWS + 1) * GAP;
  const composites = tiles.map((b, i) => ({
    input: b,
    top: GAP + Math.floor(i / COLS) * (TILE + GAP),
    left: GAP + (i % COLS) * (TILE + GAP),
  }));

  const out = await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 18, g: 18, b: 22, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  await fs.writeFile("/tmp/crab-full-traits.png", out);
  console.log(`Wrote /tmp/crab-full-traits.png — ${COUNT} crabs with random trait mix`);
}

main().catch((err) => { console.error(err); process.exit(1); });
