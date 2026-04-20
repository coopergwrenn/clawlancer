/**
 * Isolate individual traits to figure out what's on screen.
 * Renders each trait in isolation so we can compare.
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
  // Isolated trait renders — teal shell (hue=180) in each, changing one trait at a time
  const teal = 11; // 180° hue = teal/cyan

  const tests = [
    { label: "teal-plain", p: h({ 0: teal }), v: h({}) },
    { label: "teal-laser", p: h({ 0: teal, 8: 96 }), v: h({}) },       // laser eyes
    { label: "teal-pepe", p: h({ 0: teal, 8: 99 }), v: h({}) },        // pepe eyes
    { label: "teal-headphones", p: h({ 0: teal }), v: h({ 10: 80 }) }, // headphones
    { label: "teal-laservisor", p: h({ 0: teal, 9: 97 }), v: h({}) },  // laser_visor
    { label: "teal-3d-glasses", p: h({ 0: teal, 9: 81 }), v: h({}) },  // 3d glasses
  ];

  for (const t of tests) {
    const png = await buildCrabImage(t.p, t.v);
    await fs.writeFile(`/tmp/iso-${t.label}.png`, png);
    console.log(`Wrote /tmp/iso-${t.label}.png`);
  }

  // Also composite them 3x2 for quick comparison
  const tiles = await Promise.all(tests.map(async (t) => {
    const buf = await fs.readFile(`/tmp/iso-${t.label}.png`);
    return sharp(buf).resize(360, 360).png().toBuffer();
  }));

  const COLS = 3, TILE = 360, GAP = 8;
  const composites = tiles.map((b, i) => ({
    input: b, top: GAP + Math.floor(i / COLS) * (TILE + GAP),
    left: GAP + (i % COLS) * (TILE + GAP),
  }));
  const out = await sharp({
    create: { width: COLS * TILE + (COLS + 1) * GAP, height: 2 * TILE + 3 * GAP, channels: 4, background: { r: 20, g: 20, b: 24, alpha: 1 } },
  }).composite(composites).png().toBuffer();
  await fs.writeFile("/tmp/iso-grid.png", out);
  console.log("Grid written to /tmp/iso-grid.png");
}

main().catch(console.error);
