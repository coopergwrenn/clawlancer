/**
 * Screenshot — captures screen via usecomputer, compresses via sharp.
 * Optimized for speed: WebP format, quality 55, resolution capped at 1280x720.
 */
import fs from "fs";
import path from "path";

// Pre-warm sharp at module load (avoid dynamic import per screenshot)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpFn: any = null;
const sharpReady = import("sharp").then((m) => { sharpFn = (m as any).default || m; }).catch(() => {});

export interface ScreenshotOptions {
  format?: "jpeg" | "png" | "webp";
  quality?: number; // 1-100
  /** Max width — downscale if screen is larger (default 1280) */
  maxWidth?: number;
}

export interface ScreenshotCapture {
  buffer: Buffer;
  width: number;
  height: number;
  format: string;
  coordMap: string;
}

// Pre-warm usecomputer at module load
let ucMod: typeof import("usecomputer") | null = null;
const ucReady = import("usecomputer").then((m) => { ucMod = m; }).catch(() => {});

/**
 * Capture a screenshot and return it as a buffer with metadata.
 */
export async function captureScreenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotCapture> {
  // Ensure modules are loaded
  if (!ucMod) await ucReady;
  if (!sharpFn) await sharpReady;
  const uc = ucMod!;

  const tmpPath = path.join("/tmp", `dispatch-ss-${Date.now()}.png`);
  const format = opts.format || "webp";
  const quality = opts.quality || 55;
  const maxWidth = opts.maxWidth || 1280;

  try {
    const result = await uc.screenshot({ path: tmpPath, display: null, window: null, region: null, annotate: null });

    const pngBuffer = fs.readFileSync(tmpPath);
    let outputBuffer: Buffer;
    let outWidth = result.imageWidth;
    let outHeight = result.imageHeight;

    if (sharpFn) {
      try {
        let pipeline = sharpFn(pngBuffer);

        // Downscale if wider than maxWidth (HiDPI screens capture at 2x+)
        if (result.imageWidth > maxWidth) {
          pipeline = pipeline.resize(maxWidth, null, { fit: "inside", withoutEnlargement: true });
          const ratio = maxWidth / result.imageWidth;
          outWidth = maxWidth;
          outHeight = Math.round(result.imageHeight * ratio);
        }

        // Encode to target format
        if (format === "webp") {
          outputBuffer = await pipeline.webp({ quality, effort: 2 }).toBuffer();
        } else if (format === "jpeg") {
          outputBuffer = await pipeline.jpeg({ quality }).toBuffer();
        } else {
          outputBuffer = await pipeline.png().toBuffer();
        }
      } catch {
        // sharp failed — fall back to raw PNG
        outputBuffer = pngBuffer;
      }
    } else {
      // No sharp available — return raw PNG
      outputBuffer = pngBuffer;
    }

    return {
      buffer: outputBuffer,
      width: outWidth,
      height: outHeight,
      format,
      coordMap: result.coordMap,
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
