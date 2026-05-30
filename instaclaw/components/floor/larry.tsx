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
const CRAB_ORANGE = "#e8853c";
const CRAB_ORANGE_DARK = "#c96a28";
const EYE_WHITE = "#fdf6ec";
const EYE_PUPIL = "#2a1a10";

// ── Stage positions (world units; ~1 unit ≈ one floor tile) ─────────────────
const HOME_POS = new THREE.Vector3(1.15, 0, 0.85); // resting spot, front-right
const DESK_POS = new THREE.Vector3(0, 0, 0.2); // working spot, at the desk
const GROUND_Y = 0.28; // body-center height when grounded (= body radius)

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
        {/* Body — a rounded crab shell (flattened sphere) */}
        <mesh castShadow position={[0, 0, 0]} scale={[1, 0.78, 0.9]}>
          <sphereGeometry args={[0.3, 24, 16]} />
          <meshStandardMaterial color={CRAB_ORANGE} roughness={0.55} metalness={0.05} />
        </mesh>

        {/* Eyestalks group (raised/drooped as a unit) */}
        <group ref={eyeStalks} position={[0, 0.16, 0.04]}>
          {[-0.1, 0.1].map((x) => (
            <group key={x} position={[x, 0, 0]}>
              {/* stalk */}
              <mesh castShadow position={[0, 0.07, 0]}>
                <cylinderGeometry args={[0.018, 0.022, 0.16, 8]} />
                <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.6} />
              </mesh>
              {/* eye white */}
              <mesh position={[0, 0.17, 0]}>
                <sphereGeometry args={[0.05, 16, 12]} />
                <meshStandardMaterial color={EYE_WHITE} roughness={0.3} />
              </mesh>
              {/* pupil */}
              <mesh position={[0, 0.18, 0.035]}>
                <sphereGeometry args={[0.022, 12, 8]} />
                <meshStandardMaterial color={EYE_PUPIL} roughness={0.2} />
              </mesh>
            </group>
          ))}
        </group>

        {/* Claws (left/right) — tap while typing */}
        <group ref={leftClaw} position={[-0.34, -0.02, 0.12]}>
          <mesh castShadow>
            <boxGeometry args={[0.16, 0.1, 0.1]} />
            <meshStandardMaterial color={CRAB_ORANGE} roughness={0.55} />
          </mesh>
          {/* pincer tip */}
          <mesh castShadow position={[-0.1, 0.03, 0]}>
            <boxGeometry args={[0.08, 0.04, 0.08]} />
            <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.55} />
          </mesh>
        </group>
        <group ref={rightClaw} position={[0.34, -0.02, 0.12]}>
          <mesh castShadow>
            <boxGeometry args={[0.16, 0.1, 0.1]} />
            <meshStandardMaterial color={CRAB_ORANGE} roughness={0.55} />
          </mesh>
          <mesh castShadow position={[0.1, 0.03, 0]}>
            <boxGeometry args={[0.08, 0.04, 0.08]} />
            <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.55} />
          </mesh>
        </group>

        {/* Little legs — purely visual, give the silhouette crab-ness */}
        {[-0.26, -0.16, 0.16, 0.26].map((x, i) => (
          <mesh key={i} castShadow position={[x, -0.16, -0.02]} rotation={[0, 0, x < 0 ? 0.5 : -0.5]}>
            <cylinderGeometry args={[0.012, 0.012, 0.14, 6]} />
            <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.6} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
