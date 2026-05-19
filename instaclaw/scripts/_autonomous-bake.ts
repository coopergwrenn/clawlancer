/**
 * scripts/_autonomous-bake.ts — Autonomous snapshot bake orchestrator.
 *
 * Cooper's vision: "bake a snapshot" is fire-and-forget. This script
 * handles the full pipeline: preflight → provision → upgrade-os → reconcile →
 * gbrain-install → checkpoint-verify → v102-verify → strip-bearer → cleanup →
 * validate → disk-check → imagize → soak → report.
 *
 * Per design doc `docs/prd/autonomous-bake-system-design-2026-05-19.md`.
 *
 * State persisted to ~/.bake-state/runs/<run-id>/. Resume after failure
 * with --action=resume <run-id>.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/_autonomous-bake.ts                       # full bake
 *   npx tsx scripts/_autonomous-bake.ts --action=preflight    # just preflight
 *   npx tsx scripts/_autonomous-bake.ts --action=dry-run      # simulate
 *   npx tsx scripts/_autonomous-bake.ts --action=resume <id>  # resume failed
 *   npx tsx scripts/_autonomous-bake.ts --action=status <id>  # print state
 *   npx tsx scripts/_autonomous-bake.ts --action=list         # recent runs
 *   npx tsx scripts/_autonomous-bake.ts --action=rollback <id> # destroy
 *
 *   --auto-confirm       skip interactive prompts (for CI)
 *   --skip-soak          skip the soak phase (faster but riskier)
 *   --bake-from=<id>     override LINODE_SNAPSHOT_ID
 *   --region=us-east     Linode region
 *
 * ── Exit codes ───────────────────────────────────────────────────────────
 *
 *   0 — bake succeeded; new snapshot ready for cutover
 *   1 — bake failed; check state file for details
 *   2 — preflight failed (didn't provision)
 *   3 — CLI arg error
 *   4 — global lock held by another run
 *   5 — resume target not found
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";

// Resolve repo root before any imports that read source files.
const __dirname_local =
  typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname_local, "..");

// Eager env load — must happen before importing any module that reads process.env at import time.
import { loadBakeEnv } from "../lib/bake/env-loader";
loadBakeEnv(REPO_ROOT);

import {
  emptyState,
  formatElapsed,
  type BakeContext,
  type BakeState,
  type BakeStep,
  BAKE_PHASES_IN_ORDER,
} from "../lib/bake/step-spec";
import {
  acquireGlobalBakeLock,
  appendLog,
  getLogPath,
  getStateDir,
  initRun,
  latestRun,
  listRuns,
  loadState,
  markStaleIfNeeded,
  persistState,
  releaseGlobalBakeLock,
} from "../lib/bake/state";
import { buildAllSteps } from "../lib/bake/steps";
import { runVerifications } from "../lib/bake/verifications";

// ─── CLI parsing ─────────────────────────────────────────────────────────────

type Action = "full" | "preflight" | "dry-run" | "resume" | "status" | "list" | "rollback";

interface CLIArgs {
  action: Action;
  run_id?: string;
  auto_confirm: boolean;
  skip_soak: boolean;
  bake_from?: string;
  region: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): CLIArgs {
  const out: CLIArgs = {
    action: "full",
    auto_confirm: false,
    skip_soak: false,
    region: "us-east",
    verbose: false,
  };
  // Trailing positional after a known flag is treated as run_id where applicable.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--action=")) {
      out.action = a.slice("--action=".length) as Action;
    } else if (a === "--auto-confirm") {
      out.auto_confirm = true;
    } else if (a === "--skip-soak") {
      out.skip_soak = true;
    } else if (a.startsWith("--bake-from=")) {
      out.bake_from = a.slice("--bake-from=".length);
    } else if (a.startsWith("--region=")) {
      out.region = a.slice("--region=".length);
    } else if (a === "--verbose" || a === "-v") {
      out.verbose = true;
    } else if (!a.startsWith("--")) {
      out.run_id = a;
    }
  }
  return out;
}

function usage(): never {
  console.error(
    `Usage: npx tsx scripts/_autonomous-bake.ts [--action=full|preflight|dry-run|resume|status|list|rollback] [run-id]
                                              [--auto-confirm] [--skip-soak] [--bake-from=<snapshot>] [--region=us-east]

Default action: full

See header comment for exit codes and detailed examples.
`,
  );
  process.exit(3);
}

// ─── Logging helpers ─────────────────────────────────────────────────────────

function makeLogger(run_id: string, verbose: boolean): (line: string, step_id?: string) => void {
  return (line, step_id = "orch") => {
    appendLog(run_id, line, step_id);
    if (verbose || step_id === "orch") {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  };
}

function printBanner(state: BakeState): void {
  // eslint-disable-next-line no-console
  console.log("══════════════════════════════════════════════════════════════");
  // eslint-disable-next-line no-console
  console.log(`  Autonomous Bake — run ${state.run_id}`);
  // eslint-disable-next-line no-console
  console.log(`  source: ${state.source_snapshot_id}`);
  // eslint-disable-next-line no-console
  console.log(`  state:  ~/.bake-state/runs/${state.run_id}/`);
  // eslint-disable-next-line no-console
  console.log("══════════════════════════════════════════════════════════════");
}

// ─── Step runner ─────────────────────────────────────────────────────────────

/**
 * Run a single step against a context. Captures pre/post-condition results,
 * runs the action, returns success/failure. State is persisted after every
 * call (action or verification).
 */
