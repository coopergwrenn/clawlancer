"use client";

/**
 * The Floor — the office room (docs/prd/the-floor.md §7).
 *
 * A warm, upscale, cozy little study, built from primitives (no texture assets,
 * so it stays demand-render-cheap). The design point of view: a moody-but-warm
 * creative's study at golden hour —
 *   - A full WALNUT-PANELED LIBRARY WALL (deep walnut field, framed raised
 *     panels top + bottom, crisp cream rails + cornice). The dark wood recedes
 *     to warm shadow so Larry's orange POPS, and the panel relief reads
 *     "designed study," not "flat beige box."
 *   - WARM OAK plank floor with a subtle tidepool-caustic shimmer, a layered
 *     cream-bordered rug as the cozy anchor Larry rests on.
 *   - mid-century walnut DESK (tapered legs, leather pad, brass edge, a warm
 *     lamp pool) + a soft-fabric mid-century CHAIR.
 *   - curated decor: a floating shelf of books + a plant, a statement plant, a
 *     brass desk lamp, the glowing monitor — lived-in, not cluttered.
 *
 * The hero camera frames Larry tight (desktop) / pulls back to the full room
 * (mobile), so the design has to read at both — the paneled wall + cream lines
 * carry the upper room on mobile; the warm desk pool + rug carry the intimate
 * desktop close-up.
 *
 * Lighting lives in FloorScene (a raking warm key + cool fill + rim + gentle
 * wall grazes + the effort-tier desk lamp); Larry lives in larry.tsx. Clean
 * boundaries, on purpose.
 */

// ── Palette ── a considered warm/cool scheme so surfaces read as real materials
//    and Larry (warm orange) pops against the cool-green walls + woods.
// Warm greige limewash plaster — a designed NEUTRAL (not orange, so Larry pops;
// not muddy). It reads as itself under the warm key, and the "expensive" comes
// from the wood wainscot + brass + curated art + plants + layered light.
const WALL = "#3c2818"; // deep walnut upper wall — a rich paneled library field
                        // that recedes to warm shadow so Larry's orange pops
const WALL_PANEL = "#4c3422"; // raised upper-panel face (catches the warm key)
const WALL_SHADE = "#33220f"; // side wall, a hair deeper (corner depth)
const WAINSCOT = "#5f3f29"; // walnut lower-wall paneling
const WAINSCOT_HI = "#714c31"; // raised panel faces (catch the warm key)
const TRIM = "#e6d7bc"; // warm cream chair-rail + baseboard
const FLOOR = "#9a7245"; // warm oak plank floor
const FLOOR_SEAM = "#7a5532"; // plank seams
const DESK = "#5a3a24"; // walnut desk frame / legs
const DESK_TOP = "#794d2f"; // walnut desk top
const LEATHER = "#34281f"; // dark leather desk pad
const CHAIR_WOOD = "#7a5333"; // mid-century chair wood
const CHAIR_FABRIC = "#3f6b67"; // muted teal seat — the cool designer accent
const SCREEN = "#141b22"; // monitor bezel
const SCREEN_GLOW = "#3a5a76"; // screen
const BRASS = "#c79a55"; // warm brass — lamp arm, frames, knobs
const BRASS_DK = "#9c7338";
const RUG_FIELD = "#ae5839"; // warm rust rug field
const RUG_BORDER = "#dcc7a1"; // cream rug border
const RUG_LINE = "#7c3e2c"; // thin accent ring
const POT_CREAM = "#e2d5bc"; // ceramic pot (cream)
const POT_CLAY = "#ad6a40"; // terracotta pot
const LEAF = "#508a5b"; // plant leaf green
const LEAF_DK = "#3c6c49"; // deeper leaf
const MUG = "#e8e2d6";
const PAPER = "#efe7d6";
const STICKY = "#f4c95b";
const BOOK_A = "#9a4f39"; // warm rust spine
const BOOK_B = "#3f6b67"; // teal spine
const BOOK_C = "#c79a55"; // brass spine
const BOOK_D = "#d8c8aa"; // cream spine
const BOOK_E = "#5a6f57"; // sage spine

