"use client";

/**
 * The Floor — the R3F <Canvas> shell (docs/prd/the-floor.md §10.2, §12).
 *
 * A thin configuration wrapper: camera, renderer flags, and — load-bearing for
 * battery — `frameloop="demand"` so the scene renders ONLY when something
 * requests a frame (FloorScene's RenderKicker on state change, Larry's
 * self-sustaining loop while animating, OrbitControls on drag). When Larry
 * settles or naps, the GPU goes quiet.
 *
 * This component is the default export so it can be `dynamic(import, {ssr:false})`
 * — R3F needs the browser (WebGL), so it must never SSR.
 */

import { Canvas } from "@react-three/fiber";
import { FloorScene } from "./floor-scene";

export default function FloorCanvas() {
  return (
    <Canvas
      // Render only on demand — the single most important perf decision (§12).
      frameloop="demand"
      shadows
      // Cap DPR so retina phones don't render at 3× (the #1 WebGL battery sink).
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ position: [3.4, 2.7, 3.6], fov: 38, near: 0.1, far: 100 }}
      style={{ width: "100%", height: "100%", touchAction: "none" }}
    >
      {/* Warm, soft backdrop behind the room. */}
      <color attach="background" args={["#2a2018"]} />
      <fog attach="fog" args={["#2a2018", 9, 16]} />
      <FloorScene />
    </Canvas>
  );
}
