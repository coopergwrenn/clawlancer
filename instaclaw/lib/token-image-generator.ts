/**
 * Token PFP generation — Candidate 02 + HD meme-canon traits.
 *
 * Designed for DASHBOARD PREVIEW READABILITY (~128-160px display).
 * Every accessory uses thick strokes (40-80px) and big features (150-400px)
 * so the trait survives downsampling from 1024 → 160px.
 *
 * Rule: if a feature is smaller than ~150px at 1024, it disappears at preview.
 */

import path from "node:path";
import fs from "node:fs";

const BASE_IMAGE_PATH = path.join(process.cwd(), "public", "assets", "crab-base.png");
const OUTPUT_SIZE = 1024;

// Key feature positions on the 1024×1024 base
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

// Draw a BOLD "$" sign as an S-curve with vertical line — actually reads as money
function dollarSign(cx: number, cy: number, size: number, color: string): string {
  const w = size * 0.55;
  const h = size;
  const t = Math.max(10, size * 0.2); // stroke thickness
  const left = cx - w / 2;
  const right = cx + w / 2;
  const top = cy - h / 2;
  const bottom = cy + h / 2;
  // Path traces S: top-right → top-left → mid-left → mid-right → bottom-right → bottom-left
  const sPath = `M ${right} ${top + t/2}
                 L ${left} ${top + t/2}
                 L ${left} ${cy - t/4}
                 L ${right} ${cy + t/4}
                 L ${right} ${bottom - t/2}
                 L ${left} ${bottom - t/2}`;
  return `
    <path d="${sPath}" stroke="${color}" stroke-width="${t}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="${cx - t/2}" y="${top - t/3}" width="${t}" height="${h + t*2/3}" fill="${color}"/>
  `;
}

