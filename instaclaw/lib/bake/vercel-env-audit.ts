/**
 * lib/bake/vercel-env-audit.ts — Family C check (Vercel production env).
 *
 * The autonomous bake produces the snapshot, but production VMs converge
 * via the Vercel cron after a snapshot ships. That convergence depends
 * on certain env vars being set in Vercel's production env:
 *
 *   - GBRAIN_INSTALL_ENABLED=true    (stepGbrain runs)
 *   - GBRAIN_PINNED_COMMIT / _VERSION (install-gbrain.sh receives them)
 *   - RECONCILE_SOUL_MIGRATION_ENABLED=true (stepMigrateSoulV2 runs)
 *
 * This module audits Vercel prod env via `npx vercel env ls production`
 * and reports drift. The Vercel CLI must be installed + authed; if it
 * isn't, we treat the check as P1 (skip with warning) rather than P0
 * (block the bake) — per design doc §3.4 "What stays manual".
 *
 * Per design doc §1.6 gap-fill item #9.
 */

import { execSync } from "child_process";

export interface VercelEnvCheckResult {
  /** Whether Vercel CLI is available + authed (i.e., the audit ran at all). */
  cli_available: boolean;
  /** Whether all expected env vars were found with expected values. */
  ok: boolean;
  /** Detailed per-var findings. */
  vars: Array<{
    name: string;
    expected: string | "set" | "any";
    present: boolean;
    value_hint: string; // partial value or "<hidden>" — Vercel masks values
  }>;
  /** Warning if CLI unavailable. */
  notes: string[];
}

const EXPECTED_VERCEL_ENV_VARS: Array<{ name: string; expected: string | "set" | "any" }> = [
  { name: "LINODE_SNAPSHOT_ID", expected: "set" },
  { name: "LINODE_API_TOKEN", expected: "set" },
  { name: "GBRAIN_INSTALL_ENABLED", expected: "true" },
  { name: "GBRAIN_PINNED_COMMIT", expected: "set" },
  { name: "GBRAIN_PINNED_VERSION", expected: "set" },
  { name: "RECONCILE_SOUL_MIGRATION_ENABLED", expected: "true" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", expected: "set" },
  { name: "NEXT_PUBLIC_SUPABASE_URL", expected: "set" },
];

/**
 * Probe Vercel prod env. Returns structured findings.
 *
 * If Vercel CLI is absent or not authed, this returns `cli_available=false`
 * and a note suggesting the operator run `npx vercel login` and re-check
 * manually. The orchestrator's preflight treats this as a P1 warning, not
 * a P0 abort.
 *
 * IMPORTANT: this CALLS `npx vercel env ls` which requires a Vercel-authed
 * shell. If the operator's shell isn't authed, this command fails with
 * "Please run `vercel login`" — we detect and report that gracefully.
 */
export async function auditVercelProdEnv(): Promise<VercelEnvCheckResult> {
  const result: VercelEnvCheckResult = {
    cli_available: false,
    ok: false,
    vars: [],
    notes: [],
  };

  // 1. Check vercel CLI is installed
  let cliInstalled = false;
  try {
    execSync("which vercel || npx --no-install vercel --version", {
      stdio: "ignore",
      timeout: 5000,
    });
    cliInstalled = true;
  } catch {
    try {
      execSync("npx vercel --version", { stdio: "pipe", timeout: 15_000 });
      cliInstalled = true;
    } catch {
      cliInstalled = false;
    }
  }

  if (!cliInstalled) {
    result.notes.push(
      "Vercel CLI not available (or not authed). Skipping Family C audit. " +
        "Run `npx vercel login` then `npx vercel env ls production` manually to verify.",
    );
    return result;
  }

  result.cli_available = true;

  // 2. List Vercel production env vars
  //
  // `vercel env ls production` prints a paginated table. The default page
  // size shows ~25 rows. Production has ~95 vars — we need to consume all
  // pages by piping through `cat` (forces non-tty mode → no paging) AND
  // using `--limit=200` if the CLI supports it.
  //
  // Empirically (vercel CLI as of 2026-05-19): the command does NOT honor
  // --limit, but piping to a file via stdout in a non-tty subprocess returns
  // ALL vars in a single output. Node's execSync captures stdout fully, so
  // we get the complete list as long as the CLI doesn't impose its own cap.
  let envListOutput = "";
  try {
    envListOutput = execSync("npx vercel env ls production 2>&1", {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024, // 8 MB buffer for large env lists
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (/login|auth/i.test(msg)) {
      result.notes.push("Vercel CLI not authed. Run `npx vercel login`.");
    } else {
      result.notes.push(`Vercel CLI failed: ${msg.slice(0, 150)}`);
    }
    return result;
  }

  // Sanity-check: log how many rows we got (helps debug pagination issues)
  const rowCount = envListOutput.split("\n").filter((l) => /^\s+[A-Z]/.test(l)).length;
  result.notes.push(`Vercel env ls returned ${rowCount} rows`);

  // 3. For each expected var, check if it appears in the listing
  const lines = envListOutput.split("\n");
  for (const exp of EXPECTED_VERCEL_ENV_VARS) {
    // The CLI's table format has columns: `name  type  environments  age`.
    // Be permissive — match the name as a column-1 token after trim.
    const matchedLine = lines.find((l) => {
      const trimmed = l.trim();
      return trimmed.split(/\s+/)[0] === exp.name;
    });
    const present = !!matchedLine;
    let value_hint = "";
    if (matchedLine) {
      value_hint = matchedLine.trim().slice(0, 80);
    }
    result.vars.push({
      name: exp.name,
      expected: exp.expected,
      present,
      value_hint,
    });
  }

  // 4. Verdict: ok if all expected vars are present.
  // For "expected=true" entries, we can't verify the VALUE without `env pull`.
  // We emit a note recommending the operator do a one-time pull-and-verify
  // before each bake.
  const allPresent = result.vars.every((v) => v.present);
  result.ok = allPresent;

  if (allPresent) {
    result.notes.push(
      "All expected env vars present in Vercel prod. " +
        "Note: Vercel CLI masks values — to verify literals (e.g., RECONCILE_SOUL_MIGRATION_ENABLED=true), " +
        "run `npx vercel env pull .env.vercel-prod-audit && grep -E '<var>=' .env.vercel-prod-audit && rm .env.vercel-prod-audit`.",
    );
  } else {
    const missing = result.vars.filter((v) => !v.present).map((v) => v.name);
    result.notes.push(`Missing in Vercel prod env: ${missing.join(", ")}`);
  }

  return result;
}
