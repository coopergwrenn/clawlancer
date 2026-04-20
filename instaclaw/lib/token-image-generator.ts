/**
 * Token PFP generation — 28×28 crab generator based on Candidate 02
 * ("darker-legs" master from Larry Canon).
 *
 * Silhouette locked to Candidate 02 with 2-tone treatment baked in:
 *   - Light tone (L pixels) = agent's shell color
 *   - Dark tone  (D pixels) = darkened shell (legs/underside)
 * Accessories layer on TOP of this silhouette but stay small/peripheral so
 * the base crab shape always reads clearly.
 *
 * Two-hash split preserved:
 *   personalityHash (LOCKED): shell color, eye style, eyewear, background
 *   variationHash (VARIES):   hat, held item, mouth accessory
 */

// ── Grid primitives ──
export type Grid = (string | null)[][];
export const GRID_SIZE = 28;

function newGrid(): Grid {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
}

function setPx(g: Grid, x: number, y: number, color: string): void {
  if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
    g[y][x] = color;
  }
}

// ── Base silhouette (Candidate 02 — 28×28) ──
// '.' = transparent
// 'L' = light tone (stamped with shell color)
// 'D' = dark tone  (stamped with darkened shell color)
const CRAB_BASE: string[] = [
  "............................", // 0
  "............................", // 1
  "............................", // 2
  "............................", // 3
  "............................", // 4
  "............................", // 5
  "............................", // 6
  ".......LLLL.......LLLL......", // 7  — claw top caps
  "......LLL...........LLL.....", // 8  — pincer interior visible
  "......LLLLL.......LLLLL.....", // 9  — widen
  ".....LLLLL.........LLLLL....", // 10 — shift outer
  ".....LLLLLDL.....LDLLLLL....", // 11 — widen, dark shading edges
  ".....LL...LLLLLLLLL...LL....", // 12 — pincer row (outer feet + body merge)
  ".....LLL.LLLLLLLLLLL.LLL....", // 13 — body merging
  "......LLDLLLLLLLLLLLDLD.....", // 14 — body top with dark shading
  "........DLLLLLLLLLLLD.......", // 15 — body (slight narrowing)
  "......LLDLLLLLLLLLLLDLL.....", // 16 — body widens back
  ".....LL..LLLLLLLLLLL..DD....", // 17 — body with leg notches
  "........LLLLLLLLLLLDL.......", // 18 — body narrowing
  ".......LD..DLLLLLD..LL......", // 19 — leg row 1
  ".......DD...........DL......", // 20 — leg tips
  ".......LD...........DL......", // 21 — outer leg extensions
  "............................", // 22
  "............................", // 23
  "............................", // 24
  "............................", // 25
  "............................", // 26
  "............................", // 27
];

// Region helpers — adjusted for 28×28 grid
function isClawPixel(c: number, r: number): boolean {
  return r >= 7 && r <= 13 && CRAB_BASE[r][c] !== ".";
}
function isBodyPixel(c: number, r: number): boolean {
  return r >= 14 && r <= 18 && CRAB_BASE[r][c] !== ".";
}

// ── Color helpers ──
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

// ── Layer 1: Shell color palette ──
const SHELL_COLORS = [
  // Common natural — burnt-orange / terracotta family (Candidate 02 aesthetic)
  "#D97757", "#E08060", "#C5693F", "#B86A2E", "#D47147",
  "#A65A2B", "#C8703A", "#E6905A", "#D68850", "#BA6A35",
  "#C94A3F", "#8B4513",
  // Uncommon fantasy
  "#5A8DA0", "#7FA46E", "#9568B8", "#C86F8B", "#6BA086",
  // Rare metallic
  "#DAA520", "#9A9A9A", "#2C2C2C",
];

// ── Layer 2: Body patterns ──
type Pattern = "solid" | "stripes" | "spots" | "camo" | "galaxy";

function pickPattern(h: Buffer): Pattern {
  // Reduced pattern frequency — solid 85% to keep silhouette clean
  const v = h[4] % 100;
  if (v < 85) return "solid";
  if (v < 92) return "stripes";
  if (v < 96) return "spots";
  if (v < 98) return "camo";
  return "galaxy";
}

