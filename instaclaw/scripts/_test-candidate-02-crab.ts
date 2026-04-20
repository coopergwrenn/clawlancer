/**
 * Test the new 28×28 Candidate 02 generator.
 * Left: base silhouette (single orange crab, no traits) vs reference.
 * Right: 24-crab grid showing variety.
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  buildFaceGrid,
  hashToPalette,
  renderFaceSVG,
  personalityHashBuffer,
  variationHashBuffer,
  computePersonalityHashHex,
} from "../lib/token-image-generator";

async function main() {
  // ── Comparison: reference PNG vs our default base ──
  const refPath = "/Users/cooperwrenn/larry-canon/candidates/raw/_master-candidates/master-candidate-02-02-darker-legs.png";
  const REF_TILE = 480;

  // Default shell — burnt-orange (matches Candidate 02)
  const defaultHashHex = computePersonalityHashHex("default:candidate-02");
  const pHash = personalityHashBuffer(defaultHashHex);
  const vHash = variationHashBuffer(defaultHashHex, 0);
  const grid = buildFaceGrid(pHash, vHash);
  const palette = hashToPalette(pHash, vHash);
  const baseSvg = renderFaceSVG(grid, palette);
  const baseTile = await sharp(Buffer.from(baseSvg)).resize(REF_TILE, REF_TILE).png().toBuffer();
  const refTile = await sharp(refPath).resize(REF_TILE, REF_TILE).png().toBuffer();

  const compWidth = REF_TILE * 2 + 48;
  const compHeight = REF_TILE + 32;
  const comparison = await sharp({
    create: { width: compWidth, height: compHeight, channels: 4, background: { r: 30, g: 30, b: 34, alpha: 1 } },
  })
    .composite([
      { input: refTile, top: 16, left: 16 },
      { input: baseTile, top: 16, left: 32 + REF_TILE },
    ])
    .png()
    .toBuffer();
  await fs.writeFile("/tmp/crab-comparison.png", comparison);
  console.log("Wrote /tmp/crab-comparison.png (reference | our render)");

  // ── 24-crab variety grid ──
  const COUNT = 24;
  const COLS = 6;
  const ROWS = 4;
  const TILE = 240;
  const GAP = 6;

  const tiles: Buffer[] = [];
  for (let i = 0; i < COUNT; i++) {
    const hash = crypto.randomBytes(32);
    const hashHex = hash.toString("hex").slice(0, 32);
    const pH = personalityHashBuffer(hashHex);
    const vH = variationHashBuffer(hashHex, i);
    const g = buildFaceGrid(pH, vH);
    const pal = hashToPalette(pH, vH);
    const svg = renderFaceSVG(g, pal);
    const png = await sharp(Buffer.from(svg)).resize(TILE, TILE).png().toBuffer();
    tiles.push(png);
  }

  const canvasW = COLS * TILE + (COLS + 1) * GAP;
  const canvasH = ROWS * TILE + (ROWS + 1) * GAP;
  const composites = tiles.map((b, i) => ({
    input: b,
    top: GAP + Math.floor(i / COLS) * (TILE + GAP),
    left: GAP + (i % COLS) * (TILE + GAP),
  }));
  const grid24 = await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: { r: 18, g: 18, b: 22, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
  await fs.writeFile("/tmp/crab-variety.png", grid24);
  console.log(`Wrote /tmp/crab-variety.png (${COUNT} random variants)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
