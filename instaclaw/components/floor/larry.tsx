"use client";

/**
 * The Floor — Larry (docs/prd/the-floor.md §5, §6, §10.4).
 *
 * THE SOUL OF THE FEATURE. Larry is the user's agent, embodied. This is the
 * MVP primitive rig — a crab built from geometry (body + eyestalks + claws) in
 * the brand orange. It exists to prove the activity→animation pipeline end to
 * end; the rigged low-poly model + tidepool dressing come in the polish phase.
 * But even as primitives, the *motion* is the product, so it's built with care:
 * squash-and-stretch on the perk-up, a sideways crab-scuttle to the desk,
 * eyestalk "acting", and honest rest when idle.
 *
 * ── How it animates (the Village pattern, PRD §10.3) ────────────────────────
 * Larry is a DUMB EXPRESSER. The director (lib/floor/director.ts) decides WHAT
 * Larry is doing; this component decides HOW to show it. Every frame it:
 *   1. reads the director via `useFloorStore.getState()` — NO React subscription,
 *      so polling never re-renders this component (mutation happens outside React).
 *   2. interpolates the rig toward the pose for the current behavior (damp =
 *      framerate-independent smoothing).
 *   3. self-invalidates while still animating, then stops → frameloop="demand"
 *      rests at ~0 GPU when Larry is settled/napping (PRD §12).
 *
 * The magic moment (PRD §24): the director's `perkSeq` bumps on every inbound
 * message. This component watches that counter and fires the perk-up one-shot
 * the instant it changes — even on rapid repeats — so the user ALWAYS feels
 * noticed. That single beat is the whole feature; everything else frames it.
 */

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useFloorStore } from "@/lib/floor/store";
import {
  behaviorNeedsAnimation,
  type DirectorState,
} from "@/lib/floor/director";

// ── Brand palette (matches public/assets/crab-base.png lineage) ─────────────
// Stylized-PBR warmth: a saturated shell, a lighter sun-warmed underbelly, a
// darker shell-rim/leg tone for read, and eyes built for *life* — a warm iris
// plus a bright emissive catch-light the bloom pass will turn into a spark.
const CRAB_ORANGE = "#ec8a3e"; // carapace
const CRAB_ORANGE_DARK = "#bf5f24"; // shell rim, legs, finger tips
const CRAB_UNDERBELLY = "#f6b06a"; // lighter belly + arm undersides
const EYE_WHITE = "#fdf7ee";
const EYE_IRIS = "#73401f"; // warm amber-brown — reads alive, not a dead dot
const EYE_PUPIL = "#1b0f07";
const CATCH_LIGHT = "#fffaf0"; // emissive highlight — the spark of life
const MOUTH = "#3a2316";

// ── Stage positions (world units; ~1 unit ≈ one floor tile) ─────────────────
const HOME_POS = new THREE.Vector3(1.15, 0, 0.85); // resting spot, front-right
const DESK_POS = new THREE.Vector3(0, 0, 0.2); // working spot, at the desk
const GROUND_Y = 0.3; // body-center height when grounded (legs reach the floor)

// ── Timing / amplitudes ─────────────────────────────────────────────────────
const SCUTTLE_LAMBDA = 6; // higher = snappier scuttle toward target x/z
const PERK_POP_MS = 460; // perk-up squash-stretch duration
const HOP_MS = 620; // single celebrate hop duration
const STUMBLE_MS = 900; // error wobble duration

/** Where should Larry be standing for this behavior? */
function targetPosition(d: DirectorState): THREE.Vector3 {
  // He works at the desk; he rests at home. `incoming` keeps him at home for the
  // perk (he notices, THEN scuttles when `working` kicks in 1.5s later).
  if (d.behavior === "working") return DESK_POS;
  return HOME_POS;
}

/** Eyestalk raise factor 0..1 (drooped→alert). The cheapest, most expressive
 *  lever on a simple body — eyestalks are Larry's eyebrows (PRD §5). */
function targetEyeRaise(d: DirectorState): number {
  switch (d.behavior) {
    case "incoming":
    case "celebrating":
      return 1; // wide awake / delighted
    case "working":
      return 0.85; // focused
    case "stumbling":
      return 0.4; // flustered
    case "asleep":
    case "offline":
      return 0; // closed
    case "idle":
      return d.idleLevel === 2 ? 0.12 : d.idleLevel === 1 ? 0.55 : 0.5;
    default:
      return 0.5;
  }
}

/** A smooth 0→1→0 pop envelope (squash-stretch) over a normalized t in [0,1]. */
function popEnvelope(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.sin(t * Math.PI); // single clean overshoot
}

// ── Body-part builders ───────────────────────────────────────────────────────
// Pure geometry (no animation refs yet — the walk cycle / blink / pincer-snap
// land in Step 5). Kept as small components so the rig reads anatomically.