function applyPattern(grid: Grid, pattern: Pattern, shell: string, h: Buffer): void {
  if (pattern === "solid") return;
  const patternColor = darkenHex(shell, 0.35);
  if (pattern === "stripes") {
    for (const r of [15, 17]) {
      for (let c = 0; c < GRID_SIZE; c++) if (isBodyPixel(c, r)) setPx(grid, c, r, patternColor);
    }
  } else if (pattern === "spots") {
    for (let i = 0; i < 4; i++) {
      const r = 14 + (h[(10 + i) % 32] % 5);
      const c = 8 + (h[(18 + i) % 32] % 12);
      if (isBodyPixel(c, r)) setPx(grid, c, r, patternColor);
    }
  } else if (pattern === "camo") {
    const patches: Array<[number, number]> = [[10, 15], [16, 16], [12, 17]];
    for (const [sc, sr] of patches) {
      for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
        const c = sc + dc, r = sr + dr;
        if (isBodyPixel(c, r)) setPx(grid, c, r, patternColor);
      }
    }
  } else if (pattern === "galaxy") {
    for (let r = 14; r <= 18; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isBodyPixel(c, r) && (r + c) % 2 === 0) setPx(grid, c, r, patternColor);
    }
  }
}

// ── Layer 3: Claw variants ──
type ClawVariant = "default" | "gold_tipped" | "full_gold" | "full_diamond" | "asymmetric";

function pickClaw(h: Buffer): ClawVariant {
  const v = h[6] % 100;
  if (v < 80) return "default";
  if (v < 92) return "gold_tipped";
  if (v < 96) return "full_gold";
  if (v < 98) return "full_diamond";
  return "asymmetric";
}

function applyClaw(grid: Grid, variant: ClawVariant, shell: string): void {
  if (variant === "default") return;
  if (variant === "gold_tipped") {
    const gold = "#FFD700";
    // Only the very tips (rows 7-8) get gold
    for (let r = 7; r <= 8; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(grid, c, r, gold);
    }
  } else if (variant === "full_gold") {
    const gold = "#FFD700";
    for (let r = 7; r <= 11; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(grid, c, r, gold);
    }
  } else if (variant === "full_diamond") {
    const dia = "#CFF5FF";
    for (let r = 7; r <= 11; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(grid, c, r, dia);
    }
    // Sparkle highlights
    setPx(grid, 8, 8, "#FFFFFF");
    setPx(grid, 19, 8, "#FFFFFF");
  } else if (variant === "asymmetric") {
    // Bulk up left claw by 1 col outward
    const bigColor = darkenHex(shell, 0.1);
    setPx(grid, 4, 8, bigColor); setPx(grid, 4, 9, bigColor);
    setPx(grid, 4, 10, bigColor); setPx(grid, 4, 11, bigColor);
    // Reduce right claw slightly
    grid[8][22] = null; grid[9][22] = null;
  }
}

// ── Layer 4: Held items — drawn small so they don't dominate ──
type HeldItem = "none" | "coin" | "briefcase" | "leaf" | "star" | "gem" | "flag" | "heart";

function pickItem(h: Buffer): HeldItem {
  // More "none" to keep silhouette visible
  const v = h[7] % 100;
  if (v < 75) return "none";
  if (v < 82) return "coin";
  if (v < 87) return "briefcase";
  if (v < 91) return "leaf";
  if (v < 94) return "star";
  if (v < 96) return "gem";
  if (v < 98) return "flag";
  return "heart";
}

