/**
 * lib/bake/step-spec.ts — Type definitions for the autonomous bake orchestrator.
 *
 * Defines the BakeStep abstraction (a single unit of work with pre/post
 * conditions + rollback), BakePhase (the state machine's named states),
 * BakeState (persisted across the run, supports --action=resume), and
 * Verification (the reusable check primitive).
 *
 * Per design doc `docs/prd/autonomous-bake-system-design-2026-05-19.md` §2.3.
 *
 * No runtime logic in this file — pure types. Importing this file should
 * not execute any code or import any heavy dependencies. That keeps the
 * orchestrator's startup fast.
 */

// ─── State machine phases ────────────────────────────────────────────────────

/**
 * The orchestrator advances through these phases in order. Each phase
 * contains one or more BakeSteps. State persistence happens after every
 * step transition.
 */
export type BakePhase =
  | "preflight"           // gate checks — abort BEFORE provisioning if anything fails
  | "provision"           // create Linode bake VM, wait for SSH ready
  | "upgrade-os"          // OpenClaw + apt + nodejs-pin
  | "reconcile"           // auditVMConfig (50+ reconciler steps)
  | "gbrain-install"      // install-gbrain.sh Phase A-I
  | "checkpoint-verify"   // §3.5.5 — Phase C2 patch + Phase I cron + ExecStop + trial CHECKPOINT
  | "v102-verify"         // §2.6 — GBRAIN_MEMORY_PROTOCOL_V1 marker in AGENTS.md
  | "strip-bearer"        // §3.6 — strip per-VM bearer + disable service
  | "cleanup"             // _prebake-cleanup.sh --confirm
  | "validate"            // _postbake-validation.ts --mode=bake
  | "disk-check"          // verify disk < 5,900 MB
  | "imagize"             // shutdown + create_image + poll status=available
  | "soak"                // provision test VM from new snapshot, reconcile, validate, destroy
  | "report";             // print summary + Cooper-action commands

/** All phases in canonical execution order. The orchestrator iterates this. */
export const BAKE_PHASES_IN_ORDER: ReadonlyArray<BakePhase> = [
  "preflight",
  "provision",
  "upgrade-os",
  "reconcile",
  "gbrain-install",
  "checkpoint-verify",
  "v102-verify",
  "strip-bearer",
  "cleanup",
  "validate",
  "disk-check",
  "imagize",
  "soak",
  "report",
];

// ─── Severity classification ─────────────────────────────────────────────────

/**
 * Failure severity. P0 aborts the bake. P1 logs a warning but continues.
 * P2 is informational only.
 *
 * Mirrors the convention in `_postbake-validation.ts` and CLAUDE.md Rule 39.
 */
export type Severity = "P0" | "P1" | "P2";

// ─── Verifications (pre/post-condition checks) ───────────────────────────────

/**
 * A single check. Idempotent and side-effect-free.
 *
 * The orchestrator runs a step's preconditions BEFORE its action; postconditions
 * AFTER. Any P0 failure aborts the step. P1/P2 are collected into the BakeState
 * and surfaced in the final report.
 */
export interface Verification {
  /** Stable identifier; used in logs and state. Kebab-case. */
  id: string;
  /** Failure severity. */
  severity: Severity;
  /** Human-readable description (printed in the bake log). */
  description: string;
  /**
   * Returns ok=true on pass, ok=false on fail. detail is logged regardless.
   * Should NOT throw — wrap errors with try/catch and return ok:false instead.
   *
   * `ctx` carries the live state + side-channel helpers (SSH, Linode API, etc.).
   * Verifications use these to inspect remote state without each one
   * having to redo connection setup.
   */
  check: (ctx: BakeContext) => Promise<{ ok: boolean; detail: string }>;
  /**
   * Human-facing hint to display when the check fails. Should tell the
   * operator what to do next (or which manual recovery to attempt).
   *
   * Convention: prefix with "TRY:" for actions, "WHY:" for context.
   */
  remediation?: string;
}

/** Result of running a single verification. */
export interface VerificationResult {
  id: string;
  severity: Severity;
  ok: boolean;
  detail: string;
  remediation?: string;
  elapsed_ms: number;
}

// ─── Steps (the atomic units of bake work) ───────────────────────────────────

