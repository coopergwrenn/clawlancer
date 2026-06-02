"use client";

/**
 * The Floor — the office room (docs/prd/the-floor.md §7).
 *
 * MVP static geometry: a warm, cozy little workspace built from primitives —
 * floor, two back walls, a desk with a monitor, a chair, a window, a rug, a
 * coffee mug, a plant. No animation here (the room doesn't move); Larry is the
 * moving soul. This is the "core room" of §7 — desk + window + (nap corner via
 * the rug). Skill-gated stations (trading floor, mailroom, etc.) and the
 * crab-native tidepool dressing land in the polish phase.
 *
 * Kept deliberately separate from lighting (FloorScene owns the lights, incl.
 * the effort-tier desk lamp) and from Larry, so each boundary is clean.
 */

const WALL = "#d9c4a0"; // warm plaster (deepened so it reads cozy, not bright)
const WALL_SHADE = "#c9b289";
const FLOOR = "#b58e5d"; // warmer, deeper wood
const DESK = "#7a4d30"; // richer walnut
const DESK_TOP = "#9a6238";
const CHAIR = "#5b6b7a";
const SCREEN = "#1c2733";
const SCREEN_GLOW = "#3a5a76";
const RUG = "#b35a44"; // cozy terracotta
const RUG_RING = "#9c4a38"; // a darker ring for a woven-rug read
const PLANT = "#3f7d4f";
const POT = "#a4623a";
const MUG = "#e8e2d6";
const LAMP = "#3c4753"; // dark metal lamp
const LAMP_GLOW = "#ffdba0"; // warm bulb/shade underside
const PAPER = "#efe7d6"; // warm off-white paper
const STICKY = "#f4c95b"; // a little yellow sticky note
const SUCC = "#5fa06a"; // desk succulent

