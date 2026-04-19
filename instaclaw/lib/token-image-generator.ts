/**
 * Token PFP generation — 16×16 layered procedural face generator.
 *
 * Two-hash split architecture:
 *   - personalityHash: derived from SOUL.md + MEMORY.md. Locks face identity
 *     (shape, skin, eye color/style, hair color, glasses, mole, hat presence,
 *     horns, halo, eyepatch). CONSTANT across regenerations of the same agent.
 *   - variationHash:   sha256(personalityHash + variation). Varies surface
 *     traits (hair style, hat style, mouth expression, facial hair, blush,
 *     freckles, earring, scar). CHANGES each regeneration.
 *
 * Result: regens of the same agent look like the same character in different
 * outfits. Different agents look like distinct characters.
 *
 * Grid: 16×16 pixels rendered inside a 512×512 glass orb.
 */

// ── Grid primitives ──
export type Grid = string[][];
export const GRID_SIZE = 16;

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
  eyeRow: number;          // top row of eyes (eyes span eyeRow, eyeRow+1)
  mouthRow: number;
  leftEyeCol: number;      // leftmost col of left eye (eyes are 2 wide)
  rightEyeCol: number;     // leftmost col of right eye
  mouthCenterCol: number;  // leftmost col of mouth center (mouth base is 2 wide)
}

const FACE_SHAPES: FaceShape[] = [
  // 0: Oval
  {
    skin: [
      null, null,
      [5, 10],
      [4, 11],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [4, 11],
      [5, 10],
      [7, 8],
      null,
    ],
    eyeRow: 6, mouthRow: 11, leftEyeCol: 5, rightEyeCol: 9, mouthCenterCol: 7,
  },
  // 1: Round (wider middle)
  {
    skin: [
      null, null,
      [5, 10],
      [4, 11],
      [3, 12],
      [2, 13],
      [2, 13],
      [2, 13],
      [2, 13],
      [2, 13],
      [3, 12],
      [3, 12],
      [4, 11],
      [5, 10],
      [7, 8],
      null,
    ],
    eyeRow: 6, mouthRow: 11, leftEyeCol: 5, rightEyeCol: 9, mouthCenterCol: 7,
  },
  // 2: Slim
  {
    skin: [
      null, null,
      [6, 9],
      [5, 10],
      [4, 11],
      [4, 11],
      [4, 11],
      [4, 11],
      [4, 11],
      [4, 11],
      [4, 11],
      [4, 11],
      [5, 10],
      [6, 9],
      [7, 8],
      null,
    ],
    eyeRow: 6, mouthRow: 11, leftEyeCol: 5, rightEyeCol: 9, mouthCenterCol: 7,
  },
  // 3: Square (strong jaw)
  {
    skin: [
      null, null,
      [4, 11],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [3, 12],
      [7, 8],
      null,
    ],
    eyeRow: 6, mouthRow: 11, leftEyeCol: 5, rightEyeCol: 9, mouthCenterCol: 7,
  },
];

// ── Hair styles (16×16 patterns) ──
interface HairStyle {
  pattern: string[];
  bald?: boolean;
}