/**
 * A single bake step. Steps have:
 *   1. Preconditions — must pass before action runs
 *   2. Action — the actual work (idempotent)
 *   3. Postconditions — must pass after action returns
 *   4. Rollback — undo the action's side effects
 *
 * Steps SHOULD be idempotent (safe to re-run on resume). The orchestrator
 * makes no special-case effort to skip "already-done" steps — instead it
 * relies on the action being a no-op when state is already correct.
 */
export interface BakeStep {
  /** Stable identifier. Kebab-case. Used in state file and logs. */
  id: string;
  /** Which phase this step belongs to. */
  phase: BakePhase;
  /** Human-readable description (printed when the step starts). */
  description: string;
  /**
   * Estimated wall-clock duration in seconds. Used for:
   *   - Showing progress estimate to the operator
   *   - Timing out runaway steps (action exceeds 3× estimate → abort)
   */
  estimated_seconds: number;
  /** Whether the action's side effects can be safely undone. */
  retryable: boolean;
  /** Operator-facing recovery instructions if the step fails permanently. */
  recovery_hint: string;
  /** Checks that must pass before action runs. Empty array = no preconditions. */
  preconditions: Verification[];
  /**
   * The actual work. Should be idempotent. Returns a StepResult.
   * Throwing is acceptable — the orchestrator catches and treats it as a P0 failure.
   */
  action: (ctx: BakeContext) => Promise<StepResult>;
  /** Checks that must pass after action returns. */
  postconditions: Verification[];
  /**
   * Undo the action's side effects. Only called on failure paths.
   * Should be idempotent (safe to re-run if rollback itself fails).
   * Pre-imagize steps should fully reverse (destroy bake VM); post-imagize
   * steps should NOT destroy state that the operator might want to inspect.
   */
  rollback: (ctx: BakeContext) => Promise<void>;
}

/** Result of running a step's action. */
export interface StepResult {
  /** Did the action complete successfully (before postcondition checks). */
  ok: boolean;
  /** Lines of action-specific output. Captured into the bake log. */
  output: string[];
  /** Optional state mutations the action wants to record. */
  state_updates?: Partial<BakeState>;
  /** Optional warnings the action wants to surface. */
  warnings?: string[];
}

// ─── State (persisted to disk, supports --action=resume) ─────────────────────

/**
 * The full state of a bake run. Written to ~/.bake-state/<run-id>/state.json
 * after every step transition. On resume, the orchestrator reads this and
 * picks up from `current_phase` + `current_step_id`.
 *
 * Atomic write (tmp + rename, per CLAUDE.md Rule 22) prevents corruption
 * on Ctrl-C.
 */
export interface BakeState {
  /** ISO-8601 timestamp when this run started. Also the run-id basename. */
  run_id: string;
  /** When the run started. */
  started_at: string;
  /** Last state update. */
  updated_at: string;
  /** Current phase. */
  current_phase: BakePhase;
  /** Step id within the current phase. */
  current_step_id: string;
  /** Overall status. */
  status: "running" | "succeeded" | "failed" | "rolled_back" | "stalled";

  /** Bake-from snapshot (`LINODE_SNAPSHOT_ID` at run start). */
  source_snapshot_id: string;

  /** The bake VM (set after provision). */
  bake_vm: {
    linode_id: number | null;
    ip_address: string | null;
    label: string;
    region: string;
    type: string;
  };

  /** Synthetic VM record (set during reconcile; cleaned in rollback). */
  synthetic_vm: {
    inserted: boolean;
    id: string;
  };

  /** Reconcile-fleet cron lock state. */
  cron_lock: {
    acquired: boolean;
    acquired_at: string | null;
  };

  /** Source pins captured at preflight. Frozen for the run's duration. */
  source_pins: {
    gbrain_commit: string;
    gbrain_version: string;
    manifest_version: number;
    openclaw_pinned_version: string | null;
    node_version: string | null;
    bootstrap_max_chars: number;
    secret_version: number | null;
  };

  /** v106 detection result. */
  v106_path: "A" | "B" | null;

  /** New snapshot created during imagize. */
  new_snapshot: {
    image_id: string | null;
    label: string | null;
    size_mb: number | null;
    created_at: string | null;
  };

  /** Soak VM (provisioned from new snapshot during soak phase). */
  soak_vm: {
    linode_id: number | null;
    ip_address: string | null;
    label: string | null;
  };