function applyHeldItem(grid: Grid, item: HeldItem): void {
  if (item === "none") return;
  // Items drawn small in the gap between claw tops (rows 8-11, cols 12-15)
  const cx = 13, ry = 9;

  if (item === "coin") {
    const gold = "#FFD700";
    setPx(grid, cx, ry, gold); setPx(grid, cx + 1, ry, gold);
    setPx(grid, cx - 1, ry + 1, gold); setPx(grid, cx, ry + 1, "#FFF8DC"); setPx(grid, cx + 1, ry + 1, "#FFF8DC"); setPx(grid, cx + 2, ry + 1, gold);
    setPx(grid, cx, ry + 2, gold); setPx(grid, cx + 1, ry + 2, gold);
  } else if (item === "briefcase") {
    const leather = "#3A1E08";
    setPx(grid, cx - 1, ry, leather); setPx(grid, cx, ry, leather); setPx(grid, cx + 1, ry, leather); setPx(grid, cx + 2, ry, leather);
    setPx(grid, cx - 1, ry + 1, leather); setPx(grid, cx, ry + 1, "#FFD700"); setPx(grid, cx + 1, ry + 1, leather); setPx(grid, cx + 2, ry + 1, leather);
  } else if (item === "leaf") {
    const green = "#4A8F5A";
    setPx(grid, cx, ry, green); setPx(grid, cx + 1, ry + 1, green);
    setPx(grid, cx, ry + 2, green); setPx(grid, cx + 1, ry + 2, green);
  } else if (item === "star") {
    const gold = "#FFD700";
    setPx(grid, cx, ry, gold); setPx(grid, cx + 1, ry, gold);
    setPx(grid, cx - 1, ry + 1, gold); setPx(grid, cx, ry + 1, gold); setPx(grid, cx + 1, ry + 1, gold); setPx(grid, cx + 2, ry + 1, gold);
    setPx(grid, cx, ry + 2, gold); setPx(grid, cx + 1, ry + 2, gold);
  } else if (item === "gem") {
    const gem = "#7FE6FF";
    setPx(grid, cx, ry, gem); setPx(grid, cx + 1, ry, gem);
    setPx(grid, cx, ry + 1, "#FFFFFF"); setPx(grid, cx + 1, ry + 1, gem);
    setPx(grid, cx, ry + 2, gem); setPx(grid, cx + 1, ry + 2, gem);
  } else if (item === "flag") {
    const pole = "#8B4513", flag = "#E63946";
    setPx(grid, cx, ry - 1, pole); setPx(grid, cx, ry, pole); setPx(grid, cx, ry + 1, pole); setPx(grid, cx, ry + 2, pole);
    setPx(grid, cx + 1, ry, flag); setPx(grid, cx + 2, ry, flag);
    setPx(grid, cx + 1, ry + 1, flag); setPx(grid, cx + 2, ry + 1, flag);
  } else if (item === "heart") {
    const red = "#E63946";
    setPx(grid, cx, ry, red); setPx(grid, cx + 2, ry, red);
    setPx(grid, cx - 1, ry + 1, red); setPx(grid, cx, ry + 1, red); setPx(grid, cx + 1, ry + 1, red); setPx(grid, cx + 2, ry + 1, red); setPx(grid, cx + 3, ry + 1, red);
    setPx(grid, cx, ry + 2, red); setPx(grid, cx + 1, ry + 2, red); setPx(grid, cx + 2, ry + 2, red);
    setPx(grid, cx + 1, ry + 3, red);
  }
}

// ── Layer 5: Eyes (LOCKED) ──
type EyeStyle = "dot" | "wide" | "angry" | "sleepy" | "hearts" | "dollar" | "x_eyes" | "laser";

function pickEye(h: Buffer): EyeStyle {
  const v = h[8] % 100;
  // Dot eyes dominate — matches Candidate 02 "tiny 1-pixel eyes" aesthetic
  if (v < 70) return "dot";
  if (v < 82) return "wide";
  if (v < 90) return "angry";
  if (v < 95) return "sleepy";
  if (v < 97) return "hearts";
  if (v < 98) return "dollar";
  if (v < 99) return "x_eyes";
  return "laser";
}

