/**
 * Token PFP generation — 24×24 CryptoPunks-style crab generator.
 *
 * Every agent gets a pixel art crab matching the InstaClaw logo silhouette.
 * 9 composable trait layers driven by two hashes:
 *
 *   personalityHash (LOCKED — stays constant across regens of same agent):
 *     - Shell color
 *     - Body pattern (solid/stripes/spots/camo/galaxy)
 *     - Claw variant (default/gold_tipped/full_gold/full_diamond/asymmetric)
 *     - Eye style (dot/wide/angry/sleepy/hearts/dollar/x_eyes/laser)
 *     - Eyewear (sunglasses/glasses/3d/monocle/laser_visor/eyepatch/vr)
 *     - Background hue
 *
 *   variationHash (VARIES per regen — the agent's "outfit today"):
 *     - Held item (coffee/money_bag/laptop/phone/sword/trophy/briefcase/pizza/diamond)
 *     - Hat (baseball/beanie/cowboy/top_hat/crown/chef/party/headphones/halo/devil_horns)
 *     - Hat color
 *     - Mouth accessory (cigarette/pipe/gum/gold_tooth/tongue)
 *
 * Result: regens of the same agent look like the same crab in different outfits.
 */

// ── Grid primitives ──
export type Grid = (string | null)[][];
export const GRID_SIZE = 24;

function newGrid(): Grid {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(null));
}

function setPx(g: Grid, x: number, y: number, color: string): void {
  if (x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE) {
    g[y][x] = color;
  }
}

// ── Base silhouette (v7 — canonical InstaClaw crab) ──
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