/**
 * One eye on a short stalk. `side` = -1 (left) | +1 (right). Big and forward
 * for baby-schema appeal; iris + pupil converge slightly toward a point in
 * front of Larry so he reads as *looking at you*; an emissive catch-light gives
 * the "alive, not plastic" glint (the bloom pass will make it sparkle).
 */
function CrabEye({ side }: { side: number }) {
  return (
    <group position={[side * 0.1, 0, 0]}>
      {/* stalk — short, slightly outward, so the eye perches on the shell front */}
      <mesh castShadow position={[0, 0.04, 0]} rotation={[0, 0, side * -0.12]}>
        <cylinderGeometry args={[0.027, 0.032, 0.08, 12]} />
        <meshStandardMaterial color={CRAB_ORANGE} roughness={0.5} />
      </mesh>
      {/* eyeball — oversized + forward (the single biggest appeal lever) */}
      <mesh castShadow position={[0, 0.1, 0]}>
        <sphereGeometry args={[0.085, 32, 24]} />
        <meshStandardMaterial color={EYE_WHITE} roughness={0.16} metalness={0} />
      </mesh>
      {/* iris — warm amber, gazing straight forward + a touch down (endearing,
          deliberately NOT converged — straight pupils read friendliest head-on). */}
      <mesh position={[0, 0.09, 0.07]}>
        <sphereGeometry args={[0.046, 24, 18]} />
        <meshStandardMaterial color={EYE_IRIS} roughness={0.25} />
      </mesh>
      {/* pupil */}
      <mesh position={[0, 0.088, 0.083]}>
        <sphereGeometry args={[0.026, 18, 14]} />
        <meshStandardMaterial color={EYE_PUPIL} roughness={0.2} />
      </mesh>
      {/* catch-light — the spark of life. Emissive + un-tonemapped so it stays a
          crisp white glint and the bloom pass blooms it. */}
      <mesh position={[side * 0.022, 0.122, 0.066]}>
        <sphereGeometry args={[0.015, 12, 10]} />
        <meshStandardMaterial
          color={CATCH_LIGHT}
          emissive={CATCH_LIGHT}
          emissiveIntensity={1.6}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/**
 * One front claw (cheliped): a short arm + a chunky rounded palm + a two-finger
 * pincer (fixed lower jaw, raised upper jaw leaving a friendly open gap). Lives
 * inside the leftClaw/rightClaw ref'd group, which the frame loop rotates for
 * the "typing" tap. `side` mirrors the geometry left↔right.
 */
function Cheliped({ side }: { side: number }) {
  return (
    // Turn the claw slightly OUTWARD so the camera reads the open pincer profile
    // (the "C" gap) rather than looking end-on into the jaws.
    <group rotation={[0, side * 0.34, 0]}>
      {/* upper arm — a rounded capsule linking the pincer back to the body */}
      <mesh
        castShadow
        position={[side * -0.09, -0.01, -0.04]}
        rotation={[0.2, 0, side * 0.85]}
      >
        <capsuleGeometry args={[0.042, 0.13, 8, 16]} />
        <meshStandardMaterial color={CRAB_ORANGE} roughness={0.46} />
      </mesh>
      {/* palm / knuckle — a chunky rounded hand */}
      <mesh castShadow position={[0, 0, 0.05]} scale={[1, 0.92, 1.05]}>
        <sphereGeometry args={[0.11, 28, 22]} />
        <meshStandardMaterial color={CRAB_ORANGE} roughness={0.42} />
      </mesh>
      {/* lower (fixed) jaw — a tapered pincer pointing forward */}
      <mesh
        castShadow
        position={[0, -0.035, 0.16]}
        rotation={[-Math.PI / 2 + 0.16, 0, 0]}
      >
        <coneGeometry args={[0.062, 0.21, 16]} />
        <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.46} />
      </mesh>
      {/* upper (movable) jaw — raised to leave a clear pincer gap */}
      <mesh
        castShadow
        position={[0, 0.045, 0.15]}
        rotation={[-Math.PI / 2 - 0.36, 0, 0]}
      >
        <coneGeometry args={[0.052, 0.18, 16]} />
        <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.46} />
      </mesh>
    </group>
  );
}

/**
 * One walking leg: a bent two-segment limb (out-and-down, then in-and-down to a
 * pointed foot) — the silhouette detail that makes Larry read CRAB from any
 * angle. `splay` fans it front/back. Static for now; the walk cycle is Step 5.
 */
