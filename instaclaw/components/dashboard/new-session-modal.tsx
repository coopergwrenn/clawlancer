"use client";

/**
 * NewSessionModal — the "where do you want to start?" fork for the rail's "+".
 *
 * Shown ONLY when the "+" is clicked from OUTSIDE Command Center (from the rail
 * on another page). Inside Command Center the "+" skips the modal (the Chat /
 * Tasks tabs are right there). Each choice routes to the REAL new-session flow
 * via a `/tasks?new=chat|task` intent the Command Center page consumes — no
 * parallel half-version.
 *
 * Copy intent (load-bearing): Chat and Tasks OVERLAP — recurring tasks can start
 * from either, and you can do anything from either. The wording presents two
 * starting points / two vibes, never two walled gardens.
 */

import { useEffect, useRef } from "react";
import { MessageSquare, ListTodo, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export type NewSessionMode = "chat" | "task";

const CORAL = "#DC6743";

export function NewSessionModal({
  open,
  onClose,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (mode: NewSessionMode) => void;
}) {
  const firstRef = useRef<HTMLButtonElement>(null);

  // Esc to close + focus the first choice on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = requestAnimationFrame(() => firstRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(t);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          {/* backdrop — warm, soft blur; click-out closes */}
          <div
            className="absolute inset-0"
            style={{ background: "rgba(28,25,23,0.42)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }}
            onClick={onClose}
            aria-hidden="true"
          />

          {/* panel — the dashboard's warm/light material, not a system dialog */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Start a new session"
            className="relative w-full max-w-sm rounded-2xl p-5"
            style={{
              background: "var(--background)",
              border: "1px solid var(--border)",
              boxShadow: "0 16px 48px rgba(0,0,0,0.20), 0 2px 8px rgba(0,0,0,0.08)",
            }}
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, y: 6 }}
            transition={{ type: "spring", stiffness: 540, damping: 36 }}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-3 top-3 w-7 h-7 flex items-center justify-center rounded-lg cursor-pointer transition-colors hover:bg-black/[0.06] outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
              style={{ color: "var(--muted)" }}
            >
              <X className="w-4 h-4" />
            </button>

            <h2
              className="text-base font-semibold tracking-[-0.2px] pr-6"
              style={{ color: "var(--foreground)", fontFamily: "var(--font-serif)" }}
            >
              Where do you want to start?
            </h2>

            <div className="mt-3.5 flex flex-col gap-2">
              <ChoiceRow
                ref={firstRef}
                icon={MessageSquare}
                label="Chat"
                desc="Quick back-and-forth. Ask anything, or kick off a task on the fly."
                onClick={() => onChoose("chat")}
              />
              <ChoiceRow
                icon={ListTodo}
                label="Tasks"
                desc="Hand over a job to run. One-off, or recurring like every morning at 9am."
                onClick={() => onChoose("task")}
              />
            </div>

            <p className="mt-3 text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
              Not locked in. You can do anything from either, and switch anytime.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const ChoiceRow = ({
  ref,
  icon: Icon,
  label,
  desc,
  onClick,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  icon: typeof MessageSquare;
  label: string;
  desc: string;
  onClick: () => void;
}) => (
  <button
    ref={ref}
    type="button"
    onClick={onClick}
    className="group flex items-start gap-3 w-full text-left rounded-xl px-3 py-3 cursor-pointer transition-all hover:-translate-y-[0.5px] active:scale-[0.99] outline-none focus-visible:ring-2 focus-visible:ring-[#DC6743]/40"
    style={{
      border: "1px solid var(--border)",
      background: "rgba(255,255,255,0.55)",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.borderColor = "rgba(220,103,67,0.45)";
      e.currentTarget.style.background = "rgba(220,103,67,0.05)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.borderColor = "var(--border)";
      e.currentTarget.style.background = "rgba(255,255,255,0.55)";
    }}
  >
    <span
      className="shrink-0 mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
      style={{ background: "rgba(220,103,67,0.10)", color: CORAL }}
    >
      <Icon className="w-[18px] h-[18px]" strokeWidth={2} />
    </span>
    <span className="min-w-0">
      <span className="block text-sm font-semibold" style={{ color: "var(--foreground)" }}>
        {label}
      </span>
      <span className="block text-xs leading-snug mt-0.5" style={{ color: "var(--muted)" }}>
        {desc}
      </span>
    </span>
  </button>
);
