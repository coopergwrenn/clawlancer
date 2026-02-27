"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import Image from "next/image";

interface AmbassadorCardProps {
  number: number;
  verified?: boolean;
  /** When true, disables all interactions (tilt, shimmer, specular). Use for NFT image export. */
  static?: boolean;
}

export default function AmbassadorCard({
  number,
  verified = false,
  static: isStatic = false,
}: AmbassadorCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const subtitleRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const numberRef = useRef<HTMLDivElement>(null);

  const [isTouchDevice, setIsTouchDevice] = useState(false);

  const formattedNumber = String(number).padStart(3, "0");

  useEffect(() => {
    if (isStatic) return;
    setIsTouchDevice(
      "ontouchstart" in window || navigator.maxTouchPoints > 0
    );
  }, [isStatic]);

  // ── Interactions disabled in static mode ──
  const interactive = !isStatic && !isTouchDevice;

  // ── Spring transition for returning to neutral ──
  const SPRING = "0.6s cubic-bezier(0.23, 1, 0.32, 1)";
  const TRACK = "0.06s linear";

  const applyParallax = useCallback(
    (ref: React.RefObject<HTMLDivElement | null>, x: number, y: number) => {
      if (ref.current) ref.current.style.transform = `translate(${x}px, ${y}px)`;
    },
    []
  );

  const setTransitions = useCallback(
    (timing: string) => {
      const refs = [logoRef, titleRef, subtitleRef, lineRef, numberRef];
      refs.forEach((ref) => {
        if (ref.current) ref.current.style.transition = `transform ${timing}`;
      });
    },
    []
  );

  // ── Mouse handlers — direct DOM updates, no React re-renders ──

  const handleMouseEnter = useCallback(() => {
    if (!interactive) return;
    const card = cardRef.current;
    if (!card) return;

    card.style.transition = `transform ${TRACK}, box-shadow 0.3s ease`;
    card.style.boxShadow = [
      "0 0 0 0.5px rgba(255,255,255,0.5) inset",
      "0 1px 0 rgba(255,255,255,0.9) inset",
      "0 -1px 0 rgba(0,0,0,0.02) inset",
      "0 8px 32px rgba(0,0,0,0.08)",
      "0 20px 60px rgba(0,0,0,0.05)",
    ].join(", ");

    if (highlightRef.current) highlightRef.current.style.transition = "none";
    setTransitions(TRACK);
  }, [interactive, setTransitions]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const card = cardRef.current;
      if (!card) return;

      const rect = card.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const cx = x - 0.5;
      const cy = y - 0.5;

      card.style.transform = `rotateX(${cy * -10}deg) rotateY(${cx * 10}deg) scale(1.02)`;

      if (highlightRef.current) {
        highlightRef.current.style.opacity = "1";
        highlightRef.current.style.background = `radial-gradient(
          ellipse 45% 45% at ${x * 100}% ${y * 100}%,
          rgba(255,255,255,0.35) 0%,
          rgba(255,255,255,0.08) 40%,
          transparent 70%
        )`;
      }

      const px = cx * 6;
      const py = cy * 6;
      applyParallax(logoRef, px, py);
      applyParallax(titleRef, px * 0.6, py * 0.6);
      applyParallax(subtitleRef, px * 0.4, py * 0.4);
      applyParallax(lineRef, px * 0.2, 0);
      applyParallax(numberRef, px * 0.15, py * 0.15);
    },
    [interactive, applyParallax]
  );

  const handleMouseLeave = useCallback(() => {
    if (!interactive) return;
    const card = cardRef.current;
    if (!card) return;

    card.style.transition = `transform ${SPRING}, box-shadow 0.4s ease`;
    card.style.transform = "rotateX(0deg) rotateY(0deg) scale(1)";
    card.style.boxShadow = [
      "0 0 0 0.5px rgba(255,255,255,0.4) inset",
      "0 1px 0 rgba(255,255,255,0.8) inset",
      "0 -1px 0 rgba(0,0,0,0.03) inset",
      "0 4px 16px rgba(0,0,0,0.06)",
      "0 12px 40px rgba(0,0,0,0.04)",
    ].join(", ");

    if (highlightRef.current) {
      highlightRef.current.style.transition = "opacity 0.4s ease";
      highlightRef.current.style.opacity = "0";
    }

    setTransitions(SPRING);
    const refs = [logoRef, titleRef, subtitleRef, lineRef, numberRef];
    refs.forEach((ref) => {
      if (ref.current) ref.current.style.transform = "translate(0, 0)";
    });
  }, [interactive, setTransitions]);

  // ── Shared card styles ──
  const cardStyles: React.CSSProperties = {
    width: isStatic ? "340px" : "min(340px, 85vw)",
    aspectRatio: "1",
    borderRadius: "22px",
    background:
      "linear-gradient(165deg, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.88) 50%, rgba(250,250,250,0.92) 100%)",
    border: "1px solid rgba(255,255,255,0.6)",
    boxShadow: [
      "0 0 0 0.5px rgba(255,255,255,0.4) inset",
      "0 1px 0 rgba(255,255,255,0.8) inset",
      "0 -1px 0 rgba(0,0,0,0.03) inset",
      "0 4px 16px rgba(0,0,0,0.06)",
      "0 12px 40px rgba(0,0,0,0.04)",
    ].join(", "),
    position: "relative",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    cursor: "default",
    userSelect: "none",
    // Interactive-only properties
    ...(!isStatic && {
      backdropFilter: "blur(40px)",
      WebkitBackdropFilter: "blur(40px)",
      transformStyle: "preserve-3d" as const,
      willChange: "transform",
    }),
  };

  return (
    <div style={isStatic ? undefined : { perspective: "800px" }}>
      <div
        ref={isStatic ? undefined : cardRef}
        onMouseEnter={isStatic ? undefined : handleMouseEnter}
        onMouseMove={isStatic ? undefined : handleMouseMove}
        onMouseLeave={isStatic ? undefined : handleMouseLeave}
        style={cardStyles}
      >
        {/* ── Crab monogram pattern — faint luxury watermark ── */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: "url(/crab-pattern.jpg)",
            backgroundSize: "180px",
            backgroundRepeat: "repeat",
            imageRendering: "pixelated",
            opacity: 0.06,
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
        {/* Radial vignette — fades pattern toward center so text stays clean */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse 55% 55% at 50% 48%, rgba(255,255,255,1) 0%, rgba(255,255,255,0.4) 55%, transparent 100%)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />

        {/* ── Specular highlight overlay (interactive only) ── */}
        {!isStatic && (
          <div
            ref={highlightRef}
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "inherit",
              opacity: 0,
              pointerEvents: "none",
              zIndex: 10,
            }}
          />
        )}

        {/* ── Verified badge ── */}
        {verified && (
          <div
            style={{
              position: "absolute",
              top: "16px",
              right: "16px",
              fontFamily: "var(--font-serif)",
              fontSize: "9px",
              fontWeight: 400,
              letterSpacing: "0.08em",
              color: "#DC6743",
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.7), rgba(255,255,255,0.45))",
              backdropFilter: isStatic ? undefined : "blur(12px)",
              WebkitBackdropFilter: isStatic ? undefined : "blur(12px)",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "1px solid rgba(255,255,255,0.5)",
              boxShadow: [
                "0 0 0 0.5px rgba(255,255,255,0.3) inset",
                "0 1px 0 rgba(255,255,255,0.6) inset",
                "0 1px 3px rgba(0,0,0,0.06)",
                "0 2px 8px rgba(0,0,0,0.03)",
              ].join(", "),
              zIndex: 5,
            }}
          >
            VERIFIED
          </div>
        )}

        {/* ── Logo with orange glow ── */}
        <div
          ref={isStatic ? undefined : logoRef}
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "24px",
            zIndex: 2,
          }}
        >
          <div
            style={{
              position: "absolute",
              width: "140px",
              height: "140px",
              borderRadius: "50%",
              background:
                "radial-gradient(circle, rgba(220,103,67,0.18) 0%, rgba(220,103,67,0.06) 50%, transparent 75%)",
              filter: "blur(12px)",
              pointerEvents: "none",
            }}
          />
          <Image
            src="/logo.png"
            alt="InstaClaw"
            width={76}
            height={76}
            style={{
              position: "relative",
              zIndex: 1,
              imageRendering: "pixelated",
            }}
            draggable={false}
            priority
          />
        </div>

        {/* ── AMBASSADOR ── */}
        <div ref={isStatic ? undefined : titleRef} style={{ position: "relative", zIndex: 2 }}>
          <h2
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "27px",
              fontWeight: 400,
              letterSpacing: "0.22em",
              color: "#2d2d2e",
              margin: 0,
              lineHeight: 1,
            }}
          >
            AMBASSADOR
          </h2>
        </div>

        {/* ── INSTACLAW ── */}
        <div ref={isStatic ? undefined : subtitleRef} style={{ marginTop: "12px", position: "relative", zIndex: 2 }}>
          <span
            className={isStatic ? undefined : "shimmer-text"}
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "13.5px",
              fontWeight: 400,
              letterSpacing: "0.18em",
              // Static mode: flat orange. Interactive: shimmer handles color.
              ...(isStatic && { color: "#DC6743" }),
            }}
          >
            INSTACLAW
          </span>
        </div>

        {/* ── Thin separator ── */}
        <div
          ref={isStatic ? undefined : lineRef}
          style={{
            width: "56px",
            height: "1px",
            background:
              "linear-gradient(90deg, transparent, rgba(220,103,67,0.35), transparent)",
            marginTop: "20px",
            marginBottom: "20px",
            position: "relative",
            zIndex: 2,
          }}
        />

        {/* ── AMBASSADOR #001 ── */}
        <div ref={isStatic ? undefined : numberRef} style={{ position: "relative", zIndex: 2 }}>
          <span
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "11px",
              fontWeight: 400,
              letterSpacing: "0.2em",
              color: "#9ca3af",
            }}
          >
            AMBASSADOR #{formattedNumber}
          </span>
        </div>
      </div>
    </div>
  );
}
