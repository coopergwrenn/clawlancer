/**
 * Token PFP generation — Candidate 02 base + HD meme-canon trait overlays.
 *
 * Each overlay is drawn as HD SVG (not pixel blocks) at 1024×1024, composited
 * on top of the hue-tinted Candidate 02 master. Accessories are BIG, BOLD,
 * and instantly recognizable — crypto-twitter memecanon meets pixel-crab.
 *
 * LOCKED per personality: shell hue, eye style, eyewear, gold chain, clown nose
 * VARIES per regen:       bg color, hat, held item, mouth accessory
 */

import path from "node:path";
import fs from "node:fs";

const BASE_IMAGE_PATH = path.join(process.cwd(), "public", "assets", "crab-base.png");
const OUTPUT_SIZE = 1024;

// Key feature positions on the 1024×1024 base (sampled from PNG)
const LEFT_EYE_X = 352;
const RIGHT_EYE_X = 676;
const EYE_Y = 388;

let _baseCache: Buffer | null = null;
function loadBaseBuffer(): Buffer {
  if (_baseCache) return _baseCache;
  _baseCache = fs.readFileSync(BASE_IMAGE_PATH);
  return _baseCache;
}

export function darkenHex(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mult = Math.max(0, 1 - factor);
  return "#" + [r, g, b].map((v) => Math.round(v * mult).toString(16).padStart(2, "0")).join("");
}