function isClawPixel(c: number, r: number): boolean {
  return r >= 3 && r <= 11 && CRAB_BASE[r][c] === "#";
}
function isBodyPixel(c: number, r: number): boolean {
  return r >= 12 && r <= 19 && CRAB_BASE[r][c] === "#";
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

// ── Layer 1: Shell color palette (20 slots, rarity via palette position) ──
const SHELL_COLORS = [
  // Common natural (12)
  "#C94A3F", "#8B2E23", "#E67E22", "#DC143C", "#FF6F61",
  "#A0522D", "#B22222", "#CD5C5C", "#F08080", "#FA8072",
  "#D2691E", "#CD853F",
  // Uncommon fantasy (5)
  "#3B82F6", "#06A77D", "#9D4EDD", "#FF69B4", "#20C997",
  // Rare metallic (3)
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

function applyPattern(grid: Grid, pattern: Pattern, shell: string, h: Buffer): void {
  if (pattern === "solid") return;
  const patternColor = darkenHex(shell, 0.35);
  if (pattern === "stripes") {
    for (const r of [13, 15, 17]) {
      for (let c = 0; c < GRID_SIZE; c++) if (isBodyPixel(c, r)) setPx(grid, c, r, patternColor);
    }
  } else if (pattern === "spots") {
    const numSpots = 6 + (h[5] % 3);
    for (let i = 0; i < numSpots; i++) {
      const r = 12 + (h[(10 + i) % 32] % 8);
      const c = 2 + (h[(18 + i) % 32] % 20);
      if (isBodyPixel(c, r)) setPx(grid, c, r, patternColor);
    }
  } else if (pattern === "camo") {
    const patches: Array<[number, number]> = [[3, 13], [10, 14], [17, 15], [6, 17], [14, 18]];
    for (const [sc, sr] of patches) {
      for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
        const c = sc + dc, r = sr + dr;
        if (isBodyPixel(c, r)) setPx(grid, c, r, patternColor);
      }
    }
  } else if (pattern === "galaxy") {
    for (let r = 12; r <= 19; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isBodyPixel(c, r) && (r + c) % 2 === 0) setPx(grid, c, r, patternColor);
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

function applyClaw(grid: Grid, variant: ClawVariant, shell: string): void {
  if (variant === "default") return;
  if (variant === "gold_tipped") {
    const gold = "#FFD700";
    for (let r = 3; r <= 4; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(grid, c, r, gold);
    }
  } else if (variant === "full_gold") {
    const gold = "#FFD700";
    for (let r = 3; r <= 11; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(grid, c, r, gold);
    }
  } else if (variant === "full_diamond") {
    const dia = "#CFF5FF";
    for (let r = 3; r <= 11; r++) for (let c = 0; c < GRID_SIZE; c++) {
      if (isClawPixel(c, r)) setPx(grid, c, r, dia);
    }
    setPx(grid, 3, 4, "#FFFFFF");
    setPx(grid, 20, 4, "#FFFFFF");
    setPx(grid, 4, 8, "#FFFFFF");
    setPx(grid, 19, 8, "#FFFFFF");
  } else if (variant === "asymmetric") {
    // LEFT claw oversized (fiddler-crab), RIGHT claw shrunk
    const bigColor = darkenHex(shell, 0.15);
    setPx(grid, 1, 3, bigColor); setPx(grid, 1, 4, bigColor);
    setPx(grid, 1, 5, bigColor); setPx(grid, 1, 6, bigColor);
    for (let c = 3; c <= 9; c++) setPx(grid, c, 2, bigColor);
    grid[3][20] = null; grid[4][20] = null;
    grid[8][20] = null; grid[9][20] = null;
    grid[3][19] = null; grid[4][19] = null;
  }
}

// ── Layer 4: Held items (VARIES per regen) ──
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

function applyHeldItem(grid: Grid, item: HeldItem): void {
  if (item === "none") return;
  const box = (c1: number, c2: number, r1: number, r2: number, color: string) => {
    for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) setPx(grid, c, r, color);
  };

  if (item === "coffee") {
    const cup = "#5A2E10", rim = "#8B5A30", handle = "#3A1E08";
    box(9, 13, 5, 7, cup);
    box(9, 13, 4, 4, rim);
    setPx(grid, 14, 5, handle); setPx(grid, 14, 6, handle);
    setPx(grid, 10, 3, "#F5F5F5"); setPx(grid, 12, 3, "#F5F5F5");
  } else if (item === "money_bag") {
    const bag = "#5A3E12", tie = "#3A2608", dollar = "#2EA040";
    setPx(grid, 10, 4, tie); setPx(grid, 11, 4, tie); setPx(grid, 12, 4, tie);
    box(9, 14, 5, 7, bag);
    box(11, 12, 5, 7, dollar);
  } else if (item === "laptop") {
    const casing = "#2A2A2A", screen = "#4AC8FF", app = "#FFFFFF";
    box(8, 15, 3, 3, casing);
    box(9, 14, 4, 5, screen);
    setPx(grid, 11, 4, app); setPx(grid, 12, 4, app);
    box(8, 15, 6, 6, casing);
    box(9, 14, 7, 7, "#404040");
  } else if (item === "phone") {
    const casing = "#1A1A1A", screen = "#4AC8FF";
    box(10, 13, 3, 7, casing);
    box(11, 12, 4, 6, screen);
    setPx(grid, 11, 3, casing); setPx(grid, 12, 3, casing);
    setPx(grid, 11, 7, "#404040");
  } else if (item === "sword") {
    const blade = "#D0D0E0", edge = "#FFFFFF", hilt = "#8B4513", grip = "#3A1E08";
    setPx(grid, 11, 0, edge);
    box(11, 12, 1, 5, blade);
    setPx(grid, 11, 1, edge);
    box(9, 14, 6, 6, hilt);
    box(11, 12, 7, 7, grip);
  } else if (item === "trophy") {
    const gold = "#FFD700", deep = "#C89B0A";
    box(9, 14, 3, 3, gold);
    box(10, 13, 4, 5, gold);
    setPx(grid, 8, 4, gold); setPx(grid, 15, 4, gold);
    setPx(grid, 11, 6, deep); setPx(grid, 12, 6, deep);
    box(10, 13, 7, 7, gold);
  } else if (item === "briefcase") {
    const leather = "#3A1E08", strap = "#1A0A00", lock = "#FFD700";
    setPx(grid, 10, 3, strap); setPx(grid, 11, 3, strap);
    setPx(grid, 12, 3, strap); setPx(grid, 13, 3, strap);
    box(9, 14, 4, 7, leather);
    for (let c = 9; c <= 14; c++) setPx(grid, c, 5, "#2A1404");
    setPx(grid, 11, 6, lock); setPx(grid, 12, 6, lock);
  } else if (item === "pizza") {
    const crust = "#C08040", cheese = "#F4D04D", pep = "#C94A3F";
    setPx(grid, 11, 3, cheese); setPx(grid, 12, 3, cheese);
    box(10, 13, 4, 5, cheese);
    box(9, 14, 6, 6, cheese);
    setPx(grid, 10, 5, pep); setPx(grid, 13, 5, pep); setPx(grid, 11, 6, pep);
    box(9, 14, 7, 7, crust);
  } else if (item === "diamond") {
    const dia = "#7FE6FF", shine = "#FFFFFF", deep = "#3088B3";
    setPx(grid, 11, 3, dia); setPx(grid, 12, 3, dia);
    setPx(grid, 10, 4, dia); setPx(grid, 11, 4, shine); setPx(grid, 12, 4, shine); setPx(grid, 13, 4, dia);
    for (let c = 9; c <= 14; c++) setPx(grid, c, 5, dia);
    box(10, 13, 6, 6, dia);
    setPx(grid, 11, 7, deep); setPx(grid, 12, 7, deep);
    setPx(grid, 10, 5, shine);
  }
}

// ── Layer 5: Eyes (LOCKED to personality) ──
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

function applyEyes(grid: Grid, style: EyeStyle): void {
  const black = "#1A1A1A", red = "#E63946", green = "#2EA040";
  const lx = 8, rx = 15, er = 14;

  if (style === "dot") {
    setPx(grid, lx, er, black);
    setPx(grid, rx, er, black);
  } else if (style === "wide") {
    setPx(grid, lx - 1, er - 1, black); setPx(grid, lx, er - 1, black);
    setPx(grid, lx - 1, er, black); setPx(grid, lx, er, black);
    setPx(grid, rx, er - 1, black); setPx(grid, rx + 1, er - 1, black);
    setPx(grid, rx, er, black); setPx(grid, rx + 1, er, black);
  } else if (style === "angry") {
    setPx(grid, lx - 1, er - 1, black);
    setPx(grid, lx, er, black);
    setPx(grid, rx, er, black);
    setPx(grid, rx + 1, er - 1, black);
  } else if (style === "sleepy") {
    setPx(grid, lx - 1, er, black); setPx(grid, lx, er, black);
    setPx(grid, rx, er, black); setPx(grid, rx + 1, er, black);
  } else if (style === "hearts") {
    const heart = (cx: number, cy: number) => {
      setPx(grid, cx - 1, cy - 1, red); setPx(grid, cx + 1, cy - 1, red);
      setPx(grid, cx - 1, cy, red); setPx(grid, cx, cy, red); setPx(grid, cx + 1, cy, red);
      setPx(grid, cx, cy + 1, red);
    };
    heart(lx, er); heart(rx, er);
  } else if (style === "dollar") {
    const dollar = (cx: number, cy: number) => {
      setPx(grid, cx, cy - 1, green);
      setPx(grid, cx - 1, cy, green); setPx(grid, cx, cy, green); setPx(grid, cx + 1, cy, green);
      setPx(grid, cx, cy + 1, green);
    };
    dollar(lx, er); dollar(rx, er);
  } else if (style === "x_eyes") {
    const x = (cx: number, cy: number) => {
      setPx(grid, cx - 1, cy - 1, black); setPx(grid, cx + 1, cy - 1, black);
      setPx(grid, cx, cy, black);
      setPx(grid, cx - 1, cy + 1, black); setPx(grid, cx + 1, cy + 1, black);
    };
    x(lx, er); x(rx, er);
  } else if (style === "laser") {
    for (let c = 4; c <= 19; c++) setPx(grid, c, er, red);
    setPx(grid, lx, er - 1, red); setPx(grid, rx, er - 1, red);
    setPx(grid, lx, er + 1, red); setPx(grid, rx, er + 1, red);
  }
}

// ── Layer 6: Eyewear (LOCKED to personality) ──
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

function applyEyewear(grid: Grid, wear: Eyewear): void {
  if (wear === "none") return;
  const dark = "#1A1A1A", gold = "#FFD700", red = "#E63946", cyan = "#06A77D";
  const lx = 8, rx = 15, er = 14;

  if (wear === "sunglasses") {
    for (let c = lx - 1; c <= lx + 1; c++) { setPx(grid, c, er - 1, dark); setPx(grid, c, er, dark); }
    for (let c = rx - 1; c <= rx + 1; c++) { setPx(grid, c, er - 1, dark); setPx(grid, c, er, dark); }
    for (let c = lx + 2; c <= rx - 2; c++) setPx(grid, c, er - 1, dark);
  } else if (wear === "glasses") {
    for (let c = lx - 1; c <= lx + 1; c++) setPx(grid, c, er - 1, dark);
    setPx(grid, lx - 1, er, dark); setPx(grid, lx + 1, er, dark);
    setPx(grid, lx - 1, er + 1, dark); setPx(grid, lx + 1, er + 1, dark);
    for (let c = rx - 1; c <= rx + 1; c++) setPx(grid, c, er - 1, dark);
    setPx(grid, rx - 1, er, dark); setPx(grid, rx + 1, er, dark);
    setPx(grid, rx - 1, er + 1, dark); setPx(grid, rx + 1, er + 1, dark);
    for (let c = lx + 2; c <= rx - 2; c++) setPx(grid, c, er, dark);
  } else if (wear === "3d_glasses") {
    for (let c = lx - 1; c <= lx + 1; c++) { setPx(grid, c, er - 1, red); setPx(grid, c, er, red); }
    for (let c = rx - 1; c <= rx + 1; c++) { setPx(grid, c, er - 1, cyan); setPx(grid, c, er, cyan); }
    setPx(grid, lx - 1, er - 1, dark); setPx(grid, rx + 1, er - 1, dark);
  } else if (wear === "monocle") {
    setPx(grid, rx - 1, er - 1, gold); setPx(grid, rx, er - 1, gold); setPx(grid, rx + 1, er - 1, gold);
    setPx(grid, rx - 1, er, gold); setPx(grid, rx + 1, er, gold);
    setPx(grid, rx, er + 1, gold); setPx(grid, rx - 1, er + 1, gold); setPx(grid, rx + 1, er + 1, gold);
    setPx(grid, rx + 2, er, gold); setPx(grid, rx + 2, er + 1, gold);
  } else if (wear === "laser_visor") {
    for (let c = 6; c <= 17; c++) {
      setPx(grid, c, er - 1, dark);
      setPx(grid, c, er, red);
    }
  } else if (wear === "eyepatch") {
    for (let c = lx - 2; c <= lx + 2; c++) {
      setPx(grid, c, er - 1, dark);
      setPx(grid, c, er, dark);
      setPx(grid, c, er + 1, dark);
    }
    setPx(grid, lx - 2, er - 2, dark); setPx(grid, lx - 3, er - 2, dark);
  } else if (wear === "vr_headset") {
    for (let c = 5; c <= 18; c++) {
      setPx(grid, c, er - 2, dark);
      setPx(grid, c, er - 1, dark);
      setPx(grid, c, er, dark);
    }
    for (let c = 6; c <= 17; c++) setPx(grid, c, er, cyan);
  }
}

// ── Layer 7: Hats (VARIES per regen) ──
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

function applyHat(grid: Grid, hat: Hat, h: Buffer): void {
  if (hat === "none") return;
  const HAT_COLORS = ["#2C3E50", "#E74C3C", "#27AE60", "#F39C12", "#8E44AD", "#16A085", "#C0392B"];
  const hatColor = HAT_COLORS[h[11] % HAT_COLORS.length];
  const dark = "#1A1A1A", gold = "#FFD700", white = "#F5F5F5";

  if (hat === "baseball") {
    for (let c = 9; c <= 14; c++) setPx(grid, c, 10, hatColor);
    for (let c = 8; c <= 15; c++) setPx(grid, c, 11, hatColor);
    for (let c = 3; c <= 15; c++) setPx(grid, c, 12, hatColor);
  } else if (hat === "beanie") {
    for (let c = 9; c <= 14; c++) setPx(grid, c, 8, hatColor);
    for (let c = 8; c <= 15; c++) setPx(grid, c, 9, hatColor);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 10, hatColor);
    for (let c = 6; c <= 17; c++) setPx(grid, c, 11, hatColor);
    const band = darkenHex(hatColor, 0.3);
    for (let c = 6; c <= 17; c++) setPx(grid, c, 12, band);
    setPx(grid, 11, 7, white); setPx(grid, 12, 7, white);
  } else if (hat === "cowboy") {
    for (let c = 9; c <= 14; c++) setPx(grid, c, 9, hatColor);
    for (let c = 8; c <= 15; c++) setPx(grid, c, 10, hatColor);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 11, hatColor);
    for (let c = 3; c <= 20; c++) setPx(grid, c, 12, hatColor);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 11, darkenHex(hatColor, 0.4));
    for (let c = 8; c <= 15; c++) setPx(grid, c, 10, hatColor);
  } else if (hat === "top_hat") {
    for (let r = 6; r <= 10; r++) for (let c = 9; c <= 14; c++) setPx(grid, c, r, dark);
    for (let c = 9; c <= 14; c++) setPx(grid, c, 10, hatColor);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 11, dark);
    for (let c = 6; c <= 17; c++) setPx(grid, c, 12, dark);
  } else if (hat === "crown") {
    setPx(grid, 8, 9, gold); setPx(grid, 11, 9, gold); setPx(grid, 14, 9, gold);
    setPx(grid, 9, 10, gold); setPx(grid, 12, 10, gold); setPx(grid, 15, 10, gold);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 11, gold);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 12, gold);
    setPx(grid, 9, 11, "#E63946"); setPx(grid, 14, 11, "#3B82F6");
  } else if (hat === "chef") {
    for (let c = 8; c <= 15; c++) setPx(grid, c, 7, white);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 8, white);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 9, white);
    for (let c = 8; c <= 15; c++) setPx(grid, c, 10, white);
    for (let c = 8; c <= 15; c++) setPx(grid, c, 11, white);
    for (let c = 8; c <= 15; c++) setPx(grid, c, 12, white);
  } else if (hat === "party") {
    setPx(grid, 11, 7, hatColor); setPx(grid, 12, 7, hatColor);
    setPx(grid, 10, 8, hatColor); setPx(grid, 11, 8, hatColor); setPx(grid, 12, 8, hatColor); setPx(grid, 13, 8, hatColor);
    for (let c = 9; c <= 14; c++) setPx(grid, c, 9, hatColor);
    for (let c = 8; c <= 15; c++) setPx(grid, c, 10, hatColor);
    for (let c = 7; c <= 16; c++) setPx(grid, c, 11, hatColor);
    setPx(grid, 10, 9, white); setPx(grid, 13, 9, white);
    setPx(grid, 9, 10, white); setPx(grid, 14, 10, white);
    setPx(grid, 11, 6, white);
  } else if (hat === "headphones") {
    for (let c = 8; c <= 15; c++) setPx(grid, c, 8, dark);
    setPx(grid, 7, 9, dark); setPx(grid, 16, 9, dark);
    setPx(grid, 6, 10, dark); setPx(grid, 7, 10, dark);
    setPx(grid, 6, 11, dark); setPx(grid, 7, 11, dark);
    setPx(grid, 16, 10, dark); setPx(grid, 17, 10, dark);
    setPx(grid, 16, 11, dark); setPx(grid, 17, 11, dark);
    setPx(grid, 6, 10, hatColor); setPx(grid, 17, 10, hatColor);
  } else if (hat === "halo") {
    for (let c = 8; c <= 15; c++) setPx(grid, c, 5, gold);
    setPx(grid, 7, 5, gold); setPx(grid, 16, 5, gold);
    setPx(grid, 7, 6, gold); setPx(grid, 16, 6, gold);
  } else if (hat === "devil_horns") {
    const horn = "#8B0000";
    setPx(grid, 9, 8, horn); setPx(grid, 10, 8, horn);
    setPx(grid, 10, 9, horn);
    setPx(grid, 13, 9, horn);
    setPx(grid, 13, 8, horn); setPx(grid, 14, 8, horn);
    setPx(grid, 9, 7, horn); setPx(grid, 14, 7, horn);
  }
}