  /** Per-step results — id → outcome. */
  step_results: Record<
    string,
    {
      status: "pending" | "running" | "succeeded" | "failed" | "skipped";
      started_at: string | null;
      completed_at: string | null;
      output: string[];
      precondition_results: VerificationResult[];
      postcondition_results: VerificationResult[];
      error: string | null;
    }
  >;

  /** P0 errors collected (any of these aborts the bake). */
  errors: string[];
  /** P1 warnings collected (non-fatal). */
  warnings: string[];
  /** P2 notes collected (informational). */
  notes: string[];

  /** Operator-facing recommendations (output by report step). */
  cooper_actions: string[];

  /** Drift detection findings (compared against last-bake-fingerprint). */
  drift: {
    new_env_vars: string[];
    changed_pins: Array<{ name: string; old: string; new: string }>;
    reconciler_hash_changed: boolean;
    last_bake_hash: string | null;
    current_hash: string | null;
  };

  /** Estimated cost in USD (for cost-cap protection). */
  estimated_cost_usd: number;

  /** Total wall-clock duration in seconds. */
  elapsed_seconds: number;
}

// ─── Context (carried through step execution) ────────────────────────────────

/**
 * Mutable execution context passed to every step's action + verifications.
 * Holds open connections, the current state, the log writer.
 *
 * Steps SHOULD mutate `state` via the return value of their action
 * (`StepResult.state_updates`), not by direct mutation. The orchestrator
 * handles persistence.
 */
export interface BakeContext {
  /** Reference to current state. Steps treat this as read-only. */
  state: BakeState;
  /**
   * Append a line to the bake log. Steps use this for human-readable
   * progress + diagnostic output. Lines are prefixed with timestamp + step id.
   */
  log: (line: string) => void;
  /** Working directory for the orchestrator (typically instaclaw/). */
  repo_root: string;
  /** Path to the state directory for this run. */
  state_dir: string;
  /** Path to the bake log file for this run. */
  log_path: string;
  /** Dry-run mode — actions should log what they WOULD do but not mutate. */
  dry_run: boolean;
  /** --auto-confirm — skip interactive prompts. */
  auto_confirm: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format an elapsed millisecond count as "1m23s" or "42s". */
export function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** Symbol prefix for stdout. */
export const SEV_SYMBOL: Record<Severity, string> = {
  P0: "✗",
  P1: "⚠",
  P2: "·",
};

/** Default empty state — used at run start. */
export function emptyState(run_id: string, source_snapshot_id: string): BakeState {
  const now = new Date().toISOString();
  return {
    run_id,
    started_at: now,
    updated_at: now,
    current_phase: "preflight",
    current_step_id: "",
    status: "running",
    source_snapshot_id,
    bake_vm: {
      linode_id: null,
      ip_address: null,
      label: "",
      region: "us-east",
      // 2026-05-29: switched g6-nanode-1 → g6-dedicated-2 to match the production
      // fleet hardware class. The nanode's $5/mo shared CPU has highly variable
      // I/O under contention (empirically: gbrain init --pglite measured 11s-118s
      // across 5 fresh us-east nanodes, and bake attempts #5 + #6 timed out at the
      // script's 60s hard limit). Production VMs run g6-dedicated-2 ($29/mo
      // dedicated 2 vCPU); baking on the same class guarantees the snapshot's
      // install steps run under representative I/O conditions. Bake VM lives ~30
      // min so the price delta is ~$0.025 vs ~$0.004 — negligible vs the cost of
      // shipping a snapshot that was built on inferior hardware than it deploys to.
      type: "g6-dedicated-2",
    },
    synthetic_vm: { inserted: false, id: "" },
    cron_lock: { acquired: false, acquired_at: null },
    source_pins: {
      gbrain_commit: "",
      gbrain_version: "",
      manifest_version: 0,
      openclaw_pinned_version: null,
      node_version: null,
      bootstrap_max_chars: 40000,
      secret_version: null,
    },
    v106_path: null,
    new_snapshot: { image_id: null, label: null, size_mb: null, created_at: null },
    soak_vm: { linode_id: null, ip_address: null, label: null },
    step_results: {},
    errors: [],
    warnings: [],
    notes: [],
    cooper_actions: [],
    drift: {
      new_env_vars: [],
      changed_pins: [],
      reconciler_hash_changed: false,
      last_bake_hash: null,
      current_hash: null,
    },
    estimated_cost_usd: 0,
    elapsed_seconds: 0,
  };
}