/** A book lying or standing — a little colored box. */
function Book({
  position,
  rotation = [0, 0, 0],
  size,
  color,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  size: [number, number, number];
  color: string;
}) {
  return (
    <mesh castShadow position={position} rotation={rotation}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.8} />
    </mesh>
  );
}

/** A leafy statement plant — paddle leaves splayed out of a ceramic pot. */
function StatementPlant({ position }: { position: [number, number, number] }) {
  // splay angles for the paddle leaves (z-roll, y-yaw), tall + organic
  const leaves: Array<{ roll: number; yaw: number; len: number; tint: string }> = [
    { roll: 0.12, yaw: 0.0, len: 0.62, tint: LEAF },
    { roll: -0.42, yaw: 0.7, len: 0.55, tint: LEAF_DK },
    { roll: 0.5, yaw: -0.6, len: 0.5, tint: LEAF },
    { roll: -0.2, yaw: 1.5, len: 0.46, tint: LEAF_DK },
    { roll: 0.34, yaw: -1.6, len: 0.42, tint: LEAF },
    { roll: 0.0, yaw: 2.6, len: 0.4, tint: LEAF_DK },
  ];
  return (
    <group position={position}>
      {/* ceramic pot */}
      <mesh castShadow position={[0, 0.16, 0]}>
        <cylinderGeometry args={[0.17, 0.13, 0.32, 24]} />
        <meshStandardMaterial color={POT_CREAM} roughness={0.55} />
      </mesh>
      {/* soil */}
      <mesh position={[0, 0.31, 0]}>
        <cylinderGeometry args={[0.16, 0.16, 0.02, 20]} />
        <meshStandardMaterial color="#3a2a1d" roughness={0.95} />
      </mesh>
      {/* paddle leaves: a stem (thin cylinder) + a flattened blade */}
      {leaves.map((l, i) => (
        <group key={i} position={[0, 0.32, 0]} rotation={[0, l.yaw, l.roll]}>
          <mesh castShadow position={[0, l.len * 0.45, 0]}>
            <cylinderGeometry args={[0.012, 0.018, l.len * 0.9, 8]} />
            <meshStandardMaterial color={LEAF_DK} roughness={0.8} />
          </mesh>
          <mesh
            castShadow
            position={[0, l.len * 0.92, 0]}
            scale={[0.13, l.len * 0.55, 0.03]}
          >
            <sphereGeometry args={[1, 14, 10]} />
            <meshStandardMaterial color={l.tint} roughness={0.78} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function OfficeRoom() {
  return (
    <group>
      {/* ── Oak plank floor ── warm wood with a few seams so it reads as planks,
          not a flat slab. ── */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[6, 6]} />
        <meshStandardMaterial color={FLOOR} roughness={0.78} />
      </mesh>
      {[-2.2, -1.5, -0.8, -0.1, 0.6, 1.3, 2.0, 2.7].map((z, i) => (
        <mesh
          key={i}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.001, z]}
        >
          <planeGeometry args={[6, 0.012]} />
          <meshStandardMaterial color={FLOOR_SEAM} roughness={0.85} />
        </mesh>
      ))}

      {/* ── Rug ── a layered round rug: cream border, warm rust field, a thin
          accent ring. The cozy anchor Larry rests on; cream makes him pop. ── */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[1.15, 0.002, 0.85]}>
        <circleGeometry args={[0.9, 56]} />
        <meshStandardMaterial color={RUG_BORDER} roughness={0.96} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[1.15, 0.003, 0.85]}>
        <circleGeometry args={[0.8, 56]} />
        <meshStandardMaterial color={RUG_LINE} roughness={0.96} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[1.15, 0.004, 0.85]}>
        <circleGeometry args={[0.74, 56]} />
        <meshStandardMaterial color={RUG_FIELD} roughness={0.97} />
      </mesh>

      {/* ── Walls (L-shape) ── two-tone: deep sage-green above, walnut wainscot
          below, with a cream chair-rail cap + baseboard. This is the "designed
          room" move — flat single-colour walls are what read cheap. ── */}
      {/* BACK wall (faces +Z) — a full walnut-PANELED library wall: deep walnut
          field, framed raised panels top + bottom, crisp cream rails. The warm
          dark wood recedes to shadow so Larry's orange pops hard, and the panel
          relief + cream lines read "designed study," not "flat box". */}
      <group position={[0, 0, -1.5]}>
        {/* deep walnut upper field */}
        <mesh receiveShadow position={[0, 1.66, 0]}>
          <boxGeometry args={[6, 1.68, 0.1]} />
          <meshStandardMaterial color={WALL} roughness={0.82} />
        </mesh>
        {/* upper raised panels (framed, the library look) */}
        {[-2.1, -0.7, 0.7, 2.1].map((x, i) => (
          <group key={i} position={[x, 1.45, 0.052]}>
            {/* panel face */}
            <mesh>
              <boxGeometry args={[1.04, 0.92, 0.02]} />
              <meshStandardMaterial color={WALL_PANEL} roughness={0.7} />
            </mesh>
            {/* thin cream panel molding */}
            <mesh position={[0, 0.48, 0.012]}>
              <boxGeometry args={[1.12, 0.03, 0.012]} />
              <meshStandardMaterial color={TRIM} roughness={0.6} />
            </mesh>
            <mesh position={[0, -0.48, 0.012]}>
              <boxGeometry args={[1.12, 0.03, 0.012]} />
              <meshStandardMaterial color={TRIM} roughness={0.6} />
            </mesh>
            <mesh position={[-0.54, 0, 0.012]}>
              <boxGeometry args={[0.03, 1.0, 0.012]} />
              <meshStandardMaterial color={TRIM} roughness={0.6} />
            </mesh>
            <mesh position={[0.54, 0, 0.012]}>
              <boxGeometry args={[0.03, 1.0, 0.012]} />
              <meshStandardMaterial color={TRIM} roughness={0.6} />
            </mesh>
          </group>
        ))}
        {/* cream cornice at the top */}
        <mesh position={[0, 2.44, 0.06]}>
          <boxGeometry args={[6, 0.1, 0.16]} />
          <meshStandardMaterial color={TRIM} roughness={0.6} />
        </mesh>
        {/* walnut wainscot */}
        <mesh receiveShadow position={[0, 0.41, 0.02]}>
          <boxGeometry args={[6, 0.82, 0.1]} />
          <meshStandardMaterial color={WAINSCOT} roughness={0.78} />
        </mesh>
        {/* raised panel faces on the wainscot (subtle relief) */}
        {[-2.1, -0.7, 0.7, 2.1].map((x, i) => (
          <mesh key={i} position={[x, 0.41, 0.075]}>
            <boxGeometry args={[1.0, 0.58, 0.02]} />
            <meshStandardMaterial color={WAINSCOT_HI} roughness={0.72} />
          </mesh>
        ))}
        {/* cream chair-rail cap */}
        <mesh position={[0, 0.84, 0.05]}>
          <boxGeometry args={[6, 0.07, 0.13]} />
          <meshStandardMaterial color={TRIM} roughness={0.6} />
        </mesh>
        {/* cream baseboard */}
        <mesh position={[0, 0.05, 0.05]}>
          <boxGeometry args={[6, 0.1, 0.12]} />
          <meshStandardMaterial color={TRIM} roughness={0.6} />
        </mesh>
      </group>

      {/* LEFT side wall (faces +X) */}
      <group position={[-3, 0, 0]}>
        <mesh receiveShadow position={[0, 1.66, 0]}>
          <boxGeometry args={[0.1, 1.68, 6]} />
          <meshStandardMaterial color={WALL_SHADE} roughness={0.95} />
        </mesh>
        <mesh receiveShadow position={[0.02, 0.41, 0]}>
          <boxGeometry args={[0.1, 0.82, 6]} />
          <meshStandardMaterial color={WAINSCOT} roughness={0.78} />
        </mesh>
        {[-2.1, -0.7, 0.7, 2.1].map((z, i) => (
          <mesh key={i} position={[0.075, 0.41, z]}>
            <boxGeometry args={[0.02, 0.58, 1.0]} />
            <meshStandardMaterial color={WAINSCOT_HI} roughness={0.72} />
          </mesh>
        ))}
        <mesh position={[0.05, 0.84, 0]}>
          <boxGeometry args={[0.13, 0.07, 6]} />
          <meshStandardMaterial color={TRIM} roughness={0.6} />
        </mesh>
        <mesh position={[0.05, 0.05, 0]}>
          <boxGeometry args={[0.12, 0.1, 6]} />
          <meshStandardMaterial color={TRIM} roughness={0.6} />
        </mesh>
      </group>

      {/* floating walnut shelf with a few books + a tiny plant */}
      <group position={[-2.45, 1.55, -0.2]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.22, 0.04, 1.5]} />
          <meshStandardMaterial color={DESK_TOP} roughness={0.6} />
        </mesh>
        {/* standing books */}
        <Book position={[0, 0.13, -0.4]} size={[0.13, 0.22, 0.05]} color={BOOK_A} />
        <Book position={[0, 0.12, -0.33]} size={[0.13, 0.2, 0.05]} color={BOOK_B} />
        <Book position={[0, 0.135, -0.26]} size={[0.13, 0.23, 0.05]} color={BOOK_C} />
        <Book position={[0, 0.115, -0.19]} size={[0.13, 0.19, 0.05]} color={BOOK_E} />
        {/* a couple lying flat */}
        <Book position={[0, 0.05, 0.32]} size={[0.16, 0.04, 0.24]} color={BOOK_D} />
        <Book position={[0, 0.085, 0.32]} rotation={[0, 0.12, 0]} size={[0.15, 0.035, 0.22]} color={BOOK_B} />
        {/* tiny shelf plant */}
        <mesh castShadow position={[0, 0.1, 0.6]}>
          <cylinderGeometry args={[0.06, 0.05, 0.1, 14]} />
          <meshStandardMaterial color={POT_CLAY} roughness={0.7} />
        </mesh>
        <mesh castShadow position={[0, 0.2, 0.6]}>
          <sphereGeometry args={[0.1, 12, 10]} />
          <meshStandardMaterial color={LEAF} roughness={0.8} />
        </mesh>
      </group>

      {/* ── Desk ── mid-century walnut: thicker top with a thin brass edge, four
          splayed tapered legs, a dark leather desk pad, a nicer monitor. ── */}
      <group position={[0, 0, -0.55]}>
        {/* top */}
        <mesh castShadow receiveShadow position={[0, 0.5, 0]}>
          <boxGeometry args={[1.64, 0.07, 0.72]} />
          <meshStandardMaterial color={DESK_TOP} roughness={0.74} />
        </mesh>
        {/* thin brass edge band (front) */}
        <mesh position={[0, 0.5, 0.365]}>
          <boxGeometry args={[1.64, 0.045, 0.012]} />
          <meshStandardMaterial color={BRASS} roughness={0.45} metalness={0.5} />
        </mesh>
        {/* tapered splayed legs (mid-century) */}
        {[
          [-0.74, -0.3, 0.18],
          [0.74, -0.3, 0.18],
          [-0.74, -0.3, -0.18],
          [0.74, -0.3, -0.18],
        ].map((p, i) => (
          <mesh
            key={i}
            castShadow
            position={[p[0], 0.235, p[2]]}
            rotation={[(p[2] > 0 ? -1 : 1) * 0.12, 0, (p[0] > 0 ? 1 : -1) * 0.1]}
          >
            <cylinderGeometry args={[0.022, 0.04, 0.5, 12]} />
            <meshStandardMaterial color={DESK} roughness={0.6} />
          </mesh>
        ))}

        {/* leather desk pad */}
        <mesh receiveShadow position={[-0.05, 0.539, 0.05]}>
          <boxGeometry args={[0.92, 0.012, 0.42]} />
          <meshStandardMaterial color={LEATHER} roughness={0.55} />
        </mesh>

        {/* monitor — thin slab on a brass-stemmed wood base */}
        <mesh castShadow position={[0, 0.8, -0.2]}>
          <boxGeometry args={[0.66, 0.4, 0.03]} />
          <meshStandardMaterial color={SCREEN} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.8, -0.183]}>
          <planeGeometry args={[0.6, 0.34]} />
          <meshStandardMaterial color={SCREEN_GLOW} emissive={SCREEN_GLOW} emissiveIntensity={1.0} roughness={0.3} />
        </mesh>
        {/* content lines on screen */}
        <mesh position={[-0.07, 0.86, -0.18]}>
          <planeGeometry args={[0.34, 0.03]} />
          <meshStandardMaterial color="#bfe0ff" emissive="#bfe0ff" emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
        <mesh position={[-0.13, 0.79, -0.18]}>
          <planeGeometry args={[0.2, 0.025]} />
          <meshStandardMaterial color="#bfe0ff" emissive="#bfe0ff" emissiveIntensity={1.0} toneMapped={false} />
        </mesh>
        {/* stand */}
        <mesh castShadow position={[0, 0.62, -0.2]}>
          <cylinderGeometry args={[0.018, 0.018, 0.16, 10]} />
          <meshStandardMaterial color={BRASS} roughness={0.4} metalness={0.5} />
        </mesh>
        <mesh castShadow position={[0, 0.545, -0.2]}>
          <cylinderGeometry args={[0.11, 0.12, 0.02, 20]} />
          <meshStandardMaterial color={DESK} roughness={0.5} />
        </mesh>
        {/* keyboard hint */}
        <mesh castShadow position={[0, 0.548, 0.12]}>
          <boxGeometry args={[0.42, 0.018, 0.14]} />
          <meshStandardMaterial color="#262b30" roughness={0.6} />
        </mesh>

        {/* ── Coffee mug (with handle) ── */}
        <mesh castShadow position={[0.5, 0.6, 0.22]}>
          <cylinderGeometry args={[0.06, 0.054, 0.13, 20]} />
          <meshStandardMaterial color={MUG} roughness={0.5} />
        </mesh>
        <mesh position={[0.5, 0.615, 0.22]}>
          <cylinderGeometry args={[0.052, 0.052, 0.005, 16]} />
          <meshStandardMaterial color="#5a3a24" roughness={0.6} />
        </mesh>
        <mesh castShadow position={[0.565, 0.6, 0.22]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.035, 0.012, 10, 20]} />
          <meshStandardMaterial color={MUG} roughness={0.5} />
        </mesh>

        {/* ── Brass desk lamp (back-right; arches over → motivates the warm pool) ── */}
        <mesh castShadow position={[0.62, 0.565, -0.18]}>
          <cylinderGeometry args={[0.085, 0.1, 0.03, 20]} />
          <meshStandardMaterial color={BRASS_DK} roughness={0.4} metalness={0.55} />
        </mesh>
        <mesh castShadow position={[0.6, 0.74, -0.15]} rotation={[0.4, 0, 0.18]}>
          <cylinderGeometry args={[0.015, 0.015, 0.4, 10]} />
          <meshStandardMaterial color={BRASS} roughness={0.4} metalness={0.55} />
        </mesh>
        <mesh castShadow position={[0.5, 0.92, 0.0]} rotation={[0.35, 0, 0]}>
          <coneGeometry args={[0.12, 0.15, 24, 1, true]} />
          <meshStandardMaterial color={BRASS} roughness={0.42} metalness={0.5} side={2} />
        </mesh>
        {/* bulb glow under the shade */}
        <mesh position={[0.49, 0.88, 0.03]}>
          <sphereGeometry args={[0.045, 16, 12]} />
          <meshStandardMaterial color="#ffe6bc" emissive="#ffe6bc" emissiveIntensity={1.3} toneMapped={false} />
        </mesh>

        {/* ── A small stack of books + papers + a sticky note (lived-in) ── */}
        <Book position={[-0.52, 0.527, 0.18]} rotation={[0, 0.2, 0]} size={[0.2, 0.05, 0.15]} color={BOOK_C} />
        <Book position={[-0.52, 0.565, 0.18]} rotation={[0, -0.05, 0]} size={[0.18, 0.045, 0.14]} color={BOOK_A} />
        <mesh castShadow position={[-0.5, 0.6, 0.2]} rotation={[0, 0.16, 0]}>
          <boxGeometry args={[0.16, 0.012, 0.2]} />
          <meshStandardMaterial color={PAPER} roughness={0.85} />
        </mesh>
        <mesh position={[-0.4, 0.61, 0.24]} rotation={[0, 0.3, 0]}>
          <boxGeometry args={[0.065, 0.006, 0.065]} />
          <meshStandardMaterial color={STICKY} roughness={0.8} />
        </mesh>
      </group>

      {/* ── Mid-century chair ── walnut frame, splayed dowel legs, a soft teal
          fabric seat + curved back. Tucked left, angled to the desk. ── */}
      <group position={[-1.0, 0, 0.5]} rotation={[0, 0.6, 0]}>
        {/* seat cushion */}
        <mesh castShadow position={[0, 0.46, 0]}>
          <boxGeometry args={[0.46, 0.1, 0.44]} />
          <meshStandardMaterial color={CHAIR_FABRIC} roughness={0.85} />
        </mesh>
        {/* back cushion (slightly reclined) */}
        <mesh castShadow position={[0, 0.74, -0.2]} rotation={[-0.18, 0, 0]}>
          <boxGeometry args={[0.46, 0.42, 0.1]} />
          <meshStandardMaterial color={CHAIR_FABRIC} roughness={0.85} />
        </mesh>
        {/* wood frame under seat */}
        <mesh castShadow position={[0, 0.4, 0]}>
          <boxGeometry args={[0.48, 0.05, 0.46]} />
          <meshStandardMaterial color={CHAIR_WOOD} roughness={0.55} />
        </mesh>
        {/* splayed dowel legs */}
        {[
          [-0.2, 0.2, 0.4],
          [0.2, 0.2, 0.4],
          [-0.2, -0.2, -0.36],
          [0.2, -0.2, -0.36],
        ].map((p, i) => (
          <mesh
            key={i}
            castShadow
            position={[p[0], 0.2, p[2]]}
            rotation={[(p[2] > 0 ? 1 : -1) * 0.14, 0, (p[0] > 0 ? -1 : 1) * 0.12]}
          >
            <cylinderGeometry args={[0.018, 0.026, 0.42, 10]} />
            <meshStandardMaterial color={CHAIR_WOOD} roughness={0.55} />
          </mesh>
        ))}
      </group>

      {/* ── Statement plant ── a leafy paddle plant in the back-left corner, the
          cozy hit of life + a vertical that layers the space. ── */}
      <StatementPlant position={[-1.95, 0, -0.95]} />

      {/* ── A stack of books on the floor by the chair — lived-in warmth ── */}
      <group position={[-1.95, 0, 0.55]}>
        <Book position={[0, 0.04, 0]} size={[0.3, 0.07, 0.22]} color={BOOK_A} />
        <Book position={[0.01, 0.105, 0]} rotation={[0, 0.18, 0]} size={[0.28, 0.06, 0.2]} color={BOOK_B} />
        <Book position={[-0.01, 0.16, 0]} rotation={[0, -0.1, 0]} size={[0.26, 0.055, 0.2]} color={BOOK_C} />
      </group>
    </group>
  );
}