function svg(body: string): string {
  return `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// Draw a "$" sign at (cx, cy) with given size and color
function dollarSign(cx: number, cy: number, size: number, color: string): string {
  const w = size * 0.6;   // width of horizontals
  const h = size;         // vertical
  const t = Math.max(3, size * 0.12); // stroke thickness
  return `
    <rect x="${cx - t/2}" y="${cy - h/2}" width="${t}" height="${h}" fill="${color}"/>
    <rect x="${cx - w/2}" y="${cy - h/2}" width="${w}" height="${t}" fill="${color}"/>
    <rect x="${cx - w/2}" y="${cy - t/2}" width="${w}" height="${t}" fill="${color}"/>
    <rect x="${cx - w/2}" y="${cy + h/2 - t}" width="${w}" height="${t}" fill="${color}"/>
  `;
}

// ── Shell hue shifts (LOCKED per personality) ──
const HUE_SHIFTS = [
  0, 0,
  -15, -30, -45,
  15, 30, 60,
  90, 120, 150,
  180, 210, 240,
  270, 300, 330,
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

// ────────────────────────────────────────────────────────────────
// LAYER: EYES (LOCKED per personality)
// ────────────────────────────────────────────────────────────────
type EyeStyle = "dot" | "wide" | "angry" | "sleepy" | "hearts" | "dollar" | "x_eyes" | "laser" | "pepe";

function pickEye(h: Buffer): EyeStyle {
  const v = h[8] % 100;
  if (v < 45) return "dot";
  if (v < 60) return "wide";
  if (v < 72) return "angry";
  if (v < 82) return "sleepy";
  if (v < 88) return "hearts";
  if (v < 92) return "dollar";
  if (v < 95) return "x_eyes";
  if (v < 98) return "laser";    // legendary
  return "pepe";                  // legendary
}

function eyesSVG(style: EyeStyle): string {
  if (style === "dot") return "";
  const lx = LEFT_EYE_X, rx = RIGHT_EYE_X, y = EYE_Y;
  const black = "#1A1A1A", red = "#E63946", green = "#2EA040", white = "#FFFFFF";

  if (style === "wide") {
    return svg(`
      <circle cx="${lx}" cy="${y}" r="32" fill="${black}"/>
      <circle cx="${rx}" cy="${y}" r="32" fill="${black}"/>
      <circle cx="${lx - 10}" cy="${y - 10}" r="9" fill="${white}"/>
      <circle cx="${rx - 10}" cy="${y - 10}" r="9" fill="${white}"/>
    `);
  }
  if (style === "angry") {
    return svg(`
      <!-- Angry eyebrows -->
      <polygon points="${lx - 50},${y - 50} ${lx + 30},${y - 15} ${lx + 30},${y - 5} ${lx - 50},${y - 30}" fill="${black}"/>
      <polygon points="${rx + 50},${y - 50} ${rx - 30},${y - 15} ${rx - 30},${y - 5} ${rx + 50},${y - 30}" fill="${black}"/>
      <!-- Narrow angry eyes -->
      <rect x="${lx - 18}" y="${y}" width="36" height="10" fill="${black}"/>
      <rect x="${rx - 18}" y="${y}" width="36" height="10" fill="${black}"/>
    `);
  }
  if (style === "sleepy") {
    return svg(`
      <!-- Long lashes / closed eye lines -->
      <rect x="${lx - 38}" y="${y + 8}" width="76" height="8" fill="${black}"/>
      <rect x="${rx - 38}" y="${y + 8}" width="76" height="8" fill="${black}"/>
      <path d="M ${lx - 40} ${y + 16} Q ${lx - 30} ${y + 26} ${lx - 20} ${y + 16}" stroke="${black}" stroke-width="4" fill="none"/>
      <path d="M ${rx + 20} ${y + 16} Q ${rx + 30} ${y + 26} ${rx + 40} ${y + 16}" stroke="${black}" stroke-width="4" fill="none"/>
    `);
  }
  if (style === "hearts") {
    const heart = (cx: number, cy: number) => `
      <path d="M ${cx} ${cy + 28}
               C ${cx - 40} ${cy}, ${cx - 40} ${cy - 30}, ${cx - 15} ${cy - 30}
               C ${cx - 5} ${cy - 30}, ${cx} ${cy - 22}, ${cx} ${cy - 15}
               C ${cx} ${cy - 22}, ${cx + 5} ${cy - 30}, ${cx + 15} ${cy - 30}
               C ${cx + 40} ${cy - 30}, ${cx + 40} ${cy}, ${cx} ${cy + 28} Z" fill="${red}"/>
    `;
    return svg(heart(lx, y) + heart(rx, y));
  }
  if (style === "dollar") {
    return svg(`
      ${dollarSign(lx, y + 5, 56, green)}
      ${dollarSign(rx, y + 5, 56, green)}
    `);
  }
  if (style === "x_eyes") {
    const xMark = (cx: number, cy: number) => `
      <line x1="${cx - 22}" y1="${cy - 22}" x2="${cx + 22}" y2="${cy + 22}" stroke="${black}" stroke-width="10" stroke-linecap="round"/>
      <line x1="${cx + 22}" y1="${cy - 22}" x2="${cx - 22}" y2="${cy + 22}" stroke="${black}" stroke-width="10" stroke-linecap="round"/>
    `;
    return svg(xMark(lx, y) + xMark(rx, y));
  }
  if (style === "laser") {
    // Full-width red beams blasting from eyes
    return svg(`
      <!-- Bright beam base -->
      <rect x="0" y="${y - 18}" width="1024" height="36" fill="${red}" opacity="0.85"/>
      <!-- Inner hot white core -->
      <rect x="0" y="${y - 8}" width="1024" height="16" fill="${white}" opacity="0.75"/>
      <!-- Eye origin glows -->
      <circle cx="${lx}" cy="${y}" r="40" fill="${red}"/>
      <circle cx="${rx}" cy="${y}" r="40" fill="${red}"/>
      <circle cx="${lx}" cy="${y}" r="20" fill="${white}"/>
      <circle cx="${rx}" cy="${y}" r="20" fill="${white}"/>
    `);
  }
  if (style === "pepe") {
    // Big googly eyes with off-center pupils (Pepe-style)
    return svg(`
      <circle cx="${lx}" cy="${y - 4}" r="44" fill="${white}" stroke="${black}" stroke-width="4"/>
      <circle cx="${rx}" cy="${y - 4}" r="44" fill="${white}" stroke="${black}" stroke-width="4"/>
      <circle cx="${lx + 12}" cy="${y + 6}" r="16" fill="${black}"/>
      <circle cx="${rx + 12}" cy="${y + 6}" r="16" fill="${black}"/>
      <circle cx="${lx + 15}" cy="${y + 3}" r="4" fill="${white}"/>
      <circle cx="${rx + 15}" cy="${y + 3}" r="4" fill="${white}"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// LAYER: EYEWEAR (LOCKED per personality)
// ────────────────────────────────────────────────────────────────
type Eyewear = "none" | "sunglasses" | "deal_with_it" | "3d_glasses" | "monocle" | "eyepatch" | "laser_visor";

function pickEyewear(h: Buffer): Eyewear {
  const v = h[9] % 100;
  if (v < 55) return "none";
  if (v < 68) return "sunglasses";
  if (v < 78) return "deal_with_it";
  if (v < 84) return "3d_glasses";
  if (v < 90) return "monocle";
  if (v < 95) return "eyepatch";
  return "laser_visor";
}

function eyewearSVG(wear: Eyewear): string {
  if (wear === "none") return "";
  const lx = LEFT_EYE_X, rx = RIGHT_EYE_X, y = EYE_Y;
  const black = "#1A1A1A", gold = "#FFD700", goldDark = "#C89B0A";
  const red = "#E63946", cyan = "#2EC4B6", white = "#FFFFFF";

  if (wear === "sunglasses") {
    // Big aviator-style sunglasses with bridge
    return svg(`
      <ellipse cx="${lx}" cy="${y}" rx="65" ry="50" fill="${black}"/>
      <ellipse cx="${rx}" cy="${y}" rx="65" ry="50" fill="${black}"/>
      <rect x="${lx + 50}" y="${y - 8}" width="${rx - lx - 100}" height="12" fill="${black}"/>
      <!-- Lens glint -->
      <ellipse cx="${lx - 25}" cy="${y - 18}" rx="18" ry="10" fill="${white}" opacity="0.35"/>
      <ellipse cx="${rx - 25}" cy="${y - 18}" rx="18" ry="10" fill="${white}" opacity="0.35"/>
    `);
  }
  if (wear === "deal_with_it") {
    // Classic pixelated sliding-down sunglasses — thick black rectangular bar
    // Slightly tilted for "sliding" effect, with pixel step edges
    return svg(`
      <g transform="rotate(-4 ${lx} ${y + 20})">
        <!-- Main bar -->
        <rect x="${lx - 95}" y="${y - 10}" width="${rx - lx + 195}" height="48" fill="${black}"/>
        <!-- Top pixel step -->
        <rect x="${lx - 90}" y="${y - 22}" width="${rx - lx + 185}" height="12" fill="${black}"/>
        <!-- Highlight dots (pixel-art shine) -->
        <rect x="${lx - 70}" y="${y}" width="20" height="8" fill="${white}"/>
        <rect x="${rx - 70}" y="${y}" width="20" height="8" fill="${white}"/>
      </g>
    `);
  }
  if (wear === "3d_glasses") {
    return svg(`
      <!-- Cardboard frame -->
      <rect x="${lx - 75}" y="${y - 45}" width="${rx - lx + 150}" height="95" rx="6" fill="${black}"/>
      <!-- Red lens -->
      <rect x="${lx - 60}" y="${y - 30}" width="115" height="65" fill="${red}" opacity="0.75"/>
      <!-- Cyan lens -->
      <rect x="${rx - 55}" y="${y - 30}" width="115" height="65" fill="${cyan}" opacity="0.75"/>
      <!-- Frame outlines -->
      <rect x="${lx - 60}" y="${y - 30}" width="115" height="65" fill="none" stroke="${black}" stroke-width="6"/>
      <rect x="${rx - 55}" y="${y - 30}" width="115" height="65" fill="none" stroke="${black}" stroke-width="6"/>
    `);
  }
  if (wear === "monocle") {
    return svg(`
      <!-- Gold ring around right eye -->
      <circle cx="${rx}" cy="${y}" r="62" fill="none" stroke="${gold}" stroke-width="14"/>
      <circle cx="${rx}" cy="${y}" r="62" fill="none" stroke="${goldDark}" stroke-width="4"/>
      <!-- Subtle lens tint -->
      <circle cx="${rx}" cy="${y}" r="55" fill="${white}" opacity="0.08"/>
      <!-- Glint -->
      <ellipse cx="${rx - 20}" cy="${y - 22}" rx="15" ry="10" fill="${white}" opacity="0.45"/>
      <!-- Chain -->
      <path d="M ${rx + 60} ${y + 20} Q ${rx + 110} ${y + 80} ${rx + 140} ${y + 160}" stroke="${gold}" stroke-width="5" fill="none"/>
    `);
  }
  if (wear === "eyepatch") {
    return svg(`
      <!-- Big dark patch over left eye -->
      <ellipse cx="${lx}" cy="${y}" rx="85" ry="70" fill="${black}"/>
      <!-- Strap across face, diagonal -->
      <path d="M ${lx - 100} ${y - 80} L ${rx + 60} ${y + 80}" stroke="${black}" stroke-width="12"/>
    `);
  }
  if (wear === "laser_visor") {
    return svg(`
      <!-- Dark horizontal band across face -->
      <rect x="170" y="${y - 30}" width="684" height="75" rx="10" fill="${black}"/>
      <!-- Red laser strip glowing -->
      <rect x="170" y="${y + 4}" width="684" height="18" fill="${red}"/>
      <rect x="170" y="${y + 10}" width="684" height="6" fill="${white}" opacity="0.8"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// LAYER: HATS (VARIES per regen)
// ────────────────────────────────────────────────────────────────
type Hat =
  | "none" | "crown" | "degen_crown" | "cowboy" | "top_hat" | "beanie"
  | "baseball" | "chef" | "party" | "headphones" | "halo" | "devil_horns"
  | "tinfoil" | "jester";

function pickHat(h: Buffer): Hat {
  const v = h[10] % 100;
  if (v < 40) return "none";
  if (v < 48) return "cowboy";
  if (v < 55) return "beanie";
  if (v < 62) return "baseball";
  if (v < 68) return "top_hat";
  if (v < 73) return "chef";
  if (v < 78) return "party";
  if (v < 83) return "headphones";
  if (v < 88) return "crown";
  if (v < 92) return "degen_crown";
  if (v < 95) return "tinfoil";
  if (v < 97) return "jester";    // rare
  if (v < 98) return "halo";       // legendary
  return "devil_horns";            // rare
}

function hatSVG(hat: Hat, h: Buffer): string {
  if (hat === "none") return "";
  const HAT_COLORS = ["#2C3E50", "#E74C3C", "#27AE60", "#F39C12", "#8E44AD", "#16A085", "#C0392B", "#6C5CE7"];
  const hatColor = HAT_COLORS[h[11] % HAT_COLORS.length];
  const hatDark = darkenHex(hatColor, 0.35);
  const black = "#1A1A1A", gold = "#FFD700", goldDark = "#C89B0A", white = "#FFFFFF";

  if (hat === "crown") {
    // 5 gold spikes + band with 3 gems
    return svg(`
      <!-- Band -->
      <rect x="300" y="340" width="424" height="70" fill="${gold}"/>
      <rect x="300" y="390" width="424" height="20" fill="${goldDark}"/>
      <!-- Spikes -->
      <polygon points="310,340 340,220 370,340" fill="${gold}"/>
      <polygon points="385,340 420,180 455,340" fill="${gold}"/>
      <polygon points="470,340 512,150 554,340" fill="${gold}"/>
      <polygon points="569,340 604,180 639,340" fill="${gold}"/>
      <polygon points="654,340 684,220 714,340" fill="${gold}"/>
      <!-- Spike highlights -->
      <polygon points="340,220 345,235 350,220" fill="#FFF4B8"/>
      <polygon points="420,180 425,200 430,180" fill="#FFF4B8"/>
      <polygon points="512,150 517,175 522,150" fill="#FFF4B8"/>
      <polygon points="604,180 609,200 614,180" fill="#FFF4B8"/>
      <polygon points="684,220 689,235 694,220" fill="#FFF4B8"/>
      <!-- Gems -->
      <circle cx="400" cy="375" r="16" fill="#E63946"/>
      <circle cx="400" cy="375" r="16" fill="none" stroke="#8B0000" stroke-width="3"/>
      <circle cx="512" cy="375" r="20" fill="#3B82F6"/>
      <circle cx="512" cy="375" r="20" fill="none" stroke="#1E3A8A" stroke-width="3"/>
      <circle cx="624" cy="375" r="16" fill="#27AE60"/>
      <circle cx="624" cy="375" r="16" fill="none" stroke="#0E6924" stroke-width="3"/>
    `);
  }
  if (hat === "degen_crown") {
    // TILTED gold crown with dripping gold drops — on-chain meme energy
    return svg(`
      <g transform="rotate(-12 512 350)">
        <!-- Band -->
        <rect x="280" y="340" width="464" height="70" fill="${gold}"/>
        <rect x="280" y="390" width="464" height="20" fill="${goldDark}"/>
        <!-- Spikes — irregular heights for "degen" feel -->
        <polygon points="295,340 325,200 360,340" fill="${gold}"/>
        <polygon points="375,340 420,140 465,340" fill="${gold}"/>
        <polygon points="478,340 512,160 546,340" fill="${gold}"/>
        <polygon points="559,340 604,180 649,340" fill="${gold}"/>
        <polygon points="664,340 705,220 740,340" fill="${gold}"/>
        <!-- Gems -->
        <circle cx="420" cy="375" r="18" fill="#E63946"/>
        <circle cx="512" cy="375" r="22" fill="#3B82F6"/>
        <circle cx="604" cy="375" r="18" fill="#9D4EDD"/>
      </g>
      <!-- Gold drops dripping -->
      <ellipse cx="310" cy="470" rx="10" ry="18" fill="${gold}"/>
      <ellipse cx="310" cy="470" rx="4" ry="6" fill="${white}" opacity="0.6"/>
      <ellipse cx="600" cy="480" rx="12" ry="22" fill="${gold}"/>
      <ellipse cx="600" cy="480" rx="5" ry="8" fill="${white}" opacity="0.6"/>
      <ellipse cx="420" cy="445" rx="8" ry="15" fill="${gold}"/>
      <ellipse cx="730" cy="465" rx="10" ry="20" fill="${gold}"/>
    `);
  }
  if (hat === "cowboy") {
    // Wide brim + tall dome + band
    return svg(`
      <!-- Dome -->
      <ellipse cx="512" cy="340" rx="120" ry="100" fill="${hatColor}"/>
      <!-- Indent on crown -->
      <rect x="472" y="270" width="80" height="40" rx="20" fill="${hatDark}"/>
      <!-- Wide brim -->
      <ellipse cx="512" cy="410" rx="280" ry="36" fill="${hatColor}"/>
      <ellipse cx="512" cy="420" rx="280" ry="30" fill="${hatDark}"/>
      <!-- Band -->
      <rect x="390" y="360" width="244" height="22" fill="${hatDark}"/>
      <!-- Star on band -->
      <polygon points="512,362 517,375 530,375 520,383 524,396 512,389 500,396 504,383 494,375 507,375"
               fill="${gold}"/>
    `);
  }
  if (hat === "top_hat") {
    return svg(`
      <!-- Tall cylinder -->
      <rect x="400" y="150" width="224" height="240" fill="${black}"/>
      <!-- Band -->
      <rect x="400" y="340" width="224" height="30" fill="${hatColor}"/>
      <!-- Brim -->
      <rect x="330" y="380" width="364" height="28" rx="4" fill="${black}"/>
      <!-- Highlight stripe on cylinder -->
      <rect x="410" y="160" width="10" height="180" fill="#3A3A3A"/>
    `);
  }
  if (hat === "beanie") {
    return svg(`
      <!-- Beanie dome -->
      <path d="M 270 400 Q 270 180 512 170 Q 754 180 754 400 Z" fill="${hatColor}"/>
      <!-- Fold band -->
      <rect x="270" y="370" width="484" height="45" fill="${hatDark}"/>
      <!-- Knit ridges -->
      <line x1="330" y1="200" x2="340" y2="370" stroke="${hatDark}" stroke-width="4"/>
      <line x1="420" y1="180" x2="425" y2="370" stroke="${hatDark}" stroke-width="4"/>
      <line x1="512" y1="175" x2="512" y2="370" stroke="${hatDark}" stroke-width="4"/>
      <line x1="604" y1="180" x2="599" y2="370" stroke="${hatDark}" stroke-width="4"/>
      <line x1="694" y1="200" x2="684" y2="370" stroke="${hatDark}" stroke-width="4"/>
      <!-- Pom-pom -->
      <circle cx="512" cy="155" r="34" fill="${white}"/>
      <circle cx="500" cy="140" r="12" fill="#DDDDDD"/>
    `);
  }
  if (hat === "baseball") {
    return svg(`
      <!-- Dome -->
      <ellipse cx="512" cy="320" rx="170" ry="110" fill="${hatColor}"/>
      <!-- Brim extending to the LEFT (classic cap pose) -->
      <path d="M 360 380 Q 150 390 100 380 L 100 410 Q 150 420 360 410 Z" fill="${hatColor}"/>
      <path d="M 360 390 Q 150 400 100 390 L 100 410 Q 150 420 360 410 Z" fill="${hatDark}"/>
      <!-- Button on top -->
      <circle cx="512" cy="220" r="10" fill="${hatDark}"/>
      <!-- Front logo highlight -->
      <circle cx="512" cy="310" r="24" fill="${hatDark}"/>
      <circle cx="512" cy="310" r="14" fill="${white}"/>
    `);
  }
  if (hat === "chef") {
    return svg(`
      <!-- Puffy top (3 pillows) -->
      <circle cx="420" cy="230" r="80" fill="${white}"/>
      <circle cx="512" cy="200" r="90" fill="${white}"/>
      <circle cx="604" cy="230" r="80" fill="${white}"/>
      <!-- Mushroom fold -->
      <rect x="370" y="260" width="284" height="120" rx="30" fill="${white}"/>
      <!-- Band -->
      <rect x="370" y="370" width="284" height="30" fill="#DDDDDD"/>
      <!-- Subtle shading -->
      <path d="M 370 320 Q 512 280 654 320" stroke="#CCCCCC" stroke-width="4" fill="none"/>
    `);
  }
  if (hat === "party") {
    return svg(`
      <!-- Cone -->
      <polygon points="512,120 380,410 644,410" fill="${hatColor}"/>
      <!-- Stripes -->
      <polygon points="512,120 478,180 545,180" fill="${white}"/>
      <polygon points="490,230 462,295 562,295 534,230" fill="${white}"/>
      <polygon points="442,340 416,410 608,410 582,340" fill="${white}"/>
      <!-- Band at base -->
      <rect x="360" y="400" width="304" height="18" fill="${hatDark}"/>
      <!-- Pom-pom -->
      <circle cx="512" cy="114" r="26" fill="${gold}"/>
      <circle cx="512" cy="114" r="14" fill="${white}" opacity="0.5"/>
    `);
  }
  if (hat === "headphones") {
    return svg(`
      <!-- Arc band -->
      <path d="M 200 420 Q 512 100 824 420" fill="none" stroke="${black}" stroke-width="32"/>
      <path d="M 200 420 Q 512 110 824 420" fill="none" stroke="#3A3A3A" stroke-width="12"/>
      <!-- Ear cups -->
      <circle cx="200" cy="420" r="80" fill="${black}"/>
      <circle cx="200" cy="420" r="55" fill="${hatColor}"/>
      <circle cx="200" cy="420" r="55" fill="none" stroke="${black}" stroke-width="4"/>
      <circle cx="824" cy="420" r="80" fill="${black}"/>
      <circle cx="824" cy="420" r="55" fill="${hatColor}"/>
      <circle cx="824" cy="420" r="55" fill="none" stroke="${black}" stroke-width="4"/>
      <!-- Brand dot -->
      <circle cx="200" cy="420" r="12" fill="${white}"/>
      <circle cx="824" cy="420" r="12" fill="${white}"/>
    `);
  }
  if (hat === "halo") {
    return svg(`
      <!-- Bright gold ring floating above -->
      <ellipse cx="512" cy="160" rx="180" ry="36" fill="none" stroke="${gold}" stroke-width="20"/>
      <ellipse cx="512" cy="160" rx="180" ry="36" fill="none" stroke="#FFF4B8" stroke-width="8"/>
      <!-- Glow halo -->
      <ellipse cx="512" cy="160" rx="220" ry="50" fill="none" stroke="${gold}" stroke-width="4" opacity="0.4"/>
    `);
  }
  if (hat === "devil_horns") {
    const horn = "#8B0000", hornLight = "#C94A3F";
    return svg(`
      <!-- Left horn (curved outward) -->
      <path d="M 380 400 Q 300 280 330 180 Q 380 240 420 400 Z" fill="${horn}" stroke="${hornLight}" stroke-width="5"/>
      <!-- Right horn -->
      <path d="M 644 400 Q 724 280 694 180 Q 644 240 604 400 Z" fill="${horn}" stroke="${hornLight}" stroke-width="5"/>
      <!-- Horn highlights -->
      <path d="M 336 300 Q 355 240 340 190" stroke="${hornLight}" stroke-width="6" fill="none"/>
      <path d="M 688 300 Q 669 240 684 190" stroke="${hornLight}" stroke-width="6" fill="none"/>
    `);
  }
  if (hat === "tinfoil") {
    return svg(`
      <!-- Crumpled silvery cone -->
      <polygon points="512,140 355,400 669,400" fill="#B0B0B0"/>
      <!-- Highlight stripe -->
      <polygon points="512,140 405,400 470,400 480,240" fill="#E8E8E8"/>
      <!-- Crumpled details -->
      <polygon points="420,310 450,320 430,340" fill="#888"/>
      <polygon points="570,280 600,295 580,315" fill="#888"/>
      <polygon points="490,240 510,250 495,260" fill="#888"/>
      <!-- Band at bottom -->
      <rect x="330" y="390" width="364" height="25" fill="#999"/>
      <rect x="330" y="410" width="364" height="12" fill="#666"/>
      <!-- Antenna -->
      <line x1="512" y1="140" x2="512" y2="70" stroke="#666" stroke-width="5"/>
      <circle cx="512" cy="64" r="10" fill="#333"/>
      <circle cx="512" cy="64" r="4" fill="${gold}"/>
    `);
  }
  if (hat === "jester") {
    // Multicolored jester hat with drooping horns + bells
    const red = "#E63946", yellow = "#F4D04D", greenColor = "#27AE60";
    return svg(`
      <!-- Base band -->
      <rect x="330" y="360" width="364" height="55" fill="${yellow}"/>
      <rect x="330" y="405" width="364" height="15" fill="${goldDark}"/>
      <!-- Red diamond pattern on band -->
      <polygon points="380,360 405,390 380,415 355,390" fill="${red}"/>
      <polygon points="460,360 485,390 460,415 435,390" fill="${red}"/>
      <polygon points="540,360 565,390 540,415 515,390" fill="${red}"/>
      <polygon points="620,360 645,390 620,415 595,390" fill="${red}"/>
      <!-- Left drooping horn (red) -->
      <path d="M 400 360 Q 240 230 200 380 Q 220 400 250 380 Q 300 330 400 360 Z" fill="${red}"/>
      <!-- Middle horn (yellow, straight up then drooping right) -->
      <path d="M 490 360 Q 480 180 560 200 Q 570 300 540 360 Z" fill="${yellow}"/>
      <!-- Right horn (green) -->
      <path d="M 624 360 Q 784 230 824 380 Q 804 400 774 380 Q 724 330 624 360 Z" fill="${greenColor}"/>
      <!-- Bells at tips -->
      <circle cx="210" cy="380" r="26" fill="${gold}"/>
      <circle cx="210" cy="380" r="26" fill="none" stroke="${goldDark}" stroke-width="3"/>
      <rect x="206" y="400" width="8" height="14" fill="${goldDark}"/>
      <circle cx="550" cy="200" r="22" fill="${gold}"/>
      <circle cx="550" cy="200" r="22" fill="none" stroke="${goldDark}" stroke-width="3"/>
      <rect x="546" y="218" width="8" height="12" fill="${goldDark}"/>
      <circle cx="814" cy="380" r="26" fill="${gold}"/>
      <circle cx="814" cy="380" r="26" fill="none" stroke="${goldDark}" stroke-width="3"/>
      <rect x="810" y="400" width="8" height="14" fill="${goldDark}"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// LAYER: HELD ITEMS (VARIES per regen) — shown in right claw
// ────────────────────────────────────────────────────────────────
type HeldItem =
  | "none" | "money_bag" | "diamond" | "rocket" | "cash_stack"
  | "green_candle" | "money_printer" | "trophy" | "coffee" | "laptop"
  | "briefcase" | "sword" | "gm_bubble";

function pickItem(h: Buffer): HeldItem {
  const v = h[7] % 100;
  if (v < 55) return "none";
  if (v < 63) return "money_bag";
  if (v < 70) return "diamond";
  if (v < 76) return "coffee";
  if (v < 81) return "cash_stack";
  if (v < 86) return "laptop";
  if (v < 90) return "briefcase";
  if (v < 93) return "trophy";
  if (v < 96) return "green_candle";
  if (v < 98) return "rocket";
  if (v < 99) return "money_printer";
  return "gm_bubble";
}

function itemSVG(item: HeldItem): string {
  if (item === "none") return "";
  // Items positioned in right claw area
  const cx = 730, cy = 280;
  const gold = "#FFD700", goldDark = "#C89B0A", green = "#2EA040", white = "#FFFFFF";
  const black = "#1A1A1A";

  if (item === "money_bag") {
    const bag = "#8B4513", bagDark = "#5C2C0A";
    return svg(`
      <!-- Bag body -->
      <ellipse cx="${cx}" cy="${cy + 40}" rx="90" ry="100" fill="${bag}"/>
      <ellipse cx="${cx}" cy="${cy + 40}" rx="90" ry="100" fill="none" stroke="${bagDark}" stroke-width="4"/>
      <!-- Shadow on right -->
      <ellipse cx="${cx + 30}" cy="${cy + 60}" rx="60" ry="80" fill="${bagDark}" opacity="0.3"/>
      <!-- Drawstring -->
      <rect x="${cx - 40}" y="${cy - 70}" width="80" height="25" fill="${bagDark}"/>
      <path d="M ${cx - 40} ${cy - 70} Q ${cx - 55} ${cy - 95} ${cx - 25} ${cy - 105}" stroke="${bagDark}" stroke-width="5" fill="none"/>
      <path d="M ${cx + 40} ${cy - 70} Q ${cx + 55} ${cy - 95} ${cx + 25} ${cy - 105}" stroke="${bagDark}" stroke-width="5" fill="none"/>
      <!-- Big $ on bag -->
      ${dollarSign(cx, cy + 50, 70, green)}
    `);
  }
  if (item === "diamond") {
    const dia = "#7FE6FF", shine = "#FFFFFF", deep = "#3088B3";
    return svg(`
      <!-- Big rhombus diamond -->
      <polygon points="${cx},${cy - 90} ${cx + 80},${cy + 10} ${cx},${cy + 110} ${cx - 80},${cy + 10}" fill="${dia}"/>
      <!-- Facet highlights -->
      <polygon points="${cx},${cy - 90} ${cx + 80},${cy + 10} ${cx + 30},${cy + 10} ${cx - 20},${cy - 30}" fill="${shine}"/>
      <polygon points="${cx},${cy - 90} ${cx - 80},${cy + 10} ${cx - 30},${cy + 10} ${cx + 20},${cy - 30}" fill="#B0F0FF"/>
      <polygon points="${cx - 80},${cy + 10} ${cx},${cy + 110} ${cx + 80},${cy + 10}" fill="none" stroke="${deep}" stroke-width="4"/>
      <!-- Sparkles -->
      <g fill="${shine}">
        <polygon points="${cx - 20},${cy - 60} ${cx - 12},${cy - 50} ${cx - 20},${cy - 40} ${cx - 28},${cy - 50}"/>
        <polygon points="${cx + 45},${cy - 10} ${cx + 52},${cy - 3} ${cx + 45},${cy + 4} ${cx + 38},${cy - 3}"/>
        <polygon points="${cx - 50},${cy + 50} ${cx - 44},${cy + 56} ${cx - 50},${cy + 62} ${cx - 56},${cy + 56}"/>
      </g>
    `);
  }
  if (item === "rocket") {
    const body = "#E8E8E8", stripe = "#E63946", flame = "#FF8800", flameHot = "#FFDD00", fin = "#BB0000";
    return svg(`
      <g transform="translate(0, -40)">
        <!-- Nose cone -->
        <polygon points="${cx},${cy - 100} ${cx - 45},${cy - 10} ${cx + 45},${cy - 10}" fill="${stripe}"/>
        <!-- Body -->
        <rect x="${cx - 45}" y="${cy - 10}" width="90" height="120" fill="${body}"/>
        <!-- Window -->
        <circle cx="${cx}" cy="${cy + 25}" r="18" fill="#3B82F6"/>
        <circle cx="${cx}" cy="${cy + 25}" r="18" fill="none" stroke="${black}" stroke-width="3"/>
        <!-- Stripe -->
        <rect x="${cx - 45}" y="${cy + 70}" width="90" height="12" fill="${stripe}"/>
        <!-- Fins -->
        <polygon points="${cx - 45},${cy + 70} ${cx - 80},${cy + 130} ${cx - 45},${cy + 110}" fill="${fin}"/>
        <polygon points="${cx + 45},${cy + 70} ${cx + 80},${cy + 130} ${cx + 45},${cy + 110}" fill="${fin}"/>
        <!-- Flame -->
        <polygon points="${cx - 40},${cy + 110} ${cx},${cy + 220} ${cx + 40},${cy + 110}" fill="${flame}"/>
        <polygon points="${cx - 20},${cy + 110} ${cx},${cy + 180} ${cx + 20},${cy + 110}" fill="${flameHot}"/>
      </g>
    `);
  }
  if (item === "cash_stack") {
    return svg(`
      <!-- Back bills offset -->
      <rect x="${cx - 95}" y="${cy - 20}" width="180" height="70" fill="${green}" transform="rotate(-4 ${cx - 5} ${cy + 15})"/>
      <rect x="${cx - 90}" y="${cy - 15}" width="180" height="75" fill="#3CB054" transform="rotate(3 ${cx} ${cy + 20})"/>
      <!-- Top bill -->
      <rect x="${cx - 85}" y="${cy - 10}" width="180" height="80" rx="4" fill="${green}"/>
      <rect x="${cx - 85}" y="${cy - 10}" width="180" height="80" rx="4" fill="none" stroke="#1F6E2E" stroke-width="3"/>
      <!-- Big $ -->
      ${dollarSign(cx + 5, cy + 30, 58, white)}
      <!-- Corner numbers -->
      <rect x="${cx - 78}" y="${cy - 4}" width="16" height="12" fill="${white}" opacity="0.9"/>
      <rect x="${cx + 70}" y="${cy + 52}" width="16" height="12" fill="${white}" opacity="0.9"/>
    `);
  }
  if (item === "green_candle") {
    // Trading chart green candle — moon shot
    return svg(`
      <!-- Wick -->
      <line x1="${cx}" y1="${cy - 110}" x2="${cx}" y2="${cy + 130}" stroke="#1F6E2E" stroke-width="5"/>
      <!-- Candle body -->
      <rect x="${cx - 40}" y="${cy - 60}" width="80" height="160" fill="${green}"/>
      <rect x="${cx - 40}" y="${cy - 60}" width="80" height="160" fill="none" stroke="#1F6E2E" stroke-width="4"/>
      <!-- Arrow UP -->
      <polygon points="${cx - 30},${cy - 110} ${cx},${cy - 170} ${cx + 30},${cy - 110}" fill="${green}"/>
      <!-- Up-only text lines (ticker-ish) -->
      <rect x="${cx - 18}" y="${cy - 20}" width="36" height="4" fill="#1F6E2E"/>
      <rect x="${cx - 18}" y="${cy + 5}" width="36" height="4" fill="#1F6E2E"/>
      <rect x="${cx - 18}" y="${cy + 30}" width="36" height="4" fill="#1F6E2E"/>
    `);
  }
  if (item === "money_printer") {
    return svg(`
      <!-- Printer body -->
      <rect x="${cx - 90}" y="${cy}" width="180" height="100" rx="8" fill="#3A3A3A"/>
      <rect x="${cx - 90}" y="${cy + 5}" width="180" height="20" fill="#555555"/>
      <rect x="${cx - 80}" y="${cy + 70}" width="160" height="10" fill="#222"/>
      <!-- Paper output slot -->
      <rect x="${cx - 70}" y="${cy - 5}" width="140" height="10" fill="${black}"/>
      <!-- BRRR buttons -->
      <circle cx="${cx - 60}" cy="${cy + 55}" r="6" fill="#E63946"/>
      <circle cx="${cx - 40}" cy="${cy + 55}" r="6" fill="${green}"/>
      <!-- Cash flying out -->
      <rect x="${cx - 55}" y="${cy - 75}" width="110" height="60" fill="${green}" transform="rotate(-8 ${cx} ${cy - 45})"/>
      ${dollarSign(cx - 2, cy - 45, 40, white)}
      <rect x="${cx - 70}" y="${cy - 140}" width="100" height="55" fill="${green}" transform="rotate(15 ${cx - 20} ${cy - 112})"/>
      ${dollarSign(cx - 20, cy - 112, 34, white)}
    `);
  }
  if (item === "trophy") {
    return svg(`
      <!-- Cup -->
      <path d="M ${cx - 80} ${cy - 90} L ${cx + 80} ${cy - 90} L ${cx + 60} ${cy + 30} L ${cx - 60} ${cy + 30} Z" fill="${gold}"/>
      <!-- Shadow -->
      <path d="M ${cx - 80} ${cy - 90} L ${cx + 80} ${cy - 90} L ${cx + 80} ${cy - 70} L ${cx - 80} ${cy - 70} Z" fill="${goldDark}"/>
      <!-- Handles -->
      <path d="M ${cx - 80} ${cy - 70} Q ${cx - 130} ${cy - 50} ${cx - 90} ${cy - 10}" stroke="${gold}" stroke-width="14" fill="none"/>
      <path d="M ${cx + 80} ${cy - 70} Q ${cx + 130} ${cy - 50} ${cx + 90} ${cy - 10}" stroke="${gold}" stroke-width="14" fill="none"/>
      <!-- Stem -->
      <rect x="${cx - 20}" y="${cy + 30}" width="40" height="35" fill="${goldDark}"/>
      <!-- Base -->
      <rect x="${cx - 60}" y="${cy + 65}" width="120" height="25" fill="${gold}"/>
      <!-- Star on cup -->
      <polygon points="${cx},${cy - 70} ${cx + 8},${cy - 50} ${cx + 28},${cy - 50} ${cx + 13},${cy - 35} ${cx + 19},${cy - 15} ${cx},${cy - 28} ${cx - 19},${cy - 15} ${cx - 13},${cy - 35} ${cx - 28},${cy - 50} ${cx - 8},${cy - 50}" fill="${white}"/>
    `);
  }
  if (item === "coffee") {
    const mug = "#6B3410", mugDark = "#3A1E08", rim = "#8B5A30", steam = "#E8E8E8";
    return svg(`
      <!-- Mug body -->
      <rect x="${cx - 60}" y="${cy - 30}" width="120" height="120" rx="10" fill="${mug}"/>
      <rect x="${cx - 60}" y="${cy - 30}" width="120" height="25" fill="${rim}"/>
      <rect x="${cx - 60}" y="${cy + 80}" width="120" height="10" fill="${mugDark}"/>
      <!-- Handle -->
      <path d="M ${cx + 60} ${cy} Q ${cx + 130} ${cy + 15} ${cx + 60} ${cy + 60}" stroke="${mug}" stroke-width="20" fill="none"/>
      <path d="M ${cx + 60} ${cy} Q ${cx + 130} ${cy + 15} ${cx + 60} ${cy + 60}" stroke="${mugDark}" stroke-width="6" fill="none"/>
      <!-- Coffee surface -->
      <ellipse cx="${cx}" cy="${cy - 18}" rx="52" ry="10" fill="#2A1400"/>
      <!-- Steam wisps -->
      <path d="M ${cx - 20} ${cy - 80} Q ${cx - 10} ${cy - 110} ${cx - 20} ${cy - 140}" stroke="${steam}" stroke-width="8" fill="none" opacity="0.8"/>
      <path d="M ${cx + 10} ${cy - 80} Q ${cx + 20} ${cy - 110} ${cx + 10} ${cy - 140}" stroke="${steam}" stroke-width="8" fill="none" opacity="0.8"/>
      <path d="M ${cx - 5} ${cy - 95} Q ${cx + 5} ${cy - 120} ${cx - 5} ${cy - 145}" stroke="${steam}" stroke-width="6" fill="none" opacity="0.6"/>
    `);
  }
  if (item === "laptop") {
    return svg(`
      <!-- Back screen -->
      <rect x="${cx - 90}" y="${cy - 80}" width="180" height="120" rx="6" fill="#2A2A2A"/>
      <rect x="${cx - 82}" y="${cy - 72}" width="164" height="104" fill="#4AC8FF"/>
      <!-- Code-ish lines on screen -->
      <rect x="${cx - 75}" y="${cy - 60}" width="40" height="6" fill="${white}"/>
      <rect x="${cx - 75}" y="${cy - 48}" width="70" height="6" fill="${white}"/>
      <rect x="${cx - 75}" y="${cy - 36}" width="55" height="6" fill="${white}"/>
      <rect x="${cx - 75}" y="${cy - 24}" width="80" height="6" fill="${white}"/>
      <rect x="${cx - 75}" y="${cy - 12}" width="45" height="6" fill="${white}"/>
      <rect x="${cx - 75}" y="${cy}" width="60" height="6" fill="${white}"/>
      <!-- Base / keyboard -->
      <rect x="${cx - 105}" y="${cy + 40}" width="210" height="28" rx="4" fill="#1A1A1A"/>
      <rect x="${cx - 100}" y="${cy + 45}" width="200" height="8" fill="#333"/>
    `);
  }
  if (item === "briefcase") {
    const leather = "#3A1E08", strap = "#1A0A00", lock = gold;
    return svg(`
      <!-- Handle -->
      <rect x="${cx - 40}" y="${cy - 100}" width="80" height="22" rx="10" fill="${strap}"/>
      <rect x="${cx - 34}" y="${cy - 92}" width="68" height="6" fill="${leather}"/>
      <!-- Case body -->
      <rect x="${cx - 95}" y="${cy - 78}" width="190" height="140" rx="10" fill="${leather}"/>
      <!-- Seam -->
      <rect x="${cx - 95}" y="${cy}" width="190" height="8" fill="${strap}"/>
      <!-- Corners -->
      <rect x="${cx - 95}" y="${cy - 78}" width="14" height="140" fill="${strap}" opacity="0.4"/>
      <rect x="${cx + 81}" y="${cy - 78}" width="14" height="140" fill="${strap}" opacity="0.4"/>
      <!-- Lock -->
      <rect x="${cx - 14}" y="${cy - 10}" width="28" height="22" rx="4" fill="${lock}"/>
      <circle cx="${cx}" cy="${cy + 1}" r="5" fill="${strap}"/>
    `);
  }
  if (item === "sword") {
    const blade = "#E0E0E8", edge = "#FFFFFF", hilt = "#8B4513", grip = "#3A1E08";
    return svg(`
      <!-- Blade -->
      <rect x="${cx - 10}" y="${cy - 150}" width="20" height="190" fill="${blade}"/>
      <polygon points="${cx},${cy - 180} ${cx - 10},${cy - 150} ${cx + 10},${cy - 150}" fill="${edge}"/>
      <line x1="${cx - 2}" y1="${cy - 150}" x2="${cx - 2}" y2="${cy + 40}" stroke="${edge}" stroke-width="4"/>
      <!-- Crossguard -->
      <rect x="${cx - 65}" y="${cy + 35}" width="130" height="20" fill="${hilt}"/>
      <!-- Grip -->
      <rect x="${cx - 14}" y="${cy + 55}" width="28" height="60" fill="${grip}"/>
      <!-- Pommel -->
      <circle cx="${cx}" cy="${cy + 125}" r="16" fill="${hilt}"/>
    `);
  }
  if (item === "gm_bubble") {
    // White speech bubble with simplified GM letters (drawn as shapes)
    return svg(`
      <!-- Bubble -->
      <rect x="${cx - 115}" y="${cy - 80}" width="230" height="130" rx="24" fill="${white}" stroke="${black}" stroke-width="6"/>
      <!-- Tail -->
      <polygon points="${cx - 30},${cy + 50} ${cx - 60},${cy + 100} ${cx + 10},${cy + 50}" fill="${white}" stroke="${black}" stroke-width="6"/>
      <polygon points="${cx - 30},${cy + 50} ${cx - 60},${cy + 100} ${cx + 10},${cy + 50}" fill="${white}"/>
      <!-- G (C-shape) -->
      <path d="M ${cx - 70} ${cy - 40} Q ${cx - 90} ${cy - 40} ${cx - 90} ${cy - 15} Q ${cx - 90} ${cy + 10} ${cx - 70} ${cy + 10} L ${cx - 40} ${cy + 10} L ${cx - 40} ${cy - 10} L ${cx - 55} ${cy - 10}" stroke="${black}" stroke-width="10" fill="none" stroke-linecap="round"/>
      <!-- M (three verticals connected) -->
      <path d="M ${cx + 10} ${cy + 10} L ${cx + 10} ${cy - 40} L ${cx + 40} ${cy - 5} L ${cx + 70} ${cy - 40} L ${cx + 70} ${cy + 10}" stroke="${black}" stroke-width="10" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// LAYER: GOLD CHAIN around body (LOCKED — rarity flex)
// ────────────────────────────────────────────────────────────────
function pickGoldChain(h: Buffer): boolean {
  // Rare — locked to personality
  return (h[14] % 12) === 0;
}

function goldChainSVG(): string {
  const gold = "#FFD700", goldDark = "#C89B0A";
  return svg(`
    <!-- Chain arc around body -->
    <path d="M 260 580 Q 420 680 512 660 Q 604 680 770 580" stroke="${gold}" stroke-width="22" fill="none"/>
    <path d="M 260 580 Q 420 680 512 660 Q 604 680 770 580" stroke="${goldDark}" stroke-width="8" fill="none"/>
    <!-- Chain link details (small gold blobs along the path) -->
    <circle cx="300" cy="610" r="12" fill="${gold}" stroke="${goldDark}" stroke-width="2"/>
    <circle cx="360" cy="640" r="12" fill="${gold}" stroke="${goldDark}" stroke-width="2"/>
    <circle cx="430" cy="662" r="12" fill="${gold}" stroke="${goldDark}" stroke-width="2"/>
    <circle cx="600" cy="662" r="12" fill="${gold}" stroke="${goldDark}" stroke-width="2"/>
    <circle cx="670" cy="640" r="12" fill="${gold}" stroke="${goldDark}" stroke-width="2"/>
    <circle cx="730" cy="610" r="12" fill="${gold}" stroke="${goldDark}" stroke-width="2"/>
    <!-- Medallion -->
    <circle cx="512" cy="710" r="44" fill="${gold}"/>
    <circle cx="512" cy="710" r="44" fill="none" stroke="${goldDark}" stroke-width="5"/>
    ${dollarSign(512, 712, 48, goldDark)}
  `);
}

// ────────────────────────────────────────────────────────────────
// LAYER: MOUTH + CLOWN NOSE (VARIES per regen)
// ────────────────────────────────────────────────────────────────
type Mouth = "none" | "cigarette" | "pipe" | "joint" | "gold_tooth" | "tongue" | "clown_nose";

function pickMouth(h: Buffer): Mouth {
  const v = h[12] % 100;
  if (v < 65) return "none";
  if (v < 75) return "cigarette";
  if (v < 82) return "pipe";
  if (v < 88) return "joint";
  if (v < 93) return "gold_tooth";
  if (v < 96) return "tongue";
  return "clown_nose";
}

function mouthSVG(mouth: Mouth): string {
  if (mouth === "none") return "";
  const white = "#F5F5F5", red = "#E63946", brown = "#5C2C0A", pink = "#FF69B4";
  const gold = "#FFD700", ember = "#FF8800", smoke = "#BFBFBF";

  // Mouth protrudes from right side of face
  const mx = 570, my = 490;

  if (mouth === "cigarette") {
    return svg(`
      <rect x="${mx}" y="${my}" width="150" height="16" rx="4" fill="${white}"/>
      <rect x="${mx + 150}" y="${my}" width="18" height="16" fill="${ember}"/>
      <rect x="${mx + 152}" y="${my + 2}" width="14" height="12" fill="${red}"/>
      <!-- Smoke -->
      <circle cx="${mx + 180}" cy="${my - 30}" r="14" fill="${smoke}" opacity="0.55"/>
      <circle cx="${mx + 210}" cy="${my - 70}" r="18" fill="${smoke}" opacity="0.4"/>
      <circle cx="${mx + 250}" cy="${my - 120}" r="22" fill="${smoke}" opacity="0.3"/>
    `);
  }
  if (mouth === "pipe") {
    return svg(`
      <!-- Stem -->
      <rect x="${mx}" y="${my + 10}" width="120" height="18" rx="6" fill="${brown}"/>
      <!-- Bowl -->
      <rect x="${mx + 100}" y="${my - 30}" width="45" height="60" rx="8" fill="${brown}"/>
      <!-- Tobacco glow -->
      <rect x="${mx + 108}" y="${my - 25}" width="30" height="15" rx="4" fill="${ember}"/>
      <circle cx="${mx + 123}" cy="${my - 18}" r="6" fill="${red}"/>
      <!-- Smoke -->
      <circle cx="${mx + 140}" cy="${my - 80}" r="16" fill="${smoke}" opacity="0.5"/>
      <circle cx="${mx + 170}" cy="${my - 130}" r="20" fill="${smoke}" opacity="0.35"/>
    `);
  }
  if (mouth === "joint") {
    return svg(`
      <!-- Bigger than cigarette, slightly tilted -->
      <g transform="rotate(-6 ${mx + 60} ${my + 8})">
        <rect x="${mx}" y="${my}" width="170" height="22" rx="6" fill="${white}"/>
        <!-- Crinkled end -->
        <rect x="${mx}" y="${my - 2}" width="30" height="4" fill="${white}"/>
        <rect x="${mx}" y="${my + 22}" width="30" height="4" fill="${white}"/>
        <!-- Ember -->
        <rect x="${mx + 170}" y="${my}" width="22" height="22" fill="${ember}"/>
        <rect x="${mx + 172}" y="${my + 2}" width="18" height="18" fill="${red}"/>
      </g>
      <!-- Puffy smoke rings -->
      <circle cx="${mx + 210}" cy="${my - 40}" r="22" fill="${smoke}" opacity="0.55"/>
      <circle cx="${mx + 210}" cy="${my - 40}" r="22" fill="none" stroke="#909090" stroke-width="3" opacity="0.5"/>
      <circle cx="${mx + 260}" cy="${my - 95}" r="28" fill="${smoke}" opacity="0.45"/>
      <circle cx="${mx + 260}" cy="${my - 95}" r="28" fill="none" stroke="#909090" stroke-width="3" opacity="0.4"/>
      <circle cx="${mx + 310}" cy="${my - 160}" r="32" fill="${smoke}" opacity="0.35"/>
    `);
  }
  if (mouth === "gold_tooth") {
    return svg(`
      <rect x="${mx - 20}" y="${my}" width="24" height="30" fill="${gold}"/>
      <rect x="${mx - 20}" y="${my}" width="8" height="30" fill="${white}" opacity="0.4"/>
      <rect x="${mx - 20}" y="${my}" width="24" height="30" fill="none" stroke="#C89B0A" stroke-width="2"/>
    `);
  }
  if (mouth === "tongue") {
    return svg(`
      <ellipse cx="${mx}" cy="${my + 30}" rx="30" ry="42" fill="${pink}"/>
      <line x1="${mx}" y1="${my + 10}" x2="${mx}" y2="${my + 60}" stroke="#D64A8F" stroke-width="4"/>
    `);
  }
  if (mouth === "clown_nose") {
    // Big red nose in the center of the face
    return svg(`
      <circle cx="512" cy="500" r="50" fill="${red}"/>
      <circle cx="512" cy="500" r="50" fill="none" stroke="#8B0000" stroke-width="5"/>
      <!-- Highlight -->
      <ellipse cx="495" cy="485" rx="18" ry="12" fill="${white}" opacity="0.55"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// Orb background SVG (glass effect)
// ────────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────────
// Core builder
// ────────────────────────────────────────────────────────────────
export async function buildCrabImage(
  personalityHash: Buffer,
  variationHash: Buffer,
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  // LOCKED per personality
  const hueShift = HUE_SHIFTS[personalityHash[0] % HUE_SHIFTS.length];
  const eye = pickEye(personalityHash);
  const eyewear = pickEyewear(personalityHash);
  const hasChain = pickGoldChain(personalityHash);

  // VARIES per regen
  const bgHex = BG_COLORS[variationHash[0] % BG_COLORS.length];
  const bgDark = darkenHex(bgHex, 0.3);
  const hat = pickHat(variationHash);
  const item = pickItem(variationHash);
  const mouth = pickMouth(variationHash);

  // Base: hue-tinted Candidate 02
  const base = loadBaseBuffer();
  const tintedRgb = await sharp(base)
    .flatten({ background: "#000000" })
    .modulate({ hue: hueShift })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "fill", kernel: "nearest" })
    .raw()
    .toBuffer();
  const alphaMask = await sharp(tintedRgb, {
    raw: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 3 },
  })
    .greyscale()
    .threshold(25)
    .raw()
    .toBuffer();
  const crabWithAlpha = await sharp(tintedRgb, {
    raw: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 3 },
  })
    .joinChannel(alphaMask, { raw: { width: OUTPUT_SIZE, height: OUTPUT_SIZE, channels: 1 } })
    .png()
    .toBuffer();

  // Rasterize overlays
  const raster = async (s: string) =>
    sharp(Buffer.from(s)).resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "fill" }).png().toBuffer();

  const eyesPng = eye === "dot" ? null : await raster(eyesSVG(eye));
  const eyewearPng = eyewear === "none" ? null : await raster(eyewearSVG(eyewear));
  const hatPng = hat === "none" ? null : await raster(hatSVG(hat, variationHash));
  const itemPng = item === "none" ? null : await raster(itemSVG(item));
  const mouthPng = mouth === "none" ? null : await raster(mouthSVG(mouth));
  const chainPng = hasChain ? await raster(goldChainSVG()) : null;

  const orbBg = await raster(orbBackgroundSVG(bgHex, bgDark, OUTPUT_SIZE));
  const orbOverlay = await raster(orbHighlightSVG(OUTPUT_SIZE));

  // Composite order: bg → crab → chain → eyes → eyewear → mouth → hat → item → glass
  // (Chain under face; hat last so it's on top; item above hat so it's grippable)
  const layers: Buffer[] = [crabWithAlpha];
  if (chainPng) layers.push(chainPng);
  if (eyesPng) layers.push(eyesPng);
  if (eyewearPng) layers.push(eyewearPng);
  if (mouthPng) layers.push(mouthPng);
  if (hatPng) layers.push(hatPng);
  if (itemPng) layers.push(itemPng);
  layers.push(orbOverlay);

  let stacked = orbBg;
  for (const layer of layers) {
    stacked = await sharp(stacked)
      .composite([{ input: layer, top: 0, left: 0 }])
      .png()
      .toBuffer();
  }

  return sharp(stacked).resize(512, 512, { kernel: "nearest" }).png().toBuffer();
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
