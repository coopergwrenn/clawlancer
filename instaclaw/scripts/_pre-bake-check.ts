/**
 * _pre-bake-check.ts — snapshot bake go/no-go gate
 *
 * Run BEFORE provisioning the bake VM. Verifies every prerequisite in
 * `docs/snapshot-bake-v101-checklist.md §2` + `docs/snapshot-bake-runbook.md §0.5`
 * against the current state of:
 *   - this repo (HEAD alignment, pinned-version drift, file syntax)
 *   - Vercel env (LINODE_SNAPSHOT_ID, expected source snapshot)
 *   - Supabase (fleet cv distribution, quarantined VMs, cron locks,
 *     admin alerts, lifecycle events)
 *   - Linode API (instance/image API reachable)
 *   - Fleet runtime (gbrain edge_city coverage via SSH probe)
 *
 * Three severity tiers:
 *   CRITICAL — any failure means NO-GO. Bake will produce a broken snapshot
 *              or attempt against stale code.
 *   WARNING  — failure means GO WITH CAUTION. The bake may proceed but the
 *              operator needs to know about a real issue.
 *   INFO     — always logged. Useful context, never blocks.
 *
 * Exit codes:
 *   0 — GO          (every CRITICAL passed; warnings may exist)
 *   1 — NO-GO       (one or more CRITICAL checks failed)
 *   2 — CONNECTIVITY (Supabase / Linode / git unreachable; can't render verdict)
 *   3 — ARG_ERROR   (script invoked with bad args)
 *
 * Usage:
 *   npx tsx scripts/_pre-bake-check.ts
 *   npx tsx scripts/_pre-bake-check.ts --verbose
 *   npx tsx scripts/_pre-bake-check.ts --target-snapshot=private/38575292
 *
 * Why this exists: bakes have multi-hour wall-clock cost. Discovering a
 * stale `GBRAIN_PINNED_COMMIT` mismatch or a quarantined VM after step §3.5
 * costs us a redo. This script collapses every checklist gate into a single
 * 30-second verification before the bake VM is provisioned.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

// ──────────────────────────────────────────────────────────────────────────────
// Env loading — Rule 18: SSH-using scripts must load BOTH .env.local AND
// .env.ssh-key. Tries the script's own repo first, then falls back to the
// canonical `/Users/cooperwrenn/wild-west-bots/instaclaw/` path so this works
// from either the main repo or the changelog clone.
// ──────────────────────────────────────────────────────────────────────────────
const __dirname_local =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
const repoInstaclaw = resolve(__dirname_local, "..");
const ENV_FILE_CANDIDATES = [
  resolve(repoInstaclaw, ".env.local"),
  resolve(repoInstaclaw, ".env.ssh-key"),
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
];
for (const f of ENV_FILE_CANDIDATES) {
  try {
    if (!existsSync(f)) continue;
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argMap: Record<string, string> = {};
const flags = new Set<string>();
for (const a of args) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) argMap[m[1]] = m[2];
  else if (a.startsWith("--")) flags.add(a.slice(2));
}
const VERBOSE = flags.has("verbose");
const TARGET_SOURCE_SNAPSHOT =
  argMap["target-snapshot"] || process.env.LINODE_SNAPSHOT_ID || "private/38575292";
const TARGET_MANIFEST_VERSION = parseInt(
  argMap["target-manifest-version"] || "0",
  10
);
const TARGET_INTEGRITY_COMMIT = argMap["integrity-commit"] || "f49b4e68";

// ──────────────────────────────────────────────────────────────────────────────
// Result types
// ──────────────────────────────────────────────────────────────────────────────
type Severity = "CRITICAL" | "WARNING" | "INFO";
interface CheckResult {
  name: string;
  severity: Severity;
  passed: boolean;
  summary: string;
  details?: string;
}
const results: CheckResult[] = [];

function push(r: CheckResult) {
  results.push(r);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function safeGit(cmd: string, cwd = repoInstaclaw): string {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (e: any) {
    return `__GIT_ERR__: ${e?.message ?? e}`;
  }
}

function readFileIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Repo-state checks
// ──────────────────────────────────────────────────────────────────────────────

function checkHeadAlignedWithMain(): CheckResult {
  // Rule 12. Operator's local HEAD must match origin/main, otherwise the
  // bake reconciles against stale code.
  const fetchResult = safeGit("git fetch origin main --quiet 2>&1");
  if (fetchResult.startsWith("__GIT_ERR__")) {
    return {
      name: "HEAD aligned with origin/main (Rule 12)",
      severity: "CRITICAL",
      passed: false,
      summary: "git fetch failed",
      details: fetchResult,
    };
  }
  const head = safeGit("git rev-parse HEAD");
  const main = safeGit("git rev-parse origin/main");
  if (head.startsWith("__GIT_ERR__") || main.startsWith("__GIT_ERR__")) {
    return {
      name: "HEAD aligned with origin/main (Rule 12)",
      severity: "CRITICAL",
      passed: false,
      summary: "git rev-parse failed",
      details: `head=${head} main=${main}`,
    };
  }
  return {
    name: "HEAD aligned with origin/main (Rule 12)",
    severity: "CRITICAL",
    passed: head === main,
    summary: head === main ? `aligned at ${head.slice(0, 8)}` : `DRIFT: HEAD=${head.slice(0, 8)} main=${main.slice(0, 8)}`,
    details: head !== main ? "Run: git pull --ff-only origin main" : undefined,
  };
}

function checkIntegrityFixLanded(): CheckResult {
  // Verify commit TARGET_INTEGRITY_COMMIT (f49b4e68 by default) is on
  // origin/main. This is the P1-4 cache-bust integrity fix that gates whether
  // the reconcile-fleet cron can safely process VMs.
  const result = safeGit(
    `git merge-base --is-ancestor ${TARGET_INTEGRITY_COMMIT} origin/main 2>&1; echo $?`
  );
  const lines = result.split("\n");
  const exitCode = lines[lines.length - 1];
  const isAncestor = exitCode === "0";
  return {
    name: `integrity fix landed (commit ${TARGET_INTEGRITY_COMMIT})`,
    severity: "CRITICAL",
    passed: isAncestor,
    summary: isAncestor
      ? `${TARGET_INTEGRITY_COMMIT} on origin/main ✓`
      : `${TARGET_INTEGRITY_COMMIT} NOT on origin/main`,
    details: !isAncestor
      ? `Check that the manifest-integrity fix landed before baking — the integrity check is what catches stale Vercel bundles.`
      : undefined,
  };
}

function checkLinodeSnapshotMatch(): CheckResult {
  // Runbook §0.5.1 Gate 2. The LINODE_SNAPSHOT_ID env in .env.local must
  // match the expected source snapshot (the snapshot we're baking FROM).
  const local = process.env.LINODE_SNAPSHOT_ID || "<unset>";
  return {
    name: "LINODE_SNAPSHOT_ID matches expected source",
    severity: "CRITICAL",
    passed: local === TARGET_SOURCE_SNAPSHOT,
    summary:
      local === TARGET_SOURCE_SNAPSHOT
        ? `${local} ✓`
        : `MISMATCH: local=${local} expected=${TARGET_SOURCE_SNAPSHOT}`,
    details:
      local !== TARGET_SOURCE_SNAPSHOT
        ? `Edit instaclaw/.env.local or override with --target-snapshot=<id>.`
        : undefined,
  };
}

function checkGbrainPinnedAlignment(): CheckResult {
  // Pinned-version drift between the two consumers (reconciler and install
  // script) would cause stepGbrain to write different state on different
  // VMs. Both must agree.
  const reconcilerFile = resolve(repoInstaclaw, "lib/vm-reconcile.ts");
  const installFile = resolve(
    repoInstaclaw,
    "scripts/_install-gbrain-on-vm.ts"
  );
  const reconciler = readFileIfExists(reconcilerFile);
  const installer = readFileIfExists(installFile);
  if (!reconciler || !installer) {
    return {
      name: "GBRAIN_PINNED_* alignment",
      severity: "CRITICAL",
      passed: false,
      summary: "one or both files missing",
      details: `reconciler=${!!reconciler} installer=${!!installer}`,
    };
  }
  const commitRx = /GBRAIN_PINNED_COMMIT\s*=\s*["']([^"']+)["']/;
  const versionRx = /GBRAIN_PINNED_VERSION\s*=\s*["']([^"']+)["']/;
  const rc = reconciler.match(commitRx)?.[1];
  const rv = reconciler.match(versionRx)?.[1];
  const ic = installer.match(commitRx)?.[1];
  const iv = installer.match(versionRx)?.[1];
  // Installer might use env-var fallback instead of literal; that's fine
  // as long as the reconciler is set.
  const passed = !!rc && !!rv && (!ic || ic === rc) && (!iv || iv === rv);
  return {
    name: "GBRAIN_PINNED_* alignment",
    severity: "CRITICAL",
    passed,
    summary: passed
      ? `reconciler: ${rv}/${rc} ${ic && iv ? `+ installer: ${iv}/${ic}` : "(installer uses env)"}`
      : `MISMATCH reconciler=${rv}/${rc} installer=${iv}/${ic}`,
  };
}

function checkGbrainInstallScriptsSyntax(): CheckResult {
  // Both install-gbrain.sh and verify-gbrain-mcp.py must parse cleanly.
  // bash -n catches syntax errors without executing; py_compile parses .py.
  const sh = resolve(repoInstaclaw, "scripts/install-gbrain.sh");
  const py = resolve(repoInstaclaw, "scripts/verify-gbrain-mcp.py");
  if (!existsSync(sh) || !existsSync(py)) {
    return {
      name: "gbrain install scripts present + parse cleanly",
      severity: "CRITICAL",
      passed: false,
      summary: `missing: ${!existsSync(sh) ? "install-gbrain.sh " : ""}${!existsSync(py) ? "verify-gbrain-mcp.py" : ""}`,
    };
  }
  let shErr: string | null = null;
  let pyErr: string | null = null;
  try {
    execSync(`bash -n "${sh}"`, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e: any) {
    shErr = e?.stderr?.toString() || e?.message;
  }
  try {
    execSync(`python3 -m py_compile "${py}"`, {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e: any) {
    pyErr = e?.stderr?.toString() || e?.message;
  }
  const passed = !shErr && !pyErr;
  return {
    name: "gbrain install scripts present + parse cleanly",
    severity: "CRITICAL",
    passed,
    summary: passed ? "both parse cleanly ✓" : `errors: sh=${!!shErr} py=${!!pyErr}`,
    details: !passed ? `${shErr || ""}\n${pyErr || ""}`.trim() : undefined,
  };
}

function checkEnvVarsPresent(): CheckResult {
  const required = [
    "LINODE_API_TOKEN",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SSH_PRIVATE_KEY_B64",
  ];
  const missing = required.filter((k) => !process.env[k]);
  return {
    name: "required env vars loaded",
    severity: "CRITICAL",
    passed: missing.length === 0,
    summary: missing.length === 0 ? `${required.length}/${required.length} present ✓` : `missing: ${missing.join(", ")}`,
    details:
      missing.length > 0
        ? "Check instaclaw/.env.local and instaclaw/.env.ssh-key exist and are readable."
        : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// CDP backup wallet readiness — restored 2026-05-24 (Cooper P0).
//
// CDP is the agent's BACKUP wallet for EVM operations when Bankr is in
// maintenance. Every freshly-baked snapshot must be able to provision CDP
// wallets on first VM boot. Four prerequisites:
//   1. CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET in env
//      (loaded from instaclaw/.env.local for local pre-bake; the same
//      keys must also be live in Vercel production for the post-bake
//      backfill cron to work).
//   2. @coinbase/cdp-sdk in instaclaw/package.json (Vercel bundling).
//   3. instaclaw/lib/cdp-wallet.ts present (the provisioning helper).
//   4. supabase/pending_migrations/*vm_cdp_wallet*.sql OR the columns
//      already applied to prod (we check both).
//
// All four are CRITICAL — bake refuses if any fails. Without CDP, paying
// users have no backup wallet during a Bankr outage, which is what this
// whole infrastructure exists to prevent.
// ──────────────────────────────────────────────────────────────────────────────
function checkCdpReadiness(): CheckResult[] {
  const results: CheckResult[] = [];

  // Check 1: env vars
  const cdpEnvVars = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"];
  const cdpEnvMissing = cdpEnvVars.filter((k) => !process.env[k]);
  results.push({
    name: "CDP env vars (backup wallet provisioning)",
    severity: "CRITICAL",
    passed: cdpEnvMissing.length === 0,
    summary:
      cdpEnvMissing.length === 0
        ? `${cdpEnvVars.length}/${cdpEnvVars.length} present ✓`
        : `missing: ${cdpEnvMissing.join(", ")}`,
    details:
      cdpEnvMissing.length > 0
        ? "Set in Vercel production via the Web UI (Coinbase CDP dashboard → Developer Platform → API Keys). Backup wallet provisioning is DOWN without these — paying users have no EVM receive address when Bankr is in maintenance."
        : undefined,
  });

  // Check 2: SDK dependency in package.json
  let sdkInPackageJson = false;
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoInstaclaw, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    sdkInPackageJson = !!pkg.dependencies?.["@coinbase/cdp-sdk"];
  } catch {
    sdkInPackageJson = false;
  }
  results.push({
    name: "@coinbase/cdp-sdk in package.json",
    severity: "CRITICAL",
    passed: sdkInPackageJson,
    summary: sdkInPackageJson ? "present ✓" : "MISSING from instaclaw/package.json",
    details: sdkInPackageJson
      ? undefined
      : "Add via `npm install @coinbase/cdp-sdk` from instaclaw/. Without it, Vercel nft tracer won't bundle the SDK and the CDP provision call throws at runtime.",
  });

  // Check 3: helper file
  const helperPath = resolve(repoInstaclaw, "lib/cdp-wallet.ts");
  const helperPresent = existsSync(helperPath);
  results.push({
    name: "lib/cdp-wallet.ts (provisionCdpWallet helper)",
    severity: "CRITICAL",
    passed: helperPresent,
    summary: helperPresent ? "present ✓" : "MISSING",
    details: helperPresent
      ? undefined
      : "Restore the helper before baking. Without it, /api/vm/assign + /api/billing/webhook + cron/provision-missing-cdp-wallets all fail to import.",
  });

  // Check 4: migration tracked (pending or applied). We check both
  // pending_migrations/ and migrations/ since either is acceptable
  // (Rule 56: pending until prod-applied, then git-mv to migrations).
  const migrationPatterns = ["20260524180000_vm_cdp_wallet.sql"];
  const pendingDir = resolve(repoInstaclaw, "supabase/pending_migrations");
  const appliedDir = resolve(repoInstaclaw, "supabase/migrations");
  const migrationLocation = migrationPatterns
    .map((name) => {
      if (existsSync(resolve(pendingDir, name))) return `pending: ${name}`;
      if (existsSync(resolve(appliedDir, name))) return `applied: ${name}`;
      return null;
    })
    .filter((s): s is string => s !== null);
  results.push({
    name: "CDP migration tracked in repo",
    severity: "CRITICAL",
    passed: migrationLocation.length > 0,
    summary:
      migrationLocation.length > 0
        ? migrationLocation.join("; ")
        : "MISSING from both pending_migrations/ and migrations/",
    details:
      migrationLocation.length > 0
        ? undefined
        : "Migration file 20260524180000_vm_cdp_wallet.sql adds cdp_wallet_id + cdp_wallet_address to instaclaw_vms. Apply via Supabase Studio per Rule 56, then git mv into migrations/.",
  });

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// 2026-05-22 P0 incident response: env var VALUE validation
//
// `checkEnvVarsPresent` above only verifies that vars are SET. Per the
// 2026-05-22 incident, RECONCILE_SOUL_MIGRATION_ENABLED was unset in Vercel
// for 9 days while we kept building V2 templates thinking they'd ship.
// The kill switch (`if (env !== "true") return;`) silently returned every
// reconcile tick. Zero fleet VMs migrated.
//
// Same risk shape for any boolean env var our code gates behind `!== "true"`:
//   GBRAIN_INSTALL_ENABLED
//   RECONCILE_SOUL_MIGRATION_ENABLED
//   BANKR_TOKENIZE_ENABLED
//   GBRAIN_DEEP_CHECK_ENABLED
//   CLOUD_INIT_ONDEMAND_ENABLED
//   STRICT_RECONCILE_ENABLED (currently unused but defined)
//
// For the bake context specifically, the operator's LOCAL .env.local is
// what drives the bake's reconcile run (which executes locally via
// `_phase3-v2-migrate.ts`). The pre-bake-check validates LOCAL env. Vercel
// env is a separate concern — if it diverges, production reconcile-fleet
// can ship with the bug class even after a clean bake. Future enhancement:
// add a `--check-vercel` flag that also probes `npx vercel env pull`.
//
// For each var: if set to anything other than "true", CRITICAL fail. Unset
// is allowed (means "feature off" — only RECONCILE_SOUL_MIGRATION_ENABLED
// is required-on for the bake context, others may be intentionally off).
// ──────────────────────────────────────────────────────────────────────────────
interface BooleanEnvSpec {
  name: string;
  requiredOnForBake: boolean;
  rationale: string;
}

// Membership audit (Cooper deep-audit 2026-05-22, post-incident followup).
//
// Criterion: env vars whose code uses the `!== "true"` silent-skip gate
// (the exact 2026-05-22 incident shape). Vars with positive `=== "true"`
// gates have the SAME operator-side risk class (misconfigured value →
// feature inactive) but are excluded here per Cooper's narrow criterion —
// with one exception below.
//
//   IN — `!== "true"` silent-skip gates (exact bug shape Rule 61 covers):
//     RECONCILE_SOUL_MIGRATION_ENABLED  lib/vm-reconcile.ts:8057
//     GBRAIN_INSTALL_ENABLED            lib/vm-reconcile.ts:1932 + 8792 + 9067
//     BANKR_TOKENIZE_ENABLED            app/api/bankr/* x 3 callsites
//     GBRAIN_DEEP_CHECK_ENABLED         app/api/cron/gbrain-deep-check/route.ts:290
//
//   IN (exception) — `=== "true"` positive gate, surfaced here because the
//        feature is currently intentionally OFF (pending Google CASA Tier 2)
//        AND operator may flip it. Pre-bake-time check catches "Cooper meant
//        to enable but got the syntax wrong" against the same risk class:
//     GMAIL_PERSONALIZATION_ENABLED     app/api/vm/status/route.ts:169
//
//   OUT — `=== "true"` positive gate, equivalent risk class but excluded
//        per Cooper's narrow criterion (only `!== "true"` callsites). If
//        operator-side risk surfaces in production, reconsider:
//     CLOUD_INIT_ONDEMAND_ENABLED       lib/createUserVM.ts:517
//
//   OUT — DIFFERENT shape: `=== "false"` (defaults-ON). Empty string or any
//        value other than the literal "false" leaves the feature ON. Lower
//        operator-side risk; no value-validation needed:
//     INDEX_POLLER_ENABLED              app/api/cron/poll-index-opportunities/route.ts:271
const BAKE_BOOLEAN_ENVS: BooleanEnvSpec[] = [
  {
    name: "RECONCILE_SOUL_MIGRATION_ENABLED",
    requiredOnForBake: true,
    rationale:
      "stepMigrateSoulV2 ships V2 SOUL.md/AGENTS.md to the bake VM. Without this, the bake VM keeps V1 templates and the snapshot ships without the V2 agent-identity layer — the exact 2026-05-22 incident.",
  },
  {
    name: "GBRAIN_INSTALL_ENABLED",
    requiredOnForBake: true,
    rationale:
      "stepGbrain installs the gbrain HTTP sidecar. Without this, the bake VM doesn't get gbrain installed and the snapshot ships without per-VM memory.",
  },
  // These are gated-feature vars that MAY be off for a bake; surface their
  // value but don't block.
  { name: "BANKR_TOKENIZE_ENABLED", requiredOnForBake: false, rationale: "Bankr tokenize routes; may be off." },
  { name: "GBRAIN_DEEP_CHECK_ENABLED", requiredOnForBake: false, rationale: "Deep-check cron; may be off." },
  {
    name: "GMAIL_PERSONALIZATION_ENABLED",
    requiredOnForBake: false,
    rationale:
      "Gmail personalization popup; intentionally OFF pending Google CASA Tier 2. Surfaced here so a future flip catches operator typos at pre-bake gate.",
  },
];

function checkBooleanEnvVarValues(): CheckResult[] {
  return BAKE_BOOLEAN_ENVS.map(({ name, requiredOnForBake, rationale }) => {
    const value = process.env[name];

    // Unset case: only CRITICAL if requiredOnForBake. Otherwise INFO.
    if (value === undefined || value === "") {
      if (requiredOnForBake) {
        return {
          name: `${name} === "true" (value validation — Rule 61)`,
          severity: "CRITICAL",
          passed: false,
          summary: value === undefined ? "UNSET" : "set to empty string",
          details:
            `${rationale}\n` +
            `Fix: edit instaclaw/.env.local and set ${name}=true (no quotes, no whitespace).\n` +
            `For Vercel: printf 'true' | npx vercel env add ${name} production\n` +
            `2026-05-22 incident: this exact silent-skip bug class.`,
        };
      }
      return {
        name: `${name} (off)`,
        severity: "INFO",
        passed: true,
        summary: value === undefined ? "unset (off)" : "empty (off)",
      };
    }

    // Set but not "true" — always CRITICAL regardless of requiredOnForBake.
    // If the operator typed something other than "true", they meant to enable
    // it but got the syntax wrong. Silent-skip is the bug we're fixing.
    if (value !== "true") {
      return {
        name: `${name} === "true" (value validation — Rule 61)`,
        severity: "CRITICAL",
        passed: false,
        summary: `${JSON.stringify(value)} (expected "true")`,
        details:
          `${name} is set but not "true". Boolean env vars must be the literal string "true".\n` +
          `Common mistakes: "True", "TRUE", "1", "yes", whitespace, accidental empty-string from echo "" | vercel env add.\n` +
          `Fix: edit instaclaw/.env.local and set ${name}=true (no quotes, no whitespace).\n` +
          `For Vercel: printf 'true' | npx vercel env add ${name} production\n` +
          `2026-05-22 incident: empty-string passed previous "presence" check, silent-skipped 9 days of fleet migration.`,
      };
    }

    return {
      name: `${name} === "true" (value validation — Rule 61)`,
      severity: requiredOnForBake ? "CRITICAL" : "INFO",
      passed: true,
      summary: `"${value}" ✓`,
    };
  });
}

function checkManifestVersion(): CheckResult {
  // Read VM_MANIFEST.version from lib/vm-manifest.ts. Info-level — surfaces
  // what version the bake will deliver. Compare to optional
  // --target-manifest-version arg.
  const manifestFile = resolve(repoInstaclaw, "lib/vm-manifest.ts");
  const content = readFileIfExists(manifestFile);
  if (!content) {
    return {
      name: "manifest version",
      severity: "INFO",
      passed: false,
      summary: "lib/vm-manifest.ts missing",
    };
  }
  // Match `version: N,` where N is the top-level VM_MANIFEST.version. The
  // first numeric `version:` field in the file is the canonical one (it's
  // at the top of VM_MANIFEST).
  const m = content.match(/^\s*version:\s*(\d+),/m);
  const v = m ? parseInt(m[1], 10) : null;
  const matches =
    TARGET_MANIFEST_VERSION === 0 || v === TARGET_MANIFEST_VERSION;
  return {
    name: "manifest version",
    severity: TARGET_MANIFEST_VERSION > 0 ? "CRITICAL" : "INFO",
    passed: v !== null && matches,
    summary: v !== null ? `v${v}${TARGET_MANIFEST_VERSION ? ` (expected v${TARGET_MANIFEST_VERSION})` : ""}` : "could not parse",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Fleet checks (Supabase)
// ──────────────────────────────────────────────────────────────────────────────

async function checkSupabaseReachable(
  sb: ReturnType<typeof createClient>
): Promise<CheckResult> {
  try {
    const { error } = await sb
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true })
      .limit(1);
    return {
      name: "Supabase reachable",
      severity: "CRITICAL",
      passed: !error,
      summary: error ? `err: ${error.message}` : "✓",
    };
  } catch (e: any) {
    return {
      name: "Supabase reachable",
      severity: "CRITICAL",
      passed: false,
      summary: `connect failed: ${e?.message ?? e}`,
    };
  }
}

async function checkFleetCvDistribution(
  sb: ReturnType<typeof createClient>,
  manifestVersion: number | null
): Promise<CheckResult[]> {
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("config_version")
    .eq("health_status", "healthy")
    .eq("status", "assigned");
  if (error || !data) {
    return [
      {
        name: "fleet cv distribution",
        severity: "CRITICAL",
        passed: false,
        summary: `query failed: ${error?.message}`,
      },
    ];
  }
  const dist: Record<number, number> = {};
  for (const r of data as any[])
    dist[r.config_version] = (dist[r.config_version] || 0) + 1;
  const total = data.length;
  const sortedCv = Object.keys(dist)
    .map(Number)
    .sort((a, b) => b - a);
  const distStr = sortedCv
    .map((cv) => `cv=${cv}:${dist[cv]}(${((dist[cv] / total) * 100).toFixed(0)}%)`)
    .join(" ");

  const out: CheckResult[] = [];
  out.push({
    name: "fleet size",
    severity: "INFO",
    passed: true,
    summary: `${total} healthy+assigned VMs`,
  });
  out.push({
    name: "fleet cv distribution",
    severity: "INFO",
    passed: true,
    summary: distStr,
  });

  // Warning: cv-lag check. If the manifest has bumped recently and >20% of
  // the fleet is at cv≤(manifest-2), that's stuck-cohort territory.
  if (manifestVersion !== null) {
    const stuckThreshold = manifestVersion - 2;
    const stuckCount = sortedCv
      .filter((cv) => cv <= stuckThreshold)
      .reduce((s, cv) => s + dist[cv], 0);
    const stuckPct = (stuckCount / total) * 100;
    out.push({
      name: `cv-lag (VMs at cv≤${stuckThreshold} when manifest=v${manifestVersion})`,
      severity: "WARNING",
      passed: stuckPct < 20,
      summary:
        stuckPct < 20
          ? `${stuckCount}/${total} (${stuckPct.toFixed(1)}%) — within tolerance`
          : `${stuckCount}/${total} (${stuckPct.toFixed(1)}%) STUCK — reconcile-fleet may be halted`,
      details:
        stuckPct >= 20
          ? "Common cause: stale_bundle alert halting reconcile-fleet. Check admin alerts."
          : undefined,
    });
  }
  return out;
}

async function checkQuarantinedVMs(
  sb: ReturnType<typeof createClient>
): Promise<CheckResult> {
  // Quarantine on instaclaw_vms is split across two columns:
  //   watchdog_quarantined_at (Rule 17 watchdog v2)
  //   reconcile_quarantined_at (reconciler step quarantine)
  // PostgREST: use `or` filter to match either.
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("name,watchdog_quarantined_at,reconcile_quarantined_at,health_status,status")
    .or("watchdog_quarantined_at.not.is.null,reconcile_quarantined_at.not.is.null");
  if (error) {
    return {
      name: "no quarantined VMs",
      severity: "CRITICAL",
      passed: false,
      summary: `query failed: ${error.message}`,
    };
  }
  const list = (data as any[]) || [];
  return {
    name: "no quarantined VMs",
    severity: "CRITICAL",
    passed: list.length === 0,
    summary: list.length === 0 ? "✓" : `${list.length} quarantined`,
    details:
      list.length > 0
        ? list
            .slice(0, 5)
            .map((v: any) => {
              const kind = v.watchdog_quarantined_at ? "watchdog" : "reconcile";
              const ts = v.watchdog_quarantined_at || v.reconcile_quarantined_at;
              return `  ${v.name} (${v.health_status}/${v.status}): ${kind} since ${ts?.slice(0, 16)}`;
            })
            .join("\n")
        : undefined,
  };
}

async function checkStaleCronLocks(
  sb: ReturnType<typeof createClient>
): Promise<CheckResult> {
  // Schema: instaclaw_cron_locks(name, acquired_at, expires_at, holder)
  const { data, error } = await sb
    .from("instaclaw_cron_locks")
    .select("name,holder,acquired_at,expires_at");
  if (error) {
    return {
      name: "no stale cron locks (>2h)",
      severity: "WARNING",
      passed: false,
      summary: `query failed: ${error.message}`,
    };
  }
  const now = Date.now();
  const stale = ((data as any[]) || []).filter((r: any) => {
    const acquired = new Date(r.acquired_at).getTime();
    return (now - acquired) / 1000 / 60 > 120;
  });
  return {
    name: "no stale cron locks (>2h)",
    severity: "WARNING",
    passed: stale.length === 0,
    summary: stale.length === 0 ? "✓" : `${stale.length} stale`,
    details:
      stale.length > 0
        ? stale
            .map(
              (r: any) =>
                `  ${r.name} held by ${r.holder} since ${r.acquired_at?.slice(0, 16)}`
            )
            .join("\n")
        : undefined,
  };
}

async function checkAdminAlerts(
  sb: ReturnType<typeof createClient>
): Promise<CheckResult[]> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb
    .from("instaclaw_admin_alert_log")
    .select("alert_key,sent_at,vm_count")
    .gte("sent_at", cutoff)
    .order("sent_at", { ascending: false })
    .limit(200);
  if (error) {
    return [
      {
        name: "admin alerts (24h)",
        severity: "CRITICAL",
        passed: false,
        summary: `query failed: ${error.message}`,
      },
    ];
  }
  const alerts = ((data as any[]) || []);
  const byKey: Record<string, number> = {};
  for (const a of alerts) byKey[a.alert_key] = (byKey[a.alert_key] || 0) + 1;

  const out: CheckResult[] = [];

  // Stale-bundle alerts — CRITICAL. If firing, the reconcile-fleet cron is
  // halted by the integrity check (P1-4), which means production isn't
  // converging to the latest manifest. Bake-time risk: the bake reconciles
  // locally so it's fine, but the soak validation would compare against a
  // fleet that's behind.
  const staleBundleCount = Object.keys(byKey)
    .filter((k) => k.startsWith("stale_bundle"))
    .reduce((s, k) => s + byKey[k], 0);
  out.push({
    name: "no STALE_BUNDLE alerts in 24h",
    severity: "CRITICAL",
    passed: staleBundleCount === 0,
    summary:
      staleBundleCount === 0
        ? "✓"
        : `${staleBundleCount} alerts — Vercel cache is stale; reconcile-fleet halted`,
    details:
      staleBundleCount > 0
        ? "Operator action: bump the file `app/api/cron/reconcile-fleet/route.ts` with a touch-comment + push, OR redeploy Vercel manually. The integrity check will then accept the bundle and reconciliation resumes."
        : undefined,
  });

  // ENOSPC alerts — CRITICAL. Disk pressure on any VM.
  const enospcCount = Object.keys(byKey)
    .filter((k) => k.startsWith("enospc"))
    .reduce((s, k) => s + byKey[k], 0);
  out.push({
    name: "no ENOSPC alerts in 24h (Rule 37)",
    severity: "CRITICAL",
    passed: enospcCount === 0,
    summary: enospcCount === 0 ? "✓" : `${enospcCount} alerts — disk pressure on the fleet`,
    details:
      enospcCount > 0
        ? "Investigate disk-full VMs before baking — they may indicate a session-backup runaway (Rule 45) the bake won't fix."
        : undefined,
  });

  // Stuck onboarding (Rule 33) — WARNING
  const stuckOnboarding = byKey["Stuck-Onboarding Users [Rule 33]"] || 0;
  out.push({
    name: "no stuck-onboarding alerts (Rule 33)",
    severity: "WARNING",
    passed: stuckOnboarding === 0,
    summary: stuckOnboarding === 0 ? "✓" : `${stuckOnboarding} alerts`,
  });

  // P0 freeze-recovery-failed (Rule 52) — WARNING
  const freezeFailed = Object.keys(byKey)
    .filter((k) => k.includes("Freeze recovery FAILED"))
    .reduce((s, k) => s + byKey[k], 0);
  out.push({
    name: "no [P0] freeze-recovery-failed alerts (Rule 52)",
    severity: "WARNING",
    passed: freezeFailed === 0,
    summary: freezeFailed === 0 ? "✓" : `${freezeFailed} alerts`,
  });

  // Info row: alert key summary
  const summary = Object.keys(byKey)
    .sort((a, b) => byKey[b] - byKey[a])
    .slice(0, 8)
    .map((k) => `${k}(${byKey[k]})`)
    .join("  ");
  out.push({
    name: "admin alerts (24h, top keys)",
    severity: "INFO",
    passed: true,
    summary: alerts.length === 0 ? "none" : `${alerts.length} total: ${summary}`,
  });

  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// gbrain edge_city coverage — delegates to the existing coverage script's
// probe semantics. Rather than re-implementing the SSH probe, we shell out
// to `_coverage-gbrain-sidecar.ts` and parse the summary line.
// ──────────────────────────────────────────────────────────────────────────────
async function checkGbrainEdgeCityCoverage(): Promise<CheckResult> {
  const coverageScript = resolve(
    repoInstaclaw,
    "scripts/_coverage-gbrain-sidecar.ts"
  );
  if (!existsSync(coverageScript)) {
    return {
      name: "gbrain edge_city coverage (delegated)",
      severity: "WARNING",
      passed: false,
      summary: "_coverage-gbrain-sidecar.ts missing",
    };
  }
  try {
    // --verbose surfaces the per-VM table so we can name specific missing
    // VMs in the report. Adds zero SSH cost (same probes either way; just
    // more rendered output to parse).
    const out = execSync(
      `npx tsx "${coverageScript}" --partner edge_city --verbose 2>&1`,
      {
        cwd: repoInstaclaw,
        timeout: 90_000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).toString();
    // Parse "gbrained N/M (P%)" line
    const m = out.match(/gbrained\s+(\d+)\/(\d+)\s+\((\d+)%\)/);
    if (!m) {
      return {
        name: "gbrain edge_city coverage (delegated)",
        severity: "WARNING",
        passed: false,
        summary: "could not parse coverage output",
        details: out.slice(-500),
      };
    }
    const got = parseInt(m[1], 10);
    const exp = parseInt(m[2], 10);
    const pct = parseInt(m[3], 10);

    // Extract per-VM rows for any non-gbrained status (missing_gbrain,
    // partial, missing_key, ssh_err). The verbose table prints status
    // tokens that we can recognize unambiguously.
    const missingVMs: { name: string; status: string }[] = [];
    const lines = out.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("instaclaw-vm-")) continue;
      const parts = t.split(/\s+/);
      const name = parts[0];
      // Coverage script's per-VM row sometimes concatenates status+arch (e.g.,
      // "missing_gbrainnone"). Match against known statuses.
      const tail = parts.slice(1).join(" ");
      const statusMatch = tail.match(/^(gbrained|missing_gbrain|missing_key|partial|ssh_err)/);
      const status = statusMatch?.[1] ?? "unknown";
      if (status !== "gbrained") missingVMs.push({ name, status });
    }

    return {
      name: "gbrain edge_city coverage 100% (Rule 35)",
      severity: "CRITICAL",
      passed: got === exp && pct === 100,
      summary: `${got}/${exp} (${pct}%) ${got === exp ? "✓" : "BELOW TARGET"}`,
      details:
        missingVMs.length > 0
          ? `Action needed for ${missingVMs.length} VM(s):\n` +
            missingVMs
              .slice(0, 10)
              .map(
                (v) =>
                  `  ${v.name} [${v.status}] → npx tsx scripts/_install-gbrain-on-vm.ts ${v.name}`
              )
              .join("\n")
          : undefined,
    };
  } catch (e: any) {
    return {
      name: "gbrain edge_city coverage (delegated)",
      severity: "WARNING",
      passed: false,
      summary: `script failed: ${e?.message ?? e}`,
    };
  }
}

async function checkFleetDiskUsage(
  sb: ReturnType<typeof createClient>
): Promise<CheckResult[]> {
  // Schema: instaclaw_vms.last_disk_pct (INT). Populated by cron/health-check
  // every cycle (Rule 46). VMs without a recent disk probe will be NULL.
  const { data: all } = await sb
    .from("instaclaw_vms")
    .select("name,last_disk_pct,health_status")
    .eq("health_status", "healthy")
    .eq("status", "assigned");
  const list = (all as any[]) || [];
  const withDisk = list.filter((v: any) => v.last_disk_pct != null);
  const out: CheckResult[] = [];

  // Coverage of the disk-probe itself. If fewer than half the fleet has a
  // populated last_disk_pct, the health-check cron isn't reaching them and
  // we can't make a fleet-wide claim.
  const coveragePct =
    list.length === 0 ? 0 : Math.round((withDisk.length / list.length) * 100);
  out.push({
    name: "disk-usage data coverage (Rule 46 health-check)",
    severity: "WARNING",
    passed: coveragePct >= 50,
    summary: `${withDisk.length}/${list.length} VMs reporting (${coveragePct}%)`,
    details:
      coveragePct < 50
        ? "Health-check cron may not be running disk probe on most VMs. Without coverage, fleet-wide disk pressure is invisible until a VM crashes."
        : undefined,
  });

  // Among VMs that DO have data, flag any over 80%. CRITICAL because they're
  // candidates for ENOSPC during the bake window.
  const high = withDisk.filter((v: any) => v.last_disk_pct >= 80);
  out.push({
    name: "no VMs with disk_pct ≥80% (Rule 46)",
    severity: "CRITICAL",
    passed: high.length === 0,
    summary:
      withDisk.length === 0
        ? "no data (see coverage check above)"
        : high.length === 0
          ? `✓ (max=${Math.max(...withDisk.map((v: any) => v.last_disk_pct))}%)`
          : `${high.length} VMs ≥80%`,
    details:
      high.length > 0
        ? high
            .sort((a: any, b: any) => b.last_disk_pct - a.last_disk_pct)
            .slice(0, 10)
            .map((v: any) => `  ${v.name}: ${v.last_disk_pct}%`)
            .join("\n")
        : undefined,
  });

  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Linode API reachable
// ──────────────────────────────────────────────────────────────────────────────
async function checkLinodeReachable(): Promise<CheckResult> {
  try {
    const token = process.env.LINODE_API_TOKEN;
    if (!token) {
      return {
        name: "Linode API reachable",
        severity: "CRITICAL",
        passed: false,
        summary: "LINODE_API_TOKEN not set",
      };
    }
    // /v4/account is the cheapest endpoint that proves token validity.
    // /v4/linode/instances?page_size=1 returns HTTP 400 because Linode's
    // min page_size is 25. Don't use it.
    const res = await fetch("https://api.linode.com/v4/account", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return {
        name: "Linode API reachable",
        severity: "CRITICAL",
        passed: false,
        summary: `HTTP ${res.status} on /v4/account — token may be invalid`,
      };
    }
    const json: any = await res.json();
    return {
      name: "Linode API reachable",
      severity: "CRITICAL",
      passed: true,
      summary: `OK (account=${json.email ?? "?"})`,
    };
  } catch (e: any) {
    return {
      name: "Linode API reachable",
      severity: "CRITICAL",
      passed: false,
      summary: `connect failed: ${e?.message ?? e}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Cooper-action items (always info, never blocking — flag for operator)
// ──────────────────────────────────────────────────────────────────────────────
function cooperActionReminders(): CheckResult[] {
  return [
    {
      name: "Anthropic project-key spending cap ($300/mo on GBRAIN_ANTHROPIC_API_KEY)",
      severity: "INFO",
      passed: true,
      summary:
        "manual verify at console.anthropic.com — script cannot check API console",
    },
    {
      name: "vm-354 30-min soak (§2.1 checklist)",
      severity: "INFO",
      passed: true,
      summary:
        "manual verify the 5 soak checks on vm-354 — service active, bearer hash match, schema v66, put_page/get_page round-trip, openclaw.json transport=streamable-http",
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Reporter
// ──────────────────────────────────────────────────────────────────────────────
function report(): number {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("        SNAPSHOT BAKE PRE-FLIGHT — GO/NO-GO VERDICT");
  console.log("═══════════════════════════════════════════════════════════════════");

  const groups: Record<Severity, CheckResult[]> = {
    CRITICAL: [],
    WARNING: [],
    INFO: [],
  };
  for (const r of results) groups[r.severity].push(r);

  function dump(sev: Severity) {
    if (groups[sev].length === 0) return;
    console.log("");
    console.log(`── ${sev} ──`);
    for (const r of groups[sev]) {
      const icon = r.passed ? "✓" : "✗";
      console.log(`  ${icon} ${r.name}`);
      console.log(`      ${r.summary}`);
      if ((VERBOSE || !r.passed) && r.details) {
        for (const line of r.details.split("\n"))
          console.log(`      ${line}`);
      }
    }
  }

  dump("CRITICAL");
  dump("WARNING");
  dump("INFO");

  const criticalFails = groups.CRITICAL.filter((r) => !r.passed);
  const warningFails = groups.WARNING.filter((r) => !r.passed);

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  if (criticalFails.length > 0) {
    console.log(`  ❌ NO-GO — ${criticalFails.length} CRITICAL blocker(s):`);
    for (const r of criticalFails) console.log(`     • ${r.name}`);
    console.log("");
    console.log("  Resolve all CRITICAL blockers before provisioning the bake VM.");
    console.log("═══════════════════════════════════════════════════════════════════");
    return 1;
  }
  if (warningFails.length > 0) {
    console.log(`  ⚠  GO WITH CAUTION — ${warningFails.length} WARNING(s):`);
    for (const r of warningFails) console.log(`     • ${r.name}`);
    console.log("");
    console.log("  Critical gates pass. Warnings are non-fatal but operator should");
    console.log("  review them before proceeding.");
    console.log("═══════════════════════════════════════════════════════════════════");
    return 0;
  }
  console.log("  ✅ GO — every gate passed.");
  console.log("═══════════════════════════════════════════════════════════════════");
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const t0 = Date.now();

  // Repo-state checks (synchronous, fast)
  push(checkHeadAlignedWithMain());
  push(checkIntegrityFixLanded());
  push(checkEnvVarsPresent());
  // 2026-05-22 incident response: value validation, not just presence.
  for (const r of checkBooleanEnvVarValues()) push(r);
  // 2026-05-24 CDP backup wallet restoration (Cooper P0).
  for (const r of checkCdpReadiness()) push(r);
  push(checkLinodeSnapshotMatch());

  const manifestCheck = checkManifestVersion();
  push(manifestCheck);
  const manifestMatch = manifestCheck.summary.match(/v(\d+)/);
  const manifestVersion = manifestMatch ? parseInt(manifestMatch[1], 10) : null;

  push(checkGbrainPinnedAlignment());
  push(checkGbrainInstallScriptsSyntax());

  // Async checks — Supabase (bail if not reachable)
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    push({
      name: "Supabase reachable",
      severity: "CRITICAL",
      passed: false,
      summary: "Supabase env vars not loaded — can't run fleet checks",
    });
    return report();
  }
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const sbCheck = await checkSupabaseReachable(sb);
  push(sbCheck);
  if (!sbCheck.passed) {
    return 2;
  }

  // Fleet checks
  const cvResults = await checkFleetCvDistribution(sb, manifestVersion);
  for (const r of cvResults) push(r);

  push(await checkQuarantinedVMs(sb));
  push(await checkStaleCronLocks(sb));

  const alertResults = await checkAdminAlerts(sb);
  for (const r of alertResults) push(r);

  // Linode API
  push(await checkLinodeReachable());

  // Fleet disk usage (Rule 46) — coverage + high-usage flags
  for (const r of await checkFleetDiskUsage(sb)) push(r);

  // gbrain edge_city coverage (delegated, slowest — ~3s)
  push(await checkGbrainEdgeCityCoverage());

  // Cooper-action reminders
  for (const r of cooperActionReminders()) push(r);

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  push({
    name: "wall-clock",
    severity: "INFO",
    passed: true,
    summary: `${elapsedSec}s`,
  });

  return report();
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL:", e?.stack || e);
    process.exit(2);
  });
