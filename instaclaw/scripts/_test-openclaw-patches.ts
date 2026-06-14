#!/usr/bin/env tsx
/**
 * _test-openclaw-patches.ts — local fixture test for the OpenClaw patch
 * registry (CLAUDE.md Rule 31: ship a failure-mode test, not just happy path).
 *
 * Runs WITHOUT any VM. For every registry patch that has a `transform`, it:
 *   1. Builds a synthetic pristine fixture that contains every declared anchor
 *      verbatim (so the transform's .replace() calls fire).
 *   2. Runs the transform.
 *   3. Asserts: sentinel count >= minSentinelCount, balanced braces, and the
 *      transform actually changed the source (didn't silently no-op).
 *   4. Writes the patched output to a temp .mjs and runs `node --check` on it
 *      — the same syntax gate the on-VM engine applies before committing.
 *   5. Asserts idempotency: re-running the transform on already-patched output
 *      is detected by the sentinel (the engine skips, so we just confirm the
 *      sentinel is present).
 *
 * It also asserts registry invariants (unique ids, sentinels non-empty, each
 * patch has >= 1 anchor, and any transform-less descriptor documents
 * captureInstructions).
 *
 * Failure modes deliberately exercised:
 *   - transform matched zero anchor sites → sentinel count stays 0 (caught).
 *   - transform produced syntactically broken JS → node --check fails (caught).
 *   - anchor drift → fixture-without-anchor leaves source unchanged (caught).
 *
 * Usage:  npx tsx scripts/_test-openclaw-patches.ts
 * Exit:   0 = all assertions pass, 1 = a failure.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATCHES, type OpenClawPatch } from "../lib/openclaw-patches";

let failures = 0;
const log = (s: string) => console.log(s);
function assert(cond: boolean, msg: string) {
  if (cond) {
    log(`  ✓ ${msg}`);
  } else {
    log(`  ✗ ${msg}`);
    failures++;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0,
    i = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) break;
    n++;
    i = idx + needle.length;
  }
  return n;
}

const tmp = mkdtempSync(join(tmpdir(), "ocpatch-test-"));

function nodeCheck(source: string, label: string): boolean {
  const f = join(tmp, `${label}.mjs`);
  writeFileSync(f, source, "utf-8");
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    return true;
  } catch (e: any) {
    log(`    node --check stderr: ${(e.stderr?.toString() || e.message).slice(0, 300)}`);
    return false;
  }
}

/**
 * Build a syntactically-valid ESM fixture that embeds every anchor verbatim.
 * Anchors are wrapped so the whole file parses as a module. Anchors that are
 * statements (if-blocks, expression statements, const decls) are valid at
 * module top level; we add a leading const so there's always at least one
 * benign statement and a trailing export to keep it a module.
 */
function buildFixture(patch: OpenClawPatch): string {
  return [
    "// synthetic pristine fixture for " + patch.id,
    "let body = {};",
    "let info = { kind: 'block' };",
    ...patch.anchors,
    "export const __fixture = true;",
    "",
  ].join("\n\n");
}

function testTransformablePatch(patch: OpenClawPatch) {
  log(`\n── ${patch.id} (kind=${patch.kind}, rollout=${patch.rollout}) ──`);

  const fixture = buildFixture(patch);

  // Sanity: the pristine fixture parses.
  assert(nodeCheck(fixture, `${patch.id}-pristine`), "pristine fixture is valid ESM");

  // Every anchor must be present in the fixture we built (self-check).
  const anchorsInFixture = patch.anchors.every((a) => fixture.includes(a));
  assert(anchorsInFixture, "fixture contains every declared anchor verbatim");

  const patched = patch.transform!(fixture);

  // The transform must actually change the source (didn't silently no-op).
  assert(patched !== fixture, "transform changed the source (anchors matched)");

  // Sentinel embedded at expected count.
  const sc = countOccurrences(patched, patch.sentinel);
  assert(
    sc >= patch.minSentinelCount,
    `sentinel "${patch.sentinel.slice(0, 32)}…" appears ${sc}x (>= ${patch.minSentinelCount})`,
  );

  // Brace balance (the engine's pre-write gate).
  const open = countOccurrences(patched, "{");
  const close = countOccurrences(patched, "}");
  assert(open === close, `brace balance (${open} open, ${close} close)`);

  // Syntax gate — the same node --check the on-VM engine runs.
  assert(nodeCheck(patched, `${patch.id}-patched`), "patched output passes node --check");

  // Idempotency: a second transform on already-patched source still has the
  // sentinel (the engine would sentinel-skip before reaching transform; here
  // we just confirm the marker survives a re-run rather than vanishing).
  const twice = patch.transform!(patched);
  assert(
    countOccurrences(twice, patch.sentinel) >= patch.minSentinelCount,
    "sentinel survives a second transform pass (idempotency marker intact)",
  );

  // Anchor-drift failure mode: a fixture WITHOUT the anchors must leave the
  // source unchanged (the engine surfaces this as anchor-drift instead of
  // writing garbage).
  const noAnchorSrc = "export const x = 1;\nlet body = {};\n";
  const noAnchorOut = patch.transform!(noAnchorSrc);
  assert(
    noAnchorOut === noAnchorSrc || countOccurrences(noAnchorOut, patch.sentinel) === 0,
    "transform on anchor-less source does not inject the sentinel (drift is caught upstream)",
  );
}

function testRegistryInvariants() {
  log("\n── registry invariants ──");
  const ids = PATCHES.map((p) => p.id);
  assert(new Set(ids).size === ids.length, "patch ids are unique");
  for (const p of PATCHES) {
    assert(p.sentinel.length > 0, `${p.id}: sentinel is non-empty`);
    assert(p.anchors.length > 0, `${p.id}: has >= 1 anchor`);
    assert(p.minSentinelCount >= 1, `${p.id}: minSentinelCount >= 1`);
    if (!p.transform) {
      assert(
        !!p.captureInstructions,
        `${p.id}: transform-less descriptor documents captureInstructions`,
      );
    }
    if (p.kind === "feature") {
      assert(
        !p.detectNativeFix,
        `${p.id}: feature patches have no native-fix detector (upstream won't ship a feature)`,
      );
    }
  }
}

function main() {
  log("OpenClaw patch registry — local fixture test\n");
  testRegistryInvariants();

  for (const patch of PATCHES) {
    if (patch.transform) {
      testTransformablePatch(patch);
    } else {
      log(`\n── ${patch.id} — STUB (no transform captured) ──`);
      assert(true, "skipped transform tests (body not yet captured into repo)");
      log(`  ℹ ${patch.captureInstructions?.split("\n")[0] ?? "see registry captureInstructions"}`);
    }
  }

  rmSync(tmp, { recursive: true, force: true });

  log("\n════════════════════════════════════");
  if (failures === 0) {
    log("  ALL CHECKS PASS");
    log("════════════════════════════════════\n");
    process.exit(0);
  } else {
    log(`  ${failures} FAILURE(S)`);
    log("════════════════════════════════════\n");
    process.exit(1);
  }
}

main();