// ── Shell hue shifts (LOCKED per personality) ──
const HUE_SHIFTS = [
  0, 0, -15, -30, -45,
  15, 30, 60, 90, 120, 150,
  180, 210, 240, 270, 300, 330,
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
// EYES — all big enough to read at preview size (60px+ features)
// ────────────────────────────────────────────────────────────────
type EyeStyle = "dot" | "wide" | "angry" | "hearts" | "dollar" | "x_eyes" | "laser" | "pepe";

function pickEye(h: Buffer): EyeStyle {
  const v = h[8] % 100;
  if (v < 50) return "dot";
  if (v < 65) return "wide";
  if (v < 75) return "angry";
  if (v < 83) return "hearts";
  if (v < 89) return "dollar";
  if (v < 94) return "x_eyes";
  if (v < 98) return "laser";
  return "pepe";
}

function eyesSVG(style: EyeStyle): string {
  if (style === "dot") return "";
  const lx = LEFT_EYE_X, rx = RIGHT_EYE_X, y = EYE_Y;
  const black = "#1A1A1A", red = "#E63946", green = "#2EA040", white = "#FFFFFF";

  if (style === "wide") {
    return svg(`
      <circle cx="${lx}" cy="${y}" r="48" fill="${black}"/>
      <circle cx="${rx}" cy="${y}" r="48" fill="${black}"/>
      <circle cx="${lx - 14}" cy="${y - 14}" r="14" fill="${white}"/>
      <circle cx="${rx - 14}" cy="${y - 14}" r="14" fill="${white}"/>
    `);
  }
  if (style === "angry") {
    // Thick angry eyebrows + narrow eyes
    return svg(`
      <polygon points="${lx - 70},${y - 70} ${lx + 40},${y - 10} ${lx + 40},${y + 10} ${lx - 70},${y - 40}" fill="${black}"/>
      <polygon points="${rx + 70},${y - 70} ${rx - 40},${y - 10} ${rx - 40},${y + 10} ${rx + 70},${y - 40}" fill="${black}"/>
      <rect x="${lx - 28}" y="${y + 5}" width="56" height="18" fill="${black}"/>
      <rect x="${rx - 28}" y="${y + 5}" width="56" height="18" fill="${black}"/>
    `);
  }
  if (style === "hearts") {
    const heart = (cx: number, cy: number) => `
      <path d="M ${cx} ${cy + 45}
               C ${cx - 55} ${cy + 10}, ${cx - 55} ${cy - 35}, ${cx - 20} ${cy - 35}
               C ${cx - 8} ${cy - 35}, ${cx} ${cy - 25}, ${cx} ${cy - 15}
               C ${cx} ${cy - 25}, ${cx + 8} ${cy - 35}, ${cx + 20} ${cy - 35}
               C ${cx + 55} ${cy - 35}, ${cx + 55} ${cy + 10}, ${cx} ${cy + 45} Z"
        fill="${red}" stroke="#8B0000" stroke-width="5"/>
    `;
    return svg(heart(lx, y) + heart(rx, y));
  }
  if (style === "dollar") {
    return svg(`
      ${dollarSign(lx, y + 5, 70, green)}
      ${dollarSign(rx, y + 5, 70, green)}
    `);
  }
  if (style === "x_eyes") {
    const xMark = (cx: number, cy: number) => `
      <line x1="${cx - 30}" y1="${cy - 30}" x2="${cx + 30}" y2="${cy + 30}" stroke="${black}" stroke-width="20" stroke-linecap="round"/>
      <line x1="${cx + 30}" y1="${cy - 30}" x2="${cx - 30}" y2="${cy + 30}" stroke="${black}" stroke-width="20" stroke-linecap="round"/>
    `;
    return svg(xMark(lx, y) + xMark(rx, y));
  }
  if (style === "laser") {
    // Full-width red beam — UNMISTAKABLE at any size
    return svg(`
      <rect x="0" y="${y - 40}" width="1024" height="80" fill="${red}" opacity="0.9"/>
      <rect x="0" y="${y - 18}" width="1024" height="36" fill="${white}" opacity="0.75"/>
      <circle cx="${lx}" cy="${y}" r="70" fill="${red}"/>
      <circle cx="${rx}" cy="${y}" r="70" fill="${red}"/>
      <circle cx="${lx}" cy="${y}" r="32" fill="${white}"/>
      <circle cx="${rx}" cy="${y}" r="32" fill="${white}"/>
    `);
  }
  if (style === "pepe") {
    return svg(`
      <circle cx="${lx}" cy="${y - 6}" r="60" fill="${white}" stroke="${black}" stroke-width="8"/>
      <circle cx="${rx}" cy="${y - 6}" r="60" fill="${white}" stroke="${black}" stroke-width="8"/>
      <circle cx="${lx + 18}" cy="${y + 8}" r="24" fill="${black}"/>
      <circle cx="${rx + 18}" cy="${y + 8}" r="24" fill="${black}"/>
      <circle cx="${lx + 22}" cy="${y + 4}" r="6" fill="${white}"/>
      <circle cx="${rx + 22}" cy="${y + 4}" r="6" fill="${white}"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// EYEWEAR — all big, bold, with heavy strokes
// ────────────────────────────────────────────────────────────────
type Eyewear = "none" | "sunglasses" | "deal_with_it" | "3d_glasses" | "eyepatch" | "laser_visor";

function pickEyewear(h: Buffer): Eyewear {
  const v = h[9] % 100;
  if (v < 55) return "none";
  if (v < 70) return "sunglasses";
  if (v < 82) return "deal_with_it";
  if (v < 90) return "3d_glasses";
  if (v < 96) return "eyepatch";
  return "laser_visor";
}

function eyewearSVG(wear: Eyewear): string {
  if (wear === "none") return "";
  const lx = LEFT_EYE_X, rx = RIGHT_EYE_X, y = EYE_Y;
  const black = "#1A1A1A", red = "#E63946", cyan = "#2EC4B6", white = "#FFFFFF";

  if (wear === "sunglasses") {
    return svg(`
      <ellipse cx="${lx}" cy="${y}" rx="85" ry="65" fill="${black}"/>
      <ellipse cx="${rx}" cy="${y}" rx="85" ry="65" fill="${black}"/>
      <rect x="${lx + 60}" y="${y - 15}" width="${rx - lx - 120}" height="28" fill="${black}"/>
      <!-- Prominent lens glint -->
      <ellipse cx="${lx - 30}" cy="${y - 25}" rx="26" ry="16" fill="${white}" opacity="0.5"/>
      <ellipse cx="${rx - 30}" cy="${y - 25}" rx="26" ry="16" fill="${white}" opacity="0.5"/>
    `);
  }
  if (wear === "deal_with_it") {
    return svg(`
      <g transform="rotate(-5 ${lx} ${y + 25})">
        <rect x="${lx - 120}" y="${y - 15}" width="${rx - lx + 240}" height="60" fill="${black}"/>
        <rect x="${lx - 115}" y="${y - 30}" width="${rx - lx + 230}" height="18" fill="${black}"/>
        <rect x="${lx - 85}" y="${y + 5}" width="30" height="12" fill="${white}"/>
        <rect x="${rx - 85}" y="${y + 5}" width="30" height="12" fill="${white}"/>
      </g>
    `);
  }
  if (wear === "3d_glasses") {
    return svg(`
      <rect x="${lx - 95}" y="${y - 55}" width="${rx - lx + 190}" height="115" rx="10" fill="${black}"/>
      <rect x="${lx - 75}" y="${y - 38}" width="140" height="80" fill="${red}"/>
      <rect x="${rx - 65}" y="${y - 38}" width="140" height="80" fill="${cyan}"/>
      <rect x="${lx - 75}" y="${y - 38}" width="140" height="80" fill="none" stroke="${black}" stroke-width="10"/>
      <rect x="${rx - 65}" y="${y - 38}" width="140" height="80" fill="none" stroke="${black}" stroke-width="10"/>
    `);
  }
  if (wear === "eyepatch") {
    return svg(`
      <ellipse cx="${lx}" cy="${y}" rx="110" ry="85" fill="${black}"/>
      <!-- Diagonal strap -->
      <polygon points="${lx - 150},${y - 110} ${lx - 80},${y - 160} ${rx + 90},${y + 120} ${rx + 30},${y + 170}" fill="${black}"/>
    `);
  }
  if (wear === "laser_visor") {
    return svg(`
      <rect x="150" y="${y - 45}" width="724" height="100" rx="12" fill="${black}"/>
      <rect x="150" y="${y + 5}" width="724" height="30" fill="${red}"/>
      <rect x="150" y="${y + 12}" width="724" height="12" fill="${white}" opacity="0.9"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// HATS — all span at least 300px wide so they read at preview
// ────────────────────────────────────────────────────────────────
type Hat =
  | "none" | "crown" | "degen_crown" | "cowboy" | "top_hat" | "beanie"
  | "baseball" | "chef" | "party" | "halo" | "devil_horns"
  | "tinfoil" | "jester";

function pickHat(h: Buffer): Hat {
  const v = h[10] % 100;
  if (v < 40) return "none";
  if (v < 49) return "cowboy";
  if (v < 57) return "beanie";
  if (v < 64) return "baseball";
  if (v < 70) return "top_hat";
  if (v < 76) return "chef";
  if (v < 82) return "party";
  if (v < 88) return "crown";
  if (v < 92) return "degen_crown";
  if (v < 95) return "tinfoil";
  if (v < 97) return "jester";
  if (v < 99) return "halo";
  return "devil_horns";
}

function hatSVG(hat: Hat, h: Buffer): string {
  if (hat === "none") return "";
  const HAT_COLORS = ["#2C3E50", "#E74C3C", "#27AE60", "#F39C12", "#8E44AD", "#16A085", "#C0392B", "#6C5CE7"];
  const hatColor = HAT_COLORS[h[11] % HAT_COLORS.length];
  const hatDark = darkenHex(hatColor, 0.35);
  const black = "#1A1A1A", gold = "#FFD700", goldDark = "#C89B0A", white = "#FFFFFF";

  if (hat === "crown") {
    return svg(`
      <rect x="290" y="340" width="444" height="80" fill="${gold}"/>
      <rect x="290" y="400" width="444" height="22" fill="${goldDark}"/>
      <polygon points="295,340 330,200 365,340" fill="${gold}"/>
      <polygon points="370,340 420,150 470,340" fill="${gold}"/>
      <polygon points="470,340 512,120 554,340" fill="${gold}"/>
      <polygon points="554,340 604,150 654,340" fill="${gold}"/>
      <polygon points="659,340 694,200 729,340" fill="${gold}"/>
      <circle cx="400" cy="380" r="20" fill="#E63946" stroke="#8B0000" stroke-width="4"/>
      <circle cx="512" cy="380" r="24" fill="#3B82F6" stroke="#1E3A8A" stroke-width="4"/>
      <circle cx="624" cy="380" r="20" fill="#27AE60" stroke="#0E6924" stroke-width="4"/>
    `);
  }
  if (hat === "degen_crown") {
    return svg(`
      <g transform="rotate(-14 512 360)">
        <rect x="275" y="340" width="474" height="80" fill="${gold}"/>
        <rect x="275" y="400" width="474" height="22" fill="${goldDark}"/>
        <polygon points="290,340 320,170 360,340" fill="${gold}"/>
        <polygon points="370,340 420,130 470,340" fill="${gold}"/>
        <polygon points="478,340 512,140 548,340" fill="${gold}"/>
        <polygon points="554,340 604,160 654,340" fill="${gold}"/>
        <polygon points="664,340 700,190 740,340" fill="${gold}"/>
        <circle cx="420" cy="385" r="22" fill="#E63946"/>
        <circle cx="512" cy="385" r="26" fill="#3B82F6"/>
        <circle cx="604" cy="385" r="22" fill="#9D4EDD"/>
      </g>
      <!-- Gold drops -->
      <ellipse cx="300" cy="480" rx="16" ry="26" fill="${gold}"/>
      <ellipse cx="600" cy="490" rx="18" ry="30" fill="${gold}"/>
      <ellipse cx="420" cy="455" rx="14" ry="22" fill="${gold}"/>
      <ellipse cx="730" cy="475" rx="16" ry="26" fill="${gold}"/>
    `);
  }
  if (hat === "cowboy") {
    return svg(`
      <ellipse cx="512" cy="340" rx="150" ry="120" fill="${hatColor}"/>
      <rect x="462" y="260" width="100" height="50" rx="24" fill="${hatDark}"/>
      <ellipse cx="512" cy="410" rx="320" ry="50" fill="${hatColor}"/>
      <ellipse cx="512" cy="424" rx="320" ry="40" fill="${hatDark}"/>
      <rect x="380" y="360" width="264" height="30" fill="${hatDark}"/>
      <polygon points="512,360 520,378 540,378 525,390 530,408 512,398 494,408 499,390 484,378 504,378" fill="${gold}"/>
    `);
  }
  if (hat === "top_hat") {
    return svg(`
      <rect x="390" y="130" width="244" height="260" fill="${black}"/>
      <rect x="390" y="340" width="244" height="38" fill="${hatColor}"/>
      <rect x="310" y="380" width="404" height="40" rx="6" fill="${black}"/>
      <rect x="400" y="140" width="14" height="200" fill="#3A3A3A"/>
    `);
  }
  if (hat === "beanie") {
    return svg(`
      <path d="M 250 410 Q 250 160 512 150 Q 774 160 774 410 Z" fill="${hatColor}"/>
      <rect x="250" y="375" width="524" height="55" fill="${hatDark}"/>
      <circle cx="512" cy="140" r="40" fill="${white}"/>
      <circle cx="498" cy="122" r="14" fill="#DDDDDD"/>
    `);
  }
  if (hat === "baseball") {
    return svg(`
      <ellipse cx="512" cy="320" rx="190" ry="130" fill="${hatColor}"/>
      <path d="M 340 380 Q 130 395 70 380 L 70 420 Q 130 430 340 410 Z" fill="${hatColor}"/>
      <path d="M 340 400 Q 130 410 70 400 L 70 420 Q 130 430 340 410 Z" fill="${hatDark}"/>
      <circle cx="512" cy="215" r="14" fill="${hatDark}"/>
      <circle cx="512" cy="310" r="36" fill="${hatDark}"/>
      <circle cx="512" cy="310" r="22" fill="${white}"/>
    `);
  }
  if (hat === "chef") {
    return svg(`
      <circle cx="420" cy="220" r="100" fill="${white}"/>
      <circle cx="512" cy="180" r="115" fill="${white}"/>
      <circle cx="604" cy="220" r="100" fill="${white}"/>
      <rect x="360" y="260" width="304" height="150" rx="40" fill="${white}"/>
      <rect x="360" y="380" width="304" height="40" fill="#DDDDDD"/>
    `);
  }
  if (hat === "party") {
    return svg(`
      <polygon points="512,100 370,420 654,420" fill="${hatColor}"/>
      <polygon points="512,100 472,175 552,175" fill="${white}"/>
      <polygon points="486,225 455,295 570,295 538,225" fill="${white}"/>
      <polygon points="434,350 405,420 619,420 590,350" fill="${white}"/>
      <rect x="350" y="405" width="324" height="24" fill="${hatDark}"/>
      <circle cx="512" cy="92" r="34" fill="${gold}"/>
    `);
  }
  if (hat === "halo") {
    // SOLID gold ellipse (disc) floating above — guaranteed to render at preview
    return svg(`
      <ellipse cx="512" cy="170" rx="200" ry="50" fill="${gold}"/>
      <ellipse cx="512" cy="170" rx="200" ry="50" fill="none" stroke="${goldDark}" stroke-width="8"/>
      <ellipse cx="512" cy="160" rx="170" ry="28" fill="#FFF4B8" opacity="0.6"/>
      <!-- Glow -->
      <ellipse cx="512" cy="170" rx="240" ry="62" fill="none" stroke="${gold}" stroke-width="10" opacity="0.4"/>
    `);
  }
  if (hat === "devil_horns") {
    const horn = "#8B0000", hornLight = "#C94A3F";
    return svg(`
      <path d="M 370 410 Q 280 260 330 150 Q 400 230 440 410 Z" fill="${horn}" stroke="${hornLight}" stroke-width="8"/>
      <path d="M 654 410 Q 744 260 694 150 Q 624 230 584 410 Z" fill="${horn}" stroke="${hornLight}" stroke-width="8"/>
    `);
  }
  if (hat === "tinfoil") {
    return svg(`
      <polygon points="512,120 340,410 684,410" fill="#B0B0B0"/>
      <polygon points="512,120 395,410 465,410 475,220" fill="#E8E8E8"/>
      <polygon points="420,320 455,335 435,355" fill="#777"/>
      <polygon points="570,290 605,305 585,325" fill="#777"/>
      <rect x="315" y="395" width="394" height="35" fill="#999"/>
      <rect x="315" y="420" width="394" height="16" fill="#666"/>
      <line x1="512" y1="120" x2="512" y2="50" stroke="#555" stroke-width="8"/>
      <circle cx="512" cy="42" r="16" fill="#333"/>
      <circle cx="512" cy="42" r="6" fill="${gold}"/>
    `);
  }
  if (hat === "jester") {
    const red = "#E63946", yellow = "#F4D04D", green = "#27AE60";
    return svg(`
      <rect x="310" y="360" width="404" height="60" fill="${yellow}"/>
      <rect x="310" y="410" width="404" height="18" fill="${goldDark}"/>
      <polygon points="370,360 400,396 370,422 340,396" fill="${red}"/>
      <polygon points="450,360 480,396 450,422 420,396" fill="${red}"/>
      <polygon points="530,360 560,396 530,422 500,396" fill="${red}"/>
      <polygon points="610,360 640,396 610,422 580,396" fill="${red}"/>
      <path d="M 390 360 Q 200 210 160 380 Q 180 410 220 385 Q 280 320 390 360 Z" fill="${red}"/>
      <path d="M 490 360 Q 475 160 570 190 Q 580 310 540 360 Z" fill="${yellow}"/>
      <path d="M 634 360 Q 824 210 864 380 Q 844 410 804 385 Q 744 320 634 360 Z" fill="${green}"/>
      <circle cx="170" cy="380" r="30" fill="${gold}" stroke="${goldDark}" stroke-width="5"/>
      <rect x="165" y="405" width="10" height="16" fill="${goldDark}"/>
      <circle cx="560" cy="190" r="26" fill="${gold}" stroke="${goldDark}" stroke-width="5"/>
      <circle cx="854" cy="380" r="30" fill="${gold}" stroke="${goldDark}" stroke-width="5"/>
      <rect x="849" y="405" width="10" height="16" fill="${goldDark}"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// HELD ITEMS — all 200px+ at 1024, positioned at right claw
// ────────────────────────────────────────────────────────────────
type HeldItem =
  | "none" | "money_bag" | "diamond" | "rocket" | "cash_stack"
  | "green_candle" | "trophy" | "coffee" | "laptop" | "briefcase"
  | "gm_bubble";

function pickItem(h: Buffer): HeldItem {
  const v = h[7] % 100;
  if (v < 55) return "none";
  if (v < 64) return "money_bag";
  if (v < 71) return "diamond";
  if (v < 77) return "coffee";
  if (v < 83) return "cash_stack";
  if (v < 88) return "laptop";
  if (v < 92) return "briefcase";
  if (v < 95) return "trophy";
  if (v < 97) return "green_candle";
  if (v < 99) return "rocket";
  return "gm_bubble";
}

function itemSVG(item: HeldItem): string {
  if (item === "none") return "";
  const cx = 760, cy = 280;
  const gold = "#FFD700", goldDark = "#C89B0A", green = "#2EA040", white = "#FFFFFF";
  const black = "#1A1A1A";

  if (item === "money_bag") {
    const bag = "#8B4513", bagDark = "#5C2C0A";
    return svg(`
      <ellipse cx="${cx}" cy="${cy + 50}" rx="110" ry="120" fill="${bag}"/>
      <ellipse cx="${cx + 35}" cy="${cy + 70}" rx="70" ry="90" fill="${bagDark}" opacity="0.35"/>
      <rect x="${cx - 50}" y="${cy - 80}" width="100" height="32" fill="${bagDark}"/>
      <path d="M ${cx - 50} ${cy - 80} Q ${cx - 70} ${cy - 110} ${cx - 30} ${cy - 125}" stroke="${bagDark}" stroke-width="8" fill="none"/>
      <path d="M ${cx + 50} ${cy - 80} Q ${cx + 70} ${cy - 110} ${cx + 30} ${cy - 125}" stroke="${bagDark}" stroke-width="8" fill="none"/>
      ${dollarSign(cx, cy + 60, 90, green)}
    `);
  }
  if (item === "diamond") {
    const dia = "#7FE6FF", shine = "#FFFFFF", deep = "#3088B3";
    return svg(`
      <polygon points="${cx},${cy - 110} ${cx + 100},${cy + 20} ${cx},${cy + 130} ${cx - 100},${cy + 20}"
               fill="${dia}" stroke="${deep}" stroke-width="6"/>
      <polygon points="${cx},${cy - 110} ${cx + 100},${cy + 20} ${cx + 40},${cy + 20} ${cx - 20},${cy - 40}" fill="${shine}"/>
      <polygon points="${cx},${cy - 110} ${cx - 100},${cy + 20} ${cx - 40},${cy + 20} ${cx + 20},${cy - 40}" fill="#B0F0FF"/>
      <polygon points="${cx - 15},${cy - 70} ${cx - 5},${cy - 60} ${cx - 15},${cy - 50} ${cx - 25},${cy - 60}" fill="${shine}"/>
    `);
  }
  if (item === "rocket") {
    const body = "#E8E8E8", stripe = "#E63946", flame = "#FF8800", flameHot = "#FFDD00", fin = "#8B0000";
    return svg(`
      <polygon points="${cx},${cy - 140} ${cx - 55},${cy - 30} ${cx + 55},${cy - 30}" fill="${stripe}"/>
      <rect x="${cx - 55}" y="${cy - 30}" width="110" height="150" fill="${body}" stroke="${black}" stroke-width="4"/>
      <circle cx="${cx}" cy="${cy + 15}" r="24" fill="#3B82F6" stroke="${black}" stroke-width="5"/>
      <rect x="${cx - 55}" y="${cy + 85}" width="110" height="18" fill="${stripe}"/>
      <polygon points="${cx - 55},${cy + 85} ${cx - 100},${cy + 160} ${cx - 55},${cy + 130}" fill="${fin}"/>
      <polygon points="${cx + 55},${cy + 85} ${cx + 100},${cy + 160} ${cx + 55},${cy + 130}" fill="${fin}"/>
      <polygon points="${cx - 48},${cy + 120} ${cx},${cy + 250} ${cx + 48},${cy + 120}" fill="${flame}"/>
      <polygon points="${cx - 24},${cy + 120} ${cx},${cy + 210} ${cx + 24},${cy + 120}" fill="${flameHot}"/>
    `);
  }
  if (item === "cash_stack") {
    return svg(`
      <rect x="${cx - 100}" y="${cy - 25}" width="200" height="80" fill="${green}" transform="rotate(-5 ${cx} ${cy + 15})"/>
      <rect x="${cx - 95}" y="${cy - 18}" width="200" height="85" fill="#3CB054" transform="rotate(4 ${cx} ${cy + 24})"/>
      <rect x="${cx - 90}" y="${cy - 10}" width="200" height="90" rx="6" fill="${green}" stroke="#1F6E2E" stroke-width="5"/>
      ${dollarSign(cx + 5, cy + 35, 70, white)}
    `);
  }
  if (item === "green_candle") {
    return svg(`
      <line x1="${cx}" y1="${cy - 140}" x2="${cx}" y2="${cy + 140}" stroke="#1F6E2E" stroke-width="10"/>
      <rect x="${cx - 55}" y="${cy - 70}" width="110" height="170" fill="${green}" stroke="#1F6E2E" stroke-width="6"/>
      <polygon points="${cx - 40},${cy - 140} ${cx},${cy - 200} ${cx + 40},${cy - 140}" fill="${green}" stroke="#1F6E2E" stroke-width="5"/>
    `);
  }
  if (item === "trophy") {
    return svg(`
      <path d="M ${cx - 100} ${cy - 110} L ${cx + 100} ${cy - 110} L ${cx + 75} ${cy + 30} L ${cx - 75} ${cy + 30} Z"
            fill="${gold}" stroke="${goldDark}" stroke-width="5"/>
      <path d="M ${cx - 100} ${cy - 90} Q ${cx - 160} ${cy - 60} ${cx - 115} ${cy - 10}" stroke="${gold}" stroke-width="22" fill="none"/>
      <path d="M ${cx + 100} ${cy - 90} Q ${cx + 160} ${cy - 60} ${cx + 115} ${cy - 10}" stroke="${gold}" stroke-width="22" fill="none"/>
      <rect x="${cx - 28}" y="${cy + 30}" width="56" height="40" fill="${goldDark}"/>
      <rect x="${cx - 80}" y="${cy + 70}" width="160" height="32" fill="${gold}"/>
      <polygon points="${cx},${cy - 85} ${cx + 12},${cy - 60} ${cx + 40},${cy - 60} ${cx + 18},${cy - 40} ${cx + 28},${cy - 10} ${cx},${cy - 28} ${cx - 28},${cy - 10} ${cx - 18},${cy - 40} ${cx - 40},${cy - 60} ${cx - 12},${cy - 60}" fill="${white}"/>
    `);
  }
  if (item === "coffee") {
    const mug = "#6B3410", mugDark = "#3A1E08", rim = "#8B5A30", steam = "#FFFFFF";
    return svg(`
      <rect x="${cx - 75}" y="${cy - 40}" width="150" height="150" rx="12" fill="${mug}"/>
      <rect x="${cx - 75}" y="${cy - 40}" width="150" height="32" fill="${rim}"/>
      <path d="M ${cx + 75} ${cy} Q ${cx + 160} ${cy + 15} ${cx + 75} ${cy + 75}" stroke="${mug}" stroke-width="30" fill="none"/>
      <path d="M ${cx + 75} ${cy} Q ${cx + 160} ${cy + 15} ${cx + 75} ${cy + 75}" stroke="${mugDark}" stroke-width="12" fill="none"/>
      <ellipse cx="${cx}" cy="${cy - 22}" rx="65" ry="12" fill="#2A1400"/>
      <path d="M ${cx - 20} ${cy - 95} Q ${cx - 5} ${cy - 135} ${cx - 20} ${cy - 175}" stroke="${steam}" stroke-width="14" fill="none" opacity="0.85"/>
      <path d="M ${cx + 20} ${cy - 95} Q ${cx + 35} ${cy - 135} ${cx + 20} ${cy - 175}" stroke="${steam}" stroke-width="14" fill="none" opacity="0.85"/>
    `);
  }
  if (item === "laptop") {
    return svg(`
      <rect x="${cx - 110}" y="${cy - 100}" width="220" height="150" rx="8" fill="#2A2A2A"/>
      <rect x="${cx - 100}" y="${cy - 90}" width="200" height="130" fill="#4AC8FF"/>
      <rect x="${cx - 92}" y="${cy - 78}" width="50" height="10" fill="${white}"/>
      <rect x="${cx - 92}" y="${cy - 60}" width="90" height="10" fill="${white}"/>
      <rect x="${cx - 92}" y="${cy - 42}" width="70" height="10" fill="${white}"/>
      <rect x="${cx - 92}" y="${cy - 24}" width="100" height="10" fill="${white}"/>
      <rect x="${cx - 92}" y="${cy - 6}" width="60" height="10" fill="${white}"/>
      <rect x="${cx - 92}" y="${cy + 12}" width="80" height="10" fill="${white}"/>
      <rect x="${cx - 130}" y="${cy + 50}" width="260" height="36" rx="6" fill="#1A1A1A"/>
    `);
  }
  if (item === "briefcase") {
    const leather = "#3A1E08", strap = "#1A0A00", lock = gold;
    return svg(`
      <rect x="${cx - 50}" y="${cy - 125}" width="100" height="28" rx="12" fill="${strap}"/>
      <rect x="${cx - 40}" y="${cy - 117}" width="80" height="10" fill="${leather}"/>
      <rect x="${cx - 110}" y="${cy - 95}" width="220" height="170" rx="12" fill="${leather}"/>
      <rect x="${cx - 110}" y="${cy - 8}" width="220" height="12" fill="${strap}"/>
      <rect x="${cx - 20}" y="${cy - 14}" width="40" height="34" rx="6" fill="${lock}" stroke="${strap}" stroke-width="3"/>
    `);
  }
  if (item === "gm_bubble") {
    return svg(`
      <rect x="${cx - 135}" y="${cy - 100}" width="270" height="160" rx="28" fill="${white}" stroke="${black}" stroke-width="8"/>
      <polygon points="${cx - 40},${cy + 55} ${cx - 80},${cy + 130} ${cx + 20},${cy + 55}"
               fill="${white}" stroke="${black}" stroke-width="8"/>
      <polygon points="${cx - 38},${cy + 57} ${cx - 75},${cy + 120} ${cx + 18},${cy + 57}" fill="${white}"/>
      <!-- G -->
      <path d="M ${cx - 80} ${cy - 55} L ${cx - 105} ${cy - 55} L ${cx - 105} ${cy + 20} L ${cx - 40} ${cy + 20} L ${cx - 40} ${cy - 10} L ${cx - 65} ${cy - 10}"
            stroke="${black}" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <!-- M -->
      <path d="M ${cx + 10} ${cy + 20} L ${cx + 10} ${cy - 55} L ${cx + 45} ${cy - 15} L ${cx + 80} ${cy - 55} L ${cx + 80} ${cy + 20}"
            stroke="${black}" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// GOLD CHAIN — visible chunky links + $ medallion
// ────────────────────────────────────────────────────────────────
function pickGoldChain(h: Buffer): boolean {
  return (h[14] % 10) === 0;
}

function goldChainSVG(): string {
  const gold = "#FFD700", goldDark = "#C89B0A";
  return svg(`
    <!-- Main chain arc (thick) -->
    <path d="M 250 580 Q 420 690 512 660 Q 604 690 774 580" stroke="${gold}" stroke-width="30" fill="none"/>
    <path d="M 250 580 Q 420 690 512 660 Q 604 690 774 580" stroke="${goldDark}" stroke-width="12" fill="none"/>
    <!-- Link circles for texture -->
    <circle cx="290" cy="610" r="18" fill="${gold}" stroke="${goldDark}" stroke-width="3"/>
    <circle cx="360" cy="645" r="18" fill="${gold}" stroke="${goldDark}" stroke-width="3"/>
    <circle cx="430" cy="668" r="18" fill="${gold}" stroke="${goldDark}" stroke-width="3"/>
    <circle cx="600" cy="668" r="18" fill="${gold}" stroke="${goldDark}" stroke-width="3"/>
    <circle cx="670" cy="645" r="18" fill="${gold}" stroke="${goldDark}" stroke-width="3"/>
    <circle cx="730" cy="610" r="18" fill="${gold}" stroke="${goldDark}" stroke-width="3"/>
    <!-- Big medallion -->
    <circle cx="512" cy="720" r="60" fill="${gold}" stroke="${goldDark}" stroke-width="8"/>
    ${dollarSign(512, 722, 70, goldDark)}
  `);
}

// ────────────────────────────────────────────────────────────────
// MOUTH — big recognizable accessories only
// ────────────────────────────────────────────────────────────────
type Mouth = "none" | "cigarette" | "joint" | "tongue" | "clown_nose";

function pickMouth(h: Buffer): Mouth {
  const v = h[12] % 100;
  if (v < 72) return "none";
  if (v < 83) return "cigarette";
  if (v < 90) return "joint";
  if (v < 95) return "tongue";
  return "clown_nose";
}

function mouthSVG(mouth: Mouth): string {
  if (mouth === "none") return "";
  const white = "#F5F5F5", red = "#E63946", pink = "#FF69B4";
  const ember = "#FF8800", smoke = "#BFBFBF";
  const mx = 580, my = 490;

  if (mouth === "cigarette") {
    return svg(`
      <rect x="${mx}" y="${my}" width="180" height="26" rx="6" fill="${white}" stroke="#CCC" stroke-width="3"/>
      <rect x="${mx + 180}" y="${my}" width="28" height="26" fill="${ember}"/>
      <rect x="${mx + 184}" y="${my + 3}" width="20" height="20" fill="${red}"/>
      <circle cx="${mx + 220}" cy="${my - 40}" r="20" fill="${smoke}" opacity="0.6"/>
      <circle cx="${mx + 250}" cy="${my - 90}" r="26" fill="${smoke}" opacity="0.45"/>
      <circle cx="${mx + 285}" cy="${my - 150}" r="32" fill="${smoke}" opacity="0.3"/>
    `);
  }
  if (mouth === "joint") {
    return svg(`
      <g transform="rotate(-8 ${mx + 80} ${my + 15})">
        <rect x="${mx}" y="${my}" width="200" height="32" rx="6" fill="${white}" stroke="#DDD" stroke-width="3"/>
        <rect x="${mx + 200}" y="${my}" width="32" height="32" fill="${ember}"/>
        <rect x="${mx + 204}" y="${my + 3}" width="24" height="26" fill="${red}"/>
      </g>
      <circle cx="${mx + 250}" cy="${my - 60}" r="32" fill="${smoke}" opacity="0.65"/>
      <circle cx="${mx + 250}" cy="${my - 60}" r="32" fill="none" stroke="#909090" stroke-width="5" opacity="0.6"/>
      <circle cx="${mx + 300}" cy="${my - 130}" r="38" fill="${smoke}" opacity="0.5"/>
      <circle cx="${mx + 300}" cy="${my - 130}" r="38" fill="none" stroke="#909090" stroke-width="5" opacity="0.5"/>
      <circle cx="${mx + 350}" cy="${my - 200}" r="42" fill="${smoke}" opacity="0.35"/>
    `);
  }
  if (mouth === "tongue") {
    return svg(`
      <ellipse cx="${mx - 10}" cy="${my + 40}" rx="50" ry="60" fill="${pink}" stroke="#D64A8F" stroke-width="5"/>
      <line x1="${mx - 10}" y1="${my + 5}" x2="${mx - 10}" y2="${my + 80}" stroke="#D64A8F" stroke-width="6"/>
    `);
  }
  if (mouth === "clown_nose") {
    return svg(`
      <circle cx="512" cy="505" r="70" fill="${red}" stroke="#8B0000" stroke-width="8"/>
      <ellipse cx="488" cy="485" rx="24" ry="16" fill="${white}" opacity="0.6"/>
    `);
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// Orb background / highlight
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

// ── Legacy stubs ──
export type Grid = (string | null)[][];
export const GRID_SIZE = 28;
export interface Palette { bg: string; }
export function buildFaceGrid(_p: Buffer, _v: Buffer): Grid { return []; }
export function hashToPalette(_p: Buffer, v: Buffer): Palette {
  return { bg: BG_COLORS[v[0] % BG_COLORS.length] };
}
export function renderFaceSVG(_g: Grid, _p: Palette): string { return ""; }