/**
 * In dry-run mode, every step EXCEPT these phases gets its action skipped.
 * Preflight reads source (no side effects). Report just prints to stdout.
 * Everything else (provision, reconcile, install, imagize, soak, etc.)
 * mutates external state — Linode VMs, SSH targets, Vercel env — so the
 * orchestrator stubs them out in dry-run.
 */
const SAFE_PHASES_IN_DRY_RUN: ReadonlySet<string> = new Set(["preflight"]);

async function runStep(
  step: BakeStep,
  ctx: BakeContext,
  logFn: (line: string, step_id?: string) => void,
): Promise<{ ok: boolean; abort: boolean }> {
  const state = ctx.state;
  const now = new Date().toISOString();
  state.current_phase = step.phase;
  state.current_step_id = step.id;
  state.step_results[step.id] = state.step_results[step.id] ?? {
    status: "pending",
    started_at: null,
    completed_at: null,
    output: [],
    precondition_results: [],
    postcondition_results: [],
    error: null,
  };
  state.step_results[step.id].status = "running";
  state.step_results[step.id].started_at = now;
  persistState(state);

  logFn("", step.id);
  logFn(`▶ [${step.phase}] ${step.id}: ${step.description}`, step.id);

  // Dry-run short-circuit. Steps in non-safe phases skip their action entirely.
  // Their preconditions still run — those are read-only and tell the operator
  // whether the step WOULD have proceeded.
  if (ctx.dry_run && !SAFE_PHASES_IN_DRY_RUN.has(step.phase)) {
    const preResults = await runVerifications(step.preconditions, ctx);
    state.step_results[step.id].precondition_results = preResults;
    for (const r of preResults) {
      const sym = r.ok ? "✓" : r.severity === "P0" ? "✗" : r.severity === "P1" ? "⚠" : "·";
      logFn(`  ${sym} pre [${r.severity}] ${r.id} ${r.detail ? `(${r.detail})` : ""}`, step.id);
    }
    logFn(
      `  ↻ dry-run skip: ${step.description} (would take ~${step.estimated_seconds}s)`,
      step.id,
    );
    state.step_results[step.id].status = "skipped";
    state.step_results[step.id].output = [
      `(dry-run skipped — would: ${step.description})`,
    ];
    state.step_results[step.id].completed_at = new Date().toISOString();
    persistState(state);
    return { ok: true, abort: false };
  }

  // Pre-conditions
  const preResults = await runVerifications(step.preconditions, ctx);
  state.step_results[step.id].precondition_results = preResults;
  for (const r of preResults) {
    const sym = r.ok ? "✓" : r.severity === "P0" ? "✗" : r.severity === "P1" ? "⚠" : "·";
    logFn(`  ${sym} pre [${r.severity}] ${r.id} ${r.detail ? `(${r.detail})` : ""}`, step.id);
    if (!r.ok && r.severity === "P0") {
      const msg = `precondition failed: ${r.id}: ${r.detail}`;
      state.step_results[step.id].status = "failed";
      state.step_results[step.id].error = msg;
      state.step_results[step.id].completed_at = new Date().toISOString();
      state.errors.push(`${step.id}: ${msg}`);
      persistState(state);
      logFn(`  ABORT: ${msg}`, step.id);
      if (r.remediation) logFn(`    ${r.remediation}`, step.id);
      return { ok: false, abort: true };
    } else if (!r.ok && r.severity === "P1") {
      state.warnings.push(`${step.id} pre: ${r.id}: ${r.detail}`);
    } else if (!r.ok && r.severity === "P2") {
      state.notes.push(`${step.id} pre: ${r.id}: ${r.detail}`);
    }
  }
  persistState(state);

  // Action
  const startMs = Date.now();
  let actionResult: { ok: boolean; output: string[]; state_updates?: Partial<BakeState>; warnings?: string[] } | null = null;
  let actionError: Error | null = null;

  // Timeout: 3× estimated_seconds, with a 1 hour minimum for long steps.
  const timeoutMs = Math.max(step.estimated_seconds * 3 * 1000, 60 * 60 * 1000);
  try {
    actionResult = await Promise.race([
      step.action(ctx),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`step timeout after ${formatElapsed(timeoutMs)}`)), timeoutMs),
      ),
    ]);
  } catch (e) {
    actionError = e as Error;
  }
  const actionMs = Date.now() - startMs;

  if (actionError) {
    state.step_results[step.id].status = "failed";
    state.step_results[step.id].error = actionError.message;
    state.step_results[step.id].completed_at = new Date().toISOString();
    state.errors.push(`${step.id}: ${actionError.message}`);
    persistState(state);
    logFn(`  ✗ action threw: ${actionError.message}`, step.id);
    logFn(`    recovery: ${step.recovery_hint}`, step.id);
    return { ok: false, abort: true };
  }

  if (!actionResult!.ok) {
    state.step_results[step.id].status = "failed";
    state.step_results[step.id].output = actionResult!.output;
    state.step_results[step.id].error = actionResult!.output.find((l) => l.startsWith("FAIL:")) ?? "action returned ok=false";
    state.step_results[step.id].completed_at = new Date().toISOString();
    state.errors.push(`${step.id}: ${state.step_results[step.id].error}`);
    for (const line of actionResult!.output) logFn(line, step.id);
    logFn(`  ✗ action failed (${formatElapsed(actionMs)})`, step.id);
    logFn(`    recovery: ${step.recovery_hint}`, step.id);
    persistState(state);
    return { ok: false, abort: true };
  }

  // Action succeeded — apply state updates.
  //
  // CRITICAL: array fields on BakeState (warnings, errors, notes,
  // cooper_actions) must be APPENDED across steps, not replaced. Using
  // Object.assign() naively would overwrite e.g. `state.warnings` if a
  // step returns `{ warnings: [...] }` in its state_updates, dropping all
  // warnings from prior steps. Discovered live during preflight 2026-05-19.
  for (const line of actionResult!.output) logFn(line, step.id);
  if (actionResult!.state_updates) {
    const APPEND_ARRAY_FIELDS = new Set([
      "warnings",
      "errors",
      "notes",
      "cooper_actions",
    ]);
    for (const [k, v] of Object.entries(actionResult!.state_updates)) {
      if (APPEND_ARRAY_FIELDS.has(k) && Array.isArray(v) && Array.isArray((state as any)[k])) {
        // Prefix array entries with step.id so the operator can trace the source
        const prefixed = v.map((entry) =>
          typeof entry === "string" ? `${step.id}: ${entry}` : entry,
        );
        (state as any)[k].push(...prefixed);
      } else {
        (state as any)[k] = v;
      }
    }
  }
  // Top-level StepResult.warnings field (kept for backward compat; same append semantics)
  if (actionResult!.warnings) {
    state.warnings.push(...actionResult!.warnings.map((w) => `${step.id}: ${w}`));
    for (const w of actionResult!.warnings) logFn(`  ⚠ ${w}`, step.id);
  }
  state.step_results[step.id].output = actionResult!.output;
  persistState(state);

  // Post-conditions
  const postResults = await runVerifications(step.postconditions, ctx);
  state.step_results[step.id].postcondition_results = postResults;
  for (const r of postResults) {
    const sym = r.ok ? "✓" : r.severity === "P0" ? "✗" : r.severity === "P1" ? "⚠" : "·";
    logFn(`  ${sym} post [${r.severity}] ${r.id} ${r.detail ? `(${r.detail})` : ""}`, step.id);
    if (!r.ok && r.severity === "P0") {
      const msg = `postcondition failed: ${r.id}: ${r.detail}`;
      state.step_results[step.id].status = "failed";
      state.step_results[step.id].error = msg;
      state.step_results[step.id].completed_at = new Date().toISOString();
      state.errors.push(`${step.id}: ${msg}`);
      persistState(state);
      logFn(`  ABORT: ${msg}`, step.id);
      return { ok: false, abort: true };
    } else if (!r.ok && r.severity === "P1") {
      state.warnings.push(`${step.id} post: ${r.id}: ${r.detail}`);
    }
  }

  state.step_results[step.id].status = "succeeded";
  state.step_results[step.id].completed_at = new Date().toISOString();
  persistState(state);
  logFn(`  ✓ done (${formatElapsed(actionMs)})`, step.id);
  return { ok: true, abort: false };
}