const HAIR_STYLES: HairStyle[] = [
  // 0: Short classic
  { pattern: [
    "................",
    ".....hhhhhh.....",
    "....hhhhhhhh....",
    "...hhhhhhhhhh...",
    "...h........h...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 1: Crew cut
  { pattern: [
    "................",
    "................",
    "....hhhhhhhh....",
    "...hhhhhhhhhh...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 2: Buzz (very minimal)
  { pattern: [
    "................",
    "................",
    "................",
    "....hhhhhhhh....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 3: Spiky
  { pattern: [
    "................",
    "..h.h.hhhh.h.h..",
    "...hhhhhhhhhh...",
    "...hhhhhhhhhh...",
    "...h........h...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 4: Mohawk
  { pattern: [
    "......hhhh......",
    "......hhhh......",
    "......hhhh......",
    "......hhhh......",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 5: Side part (asymmetric left-heavy)
  { pattern: [
    "................",
    "...hhhhhhh......",
    "..hhhhhhhhh.....",
    "..hhhhhhhhhh....",
    "..h.........h...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 6: Afro (big rounded hair)
  { pattern: [
    "..hhhhhhhhhhhh..",
    ".hhhhhhhhhhhhhh.",
    "hhhhhhhhhhhhhhhh",
    "hhhhhhhhhhhhhhhh",
    "hhh........hhhhh",
    "hh..........hhhh",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 7: Long hair (flows down sides)
  { pattern: [
    "................",
    ".....hhhhhh.....",
    "....hhhhhhhh....",
    "...hhhhhhhhhh...",
    "..hh........hh..",
    "..h..........h..",
    "..h..........h..",
    "..h..........h..",
    "..h..........h..",
    "..h..........h..",
    "..hh........hh..",
    "..hhh......hhh..",
    "..hhh......hhh..",
    "................",
    "................",
    "................",
  ] },
  // 8: Pigtails
  { pattern: [
    ".h...hhhhhh...h.",
    ".hh..hhhhhh..hh.",
    "..hhhhhhhhhhhh..",
    "hhh..........hhh",
    "hhhh........hhhh",
    "hhh..........hhh",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 9: Topknot / bun
  { pattern: [
    "......hhhh......",
    ".....hhhhhh.....",
    "....hhhhhhhh....",
    "...hhhhhhhhhh...",
    "...h........h...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 10: Curly (irregular top)
  { pattern: [
    "..hhh.hhh.hhhh..",
    ".hhhhhhhhhhhhhh.",
    "..hhhhhhhhhhhh..",
    "..hhhhhhhhhhhh..",
    "..h.........h...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 11: Pompadour (tall front)
  { pattern: [
    ".....hhhhh......",
    "....hhhhhhh.....",
    "...hhhhhhhhh....",
    "...hhhhhhhhhh...",
    "...h........h...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 12: Bald
  { pattern: [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ], bald: true },
  // 13: Messy
  { pattern: [
    "...h.hhh.hhh.h..",
    ".hhhhhhhhhhhhhh.",
    "..hhhhhhhhhhhh..",
    "...hhhhhhhhhh...",
    "...h........h...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 14: Slicked back
  { pattern: [
    "................",
    "...hhhhhhhhhh...",
    "..hhhhhhhhhhhh..",
    "..hh........hh..",
    "..h..........h..",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
];

// ── Hat styles ──
interface HatStyle {
  pattern: string[];
}

const HATS: HatStyle[] = [
  // 0: Baseball cap (brim left)
  { pattern: [
    "................",
    ".....tttttt.....",
    "....tttttttt....",
    "tttttttttttt....",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 1: Beanie
  { pattern: [
    "................",
    "....tttttttt....",
    "...tttttttttt...",
    "..tttttttttttt..",
    ".tttttttttttttt.",
    "..t..........t..",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 2: Top hat
  { pattern: [
    ".....tttttt.....",
    ".....tttttt.....",
    ".....tttttt.....",
    "...tttttttttt...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 3: Cowboy hat
  { pattern: [
    "................",
    ".....tttttt.....",
    "....tttttttt....",
    "...tttttttttt...",
    "tttttttttttttttt",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 4: Crown
  { pattern: [
    "....t.t.t.t.t...",
    "....ttttttttt...",
    "....ttttttttt...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 5: Headband
  { pattern: [
    "................",
    "................",
    "................",
    "................",
    "..tttttttttttt..",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 6: Witch hat
  { pattern: [
    ".......tt.......",
    "......tttt......",
    ".....tttttt.....",
    "....tttttttt....",
    "..tttttttttttt..",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
  // 7: Hood
  { pattern: [
    "................",
    "....tttttttt....",
    "..tttttttttttt..",
    ".tttttttttttttt.",
    ".ttt........ttt.",
    ".tt..........tt.",
    ".tt..........tt.",
    ".tt..........tt.",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ] },
];

// ── Eye styles ──
type EyeApply = (grid: Grid, lc: number, rc: number, row: number) => void;

const EYE_STYLES: EyeApply[] = [
  // 0: Standard (2×2 dark block)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row, "e");
    setPixel(grid, lc + 1, row, "e");
    setPixel(grid, lc, row + 1, "e");
    setPixel(grid, lc + 1, row + 1, "e");
    setPixel(grid, rc, row, "e");
    setPixel(grid, rc + 1, row, "e");
    setPixel(grid, rc, row + 1, "e");
    setPixel(grid, rc + 1, row + 1, "e");
  },
  // 1: Big (2×3 — taller)
  (grid, lc, rc, row) => {
    for (let r = 0; r < 3; r++) {
      setPixel(grid, lc, row + r, "e");
      setPixel(grid, lc + 1, row + r, "e");
      setPixel(grid, rc, row + r, "e");
      setPixel(grid, rc + 1, row + r, "e");
    }
  },
  // 2: Sleepy (narrow — only bottom row visible)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row + 1, "e");
    setPixel(grid, lc + 1, row + 1, "e");
    setPixel(grid, rc, row + 1, "e");
    setPixel(grid, rc + 1, row + 1, "e");
  },
  // 3: Wide-apart (eyes pushed outward)
  (grid, lc, rc, row) => {
    setPixel(grid, lc - 2, row, "e");
    setPixel(grid, lc - 1, row, "e");
    setPixel(grid, lc - 2, row + 1, "e");
    setPixel(grid, lc - 1, row + 1, "e");
    setPixel(grid, rc + 2, row, "e");
    setPixel(grid, rc + 3, row, "e");
    setPixel(grid, rc + 2, row + 1, "e");
    setPixel(grid, rc + 3, row + 1, "e");
  },
  // 4: Squint (1 row only — horizontal line)
  (grid, lc, rc, row) => {
    setPixel(grid, lc, row, "e");
    setPixel(grid, lc + 1, row, "e");
    setPixel(grid, rc, row, "e");
    setPixel(grid, rc + 1, row, "e");
  },
];

// ── Mouth styles ──
type MouthApply = (grid: Grid, cc: number, row: number) => void;

const MOUTH_STYLES: MouthApply[] = [
  // 0: Small closed (2 pixels)
  (grid, cc, row) => {
    setPixel(grid, cc, row, "m");
    setPixel(grid, cc + 1, row, "m");
  },
  // 1: Wide smile (4 pixels)
  (grid, cc, row) => {
    setPixel(grid, cc - 1, row, "m");
    setPixel(grid, cc, row, "m");
    setPixel(grid, cc + 1, row, "m");
    setPixel(grid, cc + 2, row, "m");
  },
  // 2: Tiny (1 pixel)
  (grid, cc, row) => {
    setPixel(grid, cc, row, "m");
  },
  // 3: Teeth smile (open mouth with visible teeth gap)
  (grid, cc, row) => {
    // Upper lip
    setPixel(grid, cc - 1, row, "m");
    setPixel(grid, cc, row, "m");
    setPixel(grid, cc + 1, row, "m");
    setPixel(grid, cc + 2, row, "m");
    // Bottom lip (row + 1 middle stays skin — that's the teeth)
    setPixel(grid, cc, row + 1, "m");
    setPixel(grid, cc + 1, row + 1, "m");
  },
  // 4: Smirk (asymmetric, shifted right)
  (grid, cc, row) => {
    setPixel(grid, cc + 1, row, "m");
    setPixel(grid, cc + 2, row, "m");
  },
  // 5: Frown (dips at corners)
  (grid, cc, row) => {
    setPixel(grid, cc, row, "m");
    setPixel(grid, cc + 1, row, "m");
    setPixel(grid, cc - 1, row + 1, "m");
    setPixel(grid, cc + 2, row + 1, "m");
  },
];

// ── Facial hair ──
type FacialApply = (grid: Grid, shape: FaceShape) => void;

const FACIAL_HAIR: FacialApply[] = [
  // 0: None
  () => {},
  // 1: Mustache
  (grid, shape) => {
    const row = shape.mouthRow - 1;
    for (let c = shape.mouthCenterCol - 1; c <= shape.mouthCenterCol + 2; c++) {
      setPixel(grid, c, row, "z");
    }
  },
  // 2: Goatee
  (grid, shape) => {
    const row = shape.mouthRow + 1;
    setPixel(grid, shape.mouthCenterCol, row, "z");
    setPixel(grid, shape.mouthCenterCol + 1, row, "z");
    setPixel(grid, shape.mouthCenterCol, row + 1, "z");
    setPixel(grid, shape.mouthCenterCol + 1, row + 1, "z");
  },
  // 3: Full beard
  (grid, shape) => {
    const mouthSkin = shape.skin[shape.mouthRow];
    if (mouthSkin) {
      const [start, end] = mouthSkin;
      for (let c = start; c <= end; c++) {
        if (c >= shape.mouthCenterCol - 1 && c <= shape.mouthCenterCol + 2) continue;
        setPixel(grid, c, shape.mouthRow, "z");
      }
    }
    for (let r = shape.mouthRow + 1; r <= shape.mouthRow + 2; r++) {
      const chinSkin = shape.skin[r];
      if (chinSkin) {
        const [start, end] = chinSkin;
        for (let c = start; c <= end; c++) setPixel(grid, c, r, "z");
      }
    }
  },
  // 4: Chin strap
  (grid, shape) => {
    for (let r = shape.mouthRow + 1; r <= shape.mouthRow + 2; r++) {
      const chinSkin = shape.skin[r];
      if (chinSkin) {
        const [start, end] = chinSkin;
        setPixel(grid, start, r, "z");
        setPixel(grid, end, r, "z");
      }
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
  setPixel(grid, start + 1, row, "r");
  setPixel(grid, end, row, "r");
  setPixel(grid, end - 1, row, "r");
}

function applyFreckles(grid: Grid, shape: FaceShape): void {
  const row1 = shape.eyeRow + 2;
  const row2 = shape.mouthRow - 2;
  const skin1 = shape.skin[row1];
  const skin2 = shape.skin[row2];
  if (skin1) {
    const [start, end] = skin1;
    setPixel(grid, start + 1, row1, "f");
    setPixel(grid, start + 2, row1, "f");
    setPixel(grid, end - 1, row1, "f");
    setPixel(grid, end - 2, row1, "f");
  }
  if (skin2) {
    const [start, end] = skin2;
    setPixel(grid, start + 1, row2, "f");
    setPixel(grid, end - 1, row2, "f");
  }
}

function applyEarring(grid: Grid, shape: FaceShape): void {
  const row = shape.mouthRow;
  const skinRow = shape.skin[row];
  if (!skinRow) return;
  const [, end] = skinRow;
  setPixel(grid, end + 1, row, "o");
  setPixel(grid, end + 1, row + 1, "o");
}

function applyMole(grid: Grid, shape: FaceShape): void {
  setPixel(grid, shape.mouthCenterCol - 2, shape.mouthRow - 1, "x");
}

function applyHorns(grid: Grid): void {
  setPixel(grid, 2, 1, "v");
  setPixel(grid, 3, 2, "v");
  setPixel(grid, 13, 1, "v");
  setPixel(grid, 12, 2, "v");
}

function applyScar(grid: Grid, shape: FaceShape): void {
  const row1 = shape.eyeRow + 2;
  const row2 = shape.eyeRow + 3;
  const skin1 = shape.skin[row1];
  const skin2 = shape.skin[row2];
  if (skin1) setPixel(grid, skin1[0], row1, "p");
  if (skin2) setPixel(grid, skin2[0] + 1, row2, "p");
}

function applyHalo(grid: Grid): void {
  for (let c = 4; c <= 11; c++) setPixel(grid, c, 0, "a");
  setPixel(grid, 3, 0, "a");
  setPixel(grid, 12, 0, "a");
}

function applyEyepatch(grid: Grid, shape: FaceShape): void {
  for (let c = shape.leftEyeCol - 1; c <= shape.leftEyeCol + 2; c++) {
    setPixel(grid, c, shape.eyeRow - 1, "y");
    setPixel(grid, c, shape.eyeRow, "y");
    setPixel(grid, c, shape.eyeRow + 1, "y");
    setPixel(grid, c, shape.eyeRow + 2, "y");
  }
}

function applyGlasses(grid: Grid, shape: FaceShape): void {
  const row = shape.eyeRow;
  const lc = shape.leftEyeCol;
  const rc = shape.rightEyeCol;
  // Left lens frame
  setPixel(grid, lc - 1, row - 1, "g");
  setPixel(grid, lc, row - 1, "g");
  setPixel(grid, lc + 1, row - 1, "g");
  setPixel(grid, lc + 2, row - 1, "g");
  setPixel(grid, lc - 1, row, "g");
  setPixel(grid, lc + 2, row, "g");
  setPixel(grid, lc - 1, row + 1, "g");
  setPixel(grid, lc + 2, row + 1, "g");
  setPixel(grid, lc - 1, row + 2, "g");
  setPixel(grid, lc, row + 2, "g");
  setPixel(grid, lc + 1, row + 2, "g");
  setPixel(grid, lc + 2, row + 2, "g");
  // Right lens frame
  setPixel(grid, rc - 1, row - 1, "g");
  setPixel(grid, rc, row - 1, "g");
  setPixel(grid, rc + 1, row - 1, "g");
  setPixel(grid, rc + 2, row - 1, "g");
  setPixel(grid, rc - 1, row, "g");
  setPixel(grid, rc + 2, row, "g");
  setPixel(grid, rc - 1, row + 1, "g");
  setPixel(grid, rc + 2, row + 1, "g");
  setPixel(grid, rc - 1, row + 2, "g");
  setPixel(grid, rc, row + 2, "g");
  setPixel(grid, rc + 1, row + 2, "g");
  setPixel(grid, rc + 2, row + 2, "g");
}

function applyShirt(grid: Grid): void {
  for (let c = 2; c <= 13; c++) setPixel(grid, c, 15, "b");
  for (let c = 3; c <= 12; c++) setPixel(grid, c, 14, "b");
}

// ── Main builder (two-hash split) ──
export function buildFaceGrid(personalityHash: Buffer, variationHash: Buffer): Grid {
  const grid = emptyGrid();
  const pH = personalityHash;
  const vH = variationHash;

  // ── LOCKED TRAITS (identity — stays constant across regens) ──
  const shapeIdx = pH[0] % FACE_SHAPES.length;
  const shape = FACE_SHAPES[shapeIdx];
  const eyeStyleIdx = pH[2] % EYE_STYLES.length;
  const finalEyeStyleIdx = shapeIdx === 2 && eyeStyleIdx === 3 ? 0 : eyeStyleIdx;

  const pAcc = pH[5];
  const hasGlasses = (pAcc & 0x01) !== 0;
  const hasMole = (pAcc & 0x02) !== 0;
  const hasHat = (pAcc & 0x04) !== 0;
  const hasEyepatch = (pAcc & 0x08) !== 0 && !hasGlasses;
  const hasHorns = (pH[13] & 0x07) === 0; // 1/8
  const hasHalo = (pAcc & 0x10) !== 0 && !hasHat && !hasHorns;
  const isBald = (pH[6] & 0x0F) === 0; // 1/16

  // ── VARYING TRAITS (outfit/expression — changes per regen) ──
  let hairIdx = vH[0] % 14; // 0-13 (skip bald index 12 — handled separately)
  if (hairIdx >= 12) hairIdx += 1;
  const hair = isBald ? HAIR_STYLES[12] : HAIR_STYLES[hairIdx];

  const hatIdx = vH[1] % HATS.length;
  const mouthStyleIdx = vH[2] % MOUTH_STYLES.length;
  const finalMouthStyleIdx = shapeIdx === 2 && mouthStyleIdx === 1 ? 0 : mouthStyleIdx;

  const facialHairIdx = vH[3] % FACIAL_HAIR.length;
  const vAcc = vH[4];
  const hasBlush = (vAcc & 0x01) !== 0;
  const hasFreckles = (vAcc & 0x02) !== 0;
  const hasEarring = (vAcc & 0x04) !== 0;
  const hasScar = (vAcc & 0x08) !== 0;

  // 1. Skin
  for (let r = 0; r < GRID_SIZE; r++) {
    const range = shape.skin[r];
    if (range) {
      const [start, end] = range;
      for (let c = start; c <= end; c++) setPixel(grid, c, r, "s");
    }
  }

  // 2. Bald scalp fill
  if (hair.bald) {
    for (let c = 5; c <= 10; c++) setPixel(grid, c, 2, "s");
    for (let c = 4; c <= 11; c++) setPixel(grid, c, 3, "s");
    for (let c = 3; c <= 12; c++) setPixel(grid, c, 4, "s");
  }

  // 3. Hair
  for (let r = 0; r < GRID_SIZE; r++) {
    const row = hair.pattern[r];
    for (let c = 0; c < GRID_SIZE; c++) {
      if (row[c] === "h") setPixel(grid, c, r, "h");
    }
  }

  // 4. Hat
  if (hasHat) {
    const hat = HATS[hatIdx];
    for (let r = 0; r < GRID_SIZE; r++) {
      const row = hat.pattern[r];
      for (let c = 0; c < GRID_SIZE; c++) {
        if (row[c] === "t") setPixel(grid, c, r, "t");
      }
    }
  }

  // 5. Horns (only if no hat)
  if (hasHorns && !hasHat) applyHorns(grid);

  // 6. Halo
  if (hasHalo) applyHalo(grid);

  // 7. Eyes
  EYE_STYLES[finalEyeStyleIdx](grid, shape.leftEyeCol, shape.rightEyeCol, shape.eyeRow);

  // 8. Glasses
  if (hasGlasses) applyGlasses(grid, shape);

  // 9. Eyepatch
  if (hasEyepatch) applyEyepatch(grid, shape);

  // 10. Mouth
  MOUTH_STYLES[finalMouthStyleIdx](grid, shape.mouthCenterCol, shape.mouthRow);

  // 11. Facial hair (skip if teeth smile)
  if (finalMouthStyleIdx !== 3) FACIAL_HAIR[facialHairIdx](grid, shape);

  // 12. Accessories
  if (hasBlush) applyBlush(grid, shape);
  if (hasFreckles) applyFreckles(grid, shape);
  if (hasEarring) applyEarring(grid, shape);
  if (hasMole) applyMole(grid, shape);
  if (hasScar) applyScar(grid, shape);

  // 13. Shirt
  applyShirt(grid);

  return grid;
}

// ── Color palettes ──
const HAIR_COLORS = [
  "#5C3A1E", "#2C1810", "#1A1A2A", "#D4A017",
  "#6B4226", "#A0522D", "#4A3728", "#C4A45A",
  "#8B6914", "#333333", "#5A5A5A", "#3B2F2F",
  "#7B3F00", "#E8DDB5", "#CCCCCC",
  "#E63946", "#FF69B4", "#3B82F6", "#9D4EDD", "#06A77D",
];

const SKIN_TONES = [
  "#F5D0A9", "#FADDBA", "#FFE0BD", "#EDC9A3",
  "#D4A574", "#C68642", "#8D6E4C", "#6B4C3B",
  "#9E6B4A", "#5C3A1E",
  "#7DB87D", "#B87DB8", "#7DA8C8", "#D48888",
];

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

export function hashToPalette(personalityHash: Buffer, _variationHash: Buffer): Palette {
  // ALL colors locked to personality — regen keeps the signature palette.
  const pH = personalityHash;
  return {
    hair: HAIR_COLORS[pH[16] % HAIR_COLORS.length],
    skin: SKIN_TONES[pH[17] % SKIN_TONES.length],
    eye: EYE_COLORS[pH[18] % EYE_COLORS.length],
    mouth: MOUTH_COLORS[pH[19] % MOUTH_COLORS.length],
    shirt: SHIRT_COLORS[pH[20] % SHIRT_COLORS.length],
    bg: BG_COLORS[pH[21] % BG_COLORS.length],
    hat: HAT_COLORS[pH[22] % HAT_COLORS.length],
    earring: EARRING_COLORS[pH[23] % EARRING_COLORS.length],
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

// ── Render SVG ──
export function renderFaceSVG(grid: Grid, palette: Palette): string {
  const SIZE = 512;
  const FACE_PX = 416;
  const PIXEL = FACE_PX / GRID_SIZE; // 26px per grid pixel
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

// ── Hash helpers ──
export function computePersonalityHashHex(personalityText: string): string {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(personalityText).digest("hex").slice(0, 32);
}

export function personalityHashBuffer(personalityHashHex: string): Buffer {
  // Pad/extend to 32 bytes by re-hashing — ensures buffer has 32 bytes for byte access
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(personalityHashHex).digest();
}

export function variationHashBuffer(personalityHashHex: string, variation: number): Buffer {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(`${personalityHashHex}:${variation}`).digest();
}
