#!/usr/bin/env -S npx tsx
/**
 * Synthetic-fixture test for stepDeployBaseDefiRouting's content-drift logic.
 *
 * Why this file exists: 2026-05-28 we discovered stepDeployBaseDefiRouting was
 * INSERT-only (silently no-op'd on any content update once the BASE_DEFI_ROUTING_V1
 * markers were on disk). The fix introduced REPLACE-on-drift semantics. This test
 * exercises the new Python logic against 6 synthetic AGENTS.md states locally —
 * no SSH, no VMs, no Vercel — so we catch logic bugs BEFORE fleet rollout.
 *
 * How: extracts the literal Python script body from the running production
 * source (lib/vm-reconcile.ts:stepDeployBaseDefiRouting) so test == prod, runs
 * it against synthetic AGENTS.md fixtures via stdin, asserts on output JSON.
 *
 * Test matrix:
 *   1. missing       — AGENTS.md doesn't exist                 → expects: missing
 *   2. insert-anchor — empty markers, anchor header present     → expects: inserted/before-header
 *   3. insert-eof    — empty markers, anchor header missing     → expects: inserted/appended-eof
 *   4. malformed-b   — only begin marker present                → expects: malformed
 *   5. malformed-e   — only end marker present                  → expects: malformed
 *   6. already-ok    — both markers + content matches canonical → expects: already-correct
 *   7. drift-replace — both markers + content differs           → expects: replaced
 *   8. idempotency   — after replace, re-run → already-correct (cron tick stability)
 *
 * Run: npx tsx instaclaw/scripts/_test-base-defi-routing-content-drift.ts
 *      Exit 0 on all-pass, non-zero on any failure.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  BASE_DEFI_ROUTING_V1_AGENTS_BLOCK,
  BASE_DEFI_ROUTING_V1_BEGIN_MARKER,
  BASE_DEFI_ROUTING_V1_END_MARKER,
  BASE_DEFI_ROUTING_V1_INSERT_BEFORE_HEADER,
} from "../lib/workspace-templates-v2";

// ── Extract the PATCH_PY body from lib/vm-reconcile.ts ────────────────────────
// This guarantees test == prod. If the source changes, the test runs against
// the new logic with no manual sync.
const SRC = readFileSync(
  join(__dirname, "..", "lib", "vm-reconcile.ts"),
  "utf-8",
);
const MARK_START = "// ── Content-drift-aware Python";
const MARK_END = "const scriptB64 = Buffer.from(PATCH_PY";

const startIdx = SRC.indexOf(MARK_START);
const endIdx = SRC.indexOf(MARK_END, startIdx);
if (startIdx < 0 || endIdx < 0) {
  console.error("FATAL: could not locate PATCH_PY in lib/vm-reconcile.ts");
  process.exit(2);
}
const segment = SRC.slice(startIdx, endIdx);
// Pull out everything between `const PATCH_PY = \`` and the next unescaped backtick.
const pyMatch = segment.match(/const PATCH_PY = `([\s\S]*?)`;/);
if (!pyMatch) {
  console.error("FATAL: could not extract PATCH_PY string literal");
  process.exit(2);
}
// Un-escape: the TS source has \\n (literally: backslash + backslash + n on
// disk) inside the template literal. JavaScript's template-literal evaluator
// converts every `\\` to a single backslash at module-load time, producing the
// string `split("\n")` (single backslash + n) which Python then parses as the
// newline escape. We bypass JS module-load by reading the raw source via fs,
// so we must apply that same un-escape ourselves. Targeted: only `\\n` and
// `\\\\` (the only template escapes used in this Python). If new escape kinds
// are added to PATCH_PY in the future, extend this map accordingly.
const PATCH_PY = pyMatch[1]
  .replace(/\\\\n/g, "\\n")      // `\\n` (3 chars in source) → `\n` (2 chars: backslash + n)
  .replace(/\\\\\\\\/g, "\\\\"); // `\\\\` (4 chars in source) → `\\` (2 chars: 2 backslashes)

// ── Test harness ──────────────────────────────────────────────────────────────
interface TestCase {
  name: string;
  setup: () => { agentsContent: string | null };
  expectStatus: string;
  expectInsertedAt?: string;
  expectBeginPresent?: boolean;
  expectEndPresent?: boolean;
}

const ANCHOR = BASE_DEFI_ROUTING_V1_INSERT_BEFORE_HEADER;
const CANONICAL = BASE_DEFI_ROUTING_V1_AGENTS_BLOCK;
const BEGIN = BASE_DEFI_ROUTING_V1_BEGIN_MARKER;
const END = BASE_DEFI_ROUTING_V1_END_MARKER;

// An older / different routing block (simulates drift).
const STALE_BLOCK = `${BEGIN}
## Base DeFi (stale version — no Smart-account section)

| Intent | Skill |
|---|---|
| Lend USDC | base-morpho |
| Swap | base-aerodrome |
${END}`;

const TESTS: TestCase[] = [
  {
    name: "1. missing — no AGENTS.md file",
    setup: () => ({ agentsContent: null }),
    expectStatus: "missing",
  },
  {
    name: "2. insert with anchor present",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n## Some Earlier Section\n\nfoo\n\n${ANCHOR}\n\nlist your crons here\n`,
    }),
    expectStatus: "inserted",
    expectInsertedAt: "before-header",
  },
  {
    name: "3. insert with NO anchor (EOF fallback)",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n## Random Content\n\nno anchor here\n`,
    }),
    expectStatus: "inserted",
    expectInsertedAt: "appended-eof",
  },
  {
    name: "4. malformed — only begin marker present",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n${BEGIN}\n## leftover content with no end\n\n${ANCHOR}\n`,
    }),
    expectStatus: "malformed",
    expectBeginPresent: true,
    expectEndPresent: false,
  },
  {
    name: "5. malformed — only end marker present",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\nsome content${END}\n\n${ANCHOR}\n`,
    }),
    expectStatus: "malformed",
    expectBeginPresent: false,
    expectEndPresent: true,
  },
  {
    name: "6. already-correct — markers + canonical content match",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n## Intro\n\n${CANONICAL}\n\n---\n\n${ANCHOR}\n`,
    }),
    expectStatus: "already-correct",
  },
  {
    name: "7. drift → replace — markers present, stale content",
    setup: () => ({
      agentsContent: `# AGENTS.md\n\n## Intro\n\n${STALE_BLOCK}\n\n---\n\n${ANCHOR}\n`,
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
  const tmp = mkdtempSync(join(tmpdir(), "test-bdr-"));
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
      parsed = { _parseError: String(e), _raw: lastLine };
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

  // Extra check on REPLACE / INSERTED: confirm canonical block is in final file
  if (
    ok &&
    (test.expectStatus === "inserted" || test.expectStatus === "replaced") &&
    result.finalContent !== null
  ) {
    if (!result.finalContent.includes(CANONICAL)) {
      ok = false;
      detail += `, post-write file MISSING canonical block`;
    }
  }

  // Extra check on REPLACE: confirm the stale block is GONE
  if (ok && test.expectStatus === "replaced" && result.finalContent !== null) {
    if (result.finalContent.includes("stale version")) {
      ok = false;
      detail += `, post-replace file STILL contains stale content`;
    }
  }

  if (ok) {
    pass++;
    console.log(`  ✓ ${test.name}`);
  } else {
    fail++;
    failures.push(`${test.name}: ${detail}\n    full output: ${JSON.stringify(result.fullJson)}`);
    console.log(`  ✗ ${test.name}\n      ${detail}`);
  }
}

// ── Idempotency test: replace then immediately re-run; second run should no-op ──
{
  const tmp = mkdtempSync(join(tmpdir(), "test-bdr-idemp-"));
  const agentsPath = join(tmp, "AGENTS.md");
  const backupBase = join(tmp, "backups");
  const scriptPath = join(tmp, "patch.py");

  writeFileSync(
    agentsPath,
    `# AGENTS.md\n\n${STALE_BLOCK}\n\n---\n\n${ANCHOR}\n`,
  );
  writeFileSync(scriptPath, PATCH_PY);

  // Run 1 — drift → replace
  const cfg1 = JSON.stringify({
    agents_path: agentsPath,
    backup_path: join(backupBase, "1", "AGENTS.md"),
    block: CANONICAL,
    begin_marker: BEGIN,
    end_marker: END,
    insert_before_header: ANCHOR,
  });
  const proc1 = spawnSync("python3", [scriptPath], {
    input: cfg1,
    encoding: "utf-8",
    timeout: 10_000,
  });
  const lines1 = (proc1.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const j1 = JSON.parse(lines1[lines1.length - 1] ?? "{}");

  // Run 2 — should be already-correct
  const cfg2 = JSON.stringify({
    agents_path: agentsPath,
    backup_path: join(backupBase, "2", "AGENTS.md"),
    block: CANONICAL,
    begin_marker: BEGIN,
    end_marker: END,
    insert_before_header: ANCHOR,
  });
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
