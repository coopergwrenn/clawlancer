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

import { forwardRef, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
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
// ── Voxel palette — 4 shades of orange (Pokemon-Quest / Crossy-Road blocky).
// The character is now built from BOXES, not spheres: boxes can't melt into
// blobs, and a rectangular gap between two box jaws reads as a pincer from ANY
// angle. The warm rim shader (ShellMaterial) catches every cube edge.
const CRAB_ORANGE = "#ec8a3e"; // main carapace
const CRAB_ORANGE_LIGHT = "#f6ad5e"; // top shell cap / sun-lit faces
const CRAB_ORANGE_DARK = "#bf5f24"; // legs, claw-tip accents
const EYE_WHITE = "#fdf7ee";
const EYE_IRIS = "#73401f"; // warm amber-brown — reads alive, not a dead dot
const EYE_PUPIL = "#1b0f07";
const CATCH_LIGHT = "#fffaf0"; // emissive highlight — the spark of life
const EYE_LID = "#e07e34"; // eyelid skin — a hair deeper than the carapace so the closed lid reads
const LASH_LINE = "#7a3f1c"; // soft lash seam on the closed lid (warm brown, not harsh black)
const CLAW_TONE = "#d2742e"; // pincer jaws — lighter than the leg tone so the
//                              claw reads as a claw, not a dark hole.

// ── Stage positions (world units; ~1 unit ≈ one floor tile) ─────────────────
const HOME_POS = new THREE.Vector3(1.15, 0, 0.85); // resting spot, front-right
const DESK_POS = new THREE.Vector3(0, 0, 0.12); // working spot, in front of the desk
const GROUND_Y = 0.3; // body-center height when grounded (legs reach the floor)
const LEG_BASE_Y = -0.05; // resting y of each walking-leg attach group

// ── Timing / amplitudes ─────────────────────────────────────────────────────
const SCUTTLE_LAMBDA = 6; // higher = snappier scuttle toward target x/z
const PERK_TOTAL_MS = 760; // perk-up: anticipation → stretch → settle
const HOP_MS = 760; // celebrate hop (anticipation crouch + arc)
const STUMBLE_MS = 900; // error wobble duration
const STEP_FREQ = 10; // leg-cycle / waddle cadence while scuttling

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

/**
 * The perk-up envelope over normalized t in [0,1], built from the animation
 * principles so the "noticed you" beat reads as intentional, not robotic:
 *   - ANTICIPATION: a quick squash DOWN before the pop (negative lobe).
 *   - STRETCH + SETTLE: a strong stretch UP that overshoots, then a decaying
 *     oscillation settles it back to rest (follow-through).
 * Returns a signed amount: <0 = squash, >0 = stretch.
 */
function perkStretch(tn: number): number {
  if (tn <= 0 || tn >= 1) return 0;
  if (tn < 0.15) {
    // anticipation — a quick crouch before the spring
    return -Math.sin((tn / 0.15) * Math.PI) * 0.45;
  }
  // stretch up, then a damped overshoot that settles
  const u = (tn - 0.15) / 0.85;
  return Math.sin(u * Math.PI * 1.6) * Math.exp(-u * 2.4);
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
const CrabEye = forwardRef<
  THREE.Group,
  { side: number; lidRef?: (el: THREE.Group | null) => void }
>(function CrabEye({ side, lidRef }, ref) {
  return (
    <group position={[side * 0.1, 0, 0]}>
      {/* stalk — short, slightly outward, so the eye perches on the shell front */}
      <mesh castShadow position={[0, 0.04, 0]} rotation={[0, 0, side * -0.12]}>
        <cylinderGeometry args={[0.027, 0.032, 0.08, 12]} />
        <meshStandardMaterial color={CRAB_ORANGE} roughness={0.5} />
      </mesh>
      {/* eye group — eyeball + iris + pupil + catch-light move/scale as ONE, so
          the blink (scale.y) closes a whole, coherent eye. */}
      <group ref={ref} position={[0, 0.1, 0]}>
        {/* eyeball — oversized + forward (the single biggest appeal lever). Low
            roughness = a glossy, *wet* eye that catches a crisp specular. */}
        <mesh castShadow position={[0, 0, 0]}>
          <sphereGeometry args={[0.085, 32, 24]} />
          <meshStandardMaterial color={EYE_WHITE} roughness={0.11} metalness={0} />
        </mesh>
        {/* iris — warm amber, gazing forward + a touch UP (curious/friendly,
            not the intense downward stare). */}
        <mesh position={[0, 0.014, 0.072]}>
          <sphereGeometry args={[0.046, 24, 18]} />
          <meshStandardMaterial color={EYE_IRIS} roughness={0.32} metalness={0} />
        </mesh>
        {/* pupil — glossy black so it picks up a tiny secondary glint */}
        <mesh position={[0, 0.018, 0.084]}>
          <sphereGeometry args={[0.026, 18, 14]} />
          <meshStandardMaterial color={EYE_PUPIL} roughness={0.13} metalness={0} />
        </mesh>
        {/* catch-light — the spark of life, up top. Emissive + un-tonemapped so
            it stays a crisp white glint and the bloom pass blooms it. */}
        <mesh position={[side * 0.02, 0.05, 0.066]}>
          <sphereGeometry args={[0.016, 12, 10]} />
          <meshStandardMaterial
            color={CATCH_LIGHT}
            emissive={CATCH_LIGHT}
            emissiveIntensity={1.6}
            toneMapped={false}
          />
        </mesh>
        {/* ── Eyelid — a skin-toned dome that closes OVER the eye for a peaceful
            nap (asleep/offline). Hidden (scale 0) while awake; the frame loop
            scales it to 1 when Larry sleeps. A soft downward-bowed lash seam
            sits on it so the closed eye reads CONTENT, not the angry white slit
            you get from just squashing the eyeball. ── */}
        <group ref={lidRef} scale={[0, 0, 0]}>
          {/* lid dome — a hair larger than the eyeball so it fully covers the
              white + iris; squashed slightly so it domes like a real lid */}
          <mesh position={[0, 0.006, 0.02]} scale={[1, 0.92, 1]}>
            <sphereGeometry args={[0.093, 24, 18]} />
            <meshStandardMaterial color={EYE_LID} roughness={0.5} metalness={0} />
          </mesh>
          {/* lash seam — a soft arched lid-line on the FRONT of the lid (facing
              camera), giving the closed eye its gentle ∩ curve (a calm, content
              sleeping lid). A half-torus in the lid's front plane; the eyestalk's
              forward tilt angles it toward the hero camera. */}
          <mesh position={[0, -0.004, 0.099]}>
            <torusGeometry args={[0.052, 0.009, 10, 28, Math.PI]} />
            <meshStandardMaterial color={LASH_LINE} roughness={0.6} metalness={0} />
          </mesh>
        </group>
      </group>
    </group>
  );
});

/**
 * The claw silhouette — DRAWN, not assembled (the category shift after five
 * failed attempts to fuse separate primitives into a pincer).
 *
 * A `THREE.Shape` is a hand-authored 2D outline of an OPEN crab pincer: a solid
 * rounded palm for the lower half that splits into two prongs up top with a
 * concave "bite" valley between them. Because it's ONE continuous contour, the
 * silhouette is exactly what's drawn — there are no sub-shapes that can fail to
 * fuse. `ExtrudeGeometry` then gives it real depth + a fat bevel so it reads as
 * a chunky lit 3D object (catches ShellMaterial + the rim light) rather than a
 * flat sticker. The shape is symmetric about x=0 and opens +Y, so BOTH claws
 * share one geometry — no mirroring, no negative-scale normal flips.
 *
 * SIDE PROFILE, forward-opening, ASYMMETRIC — this is what makes it read as a
 * crab claw instead of a tulip. The claw points outward (+X for `dir=+1`), the
 * palm at the back (toward the body), splitting at the front into a small upper
 * jaw (dactyl) and a bigger lower jaw (pollex) with the mouth opening forward.
 * Two symmetric prongs opening UP always read as ears/tulip; an asymmetric
 * forward-opening profile reads as a claw. `dir` negates X to mirror cleanly for
 * the other side (extruded fresh so normals stay correct — no scale(-1) flip).
 *
 * Authored ~0.45 long × 0.27 tall; chunky depth + fat bevel so it's a solid 3D
 * claw, not a flat slab.
 */
function buildClawShape(dir: number): THREE.Shape {
  const x = (v: number) => v * dir;
  const s = new THREE.Shape();
  s.moveTo(x(-0.16), 0.1); // back-top of palm
  s.quadraticCurveTo(x(-0.02), 0.14, x(0.1), 0.12); // palm top → forward
  s.quadraticCurveTo(x(0.22), 0.11, x(0.265), 0.04); // upper jaw → tip (curls down)
  s.quadraticCurveTo(x(0.24), 0.0, x(0.19), 0.02); // upper jaw inner (mouth top)
  s.quadraticCurveTo(x(0.11), 0.0, x(0.18), -0.035); // into the bite cavity
  s.quadraticCurveTo(x(0.27), -0.05, x(0.27), -0.08); // lower jaw tip (curls up)
  s.quadraticCurveTo(x(0.22), -0.13, x(0.08), -0.13); // lower jaw bottom → back
  s.quadraticCurveTo(x(-0.1), -0.12, x(-0.16), -0.06); // palm bottom
  s.quadraticCurveTo(x(-0.19), 0.02, x(-0.16), 0.1); // palm back edge → close
  return s;
}

function extrudeClaw(dir: number): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(buildClawShape(dir), {
    depth: 0.2,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.06,
    bevelSegments: 5,
    curveSegments: 24,
  });
  g.center(); // pivot at the claw's center so group rotation is sane
  return g;
}

// One geometry per side (mirrored), so each claw opens OUTWARD away from the body.
const CLAW_GEO_RIGHT = extrudeClaw(1);
const CLAW_GEO_LEFT = extrudeClaw(-1);

/**
 * One front claw (cheliped) — the HERO feature, single extruded pincer.
 *
 * The claw is ONE extruded mesh (drawn asymmetric profile), the side-correct
 * mirror per `side`. Its flat profile faces +Z (the hero camera), the mouth
 * opens OUTWARD away from the body, tilted slightly up for the elevated camera.
 * A short thick arm grounds the palm to the body so it never floats on a stick.
 *
 * `side` (-1 L / +1 R) selects the mirrored geometry + placement. Lives inside
 * the leftClaw/rightClaw ref'd group whose animated rotation.x drives tap/raise.
 */
function Cheliped({ side }: { side: number }) {
  const clawGeo = side < 0 ? CLAW_GEO_LEFT : CLAW_GEO_RIGHT;
  return (
    <group>
      {/* arm — SHORT + THICK, overlapping body (back) and claw (front) so the
          claw never floats on a stick. */}
      <RoundedBox
        args={[0.17, 0.17, 0.2]}
        radius={0.06}
        smoothness={4}
        castShadow
        position={[side * -0.04, -0.05, -0.02]}
        rotation={[0.28, 0, side * 0.08]}
      >
        <ShellMaterial color={CRAB_ORANGE} roughness={0.4} emissiveIntensity={0.1} />
      </RoundedBox>

      {/* ── the CLAW — one drawn-and-extruded asymmetric profile ──
          Profile faces +Z (camera); mouth opens outward; raised + the mouth
          rolled up (rotation.z) into a perky "claws up" pose; tilted toward the
          elevated hero camera (rotation.x). */}
      <group position={[side * 0.06, 0.06, 0.16]} rotation={[-0.2, 0, side * 0.22]}>
        <mesh geometry={clawGeo} castShadow receiveShadow>
          <ShellMaterial color={CLAW_TONE} roughness={0.36} emissiveIntensity={0.12} />
        </mesh>
      </group>
    </group>
  );
}

/**
 * One walking leg: a bent two-segment limb (out-and-down, then in-and-down to a
 * pointed foot) — the silhouette detail that makes Larry read CRAB from any
 * angle. `splay` fans it front/back. Static for now; the walk cycle is Step 5.
 */
const CrabLeg = forwardRef<
  THREE.Group,
  { x: number; z: number; splay: number }
>(function CrabLeg({ x, z, splay }, ref) {
  const sign = x < 0 ? -1 : 1;
  return (
    <group ref={ref} position={[x, LEG_BASE_Y, z]} rotation={[0, splay, 0]}>
      {/* upper segment — a chunky box thigh swinging out and down */}
      <group rotation={[0, 0, sign * 0.95]}>
        <RoundedBox args={[0.07, 0.2, 0.07]} radius={0.025} smoothness={3} castShadow position={[0, -0.1, 0]}>
          <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.45} metalness={0} emissive={CRAB_ORANGE_DARK} emissiveIntensity={0.06} />
        </RoundedBox>
        {/* lower segment — a box shin bending back in and down to the foot */}
        <group position={[0, -0.2, 0]} rotation={[0, 0, sign * -1.3]}>
          <RoundedBox args={[0.055, 0.17, 0.055]} radius={0.02} smoothness={3} castShadow position={[0, -0.09, 0]}>
            <meshStandardMaterial color={CRAB_ORANGE_DARK} roughness={0.45} metalness={0} emissive={CRAB_ORANGE_DARK} emissiveIntensity={0.06} />
          </RoundedBox>
        </group>
      </group>
    </group>
  );
});

