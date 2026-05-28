#!/usr/bin/env -S npx tsx
/**
 * Synthetic-fixture test for stepDeployGbrainSoulProtocol's content-drift logic.
 *
 * Mirrors `_test-base-defi-routing-content-drift.ts` but exercises the
 * gbrain Python — which differs in two important ways:
 *
 *   1. gbrain's canonical block (GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK)
 *      starts with `---\n\n` and ends with `\n\n---` (markdown separators
 *      baked into the canonical content). Base-defi's canonical block is
 *      purely marker-bounded.
 *   2. So the gbrain REPLACE path splices the *interior* of canonical
 *      (stripped of those `---` separators) between markers on disk —
 *      leaving the on-disk separators undisturbed. This test verifies
 *      that behavior.
 *
 * Extracts the production Python literally from `lib/vm-reconcile.ts`
 * (so test == prod) via regex slice, applies the same TS-template-literal
 * escape transformation `_test-base-defi-routing-content-drift.ts` uses,
 * runs against 8 synthetic AGENTS.md states.
 *
 * Run: npx tsx instaclaw/scripts/_test-gbrain-soul-protocol-content-drift.ts
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK,
  GBRAIN_MEMORY_PROTOCOL_V1_MARKER,
  GBRAIN_MEMORY_PROTOCOL_V1_END_MARKER,
} from "../lib/workspace-templates-v2";

// ── Extract the gbrain PATCH_PY body from lib/vm-reconcile.ts ─────────────────
const SRC = readFileSync(
  join(__dirname, "..", "lib", "vm-reconcile.ts"),
  "utf-8",
);
// The unique anchor for the gbrain Python is the canonical_interior comment
// that distinguishes the gbrain function from base-defi. Locate the function
// declaration first, then the PATCH_PY string literal inside it.
const GBRAIN_FN = "async function stepDeployGbrainSoulProtocol";
const fnIdx = SRC.indexOf(GBRAIN_FN);
if (fnIdx < 0) {
  console.error("FATAL: stepDeployGbrainSoulProtocol not found in lib/vm-reconcile.ts");
  process.exit(2);
}
// Scan forward from the function start for `const PATCH_PY = \``.
const pyStart = SRC.indexOf("const PATCH_PY = `", fnIdx);
if (pyStart < 0) {
  console.error("FATAL: PATCH_PY string literal not found inside stepDeployGbrainSoulProtocol");
  process.exit(2);
}
// Find the closing backtick + semicolon.
const pyEnd = SRC.indexOf("`;", pyStart + "const PATCH_PY = `".length);
if (pyEnd < 0) {
  console.error("FATAL: PATCH_PY closing backtick not found");
  process.exit(2);
}
const raw = SRC.slice(pyStart + "const PATCH_PY = `".length, pyEnd);

// Apply the same TS-template-literal escape transformation
// `_test-base-defi-routing-content-drift.ts` does: raw `\\n` → JS-evaluated
// `\n` so Python parses it as the newline escape.
const PATCH_PY = raw
  .replace(/\\\\n/g, "\\n")
  .replace(/\\\\\\\\/g, "\\\\")
  .replace(/\\\\`/g, "`"); // `\\\`` in TS template literal → `\`` in JS string → backtick in Python

// ── Constants for fixtures ───────────────────────────────────────────────────
const BEGIN = GBRAIN_MEMORY_PROTOCOL_V1_MARKER;
const END = GBRAIN_MEMORY_PROTOCOL_V1_END_MARKER;
const CANONICAL = GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK;
const ANCHOR = "## Memory Protocol";

// Canonical INTERIOR — the marker-bounded portion of canonical_block (no `---`
// outer separators). This is what the new logic compares for drift detection
// and splices on REPLACE.
const canonicalBeginIdx = CANONICAL.indexOf(BEGIN);
const canonicalEndIdx = CANONICAL.indexOf(END);
if (canonicalBeginIdx < 0 || canonicalEndIdx < 0) {
  console.error("FATAL: canonical block doesn't contain its own markers");
  process.exit(2);
}
const CANONICAL_INTERIOR = CANONICAL.slice(canonicalBeginIdx, canonicalEndIdx + END.length);

// A stale interior (simulates drift).
const STALE_INTERIOR = `${BEGIN}
## Memory Protocol — gbrain (stale version — without anti-hallucination directive)

**gbrain is your long-term memory store.** Use put_page.
${END}`;

// ── Test harness ──────────────────────────────────────────────────────────────
interface TestCase {
  name: string;
  setup: () => { agentsContent: string | null };
  expectStatus: string;
  expectInsertedAt?: string;
  expectBeginPresent?: boolean;
  expectEndPresent?: boolean;
}

const TESTS: TestCase[] = [
  {
    name: "1. missing — no AGENTS.md file",
    setup: () => ({ agentsContent: null }),
    expectStatus: "missing",
  },
  {
    name: "2. insert with anchor present",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n## Some Earlier Section\n\nfoo\n\n${ANCHOR}\n\nfiles read at session start\n`,
    }),
    expectStatus: "inserted",
    expectInsertedAt: "before-header",
  },
  {
    name: "3. insert with NO anchor (EOF fallback)",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n## Random Content\n\nno memory protocol header\n`,
    }),
    expectStatus: "inserted",
    expectInsertedAt: "appended-eof",
  },
  {
    name: "4. malformed — only begin marker present",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n${BEGIN}\n## leftover with no end\n\n${ANCHOR}\n`,
    }),
    expectStatus: "malformed",
    expectBeginPresent: true,
    expectEndPresent: false,
  },
  {
    name: "5. malformed — only end marker present",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\nsome leftover${END}\n\n${ANCHOR}\n`,
    }),
    expectStatus: "malformed",
    expectBeginPresent: false,
    expectEndPresent: true,
  },
  {
    name: "6. already-correct — markers + interior matches canonical interior",
    setup: () => ({
      // The on-disk file has `---\n\n` and `\n\n---` surrounding the markers
      // (from a prior insert), and the interior matches canonical_interior.
      agentsContent: `# AGENTS.md\n\n## Intro\n\n---\n\n${CANONICAL_INTERIOR}\n\n---\n\n${ANCHOR}\n`,
    }),
    expectStatus: "already-correct",
  },
  {
    name: "7. drift → replace — markers present, stale interior",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n## Intro\n\n---\n\n${STALE_INTERIOR}\n\n---\n\n${ANCHOR}\n`,
    }),
    expectStatus: "replaced",
  },
];

interface RunResult {
  status: string;
  fullJson: any;
  exitCode: number;
  finalContent: string | null;
}

function runPython(agentsContent: string | null): RunResult {
  const tmp = mkdtempSync(join(tmpdir(), "test-gbrain-"));
  const agentsPath = join(tmp, "AGENTS.md");
  const backupPath = join(tmp, "backups", `${Date.now()}`, "AGENTS.md");
  const scriptPath = join(tmp, "patch.py");

  try {
    if (agentsContent !== null) {
      writeFileSync(agentsPath, agentsContent);
    }
    writeFileSync(scriptPath, PATCH_PY);

    const cfg = JSON.stringify({
      agents_path: agentsPath,
      backup_path: backupPath,
      block: CANONICAL,
      begin_marker: BEGIN,
      end_marker: END,
      insert_before_header: ANCHOR,
    });

    const proc = spawnSync("python3", [scriptPath], {
      input: cfg,
      encoding: "utf-8",
      timeout: 10_000,
    });

    const lines = (proc.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    let parsed: any = {};
    try {
      parsed = JSON.parse(lastLine);
    } catch (e) {
      parsed = { _parseError: String(e), _raw: lastLine, _stderr: proc.stderr };
    }

    const finalContent = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : null;
    return {
      status: parsed.status ?? "<no-status>",
      fullJson: parsed,
      exitCode: proc.status ?? -1,
      finalContent,
    };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

// ── Run tests ─────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const test of TESTS) {
  const setup = test.setup();
  const result = runPython(setup.agentsContent);

  let ok = result.status === test.expectStatus;
  let detail = `status=${result.status} (exp ${test.expectStatus})`;

  if (ok && test.expectInsertedAt !== undefined) {
    if (result.fullJson.inserted_at !== test.expectInsertedAt) {
      ok = false;
      detail += `, inserted_at=${result.fullJson.inserted_at} (exp ${test.expectInsertedAt})`;
    }
  }
  if (ok && test.expectBeginPresent !== undefined) {
    if (result.fullJson.begin_present !== test.expectBeginPresent) {
      ok = false;
      detail += `, begin_present=${result.fullJson.begin_present} (exp ${test.expectBeginPresent})`;
    }
  }
  if (ok && test.expectEndPresent !== undefined) {
    if (result.fullJson.end_present !== test.expectEndPresent) {
      ok = false;
      detail += `, end_present=${result.fullJson.end_present} (exp ${test.expectEndPresent})`;
    }
  }

  // Extra check on INSERTED: confirm full canonical block (with separators) landed
  if (ok && test.expectStatus === "inserted" && result.finalContent !== null) {
    if (!result.finalContent.includes(CANONICAL)) {
      ok = false;
      detail += `, post-write file MISSING canonical block (with separators)`;
    }
  }

  // Extra check on REPLACED: confirm canonical INTERIOR is in final file
  // AND the surrounding `---` separators from disk are PRESERVED (not duplicated).
  if (ok && test.expectStatus === "replaced" && result.finalContent !== null) {
    if (!result.finalContent.includes(CANONICAL_INTERIOR)) {
      ok = false;
      detail += `, post-replace MISSING canonical interior`;
    }
    if (result.finalContent.includes("stale version")) {
      ok = false;
      detail += `, post-replace STILL contains stale content`;
    }
    // Critical: confirm no duplicate `---\n\n---\n\n` sequence (would indicate
    // we accidentally inserted canonical_block's separators on top of the disk's).
    if (result.finalContent.includes("---\n\n---")) {
      ok = false;
      detail += `, post-replace has DUPLICATE --- separators`;
    }
  }

  if (ok) {
    pass++;
    console.log(`  ✓ ${test.name}`);
  } else {
    fail++;
    failures.push(
      `${test.name}: ${detail}\n    full output: ${JSON.stringify(result.fullJson)}`,
    );
    console.log(`  ✗ ${test.name}\n      ${detail}`);
  }
}

// ── Idempotency test: replace then re-run → already-correct ────────────────────
{
  const tmp = mkdtempSync(join(tmpdir(), "test-gbrain-idemp-"));
  const agentsPath = join(tmp, "AGENTS.md");
  const backupBase = join(tmp, "backups");
  const scriptPath = join(tmp, "patch.py");

  writeFileSync(
    agentsPath,
    `# AGENTS.md\n\n---\n\n${STALE_INTERIOR}\n\n---\n\n${ANCHOR}\n`,
  );
  writeFileSync(scriptPath, PATCH_PY);

  const baseCfg = {
    agents_path: agentsPath,
    block: CANONICAL,
    begin_marker: BEGIN,
    end_marker: END,
    insert_before_header: ANCHOR,
  };

  const cfg1 = JSON.stringify({ ...baseCfg, backup_path: join(backupBase, "1", "AGENTS.md") });
  const proc1 = spawnSync("python3", [scriptPath], {
    input: cfg1,
    encoding: "utf-8",
    timeout: 10_000,
  });
  const lines1 = (proc1.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const j1 = JSON.parse(lines1[lines1.length - 1] ?? "{}");

  const cfg2 = JSON.stringify({ ...baseCfg, backup_path: join(backupBase, "2", "AGENTS.md") });
  const proc2 = spawnSync("python3", [scriptPath], {
    input: cfg2,
    encoding: "utf-8",
    timeout: 10_000,
  });
  const lines2 = (proc2.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const j2 = JSON.parse(lines2[lines2.length - 1] ?? "{}");

  if (j1.status === "replaced" && j2.status === "already-correct") {
    pass++;
    console.log(`  ✓ 8. idempotency — replace then re-run gives already-correct`);
  } else {
    fail++;
    failures.push(
      `8. idempotency: first=${j1.status} (exp replaced), second=${j2.status} (exp already-correct)`,
    );
    console.log(
      `  ✗ 8. idempotency — first=${j1.status}, second=${j2.status}`,
    );
  }

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log("");
console.log(`Summary: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
process.exit(0);
