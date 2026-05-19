"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Cinematic Healdsburg hero — aerial illustrated map driven by OpenSeadragon.
 *
 * OpenSeadragon is dynamic-imported from the npm package on first mount, so
 * Next bundles it into its own code-split chunk (~50 KB) that only ships
 * when /edge actually renders. The collab repo used a jsDelivr CDN load; we
 * moved to npm for production so we don't depend on external CDN availability
 * at runtime.
 *
 * Behavior (faithful port from ../edgeclaw-site/app.jsx):
 *
 *   home      → image fills the viewport; first scroll-down triggers the
 *               cinematic, blending the OSD camera zoom with a parallel
 *               window scroll so the two motions feel like one continuous
 *               flow.
 *   animating → camera is in flight; wheel/touch are held so the user
 *               can't fight the in-flight transition.
 *   focused   → camera has landed on the Healdsburg focus point; wheel
 *               yields to the browser so the page scrolls past the map.
 *               If the user scrolls back to scrollY=0, scrolling up plays
 *               the reverse cinematic and returns the camera to home.
 *
 * The wheel + touch listeners attach with `{ passive: false, capture: true }`
 * so we can stopImmediatePropagation before OSD's own MouseTracker
 * preventDefaults the event.
 */

const HB_FOCUS = { x: 0.6168107142857139, y: 0.4729517857142861 };
const HB_FOCUS_ZOOM_MULT = 2.6;

// OSD's own .d.ts doesn't surface the runtime factory cleanly; treat as `any`
// at the boundary and rely on the configuration shape elsewhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OSDLib = any;

async function loadOpenSeadragon(): Promise<OSDLib> {
  if (typeof window === "undefined") throw new Error("SSR");
  // Dynamic import: Next code-splits this into its own chunk so the OSD
  // bundle only loads when HealdsburgMap actually mounts.
  const mod = await import("openseadragon");
  return mod.default;
}