/** Walking-leg layout — 3 per side, fanned front→back. */
const LEG_LAYOUT = [
  { x: -0.3, z: 0.17, splay: 0.55 },
  { x: -0.34, z: 0.0, splay: 0.0 },
  { x: -0.3, z: -0.17, splay: -0.55 },
  { x: 0.3, z: 0.17, splay: -0.55 },
  { x: 0.34, z: 0.0, splay: 0.0 },
  { x: 0.3, z: -0.17, splay: 0.55 },
];

// ── Stylized-PBR shell material ──────────────────────────────────────────────
// A MeshStandardMaterial patched with a Fresnel rim term that ADDS to the
// emissive channel: grazing-angle edges glow warm, separating Larry from the
// background and giving the bloom pass (Step 6) a living edge to catch — the
// "rim/bloom" half of the stylized-PBR direction.
//
// Why a constant module-level `onBeforeCompile`: three's default
// `customProgramCacheKey` is `onBeforeCompile.toString()`, so a single stable
// function lets every shell part share ONE compiled program (cheap) while each
// material keeps its own color/roughness uniforms. `vViewPosition` + `normal`
// are both defined by the time `<emissivemap_fragment>` runs.
const SHELL_RIM_COLOR = new THREE.Color("#ffc78f");

function shellRimOnBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.uniforms.uRimColor = { value: SHELL_RIM_COLOR };
  shader.uniforms.uRimIntensity = { value: 0.5 };
  shader.uniforms.uRimPower = { value: 2.6 };
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
       uniform vec3 uRimColor;
       uniform float uRimIntensity;
       uniform float uRimPower;`,
    )
    .replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
       float _rim = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), uRimPower);
       totalEmissiveRadiance += uRimColor * _rim * uRimIntensity;`,
    );
}

