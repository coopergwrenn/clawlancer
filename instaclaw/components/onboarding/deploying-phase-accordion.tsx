"use client";

/**
 * DeployingPhaseAccordion — "what's happening right now?" expandable list.
 *
 * Shown on /deploying for both pool and cloud-init paths. Same component,
 * different content configs:
 *
 *   POOL (4 phases):
 *     1. Claiming your reserved server
 *     2. Personalizing your agent
 *     3. Connecting to Telegram
 *     4. Running final checks
 *
 *   CLOUD-INIT (5 phases):
 *     1. Spinning up your dedicated cloud server
 *     2. Installing your agent's brain
 *     3. Loading personality and memory systems
 *     4. Connecting to Telegram
 *     5. Running final health checks
 *
 * Phase status (done / active / pending) is derived from a combination of:
 *   - Real backend signals from /api/vm/status (gatewayUrl, healthStatus, etc)
 *   - pollCount for time-based progression of intermediate phases that
 *     have no direct backend signal
 *
 * Design (per 2026-05-22 spec approved by Cooper):
 *   - Default state: COLLAPSED. User opts in to expand.
 *   - Closed pill button: glass style + "What's happening right now?" + chevron
 *   - Open: smooth height transition (~250ms), list of phases in glass card
 *   - Each phase row: orb (8x8) + label. Orb vocabulary matches the main
 *     5-step list — green check (done), orange pulsing (active), gray glass
 *     (pending). check-bounce 600ms when a phase flips to done.
 *   - Colors / fonts: existing brand vocabulary.
 *   - No sensitive info exposed (no IPs, no internal route names).
 */

import { useState, useEffect, useRef } from "react";
import { Check, ChevronDown } from "lucide-react";

// Existing glass style on /deploying — repeated here verbatim so the
// accordion matches without importing from the page (clean component boundary).
const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255,255,255,0.5), rgba(255,255,255,0.65), rgba(255,255,255,0.5))",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  boxShadow:
    "rgba(255,255,255,0.4) 0px -1px 1px 0px inset, rgba(0,0,0,0.04) 0px 1px 2px 0px inset, rgba(0,0,0,0.06) 0px 2px 4px -1px",
} as const;

export type PhaseStatus = "done" | "active" | "pending";

export interface PhaseDef {
  /** Stable id (for keys + animation tracking). */
  id: string;
  /** User-facing copy. Must be friendly, non-technical, premium tone. */
  label: string;
  /**
   * Predicate that decides whether this phase is `done`. Receives the live
   * vm state from /api/vm/status (camelCase) plus the current pollCount.
   * Time-based phases use pollCount as a fallback when no real signal exists.
   */
  isDone: (state: PhaseState) => boolean;
}

