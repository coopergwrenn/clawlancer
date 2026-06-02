"use client";

/**
 * The Floor — scene assembly (docs/prd/the-floor.md §10.4, §12).
 *
 * Everything that lives INSIDE the R3F <Canvas>: lights, the room, Larry, the
 * camera controls, and the render-on-demand governor. Kept separate from the
 * <Canvas> wrapper (floor-canvas.tsx) so the scene graph is readable on its own
 * and the Canvas file stays a thin configuration shell.
 *
 * Render-on-demand (PRD §12) has TWO halves and both live here:
 *   - RenderKicker: kicks ONE frame whenever the director state changes (the
 *     external trigger — useFrame can't self-start in demand mode).
 *   - Larry's own useFrame self-sustains while animating, then stops → ~0 GPU.
 *   - OrbitControls kicks a frame on user drag (the third trigger).
 */

import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Environment, Lightformer } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import { useFloorStore } from "@/lib/floor/store";
import { Larry } from "./larry";
import { OfficeRoom } from "./office-room";
import { CausticFloor } from "./caustic-floor";

/**
 * Kicks a single render frame whenever the director changes. This is the
 * external half of the render-on-demand governor: in frameloop="demand", a
 * useFrame loop cannot start itself, so a store change must request the first
 * frame. Larry's useFrame then self-sustains until everything settles.
 */
function RenderKicker() {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    // zustand v5: subscribe(listener(state, prev)). The store assigns a NEW
    // director object only on a real change, so a reference compare is exact.
    const unsub = useFloorStore.subscribe((state, prev) => {
      if (state.director !== prev.director) invalidate();
    });
    invalidate(); // kick the very first frame on mount
    return unsub;
  }, [invalidate]);
  return null;
}

// The point the camera frames — Larry's head height at his home spot. Kept in
// sync with OrbitControls.target below.
const FRAME_TARGET = new THREE.Vector3(1.0, 0.42, 0.85);

/**
 * Aspect-responsive framing (LOAD-BEARING for mobile, PRD §"opens it on their
 * phone"). A perspective camera has a FIXED vertical FOV, so a tall/narrow
 * phone viewport crops Larry's claws horizontally. This fits Larry's bounding
 * box to whichever axis is the binding constraint for the current aspect:
 *   - wide (desktop): height-bound  → the hand-tuned intimate ~36° framing
 *   - tall (phone):   width-bound   → widens vFOV so the claws never clip
 * Runs on mount + every resize, then kicks one frame (demand-safe). It only
 * sets fov, so it never fights OrbitControls for camera position.
 */
function ResponsiveFraming() {
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera) || height === 0) return;
    const aspect = width / height;
    const dist = camera.position.distanceTo(FRAME_TARGET);
    // Larry + held-up claws, with the target slightly off his center.
    const halfH = 0.62;
    const halfW = 0.74;
    const vfovForHeight = 2 * Math.atan(halfH / dist);
    const hfovForWidth = 2 * Math.atan(halfW / dist);
    const vfovForWidth = 2 * Math.atan(Math.tan(hfovForWidth / 2) / aspect);
    // Looser margin on desktop (cozy room context); tighter on phone so the
    // wide-vFOV portrait doesn't fill with empty floor.
    const margin = aspect < 1 ? 1.1 : 1.3;
    const fovDeg = THREE.MathUtils.radToDeg(
      Math.max(vfovForHeight, vfovForWidth) * margin,
    );
    // Clamp so extreme aspects can't go fisheye or telephoto.
    camera.fov = THREE.MathUtils.clamp(fovDeg, 30, 64);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, width, height, invalidate]);
  return null;
}

/**
 * The desk lamp — a warm point light whose intensity tracks the agent's real
 * effort tier. Larry literally works under a brighter lamp when he's thinking
 * hard (intensity 3 / "deep work"). A small thing, but it's REAL data driving
 * light, which is the §5 premium lever in miniature.
 */
function DeskLamp() {
  const light = useRef<THREE.PointLight>(null);
  useFrame((_, delta) => {
    const d = useFloorStore.getState().director;
    let target = 1.1; // resting glow — a cozy warm pool on the desk even at idle
    if (d.behavior === "working") {
      target = d.intensity === 3 ? 2.4 : d.intensity === 2 ? 1.7 : 1.2;
    } else if (d.behavior === "incoming") {
      target = 1.4; // perks up with him
    } else if (d.behavior === "celebrating") {
      target = 1.9;
    } else if (d.behavior === "asleep" || d.behavior === "offline") {
      target = 0.12;
    }
    if (light.current) {
      light.current.intensity = THREE.MathUtils.damp(
        light.current.intensity,
        target,
        4,
        delta,
      );
    }
  });
  return (
    <pointLight
      ref={light}
      position={[0.47, 0.98, -0.42]}
      color="#ffd9a0"
      intensity={0.6}
      distance={4.5}
      decay={1.5}
      castShadow
    />
  );
}