/** The warm, soft, faintly self-lit shell surface. Reused on every orange body
 *  part (carapace, underbelly, arms, palms) so Larry reads as one creature. */
function ShellMaterial({
  color,
  roughness = 0.38,
  emissiveIntensity = 0.12,
}: {
  color: string;
  roughness?: number;
  emissiveIntensity?: number;
}) {
  return (
    <meshStandardMaterial
      color={color}
      roughness={roughness}
      metalness={0}
      emissive={color}
      emissiveIntensity={emissiveIntensity}
      onBeforeCompile={shellRimOnBeforeCompile}
    />
  );
}

export function Larry() {
  const invalidate = useThree((s) => s.invalidate);

  // Rig refs — mutated imperatively in the frame loop (never via React state).
  const root = useRef<THREE.Group>(null); // whole crab (position/scuttle/hop)
  const body = useRef<THREE.Group>(null); // body (squash-stretch on perk)
  const eyeStalks = useRef<THREE.Group>(null); // both eyestalks (raise/droop/look)
  const leftClaw = useRef<THREE.Group>(null);
  const rightClaw = useRef<THREE.Group>(null);
  const eyes = useRef<(THREE.Group | null)[]>([]); // 2 eye groups (blink scale.y)
  const lids = useRef<(THREE.Group | null)[]>([]); // 2 eyelids (scale 0→1 on sleep)
  const legs = useRef<(THREE.Group | null)[]>([]); // 6 walking legs (gait lift)

  // One-shot bookkeeping (refs so they survive frames without re-render).
  const lastPerkSeq = useRef(0);
  const perkStart = useRef(-1); // elapsedTime when the current perk began
  const lastBehavior = useRef<DirectorState["behavior"]>("idle");
  const oneShotStart = useRef(-1); // start of hop/stumble one-shots
  const eyeRaise = useRef(0.5); // smoothed eyestalk raise
  const gait = useRef(0); // smoothed "walking-ness" 0..1 (drives waddle + legs)
  const blinkStart = useRef(-1); // elapsedTime the current blink began
  const nextBlinkAt = useRef(2.5); // elapsedTime of the next scheduled blink

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

    // ── 1. Scuttle + GAIT: damp position toward target; derive walking-ness ──
    const target = targetPosition(d);
    const prevX = g.position.x;
    const prevZ = g.position.z;
    g.position.x = THREE.MathUtils.damp(prevX, target.x, SCUTTLE_LAMBDA, delta);
    g.position.z = THREE.MathUtils.damp(prevZ, target.z, SCUTTLE_LAMBDA, delta);
    // How fast is he actually travelling this frame → how "walking" he looks.
    const speed = delta > 0 ? Math.hypot(g.position.x - prevX, g.position.z - prevZ) / delta : 0;
    gait.current = THREE.MathUtils.damp(
      gait.current,
      THREE.MathUtils.clamp(speed / 1.1, 0, 1),
      9,
      delta,
    );
    const m = gait.current; // 0 = still, 1 = full scuttle
    const stepWave = Math.sin(t * STEP_FREQ); // shared step phase

    // ── 2. Vertical motion: breathing / typing / hop + per-step bob ─────────
    let y = GROUND_Y;
    if (d.behavior === "idle") {
      // Honest breathing — amplitude shrinks as he settles toward a nap.
      const amp = d.idleLevel === 2 ? 0.006 : d.idleLevel === 1 ? 0.018 : 0.028;
      y += Math.sin(t * 1.6) * amp;
    } else if (d.behavior === "working") {
      // Focused micro-bob (the "typing" rhythm), faster when thinking hard.
      const sp = d.intensity === 3 ? 11 : d.intensity === 2 ? 9 : 7;
      y += Math.sin(t * sp) * 0.012;
    } else if (d.behavior === "celebrating" && oneShotStart.current >= 0) {
      // A joyful hop: ANTICIPATION crouch, then an arc up + a small second
      // bounce (follow-through) so the landing reads, not teleports.
      const tn = Math.min(((t - oneShotStart.current) * 1000) / HOP_MS, 1);
      if (tn < 0.15) {
        y -= Math.sin((tn / 0.15) * Math.PI) * 0.045; // crouch
      } else {
        const u = (tn - 0.15) / 0.85;
        y += Math.sin(u * Math.PI) * 0.45 + Math.max(0, Math.sin(u * Math.PI * 2 - Math.PI)) * 0.08;
      }
    }
    // Secondary action: a little up-down bob on every step while scuttling.
    y += Math.abs(stepWave) * 0.022 * m;

    // ── 3. Perk-up: anticipation → stretch overshoot → settle (+ micro-hop) ──
    let stretch = 0;
    if (perkStart.current >= 0) {
      const tn = ((t - perkStart.current) * 1000) / PERK_TOTAL_MS;
      if (tn >= 1) perkStart.current = -1;
      else stretch = perkStretch(tn);
    }
    if (body.current) {
      body.current.scale.set(1 - stretch * 0.2, 1 + stretch * 0.38, 1 - stretch * 0.2);
    }
    y += Math.max(0, stretch) * 0.08; // micro-hop on the spring up
    g.position.y = y;

    // ── 4. Roll: scuttle WADDLE (secondary action) or stumble wobble ────────
    let rollTarget = stepWave * 0.09 * m; // side-to-side waddle while walking
    let pitchTarget = m * 0.05; // a slight forward lean into the scuttle
    if (d.behavior === "stumbling" && oneShotStart.current >= 0) {
      const st = (t - oneShotStart.current) * 1000;
      const tn = Math.min(st / STUMBLE_MS, 1);
      rollTarget = Math.sin(st / 60) * 0.18 * (1 - tn); // decays to upright
      pitchTarget = 0;
    }
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, rollTarget, 9, delta);
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, pitchTarget, 8, delta);

    // ── 5. Leg cycle: phased lift + swing (arcs), scaled by walking-ness ─────
    const legArr = legs.current;
    for (let i = 0; i < legArr.length; i++) {
      const leg = legArr[i];
      if (!leg) continue;
      // Alternating tripod-ish gait: opposite sides + neighbours out of phase.
      const phase = (i % 3) * ((Math.PI * 2) / 3) + (i < 3 ? 0 : Math.PI);
      const w = Math.sin(t * STEP_FREQ + phase);
      leg.position.y = LEG_BASE_Y + Math.max(0, w) * 0.06 * m; // lift on the up-beat
      leg.rotation.x = w * 0.18 * m; // swing fore/aft (arc)
    }

    // ── 6. Eyestalk acting: raise/droop + perk follow-through + look-around ──
    eyeRaise.current = THREE.MathUtils.damp(
      eyeRaise.current,
      targetEyeRaise(d),
      7,
      delta,
    );
    if (eyeStalks.current) {
      let eyeY = 0.12 + eyeRaise.current * 0.16;
      // Gaze: level when idle, tilts UP (engaged/curious) when alert/working,
      // droops DOWN only when sleepy. (Was a constant down-tilt that made him
      // stare at the floor.)
      let eyeRotX = (0.55 - eyeRaise.current) * 0.7;
      let eyeRotY = 0;
      if (perkStart.current >= 0) {
        // FOLLOW-THROUGH: the eyes pop up a beat AFTER the body and overshoot.
        const ft = perkStretch(
          Math.max(0, ((t - perkStart.current) * 1000) / PERK_TOTAL_MS - 0.08),
        );
        eyeY += Math.max(0, ft) * 0.05;
        eyeRotX -= Math.max(0, ft) * 0.18; // snap to wide-awake
      }
      if (d.behavior === "idle" && d.idleLevel === 1) {
        eyeRotY = Math.sin(t * 0.5) * 0.35; // "looking around" pan
      }
      eyeStalks.current.position.y = eyeY;
      eyeStalks.current.rotation.x = eyeRotX;
      eyeStalks.current.rotation.y = eyeRotY;
    }

    // ── 7. Blink (secondary action) ─────────────────────────────────────────
    // Eyes shut when asleep/offline. Otherwise blink ONLY while the scene is
    // already animating (behaviorNeedsAnimation === true). Crucially NO blink
    // during a deep nap (idle level 2): a blink there would re-arm the governor
    // (blinkStart >= 0) and wake the GPU every few seconds, breaking the PRD §12
    // "a napping Larry rests at ~0 GPU" budget. Any in-flight blink is cancelled
    // on entering a resting state so `needsMore` can settle to false.
    const eyesShut = d.behavior === "asleep" || d.behavior === "offline";
    let blinkScaleY = 1;
    if (eyesShut) {
      blinkStart.current = -1; // cancel any in-flight blink
      // Eyeball stays full-size; the skin EYELID closes over it instead of
      // squashing the white sphere into an angry slit. (lid scale set below.)
    } else if (behaviorNeedsAnimation(d)) {
      // Active state — the GPU is already drawing, so a blink rides along free.
      if (blinkStart.current < 0 && t >= nextBlinkAt.current) blinkStart.current = t;
      if (blinkStart.current >= 0) {
        const bt = (t - blinkStart.current) / 0.14; // a 140ms blink
        if (bt >= 1) {
          blinkStart.current = -1;
          // schedule the next blink 2.2–5.2s out (varied so it feels alive)
          nextBlinkAt.current = t + 2.2 + (Math.sin(t * 12.9898) * 0.5 + 0.5) * 3;
        } else {
          blinkScaleY = 1 - Math.sin(bt * Math.PI) * 0.9; // dip to ~0.1 and back
        }
      }
    } else {
      // Deep nap (idle L2): eyes rest open-but-droopy; cancel any in-flight blink
      // so the demand governor can go quiet and the GPU truly idles.
      blinkStart.current = -1;
    }
    for (const eye of eyes.current) if (eye) eye.scale.y = blinkScaleY;
    // Eyelids: closed (1) only when sleeping, hidden (0) when awake. Direct-set
    // (no damp) so it never re-arms the demand governor during a deep nap.
    const lidScale = eyesShut ? 1 : 0;
    for (const lid of lids.current) if (lid) lid.scale.setScalar(lidScale);

    // ── 8. Claws: tap while working; raise high on celebrate ────────────────
    let clawTargetL = 0;
    let clawTargetR = 0;
    if (d.behavior === "working") {
      clawTargetL = -Math.max(0, Math.sin(t * 14)) * 0.35;
      clawTargetR = -Math.max(0, Math.sin(t * 14 + Math.PI)) * 0.35;
    } else if (d.behavior === "celebrating" && oneShotStart.current >= 0) {
      // Throw the claws UP in celebration (then settle) — pairs with the hop.
      const tn = Math.min(((t - oneShotStart.current) * 1000) / HOP_MS, 1);
      const up = Math.sin(Math.min(tn / 0.6, 1) * Math.PI) * 1.05;
      clawTargetL = -up;
      clawTargetR = -up;
    }
    if (leftClaw.current)
      leftClaw.current.rotation.x = THREE.MathUtils.damp(leftClaw.current.rotation.x, clawTargetL, 14, delta);
    if (rightClaw.current)
      rightClaw.current.rotation.x = THREE.MathUtils.damp(rightClaw.current.rotation.x, clawTargetR, 14, delta);

    // ── 9. Render-on-demand governor (PRD §12) ──────────────────────────────
    // Keep requesting frames while ANYTHING is still in motion; otherwise let
    // frameloop="demand" rest at ~0 GPU.
    const atTarget =
      Math.abs(g.position.x - target.x) < 0.002 &&
      Math.abs(g.position.z - target.z) < 0.002;
    const eyeSettled = Math.abs(eyeRaise.current - targetEyeRaise(d)) < 0.01;
    const needsMore =
      behaviorNeedsAnimation(d) ||
      !atTarget ||
      perkStart.current >= 0 ||
      blinkStart.current >= 0 ||
      m > 0.01 ||
      !eyeSettled;
    if (needsMore) invalidate();
  });

  return (
    <group ref={root} position={[HOME_POS.x, GROUND_Y, HOME_POS.z]}>
      <group ref={body}>
        {/* ── Carapace — a chunky VOXEL shell (Pokemon-Quest / Crossy-Road). A
            single wide, slightly-flattened RoundedBox is the body; a lighter box
            "shell cap" sits on top for the 2-tone blocky read. Boxes, not
            spheres: the form is intentionally blocky and can never blob. ── */}
        <RoundedBox
          args={[0.74, 0.46, 0.64]}
          radius={0.06}
          smoothness={4}
          castShadow
          receiveShadow
          position={[0, 0.05, 0]}
        >
          <ShellMaterial color={CRAB_ORANGE} roughness={0.4} emissiveIntensity={0.13} />
        </RoundedBox>
        {/* top shell cap — a lighter, slightly-inset box plate for the 2-tone
            voxel shell (sits ON the body, not a belt around it). */}
        <RoundedBox
          args={[0.62, 0.16, 0.52]}
          radius={0.05}
          smoothness={4}
          castShadow
          position={[0, 0.27, -0.01]}
        >
          <ShellMaterial color={CRAB_ORANGE_LIGHT} roughness={0.42} emissiveIntensity={0.12} />
        </RoundedBox>

        {/* ── Eyes on stalks (raised/drooped as a unit; each eye blinks) ──
            Perched on the front-top edge of the box shell. ── */}
        <group ref={eyeStalks} position={[0, 0.22, 0.3]}>
          <CrabEye
            ref={(el) => {
              eyes.current[0] = el;
            }}
            lidRef={(el) => {
              lids.current[0] = el;
            }}
            side={-1}
          />
          <CrabEye
            ref={(el) => {
              eyes.current[1] = el;
            }}
            lidRef={(el) => {
              lids.current[1] = el;
            }}
            side={1}
          />
        </group>

        {/* ── Front claws — held UP and forward (the iconic crab pose) so they
            read as pincers from the hero camera; tap while "typing", raise on
            celebrate. rotation.x is the animated tap axis; y/z set the pose. ── */}
        <group ref={leftClaw} position={[-0.34, 0.1, 0.3]} rotation={[0.05, 0.12, 0.1]}>
          <Cheliped side={-1} />
        </group>
        <group ref={rightClaw} position={[0.34, 0.1, 0.3]} rotation={[0.05, -0.12, -0.1]}>
          <Cheliped side={1} />
        </group>

        {/* ── Walking legs — 3 per side; phased leg-cycle while scuttling ── */}
        {LEG_LAYOUT.map((l, i) => (
          <CrabLeg
            key={i}
            ref={(el) => {
              legs.current[i] = el;
            }}
            x={l.x}
            z={l.z}
            splay={l.splay}
          />
        ))}
      </group>
    </group>
  );
}
