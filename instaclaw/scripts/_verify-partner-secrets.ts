/**
 * One-shot operator script — verify every registered partner secret.
 *
 * Workflow (per CLAUDE.md operations runbook):
 *
 *   1. Partner sends a new/rotated secret.
 *   2. Operator updates Vercel env (use `printf` not `<<<` — CLAUDE.md
 *      Rule 6 — to avoid trailing-newline corruption).
 *   3. Pull the new value into local .env.local (or run this script
 *      directly against Vercel-equivalent env).
 *   4. Run `npx tsx scripts/_verify-partner-secrets.ts`.
 *   5. Confirm ALL relevant entries report `ok` before declaring the
 *      rotation deployed. If any reports `auth_failed` or
 *      `shape_invalid`, STOP — the secret in Vercel is wrong. The
 *      EDGEOS_BEARER_TOKEN incident would have been caught here on
 *      day one if this script existed.
 *
 * Exit code:
 *   0 — all checks ok or only `not_configured` (no real failure)
 *   1 — at least one entry returned `auth_failed`, `shape_invalid`,
 *       `endpoint_other`, or `endpoint_5xx`
 *   The `unreachable` status is treated as ok for exit code purposes
 *   (we don't want a transient network blip to fail CI), but is logged
 *   so an operator sees it.
 */
import { readFileSync } from "fs";

// Load env vars before importing the verifier (which reads process.env).
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env file missing is fine in some contexts; verifiers will report
    // "not_configured" for missing values.
  }
}

import { verifyAllPartnerSecrets } from "../lib/partner-secrets";

async function main(): Promise<void> {
  console.log("Verifying partner secrets against live partner APIs…\n");

  const results = await verifyAllPartnerSecrets();

  // Status to symbol + colour-coded text (terminal-safe via reset)
  const SYMBOLS: Record<string, string> = {
    ok: "✓",
    not_configured: "·",
    shape_invalid: "✗",
    auth_failed: "✗",
    unreachable: "~",
    endpoint_5xx: "~",
    endpoint_other: "✗",
  };

  let failed = 0;
  for (const r of results) {
    const sym = SYMBOLS[r.status] ?? "?";
    const httpStr = r.http_code ? ` http=${r.http_code}` : "";
    const errStr = r.error ? ` error="${r.error.slice(0, 120)}"` : "";
    const bodyStr = r.body_prefix ? ` body="${r.body_prefix.slice(0, 120)}"` : "";
    console.log(
      `  [${sym}] ${r.envKey.padEnd(28)} ${r.status}${httpStr}${errStr}${bodyStr}`,
    );
    // Hard failures only — `unreachable` and `not_configured` aren't.
    const hardFailures = ["shape_invalid", "auth_failed", "endpoint_other", "endpoint_5xx"];
    if (hardFailures.includes(r.status)) failed++;
  }

  console.log("");
  console.log(`Summary: ${results.length} secret(s) checked, ${failed} hard failure(s).`);
  console.log(`  Hard failures (shape_invalid, auth_failed, endpoint_other, endpoint_5xx) → exit 1`);
  console.log(`  Soft signals (unreachable, not_configured) → logged but exit 0`);
  console.log(`  Healthy (ok) → exit 0`);

  if (failed > 0) {
    console.error("\nFAIL: at least one secret returned a hard failure. Investigate before deploying.");
    process.exit(1);
  }
  console.log("\nOK: all configured secrets verified.");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
