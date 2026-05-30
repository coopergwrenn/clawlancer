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

const WALL = "#e9ddc7"; // warm plaster
const WALL_SHADE = "#dccdb0";
const FLOOR = "#c9a87e"; // warm wood
const DESK = "#8a5a3b";
const DESK_TOP = "#a06a44";
const CHAIR = "#5b6b7a";
const SCREEN = "#1c2733";
const SCREEN_GLOW = "#2f4a63";
const RUG = "#b5654a";
const PLANT = "#3f7d4f";
const POT = "#a4623a";
const MUG = "#e8e2d6";

export function OfficeRoom() {
  return (
    <group>
      {/* ── Floor ── */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[6, 6]} />
        <meshStandardMaterial color={FLOOR} roughness={0.85} />
      </mesh>

      {/* ── Rug (the cozy nap corner anchor) ── */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[1.15, 0.002, 0.85]}>
        <circleGeometry args={[0.7, 32]} />
        <meshStandardMaterial color={RUG} roughness={0.95} />
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

      {/* ── Window (emissive — the "daylight"; day/night tint comes later) ── */}
      <mesh position={[-1.3, 1.5, -1.44]}>
        <planeGeometry args={[1.3, 1.0]} />
        <meshStandardMaterial
          color="#bfe3f5"
          emissive="#cdeafb"
          emissiveIntensity={0.55}
          roughness={0.4}
        />
      </mesh>
      {/* window frame */}
      <mesh position={[-1.3, 1.5, -1.43]}>
        <boxGeometry args={[1.42, 1.12, 0.04]} />
        <meshStandardMaterial color={DESK} roughness={0.7} />
      </mesh>

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
            emissiveIntensity={0.7}
            roughness={0.3}
          />
        </mesh>
        {/* monitor stand */}
        <mesh castShadow position={[0, 0.6, -0.18]}>
          <boxGeometry args={[0.06, 0.16, 0.06]} />
          <meshStandardMaterial color={SCREEN} roughness={0.5} />
        </mesh>
        {/* coffee mug */}
        <mesh castShadow position={[0.55, 0.58, 0.12]}>
          <cylinderGeometry args={[0.05, 0.045, 0.1, 16]} />
          <meshStandardMaterial color={MUG} roughness={0.5} />
        </mesh>
      </group>

      {/* ── Chair ── */}
      <group position={[0, 0, 0.55]}>
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