// ─── Rollback ────────────────────────────────────────────────────────────────

async function runRollback(steps: BakeStep[], ctx: BakeContext, logFn: (line: string, step_id?: string) => void): Promise<void> {
  // Iterate steps in REVERSE — undo most-recent first.
  const reversedSteps = [...steps].reverse();
  for (const step of reversedSteps) {
    const sr = ctx.state.step_results[step.id];
    if (!sr) continue; // step never ran
    if (sr.status === "succeeded" || sr.status === "failed" || sr.status === "running") {
      try {
        await step.rollback(ctx);
      } catch (e) {
        logFn(`  rollback ${step.id} failed: ${(e as Error).message}`, "rollback");
      }
    }
  }
  ctx.state.status = "rolled_back";
  persistState(ctx.state);
}

// ─── Action handlers ─────────────────────────────────────────────────────────

async function actionFull(args: CLIArgs, dryRun = false): Promise<number> {
  // Validate source snapshot
  const sourceSnapshotId = args.bake_from ?? process.env.LINODE_SNAPSHOT_ID;
  if (!sourceSnapshotId) {
    console.error("LINODE_SNAPSHOT_ID not set; pass --bake-from=private/<id> or set in .env.local");
    return 3;
  }

  // Generate run id (ISO timestamp, filesystem-safe)
  const run_id = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const stateDir = initRun(run_id);
  const logPath = getLogPath(run_id);

  const lockResult = acquireGlobalBakeLock(run_id);
  if (!lockResult.acquired) {
    console.error(`Cannot acquire global bake lock: ${lockResult.reason}`);
    return 4;
  }

  const state = emptyState(run_id, sourceSnapshotId);
  state.bake_vm.region = args.region;
  persistState(state);

  const logFn = makeLogger(run_id, args.verbose);
  const ctx: BakeContext = {
    state,
    log: logFn,
    repo_root: REPO_ROOT,
    state_dir: stateDir,
    log_path: logPath,
    dry_run: dryRun,
    auto_confirm: args.auto_confirm,
  };

  printBanner(state);

  // Catch SIGINT for graceful shutdown
  let interrupted = false;
  const sigintHandler = () => {
    interrupted = true;
    logFn("SIGINT received — finishing current step then halting.");
  };
  process.on("SIGINT", sigintHandler);

  const allSteps = buildAllSteps();
  const steps = args.skip_soak
    ? allSteps.filter((s) => s.phase !== "soak")
    : allSteps;

  let aborted = false;
  for (const step of steps) {
    if (interrupted) {
      logFn("halted by SIGINT");
      aborted = true;
      break;
    }
    // In preflight-only mode, stop after the preflight phase.
    if (args.action === "preflight" && step.phase !== "preflight") break;
    const r = await runStep(step, ctx, logFn);
    if (r.abort) {
      aborted = true;
      break;
    }
  }

  process.off("SIGINT", sigintHandler);

  if (aborted) {
    state.status = "failed";
    persistState(state);
    printFinalSummary(state, /* aborted */ true, ctx.dry_run);
    if (!ctx.dry_run) {
      logFn("Initiating rollback...");
      await runRollback(steps, ctx, logFn);
    }
    releaseGlobalBakeLock();
    return 1;
  }

  state.status = "succeeded";
  persistState(state);
  releaseGlobalBakeLock();
  printFinalSummary(state, /* aborted */ false, ctx.dry_run);
  return 0;
}