function CrabLeg({ x, z, splay }: { x: number; z: number; splay: number }) {
  const sign = x < 0 ? -1 : 1;
  return (
    <group position={[x, -0.05, z]} rotation={[0, splay, 0]}>
      {/* upper segment — swings out and down from under the shell */}
      <group rotation={[0, 0, sign * 0.95]}>
        <mesh castShadow position={[0, -0.1, 0]}>
          <cylinderGeometry args={[0.024, 0.018, 0.2, 8]} />
          <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.5} />
        </mesh>
        {/* lower segment — bends back in and down to a pointed foot */}
        <group position={[0, -0.2, 0]} rotation={[0, 0, sign * -1.3]}>
          <mesh castShadow position={[0, -0.09, 0]}>
            <cylinderGeometry args={[0.016, 0.004, 0.18, 8]} />
            <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.5} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/** Walking-leg layout — 3 per side, fanned front→back. */
const LEG_LAYOUT = [
  { x: -0.3, z: 0.17, splay: 0.55 },
  { x: -0.34, z: 0.0, splay: 0.0 },
  { x: -0.3, z: -0.17, splay: -0.55 },
  { x: 0.3, z: 0.17, splay: -0.55 },
  { x: 0.34, z: 0.0, splay: 0.0 },
  { x: 0.3, z: -0.17, splay: 0.55 },
];

