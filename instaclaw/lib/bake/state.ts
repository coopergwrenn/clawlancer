/**
 * lib/bake/state.ts — BakeState persistence with atomic writes + resume.
 *
 * State layout on disk:
 *
 *   ~/.bake-state/
 *     ├── last-bake-fingerprint.json     (cross-run drift baseline)
 *     ├── bake.lock                      (global lock — only one bake at a time)
 *     └── runs/
 *         └── <run-id>/                  (one dir per run; run-id = ISO timestamp)
 *             ├── state.json             (atomic-written after every step)
 *             ├── log.txt                (append-only; every line timestamped)
 *             └── <step-id>.out          (per-step captured stdout/stderr)
 *
 * Atomic write per CLAUDE.md Rule 22 — write to .tmp + os.replace.
 * Never partial-state on Ctrl-C.
 *
 * Per design doc §2.3 (state machine) + §2.6 (rollback).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { BakeState } from "./step-spec";

// ─── Paths ───────────────────────────────────────────────────────────────────

const BAKE_STATE_ROOT = join(homedir(), ".bake-state");
const RUNS_DIR = join(BAKE_STATE_ROOT, "runs");
const FINGERPRINT_PATH = join(BAKE_STATE_ROOT, "last-bake-fingerprint.json");
const GLOBAL_LOCK_PATH = join(BAKE_STATE_ROOT, "bake.lock");

export function getStateDir(run_id: string): string {
  return join(RUNS_DIR, run_id);
}

export function getStatePath(run_id: string): string {
  return join(getStateDir(run_id), "state.json");
}

export function getLogPath(run_id: string): string {
  return join(getStateDir(run_id), "log.txt");
}

export function getStepOutputPath(run_id: string, step_id: string): string {
  return join(getStateDir(run_id), `${step_id}.out`);
}

// ─── Init / write / read ─────────────────────────────────────────────────────

/** Ensure the state-root directory tree exists. Idempotent. */
export function ensureStateRoot(): void {
  if (!existsSync(BAKE_STATE_ROOT)) mkdirSync(BAKE_STATE_ROOT, { recursive: true });
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

/** Create a new run directory. Returns the state directory path. */
export function initRun(run_id: string): string {
  ensureStateRoot();
  const dir = getStateDir(run_id);
  if (existsSync(dir)) {
    throw new Error(`Run directory already exists: ${dir}`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Atomic-write the state to disk. Writes to `state.json.tmp` then renames.
 * Updates the `updated_at` and `elapsed_seconds` fields automatically.
 */
export function persistState(state: BakeState): void {
  const now = new Date();
  state.updated_at = now.toISOString();
  state.elapsed_seconds = Math.round((now.getTime() - new Date(state.started_at).getTime()) / 1000);

  const path = getStatePath(state.run_id);
  const tmp = `${path}.tmp`;
  // Note: writeFileSync followed by renameSync gives us atomicity on POSIX.
  // On macOS APFS + Linux ext4 both honor the rename atomicity contract.
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

/** Read a persisted state. Throws if absent or unreadable. */
export function loadState(run_id: string): BakeState {
  const path = getStatePath(run_id);
  if (!existsSync(path)) {
    throw new Error(`No state file for run ${run_id}: ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as BakeState;
}

// ─── Run listing + status ────────────────────────────────────────────────────

/** List recent run-ids, newest first. */
export function listRuns(limit = 20): string[] {
  ensureStateRoot();
  if (!existsSync(RUNS_DIR)) return [];
  const entries = readdirSync(RUNS_DIR)
    .filter((name) => {
      try {
        return statSync(join(RUNS_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  return entries.slice(0, limit);
}

/** Get the most recent run id (or null). */
export function latestRun(): string | null {
  const all = listRuns(1);
  return all[0] ?? null;
}

/**
 * Mark a stale-but-running state as "stalled" if it hasn't been updated
 * in `staleAfterHours` hours. Defensive — handles operator Ctrl-C without
 * cleanup, etc.
 */
export function markStaleIfNeeded(state: BakeState, staleAfterHours = 24): BakeState {
  if (state.status !== "running") return state;
  const ageHours = (Date.now() - new Date(state.updated_at).getTime()) / 1000 / 3600;
  if (ageHours > staleAfterHours) {
    state.status = "stalled";
    state.errors.push(`auto-stalled after ${ageHours.toFixed(1)}h of no updates`);
    persistState(state);
  }
  return state;
}

// ─── Global concurrency lock ─────────────────────────────────────────────────

/**
 * Acquire a global "only one bake at a time per machine" lock.
 * Writes the run-id + PID + timestamp to bake.lock. If the lock exists
 * AND its PID is still alive AND fresh (<6h), refuse to start.
 *
 * The lock is FILE-based (not OS-level fcntl) for portability. A crashed
 * orchestrator leaves the file behind; the next run detects PID death
 * and reclaims.
 */
export function acquireGlobalBakeLock(run_id: string): { acquired: boolean; reason: string } {
  ensureStateRoot();
  if (existsSync(GLOBAL_LOCK_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(GLOBAL_LOCK_PATH, "utf-8")) as {
        run_id: string;
        pid: number;
        acquired_at: string;
      };
      // Check if PID is still alive (process.kill with signal 0 = exists check).
      let alive = false;
      try {
        process.kill(existing.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      const ageH = (Date.now() - new Date(existing.acquired_at).getTime()) / 1000 / 3600;
      if (alive && ageH < 6) {
        return {
          acquired: false,
          reason: `lock held by run ${existing.run_id} (pid ${existing.pid}, age ${ageH.toFixed(1)}h)`,
        };
      }
      // Stale lock — reclaim with a warning logged separately.
    } catch (e) {
      // Corrupt lock file — overwrite.
    }
  }
  const payload = { run_id, pid: process.pid, acquired_at: new Date().toISOString() };
  writeFileSync(GLOBAL_LOCK_PATH, JSON.stringify(payload, null, 2));
  return { acquired: true, reason: "" };
}

/** Release the global lock. Idempotent — safe to call multiple times. */
export function releaseGlobalBakeLock(): void {
  if (existsSync(GLOBAL_LOCK_PATH)) {
    try {
      // Verify it's still ours before removing — defensive against multiple
      // orchestrator processes interleaving releases.
      const existing = JSON.parse(readFileSync(GLOBAL_LOCK_PATH, "utf-8")) as {
        pid: number;
      };
      if (existing.pid === process.pid) {
        // Use a tombstone rename so concurrent races don't delete a fresh lock
        // taken by another process between our check and our delete.
        const tombstone = `${GLOBAL_LOCK_PATH}.released-${Date.now()}`;
        renameSync(GLOBAL_LOCK_PATH, tombstone);
        // Best-effort delete tombstone after a moment.
        setTimeout(() => {
          try {
            require("fs").unlinkSync(tombstone);
          } catch {
            // ok
          }
        }, 100);
      }
    } catch {
      // best-effort
    }
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

/**
 * Append a line to the bake log. Lines are written immediately (no buffer)
 * so Ctrl-C preserves the log up to the last line.
 *
 * Each line has the format:
 *   2026-05-23T14:30:00Z [step-id] message
 */
export function appendLog(run_id: string, message: string, step_id = "orch"): void {
  const path = getLogPath(run_id);
  const ts = new Date().toISOString();
  const line = `${ts} [${step_id}] ${message}\n`;
  // Use appendFileSync — atomic per-line on POSIX for files opened O_APPEND
  // (which fs.appendFile uses internally).
  require("fs").appendFileSync(path, line);
}

// ─── Fingerprint (cross-run drift baseline) ──────────────────────────────────

/**
 * The fingerprint of a successful bake. Stored at last-bake-fingerprint.json.
 * Subsequent bakes diff against this and report drift.
 */
export interface BakeFingerprint {
  completed_at: string;
  snapshot_id: string;
  manifest_version: number;
  source_pins: BakeState["source_pins"];
  reconciler_hash: string;
  known_env_vars: string[];
  v106_path: "A" | "B";
}

export function readLastBakeFingerprint(): BakeFingerprint | null {
  if (!existsSync(FINGERPRINT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(FINGERPRINT_PATH, "utf-8")) as BakeFingerprint;
  } catch {
    return null;
  }
}

export function writeBakeFingerprint(fp: BakeFingerprint): void {
  ensureStateRoot();
  const tmp = `${FINGERPRINT_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(fp, null, 2));
  renameSync(tmp, FINGERPRINT_PATH);
}
