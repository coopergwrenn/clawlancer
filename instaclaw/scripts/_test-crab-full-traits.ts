/**
 * Full crab trait generator — all 9 layers.
 * Generates 30+ crab variations to verify the complete trait system.
 *
 * Run: npx tsx scripts/_test-crab-full-traits.ts
 * Output: /tmp/crab-full-traits.png
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";

const GRID_SIZE = 24;

// ── v7 canonical base silhouette ──
const CRAB_BASE: string[] = [
  "........................",
  "........................",
  "........................",
  "...#######....#######...",
  "..########....########..",
  "..###..............###..",
  "..###..............###..",
  "..###..............###..",
  "..########....########..",
  "..########....########..",
  "..###..............###..",
  "..###..............###..",
  "...##################...",
  "..####################..",
  ".######################.",
  ".######################.",
  ".######################.",
  ".######################.",
  "..####################..",
  "...##################...",
  "##.####.########.####.##",
  "........................",
  "........................",
  "........................",
];

// ── Canvas ──
type Canvas = (string | null)[][];

function newCanvas(): Canvas {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
}

function setPx(c: Canvas, x: number, y: number, color: string): void {
  if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
    c[y][x] = color;
  }
}

function darken(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mult = Math.max(0, 1 - factor);
  return "#" + [r, g, b].map((v) => Math.round(v * mult).toString(16).padStart(2, "0")).join("");
}

function lighten(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return "#" + [r, g, b].map((v) => {
    const lifted = Math.min(255, Math.round(v + (255 - v) * factor));
    return lifted.toString(16).padStart(2, "0");
  }).join("");
}

// ── Claw + body region helpers ──
function isClawPixel(c: number, r: number): boolean {
  return r >= 3 && r <= 11 && CRAB_BASE[r][c] === "#";
}
function isBodyPixel(c: number, r: number): boolean {
  return r >= 12 && r <= 19 && CRAB_BASE[r][c] === "#";
}
function isLegPixel(c: number, r: number): boolean {
  return r === 20 && CRAB_BASE[r][c] === "#";
}

// ── Layer 1: Shell colors (20 slots, rarity via palette position) ──
const SHELL_COLORS = [
  // Common natural (12) — position 0-11
  "#C94A3F", "#8B2E23", "#E67E22", "#DC143C", "#FF6F61",
  "#A0522D", "#B22222", "#CD5C5C", "#F08080", "#FA8072",
  "#D2691E", "#CD853F",
  // Uncommon fantasy (5) — position 12-16
  "#3B82F6", "#06A77D", "#9D4EDD", "#FF69B4", "#20C997",
  // Rare metallic (3) — position 17-19
  "#FFD700", "#C0C0C0", "#1A1A1A",
];

// ── Layer 2: Body patterns ──
type Pattern = "solid" | "stripes" | "spots" | "camo" | "galaxy";

function pickPattern(h: Buffer): Pattern {
  const v = h[4] % 100;
  if (v < 70) return "solid";
  if (v < 82) return "stripes";
  if (v < 90) return "spots";
  if (v < 95) return "camo";
  return "galaxy";
}

function applyPattern(canvas: Canvas, pattern: Pattern, shell: string, h: Buffer): void {
  if (pattern === "solid") return;
  const patternColor = darken(shell, 0.35);
  if (pattern === "stripes") {
    for (const r of [13, 15, 17]) {
      for (let c = 0; c < GRID_SIZE; c++) if (isBodyPixel(c, r)) setPx(canvas, c, r, patternColor);
    }
  } else if (pattern === "spots") {
    const numSpots = 6 + (h[5] % 3);
    for (let i = 0; i < numSpots; i++) {
      const r = 12 + (h[(10 + i) % 32] % 8);
      const c = 2 + (h[(18 + i) % 32] % 20);
      if (isBodyPixel(c, r)) setPx(canvas, c, r, patternColor);
    }
  } else if (pattern === "camo") {
    const patches: Array<[number, number]> = [[3, 13], [10, 14], [17, 15], [6, 17], [14, 18]];
    for (const [sc, sr] of patches) {
      for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
        const c = sc + dc, r = sr + dr;
        if (isBodyPixel(c, r)) setPx(canvas, c, r, patternColor);
      }
    }
  } else if (pattern === "galaxy") {
    for (let r = 12; r <= 19; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isBodyPixel(c, r) && (r + c) % 2 === 0) setPx(canvas, c, r, patternColor);
    }
  }
}

// ── Layer 3: Claw variants ──
type ClawVariant = "default" | "gold_tipped" | "full_gold" | "full_diamond" | "asymmetric";

function pickClaw(h: Buffer): ClawVariant {
  const v = h[6] % 100;
  if (v < 60) return "default";
  if (v < 80) return "gold_tipped";
  if (v < 88) return "full_gold";
  if (v < 91) return "full_diamond";
  return "asymmetric";
}

function applyClaw(canvas: Canvas, variant: ClawVariant, shell: string): void {
  if (variant === "default") return;
  let clawColor: string;
  let tipColor: string;
  if (variant === "gold_tipped") {
    // Only the upper jaw rows (3-4) get gold
    tipColor = "#FFD700";
    for (let r = 3; r <= 4; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(canvas, c, r, tipColor);
    }
  } else if (variant === "full_gold") {
    clawColor = "#FFD700";
    for (let r = 3; r <= 11; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(canvas, c, r, clawColor);
    }
  } else if (variant === "full_diamond") {
    clawColor = "#CFF5FF";
    for (let r = 3; r <= 11; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(canvas, c, r, clawColor);
    }
    // Sparkle: a few lighter pixels
    setPx(canvas, 3, 4, "#FFFFFF");
    setPx(canvas, 20, 4, "#FFFFFF");
    setPx(canvas, 4, 8, "#FFFFFF");
    setPx(canvas, 19, 8, "#FFFFFF");
  } else if (variant === "asymmetric") {
    // LEFT claw gets OVERSIZED — extend its upper jaw wider, make it more massive.
    // RIGHT claw gets REDUCED — shrink its upper jaw to a smaller pincer.
    // This mirrors a fiddler-crab look — one dominant claw.
    const bigColor = darken(shell, 0.15);

    // LEFT claw — add bulk: extend rows 3-4 outward (col 1) and thicken
    setPx(canvas, 1, 3, bigColor); setPx(canvas, 1, 4, bigColor);
    setPx(canvas, 1, 5, bigColor); setPx(canvas, 1, 6, bigColor);
    // Upper jaw bulked on top
    setPx(canvas, 3, 2, bigColor); setPx(canvas, 4, 2, bigColor);
    setPx(canvas, 5, 2, bigColor); setPx(canvas, 6, 2, bigColor);
    setPx(canvas, 7, 2, bigColor); setPx(canvas, 8, 2, bigColor);
    setPx(canvas, 9, 2, bigColor);

    // RIGHT claw — erase outer row to shrink it
    // Erase col 20 (outer edge) for rows 3-9 to make the right claw smaller
    const bg = null;
    canvas[3][20] = bg; canvas[4][20] = bg;
    canvas[8][20] = bg; canvas[9][20] = bg;
    // Also erase the outermost upper jaw pixel
    canvas[3][19] = bg; canvas[4][19] = bg;
  }
}

// ── Layer 4: Held items (drawn in between claws, rows 5-7) ──
type HeldItem =
  | "none" | "coffee" | "money_bag" | "laptop" | "phone"
  | "sword" | "trophy" | "briefcase" | "pizza" | "diamond";

function pickItem(h: Buffer): HeldItem {
  const v = h[7] % 100;
  if (v < 60) return "none";
  if (v < 68) return "coffee";
  if (v < 74) return "money_bag";
  if (v < 80) return "laptop";
  if (v < 85) return "phone";
  if (v < 89) return "sword";
  if (v < 93) return "trophy";
  if (v < 96) return "briefcase";
  if (v < 98) return "pizza";
  return "diamond";
}

// Items drawn in the center between claws, 8 wide × 4 tall (cols 8-15, rows 4-7).
// Bigger, more recognizable, high contrast against the orb background.
function applyHeldItem(canvas: Canvas, item: HeldItem): void {
  if (item === "none") return;
  const box = (c1: number, c2: number, r1: number, r2: number, color: string) => {
    for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) setPx(canvas, c, r, color);
  };

  if (item === "coffee") {
    // Brown mug, steam on top, visible handle
    const cup = "#5A2E10";
    const rim = "#8B5A30";
    const handle = "#3A1E08";
    box(9, 13, 5, 7, cup);
    box(9, 13, 4, 4, rim); // lighter rim
    // Handle on right
    setPx(canvas, 14, 5, handle);
    setPx(canvas, 14, 6, handle);
    // Steam wisps
    setPx(canvas, 10, 3, "#F5F5F5");
    setPx(canvas, 12, 3, "#F5F5F5");
  } else if (item === "money_bag") {
    const bag = "#5A3E12";
    const tie = "#3A2608";
    const dollar = "#2EA040";
    // Bag body (rounded)
    setPx(canvas, 10, 4, tie); setPx(canvas, 11, 4, tie); setPx(canvas, 12, 4, tie);
    box(9, 14, 5, 7, bag);
    // Dollar sign centered
    setPx(canvas, 11, 5, dollar); setPx(canvas, 12, 5, dollar);
    setPx(canvas, 11, 6, dollar); setPx(canvas, 12, 6, dollar);
    setPx(canvas, 11, 7, dollar); setPx(canvas, 12, 7, dollar);
  } else if (item === "laptop") {
    const casing = "#2A2A2A";
    const screen = "#4AC8FF";
    const app = "#FFFFFF";
    // Screen bezel
    box(8, 15, 3, 3, casing);
    // Screen glow
    box(9, 14, 4, 5, screen);
    // App icon on screen
    setPx(canvas, 11, 4, app); setPx(canvas, 12, 4, app);
    // Base (keyboard)
    box(8, 15, 6, 6, casing);
    box(9, 14, 7, 7, "#404040");
  } else if (item === "phone") {
    const casing = "#1A1A1A";
    const screen = "#4AC8FF";
    // Vertical phone
    box(10, 13, 3, 7, casing);
    // Screen
    box(11, 12, 4, 6, screen);
    // Speaker slot
    setPx(canvas, 11, 3, casing); setPx(canvas, 12, 3, casing);
    // Home button
    setPx(canvas, 11, 7, "#404040");
  } else if (item === "sword") {
    const blade = "#D0D0E0";
    const edge = "#FFFFFF";
    const hilt = "#8B4513";
    const grip = "#3A1E08";
    // Blade — thin, going up
    setPx(canvas, 11, 0, edge); // tip
    box(11, 12, 1, 5, blade);
    setPx(canvas, 11, 1, edge); // highlight along blade
    // Crossguard (wide horizontal)
    box(9, 14, 6, 6, hilt);
    // Grip
    box(11, 12, 7, 7, grip);
  } else if (item === "trophy") {
    const gold = "#FFD700";
    const deep = "#C89B0A";
    // Cup mouth wide
    box(9, 14, 3, 3, gold);
    box(10, 13, 4, 5, gold);
    // Handles (ear-like)
    setPx(canvas, 8, 4, gold); setPx(canvas, 15, 4, gold);
    // Stem
    setPx(canvas, 11, 6, deep); setPx(canvas, 12, 6, deep);
    // Base
    box(10, 13, 7, 7, gold);
  } else if (item === "briefcase") {
    const leather = "#3A1E08";
    const strap = "#1A0A00";
    const lock = "#FFD700";
    // Handle
    setPx(canvas, 11, 3, strap); setPx(canvas, 12, 3, strap);
    setPx(canvas, 10, 3, strap); setPx(canvas, 13, 3, strap);
    // Case
    box(9, 14, 4, 7, leather);
    // Seam
    for (let c = 9; c <= 14; c++) setPx(canvas, c, 5, "#2A1404");
    // Gold lock
    setPx(canvas, 11, 6, lock); setPx(canvas, 12, 6, lock);
  } else if (item === "pizza") {
    const crust = "#C08040";
    const cheese = "#F4D04D";
    const pepperoni = "#C94A3F";
    // Triangular slice (tip up)
    setPx(canvas, 11, 3, cheese); setPx(canvas, 12, 3, cheese);
    box(10, 13, 4, 5, cheese);
    box(9, 14, 6, 6, cheese);
    // Pepperoni dots
    setPx(canvas, 10, 5, pepperoni); setPx(canvas, 13, 5, pepperoni); setPx(canvas, 11, 6, pepperoni);
    // Crust
    box(9, 14, 7, 7, crust);
  } else if (item === "diamond") {
    const dia = "#7FE6FF";
    const shine = "#FFFFFF";
    const deep = "#3088B3";
    // Rhombus shape
    setPx(canvas, 11, 3, dia); setPx(canvas, 12, 3, dia);
    setPx(canvas, 10, 4, dia); setPx(canvas, 11, 4, shine); setPx(canvas, 12, 4, shine); setPx(canvas, 13, 4, dia);
    for (let c = 9; c <= 14; c++) setPx(canvas, c, 5, dia);
    box(10, 13, 6, 6, dia);
    setPx(canvas, 11, 7, deep); setPx(canvas, 12, 7, deep);
    // Sparkle
    setPx(canvas, 10, 5, shine);
  }
}

// ── Layer 5: Eyes ──
// Eye zone: rows 13-15, left cols 7-9, right cols 14-16
type EyeStyle = "dot" | "wide" | "angry" | "sleepy" | "hearts" | "dollar" | "x_eyes" | "laser";

function pickEye(h: Buffer): EyeStyle {
  const v = h[8] % 100;
  if (v < 40) return "dot";
  if (v < 65) return "wide";
  if (v < 78) return "angry";
  if (v < 88) return "sleepy";
  if (v < 92) return "hearts";
  if (v < 95) return "dollar";
  if (v < 98) return "x_eyes";
  return "laser";
}

function applyEyes(canvas: Canvas, style: EyeStyle): void {
  const black = "#1A1A1A";
  const red = "#E63946";
  const pink = "#FF69B4";
  const green = "#2EA040";

  const lx = 8, rx = 15; // left-eye-col, right-eye-col (center of each)
  const er = 14; // eye row

  if (style === "dot") {
    setPx(canvas, lx, er, black);
    setPx(canvas, rx, er, black);
  } else if (style === "wide") {
    setPx(canvas, lx - 1, er - 1, black); setPx(canvas, lx, er - 1, black);
    setPx(canvas, lx - 1, er, black); setPx(canvas, lx, er, black);
    setPx(canvas, rx, er - 1, black); setPx(canvas, rx + 1, er - 1, black);
    setPx(canvas, rx, er, black); setPx(canvas, rx + 1, er, black);
  } else if (style === "angry") {
    // Slanted down-to-inner, 2 pixels each
    setPx(canvas, lx - 1, er - 1, black);
    setPx(canvas, lx, er, black);
    setPx(canvas, rx, er, black);
    setPx(canvas, rx + 1, er - 1, black);
  } else if (style === "sleepy") {
    // Horizontal line, 2 pixels each eye
    setPx(canvas, lx - 1, er, black); setPx(canvas, lx, er, black);
    setPx(canvas, rx, er, black); setPx(canvas, rx + 1, er, black);
  } else if (style === "hearts") {
    // 3×3 heart each eye
    const drawHeart = (cx: number, cy: number) => {
      setPx(canvas, cx - 1, cy - 1, red); setPx(canvas, cx + 1, cy - 1, red);
      setPx(canvas, cx - 1, cy, red); setPx(canvas, cx, cy, red); setPx(canvas, cx + 1, cy, red);
      setPx(canvas, cx, cy + 1, red);
    };
    drawHeart(lx, er);
    drawHeart(rx, er);
  } else if (style === "dollar") {
    // $ symbol, green
    const drawDollar = (cx: number, cy: number) => {
      setPx(canvas, cx, cy - 1, green);
      setPx(canvas, cx - 1, cy, green); setPx(canvas, cx, cy, green); setPx(canvas, cx + 1, cy, green);
      setPx(canvas, cx, cy + 1, green);
    };
    drawDollar(lx, er);
    drawDollar(rx, er);
  } else if (style === "x_eyes") {
    const drawX = (cx: number, cy: number) => {
      setPx(canvas, cx - 1, cy - 1, black); setPx(canvas, cx + 1, cy - 1, black);
      setPx(canvas, cx, cy, black);
      setPx(canvas, cx - 1, cy + 1, black); setPx(canvas, cx + 1, cy + 1, black);
    };
    drawX(lx, er);
    drawX(rx, er);
  } else if (style === "laser") {
    // Horizontal red laser beam across whole face
    for (let c = 4; c <= 19; c++) setPx(canvas, c, er, red);
    // Glow above/below
    setPx(canvas, lx, er - 1, red); setPx(canvas, rx, er - 1, red);
    setPx(canvas, lx, er + 1, red); setPx(canvas, rx, er + 1, red);
  }
}

// ── Layer 6: Eyewear ──
type Eyewear = "none" | "sunglasses" | "glasses" | "3d_glasses" | "monocle" | "laser_visor" | "eyepatch" | "vr_headset";

function pickEyewear(h: Buffer): Eyewear {
  const v = h[9] % 100;
  if (v < 55) return "none";
  if (v < 70) return "sunglasses";
  if (v < 80) return "glasses";
  if (v < 85) return "3d_glasses";
  if (v < 90) return "monocle";
  if (v < 93) return "laser_visor";
  if (v < 97) return "eyepatch";
  return "vr_headset";
}

function applyEyewear(canvas: Canvas, wear: Eyewear): void {
  if (wear === "none") return;
  const dark = "#1A1A1A";
  const gold = "#FFD700";
  const red = "#E63946";
  const cyan = "#06A77D";

  const lx = 8, rx = 15, er = 14;

  if (wear === "sunglasses") {
    for (let c = lx - 1; c <= lx + 1; c++) { setPx(canvas, c, er - 1, dark); setPx(canvas, c, er, dark); }
    for (let c = rx - 1; c <= rx + 1; c++) { setPx(canvas, c, er - 1, dark); setPx(canvas, c, er, dark); }
    // Bridge
    for (let c = lx + 2; c <= rx - 2; c++) setPx(canvas, c, er - 1, dark);
  } else if (wear === "glasses") {
    // Thin round-ish frames
    for (let c = lx - 1; c <= lx + 1; c++) setPx(canvas, c, er - 1, dark);
    setPx(canvas, lx - 1, er, dark); setPx(canvas, lx + 1, er, dark);
    setPx(canvas, lx - 1, er + 1, dark); setPx(canvas, lx + 1, er + 1, dark);
    for (let c = rx - 1; c <= rx + 1; c++) setPx(canvas, c, er - 1, dark);
    setPx(canvas, rx - 1, er, dark); setPx(canvas, rx + 1, er, dark);
    setPx(canvas, rx - 1, er + 1, dark); setPx(canvas, rx + 1, er + 1, dark);
    // Bridge
    for (let c = lx + 2; c <= rx - 2; c++) setPx(canvas, c, er, dark);
  } else if (wear === "3d_glasses") {
    // Red left lens
    for (let c = lx - 1; c <= lx + 1; c++) { setPx(canvas, c, er - 1, red); setPx(canvas, c, er, red); }
    // Cyan right lens
    for (let c = rx - 1; c <= rx + 1; c++) { setPx(canvas, c, er - 1, cyan); setPx(canvas, c, er, cyan); }
    // Dark frame edges
    setPx(canvas, lx - 1, er - 1, dark); setPx(canvas, rx + 1, er - 1, dark);
  } else if (wear === "monocle") {
    // Gold ring around right eye only
    setPx(canvas, rx - 1, er - 1, gold);
    setPx(canvas, rx, er - 1, gold);
    setPx(canvas, rx + 1, er - 1, gold);
    setPx(canvas, rx - 1, er, gold); setPx(canvas, rx + 1, er, gold);
    setPx(canvas, rx, er + 1, gold); setPx(canvas, rx - 1, er + 1, gold); setPx(canvas, rx + 1, er + 1, gold);
    // Chain
    setPx(canvas, rx + 2, er, gold);
    setPx(canvas, rx + 2, er + 1, gold);
  } else if (wear === "laser_visor") {
    // Horizontal band across both eyes, dark with red lasers
    for (let c = 6; c <= 17; c++) {
      setPx(canvas, c, er - 1, dark);
      setPx(canvas, c, er, red);
    }
  } else if (wear === "eyepatch") {
    // Dark patch over left eye
    for (let c = lx - 2; c <= lx + 2; c++) {
      setPx(canvas, c, er - 1, dark);
      setPx(canvas, c, er, dark);
      setPx(canvas, c, er + 1, dark);
    }
    // Strap going up-left (to body edge)
    setPx(canvas, lx - 2, er - 2, dark);
    setPx(canvas, lx - 3, er - 2, dark);
  } else if (wear === "vr_headset") {
    // Large dark band
    for (let c = 5; c <= 18; c++) {
      setPx(canvas, c, er - 2, dark);
      setPx(canvas, c, er - 1, dark);
      setPx(canvas, c, er, dark);
    }
    // Accent line
    for (let c = 6; c <= 17; c++) setPx(canvas, c, er, cyan);
  }
}

// ── Layer 7: Hats ──
type Hat = "none" | "baseball" | "beanie" | "cowboy" | "top_hat" | "crown" | "chef" | "party" | "headphones" | "halo" | "devil_horns";

function pickHat(h: Buffer): Hat {
  const v = h[10] % 100;
  if (v < 40) return "none";
  if (v < 52) return "baseball";
  if (v < 62) return "beanie";
  if (v < 70) return "cowboy";
  if (v < 76) return "top_hat";
  if (v < 80) return "crown";
  if (v < 85) return "chef";
  if (v < 90) return "party";
  if (v < 94) return "headphones";
  if (v < 97) return "halo";
  return "devil_horns";
}

function applyHat(canvas: Canvas, hat: Hat, h: Buffer): void {
  if (hat === "none") return;
  // Pick hat color from a small palette (varies per agent)
  const HAT_COLORS = ["#2C3E50", "#E74C3C", "#27AE60", "#F39C12", "#8E44AD", "#16A085", "#C0392B"];
  const hatColor = HAT_COLORS[h[11] % HAT_COLORS.length];
  const dark = "#1A1A1A";
  const gold = "#FFD700";
  const white = "#F5F5F5";

  if (hat === "baseball") {
    // Cap crown + brim extending left
    for (let c = 9; c <= 14; c++) setPx(canvas, c, 10, hatColor);
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 11, hatColor);
    // Brim (extends left past center)
    for (let c = 3; c <= 15; c++) setPx(canvas, c, 12, hatColor);
  } else if (hat === "beanie") {
    // Rounded cap with folded band
    for (let c = 9; c <= 14; c++) setPx(canvas, c, 8, hatColor);
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 9, hatColor);
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 10, hatColor);
    for (let c = 6; c <= 17; c++) setPx(canvas, c, 11, hatColor);
    // Fold / band at bottom (slightly darker)
    const band = darken(hatColor, 0.3);
    for (let c = 6; c <= 17; c++) setPx(canvas, c, 12, band);
    // Pom-pom on top
    setPx(canvas, 11, 7, white); setPx(canvas, 12, 7, white);
  } else if (hat === "cowboy") {
    // Wide brim + dome crown
    for (let c = 9; c <= 14; c++) setPx(canvas, c, 9, hatColor);
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 10, hatColor);
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 11, hatColor);
    // Very wide brim
    for (let c = 3; c <= 20; c++) setPx(canvas, c, 12, hatColor);
    // Hat band accent
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 11, darken(hatColor, 0.4));
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 10, hatColor);
  } else if (hat === "top_hat") {
    // Tall cylinder
    for (let r = 6; r <= 10; r++) for (let c = 9; c <= 14; c++) setPx(canvas, c, r, dark);
    // Band (slightly above brim)
    for (let c = 9; c <= 14; c++) setPx(canvas, c, 10, hatColor);
    // Brim
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 11, dark);
    for (let c = 6; c <= 17; c++) setPx(canvas, c, 12, dark);
  } else if (hat === "crown") {
    // Gold crown with spikes and gems
    // Spikes
    setPx(canvas, 8, 9, gold); setPx(canvas, 11, 9, gold); setPx(canvas, 14, 9, gold);
    setPx(canvas, 9, 10, gold); setPx(canvas, 12, 10, gold); setPx(canvas, 15, 10, gold);
    // Band
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 11, gold);
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 12, gold);
    // Gems
    setPx(canvas, 9, 11, "#E63946"); setPx(canvas, 14, 11, "#3B82F6");
  } else if (hat === "chef") {
    // Puffy chef hat
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 7, white);
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 8, white);
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 9, white);
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 10, white);
    // Band
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 11, white);
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 12, white);
  } else if (hat === "party") {
    // Cone-shaped party hat
    setPx(canvas, 11, 7, hatColor); setPx(canvas, 12, 7, hatColor);
    setPx(canvas, 10, 8, hatColor); setPx(canvas, 11, 8, hatColor); setPx(canvas, 12, 8, hatColor); setPx(canvas, 13, 8, hatColor);
    for (let c = 9; c <= 14; c++) setPx(canvas, c, 9, hatColor);
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 10, hatColor);
    for (let c = 7; c <= 16; c++) setPx(canvas, c, 11, hatColor);
    // Stripes
    setPx(canvas, 10, 9, white); setPx(canvas, 13, 9, white);
    setPx(canvas, 9, 10, white); setPx(canvas, 14, 10, white);
    // Pom-pom
    setPx(canvas, 11, 6, white);
  } else if (hat === "headphones") {
    // Arc band over head
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 8, dark);
    setPx(canvas, 7, 9, dark); setPx(canvas, 16, 9, dark);
    // Ear cups on sides
    setPx(canvas, 6, 10, dark); setPx(canvas, 7, 10, dark);
    setPx(canvas, 6, 11, dark); setPx(canvas, 7, 11, dark);
    setPx(canvas, 16, 10, dark); setPx(canvas, 17, 10, dark);
    setPx(canvas, 16, 11, dark); setPx(canvas, 17, 11, dark);
    // Accent (colored cushion)
    setPx(canvas, 6, 10, hatColor); setPx(canvas, 17, 10, hatColor);
  } else if (hat === "halo") {
    // Gold ring floating above
    for (let c = 8; c <= 15; c++) setPx(canvas, c, 5, gold);
    // Ring thickness
    setPx(canvas, 7, 5, gold); setPx(canvas, 16, 5, gold);
    // Hollow inside shown by not filling row 6 except at edges
    setPx(canvas, 7, 6, gold); setPx(canvas, 16, 6, gold);
  } else if (hat === "devil_horns") {
    const horn = "#8B0000";
    // Two small curved horns
    setPx(canvas, 9, 8, horn); setPx(canvas, 10, 8, horn);
    setPx(canvas, 10, 9, horn);
    setPx(canvas, 13, 9, horn);
    setPx(canvas, 13, 8, horn); setPx(canvas, 14, 8, horn);
    // Tips (darker red)
    setPx(canvas, 9, 7, horn); setPx(canvas, 14, 7, horn);
  }
}

// ── Layer 8: Mouth accessories ──
type Mouth = "none" | "cigarette" | "pipe" | "gum" | "gold_tooth" | "tongue";

function pickMouth(h: Buffer): Mouth {
  const v = h[12] % 100;
  if (v < 70) return "none";
  if (v < 80) return "cigarette";
  if (v < 88) return "pipe";
  if (v < 93) return "gum";
  if (v < 97) return "gold_tooth";
  return "tongue";
}

function applyMouth(canvas: Canvas, mouth: Mouth): void {
  if (mouth === "none") return;
  const white = "#F5F5F5";
  const red = "#E63946";
  const brown = "#4A2408";
  const pink = "#FF69B4";
  const gold = "#FFD700";

  // Mouth zone: row 17 around cols 10-14
  if (mouth === "cigarette") {
    // White stick extending right from mouth with glowing red tip
    setPx(canvas, 13, 17, white); setPx(canvas, 14, 17, white); setPx(canvas, 15, 17, white);
    setPx(canvas, 16, 17, white); setPx(canvas, 17, 17, white);
    setPx(canvas, 18, 17, red); // ember
    // smoke
    setPx(canvas, 18, 16, "#A0A0A0");
    setPx(canvas, 19, 15, "#A0A0A0");
  } else if (mouth === "pipe") {
    // L-shaped pipe
    setPx(canvas, 13, 17, brown); setPx(canvas, 14, 17, brown); setPx(canvas, 15, 17, brown);
    setPx(canvas, 15, 18, brown); setPx(canvas, 16, 18, brown);
    setPx(canvas, 15, 16, "#FF9800"); // smoke / ember glow
  } else if (mouth === "gum") {
    // Pink bubble
    setPx(canvas, 12, 17, pink); setPx(canvas, 13, 17, pink);
    setPx(canvas, 12, 18, pink); setPx(canvas, 13, 18, pink);
    // Shine
    setPx(canvas, 12, 17, "#FFB8D9");
  } else if (mouth === "gold_tooth") {
    setPx(canvas, 11, 17, gold);
  } else if (mouth === "tongue") {
    // Pink strip sticking out
    setPx(canvas, 11, 17, pink); setPx(canvas, 12, 17, pink);
    setPx(canvas, 11, 18, pink); setPx(canvas, 12, 18, pink);
  }
}

// ── Layer 9: Backgrounds (glass orb hue) ──
const BG_COLORS = [
  // Common pastels (10)
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA",
  "#D8E5D5", "#DDDDDD", "#E5D5DE", "#D5E0D5",
  "#D8D5E0", "#D5E0E5",
  // Themed (5)
  "#F5D7B0", // sandy beach
  "#C7E1F5", // ocean
  "#D5E8C4", // forest
  "#F5C7E1", // sunset
  "#E1D5F5", // dusk purple
  // Rare (3)
  "#2C1F5E", // midnight
  "#F5E6A8", // gold glow
  "#1F1F1F", // void black
];

function pickBg(h: Buffer): string {
  return BG_COLORS[h[13] % BG_COLORS.length];
}

// ── Master build ──
function buildCrab(h: Buffer): { canvas: Canvas; bg: string } {
  const canvas = newCanvas();
  const shell = SHELL_COLORS[h[0] % SHELL_COLORS.length];
  const pattern = pickPattern(h);
  const claw = pickClaw(h);
  const item = pickItem(h);
  const eye = pickEye(h);
  const wear = pickEyewear(h);
  const hat = pickHat(h);
  const mouth = pickMouth(h);
  const bg = pickBg(h);

  // Layer 1 — shell color on all body pixels
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (CRAB_BASE[r][c] === "#") canvas[r][c] = shell;
    }
  }

  // Layer 2 — pattern
  applyPattern(canvas, pattern, shell, h);

  // Layer 3 — claw variants (must come after shell/pattern on claws)
  applyClaw(canvas, claw, shell);

  // Layer 4 — held items (drawn in center gap between claws)
  applyHeldItem(canvas, item);

  // Layer 5 — eyes
  applyEyes(canvas, eye);

  // Layer 6 — eyewear over eyes
  applyEyewear(canvas, wear);

  // Layer 7 — hat on top
  applyHat(canvas, hat, h);

  // Layer 8 — mouth accessories on body
  applyMouth(canvas, mouth);

  return { canvas, bg };
}

// ── Render to SVG ──
function renderSVG(canvas: Canvas, bgColor: string): string {
  const SIZE = 512;
  const FACE_PX = 384;
  const PIXEL = FACE_PX / GRID_SIZE;
  const OFFSET = (SIZE - FACE_PX) / 2;

  const pixels: string[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const color = canvas[r][c];
      if (!color) continue;
      pixels.push(
        `<rect x="${OFFSET + c * PIXEL}" y="${OFFSET + r * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`,
      );
    }
  }

  const bgDark = darken(bgColor, 0.3);

  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <radialGradient id="orbBg" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${bgColor}" stop-opacity="1"/>
      <stop offset="55%" stop-color="${bgColor}" stop-opacity="0.94"/>
      <stop offset="100%" stop-color="${bgDark}" stop-opacity="1"/>
    </radialGradient>
    <radialGradient id="highlight" cx="28%" cy="22%" r="30%">
      <stop offset="0%" stop-color="white" stop-opacity="0.65"/>
      <stop offset="45%" stop-color="white" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="rim" cx="50%" cy="50%" r="50%">
      <stop offset="88%" stop-color="black" stop-opacity="0"/>
      <stop offset="96%" stop-color="black" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.18"/>
    </radialGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#orbBg)" shape-rendering="auto"/>
  <g>${pixels.join("")}</g>
  <ellipse cx="${SIZE * 0.3}" cy="${SIZE * 0.2}" rx="${SIZE * 0.2}" ry="${SIZE * 0.11}" fill="url(#highlight)" shape-rendering="auto"/>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#rim)" shape-rendering="auto"/>
</svg>`;
}

// ── Generate grid of 30 crabs ──
async function main() {
  const COUNT = 36;
  const COLS = 6;
  const ROWS = 6;
  const TILE = 280;
  const GAP = 8;

  const crabs: Buffer[] = [];
  for (let i = 0; i < COUNT; i++) {
    const hash = crypto.randomBytes(32);
    const { canvas, bg } = buildCrab(hash);
    const svg = renderSVG(canvas, bg);
    const png = await sharp(Buffer.from(svg)).resize(TILE, TILE).png().toBuffer();
    crabs.push(png);
  }

  const canvasW = COLS * TILE + (COLS + 1) * GAP;
  const canvasH = ROWS * TILE + (ROWS + 1) * GAP;

  const composites = crabs.map((b, i) => ({
    input: b,
    top: GAP + Math.floor(i / COLS) * (TILE + GAP),
    left: GAP + (i % COLS) * (TILE + GAP),
  }));

  const out = await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 18, g: 18, b: 22, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  await fs.writeFile("/tmp/crab-full-traits.png", out);
  console.log(`Wrote ${COUNT} crab variations with all 9 trait layers → /tmp/crab-full-traits.png`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
