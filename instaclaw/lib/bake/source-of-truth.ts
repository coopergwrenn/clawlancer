/**
 * lib/bake/source-of-truth.ts — Runtime extraction of pins/manifest/env vars.
 *
 * The autonomous bake reads its configuration LIVE from source files at
 * preflight, rather than hardcoding values. This means:
 *
 *   - Pin bumps in lib/vm-reconcile.ts are auto-picked-up
 *   - Manifest version is read fresh from lib/vm-manifest.ts
 *   - New env vars referenced in lib/vm-reconcile.ts are detected
 *
 * Per design doc §2.4. Drift detection (comparing today's values to last
 * bake's fingerprint) lives in `lib/bake/drift.ts` (called from preflight).
 *
 * Extraction uses regex against source text. Alternative considered:
 * dynamic `import()` of the TS module. Rejected because:
 *   (a) Importing vm-reconcile.ts at orchestrator runtime spins up all its
 *       transitive imports (Supabase client, manifest, etc.) — slow + can fail
 *       on missing env vars unrelated to bake.
 *   (b) Regex is forwards-compatible: a future refactor that re-exports
 *       the pin under a new symbol doesn't break us.
 *   (c) Drift detection is easier on string content than on parsed AST.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";

// ─── Source file paths (relative to the instaclaw/ directory) ────────────────

const SRC = {
  vmReconcile: "lib/vm-reconcile.ts",
  vmManifest: "lib/vm-manifest.ts",
  ssh: "lib/ssh.ts",
  workspaceTemplatesV2: "lib/workspace-templates-v2.ts",
  installGbrain: "scripts/install-gbrain.sh",
} as const;

function readSource(repoRoot: string, relPath: string): string {
  const full = resolve(repoRoot, relPath);
  if (!existsSync(full)) throw new Error(`Source file not found: ${full}`);
  return readFileSync(full, "utf-8");
}

// ─── Pin extraction ──────────────────────────────────────────────────────────

/**
 * Extract a top-level `const NAME = "value"` (or numeric) from a TS source.
 * Returns null if absent. Throws on multiple matches (ambiguous).
 *
 * Looks for `const NAME = "..."` OR `const NAME = '...'` OR `const NAME = N;`.
 * Skips lines beginning with `//` (single-line comments — multi-line comments
 * containing fake declarations are an unhandled edge case but unlikely in practice).
 */
export function extractConst(source: string, name: string): string | null {
  // First try string literal
  const stringPat = new RegExp(`^const\\s+${name}\\s*(?::\\s*[^=]+)?=\\s*["']([^"']*)["']`, "m");
  const stringMatches = [...source.matchAll(new RegExp(stringPat.source, "gm"))];
  // Filter out matches inside JSDoc/comment blocks (heuristic: line not starting with //)
  const filtered = stringMatches.filter((m) => {
    const lineStart = source.lastIndexOf("\n", m.index ?? 0) + 1;
    const line = source.slice(lineStart, m.index ?? 0);
    return !line.trim().startsWith("//") && !line.trim().startsWith("*");
  });
  if (filtered.length > 1) {
    throw new Error(`Ambiguous: ${filtered.length} matches for const ${name}`);
  }
  if (filtered.length === 1) return filtered[0][1];

  // Try numeric literal
  const numPat = new RegExp(`^const\\s+${name}\\s*(?::\\s*[^=]+)?=\\s*(\\d+(?:\\.\\d+)?)`, "m");
  const numMatch = source.match(numPat);
  if (numMatch) return numMatch[1];

  return null;
}

