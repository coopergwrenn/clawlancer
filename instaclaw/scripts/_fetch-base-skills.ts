/**
 * scripts/_fetch-base-skills.ts — Manual refresh of vendored Base skill plugins.
 *
 * For each entry in BASE_SKILL_CATALOG, fetches upstream content via the
 * registry module's live-fetch mode, compares SHA against the vendored copy
 * on disk, and either:
 *   - reports it as up-to-date,
 *   - shows a unified diff and (optionally) writes the new version,
 *   - or reports a fetch failure (leaves vendored copy alone).
 *
 * Usage:
 *   npx tsx scripts/_fetch-base-skills.ts                # interactive (per-skill prompt)
 *   npx tsx scripts/_fetch-base-skills.ts --yes          # auto-confirm all drifts
 *   npx tsx scripts/_fetch-base-skills.ts --check        # exit 1 on any drift, no writes
 *   npx tsx scripts/_fetch-base-skills.ts --skill morpho # single skill
 *
 * After writing, the operator should:
 *   1. Inspect the diff via `git diff instaclaw/skills/base-*\/SKILL.md`
 *   2. Update each modified entry's `importedAt` in lib/base-skills-registry.ts
 *      to today's date (optional — informational only)
 *   3. Commit the content + catalog changes together
 *   4. The next file-drift cron tick (~5 min) propagates to the fleet
 *
 * The catalog's `upstreamCommitSha` field is informational (audit trail).
 * Runtime SHA comparison uses the live-computed SHA from getBaseSkillContent.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import {
  BASE_SKILL_CATALOG,
  type BaseSkillEntry,
  _clearCacheForTesting,
  getBaseSkillContent,
} from "../lib/base-skills-registry";

// ─── arg parsing ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flagYes = argv.includes("--yes") || argv.includes("-y");
const flagCheck = argv.includes("--check");
const skillFilter = (() => {
  const idx = argv.indexOf("--skill");
  return idx >= 0 ? argv[idx + 1] : null;
})();

if (flagYes && flagCheck) {
  console.error("--yes and --check are mutually exclusive");
  process.exit(2);
}

// ─── helpers ─────────────────────────────────────────────────────────

const REPO_ROOT = process.env.INSTACLAW_REPO_ROOT ?? process.cwd();

function vendoredPath(entry: BaseSkillEntry): string {
  return path.join(REPO_ROOT, "skills", entry.vendoredPath, "SKILL.md");
}

function readVendoredOrNull(entry: BaseSkillEntry): {
  content: string;
  sha: string;
} | null {
  const p = vendoredPath(entry);
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, "utf-8");
  const sha = crypto.createHash("sha256").update(content).digest("hex");
  return { content, sha };
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * Cheap unified-diff-ish output. For large diffs we just show summary stats
 * to keep terminal output manageable; the operator can use `git diff` after
 * a write for the full diff.
 */
function summarizeDiff(a: string, b: string): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  let added = 0;
  let removed = 0;
  const max = Math.max(al.length, bl.length);
  for (let i = 0; i < max; i++) {
    if ((al[i] ?? "") !== (bl[i] ?? "")) {
      if (al[i] === undefined) added++;
      else if (bl[i] === undefined) removed++;
      else {
        added++;
        removed++;
      }
    }
  }
  return `+${added} -${removed} (vendored ${al.length} → upstream ${bl.length} lines)`;
}

async function confirm(prompt: string): Promise<boolean> {
  if (flagYes) return true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ans = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

function writeVendored(entry: BaseSkillEntry, content: string): void {
  const p = vendoredPath(entry);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: tmp + rename (matches Rule 38 / file-drift cron pattern)
  const tmp = `${p}.tmp.${Date.now()}.${process.pid}`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, p);
}

// ─── main ────────────────────────────────────────────────────────────

interface PerEntryResult {
  name: string;
  status: "up-to-date" | "drifted-written" | "drifted-skipped" | "fetch-failed";
  detail?: string;
}

