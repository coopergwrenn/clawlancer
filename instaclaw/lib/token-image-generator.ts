/**
 * Token PFP generation — Candidate 02 base + HD trait overlays.
 *
 * Pipeline:
 *   1. Load Candidate 02 PNG (1024×1024 master from Larry Canon)
 *   2. Hue-shift the base for shell color (personality-locked)
 *   3. Composite trait overlays (eyes, eyewear, hat, item, mouth) as
 *      transparent 1024×1024 PNGs drawn from SVG
 *   4. Wrap in glass-orb background + rim/highlight
 *
 * Overlays render at the base's native resolution (no pixel-block mismatch).
 * Each overlay uses 30px "big pixels" to match the base's logical pixel grid.
 *
 * Personality-locked (LOCKED across regens): shell hue, eye style, eyewear
 * Variation-locked (VARIES per regen): background, hat, held item, mouth
 */

import path from "node:path";
import fs from "node:fs";

const BASE_IMAGE_PATH = path.join(process.cwd(), "public", "assets", "crab-base.png");
const OUTPUT_SIZE = 1024;
const LP = 22; // logical pixel = 22 canvas px — sized so overlays don't dominate the ~670px-wide crab

// Key feature positions in the 1024×1024 base (sampled from actual PNG)
const LEFT_EYE_X = 352;
const RIGHT_EYE_X = 660;
const EYE_Y = 385;
const HAT_CENTER_X = 512;
const HAT_BOTTOM_Y = 400;   // hat sits above this line
const ITEM_CENTER_X = 512;
const ITEM_BOTTOM_Y = 310;  // item "held" above claws, above this line
const MOUTH_Y = 475;
const MOUTH_CENTER_X = 512;

let _baseCache: Buffer | null = null;
function loadBaseBuffer(): Buffer {
  if (_baseCache) return _baseCache;
  _baseCache = fs.readFileSync(BASE_IMAGE_PATH);
  return _baseCache;
}

