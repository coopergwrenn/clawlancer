/**
 * Screenshot — captures screen via usecomputer, converts PNG→JPEG via sharp.
 * Separated per PRD Section 5.1 package structure.
 */
import fs from "fs";
import path from "path";

export interface ScreenshotOptions {
  format?: "jpeg" | "png";
  quality?: number; // 1-100, JPEG only
}

export interface ScreenshotCapture {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  coordMap: string;
}

/**
 * Capture a screenshot and return it as a buffer with metadata.
 */
export async function captureScreenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotCapture> {
  const uc = await import("usecomputer");
  const tmpPath = path.join("/tmp", `dispatch-ss-${Date.now()}.png`);
  const format = opts.format || "jpeg";
  const quality = opts.quality || 80;

  try {
    const result = await uc.screenshot({ path: tmpPath, display: null, window: null, region: null, annotate: null });

    const pngBuffer = fs.readFileSync(tmpPath);
    let outputBuffer: Buffer;

    if (format === "jpeg") {
      try {
        const sharp = (await import("sharp")).default;
        outputBuffer = await sharp(pngBuffer).jpeg({ quality }).toBuffer();
      } catch {
        // sharp not available — fall back to PNG
        outputBuffer = pngBuffer;
      }
    } else {
      outputBuffer = pngBuffer;
    }

    return {
      buffer: outputBuffer,
      width: result.imageWidth,
      height: result.imageHeight,
      format,
      coordMap: result.coordMap,
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
