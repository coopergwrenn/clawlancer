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

// Build the glass-orb SVG background — radial gradient + highlight + rim
// for the signature 3D orb depth effect. Same bg color, different lighting.
function orbBackgroundSVG(bgLight: string, bgDark: string, size: number): string {
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="orbBg" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${bgLight}" stop-opacity="1"/>
      <stop offset="55%" stop-color="${bgLight}" stop-opacity="0.94"/>
      <stop offset="100%" stop-color="${bgDark}" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#orbBg)"/>
</svg>`;
}

// Build the orb highlight + rim overlay SVG (rendered on TOP of the crab
// to sit the orb "glass" over everything — preserves the 3D look).
function orbHighlightSVG(size: number): string {
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="highlight" cx="28%" cy="22%" r="30%">
      <stop offset="0%" stop-color="white" stop-opacity="0.35"/>
      <stop offset="45%" stop-color="white" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="rim" cx="50%" cy="50%" r="50%">
      <stop offset="88%" stop-color="black" stop-opacity="0"/>
      <stop offset="96%" stop-color="black" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.22"/>
    </radialGradient>
  </defs>
  <ellipse cx="${size * 0.3}" cy="${size * 0.2}" rx="${size * 0.2}" ry="${size * 0.11}" fill="url(#highlight)"/>
  <rect width="${size}" height="${size}" fill="url(#rim)"/>
</svg>`;
}

// ── Core image builder ──
// Pipeline: orb-gradient bg → hue-tinted crab → glass-highlight + rim overlay
export async function buildCrabImage(
  personalityHash: Buffer,
  variationHash: Buffer,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  // Shell hue — LOCKED to personality
  const hueShift = HUE_SHIFTS[personalityHash[0] % HUE_SHIFTS.length];
  // Background — VARIES per regen
  const bgHex = BG_COLORS[variationHash[0] % BG_COLORS.length];
  const bgDark = darkenHex(bgHex, 0.3);

  // Step 1: hue-shift the base crab (flattened to opaque black bg first)
  const base = loadBaseBuffer();
  const tintedRgb = await sharp(base)
    .flatten({ background: "#000000" })
    .modulate({ hue: hueShift })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { kernel: "nearest" })
    .toBuffer();

  // Step 2: alpha mask from luminance (black bg → transparent, crab → opaque)
  const alphaMask = await sharp(tintedRgb).greyscale().threshold(25).toBuffer();

  // Step 3: RGBA crab with transparent bg
  const crabWithAlpha = await sharp(tintedRgb).joinChannel(alphaMask).png().toBuffer();

  // Step 4: rasterize the orb bg SVG (radial gradient)
  const orbBg = await sharp(Buffer.from(orbBackgroundSVG(bgHex, bgDark, OUTPUT_SIZE)))
    .png()
    .toBuffer();

  // Step 5: rasterize the orb highlight + rim SVG (glass effects)
  const orbOverlay = await sharp(Buffer.from(orbHighlightSVG(OUTPUT_SIZE))).png().toBuffer();

  // Step 6: stack — orb bg → crab → highlight/rim
  const final = await sharp(orbBg)
    .composite([
      { input: crabWithAlpha, top: 0, left: 0 },
      { input: orbOverlay, top: 0, left: 0 },
    ])
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