export function FloorScene() {
  const invalidate = useThree((s) => s.invalidate);
  return (
    <>
      {/* ── Lighting ── cozy-cinematic: a warm key + soft shadows, a COOL window
          fill so shadows read cool-not-black (the warm/cool contrast that makes
          a room feel cozy rather than clinical), a cool back/rim light to peel
          Larry off the background, and a file-free Environment of Lightformer
          cards so the low-roughness shell + wet eyes have soft warm/cool
          reflections to catch (what makes the stylized PBR sing). All of it is
          static, so frameloop="demand" still rests at ~0 GPU. */}

      {/* Reflections / IBL — baked once (frames={1}) → demand-safe. The cards
          tell the warm-key / cool-window story IN the reflections, too. */}
      {/* IBL is tuned LOW — its job here is soft warm/cool *reflections* on the
          shell + eyes (sheen), NOT to fill the room. The dark env background
          keeps overall irradiance down so the room stays moody, not washed. */}
      <Environment resolution={128} frames={1}>
        <color attach="background" args={["#150f0a"]} />
        {/* warm key card (front-right) */}
        <Lightformer
          form="rect"
          intensity={1.1}
          color="#ffd6a0"
          position={[3, 3, 2.5]}
          scale={[5, 5, 1]}
          target={[0, 0.5, 0]}
        />
        {/* cool window card (back-left) */}
        <Lightformer
          form="rect"
          intensity={0.8}
          color="#bcd6ff"
          position={[-3, 2.2, -2.5]}
          scale={[4, 4, 1]}
          target={[0, 0.5, 0]}
        />
        {/* faint warm overhead bounce */}
        <Lightformer
          form="rect"
          intensity={0.35}
          color="#fff1dc"
          position={[0, 4.5, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[6, 6, 1]}
        />
      </Environment>

      {/* Ambient — very low; just keeps shadows warm rather than crushed. Kept
          minimal so the warm key + desk-lamp pool define the mood (cozy needs
          contrast, not flat fill). */}
      <ambientLight intensity={0.06} color="#ffe2bc" />

      {/* Hemisphere — gentle warm-sky / warm-wood bounce. */}
      <hemisphereLight args={["#ffdcae", "#3a2616", 0.14]} />

      {/* KEY — warm, upper-front-right, the shadow-caster. The main pool of warm
          light; everything else falls toward warm shadow (cozy, not flat). */}
      <directionalLight
        position={[3.4, 5.2, 2.6]}
        intensity={2.6}
        color="#ffca8a"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-bias={-0.0004}
        shadow-radius={3.5}
        shadow-camera-near={0.5}
        shadow-camera-far={20}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
      />

      {/* COOL FILL — from the window side, no shadow; tints the shadow side cool
          so the warm/cool contrast reads cozy. The window's daylight, physical. */}
      <directionalLight position={[-3.2, 2.6, -2]} intensity={0.4} color="#9fc2ff" />

      {/* RIM / BACK — cool, behind + above Larry toward camera; lights his top
          edge so he peels off the dark backdrop (with the shell's Fresnel rim,
          this is the "pop"). */}
      <directionalLight position={[-1.4, 2.6, -3.6]} intensity={0.85} color="#cfe2ff" />

      <DeskLamp />

      {/* ── Render-on-demand external kick (PRD §12). LOAD-BEARING: in
          frameloop="demand", a settled/napping scene draws nothing, so a
          store change (e.g. a message arriving while Larry naps) must request
          the first frame. Without this, the perk-up would wait for the next
          drag. This is the half useFrame can't do itself. ── */}
      <RenderKicker />
      <ResponsiveFraming />

      {/* ── World ── */}
      <OfficeRoom />
      <CausticFloor />
      <Larry />

      {/* ── Camera controls — a gentle, constrained orbit. Users can find a
          favorite angle to screenshot, but can't swing behind the walls or
          under the floor. Kicks a frame on drag (demand-mode). ── */}
      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={1.8}
        maxDistance={4.2}
        minPolarAngle={Math.PI * 0.3}
        maxPolarAngle={Math.PI * 0.49}
        minAzimuthAngle={-Math.PI * 0.34}
        maxAzimuthAngle={Math.PI * 0.34}
        enableDamping
        dampingFactor={0.08}
        target={[1.0, 0.42, 0.85]}
        onChange={() => invalidate()}
      />

      {/* ── Post-FX (PRD §12) ── Composes ONLY on demanded frames, so it adds
          zero cost at rest. BLOOM makes the catch-lights, window, caustics and
          Fresnel rim actually glow (threshold-gated → only the bright/emissive
          things bloom = "selective"). ACES tone-mapping rolls off highlights
          for a filmic, non-blown look. VIGNETTE darkens the corners → the
          cozy, focused framing the scene was missing. */}
      <EffectComposer multisampling={4}>
        <Bloom
          intensity={0.7}
          luminanceThreshold={0.82}
          luminanceSmoothing={0.22}
          mipmapBlur
        />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <Vignette eskil={false} offset={0.28} darkness={0.85} />
      </EffectComposer>
    </>
  );
}