// ── Color helpers ──
export function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mult = Math.max(0, 1 - factor);
  return (
    "#" +
    [r, g, b].map((v) => Math.round(v * mult).toString(16).padStart(2, "0")).join("")
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// Draw a chunky "pixel" at logical size (30×30 canvas px default)
function rect(x: number, y: number, color: string, w = 1, h = 1): string {
  return `<rect x="${x}" y="${y}" width="${LP * w}" height="${LP * h}" fill="${color}"/>`;
}

// Wrap SVG body in a 1024×1024 transparent canvas
function svgWrap(body: string): string {
  return `<svg width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">${body}</svg>`;
}

// ── Shell hue shifts (LOCKED per personality) ──
const HUE_SHIFTS = [
  0, 0,              // orange (2x weight → default)
  -15, -30, -45,     // warm: coral, red, deep red
  15, 30, 60,        // warm-shift: yellow-orange, yellow, yellow-green
  90, 120, 150,      // green family
  180, 210, 240,     // cyan → blue
  270, 300, 330,     // purple → pink
];

// ── Background palette (VARIES per regen) ──
const BG_COLORS = [
  "#0D0D0D", "#1A1A1A", "#141414", "#101010",
  "#1F2533", "#2C1F2E", "#1F2E1F", "#2E1F1F",
  "#1A2E40", "#402E1A", "#2E4A1F", "#4A1F2E",
  "#0A0E2A", "#1F1F3E",
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA",
  "#D8E5D5", "#E5D5DE", "#D5E0D5", "#D8D5E0",
  "#2C1F5E", "#F5E6A8", "#E67E22",
];

// ── Layer 3: Eye overlays (LOCKED per personality) ──
type EyeStyle = "dot" | "wide" | "angry" | "sleepy" | "hearts" | "dollar" | "x_eyes" | "laser";

function pickEye(h: Buffer): EyeStyle {
  const v = h[8] % 100;
  if (v < 50) return "dot";       // default, matches base — no overlay
  if (v < 65) return "wide";
  if (v < 77) return "angry";
  if (v < 87) return "sleepy";
  if (v < 92) return "hearts";
  if (v < 96) return "dollar";
  if (v < 98) return "x_eyes";
  return "laser";                  // legendary
}

function eyesSVG(style: EyeStyle): string {
  if (style === "dot") return "";
  const black = "#1A1A1A", red = "#E63946", green = "#2EA040";
  const parts: string[] = [];
  const lx = LEFT_EYE_X, rx = RIGHT_EYE_X, y = EYE_Y;

  if (style === "wide") {
    // 2×2 black blocks (so eyes are double-height)
    parts.push(rect(lx - LP / 2, y, black, 1, 2));
    parts.push(rect(rx + LP / 2, y, black, 1, 2));
    parts.push(rect(lx + LP / 2, y, black, 1, 2));
    parts.push(rect(rx - LP / 2, y, black, 1, 2));
  } else if (style === "angry") {
    // Downward-inward slashes: \ for left eye, / for right
    parts.push(rect(lx - LP, y - LP, black));
    parts.push(rect(lx, y, black));
    parts.push(rect(rx + LP, y - LP, black));
    parts.push(rect(rx, y, black));
  } else if (style === "sleepy") {
    // Shifted down + wider horizontal bar
    parts.push(rect(lx - LP, y + LP, black, 2, 1));
    parts.push(rect(rx, y + LP, black, 2, 1));
  } else if (style === "hearts") {
    // 3×3 heart pixel pattern each eye
    const heart = (cx: number) => {
      parts.push(rect(cx - LP, y - LP, red));
      parts.push(rect(cx + LP, y - LP, red));
      parts.push(rect(cx - LP, y, red));
      parts.push(rect(cx, y, red));
      parts.push(rect(cx + LP, y, red));
      parts.push(rect(cx, y + LP, red));
    };
    heart(lx);
    heart(rx);
  } else if (style === "dollar") {
    // + pattern in green for $
    const dollar = (cx: number) => {
      parts.push(rect(cx, y - LP, green));
      parts.push(rect(cx - LP, y, green));
      parts.push(rect(cx, y, green));
      parts.push(rect(cx + LP, y, green));
      parts.push(rect(cx, y + LP, green));
    };
    dollar(lx);
    dollar(rx);
  } else if (style === "x_eyes") {
    const x = (cx: number) => {
      parts.push(rect(cx - LP, y - LP, black));
      parts.push(rect(cx + LP, y - LP, black));
      parts.push(rect(cx, y, black));
      parts.push(rect(cx - LP, y + LP, black));
      parts.push(rect(cx + LP, y + LP, black));
    };
    x(lx);
    x(rx);
  } else if (style === "laser") {
    // Red laser beam across the whole face + bright dots at eye positions
    parts.push(`<rect x="150" y="${y + LP / 3}" width="724" height="${LP}" fill="${red}"/>`);
    parts.push(`<rect x="100" y="${y + LP / 2}" width="824" height="8" fill="#FFFFFF" opacity="0.6"/>`);
  }

  return svgWrap(parts.join(""));
}

// ── Layer 4: Eyewear overlays (LOCKED) ──
type Eyewear = "none" | "sunglasses" | "glasses" | "3d_glasses" | "monocle" | "eyepatch" | "laser_visor";

function pickEyewear(h: Buffer): Eyewear {
  const v = h[9] % 100;
  if (v < 65) return "none";
  if (v < 77) return "sunglasses";
  if (v < 86) return "glasses";
  if (v < 91) return "3d_glasses";
  if (v < 95) return "monocle";
  if (v < 98) return "eyepatch";
  return "laser_visor";
}

function eyewearSVG(wear: Eyewear): string {
  if (wear === "none") return "";
  const dark = "#1A1A1A", gold = "#FFD700", goldDark = "#C89B0A";
  const red = "#E63946", cyan = "#2EC4B6";
  const parts: string[] = [];
  const lx = LEFT_EYE_X, rx = RIGHT_EYE_X, y = EYE_Y;

  if (wear === "sunglasses") {
    // Thick dark bar across both eyes with rounded edges
    parts.push(`<rect x="${lx - LP * 1.3}" y="${y - LP * 0.3}" width="${LP * 2.6}" height="${LP * 1.6}" rx="8" fill="${dark}"/>`);
    parts.push(`<rect x="${rx - LP * 1.3}" y="${y - LP * 0.3}" width="${LP * 2.6}" height="${LP * 1.6}" rx="8" fill="${dark}"/>`);
    // Bridge between
    parts.push(`<rect x="${lx + LP * 1.3}" y="${y + LP * 0.2}" width="${rx - lx - LP * 2.6}" height="${LP * 0.5}" fill="${dark}"/>`);
    // Lens highlights
    parts.push(`<rect x="${lx - LP * 0.9}" y="${y + LP * 0.0}" width="${LP * 0.6}" height="${LP * 0.3}" fill="#3A3A3A"/>`);
    parts.push(`<rect x="${rx - LP * 0.9}" y="${y + LP * 0.0}" width="${LP * 0.6}" height="${LP * 0.3}" fill="#3A3A3A"/>`);
  } else if (wear === "glasses") {
    // Two circular frames + bridge
    parts.push(`<circle cx="${lx + LP / 2}" cy="${y + LP / 2}" r="${LP * 1.2}" fill="none" stroke="${dark}" stroke-width="6"/>`);
    parts.push(`<circle cx="${rx + LP / 2}" cy="${y + LP / 2}" r="${LP * 1.2}" fill="none" stroke="${dark}" stroke-width="6"/>`);
    parts.push(`<rect x="${lx + LP * 1.7}" y="${y + LP / 2 - 3}" width="${rx - lx - LP * 1.4}" height="6" fill="${dark}"/>`);
  } else if (wear === "3d_glasses") {
    parts.push(`<rect x="${lx - LP}" y="${y}" width="${LP * 2}" height="${LP}" fill="${red}"/>`);
    parts.push(`<rect x="${rx - LP}" y="${y}" width="${LP * 2}" height="${LP}" fill="${cyan}"/>`);
    // Frames
    parts.push(`<rect x="${lx - LP * 1.2}" y="${y - 5}" width="${LP * 2.4}" height="${LP + 10}" fill="none" stroke="${dark}" stroke-width="4"/>`);
    parts.push(`<rect x="${rx - LP * 1.2}" y="${y - 5}" width="${LP * 2.4}" height="${LP + 10}" fill="none" stroke="${dark}" stroke-width="4"/>`);
    // Bridge
    parts.push(`<rect x="${lx + LP * 1.2}" y="${y + LP * 0.3}" width="${rx - lx - LP * 2.4}" height="6" fill="${dark}"/>`);
  } else if (wear === "monocle") {
    // Gold ring around right eye + chain
    parts.push(`<circle cx="${rx + LP / 2}" cy="${y + LP / 2}" r="${LP * 1.3}" fill="none" stroke="${gold}" stroke-width="7"/>`);
    parts.push(`<circle cx="${rx + LP / 2}" cy="${y + LP / 2}" r="${LP * 1.3}" fill="none" stroke="${goldDark}" stroke-width="3"/>`);
    // Chain
    parts.push(`<rect x="${rx + LP * 1.8}" y="${y + LP * 1.0}" width="4" height="${LP * 4}" fill="${gold}"/>`);
  } else if (wear === "eyepatch") {
    // Dark patch over left eye + strap
    parts.push(`<rect x="${lx - LP * 1.3}" y="${y - LP * 0.5}" width="${LP * 2.6}" height="${LP * 2}" rx="14" fill="${dark}"/>`);
    // Strap across
    parts.push(`<rect x="${lx - LP * 3}" y="${y - LP * 2}" width="${LP * 5}" height="${LP * 0.3}" fill="${dark}"/>`);
  } else if (wear === "laser_visor") {
    // Dark horizontal band with red glow line
    parts.push(`<rect x="150" y="${y - LP * 0.5}" width="724" height="${LP * 1.8}" fill="${dark}"/>`);
    parts.push(`<rect x="150" y="${y + LP * 0.4}" width="724" height="${LP * 0.4}" fill="${red}"/>`);
    parts.push(`<rect x="150" y="${y + LP * 0.55}" width="724" height="6" fill="#FFFFFF" opacity="0.7"/>`);
  }

  return svgWrap(parts.join(""));
}

// ── Layer 5: Hats (VARIES per regen) ──
type Hat = "none" | "baseball" | "beanie" | "cowboy" | "top_hat" | "crown" | "party" | "headphones" | "halo" | "devil_horns" | "chef";

function pickHat(h: Buffer): Hat {
  const v = h[10] % 100;
  if (v < 55) return "none";
  if (v < 65) return "baseball";
  if (v < 73) return "beanie";
  if (v < 80) return "cowboy";
  if (v < 85) return "top_hat";
  if (v < 90) return "party";
  if (v < 94) return "headphones";
  if (v < 97) return "crown";
  if (v < 98) return "chef";
  if (v < 99) return "halo";
  return "devil_horns";
}

function hatSVG(hat: Hat, h: Buffer): string {
  if (hat === "none") return "";
  const HAT_COLORS = ["#2C3E50", "#E74C3C", "#27AE60", "#F39C12", "#8E44AD", "#16A085", "#C0392B"];
  const hatColor = HAT_COLORS[h[11] % HAT_COLORS.length];
  const hatDark = darkenHex(hatColor, 0.35);
  const dark = "#1A1A1A", gold = "#FFD700", white = "#F5F5F5";
  const parts: string[] = [];
  const cx = HAT_CENTER_X;
  const by = HAT_BOTTOM_Y;

  if (hat === "baseball") {
    // Rounded cap + long brim
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 0.8}" rx="${LP * 3.2}" ry="${LP * 1.8}" fill="${hatColor}"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 1.1}" rx="${LP * 2.7}" ry="${LP * 0.5}" fill="${darkenHex(hatColor, 0.2)}"/>`);
    // Brim sweeps out one side
    parts.push(`<rect x="${cx - LP * 5}" y="${by - LP * 0.2}" width="${LP * 7}" height="${LP * 0.8}" rx="10" fill="${hatColor}"/>`);
    parts.push(`<rect x="${cx - LP * 5}" y="${by + LP * 0.3}" width="${LP * 7}" height="${LP * 0.4}" fill="${hatDark}"/>`);
  } else if (hat === "beanie") {
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 1.4}" rx="${LP * 3.5}" ry="${LP * 2.2}" fill="${hatColor}"/>`);
    parts.push(`<rect x="${cx - LP * 3.5}" y="${by - LP * 0.2}" width="${LP * 7}" height="${LP * 0.7}" fill="${hatDark}"/>`);
    // Pom-pom on top
    parts.push(`<circle cx="${cx}" cy="${by - LP * 3.5}" r="${LP * 0.5}" fill="${white}"/>`);
    parts.push(`<circle cx="${cx - LP * 0.1}" cy="${by - LP * 3.6}" r="${LP * 0.2}" fill="${darkenHex(white, 0.15)}"/>`);
  } else if (hat === "cowboy") {
    // Wide brim + dome
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 0.8}" rx="${LP * 2.5}" ry="${LP * 1.5}" fill="${hatColor}"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${by}" rx="${LP * 6}" ry="${LP * 0.8}" fill="${hatColor}"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${by + LP * 0.3}" rx="${LP * 6}" ry="${LP * 0.3}" fill="${hatDark}"/>`);
    // Band
    parts.push(`<rect x="${cx - LP * 2.5}" y="${by - LP * 0.8}" width="${LP * 5}" height="${LP * 0.4}" fill="${hatDark}"/>`);
  } else if (hat === "top_hat") {
    // Tall cylinder + brim
    parts.push(`<rect x="${cx - LP * 2}" y="${by - LP * 4}" width="${LP * 4}" height="${LP * 3.5}" fill="${dark}"/>`);
    parts.push(`<rect x="${cx - LP * 2}" y="${by - LP * 2}" width="${LP * 4}" height="${LP * 0.5}" fill="${hatColor}"/>`);
    parts.push(`<rect x="${cx - LP * 3.5}" y="${by - LP * 0.5}" width="${LP * 7}" height="${LP * 0.8}" fill="${dark}"/>`);
  } else if (hat === "crown") {
    // Gold crown with spikes
    for (const sx of [-3, -1.5, 0, 1.5, 3]) {
      parts.push(`<polygon points="${cx + sx * LP},${by - LP * 2.5} ${cx + (sx - 0.4) * LP},${by - LP * 1} ${cx + (sx + 0.4) * LP},${by - LP * 1}" fill="${gold}"/>`);
    }
    parts.push(`<rect x="${cx - LP * 4}" y="${by - LP * 1.2}" width="${LP * 8}" height="${LP * 1.3}" fill="${gold}"/>`);
    parts.push(`<rect x="${cx - LP * 4}" y="${by - LP * 0.1}" width="${LP * 8}" height="${LP * 0.3}" fill="${goldDarken()}"/>`);
    // Gems
    parts.push(`<circle cx="${cx - LP * 2}" cy="${by - LP * 0.5}" r="${LP * 0.3}" fill="#E63946"/>`);
    parts.push(`<circle cx="${cx}" cy="${by - LP * 0.5}" r="${LP * 0.3}" fill="#3B82F6"/>`);
    parts.push(`<circle cx="${cx + LP * 2}" cy="${by - LP * 0.5}" r="${LP * 0.3}" fill="#27AE60"/>`);
  } else if (hat === "party") {
    // Cone with stripes
    parts.push(`<polygon points="${cx},${by - LP * 4} ${cx - LP * 2},${by - LP * 0.3} ${cx + LP * 2},${by - LP * 0.3}" fill="${hatColor}"/>`);
    parts.push(`<rect x="${cx - LP * 2.5}" y="${by - LP * 0.3}" width="${LP * 5}" height="${LP * 0.5}" fill="${hatDark}"/>`);
    parts.push(`<circle cx="${cx}" cy="${by - LP * 4.1}" r="${LP * 0.35}" fill="${white}"/>`);
    // Stripe
    parts.push(`<polygon points="${cx - LP * 0.6},${by - LP * 3} ${cx + LP * 0.6},${by - LP * 3} ${cx + LP * 0.8},${by - LP * 2.3} ${cx - LP * 0.8},${by - LP * 2.3}" fill="${white}"/>`);
  } else if (hat === "headphones") {
    // Band arc over head + ear cups on sides
    parts.push(`<path d="M ${cx - LP * 4} ${by - LP * 0.5} Q ${cx} ${by - LP * 3.5} ${cx + LP * 4} ${by - LP * 0.5}" fill="none" stroke="${dark}" stroke-width="14"/>`);
    // Ear cups
    parts.push(`<circle cx="${cx - LP * 4}" cy="${by - LP * 0.3}" r="${LP * 0.9}" fill="${dark}"/>`);
    parts.push(`<circle cx="${cx + LP * 4}" cy="${by - LP * 0.3}" r="${LP * 0.9}" fill="${dark}"/>`);
    parts.push(`<circle cx="${cx - LP * 4}" cy="${by - LP * 0.3}" r="${LP * 0.5}" fill="${hatColor}"/>`);
    parts.push(`<circle cx="${cx + LP * 4}" cy="${by - LP * 0.3}" r="${LP * 0.5}" fill="${hatColor}"/>`);
  } else if (hat === "halo") {
    // Gold ring floating above
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 5}" rx="${LP * 2.5}" ry="${LP * 0.5}" fill="none" stroke="${gold}" stroke-width="10"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 5}" rx="${LP * 2.5}" ry="${LP * 0.5}" fill="none" stroke="#FFF8DC" stroke-width="4" opacity="0.7"/>`);
  } else if (hat === "devil_horns") {
    const horn = "#8B0000";
    const hornLight = "#C94A3F";
    // Two curved horns
    parts.push(`<path d="M ${cx - LP * 2.2} ${by - LP * 0.8} Q ${cx - LP * 2.8} ${by - LP * 3.5} ${cx - LP * 1.6} ${by - LP * 3.8}" fill="${horn}" stroke="${hornLight}" stroke-width="8"/>`);
    parts.push(`<path d="M ${cx + LP * 2.2} ${by - LP * 0.8} Q ${cx + LP * 2.8} ${by - LP * 3.5} ${cx + LP * 1.6} ${by - LP * 3.8}" fill="${horn}" stroke="${hornLight}" stroke-width="8"/>`);
  } else if (hat === "chef") {
    // Puffy white chef hat
    parts.push(`<ellipse cx="${cx - LP * 1.2}" cy="${by - LP * 2.5}" rx="${LP * 1.5}" ry="${LP * 1.5}" fill="${white}"/>`);
    parts.push(`<ellipse cx="${cx + LP * 1.2}" cy="${by - LP * 2.5}" rx="${LP * 1.5}" ry="${LP * 1.5}" fill="${white}"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 3.2}" rx="${LP * 1.5}" ry="${LP * 1.3}" fill="${white}"/>`);
    parts.push(`<rect x="${cx - LP * 2.5}" y="${by - LP * 1.5}" width="${LP * 5}" height="${LP * 1.5}" rx="8" fill="${white}"/>`);
    parts.push(`<rect x="${cx - LP * 2.5}" y="${by - LP * 0.4}" width="${LP * 5}" height="${LP * 0.4}" fill="#DDDDDD"/>`);
  }

  return svgWrap(parts.join(""));
}

