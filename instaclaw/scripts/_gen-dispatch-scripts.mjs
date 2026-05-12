#!/usr/bin/env node
/**
 * _gen-dispatch-scripts.mjs
 *
 * Generates `lib/dispatch-scripts.ts` from the on-disk files at
 * `skills/computer-dispatch/scripts/*.sh`, `skills/computer-dispatch/dispatch-server.js`,
 * and `skills/computer-dispatch/SKILL.md`.
 *
 * Why this exists:
 *   Next 15's @vercel/nft tracer silently drops .sh files from the bundle
 *   even when `outputFileTracingIncludes: ["./skills/**\/*"]` is set. The
 *   `.md` and `.py` extensions are in NFT's default allow-list; `.sh` is
 *   not. Four prior glob-fix attempts (per next.config.ts comments)
 *   failed silently. We sidestep the issue entirely by inlining the
 *   contents as template-literal constants — same pattern as
 *   STRIP_THINKING_SCRIPT, VM_WATCHDOG_SCRIPT, AUTO_APPROVE_PAIRING_SCRIPT,
 *   DELIVER_FILE_SCRIPT, NOTIFY_USER_SCRIPT, TOKEN_PRICE_SCRIPT,
 *   ACK_WATCHDOG_SCRIPT (all already in lib/ssh.ts).
 *
 * Usage:
 *   node scripts/_gen-dispatch-scripts.mjs
 *
 * After editing any of:
 *   skills/computer-dispatch/scripts/*.sh
 *   skills/computer-dispatch/dispatch-server.js
 *   skills/computer-dispatch/SKILL.md
 *
 * Re-run this script and commit the regenerated lib/dispatch-scripts.ts.
 *
 * Sanity:
 *   - Script list MUST match the names in lib/ssh.ts:configureOpenClaw()
 *     dispatchScripts array. If you add a script there, add it here too
 *     and re-run the generator. If a file is missing on disk, this
 *     script exits non-zero with a clear error.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "skills/computer-dispatch/scripts");
const SERVER_JS = path.join(REPO_ROOT, "skills/computer-dispatch/dispatch-server.js");
const SKILL_MD = path.join(REPO_ROOT, "skills/computer-dispatch/SKILL.md");
const OUT = path.join(REPO_ROOT, "lib/dispatch-scripts.ts");

// Source of truth for which scripts get deployed. MUST mirror the array in
// lib/ssh.ts:configureOpenClaw() to prevent drift between generator and
// runtime consumer. If you add a script to the runtime list, add it here.
const DISPATCH_SCRIPT_NAMES = [
  "dispatch-screenshot.sh",
  "dispatch-click.sh",
  "dispatch-type.sh",
  "dispatch-press.sh",
  "dispatch-scroll.sh",
  "dispatch-browser.sh",
  "dispatch-remote-screenshot.sh",
  "dispatch-remote-click.sh",
  "dispatch-remote-type.sh",
  "dispatch-remote-press.sh",
  "dispatch-remote-scroll.sh",
  "dispatch-remote-status.sh",
  "dispatch-remote-batch.sh",
  "dispatch-remote-drag.sh",
  "dispatch-remote-windows.sh",
  "dispatch-windows.sh",
  "gateway-watchdog.sh",
  "dispatch-connection-info.sh",
  "dispatch-remote-exec.sh",
];

/**
 * Escape a string for safe embedding inside a TypeScript template literal.
 *
 * Order matters:
 *   1. backslashes FIRST (must be doubled before we add new ones)
 *   2. backticks (would otherwise close the literal)
 *   3. ${ (template interpolation; replace ONLY this, not bare $ chars)
 */
function escapeForTemplateLiteral(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function readOrDie(filePath, label) {
  if (!existsSync(filePath)) {
    console.error(`FATAL: ${label} not found at ${filePath}`);
    process.exit(1);
  }
  return readFileSync(filePath, "utf-8");
}

const out = [];
out.push(`// AUTO-GENERATED — do not edit by hand.`);
out.push(`// Regenerate with: node scripts/_gen-dispatch-scripts.mjs`);
out.push(`//`);
out.push(`// Source of truth for these scripts is on disk at:`);
out.push(`//   skills/computer-dispatch/scripts/*.sh`);
out.push(`//   skills/computer-dispatch/dispatch-server.js`);
out.push(`//   skills/computer-dispatch/SKILL.md`);
out.push(`//`);
out.push(`// Why inline instead of fs.readFileSync from skills/?`);
out.push(`//   Next 15's @vercel/nft tracer silently drops .sh files from the`);
out.push(`//   bundle even with outputFileTracingIncludes. Inlining as TS`);
out.push(`//   template literals sidesteps the bundler entirely — same pattern`);
out.push(`//   as STRIP_THINKING_SCRIPT, VM_WATCHDOG_SCRIPT, etc. in lib/ssh.ts.`);
out.push(``);

out.push(`/** Per-script content, base64-decoded by configureOpenClaw on the VM. */`);
out.push(`export const DISPATCH_SCRIPTS: Record<string, string> = {`);

let totalBytes = 0;
for (const name of DISPATCH_SCRIPT_NAMES) {
  const p = path.join(SCRIPTS_DIR, name);
  const content = readOrDie(p, `script "${name}"`);
  totalBytes += content.length;
  const escaped = escapeForTemplateLiteral(content);
  out.push(`  ${JSON.stringify(name)}: \`${escaped}\`,`);
}
out.push(`};`);
out.push(``);

const serverContent = readOrDie(SERVER_JS, "dispatch-server.js");
totalBytes += serverContent.length;
out.push(`/** dispatch-server.js — the Node.js dispatch server that runs on each VM. */`);
out.push(`export const DISPATCH_SERVER_JS = \`${escapeForTemplateLiteral(serverContent)}\`;`);
out.push(``);

const skillContent = readOrDie(SKILL_MD, "SKILL.md");
totalBytes += skillContent.length;
out.push(`/** computer-dispatch SKILL.md — agent-facing skill documentation. */`);
out.push(`export const DISPATCH_SKILL_MD = \`${escapeForTemplateLiteral(skillContent)}\`;`);
out.push(``);

writeFileSync(OUT, out.join("\n"));

console.log(`✓ wrote ${OUT}`);
console.log(`  ${DISPATCH_SCRIPT_NAMES.length} scripts + dispatch-server.js + SKILL.md`);
console.log(`  ${totalBytes} bytes of script content (raw), TS file is larger due to escaping`);
console.log();
console.log(`Next step: type-check with`);
console.log(`  ./node_modules/.bin/tsc --noEmit`);
