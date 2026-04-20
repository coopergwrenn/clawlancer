import fs from "node:fs/promises";
import { buildCrabImage, personalityHashBuffer, variationHashBuffer } from "../lib/token-image-generator";
import sharp from "sharp";

async function main() {
  // Try a few specific seeds that should hit specific traits
  const tests = [
    { name: "plain", pHex: "0000000000000000000000000000000f", vIdx: 0 },
    { name: "top-hat", pHex: "0000000000000000000000000000000f", vIdx: 7 },
    { name: "crown", pHex: "0101010101010101010101010101010f", vIdx: 20 },
    { name: "laser-eyes", pHex: "000000ff00ff0000000000000000000f", vIdx: 3 },
    { name: "sunglasses", pHex: "0000000000000048000000000000000f", vIdx: 5 },
  ];

  for (const t of tests) {
    const pH = personalityHashBuffer(t.pHex);
    const vH = variationHashBuffer(t.pHex, t.vIdx);
    const png = await buildCrabImage(pH, vH);
    // Save at 512 to see full detail
    const out = await sharp(png).resize(512, 512).png().toBuffer();
    await fs.writeFile(`/tmp/crab-${t.name}.png`, out);
    console.log(`Wrote /tmp/crab-${t.name}.png`);
  }
}

main().catch(console.error);
