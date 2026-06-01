"use client";

/**
 * The Floor — tidepool caustics (docs/prd/the-floor.md §7 polish, the "ownable"
 * crab-native signature touch).
 *
 * A pool of refracted water-light cast on the floor, like sun coming through a
 * tidepool above Larry's office. It's a procedural caustic shader on a thin
 * floor-overlay plane (additive, cool-tinted) — no texture asset, no extra draw
 * cost beyond one transparent plane.
 *
 * ── Render-on-demand (PRD §12), load-bearing ────────────────────────────────
 * The pattern is STATIC at rest (a frozen caustic still reads as water-light),
 * so a settled/napping scene draws nothing. It only *shimmers* while Larry is
 * awake: the useFrame advances `uTime` and self-invalidates ONLY when
 * `behaviorNeedsAnimation` is true — exactly the frames Larry is already
 * requesting. When he naps/sleeps/offline, the water stills with him. So this
 * adds zero continuous GPU at rest, honoring frameloop="demand".
 *
 * The caustic function is the well-worn layered-domain-warp trick (cheap, GPU-
 * friendly, looks genuinely watery); sampled in WORLD xz so the pattern is
 * stable under camera orbit and the radial pool falloff is world-anchored.
 */

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useFloorStore } from "@/lib/floor/store";
import { behaviorNeedsAnimation } from "@/lib/floor/director";

// Pool sits in front of / below the window (back-left), so it reads as light
// coming THROUGH the window onto the floor.
const POOL_CENTER = new THREE.Vector2(-1.05, -0.15);
const POOL_RADIUS = 1.7;

const VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vWorld;
  uniform float uTime;
  uniform vec3  uColor;
  uniform float uIntensity;
  uniform float uScale;
  uniform vec2  uPoolCenter;
  uniform float uPoolRadius;

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }

  // Voronoi-web caustic: animated cell sites; the bright thin network at the
  // cell BORDERS (F2 - F1) is the refracted-light web you see at the bottom of
  // a pool. Two octaves at different scales = the layered, organic shimmer.
  float causticLayer(vec2 uv, float t) {
    vec2 g = floor(uv);
    vec2 f = fract(uv);
    float f1 = 8.0, f2 = 8.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y));
        vec2 site = o + 0.5 + 0.42 * sin(t + 6.2831 * hash2(g + o));
        float d = length(f - site);
        if (d < f1) { f2 = f1; f1 = d; }
        else if (d < f2) { f2 = d; }
      }
    }
    return smoothstep(0.09, 0.0, f2 - f1); // bright thin web on the borders
  }

  float caustic(vec2 uv, float t) {
    float a = causticLayer(uv, t);
    float b = causticLayer(uv * 1.9 + 11.3, t * 1.3 + 2.0);
    return clamp(a + b * 0.6, 0.0, 1.0);
  }

  void main() {
    vec2 p = vWorld.xz * uScale;
    float caus = caustic(p, uTime);

    // Soft circular pool: brightest mid-pool, smoothly faded to nothing at the
    // radius (no hard bright core — let the caustic lines do the work).
    float d = distance(vWorld.xz, uPoolCenter);
    float fall = smoothstep(uPoolRadius, 0.0, d);

    vec3 col = uColor * caus * uIntensity * fall;
    gl_FragColor = vec4(col, 1.0); // additive blend → adds light to the floor
  }
`;

export function CausticFloor() {
  const mat = useRef<THREE.ShaderMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);

  useFrame((state) => {
    const d = useFloorStore.getState().director;
    if (mat.current && behaviorNeedsAnimation(d)) {
      mat.current.uniforms.uTime.value = state.clock.elapsedTime * 0.16;
      invalidate();
    }
  });

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[POOL_CENTER.x, 0.012, POOL_CENTER.y]}
      renderOrder={2}
    >
      <planeGeometry args={[4.2, 4.2]} />
      <shaderMaterial
        ref={mat}
        vertexShader={VERT}
        fragmentShader={FRAG}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={{
          uTime: { value: 0 },
          uColor: { value: new THREE.Color("#9ad6ff") },
          uIntensity: { value: 0.6 },
          uScale: { value: 3.2 },
          uPoolCenter: { value: POOL_CENTER },
          uPoolRadius: { value: POOL_RADIUS },
        }}
      />
    </mesh>
  );
}