// ── Layer 8: Mouth accessories (VARIES per regen) ──
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

function applyMouth(grid: Grid, mouth: Mouth): void {
  if (mouth === "none") return;
  const white = "#F5F5F5", red = "#E63946", brown = "#4A2408";
  const pink = "#FF69B4", gold = "#FFD700";

  if (mouth === "cigarette") {
    for (let c = 13; c <= 17; c++) setPx(grid, c, 17, white);
    setPx(grid, 18, 17, red);
    setPx(grid, 18, 16, "#A0A0A0");
    setPx(grid, 19, 15, "#A0A0A0");
  } else if (mouth === "pipe") {
    setPx(grid, 13, 17, brown); setPx(grid, 14, 17, brown); setPx(grid, 15, 17, brown);
    setPx(grid, 15, 18, brown); setPx(grid, 16, 18, brown);
    setPx(grid, 15, 16, "#FF9800");
  } else if (mouth === "gum") {
    setPx(grid, 12, 17, pink); setPx(grid, 13, 17, pink);
    setPx(grid, 12, 18, pink); setPx(grid, 13, 18, pink);
    setPx(grid, 12, 17, "#FFB8D9");
  } else if (mouth === "gold_tooth") {
    setPx(grid, 11, 17, gold);
  } else if (mouth === "tongue") {
    setPx(grid, 11, 17, pink); setPx(grid, 12, 17, pink);
    setPx(grid, 11, 18, pink); setPx(grid, 12, 18, pink);
  }
}

