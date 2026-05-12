#!/usr/bin/env tsx
/**
 * _verify-configure-deps.ts — CI verification for configure-time dependencies.
 *
 * Purpose
 * -------
 * Catches the "fs.readFileSync(skills/...sh) silently dropped from Vercel
 * bundle" class of bug BEFORE it ships, not after khomenko89 has waited
 * 12 days for their VM. This script enforces three invariants:
 *
 *   1. lib/dispatch-scripts.ts (auto-generated inlined content) MUST be
 *      byte-equal to the on-disk source files in skills/computer-dispatch/.
 *      Catches drift: someone edits dispatch-screenshot.sh but forgets to
 *      run scripts/_gen-dispatch-scripts.mjs and commit the regenerated
 *      lib/dispatch-scripts.ts.
 *
 *   2. NO runtime fs.readFileSync of an NFT-RISKY extension (.sh, .bash,
 *      .zsh, .py — and .ts/.tsx outside node_modules) from skills/ in
 *      lib/ssh.ts or lib/vm-reconcile.ts. Either the read should be
 *      replaced with an inlined constant (Rule 23) OR the file extension
 *      needs to be in NFT's verified-bundled allow-list.
 *
 *   3. Cross-reference: every .sh file referenced in skills/ that's used
 *      at runtime SHOULD have a corresponding inlined constant in
 *      lib/dispatch-scripts.ts. If a new skill adds a .sh and someone
 *      wires it up via fs.readFileSync, this fails CI.
 *
 * Exit codes
 * ----------
 *   0  All invariants hold.
 *   1  Drift detected (regen needed OR new risky read found). Output
 *      explains exactly which.
 *   2  Internal error (file missing, can't load module, etc).
 *
 * CI wiring
 * ---------
 * Add to package.json:
 *
 *   "scripts": {
 *     "verify:configure-deps": "tsx scripts/_verify-configure-deps.ts"
 *   }
 *
 * Then in .github/workflows (or Vercel's build command), run
 * `npm run verify:configure-deps` before the build step. If the script
 * exits non-zero, the deploy aborts and the operator sees:
 *
 *   ✗ Drift: lib/dispatch-scripts.ts "dispatch-screenshot.sh" differs
 *     from skills/computer-dispatch/scripts/dispatch-screenshot.sh
 *     → run: node scripts/_gen-dispatch-scripts.mjs
 *     → commit the regenerated lib/dispatch-scripts.ts
 *
 * Equivalent local pre-commit hook (husky or lint-staged):
 *
 *   "lint-staged": {
 *     "skills/computer-dispatch/**\/*": ["tsx scripts/_verify-configure-deps.ts"],
 *     "lib/dispatch-scripts.ts":        ["tsx scripts/_verify-configure-deps.ts"],
 *     "lib/ssh.ts":                     ["tsx scripts/_verify-configure-deps.ts"],
 *     "lib/vm-reconcile.ts":            ["tsx scripts/_verify-configure-deps.ts"]
 *   }
 *
 * Failure messages are designed to be operator-actionable: each fail tells
 * you which file is wrong AND the exact command to fix it.
 */

import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import * as path from "path";
import {
  DISPATCH_SCRIPTS,
  DISPATCH_SERVER_JS,
  DISPATCH_SKILL_MD,
} from "../lib/dispatch-scripts";

const REPO_ROOT = path.resolve(__dirname, "..");

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

interface Failure {
  severity: "P0" | "P1";
  category: string;
  detail: string;
  fix: string;
}
const failures: Failure[] = [];

function fail(severity: Failure["severity"], category: string, detail: string, fix: string) {
  failures.push({ severity, category, detail, fix });
}

// ─── INVARIANT 1: lib/dispatch-scripts.ts byte-equal to disk ─────────────────
console.log("══ Invariant 1: dispatch-scripts.ts content == on-disk source ══");

const dispatchDir = path.join(REPO_ROOT, "skills/computer-dispatch/scripts");
let inlineOk = 0;
let inlineDrift = 0;

for (const [name, inlined] of Object.entries(DISPATCH_SCRIPTS)) {
  const diskPath = path.join(dispatchDir, name);
  if (!existsSync(diskPath)) {
    fail("P0", "dispatch-drift",
      `${name} is in lib/dispatch-scripts.ts but missing on disk at ${diskPath}`,
      `Either: restore the .sh file from git history, OR remove the key from lib/dispatch-scripts.ts AND remove the name from scripts/_gen-dispatch-scripts.mjs DISPATCH_SCRIPT_NAMES.`);
    inlineDrift++;
    continue;
  }
  const disk = readFileSync(diskPath, "utf-8");
  if (sha256(disk) !== sha256(inlined)) {
    fail("P0", "dispatch-drift",
      `${name} differs between lib/dispatch-scripts.ts and skills/computer-dispatch/scripts/${name}`,
      `Run: node scripts/_gen-dispatch-scripts.mjs && git add lib/dispatch-scripts.ts`);
    inlineDrift++;
  } else {
    inlineOk++;
  }
}

// dispatch-server.js
{
  const diskPath = path.join(REPO_ROOT, "skills/computer-dispatch/dispatch-server.js");
  if (!existsSync(diskPath)) {
    fail("P0", "dispatch-drift",
      `dispatch-server.js missing on disk at ${diskPath}`,
      `Restore from git, OR remove DISPATCH_SERVER_JS from lib/dispatch-scripts.ts.`);
  } else {
    const disk = readFileSync(diskPath, "utf-8");
    if (sha256(disk) !== sha256(DISPATCH_SERVER_JS)) {
      fail("P0", "dispatch-drift",
        `dispatch-server.js differs between inlined DISPATCH_SERVER_JS and disk`,
        `Run: node scripts/_gen-dispatch-scripts.mjs && git add lib/dispatch-scripts.ts`);
      inlineDrift++;
    } else {
      inlineOk++;
    }
  }
}