export interface PhaseState {
  /** /api/vm/status `status` field (e.g., "pending" / "assigned"). */
  status?: string | null;
  /** /api/vm/status `vm.healthStatus` (e.g., "healthy"). */
  healthStatus?: string | null;
  /** /api/vm/status `vm.gatewayUrl` (set once the gateway is configured + reachable). */
  gatewayUrl?: string | null;
  /** /api/vm/status `vm.telegramBotUsername` (set at row INSERT). */
  telegramBotUsername?: string | null;
  /** Seconds since the page started polling. Drives time-based progression. */
  pollCount: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Phase configurations
// ───────────────────────────────────────────────────────────────────────────

/**
 * Pool path — pool VMs are pre-warmed. The whole flow is typically <30s,
 * so phase descriptions are simple and signals are mostly real-time (no
 * heavy time-based fallback needed).
 */
export const POOL_PHASES: PhaseDef[] = [
  {
    id: "claim",
    label: "Claiming your reserved server",
    // Pool path: as soon as we have an assigned VM, the claim is done.
    isDone: (s) => s.status === "assigned",
  },
  {
    id: "personalize",
    label: "Personalizing your agent",
    // Pool configure writes gatewayUrl when done.
    isDone: (s) => !!s.gatewayUrl,
  },
  {
    id: "telegram",
    label: "Connecting to Telegram",
    // Telegram bot username is set at row INSERT, so for pool this completes
    // alongside the personalize phase. We require both (gatewayUrl + username)
    // so the user sees them flip in a coherent order.
    isDone: (s) => !!s.gatewayUrl && !!s.telegramBotUsername,
  },
  {
    id: "checks",
    label: "Running final checks",
    isDone: (s) => s.healthStatus === "healthy",
  },
];

/**
 * Cloud-init path — slower (~5-10 min). Friendlier, more detailed phases.
 * Intermediate phases (2-3) have no direct backend signal — they use
 * pollCount-based progression with sensible defaults derived from
 * vm-1019's observed timeline (T+~150s ip, T+~270s tarball, T+~580s ready).
 *
 * Phase 4 ("Connecting to Telegram") uses gatewayUrl as the proxy signal
 * per Cooper's approval — §1.33 (commit 18d9a86f) makes the cloud-init
 * callback fire ONLY after [telegram] starting provider, so by the time
 * gatewayUrl is set in DB, telegram polling has confirmedly started.
 */
export const CLOUD_INIT_PHASES: PhaseDef[] = [
  {
    id: "spinup",
    label: "Spinning up your dedicated cloud server",
    // Server provisioning is "in progress" the moment the VM row exists at
    // status='pending' or 'provisioning'. Done once we have an assigned-and-
    // post-boot signal: real-signal-first via the assignedAt-fields would
    // require more plumbing, so we use a generous time fallback that aligns
    // with the Linode-boot p99 (~150s) AND the "real" early signal of any
    // gateway URL present.
    isDone: (s) => s.pollCount > 150 || !!s.gatewayUrl,
  },
  {
    id: "brain",
    label: "Installing your agent's brain",
    // setup.sh tarball + openclaw install. Time-based fallback p99 ~300s,
    // real-signal short-circuit if gateway is up.
    isDone: (s) => s.pollCount > 300 || !!s.gatewayUrl,
  },
  {
    id: "personality",
    label: "Loading personality and memory systems",
    // Configure complete = gateway running + ready. p99 ~450s.
    isDone: (s) => s.pollCount > 450 || !!s.gatewayUrl,
  },
  {
    id: "telegram",
    label: "Connecting to Telegram",
    // §1.33 wait ensures gatewayUrl is set ONLY after telegram polling is
    // confirmed active. So gatewayUrl is a reliable proxy.
    isDone: (s) => !!s.gatewayUrl,
  },
  {
    id: "checks",
    label: "Running final health checks",
    isDone: (s) => s.healthStatus === "healthy",
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Status derivation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Returns the status for each phase. Exactly ONE phase is "active" at any
 * time — the first one that isn't done yet. All earlier phases are done,
 * all later phases are pending. This produces the "mission control"
 * progression Cooper specified.
 *
 * Edge case: if all phases are done (terminal state), they all read done
 * and no phase is active — which is correct.
 */
function derivePhaseStatuses(phases: PhaseDef[], state: PhaseState): PhaseStatus[] {
  const results: PhaseStatus[] = [];
  let activeAssigned = false;
  for (const phase of phases) {
    if (phase.isDone(state)) {
      results.push("done");
    } else if (!activeAssigned) {
      results.push("active");
      activeAssigned = true;
    } else {
      results.push("pending");
    }
  }
  return results;
}

// ───────────────────────────────────────────────────────────────────────────
// Phase row (orb + label)
// ───────────────────────────────────────────────────────────────────────────

function PhaseRow({
  label,
  status,
  justFlipped,
}: {
  label: string;
  status: PhaseStatus;
  justFlipped: boolean;
}) {
  const labelColor =
    status === "done" ? "#444444" : status === "active" ? "#666666" : "#999999";

  return (
    <div
      className="flex items-center gap-3 py-2.5"
      style={{ minHeight: "32px" }}
    >
      <div className="w-6 h-6 flex items-center justify-center flex-shrink-0">
        {status === "done" && (
          <div className={justFlipped ? "check-bounce" : ""}>
            <span
              className="relative flex items-center justify-center w-5 h-5 rounded-full overflow-hidden"
              style={{
                background:
                  "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.6), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
                boxShadow:
                  "rgba(34,197,94,0.3) 0px 2px 6px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
              }}
            >
              <span
                className="absolute inset-0 rounded-full pointer-events-none"
                style={{
                  background:
                    "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                }}
              />
              <Check
                className="relative"
                style={{ color: "#ffffff", width: "10px", height: "10px" }}
                strokeWidth={3.5}
              />
            </span>
          </div>
        )}
        {status === "active" && (
          <span
            className="relative flex items-center justify-center w-5 h-5 rounded-full overflow-hidden active-dot"
            style={{
              background:
                "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)",
              boxShadow:
                "rgba(220,103,67,0.3) 0px 2px 6px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
            }}
          >
            <span
              className="absolute inset-0 rounded-full pointer-events-none"
              style={{
                background:
                  "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
              }}
            />
          </span>
        )}
        {status === "pending" && (
          <span
            className="flex items-center justify-center w-5 h-5 rounded-full"
            style={{
              ...glassStyle,
              opacity: 0.5,
            }}
          />
        )}
      </div>
      <span
        className="text-sm transition-colors duration-300"
        style={{ color: labelColor }}
      >
        {label}
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Main accordion
// ───────────────────────────────────────────────────────────────────────────

export interface DeployingPhaseAccordionProps {
  phases: PhaseDef[];
  state: PhaseState;
}

export function DeployingPhaseAccordion({
  phases,
  state,
}: DeployingPhaseAccordionProps) {
  const [open, setOpen] = useState(false);
  const statuses = derivePhaseStatuses(phases, state);

  // Track which phases JUST flipped to done so we can play the check-bounce
  // animation once (and only once) per completion.
  const prevStatusesRef = useRef<PhaseStatus[]>(statuses);
  const [justFlipped, setJustFlipped] = useState<Set<string>>(new Set());

  useEffect(() => {
    const newlyFlipped = new Set<string>();
    phases.forEach((phase, i) => {
      if (statuses[i] === "done" && prevStatusesRef.current[i] !== "done") {
        newlyFlipped.add(phase.id);
      }
    });
    if (newlyFlipped.size > 0) {
      setJustFlipped((prev) => new Set([...prev, ...newlyFlipped]));
      const timer = setTimeout(() => {
        setJustFlipped((prev) => {
          const next = new Set(prev);
          newlyFlipped.forEach((id) => next.delete(id));
          return next;
        });
      }, 600);
      return () => clearTimeout(timer);
    }
    prevStatusesRef.current = statuses;
  }, [statuses, phases]);

  // Always keep the previous statuses in sync for next render.
  useEffect(() => {
    prevStatusesRef.current = statuses;
  });

  return (
    <div className="w-full">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium transition-all cursor-pointer"
        style={{
          ...glassStyle,
          color: "#666666",
        }}
        aria-expanded={open}
        aria-controls="deploying-phase-accordion-body"
      >
        <span>What&apos;s happening right now?</span>
        <ChevronDown
          className="transition-transform duration-200"
          style={{
            width: "14px",
            height: "14px",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
          strokeWidth={2}
        />
      </button>

      {/* Smooth height transition via grid-rows trick (no JS height measurement) */}
      <div
        id="deploying-phase-accordion-body"
        className="grid transition-all duration-250 ease-out"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          marginTop: open ? "12px" : "0px",
        }}
      >
        <div className="overflow-hidden">
          <div
            className="rounded-lg p-5"
            style={glassStyle}
          >
            {phases.map((phase, i) => (
              <div
                key={phase.id}
                style={{
                  borderBottom:
                    i < phases.length - 1 ? "1px solid rgba(0,0,0,0.05)" : "none",
                }}
              >
                <PhaseRow
                  label={phase.label}
                  status={statuses[i]}
                  justFlipped={justFlipped.has(phase.id)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