// ── Layer 9: Backgrounds (LOCKED to personality) ──
const BG_COLORS = [
  // Common pastels (10)
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA",
  "#D8E5D5", "#DDDDDD", "#E5D5DE", "#D5E0D5",
  "#D8D5E0", "#D5E0E5",
  // Themed (5)
  "#F5D7B0", "#C7E1F5", "#D5E8C4", "#F5C7E1", "#E1D5F5",
  // Rare (3)
  "#2C1F5E", "#F5E6A8", "#1F1F1F",
];

// ── Main builder: two-hash split (personality-locked + variation) ──
// LOCKED (personalityHash): shell / pattern / claws / eyes / eyewear / bg
// VARIES (variationHash):   held item / hat / mouth
export function buildFaceGrid(personalityHash: Buffer, variationHash: Buffer): Grid {
  const grid = newGrid();
  const pH = personalityHash;
  const vH = variationHash;

  // LOCKED TRAITS — the agent's identity
  const shell = SHELL_COLORS[pH[0] % SHELL_COLORS.length];
  const pattern = pickPattern(pH);
  const claw = pickClaw(pH);
  const eye = pickEye(pH);
  const wear = pickEyewear(pH);

  // VARYING TRAITS — the agent's outfit today
  const item = pickItem(vH);
  const hat = pickHat(vH);
  const mouth = pickMouth(vH);

  // Layer 1: shell color on all base pixels
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      if (CRAB_BASE[r][c] === "#") grid[r][c] = shell;
    }
  }

  // Layer 2: pattern overlay on body
  applyPattern(grid, pattern, shell, pH);

  // Layer 3: claw color override
  applyClaw(grid, claw, shell);

  // Layer 4: held item in pincer grip
  applyHeldItem(grid, item);

  // Layer 5: eyes
  applyEyes(grid, eye);

  // Layer 6: eyewear on top of eyes
  applyEyewear(grid, wear);

  // Layer 7: hat (pass vH for color variation)
  applyHat(grid, hat, vH);

  // Layer 8: mouth accessory
  applyMouth(grid, mouth);

  return grid;
}

// ── Palette (backward-compat: only bg is used — all other colors are baked into the grid) ──
export interface Palette {
  bg: string;
}

export function hashToPalette(personalityHash: Buffer, _variationHash: Buffer): Palette {
  return {
    bg: BG_COLORS[personalityHash[13] % BG_COLORS.length],
  };
}

// ── Render Grid to SVG (glass orb aesthetic) ──
export function renderFaceSVG(grid: Grid, palette: Palette): string {
  const SIZE = 512;
  const FACE_PX = 384; // 384 / 24 = 16px per grid cell (clean arithmetic)
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

// ── Hash helpers (unchanged from face version) ──
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
