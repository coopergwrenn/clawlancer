"use client";

/**
 * Toast — THE notification primitive for transient confirmations.
 *
 * Born from user test #1 round two (2026-06-12): the post-purchase
 * confirmation rendered INLINE between dashboard sections, physically
 * shifting containers down, then back up on dismiss. A purchase
 * confirmation is a NOTIFICATION: it overlays on its own fixed layer, top
 * of screen, slides in over the content, auto-dismisses (~4.5s) with a
 * manual dismiss, and NEVER moves the page (position: fixed is the
 * structural guarantee — the toast exists outside document flow, so layout
 * shift is impossible by construction, not by tuning).
 *
 * Use this for every future success/info confirmation. Persistent STATE
 * banners (past_due, maintenance) are a different class and may legitimately
 * occupy layout — they inform continuously rather than confirm transiently.
 *
 * Usage:
 *   const { toast, showToast, dismissToast } = useToast();
 *   showToast({ message: "4 premium videos added · balance: 10 clips" });
 *   // in JSX, once per page, anywhere (it renders fixed):
 *   <ToastViewport toast={toast} onDismiss={dismissToast} />
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, AlertTriangle, X } from "lucide-react";

export interface ToastData {
  message: string;
  variant?: "success" | "error";
  /** Auto-dismiss after this many ms. Default 4500. */
  durationMs?: number;
}

export function useToast() {
  const [toast, setToast] = useState<ToastData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setToast(null);
  }, []);

  const showToast = useCallback((t: ToastData) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(t);
    timerRef.current = setTimeout(() => setToast(null), t.durationMs ?? 4500);
  }, []);

  // Clear the timer on unmount so a navigated-away page can't set state.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { toast, showToast, dismissToast };
}

export function ToastViewport({
  toast,
  onDismiss,
}: {
  toast: ToastData | null;
  onDismiss: () => void;
}) {
  return (
    // The aria-live region stays mounted so screen readers announce changes.
    // The wrapper itself is FIXED (out of document flow): a plain div here
    // would still earn space-y/gap margins from a parent container even at
    // zero height — the subtle layout-impact class this primitive exists to
    // kill. pointer-events pass through the (invisible) wrapper; the card
    // re-enables them so the dismiss X stays clickable.
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed top-6 right-6 z-[100] pointer-events-none"
    >
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
            className="pointer-events-auto max-w-sm glass rounded-xl px-4 py-3 shadow-lg flex items-start gap-2.5"
            style={{
              border:
                toast.variant === "error"
                  ? "1px solid rgba(220,38,38,0.25)"
                  : "1px solid rgba(22,163,74,0.25)",
              background:
                toast.variant === "error"
                  ? "rgba(220,38,38,0.06)"
                  : "rgba(22,163,74,0.06)",
              backdropFilter: "blur(12px)",
            }}
            role="status"
          >
            {toast.variant === "error" ? (
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#ef4444" }} />
            ) : (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#16a34a" }} />
            )}
            <p className="text-sm font-medium pr-1" style={{ color: "var(--foreground)" }}>
              {toast.message}
            </p>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss notification"
              className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md transition-opacity hover:opacity-60 cursor-pointer"
              style={{ color: "var(--muted)" }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