async function main(): Promise<void> {
  // Force live-fetch mode for the duration regardless of env. We always want
  // to query upstream here — the whole purpose of this script.
  process.env.BASE_SKILLS_SOURCE_MODE = "live-fetch";
  _clearCacheForTesting();

  const targets = skillFilter
    ? BASE_SKILL_CATALOG.filter((e) => e.name === skillFilter)
    : BASE_SKILL_CATALOG;

  if (skillFilter && targets.length === 0) {
    console.error(
      `Unknown skill: ${skillFilter}. Available: ${BASE_SKILL_CATALOG.map((e) => e.name).join(", ")}`,
    );
    process.exit(2);
  }

  console.log(`Refreshing ${targets.length} Base skill plugin(s)...`);
  console.log(`Mode: ${flagCheck ? "check" : flagYes ? "auto-write" : "interactive"}\n`);

  const results: PerEntryResult[] = [];
  let anyDrift = false;

  for (const entry of targets) {
    process.stdout.write(`  ${entry.name.padEnd(12)} `);

    const vendored = readVendoredOrNull(entry);
    if (!vendored) {
      // First-time vendoring — no on-disk copy yet. Fetch + write directly
      // (subject to the same confirmation flow).
      try {
        const live = await getBaseSkillContent(entry, "live-fetch");
        if (live.sourceMode === "vendored") {
          // The registry returned a vendored fallback even though we asked
          // for live-fetch — means the upstream URL also failed AND we have
          // no vendored copy. Genuinely unrecoverable.
          process.stdout.write("✗ fetch failed + no vendored fallback\n");
          results.push({
            name: entry.name,
            status: "fetch-failed",
            detail: "no upstream, no vendored copy",
          });
          continue;
        }
        process.stdout.write(`(new) bytes=${live.content.length} sha=${shortSha(live.sha256)}\n`);
        anyDrift = true;
        if (flagCheck) {
          results.push({ name: entry.name, status: "drifted-skipped" });
          continue;
        }
        if (await confirm(`    write new vendored copy?`)) {
          writeVendored(entry, live.content);
          results.push({
            name: entry.name,
            status: "drifted-written",
            detail: `wrote ${live.content.length} bytes`,
          });
        } else {
          results.push({ name: entry.name, status: "drifted-skipped" });
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        process.stdout.write(`✗ fetch failed: ${msg.slice(0, 80)}\n`);
        results.push({ name: entry.name, status: "fetch-failed", detail: msg });
      }
      continue;
    }

    try {
      const live = await getBaseSkillContent(entry, "live-fetch");
      if (live.sourceMode === "vendored") {
        // Upstream failed; registry returned the vendored copy. Report as
        // fetch-failed even though we have a working vendored copy.
        process.stdout.write(`⚠ upstream fetch failed (vendored kept, sha=${shortSha(vendored.sha)})\n`);
        results.push({
          name: entry.name,
          status: "fetch-failed",
          detail: "upstream unreachable; vendored copy intact",
        });
        continue;
      }

      if (live.sha256 === vendored.sha) {
        process.stdout.write(`✓ up-to-date (sha=${shortSha(vendored.sha)})\n`);
        results.push({ name: entry.name, status: "up-to-date" });
        continue;
      }

      // Drift!
      const diff = summarizeDiff(vendored.content, live.content);
      process.stdout.write(`△ drift ${shortSha(vendored.sha)} → ${shortSha(live.sha256)}  ${diff}\n`);
      anyDrift = true;

      if (flagCheck) {
        results.push({ name: entry.name, status: "drifted-skipped", detail: diff });
        continue;
      }

      if (await confirm(`    overwrite vendored copy with upstream?`)) {
        writeVendored(entry, live.content);
        results.push({
          name: entry.name,
          status: "drifted-written",
          detail: `${diff}; wrote ${live.content.length} bytes`,
        });
      } else {
        results.push({ name: entry.name, status: "drifted-skipped", detail: diff });
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      process.stdout.write(`✗ fetch failed: ${msg.slice(0, 80)}\n`);
      results.push({ name: entry.name, status: "fetch-failed", detail: msg });
    }
  }

  // ── summary ────────────────────────────────────────────────────────
  const upToDate = results.filter((r) => r.status === "up-to-date").length;
  const written = results.filter((r) => r.status === "drifted-written").length;
  const skipped = results.filter((r) => r.status === "drifted-skipped").length;
  const failed = results.filter((r) => r.status === "fetch-failed").length;

  console.log("");
  console.log(`Summary: ${upToDate} up-to-date, ${written} written, ${skipped} skipped, ${failed} fetch-failed`);

  if (written > 0) {
    console.log("");
    console.log("Next steps:");
    console.log("  1. `git diff instaclaw/skills/base-*/SKILL.md` to review the changes");
    console.log("  2. Optionally update `importedAt` in lib/base-skills-registry.ts");
    console.log("     for each modified entry to today's date (informational)");
    console.log("  3. Commit content + catalog changes together");
    console.log("  4. The file-drift cron propagates to the fleet within ~5 min");
  }

  if (flagCheck && (written + skipped) > 0) {
    console.log("\n--check mode: drift detected — exiting non-zero");
    process.exit(1);
  }
  if (failed > 0) {
    console.log("\nSome fetches failed — vendored copies kept intact.");
    // Don't exit non-zero on fetch failure in normal mode (network blips
    // happen). --check mode would already have exited above.
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