export function HealdsburgMap({ children }: { children: ReactNode }) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const viewerElRef = useRef<HTMLDivElement | null>(null);
  const [osdReady, setOsdReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let viewer: any = null;
    let cleanup = () => {};

    (async () => {
      let OSD: OSDLib;
      try {
        OSD = await loadOpenSeadragon();
      } catch {
        return;
      }
      if (cancelled || !viewerElRef.current) return;

      viewer = OSD({
        element: viewerElRef.current,
        // prefixUrl omitted — all UI controls are disabled below, so OSD
        // never reaches for the navigator/zoom button image assets.
        tileSources: {
          type: "image",
          url: "/edge/healdsburg/healdsburg-detailed.jpg",
        },
        showNavigator: false,
        showNavigationControl: false,
        showZoomControl: false,
        showHomeControl: false,
        showFullPageControl: false,
        showRotationControl: false,
        showSequenceControl: false,
        immediateRender: true,
        visibilityRatio: 1.0,
        constrainDuringPan: true,
        minZoomImageRatio: 1.0,
        homeFillsViewer: true,
        // Cream backdrop = same as the page `--cream`. If the camera ever
        // shows a sliver outside the image (during resize transients, or
        // before the idle pan's clamp kicks in), it blends with the page
        // bg instead of revealing the SkyBackdrop's sky-blue band.
        background: "#f4ede0",
        mouseNavEnabled: true,
        gestureSettingsMouse: {
          scrollToZoom: false,
          clickToZoom: false,
          dblClickToZoom: false,
          dragToPan: true,
          pinchToZoom: true,
        },
        gestureSettingsTouch: {
          scrollToZoom: false,
          clickToZoom: false,
          dblClickToZoom: false,
          dragToPan: true,
          pinchToZoom: true,
          flickEnabled: true,
        },
        gestureSettingsPen: {
          scrollToZoom: false,
          clickToZoom: false,
          dblClickToZoom: false,
          dragToPan: true,
          pinchToZoom: true,
        },
      });

      let mapState: "home" | "animating" | "focused" = "home";
      let stateTimer: ReturnType<typeof setTimeout> | null = null;
      // Idle pan: while the camera sits at home, drift the center along a
      // slow Lissajous so the hero feels alive. Stopped whenever the user
      // (or the cinematic) takes control. constrainDuringPan + visibilityRatio
      // automatically clamp the motion at the image edges.
      let idleRafId: number | null = null;

      viewer.addOnceHandler("open", () => {
        if (cancelled) return;
        setOsdReady(true);

        const tiledImage = viewer.world.getItemAt(0);
        const dims = tiledImage.getContentSize();

        const homeBounds = viewer.viewport.getHomeBounds();
        const homeCenter = homeBounds.getCenter();
        const homeZoom = viewer.viewport.getHomeZoom();

        const focusImagePoint = new OSD.Point(
          HB_FOCUS.x * dims.x,
          HB_FOCUS.y * dims.y
        );
        const focusVp = tiledImage.imageToViewportCoordinates(
          focusImagePoint.x,
          focusImagePoint.y
        );
        const focusZoom = homeZoom * HB_FOCUS_ZOOM_MULT;
        // Shift LEFT so the focus area sits on the right of the viewport,
        // clear of the left-anchored hero card.
        const focusVpW = 1 / focusZoom;
        const focusViewportPoint = new OSD.Point(
          focusVp.x - focusVpW * 0.15,
          focusVp.y
        );

        // Rest the camera slightly tighter than homeFillsViewer so there's
        // guaranteed slack on BOTH axes for the idle Lissajous drift. Without
        // this, whichever axis matches the viewer aspect would have zero
        // pan room and the drift would collapse to a single-axis sway.
        const IDLE_ZOOM_MULT = 1.05;
        const restingZoom = homeZoom * IDLE_ZOOM_MULT;
        viewer.viewport.zoomTo(restingZoom, null, true);
        viewer.viewport.panTo(homeCenter, true);

        const getAnimMs = () => {
          const t = viewer.viewport.centerSpringX?.animationTime;
          return Math.max(
            800,
            Math.round((typeof t === "number" ? t : 1.2) * 1000)
          );
        };

        const IDLE_AMP_X_MAX = 0.04;
        const IDLE_AMP_Y_MAX = 0.025;
        const IDLE_PERIOD_X_MS = 30_000;
        const IDLE_PERIOD_Y_MS = 42_000;

        // Image extent in viewport coordinates — used to clamp the idle pan
        // amplitude so the camera never strays past the image edge (which
        // would otherwise show the transparent OSD canvas / page bg).
        const imageBounds = tiledImage.getBounds();

        const stopIdlePan = () => {
          if (idleRafId !== null) {
            cancelAnimationFrame(idleRafId);
            idleRafId = null;
          }
        };

        const startIdlePan = () => {
          if (idleRafId !== null) return; // already running
          const t0 = performance.now();
          const step = (now: number) => {
            if (mapState !== "home") {
              idleRafId = null;
              return;
            }
            // Slack is computed against the CURRENT viewport bounds, not the
            // raw homeBounds — since the camera rests at restingZoom > home,
            // both axes have non-zero slack and the drift can move on both.
            // Recomputing each frame also keeps it correct across resize.
            const cb = viewer.viewport.getBounds();
            const maxDx = Math.max(0, (imageBounds.width - cb.width) / 2);
            const maxDy = Math.max(0, (imageBounds.height - cb.height) / 2);
            // Keep a 10% margin so the camera never quite kisses the edge.
            const ampX = Math.min(IDLE_AMP_X_MAX, maxDx * 0.9);
            const ampY = Math.min(IDLE_AMP_Y_MAX, maxDy * 0.9);

            const dt = now - t0;
            const target = new OSD.Point(
              homeCenter.x +
                ampX * Math.sin((dt / IDLE_PERIOD_X_MS) * 2 * Math.PI),
              homeCenter.y +
                ampY *
                  Math.sin(
                    (dt / IDLE_PERIOD_Y_MS) * 2 * Math.PI + Math.PI / 4
                  )
            );
            // `immediately = true` writes the center directly each frame so
            // the spring doesn't fight the sin-driven target.
            viewer.viewport.panTo(target, true);
            idleRafId = requestAnimationFrame(step);
          };
          idleRafId = requestAnimationFrame(step);
        };

        // Kick off the ambient drift now that the camera is parked at home.
        startIdlePan();

        const playCinematic = () => {
          if (mapState !== "home") return;
          mapState = "animating";
          stopIdlePan();

          viewer.viewport.zoomTo(focusZoom);
          viewer.viewport.panTo(focusViewportPoint);

          const animMs = getAnimMs();

          // Run the page scroll in parallel with the zoom — same start
          // instant, same duration — so the two motions blend.
          const wrap = wrapRef.current;
          if (wrap) {
            const startY = window.scrollY;
            const targetY = wrap.offsetTop + wrap.offsetHeight;
            const distance = targetY - startY;
            if (distance > 1) {
              const tStart = performance.now();
              const ease = (t: number) =>
                t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
              const step = (now: number) => {
                if (mapState === "home") return; // reversed mid-flight
                const t = Math.min(1, (now - tStart) / animMs);
                window.scrollTo(0, startY + distance * ease(t));
                if (t < 1) requestAnimationFrame(step);
              };
              requestAnimationFrame(step);
            }
          }

          if (stateTimer) clearTimeout(stateTimer);
          stateTimer = setTimeout(() => {
            if (mapState === "animating") mapState = "focused";
          }, animMs);
        };

        const playReverseCinematic = () => {
          if (mapState !== "focused") return;
          mapState = "animating";

          // Return to the slightly-tighter resting zoom (not raw homeZoom)
          // so the idle drift can resume without a visible zoom-out step.
          viewer.viewport.zoomTo(restingZoom);
          viewer.viewport.panTo(homeCenter);

          const animMs = getAnimMs();
          if (stateTimer) clearTimeout(stateTimer);
          stateTimer = setTimeout(() => {
            if (mapState === "animating") {
              mapState = "home";
              startIdlePan();
            }
          }, animMs);
        };

        // Only intercept events while the map fills the dominant view.
        const isSectionDominant = () => {
          const wrap = wrapRef.current;
          if (!wrap) return false;
          const rect = wrap.getBoundingClientRect();
          return rect.top <= 5 && rect.bottom > window.innerHeight * 0.4;
        };

        const onWheel = (e: WheelEvent) => {
          if (!isSectionDominant()) return;

          // ── SCROLL UP ──
          if (e.deltaY < 0) {
            if (mapState === "animating") {
              e.preventDefault();
              e.stopImmediatePropagation();
              return;
            }
            // Let the browser scroll back to the top first.
            if (window.scrollY > 0) return;
            // Page is pinned at the top: reverse the cinematic.
            if (mapState === "focused") {
              e.preventDefault();
              e.stopImmediatePropagation();
              playReverseCinematic();
              return;
            }
            return;
          }

          // ── SCROLL DOWN ──
          if (e.deltaY <= 0) return;
          if (mapState === "home") {
            e.preventDefault();
            e.stopImmediatePropagation();
            playCinematic();
            return;
          }
          if (mapState === "animating") {
            e.preventDefault();
            e.stopImmediatePropagation(); // hold the page until camera lands
            return;
          }
          // focused: stop OSD from preventDefaulting; let the browser scroll.
          e.stopImmediatePropagation();
        };

        let touchStartY: number | null = null;
        const onTouchStart = (e: TouchEvent) => {
          if (e.touches.length !== 1) {
            touchStartY = null;
            return;
          }
          touchStartY = e.touches[0].clientY;
        };
        const onTouchMove = (e: TouchEvent) => {
          if (touchStartY == null) return;
          const dy = touchStartY - e.touches[0].clientY; // + = swipe up
          if (Math.abs(dy) <= 8) return;
          if (!isSectionDominant()) return;

          // ── SWIPE DOWN (finger down → page scrolls up) ──
          if (dy < 0) {
            if (mapState === "animating") {
              e.preventDefault();
              e.stopImmediatePropagation();
              return;
            }
            if (window.scrollY > 0) return;
            if (mapState === "focused") {
              e.preventDefault();
              e.stopImmediatePropagation();
              playReverseCinematic();
              touchStartY = null;
              return;
            }
            return;
          }

          // ── SWIPE UP (finger up → page scrolls down) ──
          if (mapState === "home") {
            e.preventDefault();
            e.stopImmediatePropagation();
            playCinematic();
            touchStartY = null;
            return;
          }
          if (mapState === "animating") {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          e.stopImmediatePropagation();
        };
        const onTouchEnd = () => {
          touchStartY = null;
        };

        window.addEventListener("wheel", onWheel, {
          passive: false,
          capture: true,
        });
        window.addEventListener("touchstart", onTouchStart, {
          passive: true,
          capture: true,
        });
        window.addEventListener("touchmove", onTouchMove, {
          passive: false,
          capture: true,
        });
        window.addEventListener("touchend", onTouchEnd, {
          passive: true,
          capture: true,
        });

        // Yield to the user as soon as they pan/pinch the map.
        const onUserNavigate = () => {
          if (stateTimer) {
            clearTimeout(stateTimer);
            stateTimer = null;
          }
          stopIdlePan();
          mapState = "focused";
        };
        viewer.addHandler("canvas-drag", onUserNavigate);
        viewer.addHandler("canvas-pinch", onUserNavigate);

        cleanup = () => {
          window.removeEventListener("wheel", onWheel, {
            capture: true,
          } as EventListenerOptions);
          window.removeEventListener("touchstart", onTouchStart, {
            capture: true,
          } as EventListenerOptions);
          window.removeEventListener("touchmove", onTouchMove, {
            capture: true,
          } as EventListenerOptions);
          window.removeEventListener("touchend", onTouchEnd, {
            capture: true,
          } as EventListenerOptions);
          stopIdlePan();
          if (stateTimer) clearTimeout(stateTimer);
        };
      });
    })();

    return () => {
      cancelled = true;
      cleanup();
      try {
        viewer?.destroy();
      } catch {
        /* noop */
      }
    };
  }, []);

  return (
    <section
      ref={wrapRef}
      className="relative w-full h-[100dvh] min-h-[600px] overflow-hidden"
      style={{ background: "#f4ede0" }}
      data-screen-label="healdsburg-map"
    >
      {/* Fallback static crop — shown until OSD has opened the tile source.
          Sits at the home framing so the swap to OSD is visually invisible. */}
      {!osdReady && (
        <Image
          src="/edge/healdsburg/healdsburg-detailed.jpg"
          alt=""
          fill
          priority
          aria-hidden
          sizes="100vw"
          className="object-cover"
          style={{ objectPosition: "50% 50%" }}
        />
      )}
      <div ref={viewerElRef} className="absolute inset-0 w-full h-full" />
      {children}
    </section>
  );
}