function goldDarken(): string {
  return "#C89B0A";
}

// ── Layer 6: Held items (VARIES per regen) ──
type HeldItem = "none" | "coin" | "money_bag" | "laptop" | "coffee" | "diamond" | "sword" | "star" | "briefcase" | "trophy";

function pickItem(h: Buffer): HeldItem {
  const v = h[7] % 100;
  if (v < 65) return "none";
  if (v < 73) return "coin";
  if (v < 79) return "money_bag";
  if (v < 84) return "coffee";
  if (v < 88) return "laptop";
  if (v < 92) return "briefcase";
  if (v < 95) return "star";
  if (v < 97) return "trophy";
  if (v < 99) return "sword";
  return "diamond";
}

function itemSVG(item: HeldItem): string {
  if (item === "none") return "";
  const parts: string[] = [];
  const cx = ITEM_CENTER_X;
  const by = ITEM_BOTTOM_Y;

  if (item === "coin") {
    const gold = "#FFD700", goldDark = "#C89B0A";
    parts.push(`<circle cx="${cx}" cy="${by - LP * 1.5}" r="${LP * 1.4}" fill="${gold}"/>`);
    parts.push(`<circle cx="${cx}" cy="${by - LP * 1.5}" r="${LP * 1.4}" fill="none" stroke="${goldDark}" stroke-width="6"/>`);
    parts.push(`<text x="${cx}" y="${by - LP * 0.9}" font-family="Arial, sans-serif" font-size="${LP * 1.5}" font-weight="bold" fill="${goldDark}" text-anchor="middle">$</text>`);
  } else if (item === "money_bag") {
    const bag = "#8B4513", bagDark = "#5C2C0A", dollar = "#2EA040";
    parts.push(`<ellipse cx="${cx}" cy="${by - LP * 1.5}" rx="${LP * 1.8}" ry="${LP * 2}" fill="${bag}"/>`);
    parts.push(`<rect x="${cx - LP * 0.8}" y="${by - LP * 3.3}" width="${LP * 1.6}" height="${LP * 0.4}" fill="${bagDark}"/>`);
    parts.push(`<text x="${cx}" y="${by - LP * 0.9}" font-family="Arial" font-size="${LP * 1.3}" font-weight="bold" fill="${dollar}" text-anchor="middle">$</text>`);
  } else if (item === "coffee") {
    const mug = "#6B3410", mugDark = "#3A1E08", steam = "#E8E8E8";
    parts.push(`<rect x="${cx - LP * 1.2}" y="${by - LP * 2}" width="${LP * 2.4}" height="${LP * 2}" rx="6" fill="${mug}"/>`);
    parts.push(`<rect x="${cx - LP * 1.2}" y="${by - LP * 2}" width="${LP * 2.4}" height="${LP * 0.4}" fill="${mugDark}"/>`);
    parts.push(`<path d="M ${cx + LP * 1.2} ${by - LP * 1.5} Q ${cx + LP * 2} ${by - LP * 1} ${cx + LP * 1.2} ${by - LP * 0.5}" stroke="${mug}" stroke-width="10" fill="none"/>`);
    // Steam
    parts.push(`<path d="M ${cx - LP * 0.3} ${by - LP * 3} Q ${cx} ${by - LP * 3.5} ${cx + LP * 0.3} ${by - LP * 3}" stroke="${steam}" stroke-width="6" fill="none"/>`);
    parts.push(`<path d="M ${cx + LP * 0.3} ${by - LP * 3.5} Q ${cx + LP * 0.6} ${by - LP * 4} ${cx + LP * 0.9} ${by - LP * 3.5}" stroke="${steam}" stroke-width="6" fill="none"/>`);
  } else if (item === "laptop") {
    const frame = "#2A2A2A", screen = "#4AC8FF", base = "#1A1A1A";
    parts.push(`<rect x="${cx - LP * 1.8}" y="${by - LP * 3}" width="${LP * 3.6}" height="${LP * 2.4}" rx="6" fill="${frame}"/>`);
    parts.push(`<rect x="${cx - LP * 1.5}" y="${by - LP * 2.7}" width="${LP * 3}" height="${LP * 1.8}" fill="${screen}"/>`);
    parts.push(`<rect x="${cx - LP * 1.3}" y="${by - LP * 2.4}" width="${LP * 1}" height="${LP * 0.3}" fill="#FFFFFF" opacity="0.6"/>`);
    parts.push(`<rect x="${cx - LP * 2}" y="${by - LP * 0.6}" width="${LP * 4}" height="${LP * 0.6}" rx="4" fill="${base}"/>`);
  } else if (item === "briefcase") {
    const leather = "#3A1E08", strap = "#1A0A00", lock = "#FFD700";
    parts.push(`<rect x="${cx - LP * 0.3}" y="${by - LP * 3.2}" width="${LP * 0.6}" height="${LP * 0.4}" fill="${strap}"/>`);
    parts.push(`<rect x="${cx - LP * 1.5}" y="${by - LP * 2.7}" width="${LP * 3}" height="${LP * 2.5}" rx="8" fill="${leather}"/>`);
    parts.push(`<rect x="${cx - LP * 1.5}" y="${by - LP * 1.6}" width="${LP * 3}" height="${LP * 0.2}" fill="${strap}"/>`);
    parts.push(`<rect x="${cx - LP * 0.3}" y="${by - LP * 1.8}" width="${LP * 0.6}" height="${LP * 0.6}" fill="${lock}"/>`);
  } else if (item === "star") {
    const gold = "#FFD700", goldDark = "#C89B0A";
    // 5-point star
    const sp = (a: number, r: number) => {
      const rad = (a - 90) * Math.PI / 180;
      return `${cx + Math.cos(rad) * r},${by - LP * 1.5 + Math.sin(rad) * r}`;
    };
    const points: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = i * 36;
      const r = i % 2 === 0 ? LP * 1.8 : LP * 0.8;
      points.push(sp(a, r));
    }
    parts.push(`<polygon points="${points.join(" ")}" fill="${gold}" stroke="${goldDark}" stroke-width="4"/>`);
  } else if (item === "trophy") {
    const gold = "#FFD700", goldDark = "#C89B0A";
    parts.push(`<path d="M ${cx - LP * 1.3} ${by - LP * 3.2} L ${cx + LP * 1.3} ${by - LP * 3.2} L ${cx + LP * 1} ${by - LP * 1.6} L ${cx - LP * 1} ${by - LP * 1.6} Z" fill="${gold}"/>`);
    parts.push(`<path d="M ${cx - LP * 1.8} ${by - LP * 3.2} Q ${cx - LP * 2.5} ${by - LP * 2.5} ${cx - LP * 1.3} ${by - LP * 2.3}" stroke="${gold}" stroke-width="8" fill="none"/>`);
    parts.push(`<path d="M ${cx + LP * 1.8} ${by - LP * 3.2} Q ${cx + LP * 2.5} ${by - LP * 2.5} ${cx + LP * 1.3} ${by - LP * 2.3}" stroke="${gold}" stroke-width="8" fill="none"/>`);
    parts.push(`<rect x="${cx - LP * 0.3}" y="${by - LP * 1.6}" width="${LP * 0.6}" height="${LP * 0.6}" fill="${goldDark}"/>`);
    parts.push(`<rect x="${cx - LP * 1.2}" y="${by - LP * 1}" width="${LP * 2.4}" height="${LP * 0.5}" fill="${gold}"/>`);
  } else if (item === "sword") {
    const blade = "#D0D0E0", edge = "#FFFFFF", hilt = "#8B4513", grip = "#3A1E08";
    // Long blade
    parts.push(`<rect x="${cx - LP * 0.2}" y="${by - LP * 4.5}" width="${LP * 0.4}" height="${LP * 3.5}" fill="${blade}"/>`);
    parts.push(`<polygon points="${cx},${by - LP * 4.8} ${cx - LP * 0.2},${by - LP * 4.5} ${cx + LP * 0.2},${by - LP * 4.5}" fill="${edge}"/>`);
    parts.push(`<rect x="${cx - LP * 0.1}" y="${by - LP * 4.5}" width="${LP * 0.1}" height="${LP * 3.5}" fill="${edge}"/>`);
    // Crossguard
    parts.push(`<rect x="${cx - LP * 1.2}" y="${by - LP * 1.2}" width="${LP * 2.4}" height="${LP * 0.35}" fill="${hilt}"/>`);
    // Grip
    parts.push(`<rect x="${cx - LP * 0.25}" y="${by - LP * 0.85}" width="${LP * 0.5}" height="${LP * 0.8}" fill="${grip}"/>`);
  } else if (item === "diamond") {
    const dia = "#7FE6FF", shine = "#FFFFFF", deep = "#3088B3";
    // Diamond rhombus shape
    parts.push(`<polygon points="${cx},${by - LP * 3} ${cx + LP * 1.5},${by - LP * 2} ${cx},${by - LP * 0.5} ${cx - LP * 1.5},${by - LP * 2}" fill="${dia}"/>`);
    parts.push(`<polygon points="${cx},${by - LP * 3} ${cx + LP * 1.5},${by - LP * 2} ${cx + LP * 0.8},${by - LP * 2.3} ${cx - LP * 0.5},${by - LP * 2.7}" fill="${shine}"/>`);
    parts.push(`<polygon points="${cx - LP * 1.5},${by - LP * 2} ${cx},${by - LP * 0.5} ${cx + LP * 1.5},${by - LP * 2}" stroke="${deep}" stroke-width="3" fill="none"/>`);
  }

  return svgWrap(parts.join(""));
}

