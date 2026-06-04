"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { buildTourSteps } from "./tour-steps";

interface SpotlightTourProps {
  startStep: number;
  onStepChange: (step: number) => void;
  onComplete: () => void;
  onClose: () => void;
  setMoreOpen: (open: boolean) => void;
  navigateTo: (path: string) => void;
  // Phase 1 sidebar restructure. "topnav" (default) is byte-identical to the
  // pre-restructure behaviour. "sidebar" builds the sidebar-adapted step array.
  // The sidebar is desktop-only, so its rail is always visible — no drawer to
  // open; only the top-nav tour ever opens the "···" menu.
  navMode?: "topnav" | "sidebar";
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 8;
const TOOLTIP_GAP = 12;

// Prefer an on-screen instance when a selector matches multiple elements. In
// sidebar mode the same data-tour key exists on BOTH the desktop rail (which
// is display:none on mobile) AND the open drawer; a plain querySelector would
// return the first (hidden) one and the spotlight would target an invisible
// box. Picking the element with a non-zero bounding box targets the visible
// instance. In top-nav mode there's only ever one match, so this is a no-op.
function findVisibleElement(selector: string): Element | null {
  const els = Array.from(document.querySelectorAll(selector));
  if (els.length === 0) return null;
  return (
    els.find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }) ?? els[0]
  );
}

function getElementRect(selector: string): Rect | null {
  const el = findVisibleElement(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: r.top - PADDING,
    left: r.left - PADDING,
    width: r.width + PADDING * 2,
    height: r.height + PADDING * 2,
  };
}

type TooltipPos = "top" | "bottom" | "left" | "right";

function computeTooltipPosition(
  rect: Rect,
  preferred?: string,
  keepMoreOpen?: boolean
): { pos: TooltipPos; style: React.CSSProperties } {
  const isMobile = window.innerWidth < 640;

  // Mobile: always use bottom sheet
  if (isMobile) {
    return {
      pos: "bottom",
      style: {
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        borderRadius: "16px 16px 0 0",
      },
    };
  }

  const vp = { w: window.innerWidth, h: window.innerHeight };
  const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

  // For items inside the More dropdown, position tooltip below the entire dropdown
  // so it doesn't cover sibling menu items
  if (keepMoreOpen) {
    const dropdown = document.querySelector('[data-tour-dropdown="more"]');
    const dropdownBottom = dropdown
      ? dropdown.getBoundingClientRect().bottom + TOOLTIP_GAP
      : rect.top + rect.height + TOOLTIP_GAP;

    return {
      pos: "bottom",
      style: {
        position: "fixed",
        top: dropdownBottom,
        right: Math.max(16, vp.w - (rect.left + rect.width + PADDING)),
      },
    };
  }

  // Determine best position
  let pos: TooltipPos = "bottom";

  if (preferred && preferred !== "auto") {
    pos = preferred as TooltipPos;
  } else {
    const spaceBelow = vp.h - (rect.top + rect.height);
    const spaceAbove = rect.top;
    const spaceRight = vp.w - (rect.left + rect.width);
    const spaceLeft = rect.left;

    if (spaceBelow >= 200) pos = "bottom";
    else if (spaceAbove >= 200) pos = "top";
    else if (spaceRight >= 320) pos = "right";
    else if (spaceLeft >= 320) pos = "left";
  }

  const style: React.CSSProperties = { position: "fixed" };

  switch (pos) {
    case "bottom":
      style.top = rect.top + rect.height + TOOLTIP_GAP;
      style.left = Math.max(16, Math.min(center.x - 160, vp.w - 336));
      break;
    case "top":
      style.bottom = vp.h - rect.top + TOOLTIP_GAP;
      style.left = Math.max(16, Math.min(center.x - 160, vp.w - 336));
      break;
    case "right":
      style.top = Math.max(16, center.y - 80);
      style.left = rect.left + rect.width + TOOLTIP_GAP;
      break;
    case "left":
      style.top = Math.max(16, center.y - 80);
      style.right = vp.w - rect.left + TOOLTIP_GAP;
      break;
  }

  return { pos, style };
}