/**
 * Print the operator-facing end-of-run summary. Goes to stdout regardless
 * of --verbose. Surfaces warnings + errors prominently so the 2am operator
 * doesn't miss them buried in the log.
 */
function printFinalSummary(state: BakeState, aborted: boolean, dry_run: boolean): void {
  const isPreflightOnly = state.current_phase === "preflight";
  const headline = aborted
    ? `❌ BAKE FAILED at phase=${state.current_phase} step=${state.current_step_id}`
    : isPreflightOnly
    ? `✓ PREFLIGHT PASSED${dry_run ? " (dry-run)" : ""}`
    : `✓ BAKE SUCCEEDED${dry_run ? " (dry-run)" : ""}`;

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${headline}`);
  console.log(`  run_id:   ${state.run_id}`);
  console.log(`  elapsed:  ${formatElapsed(state.elapsed_seconds * 1000)}`);
  console.log(`  errors:   ${state.errors.length}`);
  console.log(`  warnings: ${state.warnings.length}`);
  console.log(`  notes:    ${state.notes.length}`);
  console.log(`  state:    ~/.bake-state/runs/${state.run_id}/state.json`);
  console.log(`  log:      ~/.bake-state/runs/${state.run_id}/log.txt`);
  console.log("══════════════════════════════════════════════════════════════");

  if (state.errors.length > 0) {
    console.log("");
    console.log("ERRORS (P0 — these blocked the bake):");
    for (const e of state.errors) console.log(`  ✗ ${e}`);
    // Show the last-failed step's output + recovery hint inline, so the
    // operator doesn't have to dig into the state file at 2am.
    const failedStepId = state.current_step_id;
    const failedStep = state.step_results[failedStepId];
    if (failedStep && failedStep.output.length > 0) {
      console.log("");
      console.log(`Last output from ${failedStepId} (most recent ${Math.min(10, failedStep.output.length)} lines):`);
      for (const line of failedStep.output.slice(-10)) {
        console.log(`  │ ${line}`);
      }
    }
    // Step recovery hint from the step spec — pulled out of buildAllSteps()
    // via id match. This isn't persisted in state, so we re-derive at print time.
    const allSteps = buildAllSteps();
    const stepSpec = allSteps.find((s) => s.id === failedStepId);
    if (stepSpec?.recovery_hint) {
      console.log("");
      console.log(`Recovery hint: ${stepSpec.recovery_hint}`);
    }
    console.log("");
  }

  if (state.warnings.length > 0) {
    console.log("");
    console.log("WARNINGS (P1 — bake proceeded but review before next bake):");
    for (const w of state.warnings) console.log(`  ⚠ ${w}`);
    console.log("");
  }

  if (aborted) {
    console.log("Resume after fixing the underlying issue:");
    console.log(`  npx tsx scripts/_autonomous-bake.ts --action=resume ${state.run_id}`);
    console.log("");
    console.log("Or rollback (destroys any Linode resources, releases locks):");
    console.log(`  npx tsx scripts/_autonomous-bake.ts --action=rollback ${state.run_id}`);
    console.log("");
  } else if (!isPreflightOnly && state.new_snapshot.image_id) {
    console.log("");
    console.log("Cooper actions (paste-ready):");
    for (const c of state.cooper_actions) console.log(`  ${c}`);
    console.log("");
  } else if (isPreflightOnly && state.warnings.length === 0) {
    console.log("Preflight clean. Run full bake:");
    console.log(`  npx tsx scripts/_autonomous-bake.ts`);
    console.log("");
  } else if (isPreflightOnly) {
    console.log("Preflight passed with warnings. Review above. Then:");
    console.log(`  npx tsx scripts/_autonomous-bake.ts                  # ignore warnings, bake`);
    console.log(`  # OR — resolve the warnings first (see remediation in log), then re-run preflight`);
    console.log("");
  }
}