// ── Layer 7: Mouth accessories (VARIES per regen) ──
type Mouth = "none" | "cigarette" | "pipe" | "gold_tooth" | "tongue";

function pickMouth(h: Buffer): Mouth {
  const v = h[12] % 100;
  if (v < 75) return "none";
  if (v < 85) return "cigarette";
  if (v < 92) return "pipe";
  if (v < 97) return "gold_tooth";
  return "tongue";
}

function mouthSVG(mouth: Mouth): string {
  if (mouth === "none") return "";
  const parts: string[] = [];
  const cx = MOUTH_CENTER_X;
  const y = MOUTH_Y;

  if (mouth === "cigarette") {
    const white = "#F5F5F5", red = "#E63946", smoke = "#BFBFBF";
    parts.push(`<rect x="${cx + LP * 0.3}" y="${y + LP * 0.2}" width="${LP * 3}" height="${LP * 0.4}" rx="2" fill="${white}"/>`);
    parts.push(`<rect x="${cx + LP * 3.3}" y="${y + LP * 0.2}" width="${LP * 0.3}" height="${LP * 0.4}" fill="${red}"/>`);
    // Smoke wisps
    parts.push(`<circle cx="${cx + LP * 3.8}" cy="${y - LP * 0.3}" r="${LP * 0.2}" fill="${smoke}" opacity="0.6"/>`);
    parts.push(`<circle cx="${cx + LP * 4.3}" cy="${y - LP * 0.8}" r="${LP * 0.25}" fill="${smoke}" opacity="0.5"/>`);
  } else if (mouth === "pipe") {
    const brown = "#5C2C0A", ember = "#FF9800";
    parts.push(`<rect x="${cx + LP * 0.3}" y="${y + LP * 0.2}" width="${LP * 2.2}" height="${LP * 0.5}" rx="4" fill="${brown}"/>`);
    // Bowl
    parts.push(`<rect x="${cx + LP * 2.2}" y="${y - LP * 0.3}" width="${LP * 0.8}" height="${LP * 1}" rx="4" fill="${brown}"/>`);
    parts.push(`<rect x="${cx + LP * 2.3}" y="${y - LP * 0.4}" width="${LP * 0.6}" height="${LP * 0.2}" fill="${ember}"/>`);
  } else if (mouth === "gold_tooth") {
    parts.push(`<rect x="${cx - LP * 0.25}" y="${y}" width="${LP * 0.5}" height="${LP * 0.6}" fill="#FFD700"/>`);
    parts.push(`<rect x="${cx - LP * 0.25}" y="${y}" width="${LP * 0.15}" height="${LP * 0.6}" fill="#FFFFFF" opacity="0.5"/>`);
  } else if (mouth === "tongue") {
    const pink = "#FF69B4";
    parts.push(`<ellipse cx="${cx}" cy="${y + LP * 0.8}" rx="${LP * 0.6}" ry="${LP * 0.7}" fill="${pink}"/>`);
  }

  return svgWrap(parts.join(""));
}

