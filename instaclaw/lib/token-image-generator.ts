/**
 * Token PFP generation — Candidate 02 base image + hue-tint + varied bg.
 *
 * Strategy: instead of pixel-by-pixel reconstruction, we use the actual
 * Larry Canon master PNG as the base and apply color transforms via sharp.
 * This preserves the exact aesthetic quality of the hand-designed mascot.
 *
 * Two-hash split:
 *   personalityHash (LOCKED): shell hue (what color the agent's crab is)
 *   variationHash (VARIES):   background color/scene (changes per regen)
 *
 * Phase 2 (later): accessory PNG overlays composited on top.
 */

import path from "node:path";
import fs from "node:fs";
import type sharpType from "sharp";

const BASE_IMAGE_PATH = path.join(process.cwd(), "public", "assets", "crab-base.png");
const OUTPUT_SIZE = 512;

// Module-level cache for the base image buffer (read once per function cold start)
let _baseCache: Buffer | null = null;
function loadBaseBuffer(): Buffer {
  if (_baseCache) return _baseCache;
  _baseCache = fs.readFileSync(BASE_IMAGE_PATH);
  return _baseCache;
}

// ── Shell hue shifts (LOCKED to personality) ──
// Each value is degrees to rotate the base orange hue in HSL space.
// Base Candidate 02 is ~20° orange. Shifts produce: red / yellow / green / blue / purple etc.
const HUE_SHIFTS = [
  0,    // orange (default, matches base)
  0,    // orange (repeat for higher probability)
  -15,  // warmer orange / coral
  -30,  // red
  -45,  // deep red
  15,   // yellow-orange
  30,   // yellow
  60,   // yellow-green
  90,   // green
  120,  // deep green
  150,  // teal
  180,  // cyan
  210,  // blue
  240,  // deep blue
  270,  // purple
  300,  // magenta
  330,  // pink
];

// ── Background color palette (VARIES per regen) ──
// Dark world tones + soft pastels. Varies each regeneration.
const BG_COLORS = [
  // Near-black (matches base Candidate 02 framing)
  "#0D0D0D", "#1A1A1A", "#141414", "#101010",
  // Deep themed
  "#1F2533", "#2C1F2E", "#1F2E1F", "#2E1F1F",
  "#1A2E40", "#402E1A", "#2E4A1F", "#4A1F2E",
  // Midnight sky
  "#0A0E2A", "#1F1F3E",
  // Soft orbs
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA",
  "#D8E5D5", "#E5D5DE", "#D5E0D5", "#D8D5E0",
  // Rare
  "#2C1F5E", "#F5E6A8", "#E67E22",
];

// ── Helpers ──
export function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mult = Math.max(0, 1 - factor);
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(v * mult).toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// ── Core image builder ──
// Returns a PNG buffer of the finished token PFP.
export async function buildCrabImage(
  personalityHash: Buffer,
  variationHash: Buffer,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  // Shell hue — LOCKED to personality
  const hueShift = HUE_SHIFTS[personalityHash[0] % HUE_SHIFTS.length];
  // Background — VARIES per regen
  const bgHex = BG_COLORS[variationHash[0] % BG_COLORS.length];
  const bgRgb = hexToRgb(bgHex);

  const base = loadBaseBuffer();
  const meta = await sharp(base).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1024;

  // Step 1: flatten base against its own (black) bg so we have a clean RGB image,
  // then hue-shift. Resize to OUTPUT_SIZE early so all downstream buffers match.
  const tintedRgb = await sharp(base)
    .flatten({ background: "#000000" })
    .modulate({ hue: hueShift })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: "nearest" })
    .toBuffer();

  // Step 2: derive alpha mask from the tinted crab's luminance
  // Black bg (lum < 25) → 0 (transparent); crab → 255 (opaque)
  const alphaMask = await sharp(tintedRgb)
    .greyscale()
    .threshold(25)
    .toBuffer();

  // Step 3: attach alpha to tinted → RGBA crab
  const crabWithAlpha = await sharp(tintedRgb)
    .joinChannel(alphaMask)
    .png()
    .toBuffer();

  // Step 4: build bg canvas at OUTPUT_SIZE + composite crab on top
  const final = await sharp({
    create: {
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      channels: 3,
      background: { r: bgRgb.r, g: bgRgb.g, b: bgRgb.b },
    },
  })
    .composite([{ input: crabWithAlpha, top: 0, left: 0 }])
    .png()
    .toBuffer();

  return final;
}

// ── Hash helpers (unchanged — preserves existing API) ──
export function computePersonalityHashHex(personalityText: string): string {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(personalityText).digest("hex").slice(0, 32);
}

export function personalityHashBuffer(personalityHashHex: string): Buffer {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(personalityHashHex).digest();
}

export function variationHashBuffer(personalityHashHex: string, variation: number): Buffer {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(`${personalityHashHex}:${variation}`).digest();
}

// ── Legacy API stubs (kept for backward compatibility) ──
// These used to return Grid/Palette and then the caller converted to PNG via SVG.
// Now we have a direct image pipeline. These stubs let existing imports resolve,
// but callers should migrate to buildCrabImage() directly.
export type Grid = (string | null)[][];
export const GRID_SIZE = 28;
export interface Palette {
  bg: string;
}
export function buildFaceGrid(_p: Buffer, _v: Buffer): Grid {
  return [];
}
export function hashToPalette(_p: Buffer, variationHash: Buffer): Palette {
  return { bg: BG_COLORS[variationHash[0] % BG_COLORS.length] };
}
export function renderFaceSVG(_grid: Grid, _palette: Palette): string {
  return "";
}
