"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import tourSteps from "./tour-steps";

interface SpotlightTourProps {
  startStep: number;
  onStepChange: (step: number) => void;
  onComplete: () => void;
  onClose: () => void;
  setMoreOpen: (open: boolean) => void;
  navigateTo: (path: string) => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 8;
const TOOLTIP_GAP = 12;

function getElementRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
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
}: SpotlightTourProps) {
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

      // Open More dropdown if needed
      if (step.preAction === "open-more" || step.keepMoreOpen) {
        setMoreOpen(true);
      } else {
        setMoreOpen(false);
      }

      // Wait for DOM to settle after navigation/dropdown
      const delay = step.navigateTo ? 400 : step.preAction === "open-more" ? 200 : 50;

      if (retryRef.current) clearTimeout(retryRef.current);

      retryRef.current = setTimeout(() => {
        // Smooth-scroll the target element into view before positioning
        const el = document.querySelector(step.selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          const inView = rect.top >= 80 && rect.bottom <= window.innerHeight - 280;
          if (!inView) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            // Wait for scroll to finish before positioning spotlight
            retryRef.current = setTimeout(() => {
              updatePosition();
              setIsTransitioning(false);
              // One more retry to catch any layout shift
              retryRef.current = setTimeout(() => updatePosition(), 200);
            }, 500);
            return;
          }
        }

        updatePosition();
        setIsTransitioning(false);

        // Retry once more if element wasn't found (navigation delay)
        retryRef.current = setTimeout(() => {
          const retryEl = document.querySelector(step.selector);
          if (retryEl) {
            const retryRect = retryEl.getBoundingClientRect();
            const retryInView = retryRect.top >= 80 && retryRect.bottom <= window.innerHeight - 280;
            if (!retryInView) {
              retryEl.scrollIntoView({ behavior: "smooth", block: "center" });
              retryRef.current = setTimeout(() => updatePosition(), 500);
              return;
            }
          }
          updatePosition();
        }, 300);
      }, delay);
    };

    setup();

    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [currentStep, step, navigateTo, setMoreOpen, updatePosition]);

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
      {/* Click blocker layer */}
      <div
        className="fixed inset-0 z-[9997]"
        onClick={(e) => e.stopPropagation()}
      />

      {/* Spotlight cutout */}
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
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
            }}
          />
        )}
      </AnimatePresence>

      {/* Tooltip */}
      <AnimatePresence mode="wait">
        {tooltipInfo && !isTransitioning && (
          <motion.div
            key={currentStep}
            className={`z-[9999] ${step.large ? "max-w-sm" : "w-80"} ${
              isMobile ? "p-6 pb-8" : "p-5 rounded-xl"
            }`}
            style={{
              ...tooltipInfo.style,
              background: isMobile
                ? "rgba(255, 255, 255, 0.92)"
                : "rgba(255, 255, 255, 0.82)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              border: isMobile
                ? "none"
                : "1px solid rgba(255, 255, 255, 0.5)",
              boxShadow: isMobile
                ? "0 -8px 32px rgba(0,0,0,0.12), 0 0 0 1px rgba(255,255,255,0.3) inset"
                : "0 12px 40px rgba(0,0,0,0.12), 0 0 0 1px rgba(255,255,255,0.3) inset, 0 -2px 6px rgba(255,255,255,0.4) inset",
            }}
            initial={{ opacity: 0, y: tooltipInfo.pos === "top" ? 8 : -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: tooltipInfo.pos === "top" ? 8 : -8 }}
            transition={{ duration: 0.2 }}
          >
            {/* Close button */}
            <button
              onClick={handleClose}
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
                      onClick={goPrev}
                      className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-black/5"
                      style={{ color: "var(--muted)" }}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={goNext}
                    className="flex items-center gap-1 px-3.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:opacity-90 active:scale-[0.96]"
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
