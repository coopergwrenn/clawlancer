/**
 * Test grid showing specific meme trait combinations.
 * Constructs raw 32-byte hash buffers with targeted bytes to force
 * specific traits — verifies each accessory renders recognizably.
 */

import fs from "node:fs/promises";
import sharp from "sharp";
import { buildCrabImage } from "../lib/token-image-generator";

// Helper to construct a hash with specific bytes
function h(bytes: Record<number, number>): Buffer {
  const b = Buffer.alloc(32);
  for (const [k, v] of Object.entries(bytes)) {
    b[Number(k)] = v;
  }
  return b;
}

async function main() {
  const configs = [
    {
      label: "Laser Eyes + Degen Crown + Money Bag",
      // p: hue=red, eye=laser(98), eyewear=none(0), chain=yes(0)
      p: h({ 0: 3, 8: 98, 9: 0, 14: 0 }),
      // v: bg=midnight(12), item=money_bag(58), hat=degen_crown(90), color=gold(3), mouth=none
      v: h({ 0: 12, 7: 58, 10: 90, 11: 3, 12: 0 }),
    },
    {
      label: "Deal-With-It + Gold Chain + Cash",
      p: h({ 0: 1, 8: 0, 9: 72, 14: 0 }),
      v: h({ 0: 0, 7: 78, 10: 100, 11: 0, 12: 0 }), // v[10]=100 hits devil_horns actually; use none via no v[10] key sets 0 = none
    },
    {
      label: "Pepe Eyes + Sunglasses + Joint",
      p: h({ 0: 15, 8: 99, 9: 55, 14: 10 }),
      v: h({ 0: 1, 7: 0, 10: 0, 11: 0, 12: 85 }),
    },
    {
      label: "Jester Hat + Diamond + Clown Nose",
      p: h({ 0: 7, 8: 0, 9: 0, 14: 1 }),
      v: h({ 0: 15, 7: 66, 10: 95, 11: 1, 12: 98 }),
    },
    {
      label: "Heart Eyes + 3D Glasses + Rocket",
      p: h({ 0: 16, 8: 85, 9: 80, 14: 1 }),
      v: h({ 0: 17, 7: 94, 10: 0, 11: 0, 12: 0 }),
    },
    {
      label: "Regular Crown + Trophy + Tongue Out",
      p: h({ 0: 5, 8: 0, 9: 0, 14: 1 }),
      v: h({ 0: 2, 7: 91, 10: 85, 11: 2, 12: 94 }),
    },
    {
      label: "Angry Eyes + Eyepatch + Cowboy + Briefcase",
      p: h({ 0: 4, 8: 65, 9: 92, 14: 1 }),
      v: h({ 0: 10, 7: 87, 10: 44, 11: 4, 12: 0 }),
    },
    {
      label: "Tinfoil Hat + Green Candle + Gold Chain",
      p: h({ 0: 13, 8: 0, 9: 0, 14: 0 }),
      v: h({ 0: 22, 7: 95, 10: 93, 11: 0, 12: 0 }),
    },
    {
      label: "Sleepy + Monocle + Top Hat + Coffee",
      p: h({ 0: 9, 8: 75, 9: 85, 14: 1 }),
      v: h({ 0: 14, 7: 73, 10: 65, 11: 0, 12: 0 }),
    },
    {
      label: "Dollar Eyes + Money Printer + Cigarette",
      p: h({ 0: 6, 8: 90, 9: 0, 14: 1 }),
      v: h({ 0: 1, 7: 97, 10: 0, 11: 0, 12: 70 }),
    },
    {
      label: "Chef Hat + Laptop + Gold Tooth",
      p: h({ 0: 0, 8: 0, 9: 0, 14: 1 }),
      v: h({ 0: 23, 7: 82, 10: 69, 11: 0, 12: 90 }),
    },
    {
      label: "Halo + GM Bubble + Hearts Eyes",
      p: h({ 0: 14, 8: 85, 9: 0, 14: 1 }),
      v: h({ 0: 16, 7: 99, 10: 95, 11: 0, 12: 0 }),
    },
  ];

  const COLS = 3;
  const ROWS = 4;
  const TILE = 480;
  const GAP = 12;

  console.log("Rendering 12 curated meme crabs...");
  const tiles: Buffer[] = [];
  for (const cfg of configs) {
    const png = await buildCrabImage(cfg.p, cfg.v);
    tiles.push(await sharp(png).resize(TILE, TILE).png().toBuffer());
    console.log(`  ✓ ${cfg.label}`);
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

  await fs.writeFile("/tmp/crab-memes.png", out);
  console.log("\nWrote /tmp/crab-memes.png");
}

main().catch((err) => { console.error(err); process.exit(1); });
