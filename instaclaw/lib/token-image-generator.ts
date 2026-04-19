/**
 * Pure face generation — no env/DB dependencies.
 *
 * 6 layered components composed from hash bytes:
 *   1. Face shape (4: oval/round/slim/square)
 *   2. Hair style (15 variations incl. bald) + hair color (20 colors w/ bold reds/pinks/blues/purples)
 *   3. Eyes (5 styles)
 *   4. Mouth (5 styles)
 *   5. Facial hair (5 options)
 *   6. Accessories toggled by hash[9]/hash[12] bits:
 *      hat, glasses, blush, freckles, earring, mole, horns, scar, halo, eyepatch
 *
 * ~45M structural × billions of color combos = unique face per agent.
 *
 * Grid is 10×10. Rendered inside a 512×512 glass orb via SVG.
 */

// ── Grid primitives ──
export type Grid = string[][];
export const GRID_SIZE = 10;

function emptyGrid(): Grid {
  return Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(" "));
}

function setPixel(grid: Grid, col: number, row: number, char: string): void {
  if (col >= 0 && col < GRID_SIZE && row >= 0 && row < GRID_SIZE) {
    grid[row][col] = char;
  }
}

// ── Face shapes ──
interface FaceShape {
  skin: Array<[number, number] | null>;
  eyeRow: number;
  mouthRow: number;
  leftEyeCol: number;
  rightEyeCol: number;
  mouthCenterCol: number;
}

const FACE_SHAPES: FaceShape[] = [
  // 0: Oval
  {
    skin: [null, null, [2, 7], [2, 7], [2, 7], [2, 7], [2, 7], [3, 6], null, null],
    eyeRow: 4, mouthRow: 6, leftEyeCol: 3, rightEyeCol: 6, mouthCenterCol: 4,
  },
  // 1: Round (wider middle)
  {
    skin: [null, null, [2, 7], [1, 8], [1, 8], [1, 8], [2, 7], [3, 6], null, null],
    eyeRow: 4, mouthRow: 6, leftEyeCol: 3, rightEyeCol: 6, mouthCenterCol: 4,
  },
  // 2: Slim (narrow)
  {
    skin: [null, null, [3, 6], [3, 6], [3, 6], [3, 6], [3, 6], [4, 5], null, null],
    eyeRow: 4, mouthRow: 6, leftEyeCol: 3, rightEyeCol: 6, mouthCenterCol: 4,
  },
  // 3: Square (strong jaw)
  {
    skin: [null, null, [2, 7], [2, 7], [2, 7], [2, 7], [2, 7], [2, 7], null, null],
    eyeRow: 4, mouthRow: 6, leftEyeCol: 3, rightEyeCol: 6, mouthCenterCol: 4,
  },
];

// ── Hair styles (10×10 overlays — 'h' = hair, ' ' = no change) ──
interface HairStyle {
  pattern: string[];
  bald?: boolean;
}