export function OfficeRoom() {
  return (
    <group>
      {/* ── Floor ── */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[6, 6]} />
        <meshStandardMaterial color={FLOOR} roughness={0.85} />
      </mesh>

      {/* ── Rug — a woven two-ring round rug; the cozy anchor Larry rests on ── */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[1.15, 0.002, 0.85]}>
        <circleGeometry args={[0.82, 48]} />
        <meshStandardMaterial color={RUG_RING} roughness={0.97} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[1.15, 0.004, 0.85]}>
        <circleGeometry args={[0.66, 48]} />
        <meshStandardMaterial color={RUG} roughness={0.97} />
      </mesh>

      {/* ── Back walls (L-shape) ── */}
      <mesh receiveShadow position={[0, 1.25, -1.5]}>
        <boxGeometry args={[6, 2.5, 0.1]} />
        <meshStandardMaterial color={WALL} roughness={0.9} />
      </mesh>
      <mesh receiveShadow position={[-3, 1.25, 0]}>
        <boxGeometry args={[0.1, 2.5, 6]} />
        <meshStandardMaterial color={WALL_SHADE} roughness={0.9} />
      </mesh>

      {/* ── Window — the cool "daylight" pane. Bright emissive so it reads as a
          real light source (and the bloom pass will halo it); the cool fill +
          rim lights in FloorScene are this glow made physical. Step 4 swaps the
          flat fill for a sky/sea gradient (the tidepool porthole). ── */}
      <mesh position={[-1.3, 1.5, -1.44]}>
        <planeGeometry args={[1.3, 1.0]} />
        <meshStandardMaterial
          color="#d4ecfb"
          emissive="#cfe6fb"
          emissiveIntensity={1.5}
          roughness={0.35}
          toneMapped={false}
        />
      </mesh>
      {/* window frame — a HOLLOW frame (4 bars + a cottage muntin cross) so the
          cool daylight pane actually shows through and reads as a window/light
          source, instead of a solid slab that looked like a dark painting. */}
      <group position={[-1.3, 1.5, -1.43]}>
        {/* outer frame bars */}
        <mesh position={[0, 0.55, 0]}>
          <boxGeometry args={[1.5, 0.1, 0.07]} />
          <meshStandardMaterial color={DESK} roughness={0.7} />
        </mesh>
        <mesh position={[0, -0.55, 0]}>
          <boxGeometry args={[1.5, 0.1, 0.07]} />
          <meshStandardMaterial color={DESK} roughness={0.7} />
        </mesh>
        <mesh position={[-0.7, 0, 0]}>
          <boxGeometry args={[0.1, 1.2, 0.07]} />
          <meshStandardMaterial color={DESK} roughness={0.7} />
        </mesh>
        <mesh position={[0.7, 0, 0]}>
          <boxGeometry args={[0.1, 1.2, 0.07]} />
          <meshStandardMaterial color={DESK} roughness={0.7} />
        </mesh>
        {/* muntin cross (thin, just in front of the pane) */}
        <mesh position={[0, 0, 0.005]}>
          <boxGeometry args={[1.36, 0.04, 0.05]} />
          <meshStandardMaterial color={DESK} roughness={0.7} />
        </mesh>
        <mesh position={[0, 0, 0.005]}>
          <boxGeometry args={[0.04, 1.06, 0.05]} />
          <meshStandardMaterial color={DESK} roughness={0.7} />
        </mesh>
      </group>

      {/* ── Desk ── */}
      <group position={[0, 0, -0.55]}>
        {/* top */}
        <mesh castShadow receiveShadow position={[0, 0.5, 0]}>
          <boxGeometry args={[1.6, 0.08, 0.7]} />
          <meshStandardMaterial color={DESK_TOP} roughness={0.6} />
        </mesh>
        {/* legs */}
        {[
          [-0.72, 0.25, -0.28],
          [0.72, 0.25, -0.28],
          [-0.72, 0.25, 0.28],
          [0.72, 0.25, 0.28],
        ].map((p, i) => (
          <mesh key={i} castShadow position={p as [number, number, number]}>
            <boxGeometry args={[0.07, 0.5, 0.07]} />
            <meshStandardMaterial color={DESK} roughness={0.7} />
          </mesh>
        ))}
        {/* monitor */}
        <mesh castShadow position={[0, 0.78, -0.18]}>
          <boxGeometry args={[0.62, 0.4, 0.04]} />
          <meshStandardMaterial color={SCREEN} roughness={0.4} />
        </mesh>
        {/* monitor glow (the screen) */}
        <mesh position={[0, 0.78, -0.157]}>
          <planeGeometry args={[0.56, 0.34]} />
          <meshStandardMaterial
            color={SCREEN_GLOW}
            emissive={SCREEN_GLOW}
            emissiveIntensity={1.0}
            roughness={0.3}
          />
        </mesh>
        {/* faint "content" line on the screen — reads as activity, not a blank panel */}
        <mesh position={[-0.06, 0.82, -0.155]}>
          <planeGeometry args={[0.3, 0.03]} />
          <meshStandardMaterial color="#bfe0ff" emissive="#bfe0ff" emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
        <mesh position={[-0.12, 0.76, -0.155]}>
          <planeGeometry args={[0.18, 0.025]} />
          <meshStandardMaterial color="#bfe0ff" emissive="#bfe0ff" emissiveIntensity={1.0} toneMapped={false} />
        </mesh>
        {/* monitor stand */}
        <mesh castShadow position={[0, 0.6, -0.18]}>
          <boxGeometry args={[0.06, 0.16, 0.06]} />
          <meshStandardMaterial color={SCREEN} roughness={0.5} />
        </mesh>

        {/* ── Coffee mug (with handle) ── */}
        <mesh castShadow position={[0.46, 0.605, 0.2]}>
          <cylinderGeometry args={[0.06, 0.054, 0.13, 20]} />
          <meshStandardMaterial color={MUG} roughness={0.5} />
        </mesh>
        <mesh position={[0.46, 0.62, 0.2]}>
          <cylinderGeometry args={[0.052, 0.052, 0.005, 16]} />
          <meshStandardMaterial color="#5a3a24" roughness={0.6} />
        </mesh>
        <mesh castShadow position={[0.525, 0.605, 0.2]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.035, 0.012, 10, 20]} />
          <meshStandardMaterial color={MUG} roughness={0.5} />
        </mesh>

        {/* ── Desk lamp (back-right; arches over and motivates the warm pool) ── */}
        <mesh castShadow position={[0.6, 0.565, -0.16]}>
          <cylinderGeometry args={[0.09, 0.1, 0.03, 20]} />
          <meshStandardMaterial color={LAMP} roughness={0.45} metalness={0.2} />
        </mesh>
        <mesh castShadow position={[0.58, 0.74, -0.13]} rotation={[0.4, 0, 0.18]}>
          <cylinderGeometry args={[0.016, 0.016, 0.4, 10]} />
          <meshStandardMaterial color={LAMP} roughness={0.45} metalness={0.2} />
        </mesh>
        <mesh castShadow position={[0.48, 0.92, 0.02]} rotation={[0.35, 0, 0]}>
          <coneGeometry args={[0.12, 0.15, 24, 1, true]} />
          <meshStandardMaterial color="#e7d8b8" roughness={0.5} side={2} />
        </mesh>
        {/* bulb glow under the shade */}
        <mesh position={[0.47, 0.88, 0.05]}>
          <sphereGeometry args={[0.045, 16, 12]} />
          <meshStandardMaterial color={LAMP_GLOW} emissive={LAMP_GLOW} emissiveIntensity={2.2} toneMapped={false} />
        </mesh>

        {/* ── A small stack of papers + a sticky note (lived-in) ── */}
        <mesh castShadow position={[0.06, 0.553, 0.2]} rotation={[0, 0.16, 0]}>
          <boxGeometry args={[0.2, 0.014, 0.26]} />
          <meshStandardMaterial color={PAPER} roughness={0.85} />
        </mesh>
        <mesh castShadow position={[0.04, 0.562, 0.2]} rotation={[0, -0.1, 0]}>
          <boxGeometry args={[0.19, 0.012, 0.25]} />
          <meshStandardMaterial color="#e3d8c2" roughness={0.85} />
        </mesh>
        <mesh position={[-0.13, 0.566, 0.26]} rotation={[0, 0.3, 0]}>
          <boxGeometry args={[0.075, 0.006, 0.075]} />
          <meshStandardMaterial color={STICKY} roughness={0.8} />
        </mesh>

        {/* ── Tiny desk succulent ── */}
        <mesh castShadow position={[-0.52, 0.6, 0.16]}>
          <cylinderGeometry args={[0.055, 0.048, 0.09, 16]} />
          <meshStandardMaterial color={POT} roughness={0.7} />
        </mesh>
        {[
          [0, 0.08, 0],
          [0.035, 0.06, 0.02],
          [-0.035, 0.06, -0.02],
          [0.02, 0.055, -0.035],
        ].map((p, i) => (
          <mesh key={i} castShadow position={[-0.52 + p[0], 0.64 + p[1], 0.16 + p[2]]} scale={[0.6, 1.3, 0.6]}>
            <sphereGeometry args={[0.04, 10, 8]} />
            <meshStandardMaterial color={SUCC} roughness={0.8} />
          </mesh>
        ))}
      </group>

      {/* ── Chair ── tucked to the left and angled toward the desk, so it
          dresses the room without standing between Larry (at the desk) and the
          camera. ── */}
      <group position={[-1.0, 0, 0.5]} rotation={[0, 0.6, 0]}>
        <mesh castShadow position={[0, 0.42, 0]}>
          <boxGeometry args={[0.42, 0.08, 0.42]} />
          <meshStandardMaterial color={CHAIR} roughness={0.7} />
        </mesh>
        <mesh castShadow position={[0, 0.66, -0.18]}>
          <boxGeometry args={[0.42, 0.4, 0.06]} />
          <meshStandardMaterial color={CHAIR} roughness={0.7} />
        </mesh>
        {/* post */}
        <mesh castShadow position={[0, 0.2, 0]}>
          <cylinderGeometry args={[0.04, 0.04, 0.4, 8]} />
          <meshStandardMaterial color="#3c4753" roughness={0.6} />
        </mesh>
      </group>

      {/* ── Desk plant (a sprig of kelp-green) ── */}
      <group position={[-1.0, 0, -0.7]}>
        <mesh castShadow position={[0, 0.12, 0]}>
          <cylinderGeometry args={[0.1, 0.12, 0.24, 12]} />
          <meshStandardMaterial color={POT} roughness={0.7} />
        </mesh>
        <mesh castShadow position={[0, 0.34, 0]}>
          <sphereGeometry args={[0.16, 12, 10]} />
          <meshStandardMaterial color={PLANT} roughness={0.8} />
        </mesh>
      </group>
    </group>
  );
}