/** Extract `version: NNN` from `export const VM_MANIFEST = { ... version: NNN, ... }`. */
export function extractManifestVersion(source: string): number | null {
  // Find the VM_MANIFEST object literal start.
  const startMatch = source.match(/export\s+const\s+VM_MANIFEST\s*=\s*\{/);
  if (!startMatch) return null;
  const after = source.slice((startMatch.index ?? 0) + startMatch[0].length);
  // Look for `version: <num>` in the next 1000 chars (top-level of the object).
  const verMatch = after.slice(0, 5000).match(/^\s*version:\s*(\d+)/m);
  if (!verMatch) return null;
  return parseInt(verMatch[1], 10);
}

/**
 * Extract the set literal `new Set([...])` for a const declaration.
 * Returns the contents as a string array (string-literal values only).
 */
export function extractStringSet(source: string, name: string): string[] {
  const pat = new RegExp(
    `const\\s+${name}\\s*(?::\\s*[^=]+)?=\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
    "m",
  );
  const match = source.match(pat);
  if (!match) return [];
  const inner = match[1];
  const items = [...inner.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  return items;
}

// ─── Aggregate: capture all source pins at preflight ─────────────────────────

export interface SourcePins {
  gbrain_commit: string;
  gbrain_version: string;
  manifest_version: number;
  openclaw_pinned_version: string | null;
  node_version: string | null;
  bootstrap_max_chars: number;
  secret_version: number | null;
  gbrain_partner_allowlist: string[];
}

/**
 * Read every bake-relevant pin from source. Throws if any required pin
 * is unreadable (preflight catches and reports).
 */
export function readSourcePins(repoRoot: string): SourcePins {
  const reconcileSrc = readSource(repoRoot, SRC.vmReconcile);
  const manifestSrc = readSource(repoRoot, SRC.vmManifest);

  const gbrain_commit = extractConst(reconcileSrc, "GBRAIN_PINNED_COMMIT");
  if (!gbrain_commit) {
    throw new Error("GBRAIN_PINNED_COMMIT not found in lib/vm-reconcile.ts");
  }
  const gbrain_version = extractConst(reconcileSrc, "GBRAIN_PINNED_VERSION");
  if (!gbrain_version) {
    throw new Error("GBRAIN_PINNED_VERSION not found in lib/vm-reconcile.ts");
  }
  const manifest_version = extractManifestVersion(manifestSrc);
  if (manifest_version === null) {
    throw new Error("VM_MANIFEST.version not found in lib/vm-manifest.ts");
  }
  const openclaw_pinned_version = extractConst(reconcileSrc, "OPENCLAW_PINNED_VERSION");
  const node_version = extractConst(manifestSrc, "NODE_VERSION");
  const bootstrap_max_chars_raw = extractConst(manifestSrc, "BOOTSTRAP_MAX_CHARS");
  const bootstrap_max_chars = bootstrap_max_chars_raw ? parseInt(bootstrap_max_chars_raw, 10) : 40000;
  const secret_version_raw = extractConst(reconcileSrc, "SECRET_VERSION");
  const secret_version = secret_version_raw ? parseInt(secret_version_raw, 10) : null;
  const gbrain_partner_allowlist = extractStringSet(reconcileSrc, "GBRAIN_PARTNER_ALLOWLIST");

  return {
    gbrain_commit,
    gbrain_version,
    manifest_version,
    openclaw_pinned_version,
    node_version,
    bootstrap_max_chars,
    secret_version,
    gbrain_partner_allowlist,
  };
}

// ─── Env-var reference detection ─────────────────────────────────────────────

export interface EnvVarRef {
  name: string;
  file: string;
  line: number;
  context: string;
}

/**
 * Find every `process.env.X` reference in bake-relevant source files.
 * Used for drift detection: if a future terminal adds `process.env.NEW_FLAG`,
 * we want to alert.
 */
export function detectEnvVarReferences(repoRoot: string): EnvVarRef[] {
  const files = [SRC.vmReconcile, SRC.ssh, SRC.installGbrain];
  const refs: EnvVarRef[] = [];
  for (const rel of files) {
    const full = resolve(repoRoot, rel);
    if (!existsSync(full)) continue;
    const src = readFileSync(full, "utf-8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // TypeScript: process.env.NAME, process.env["NAME"]
      // Shell: ${NAME:?...}, : "${NAME:?...}"
      const matches = [
        ...line.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g),
        ...line.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g),
        ...line.matchAll(/:\s*"\$\{([A-Z][A-Z0-9_]+):/g),
      ];
      for (const m of matches) {
        refs.push({
          name: m[1],
          file: rel,
          line: i + 1,
          context: line.trim().slice(0, 120),
        });
      }
    }
  }
  return refs;
}

/** Distinct env-var names referenced (sorted). */
export function distinctEnvVars(refs: EnvVarRef[]): string[] {
  const set = new Set(refs.map((r) => r.name));
  return [...set].sort();
}

// ─── Reconciler hash (drift detection) ───────────────────────────────────────

/**
 * Hash the body of reconcileVM() — the orchestrator function in lib/vm-reconcile.ts.
 * If this changes between bakes, we want to know (new step added, existing step changed).
 *
 * Implementation: find `export async function reconcileVM(`, capture lines
 * until the matching `^}` at column 0. Hash the captured text with SHA-256.
 */
export function hashReconcilerOrchestrator(repoRoot: string): string {
  const src = readSource(repoRoot, SRC.vmReconcile);
  const startMatch = src.match(/^export\s+async\s+function\s+reconcileVM\s*\(/m);
  if (!startMatch) {
    throw new Error("reconcileVM function not found in lib/vm-reconcile.ts");
  }
  const startIdx = startMatch.index ?? 0;
  const after = src.slice(startIdx);
  // Find the matching close brace at column 0.
  const closeMatch = after.match(/^\}/m);
  if (!closeMatch) {
    throw new Error("Could not find closing brace of reconcileVM");
  }
  const body = after.slice(0, (closeMatch.index ?? 0) + 1);
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Hash all `currentStep = "..."` assignments in lib/vm-reconcile.ts.
 * More targeted than hashReconcilerOrchestrator — catches step additions/
 * removals while ignoring unrelated edits inside step bodies.
 */
export function hashReconcilerStepSequence(repoRoot: string): {
  hash: string;
  step_count: number;
  step_ids: string[];
} {
  const src = readSource(repoRoot, SRC.vmReconcile);
  const steps = [...src.matchAll(/currentStep\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const hash = createHash("sha256").update(steps.join("\n")).digest("hex");
  return { hash, step_count: steps.length, step_ids: steps };
}

// ─── v106 landing detection ──────────────────────────────────────────────────

export interface V106Detection {
  path: "A" | "B";
  detected_signals: {
    step_present: boolean;
    constant_present: boolean;
    manifest_at_106_or_higher: boolean;
  };
}

/**
 * Detect whether v106 (stepDeployGbrainSoulRouting) has landed.
 *
 * Path A = landed (all three signals positive).
 * Path B = not yet landed (any signal absent).
 *
 * Per design doc §2.6.6.
 */
export function detectV106Landing(repoRoot: string): V106Detection {
  const reconcileSrc = readSource(repoRoot, SRC.vmReconcile);
  const templatesSrc = (() => {
    try {
      return readSource(repoRoot, SRC.workspaceTemplatesV2);
    } catch {
      return "";
    }
  })();
  const manifestSrc = readSource(repoRoot, SRC.vmManifest);

  const step_present = /stepDeployGbrainSoulRouting/.test(reconcileSrc);
  const constant_present = /GBRAIN_SOUL_ROUTING_V1_(BEGIN|SECTION|MARKER)/.test(templatesSrc);
  const manifest_version = extractManifestVersion(manifestSrc) ?? 0;
  const manifest_at_106_or_higher = manifest_version >= 106;

  const path: "A" | "B" =
    step_present && constant_present && manifest_at_106_or_higher ? "A" : "B";

  return {
    path,
    detected_signals: { step_present, constant_present, manifest_at_106_or_higher },
  };
}