export default function SpotlightTour({
  startStep,
  onStepChange,
  onComplete,
  onClose,
  setMoreOpen,
  navigateTo,
  navMode = "topnav",
}: SpotlightTourProps) {
  const tourSteps = useMemo(() => buildTourSteps(navMode), [navMode]);
  const [currentStep, setCurrentStep] = useState(startStep);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipInfo, setTooltipInfo] = useState<{
    pos: TooltipPos;
    style: React.CSSProperties;
  } | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = tourSteps[currentStep];
  const totalSteps = tourSteps.length;
  const isLast = currentStep === totalSteps - 1;

  // Locate target element and position tooltip
  const updatePosition = useCallback(() => {
    if (!step) return;
    const rect = getElementRect(step.selector);
    if (rect) {
      setTargetRect(rect);
      setTooltipInfo(computeTooltipPosition(rect, step.position, step.keepMoreOpen));
    } else {
      setTargetRect(null);
      setTooltipInfo(null);
    }
  }, [step]);

  // When step changes, handle navigation and pre-actions
  useEffect(() => {
    if (!step) return;
    setIsTransitioning(true);

    const setup = async () => {
      // Navigate if needed
      if (step.navigateTo) {
        navigateTo(step.navigateTo);
      }

      // Reveal the chrome this step needs. Sidebar mode is desktop-only — the
      // rail is always visible, so there's no drawer to open; only the top-nav
      // tour opens the "···" menu.
      if (navMode === "topnav") {
        if (step.preAction === "open-more" || step.keepMoreOpen) {
          setMoreOpen(true);
        } else {
          setMoreOpen(false);
        }
      }

      // Wait for DOM to settle after navigation / chrome reveal.
      const initialDelay = step.navigateTo
        ? 400
        : step.preAction === "open-more"
          ? 200
          : 50;

      if (retryRef.current) clearTimeout(retryRef.current);

      // Poll for element until it appears (handles async data-fetching pages)
      let attempts = 0;
      const maxAttempts = 15;

      const tryPosition = () => {
        attempts++;
        const el = findVisibleElement(step.selector);

        if (!el && attempts < maxAttempts) {
          // Element not in DOM yet, retry in 200ms
          retryRef.current = setTimeout(tryPosition, 200);
          return;
        }

        // Element not found after all retries — auto-skip to next step
        if (!el) {
          setIsTransitioning(false);
          const next = currentStep + 1;
          if (next < tourSteps.length) {
            setCurrentStep(next);
            onStepChange(next);
          } else {
            setMoreOpen(false);
            onComplete();
          }
          return;
        }

        if (el) {
          const rect = el.getBoundingClientRect();
          const inView = rect.top >= 80 && rect.bottom <= window.innerHeight - 280;
          if (!inView) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            retryRef.current = setTimeout(() => {
              updatePosition();
              setIsTransitioning(false);
              retryRef.current = setTimeout(() => updatePosition(), 200);
            }, 500);
            return;
          }
        }

        updatePosition();
        setIsTransitioning(false);
        // One final position check after paint
        retryRef.current = setTimeout(() => updatePosition(), 200);
      };

      retryRef.current = setTimeout(tryPosition, initialDelay);
    };

    setup();

    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [currentStep, step, navigateTo, setMoreOpen, updatePosition, onStepChange, onComplete]);

  // Recalc on window resize
  useEffect(() => {
    const handler = () => updatePosition();
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [updatePosition]);

  const goNext = useCallback(() => {
    if (isLast) {
      setMoreOpen(false);
      onComplete();
    } else {
      const next = currentStep + 1;
      setCurrentStep(next);
      onStepChange(next);
    }
  }, [currentStep, isLast, onComplete, onStepChange, setMoreOpen]);

  const goPrev = useCallback(() => {
    if (currentStep > 0) {
      const prev = currentStep - 1;
      setCurrentStep(prev);
      onStepChange(prev);
    }
  }, [currentStep, onStepChange]);

  const handleClose = useCallback(() => {
    setMoreOpen(false);
    onClose();
  }, [setMoreOpen, onClose]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
      if (e.key === "ArrowRight" || e.key === "Enter") goNext();
      if (e.key === "ArrowLeft") goPrev();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose, goNext, goPrev]);

  if (!step) return null;

  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

  return (
    <>
      {/* Click blocker + transition overlay — dims screen only when cutout isn't visible */}
      <div
        className="fixed inset-0 z-[9997]"
        style={{
          background: isTransitioning || !targetRect
            ? "rgba(0,0,0,0.32)"
            : "transparent",
        }}
      />

      {/* Spotlight cutout — provides dimming with a hole around the target */}
      <AnimatePresence>
        {targetRect && !isTransitioning && (
          <motion.div
            className="fixed z-[9998] rounded-xl pointer-events-none spotlight-cutout"
            initial={false}
            animate={{
              top: targetRect.top,
              left: targetRect.left,
              width: targetRect.width,
              height: targetRect.height,
            }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            style={{
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.32)",
            }}
          />
        )}
      </AnimatePresence>

      {/* Tooltip */}
      <AnimatePresence mode="wait">
        {tooltipInfo && !isTransitioning && (
          <motion.div
            key={currentStep}
            className={`${
              isMobile
                ? "fixed bottom-0 left-0 right-0 z-[9999] p-6"
                : `z-[9999] ${step.large ? "max-w-sm" : "w-80"} p-5 rounded-xl`
            }`}
            style={{
              ...(isMobile ? {} : tooltipInfo.style),
              pointerEvents: "auto",
              background: isMobile
                ? "rgba(255, 255, 255, 0.95)"
                : "rgba(255, 255, 255, 0.82)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              borderRadius: isMobile ? "16px 16px 0 0" : undefined,
              border: isMobile
                ? "none"
                : "1px solid rgba(255, 255, 255, 0.5)",
              boxShadow: isMobile
                ? "0 -8px 32px rgba(0,0,0,0.12), 0 0 0 1px rgba(255,255,255,0.3) inset"
                : "0 12px 40px rgba(0,0,0,0.12), 0 0 0 1px rgba(255,255,255,0.3) inset, 0 -2px 6px rgba(255,255,255,0.4) inset",
              paddingBottom: isMobile
                ? "max(2rem, calc(env(safe-area-inset-bottom) + 1.5rem))"
                : undefined,
            }}
            initial={{ opacity: 0, y: tooltipInfo.pos === "top" ? 8 : -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: tooltipInfo.pos === "top" ? 8 : -8 }}
            transition={{ duration: 0.2 }}
          >
            {/* Close button */}
            <button
              onPointerDown={handleClose}
              className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center cursor-pointer transition-colors hover:bg-black/5"
              style={{ color: "var(--muted)" }}
            >
              <X className="w-3.5 h-3.5" />
            </button>

            {/* Content */}
            <h3
              className="text-sm font-semibold mb-1.5 pr-6"
              style={{ color: "var(--foreground)" }}
            >
              {step.title}
            </h3>
            <p
              className="text-xs leading-relaxed"
              style={{ color: "var(--muted)" }}
            >
              {step.description}
            </p>

            {/* Navigation */}
            <div className="mt-4 space-y-3">
              {/* Progress bar */}
              <div className="w-full rounded-full h-1 overflow-hidden" style={{ background: "rgba(0,0,0,0.08)" }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${((currentStep + 1) / totalSteps) * 100}%`,
                    background: "var(--foreground)",
                  }}
                />
              </div>

              {/* Step counter + buttons */}
              <div className="flex items-center justify-between">
                <span
                  className="text-[11px] tabular-nums"
                  style={{ color: "var(--muted)" }}
                >
                  {currentStep + 1} of {totalSteps}
                </span>

                <div className="flex items-center gap-2">
                  {currentStep > 0 && (
                    <button
                      onPointerDown={goPrev}
                      className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-black/5"
                      style={{ color: "var(--muted)" }}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onPointerDown={goNext}
                    className={`flex items-center gap-1 rounded-lg font-medium cursor-pointer transition-all hover:opacity-90 active:scale-[0.96] ${
                      isMobile ? "px-5 py-2.5 text-sm" : "px-3.5 py-1.5 text-xs"
                    }`}
                    style={{
                      background: "var(--foreground)",
                      color: "var(--background)",
                    }}
                  >
                    {isLast ? "Finish Tour" : "Next"}
                    {!isLast && <ChevronRight className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