// ── Orb background SVG ──
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
export async function buildCrabImage(
  personalityHash: Buffer,
  variationHash: Buffer,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  // LOCKED per personality
  const hueShift = HUE_SHIFTS[personalityHash[0] % HUE_SHIFTS.length];
  const eye = pickEye(personalityHash);
  const eyewear = pickEyewear(personalityHash);

  // VARIES per regen
  const bgHex = BG_COLORS[variationHash[0] % BG_COLORS.length];
  const bgDark = darkenHex(bgHex, 0.3);
  const hat = pickHat(variationHash);
  const item = pickItem(variationHash);
  const mouth = pickMouth(variationHash);

  // Step 1: hue-tinted base — force 1024×1024 throughout
  const base = loadBaseBuffer();
  const tintedRgb = await sharp(base)
    .flatten({ background: "#000000" })
    .modulate({ hue: hueShift })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "fill", kernel: "nearest" })
    .raw()
    .toBuffer();

  const alphaMask = await sharp(tintedRgb, { raw: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 3 } })
    .greyscale()
    .threshold(25)
    .raw()
    .toBuffer();

  const crabWithAlpha = await sharp(tintedRgb, { raw: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 3 } })
    .joinChannel(alphaMask, { raw: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 1 } })
    .png()
    .toBuffer();

  // Helper to rasterize SVG at the exact output size
  const rasterize = async (svg: string) =>
    sharp(Buffer.from(svg)).resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "fill" }).png().toBuffer();

  // Step 2: rasterize each overlay SVG at exact output size
  const eyesPng = eye === "dot" ? null : await rasterize(eyesSVG(eye));
  const eyewearPng = eyewear === "none" ? null : await rasterize(eyewearSVG(eyewear));
  const hatPng = hat === "none" ? null : await rasterize(hatSVG(hat, variationHash));
  const itemPng = item === "none" ? null : await rasterize(itemSVG(item));
  const mouthPng = mouth === "none" ? null : await rasterize(mouthSVG(mouth));

  // Step 3: orb bg + overlay
  const orbBg = await rasterize(orbBackgroundSVG(bgHex, bgDark, OUTPUT_SIZE));
  const orbOverlay = await rasterize(orbHighlightSVG(OUTPUT_SIZE));

  // Step 4: composite layers sequentially (avoids multi-composite dimension bug)
  // Order: orb bg → crab → eyes → eyewear → hat → item → mouth → orb glass overlay
  const layers: Buffer[] = [crabWithAlpha];
  if (eyesPng) layers.push(eyesPng);
  if (eyewearPng) layers.push(eyewearPng);
  if (hatPng) layers.push(hatPng);
  if (itemPng) layers.push(itemPng);
  if (mouthPng) layers.push(mouthPng);
  layers.push(orbOverlay);

  let stacked = orbBg;
  for (const layer of layers) {
    stacked = await sharp(stacked).composite([{ input: layer, top: 0, left: 0 }]).png().toBuffer();
  }

  const final = await sharp(stacked)
    .resize(512, 512, { kernel: "nearest" })
    .png()
    .toBuffer();

  return final;
}

// ── Hash helpers ──
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

// ── Legacy API stubs ──
export type Grid = (string | null)[][];
export const GRID_SIZE = 28;
export interface Palette { bg: string; }
export function buildFaceGrid(_p: Buffer, _v: Buffer): Grid { return []; }
export function hashToPalette(_p: Buffer, v: Buffer): Palette {
  return { bg: BG_COLORS[v[0] % BG_COLORS.length] };
}
export function renderFaceSVG(_g: Grid, _p: Palette): string { return ""; }