function applyEyes(grid: Grid, style: EyeStyle): void {
  const black = "#1A1A1A", red = "#E63946", green = "#2EA040";
  // Eye positions on the body face
  const lx = 10, rx = 17, er = 15;

  if (style === "dot") {
    setPx(grid, lx, er, black);
    setPx(grid, rx, er, black);
  } else if (style === "wide") {
    setPx(grid, lx, er, black); setPx(grid, lx, er + 1, black);
    setPx(grid, rx, er, black); setPx(grid, rx, er + 1, black);
  } else if (style === "angry") {
    setPx(grid, lx - 1, er - 1, black);
    setPx(grid, lx, er, black);
    setPx(grid, rx, er, black);
    setPx(grid, rx + 1, er - 1, black);
  } else if (style === "sleepy") {
    setPx(grid, lx - 1, er + 1, black); setPx(grid, lx, er + 1, black);
    setPx(grid, rx, er + 1, black); setPx(grid, rx + 1, er + 1, black);
  } else if (style === "hearts") {
    setPx(grid, lx, er, red); setPx(grid, lx + 1, er, red);
    setPx(grid, rx, er, red); setPx(grid, rx + 1, er, red);
  } else if (style === "dollar") {
    setPx(grid, lx, er, green); setPx(grid, rx, er, green);
  } else if (style === "x_eyes") {
    setPx(grid, lx - 1, er - 1, black); setPx(grid, lx + 1, er + 1, black);
    setPx(grid, rx - 1, er - 1, black); setPx(grid, rx + 1, er + 1, black);
  } else if (style === "laser") {
    for (let c = 6; c <= 21; c++) setPx(grid, c, er, red);
  }
}

// ── Layer 6: Eyewear (LOCKED) — reduced frequency ──
type Eyewear = "none" | "sunglasses" | "glasses" | "monocle" | "eyepatch";

function pickEyewear(h: Buffer): Eyewear {
  const v = h[9] % 100;
  if (v < 80) return "none";
  if (v < 88) return "sunglasses";
  if (v < 93) return "glasses";
  if (v < 97) return "monocle";
  return "eyepatch";
}

function applyEyewear(grid: Grid, wear: Eyewear): void {
  if (wear === "none") return;
  const dark = "#1A1A1A", gold = "#FFD700";
  const lx = 10, rx = 17, er = 15;

  if (wear === "sunglasses") {
    for (let c = lx - 1; c <= lx + 1; c++) setPx(grid, c, er, dark);
    for (let c = rx - 1; c <= rx + 1; c++) setPx(grid, c, er, dark);
    setPx(grid, lx + 2, er, dark); setPx(grid, rx - 2, er, dark);
    for (let c = lx + 3; c <= rx - 3; c++) setPx(grid, c, er, dark);
  } else if (wear === "glasses") {
    for (let c = lx - 1; c <= lx + 1; c++) setPx(grid, c, er - 1, dark);
    setPx(grid, lx - 1, er, dark); setPx(grid, lx + 1, er, dark);
    setPx(grid, lx, er + 1, dark);
    for (let c = rx - 1; c <= rx + 1; c++) setPx(grid, c, er - 1, dark);
    setPx(grid, rx - 1, er, dark); setPx(grid, rx + 1, er, dark);
    setPx(grid, rx, er + 1, dark);
    for (let c = lx + 2; c <= rx - 2; c++) setPx(grid, c, er - 1, dark);
  } else if (wear === "monocle") {
    setPx(grid, rx - 1, er - 1, gold); setPx(grid, rx, er - 1, gold); setPx(grid, rx + 1, er - 1, gold);
    setPx(grid, rx - 1, er, gold); setPx(grid, rx + 1, er, gold);
    setPx(grid, rx, er + 1, gold); setPx(grid, rx - 1, er + 1, gold); setPx(grid, rx + 1, er + 1, gold);
  } else if (wear === "eyepatch") {
    for (let c = lx - 1; c <= lx + 1; c++) for (let r = er - 1; r <= er + 1; r++) setPx(grid, c, r, dark);
  }
}

// ── Layer 7: Hats (VARIES) — small, sit on top of body between claws ──
type Hat = "none" | "baseball" | "beanie" | "cowboy" | "top_hat" | "crown" | "party" | "halo" | "devil_horns";

