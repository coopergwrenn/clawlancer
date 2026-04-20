/**
 * Decode Candidate 02 PNG into grid representations at multiple sizes
 * to find the native pixel resolution.
 */

import fs from "node:fs/promises";
import sharp from "sharp";

const SRC = "/Users/cooperwrenn/larry-canon/candidates/raw/_master-candidates/master-candidate-02-02-darker-legs.png";

async function decodeAt(size: number): Promise<string[]> {
  const { data } = await sharp(SRC)
    .resize(size, size, { fit: "contain", kernel: "nearest", background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rows: string[] = [];
  for (let r = 0; r < size; r++) {
    let row = "";
    for (let c = 0; c < size; c++) {
      const idx = (r * size + c) * 3;
      const red = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      // Crab pixel if it's brighter than very dark (black bg)
      const lum = (red + g + b) / 3;
      row += lum > 30 ? "#" : ".";
    }
    rows.push(row);
  }
  return rows;
}

async function main() {
  const meta = await sharp(SRC).metadata();
  console.log(`Source: ${meta.width}×${meta.height}\n`);

  // Try 16, 20, 24, 28, 32
  for (const size of [20, 24, 28, 32]) {
    console.log(`\n=== ${size}×${size} decode ===`);
    const rows = await decodeAt(size);
    for (let r = 0; r < rows.length; r++) {
      console.log(`"${rows[r]}", // ${r}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
