/**
 * Decode Candidate 02 at 28×28 with multi-tone classification.
 * Emits a grid where each cell is:
 *   '.' = background (near-black)
 *   'L' = light top tone   (brighter orange, top + claws main body)
 *   'D' = dark bottom tone (darker orange/brown, legs + underside)
 *   'E' = eye pixel (very dark, not background)
 */

import fs from "node:fs/promises";
import sharp from "sharp";

const SRC = "/Users/cooperwrenn/larry-canon/candidates/raw/_master-candidates/master-candidate-02-02-darker-legs.png";
const GRID = 28;

async function main() {
  const { data } = await sharp(SRC)
    .resize(GRID, GRID, { fit: "contain", kernel: "nearest", background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rows: string[] = [];
  console.log(`\nRaw 28×28 classification:\n`);
  for (let r = 0; r < GRID; r++) {
    let row = "";
    for (let c = 0; c < GRID; c++) {
      const idx = (r * GRID + c) * 3;
      const R = data[idx], G = data[idx + 1], B = data[idx + 2];
      const lum = (R + G + B) / 3;

      if (lum < 25) row += ".";                        // black bg
      else if (lum < 90 && R > G && G > B) row += "D"; // dark tone (brown/dark orange)
      else if (lum < 70) row += "E";                   // eye (dark but not orange — low R)
      else row += "L";                                 // light top tone
    }
    rows.push(row);
    console.log(`  "${row}", // ${r}`);
  }

  // Sample a few pixel RGB values to help verify the thresholds
  console.log(`\nRGB samples:`);
  const sample = (r: number, c: number) => {
    const idx = (r * GRID + c) * 3;
    return `${data[idx]},${data[idx + 1]},${data[idx + 2]}`;
  };
  console.log(`  top of body (light):   rgb(${sample(12, 14)})`);
  console.log(`  bottom leg (dark):     rgb(${sample(22, 8)})`);
  console.log(`  background:            rgb(${sample(0, 0)})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