function pickHat(h: Buffer): Hat {
  const v = h[10] % 100;
  if (v < 65) return "none";
  if (v < 73) return "baseball";
  if (v < 80) return "beanie";
  if (v < 86) return "cowboy";
  if (v < 90) return "top_hat";
  if (v < 93) return "crown";
  if (v < 96) return "party";
  if (v < 98) return "halo";
  return "devil_horns";
}

function applyHat(grid: Grid, hat: Hat, h: Buffer): void {
  if (hat === "none") return;
  const HAT_COLORS = ["#2C3E50", "#E74C3C", "#27AE60", "#F39C12", "#8E44AD", "#16A085"];
  const hatColor = HAT_COLORS[h[11] % HAT_COLORS.length];
  const dark = "#1A1A1A", gold = "#FFD700", white = "#F5F5F5";

  // Hats sit in the center-top between claws (cols 11-16, rows 10-13)
  if (hat === "baseball") {
    for (let c = 11; c <= 16; c++) setPx(grid, c, 11, hatColor);
    for (let c = 10; c <= 17; c++) setPx(grid, c, 12, hatColor);
    for (let c = 7; c <= 17; c++) setPx(grid, c, 13, hatColor);
  } else if (hat === "beanie") {
    for (let c = 11; c <= 16; c++) setPx(grid, c, 9, hatColor);
    for (let c = 10; c <= 17; c++) setPx(grid, c, 10, hatColor);
    for (let c = 9; c <= 18; c++) setPx(grid, c, 11, hatColor);
    const band = darkenHex(hatColor, 0.3);
    for (let c = 9; c <= 18; c++) setPx(grid, c, 12, band);
    setPx(grid, 13, 8, white); setPx(grid, 14, 8, white);
  } else if (hat === "cowboy") {
    for (let c = 11; c <= 16; c++) setPx(grid, c, 10, hatColor);
    for (let c = 10; c <= 17; c++) setPx(grid, c, 11, hatColor);
    for (let c = 5; c <= 22; c++) setPx(grid, c, 12, hatColor);
  } else if (hat === "top_hat") {
    for (let r = 8; r <= 11; r++) for (let c = 11; c <= 16; c++) setPx(grid, c, r, dark);
    for (let c = 11; c <= 16; c++) setPx(grid, c, 10, hatColor);
    for (let c = 9; c <= 18; c++) setPx(grid, c, 12, dark);
  } else if (hat === "crown") {
    setPx(grid, 11, 10, gold); setPx(grid, 13, 10, gold); setPx(grid, 15, 10, gold); setPx(grid, 16, 10, gold);
    for (let c = 10; c <= 17; c++) setPx(grid, c, 11, gold);
    for (let c = 10; c <= 17; c++) setPx(grid, c, 12, gold);
    setPx(grid, 12, 11, "#E63946"); setPx(grid, 15, 11, "#3B82F6");
  } else if (hat === "party") {
    setPx(grid, 13, 8, hatColor); setPx(grid, 14, 8, hatColor);
    setPx(grid, 12, 9, hatColor); setPx(grid, 13, 9, hatColor); setPx(grid, 14, 9, hatColor); setPx(grid, 15, 9, hatColor);
    for (let c = 11; c <= 16; c++) setPx(grid, c, 10, hatColor);
    for (let c = 10; c <= 17; c++) setPx(grid, c, 11, hatColor);
    setPx(grid, 13, 7, white);
  } else if (hat === "halo") {
    for (let c = 10; c <= 17; c++) setPx(grid, c, 6, gold);
  } else if (hat === "devil_horns") {
    const horn = "#8B0000";
    setPx(grid, 10, 9, horn); setPx(grid, 11, 9, horn);
    setPx(grid, 11, 10, horn);
    setPx(grid, 16, 10, horn);
    setPx(grid, 16, 9, horn); setPx(grid, 17, 9, horn);
  }
}

// ── Layer 8: Mouth accessories (VARIES) — reduced frequency ──
type Mouth = "none" | "cigarette" | "gum" | "gold_tooth";

