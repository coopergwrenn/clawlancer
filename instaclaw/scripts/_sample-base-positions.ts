/**
 * Sample the Candidate 02 base PNG to find exact pixel positions of
 * key features (eyes, body center, claw tips, etc.) so overlays can
 * be positioned correctly.
 */

import sharp from "sharp";

const BASE = "/Users/cooperwrenn/wild-west-bots/instaclaw/public/assets/crab-base.png";

async function main() {
  const { data, info } = await sharp(BASE).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;

  console.log(`Base: ${W}×${H}, ${ch} channels`);

  // Find very dark pixels (eyes are near-black dots on orange body)
  // Restrict search to the body region (upper-mid of image)
  const darkSpots: Array<{ x: number; y: number; lum: number }> = [];
  for (let y = H * 0.35; y < H * 0.65; y += 4) {
    for (let x = W * 0.2; x < W * 0.8; x += 4) {
      const idx = (Math.floor(y) * W + Math.floor(x)) * ch;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const lum = (r + g + b) / 3;
      // Dark pixel surrounded by orange: likely an eye
      if (lum < 50) {
        // Check surrounding is orange (not itself bg)
        const nIdx = (Math.floor(y - 20) * W + Math.floor(x)) * ch;
        const nLum = (data[nIdx] + data[nIdx + 1] + data[nIdx + 2]) / 3;
        if (nLum > 100) {
          darkSpots.push({ x: Math.floor(x), y: Math.floor(y), lum });
        }
      }
    }
  }
  console.log(`Found ${darkSpots.length} candidate eye-like dark spots`);

  // Cluster nearby points
  const clusters: Array<{ cx: number; cy: number; count: number }> = [];
  for (const p of darkSpots) {
    const found = clusters.find((c) => Math.abs(c.cx - p.x) < 50 && Math.abs(c.cy - p.y) < 50);
    if (found) {
      found.cx = (found.cx * found.count + p.x) / (found.count + 1);
      found.cy = (found.cy * found.count + p.y) / (found.count + 1);
      found.count++;
    } else {
      clusters.push({ cx: p.x, cy: p.y, count: 1 });
    }
  }
  clusters.sort((a, b) => b.count - a.count);
  console.log(`\nTop 2 clusters (likely left + right eyes):`);
  for (const c of clusters.slice(0, 2)) {
    console.log(`  eye center: (${c.cx.toFixed(0)}, ${c.cy.toFixed(0)}) — count: ${c.count}`);
  }

  // Find overall crab bounding box (non-black pixels)
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const idx = (y * W + x) * ch;
      const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (lum > 30) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(`\nCrab bounding box: (${minX}, ${minY}) → (${maxX}, ${maxY})`);
  console.log(`  width: ${maxX - minX}px, height: ${maxY - minY}px`);
  console.log(`  center: (${((minX + maxX) / 2).toFixed(0)}, ${((minY + maxY) / 2).toFixed(0)})`);

  // Logical pixel size estimate — find a 1-pixel wide dark gap
  // Check horizontal gap widths near the top
  console.log(`\nEstimating logical pixel size by sampling edges…`);
  const probeY = Math.floor((minY + maxY) / 2);
  let gaps: number[] = [];
  let inDark = false;
  let gapStart = 0;
  for (let x = minX; x <= maxX; x++) {
    const idx = (probeY * W + x) * ch;
    const lum = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    const dark = lum < 30;
    if (dark && !inDark) {
      gapStart = x;
      inDark = true;
    } else if (!dark && inDark) {
      gaps.push(x - gapStart);
      inDark = false;
    }
  }
  gaps.sort((a, b) => a - b);
  console.log(`  gap widths (horizontal, at row ${probeY}): ${gaps.slice(0, 10).join(", ")}`);
  if (gaps.length > 0) {
    console.log(`  smallest gap ≈ 1 logical pixel: ${gaps[0]}px`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