async function actionResume(args: CLIArgs): Promise<number> {
  const run_id = args.run_id;
  if (!run_id) {
    console.error("--action=resume requires a run-id argument");
    return 3;
  }
  if (!existsSync(getStateDir(run_id))) {
    console.error(`Run not found: ${run_id}`);
    return 5;
  }
  let state = loadState(run_id);
  state = markStaleIfNeeded(state);
  if (state.status === "succeeded" || state.status === "rolled_back") {
    console.error(`Cannot resume — status is ${state.status}`);
    return 5;
  }

  const lockResult = acquireGlobalBakeLock(run_id);
  if (!lockResult.acquired) {
    console.error(`Cannot acquire global bake lock: ${lockResult.reason}`);
    return 4;
  }

  state.status = "running";
  // Clear the failed status of the last-attempted step so we re-run it.
  if (state.current_step_id && state.step_results[state.current_step_id]?.status === "failed") {
    state.step_results[state.current_step_id].status = "pending";
    state.step_results[state.current_step_id].error = null;
  }
  // Clear the last error from the errors[] array so it doesn't block postcondition gating.
  state.errors = state.errors.filter((e) => !e.startsWith(`${state.current_step_id}:`));
  persistState(state);

  const stateDir = getStateDir(run_id);
  const logPath = getLogPath(run_id);
  const logFn = makeLogger(run_id, args.verbose);
  const ctx: BakeContext = {
    state,
    log: logFn,
    repo_root: REPO_ROOT,
    state_dir: stateDir,
    log_path: logPath,
    dry_run: false,
    auto_confirm: args.auto_confirm,
  };

  printBanner(state);
  logFn(`RESUMING from step ${state.current_step_id} (phase ${state.current_phase})`);

  const allSteps = buildAllSteps();
  const fromIdx = allSteps.findIndex((s) => s.id === state.current_step_id);
  if (fromIdx < 0) {
    console.error(`Cannot find step ${state.current_step_id} in current step list — maybe steps changed since last run.`);
    releaseGlobalBakeLock();
    return 5;
  }

  // Run from the failed step onward
  const steps = allSteps.slice(fromIdx);
  let aborted = false;
  for (const step of steps) {
    const r = await runStep(step, ctx, logFn);
    if (r.abort) {
      aborted = true;
      break;
    }
  }

  if (aborted) {
    state.status = "failed";
    persistState(state);
    logFn("BAKE FAILED again — DO NOT auto-rollback on resume (operator may want to inspect).");
    releaseGlobalBakeLock();
    return 1;
  }

  state.status = "succeeded";
  persistState(state);
  releaseGlobalBakeLock();
  logFn("BAKE SUCCEEDED");
  return 0;
}