function pickMouth(h: Buffer): Mouth {
  const v = h[12] % 100;
  if (v < 88) return "none";
  if (v < 94) return "cigarette";
  if (v < 97) return "gum";
  return "gold_tooth";
}

function applyMouth(grid: Grid, mouth: Mouth): void {
  if (mouth === "none") return;
  const white = "#F5F5F5", red = "#E63946", pink = "#FF69B4", gold = "#FFD700";

  // Mouth position below eyes, at row 17
  if (mouth === "cigarette") {
    for (let c = 15; c <= 19; c++) setPx(grid, c, 17, white);
    setPx(grid, 20, 17, red);
  } else if (mouth === "gum") {
    setPx(grid, 14, 17, pink); setPx(grid, 15, 17, pink);
  } else if (mouth === "gold_tooth") {
    setPx(grid, 13, 17, gold);
  }
}

// ── Layer 9: Backgrounds (LOCKED) ──
const BG_COLORS = [
  // Near-black / dark neutrals (matches Candidate 02 aesthetic — the world is dark)
  "#1A1A1A", "#0D0D0D", "#1F1F1F", "#181818", "#101010",
  // Deep themed
  "#1F2533", "#2C1F2E", "#1F2E1F", "#2E1F1F",
  // Common pastels (softer orb)
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA", "#D8E5D5",
  // Rare
  "#2C1F5E", "#F5E6A8",
];

function pickBg(h: Buffer): string {
  return BG_COLORS[h[13] % BG_COLORS.length];
}

// ── Main builder ──
export function buildFaceGrid(personalityHash: Buffer, variationHash: Buffer): Grid {
  const grid = newGrid();
  const pH = personalityHash;
  const vH = variationHash;

  const shell = SHELL_COLORS[pH[0] % SHELL_COLORS.length];
  const darkShell = darkenHex(shell, 0.25);
  const pattern = pickPattern(pH);
  const claw = pickClaw(pH);
  const eye = pickEye(pH);
  const wear = pickEyewear(pH);

  const item = pickItem(vH);
  const hat = pickHat(vH);
  const mouth = pickMouth(vH);

  // Layer 1+2: base silhouette with 2-tone
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const ch = CRAB_BASE[r][c];
      if (ch === "L") grid[r][c] = shell;
      else if (ch === "D") grid[r][c] = darkShell;
    }
  }

  applyPattern(grid, pattern, shell, pH);
  applyClaw(grid, claw, shell);
  applyHeldItem(grid, item);
  applyEyes(grid, eye);
  applyEyewear(grid, wear);
  applyHat(grid, hat, vH);
  applyMouth(grid, mouth);

  return grid;
}

// ── Palette ──
export interface Palette {
  bg: string;
}

export function hashToPalette(personalityHash: Buffer, _variationHash: Buffer): Palette {
  return { bg: pickBg(personalityHash) };
}

// ── Render ──
export function renderFaceSVG(grid: Grid, palette: Palette): string {
  const SIZE = 512;
  const FACE_PX = 448; // 448 / 28 = 16 (clean 16px per cell)
  const PIXEL = FACE_PX / GRID_SIZE;
  const OFFSET = (SIZE - FACE_PX) / 2;

  const pixels: string[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const color = grid[r][c];
      if (!color) continue;
      pixels.push(
        `<rect x="${OFFSET + c * PIXEL}" y="${OFFSET + r * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`,
      );
    }
  }

  const bgLight = palette.bg;
  const bgDark = darkenHex(bgLight, 0.3);

  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <radialGradient id="orbBg" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${bgLight}" stop-opacity="1"/>
      <stop offset="55%" stop-color="${bgLight}" stop-opacity="0.94"/>
      <stop offset="100%" stop-color="${bgDark}" stop-opacity="1"/>
    </radialGradient>
    <radialGradient id="highlight" cx="28%" cy="22%" r="30%">
      <stop offset="0%" stop-color="white" stop-opacity="0.35"/>
      <stop offset="45%" stop-color="white" stop-opacity="0.08"/>
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

// ── Hash helpers (unchanged) ──
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