const HAIR_STYLES: HairStyle[] = [
  // 0: Short classic
  { pattern: [
    "   hhhh   ",
    "  hhhhhh  ",
    "  hhhhhh  ",
    "  h    h  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 1: Crew cut
  { pattern: [
    "          ",
    "   hhhh   ",
    "  hhhhhh  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 2: Buzz
  { pattern: [
    "          ",
    "          ",
    "  hhhhhh  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 3: Spiky
  { pattern: [
    " h hhhh h ",
    "  hhhhhh  ",
    "  hhhhhh  ",
    "  h    h  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 4: Mohawk
  { pattern: [
    "    hh    ",
    "    hh    ",
    "    hh    ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 5: Side part
  { pattern: [
    "  hhhhh   ",
    " hhhhhhh  ",
    " hhhhhhh  ",
    "  h    h  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 6: Afro
  { pattern: [
    " hhhhhhhh ",
    "hhhhhhhhhh",
    "hhhhhhhhhh",
    "hh      hh",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 7: Long hair (flowing)
  { pattern: [
    "   hhhh   ",
    "  hhhhhh  ",
    "  hhhhhh  ",
    " h      h ",
    " h      h ",
    " h      h ",
    " h      h ",
    " hh    hh ",
    "          ",
    "          ",
  ] },
  // 8: Pigtails
  { pattern: [
    " h  hh  h ",
    " h hhhh h ",
    "  hhhhhh  ",
    "hh      hh",
    "hh      hh",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 9: Topknot / bun
  { pattern: [
    "    hh    ",
    "   hhhh   ",
    "  hhhhhh  ",
    "  h    h  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 10: Curly
  { pattern: [
    " hhh hhh  ",
    "hhhhhhhhh ",
    "hhhhhhhhh ",
    "  h    h  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 11: Pompadour
  { pattern: [
    "   hhhh   ",
    "  hhhhhh  ",
    " hhhhhhhh ",
    "  h    h  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 12: Bald (scalp gets added as skin)
  { pattern: [
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ], bald: true },
  // 13: Messy
  { pattern: [
    " h hhh hh ",
    "hhhhhhhhh ",
    "  hhhhhh  ",
    "  h    h  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 14: Slicked back
  { pattern: [
    "          ",
    "  hhhhhh  ",
    " hhhhhhhh ",
    " hh    hh ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
];

// ── Hats ──
interface HatStyle {
  pattern: string[];
}

const HATS: HatStyle[] = [
  // 0: Cap (brim on one side)
  { pattern: [
    "   tttt   ",
    "  tttttt  ",
    "tttttttt  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 1: Beanie
  { pattern: [
    "          ",
    "  tttttt  ",
    " tttttttt ",
    "  t    t  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 2: Top hat
  { pattern: [
    "   tttt   ",
    "   tttt   ",
    " tttttttt ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 3: Cowboy hat (wide brim)
  { pattern: [
    "   tttt   ",
    "  tttttt  ",
    "tttttttttt",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 4: Crown
  { pattern: [
    "t  t  t  t",
    "tttttttttt",
    " tttttttt ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 5: Headband
  { pattern: [
    "          ",
    "          ",
    "  tttttt  ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 6: Witch hat (tall pointed)
  { pattern: [
    "    tt    ",
    "   ttt    ",
    " tttttttt ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
  // 7: Hood (covers sides)
  { pattern: [
    "  tttttt  ",
    " tttttttt ",
    " tttttttt ",
    " t      t ",
    " t      t ",
    "          ",
    "          ",
    "          ",
    "          ",
    "          ",
  ] },
];

// ── Eye styles ──
type EyeApply = (grid: Grid, lc: number, rc: number, row: number) => void;

const EYE_STYLES: EyeApply[] = [
  // 0: Dot (default)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row, "e");
    setPixel(grid, rc, row, "e");
  },
  // 1: Tall (2 pixels vertical — big eyes)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row, "e");
    setPixel(grid, rc, row, "e");
    setPixel(grid, lc, row + 1, "e");
    setPixel(grid, rc, row + 1, "e");
  },
  // 2: Sleepy (shifted down one)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row + 1, "e");
    setPixel(grid, rc, row + 1, "e");
  },
  // 3: Wide (extra pixel inward)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row, "e");
    setPixel(grid, lc + 1, row, "e");
    setPixel(grid, rc - 1, row, "e");
    setPixel(grid, rc, row, "e");
  },
  // 4: Winking (left closed horizontal, right open)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row, "e");
    setPixel(grid, lc + 1, row, "e");
    setPixel(grid, rc, row, "e");
  },
];

// ── Mouth styles ──
type MouthApply = (grid: Grid, cc: number, row: number) => void;

const MOUTH_STYLES: MouthApply[] = [
  // 0: Small (2px)
  (grid, cc, row) => {
    setPixel(grid, cc, row, "m");
    setPixel(grid, cc + 1, row, "m");
  },
  // 1: Wide smile (4px)
  (grid, cc, row) => {
    setPixel(grid, cc - 1, row, "m");
    setPixel(grid, cc, row, "m");
    setPixel(grid, cc + 1, row, "m");
    setPixel(grid, cc + 2, row, "m");
  },
  // 2: Tiny (1px)
  (grid, cc, row) => {
    setPixel(grid, cc, row, "m");
  },
  // 3: Teeth smile (corners + bottom lip — reads as open smile with teeth showing)
  (grid, cc, row) => {
    setPixel(grid, cc - 1, row, "m");
    setPixel(grid, cc + 2, row, "m");
    setPixel(grid, cc, row + 1, "m");
    setPixel(grid, cc + 1, row + 1, "m");
  },
  // 4: Smirk (asymmetric right)
  (grid, cc, row) => {
    setPixel(grid, cc + 1, row, "m");
    setPixel(grid, cc + 2, row, "m");
  },
];

// ── Facial hair ──
type FacialApply = (grid: Grid, shape: FaceShape) => void;

const FACIAL_HAIR: FacialApply[] = [
  // 0: None
  () => {},
  // 1: Mustache (row above mouth)
  (grid, shape) => {
    const row = shape.mouthRow - 1;
    setPixel(grid, shape.mouthCenterCol, row, "z");
    setPixel(grid, shape.mouthCenterCol + 1, row, "z");
  },
  // 2: Goatee (below mouth)
  (grid, shape) => {
    const row = shape.mouthRow + 1;
    setPixel(grid, shape.mouthCenterCol, row, "z");
    setPixel(grid, shape.mouthCenterCol + 1, row, "z");
  },
  // 3: Full beard (wraps jaw)
  (grid, shape) => {
    const mouthSkin = shape.skin[shape.mouthRow];
    if (mouthSkin) {
      const [start, end] = mouthSkin;
      for (let c = start; c <= end; c++) {
        if (c === shape.mouthCenterCol || c === shape.mouthCenterCol + 1) continue;
        setPixel(grid, c, shape.mouthRow, "z");
      }
    }
    const chinSkin = shape.skin[shape.mouthRow + 1];
    if (chinSkin) {
      const [start, end] = chinSkin;
      for (let c = start; c <= end; c++) setPixel(grid, c, shape.mouthRow + 1, "z");
    }
  },
  // 4: Chin strap (jaw edges only)
  (grid, shape) => {
    const chinSkin = shape.skin[shape.mouthRow + 1];
    if (chinSkin) {
      const [start, end] = chinSkin;
      setPixel(grid, start, shape.mouthRow + 1, "z");
      setPixel(grid, end, shape.mouthRow + 1, "z");
    }
  },
];

// ── Accessories ──
function applyBlush(grid: Grid, shape: FaceShape): void {
  const row = shape.mouthRow - 1;
  const skinRow = shape.skin[row];
  if (!skinRow) return;
  const [start, end] = skinRow;
  setPixel(grid, start, row, "r");
  setPixel(grid, end, row, "r");
}

function applyFreckles(grid: Grid, shape: FaceShape): void {
  const row = shape.mouthRow - 1;
  const skinRow = shape.skin[row];
  if (!skinRow) return;
  const [start, end] = skinRow;
  setPixel(grid, start + 1, row, "f");
  setPixel(grid, end - 1, row, "f");
  setPixel(grid, 4, shape.eyeRow + 1, "f");
  setPixel(grid, 5, shape.eyeRow + 1, "f");
}

function applyEarring(grid: Grid, shape: FaceShape): void {
  const row = shape.mouthRow;
  const skinRow = shape.skin[row];
  if (!skinRow) return;
  const [, end] = skinRow;
  setPixel(grid, end + 1, row, "o");
}

function applyMole(grid: Grid, shape: FaceShape): void {
  setPixel(grid, shape.mouthCenterCol - 1, shape.mouthRow - 1, "x");
}

function applyHorns(grid: Grid): void {
  // Devil horns: corner pixels that attach to the head's top
  setPixel(grid, 1, 0, "v");
  setPixel(grid, 2, 1, "v");
  setPixel(grid, 8, 0, "v");
  setPixel(grid, 7, 1, "v");
}

function applyScar(grid: Grid, shape: FaceShape): void {
  // Left cheek mark — 2 pixels at leftmost skin edge (avoids earring + mouth conflicts)
  const row1 = shape.eyeRow + 1;
  const row2 = shape.eyeRow + 2;
  const skin1 = shape.skin[row1];
  const skin2 = shape.skin[row2];
  if (skin1) setPixel(grid, skin1[0], row1, "p");
  if (skin2) setPixel(grid, skin2[0], row2, "p");
}

function applyHalo(grid: Grid): void {
  // Gold ring floating above head — ring-shape using 6 pixels
  setPixel(grid, 3, 0, "a");
  setPixel(grid, 4, 0, "a");
  setPixel(grid, 5, 0, "a");
  setPixel(grid, 6, 0, "a");
  setPixel(grid, 2, 0, "a");
  setPixel(grid, 7, 0, "a");
}

function applyEyepatch(grid: Grid, shape: FaceShape): void {
  // Covers left eye entirely
  setPixel(grid, shape.leftEyeCol - 1, shape.eyeRow, "y");
  setPixel(grid, shape.leftEyeCol, shape.eyeRow, "y");
  setPixel(grid, shape.leftEyeCol + 1, shape.eyeRow, "y");
  setPixel(grid, shape.leftEyeCol, shape.eyeRow - 1, "y");
}

function applyGlasses(grid: Grid, shape: FaceShape): void {
  // Frame around eyes, leaving eye pixels visible
  const row = shape.eyeRow;
  const lc = shape.leftEyeCol;
  const rc = shape.rightEyeCol;
  setPixel(grid, lc - 1, row, "g"); // left outer
  setPixel(grid, lc + 1, row, "g"); // bridge left
  setPixel(grid, rc - 1, row, "g"); // bridge right
  setPixel(grid, rc + 1, row, "g"); // right outer
  // Top frame pixels (subtle)
  setPixel(grid, lc, row - 1, "g");
  setPixel(grid, rc, row - 1, "g");
}

function applyShirt(grid: Grid): void {
  setPixel(grid, 4, 8, "s");
  setPixel(grid, 5, 8, "s");
  for (let c = 1; c <= 8; c++) setPixel(grid, c, 9, "b");
}

// ── Build a face grid from hash ──
export function buildFaceGrid(hash: Buffer): Grid {
  const grid = emptyGrid();

  // Face shape
  const shapeIdx = hash[0] % FACE_SHAPES.length;
  const shape = FACE_SHAPES[shapeIdx];

  // 1. Skin
  for (let r = 0; r < GRID_SIZE; r++) {
    const range = shape.skin[r];
    if (range) {
      const [start, end] = range;
      for (let c = start; c <= end; c++) setPixel(grid, c, r, "s");
    }
  }

  // 2. Hair (or bald scalp)
  const hairIdx = hash[1] % HAIR_STYLES.length;
  const hair = HAIR_STYLES[hairIdx];
  if (hair.bald) {
    for (let c = 3; c <= 6; c++) setPixel(grid, c, 0, "s");
    for (let c = 2; c <= 7; c++) setPixel(grid, c, 1, "s");
  }
  for (let r = 0; r < GRID_SIZE; r++) {
    const row = hair.pattern[r];
    for (let c = 0; c < GRID_SIZE; c++) {
      if (row[c] === "h") setPixel(grid, c, r, "h");
    }
  }

  // Accessory bits
  const acc1 = hash[9];
  const hasHat = (acc1 & 0x01) !== 0;
  const hasGlasses = (acc1 & 0x02) !== 0;
  const hasBlush = (acc1 & 0x04) !== 0;
  const hasFreckles = (acc1 & 0x08) !== 0;
  const hasEarring = (acc1 & 0x10) !== 0;
  const hasMole = (acc1 & 0x20) !== 0;
  const hasHorns = (hash[13] & 0x07) === 0;
  const hasScar = (acc1 & 0x80) !== 0;
  const acc2 = hash[12];
  const hasHalo = (acc2 & 0x01) !== 0 && !hasHat && !hasHorns;
  const hasEyepatch = (acc2 & 0x02) !== 0;

  // 3. Hat (overrides hair/scalp)
  if (hasHat) {
    const hatIdx = hash[10] % HATS.length;
    const hat = HATS[hatIdx];
    for (let r = 0; r < GRID_SIZE; r++) {
      const row = hat.pattern[r];
      for (let c = 0; c < GRID_SIZE; c++) {
        if (row[c] === "t") setPixel(grid, c, r, "t");
      }
    }
  }

  // 4. Horns (only if no hat)
  if (hasHorns && !hasHat) applyHorns(grid);

  // 5. Halo (only if no hat/horns)
  if (hasHalo) applyHalo(grid);

  // 6. Eyes
  const eyeStyleIdx = hash[2] % EYE_STYLES.length;
  EYE_STYLES[eyeStyleIdx](grid, shape.leftEyeCol, shape.rightEyeCol, shape.eyeRow);

  // 7. Glasses (overrides eye area)
  if (hasGlasses) applyGlasses(grid, shape);

  // 8. Eyepatch (overrides left eye even through glasses)
  if (hasEyepatch) applyEyepatch(grid, shape);

  // 9. Mouth (slim face → no wide mouth)
  let mouthStyleIdx = hash[3] % MOUTH_STYLES.length;
  if (shapeIdx === 2 && mouthStyleIdx === 1) mouthStyleIdx = 0;
  MOUTH_STYLES[mouthStyleIdx](grid, shape.mouthCenterCol, shape.mouthRow);

  // 10. Facial hair (skip if open mouth)
  const facialHairIdx = hash[4] % FACIAL_HAIR.length;
  if (mouthStyleIdx !== 3) FACIAL_HAIR[facialHairIdx](grid, shape);

  // 11. Accessories
  if (hasBlush) applyBlush(grid, shape);
  if (hasFreckles) applyFreckles(grid, shape);
  if (hasEarring) applyEarring(grid, shape);
  if (hasMole) applyMole(grid, shape);
  if (hasScar) applyScar(grid, shape);

  // 12. Shirt + neck
  applyShirt(grid);

  return grid;
}

// ── Color palettes ──
// Hair: 15 natural + 5 bold = 20 slots (25% bold)
const HAIR_COLORS = [
  "#5C3A1E", "#2C1810", "#1A1A2A", "#D4A017",
  "#6B4226", "#A0522D", "#4A3728", "#C4A45A",
  "#8B6914", "#333333", "#5A5A5A", "#3B2F2F",
  "#7B3F00", "#E8DDB5", "#CCCCCC",
  "#E63946", "#FF69B4", "#3B82F6", "#9D4EDD", "#06A77D",
];

// Skin: 10 natural + 4 fantasy = 14 slots (~28% fantasy)
const SKIN_TONES = [
  "#F5D0A9", "#FADDBA", "#FFE0BD", "#EDC9A3",
  "#D4A574", "#C68642", "#8D6E4C", "#6B4C3B",
  "#9E6B4A", "#5C3A1E",
  "#7DB87D", "#B87DB8", "#7DA8C8", "#D48888",
];

// Eyes: weighted toward natural, some exotic
const EYE_COLORS = [
  "#1A1A1A", "#1A1A1A", "#1A1A1A",
  "#4A3728", "#4A3728",
  "#2E4A6B", "#2E6B4F",
  "#FFD700", "#800080", "#8B0000",
];

const MOUTH_COLORS = [
  "#CC6666", "#B85C5C", "#E8888A",
  "#A0522D", "#D4736C", "#997766", "#C85C5C",
  "#9D4EDD", "#E63946",
];

const SHIRT_COLORS = [
  "#6B8E9B", "#4A6FA5", "#B8860B", "#E8734A",
  "#7CB68E", "#333333", "#9B6B8E", "#5B7553",
  "#4A4A6A", "#5A8FA5", "#8B5A3C", "#4A8F5A",
  "#D4A017", "#5B8DB0", "#E63946", "#06A77D",
  "#9D4EDD", "#FF69B4",
];

const BG_COLORS = [
  "#E8DDD3", "#D5DDE5", "#E5D8C3", "#E0D5CA",
  "#D8E5D5", "#DDDDDD", "#E5D5DE", "#D5E0D5",
  "#D8D5E0", "#D5E0E5", "#E5DFD5", "#DAE0D5",
  "#F5E3D7", "#E7D6F5", "#D6F5E3", "#F5D6D6",
];

const HAT_COLORS = [
  "#2C3E50", "#E74C3C", "#27AE60", "#2980B9",
  "#8B4513", "#333333", "#E67E22", "#9B59B6",
  "#D4A017", "#B85C5C", "#06A77D", "#FF69B4",
];

const EARRING_COLORS = ["#D4A017", "#C0C0C0", "#B87333", "#9D4EDD", "#E63946"];

const BLUSH_COLOR = "#FFB6B6";
const MOLE_COLOR = "#3B2416";
const GLASSES_COLOR = "#1A1A2A";
const HORNS_COLOR = "#8B0000";
const SCAR_COLOR = "#D4736C";
const HALO_COLOR = "#FFD700";
const EYEPATCH_COLOR = "#1A1A1A";

export interface Palette {
  hair: string;
  skin: string;
  eye: string;
  mouth: string;
  shirt: string;
  bg: string;
  hat: string;
  earring: string;
}

export function hashToPalette(hash: Buffer): Palette {
  return {
    hair: HAIR_COLORS[hash[16] % HAIR_COLORS.length],
    skin: SKIN_TONES[hash[17] % SKIN_TONES.length],
    eye: EYE_COLORS[hash[18] % EYE_COLORS.length],
    mouth: MOUTH_COLORS[hash[19] % MOUTH_COLORS.length],
    shirt: SHIRT_COLORS[hash[20] % SHIRT_COLORS.length],
    bg: BG_COLORS[hash[21] % BG_COLORS.length],
    hat: HAT_COLORS[hash[22] % HAT_COLORS.length],
    earring: EARRING_COLORS[hash[23] % EARRING_COLORS.length],
  };
}

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

// ── Render SVG (glass orb container + face) ──
export function renderFaceSVG(grid: Grid, palette: Palette): string {
  const SIZE = 512;
  const FACE_PX = 400;
  const PIXEL = FACE_PX / GRID_SIZE; // 40
  const OFFSET = (SIZE - FACE_PX) / 2;

  const colorMap: Record<string, string> = {
    s: palette.skin,
    h: palette.hair,
    t: palette.hat,
    e: palette.eye,
    g: GLASSES_COLOR,
    m: palette.mouth,
    b: palette.shirt,
    z: darkenHex(palette.hair, 0.2),
    f: darkenHex(palette.skin, 0.35),
    r: BLUSH_COLOR,
    o: palette.earring,
    x: MOLE_COLOR,
    v: HORNS_COLOR,
    p: SCAR_COLOR,
    a: HALO_COLOR,
    y: EYEPATCH_COLOR,
  };

  const pixels: string[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const char = grid[r][c];
      if (char === " ") continue;
      const color = colorMap[char];
      if (!color) continue;
      pixels.push(
        `<rect x="${OFFSET + c * PIXEL}" y="${OFFSET + r * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`,
      );
    }
  }

  const bgLight = palette.bg;
  const bgDark = darkenHex(palette.bg, 0.3);

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