export function Larry() {
  const invalidate = useThree((s) => s.invalidate);

  // Rig refs — mutated imperatively in the frame loop (never via React state).
  const root = useRef<THREE.Group>(null); // whole crab (position/scuttle/hop)
  const body = useRef<THREE.Group>(null); // body (squash-stretch on perk)
  const eyeStalks = useRef<THREE.Group>(null); // both eyestalks (raise/droop)
  const leftClaw = useRef<THREE.Group>(null);
  const rightClaw = useRef<THREE.Group>(null);

  // One-shot bookkeeping (refs so they survive frames without re-render).
  const lastPerkSeq = useRef(0);
  const perkStart = useRef(-1); // elapsedTime when the current perk began
  const lastBehavior = useRef<DirectorState["behavior"]>("idle");
  const oneShotStart = useRef(-1); // start of hop/stumble one-shots
  const eyeRaise = useRef(0.5); // smoothed eyestalk raise

  useFrame((state, delta) => {
    const d = useFloorStore.getState().director;
    const t = state.clock.elapsedTime;
    const g = root.current;
    if (!g) return;

    // ── Detect the perk-up (the magic moment) — perkSeq changed ─────────────
    if (d.perkSeq !== lastPerkSeq.current) {
      lastPerkSeq.current = d.perkSeq;
      perkStart.current = t;
    }

    // ── Detect entry into a one-shot behavior (hop / stumble) ───────────────
    if (d.behavior !== lastBehavior.current) {
      if (d.behavior === "celebrating" || d.behavior === "stumbling") {
        oneShotStart.current = t;
      }
      lastBehavior.current = d.behavior;
    }

    // ── 1. Scuttle: damp position toward the behavior's target (x/z) ─────────
    const target = targetPosition(d);
    g.position.x = THREE.MathUtils.damp(g.position.x, target.x, SCUTTLE_LAMBDA, delta);
    g.position.z = THREE.MathUtils.damp(g.position.z, target.z, SCUTTLE_LAMBDA, delta);

    // ── 2. Vertical motion: breathing / typing / hop, stacked on ground Y ───
    let y = GROUND_Y;
    if (d.behavior === "idle") {
      // Honest breathing — amplitude shrinks as he settles toward a nap.
      const amp = d.idleLevel === 2 ? 0.006 : d.idleLevel === 1 ? 0.018 : 0.028;
      y += Math.sin(t * 1.6) * amp;
    } else if (d.behavior === "working") {
      // Focused micro-bob (the "typing" rhythm), faster when thinking hard.
      const speed = d.intensity === 3 ? 11 : d.intensity === 2 ? 9 : 7;
      y += Math.sin(t * speed) * 0.012;
    } else if (d.behavior === "celebrating" && oneShotStart.current >= 0) {
      // A joyful hop (parabolic arc).
      const ht = (t - oneShotStart.current) * 1000;
      const tn = Math.min(ht / HOP_MS, 1);
      y += Math.sin(tn * Math.PI) * 0.45;
    }
    g.position.y = y;

    // ── 3. Perk-up pop (squash-stretch on body) ─────────────────────────────
    let bodyScaleY = 1;
    let bodyScaleXZ = 1;
    if (perkStart.current >= 0) {
      const pt = ((t - perkStart.current) * 1000) / PERK_POP_MS;
      const pop = popEnvelope(pt);
      if (pop > 0) {
        bodyScaleY = 1 + pop * 0.22; // stretch up
        bodyScaleXZ = 1 - pop * 0.1; // squash in
      } else if (pt >= 1) {
        perkStart.current = -1; // pop finished
      }
    }
    if (body.current) {
      body.current.scale.set(bodyScaleXZ, bodyScaleY, bodyScaleXZ);
    }

    // ── 4. Stumble wobble (comedic, decaying — never an alarm) ───────────────
    let rootRoll = 0;
    if (d.behavior === "stumbling" && oneShotStart.current >= 0) {
      const st = (t - oneShotStart.current) * 1000;
      const tn = Math.min(st / STUMBLE_MS, 1);
      rootRoll = Math.sin(st / 60) * 0.18 * (1 - tn); // decays to upright
    }
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, rootRoll, 8, delta);

    // ── 5. Eyestalk acting (raise/droop) ────────────────────────────────────
    eyeRaise.current = THREE.MathUtils.damp(
      eyeRaise.current,
      targetEyeRaise(d),
      7,
      delta,
    );
    if (eyeStalks.current) {
      // Raise = lift + slight forward lean; droop = lower + tilt down.
      eyeStalks.current.position.y = 0.12 + eyeRaise.current * 0.16;
      eyeStalks.current.rotation.x = (1 - eyeRaise.current) * 0.5;
    }

    // ── 6. Claw tapping while working (the "keyboard") ───────────────────────
    const tapping = d.behavior === "working";
    const tapL = tapping ? Math.max(0, Math.sin(t * 14)) * 0.35 : 0;
    const tapR = tapping ? Math.max(0, Math.sin(t * 14 + Math.PI)) * 0.35 : 0;
    if (leftClaw.current)
      leftClaw.current.rotation.x = THREE.MathUtils.damp(leftClaw.current.rotation.x, -tapL, 14, delta);
    if (rightClaw.current)
      rightClaw.current.rotation.x = THREE.MathUtils.damp(rightClaw.current.rotation.x, -tapR, 14, delta);

    // ── 7. Render-on-demand governor (PRD §12) ──────────────────────────────
    // Keep requesting frames while ANYTHING is still moving; otherwise let
    // frameloop="demand" rest at ~0 GPU. We are "settled" only when: behavior
    // needs no looping animation AND position has reached target AND no one-shot
    // (perk/hop/stumble) is in flight.
    const dx = Math.abs(g.position.x - target.x);
    const dz = Math.abs(g.position.z - target.z);
    const atTarget = dx < 0.002 && dz < 0.002;
    const perkActive = perkStart.current >= 0;
    const eyeSettled = Math.abs(eyeRaise.current - targetEyeRaise(d)) < 0.01;
    const needsMore =
      behaviorNeedsAnimation(d) || !atTarget || perkActive || !eyeSettled;
    if (needsMore) invalidate();
  });

  return (
    <group ref={root} position={[HOME_POS.x, GROUND_Y, HOME_POS.z]}>
      <group ref={body}>
        {/* ── Carapace — a wide, low dome (crab shell, not a ball) ── */}
        <mesh castShadow receiveShadow position={[0, 0.02, 0]} scale={[1.35, 0.6, 1.08]}>
          <sphereGeometry args={[0.34, 64, 48]} />
          <meshStandardMaterial color={CRAB_ORANGE} roughness={0.45} metalness={0} />
        </mesh>

        {/* Shell rim — the carapace lip that reads "crab shell" at a glance */}
        <mesh position={[0, 0.0, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[1.33, 1.06, 0.52]}>
          <torusGeometry args={[0.34, 0.03, 16, 80]} />
          <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.5} metalness={0} />
        </mesh>

        {/* Underbelly — a flatter, sun-warmed plate beneath the dome */}
        <mesh position={[0, -0.06, 0.01]} scale={[1.26, 0.34, 1.0]}>
          <sphereGeometry args={[0.34, 48, 32]} />
          <meshStandardMaterial color={CRAB_UNDERBELLY} roughness={0.6} metalness={0} />
        </mesh>

        {/* Mouth — a small dark mandible at the front-bottom (subtle character) */}
        <mesh position={[0, -0.05, 0.33]} rotation={[0.35, 0, 0]} scale={[1, 0.55, 0.5]}>
          <sphereGeometry args={[0.05, 16, 12]} />
          <meshStandardMaterial color={MOUTH} roughness={0.65} />
        </mesh>

        {/* ── Eyes on stalks (raised/drooped as a unit by the frame loop) ── */}
        <group ref={eyeStalks} position={[0, 0.16, 0.2]}>
          <CrabEye side={-1} />
          <CrabEye side={1} />
        </group>

        {/* ── Front claws — tap while "typing"; snap on celebrate (Step 5) ── */}
        <group ref={leftClaw} position={[-0.42, -0.01, 0.15]}>
          <Cheliped side={-1} />
        </group>
        <group ref={rightClaw} position={[0.42, -0.01, 0.15]}>
          <Cheliped side={1} />
        </group>

        {/* ── Walking legs — 3 per side, the crab silhouette ── */}
        {LEG_LAYOUT.map((l, i) => (
          <CrabLeg key={i} x={l.x} z={l.z} splay={l.splay} />
        ))}
      </group>
    </group>
  );
}
