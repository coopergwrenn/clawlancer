/**
 * Test grid rendered at the ACTUAL display size users see (~160px).
 * This is what gets shown in the dashboard card preview.
 */

import fs from "node:fs/promises";
import sharp from "sharp";
import { buildCrabImage } from "../lib/token-image-generator";

function h(bytes: Record<number, number>): Buffer {
  const b = Buffer.alloc(32);
  for (const [k, v] of Object.entries(bytes)) b[Number(k)] = v;
  return b;
}

async function main() {
  const configs = [
    { label: "Laser + Degen Crown + Money Bag", p: h({ 0: 3, 8: 96, 14: 0 }), v: h({ 0: 12, 7: 58, 10: 90, 11: 3 }) },
    { label: "Deal-With-It + Gold Chain + Cash", p: h({ 0: 1, 9: 72, 14: 0 }), v: h({ 0: 0, 7: 80 }) },
    { label: "Pepe + Sunglasses + Joint", p: h({ 0: 15, 8: 99, 9: 55 }), v: h({ 0: 1, 12: 87 }) },
    { label: "Jester + Diamond + Clown Nose", p: h({ 0: 7, 14: 1 }), v: h({ 0: 15, 7: 66, 10: 95, 11: 1, 12: 98 }) },
    { label: "Hearts + 3D Glasses + Rocket", p: h({ 0: 16, 8: 78, 9: 83 }), v: h({ 0: 17, 7: 96 }) },
    { label: "Crown + Trophy + Tongue", p: h({ 0: 5, 14: 1 }), v: h({ 0: 2, 7: 93, 10: 85, 11: 2, 12: 92 }) },
    { label: "Angry + Eyepatch + Cowboy + Briefcase", p: h({ 0: 4, 8: 73, 9: 92 }), v: h({ 0: 10, 7: 90, 10: 44, 11: 4 }) },
    { label: "Tinfoil + Green Candle", p: h({ 0: 13, 14: 0 }), v: h({ 0: 22, 7: 95, 10: 93 }) },
    { label: "Dollar Eyes + Cash Stack", p: h({ 0: 6, 8: 86, 14: 1 }), v: h({ 0: 1, 7: 80, 12: 74 }) },
    { label: "Chef + Laptop", p: h({ 0: 0, 14: 1 }), v: h({ 0: 23, 7: 85, 10: 72, 11: 0 }) },
    { label: "Halo + GM Bubble", p: h({ 0: 14 }), v: h({ 0: 16, 7: 99, 10: 98, 11: 0 }) },
    { label: "Wide Eyes + Baseball Cap + Coffee", p: h({ 0: 8, 8: 55 }), v: h({ 0: 4, 7: 75, 10: 60, 11: 6 }) },
  ];

  const COLS = 4;
  const ROWS = 3;
  const TILE = 160;       // ACTUAL size users see
  const LARGE_TILE = 320; // 2x for detailed inspection
  const GAP = 10;

  console.log("Rendering 12 crabs at preview-accurate 160px + 320px for inspection...");

  const previewTiles: Buffer[] = [];
  const largeTiles: Buffer[] = [];
  for (const cfg of configs) {
    const png = await buildCrabImage(cfg.p, cfg.v);
    previewTiles.push(await sharp(png).resize(TILE, TILE, { kernel: "lanczos3" }).png().toBuffer());
    largeTiles.push(await sharp(png).resize(LARGE_TILE, LARGE_TILE, { kernel: "lanczos3" }).png().toBuffer());
    console.log(`  ✓ ${cfg.label}`);
  }

  // Row 1-2: preview-size grid (what users actually see)
  // Row 3-4: larger for inspection
  const previewW = COLS * TILE + (COLS + 1) * GAP;
  const previewH = ROWS * TILE + (ROWS + 1) * GAP;
  const largeW = COLS * LARGE_TILE + (COLS + 1) * GAP;
  const largeH = ROWS * LARGE_TILE + (ROWS + 1) * GAP;

  // Preview grid only (at 160px)
  const previewComposites = previewTiles.map((b, i) => ({
    input: b,
    top: GAP + Math.floor(i / COLS) * (TILE + GAP),
    left: GAP + (i % COLS) * (TILE + GAP),
  }));
  const previewGrid = await sharp({
    create: { width: previewW, height: previewH, channels: 4, background: { r: 240, g: 240, b: 245, alpha: 1 } },
  }).composite(previewComposites).png().toBuffer();
  await fs.writeFile("/tmp/crab-preview-size.png", previewGrid);

  // Large inspection grid
  const largeComposites = largeTiles.map((b, i) => ({
    input: b,
    top: GAP + Math.floor(i / COLS) * (LARGE_TILE + GAP),
    left: GAP + (i % COLS) * (LARGE_TILE + GAP),
  }));
  const largeGrid = await sharp({
    create: { width: largeW, height: largeH, channels: 4, background: { r: 18, g: 18, b: 22, alpha: 1 } },
  }).composite(largeComposites).png().toBuffer();
  await fs.writeFile("/tmp/crab-preview-large.png", largeGrid);

  console.log("\n/tmp/crab-preview-size.png  (actual 160px user-visible size)");
  console.log("/tmp/crab-preview-large.png (320px for detail inspection)");
}

main().catch((err) => { console.error(err); process.exit(1); });