function actionStatus(args: CLIArgs): number {
  const run_id = args.run_id ?? latestRun();
  if (!run_id) {
    console.error("No runs found.");
    return 5;
  }
  if (!existsSync(getStateDir(run_id))) {
    console.error(`Run not found: ${run_id}`);
    return 5;
  }
  const state = loadState(run_id);
  console.log(JSON.stringify(state, null, 2));
  return 0;
}

function actionList(): number {
  const runs = listRuns(20);
  console.log(`# Recent bake runs (newest first):`);
  for (const r of runs) {
    try {
      const s = loadState(r);
      console.log(`  ${r}  ${s.status.padEnd(11)}  phase=${s.current_phase}  step=${s.current_step_id}`);
    } catch {
      console.log(`  ${r}  (state unreadable)`);
    }
  }
  return 0;
}

async function actionRollback(args: CLIArgs): Promise<number> {
  const run_id = args.run_id ?? latestRun();
  if (!run_id) {
    console.error("No run id provided and no recent runs found.");
    return 5;
  }
  const state = loadState(run_id);
  const stateDir = getStateDir(run_id);
  const logPath = getLogPath(run_id);
  const logFn = makeLogger(run_id, args.verbose);
  const ctx: BakeContext = {
    state,
    log: logFn,
    repo_root: REPO_ROOT,
    state_dir: stateDir,
    log_path: logPath,
    dry_run: false,
    auto_confirm: true,
  };
  const allSteps = buildAllSteps();
  logFn(`Running rollback for ${run_id}`);
  await runRollback(allSteps, ctx, logFn);
  logFn("Rollback complete");
  return 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  switch (args.action) {
    case "full":
      return actionFull(args, false);
    case "preflight":
      return actionFull(args, false);
    case "dry-run":
      return actionFull(args, true);
    case "resume":
      return actionResume(args);
    case "status":
      return actionStatus(args);
    case "list":
      return actionList();
    case "rollback":
      return actionRollback(args);
    default:
      usage();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error("FATAL:", e?.stack ?? e);
    releaseGlobalBakeLock();
    process.exit(1);
  });
