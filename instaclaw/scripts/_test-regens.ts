import fs from "node:fs/promises";
import sharp from "sharp";
import {
  buildCrabImage,
  personalityHashBuffer,
  variationHashBuffer,
} from "../lib/token-image-generator";

async function main() {
  const hashHex = "746573742d6167656e742d3132330000";
  const tiles: Buffer[] = [];
  for (let i = 0; i < 6; i++) {
    const pH = personalityHashBuffer(hashHex);
    const vH = variationHashBuffer(hashHex, i);
    const png = await buildCrabImage(pH, vH);
    tiles.push(await sharp(png).resize(256, 256).png().toBuffer());
  }
  const composites = tiles.map((b, i) => ({ input: b, top: 10, left: 10 + i * 266 }));
  const W = 6 * 266 + 10;
  const out = await sharp({
    create: { width: W, height: 276, channels: 4, background: { r: 18, g: 18, b: 22, alpha: 1 } },
  }).composite(composites).png().toBuffer();
  await fs.writeFile("/tmp/same-agent-regens.png", out);
  console.log("Wrote /tmp/same-agent-regens.png");
}
main().catch(console.error);