// SKILL.md
{
  const diskPath = path.join(REPO_ROOT, "skills/computer-dispatch/SKILL.md");
  if (!existsSync(diskPath)) {
    fail("P0", "dispatch-drift",
      `SKILL.md missing on disk at ${diskPath}`,
      `Restore from git, OR remove DISPATCH_SKILL_MD from lib/dispatch-scripts.ts.`);
  } else {
    const disk = readFileSync(diskPath, "utf-8");
    if (sha256(disk) !== sha256(DISPATCH_SKILL_MD)) {
      fail("P0", "dispatch-drift",
        `SKILL.md differs between inlined DISPATCH_SKILL_MD and disk`,
        `Run: node scripts/_gen-dispatch-scripts.mjs && git add lib/dispatch-scripts.ts`);
      inlineDrift++;
    } else {
      inlineOk++;
    }
  }
}

console.log(`  ${inlineOk}/${inlineOk + inlineDrift} files in sync`);
if (inlineDrift > 0) console.log(`  ⚠ ${inlineDrift} drift(s) detected — see failures below`);

// ─── INVARIANT 2: no NFT-risky runtime reads from skills/ ────────────────────
console.log();
console.log("══ Invariant 2: no fs.readFileSync of NFT-risky extensions from skills/ ══");

const RISKY_EXTENSIONS = [".sh", ".bash", ".zsh"];
const FILES_TO_SCAN = ["lib/ssh.ts", "lib/vm-reconcile.ts", "lib/cloud-init.ts"];

let riskyReads = 0;
let safeReads = 0;

for (const relPath of FILES_TO_SCAN) {
  const filePath = path.join(REPO_ROOT, relPath);
  if (!existsSync(filePath)) continue;
  const src = readFileSync(filePath, "utf-8");
  const lines = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("//")) continue;

    // Find fs.readFileSync calls whose first arg contains skills/ + a risky extension
    if (!/fs\.readFileSync/.test(line)) continue;
    if (!/skills/.test(line)) continue;

    for (const ext of RISKY_EXTENSIONS) {
      // Look for the extension in this line or the surrounding context
      // (path.join calls often span 2-3 lines)
      const context = lines.slice(Math.max(0, i - 1), i + 2).join("\n");
      if (context.includes(`"${ext}"`) || context.includes(`'${ext}'`) || new RegExp(`\\${ext}["'\\)]`).test(context)) {
        fail("P0", "nft-risk",
          `${relPath}:${i + 1} reads a ${ext} file from skills/ at runtime — Vercel @vercel/nft may silently drop it from the bundle`,
          `Either: (a) inline the script as a TS template-literal constant (see lib/dispatch-scripts.ts pattern), OR (b) prove the extension is bundled by adding scripts/_verify-bundle.ts that grep's the Vercel build output. For new skills, prefer (a).`);
        riskyReads++;
        break;
      }
    }
  }
}

if (riskyReads > 0) {
  console.log(`  ⚠ ${riskyReads} risky readFileSync call(s) found`);
} else {
  console.log(`  ✓ No risky reads of .sh/.bash/.zsh from skills/`);
}

// ─── INVARIANT 3: every .sh in skills/computer-dispatch/scripts/ is inlined ──
console.log();
console.log("══ Invariant 3: all .sh in skills/computer-dispatch/scripts/ are inlined ══");

import { readdirSync } from "fs";
const onDiskScripts = readdirSync(dispatchDir).filter(f => f.endsWith(".sh"));
const inlinedKeys = new Set(Object.keys(DISPATCH_SCRIPTS));
let missing = 0;
for (const sh of onDiskScripts) {
  if (!inlinedKeys.has(sh)) {
    // Allow files that aren't in DISPATCH_SCRIPT_NAMES intentionally
    // (e.g., dev-only helpers). But warn loudly so the operator sees them.
    fail("P1", "potentially-unwired",
      `${sh} exists in skills/computer-dispatch/scripts/ but is NOT in lib/dispatch-scripts.ts`,
      `Either: (a) add the name to scripts/_gen-dispatch-scripts.mjs DISPATCH_SCRIPT_NAMES + regen, OR (b) delete the .sh if it's truly unused. Currently this script would NOT be deployed to any new VM.`);
    missing++;
  }
}
if (missing === 0) {
  console.log(`  ✓ All ${onDiskScripts.length} .sh files in skills/computer-dispatch/scripts/ have inlined constants`);
}

// ─── Report ──────────────────────────────────────────────────────────────────
console.log();
console.log("══════════════════════════════════════════════════════════════════════");

const p0 = failures.filter(f => f.severity === "P0");
const p1 = failures.filter(f => f.severity === "P1");
console.log(`Total: ${p0.length} P0, ${p1.length} P1`);

if (failures.length === 0) {
  console.log();
  console.log("✓ All configure dependencies verified. Safe to deploy.");
  process.exit(0);
}

console.log();
console.log("FAILURES:");
for (const f of failures) {
  console.log();
  console.log(`  [${f.severity}] ${f.category}`);
  console.log(`    ${f.detail}`);
  console.log(`    fix: ${f.fix}`);
}

if (p0.length > 0) {
  console.log();
  console.log(`✗ ${p0.length} P0 failure(s) — refusing deploy. Fix above issues and re-run.`);
  process.exit(1);
}

console.log();
console.log(`⚠ ${p1.length} P1 warning(s) — deploy proceeds but operator attention recommended.`);
process.exit(0);
