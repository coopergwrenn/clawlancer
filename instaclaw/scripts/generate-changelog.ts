/**
 * generate-changelog.ts
 *
 * Exhaustive git → markdown changelog generator.
 * Reads every commit in a range, categorizes conservatively, detects
 * manifest version bumps, and writes a clean markdown reference.
 *
 * Usage:
 *   npx tsx scripts/generate-changelog.ts --since <sha-or-tag>
 *   npx tsx scripts/generate-changelog.ts --since 2026-04-15 --date-mode
 *   npx tsx scripts/generate-changelog.ts                   # uses last marker
 *   npx tsx scripts/generate-changelog.ts --append-running  # also append to running file
 *
 * Outputs:
 *   docs/changelog-latest.md          (always, single-window snapshot)
 *   docs/changelog-running.md         (if --append-running, monotonic)
 *
 * Categorization is CONSERVATIVE. If a commit touches `lib/ssh.ts` it
 * is infrastructure, even if the commit message says "feat". Per user
 * instruction: ambiguous = infra > feature.
 */

import { execSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "fs";
import { dirname, resolve } from "path";

// ── Config ───────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..", "..");
const INSTACLAW_DIR = resolve(REPO_ROOT, "instaclaw");
const DOCS_DIR = resolve(INSTACLAW_DIR, "docs");
const LATEST_PATH = resolve(DOCS_DIR, "changelog-latest.md");
const RUNNING_PATH = resolve(DOCS_DIR, "changelog-running.md");
const MARKER = "<!-- LAST_GENERATED_SHA:";

// Category root paths. Order matters — first match wins for primary
// category, but all matches contribute to multi-category tagging.
const CATEGORY_RULES: Array<{
  category: Category;
  matchPath?: RegExp;
  matchMessage?: RegExp;
}> = [
  // Reconciler/Manifest — most specific, must come first
  {
    category: "reconciler",
    matchPath:
      /^instaclaw\/lib\/(vm-manifest|vm-reconcile|ssh|workspace-templates|earn-md-template|agent-intelligence)\.ts$/,
  },
  {
    category: "reconciler",
    matchMessage: /\b(manifest v\d+|fleet\(v\d+\)|cv=\d+)\b/i,
  },
  // Edge — match before infrastructure so edge-related infra still tags edge
  {
    category: "edge",
    matchPath: /^instaclaw\/(app|lib|scripts)\/.*\b(edge|partner-tag)\b/i,
  },
  { category: "edge", matchMessage: /\b(edge[\s_-]?city|esmeralda|edge[-_]?privacy|\/edge)\b/i },
  // Infrastructure (broad: lib/, cron, admin, migrations, ops scripts)
  { category: "infrastructure", matchPath: /^instaclaw\/lib\// },
  { category: "infrastructure", matchPath: /^instaclaw\/app\/api\/cron\// },
  { category: "infrastructure", matchPath: /^instaclaw\/app\/api\/admin\// },
  { category: "infrastructure", matchPath: /^supabase\/migrations\// },
  { category: "infrastructure", matchPath: /^instaclaw\/scripts\/_/ },
  // Features (user-facing surfaces). Order: specific groups first, then
  // a catch-all `app/` (excluding api routes). Public assets under
  // app's route-static dirs (e.g. /edge/...) also count.
  { category: "feature", matchPath: /^instaclaw\/app\/\(marketing\)\// },
  { category: "feature", matchPath: /^instaclaw\/app\/\(dashboard\)\// },
  { category: "feature", matchPath: /^instaclaw\/app\/\(onboarding\)\// },
  { category: "feature", matchPath: /^instaclaw\/app\/\(auth\)\// },
  { category: "feature", matchPath: /^instaclaw\/components\// },
  { category: "feature", matchPath: /^instaclaw-mini\// },
  // Catch-all: any app/ page that isn't an api route or already covered.
  // This catches things like app/edge/, app/blog/, app/skills/ that
  // don't live under a parenthesized route group.
  {
    category: "feature",
    matchPath: /^instaclaw\/app\/(?!api\/)(?!\()[^/]+\/.*\.(tsx?|jsx?|css)$/,
  },
  { category: "feature", matchPath: /^instaclaw\/public\// },
  // Docs-only
  { category: "docs", matchPath: /\.(md|mdx)$/ },
];

type Category = "reconciler" | "infrastructure" | "feature" | "edge" | "docs";
const CATEGORY_ORDER: Category[] = [
  "reconciler",
  "infrastructure",
  "feature",
  "edge",
  "docs",
];
const CATEGORY_LABELS: Record<Category, string> = {
  reconciler: "Reconciler / manifest",
  infrastructure: "Infrastructure",
  feature: "Feature (user-facing)",
  edge: "Edge City partner",
  docs: "Docs / PRD only",
};

interface CommitInfo {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  subject: string;
  body: string;
  files: string[];
  fileCount: number;
  categories: Category[]; // primary first
  bumpedManifest: boolean;
  manifestVersion: number | null; // the version it bumped TO, if any
  isMerge: boolean;
  coAuthored: boolean; // contains Co-Authored-By or Claude attribution
}

// ── Git helpers ──────────────────────────────────────────────────────

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function resolveSince(arg: string | null): string {
  if (arg) {
    // Treat date-shaped strings as date filters; otherwise treat as SHA/ref.
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
    try {
      return git(`rev-parse ${arg}`);
    } catch {
      throw new Error(
        `Cannot resolve --since value "${arg}" (not a date, ref, or SHA).`
      );
    }
  }
  // Try to read marker from existing latest file
  if (existsSync(LATEST_PATH)) {
    const text = readFileSync(LATEST_PATH, "utf-8");
    const m = text.match(new RegExp(`${MARKER}\\s*([a-f0-9]{7,40})\\s*-->`));
    if (m) return m[1];
  }
  // Fallback: 14 days ago
  console.warn(
    "[changelog] No --since arg and no marker found; defaulting to 14 days ago."
  );
  return git("log -1 --format=%H --before=14.days.ago").split("\n")[0];
}

function listCommits(since: string, until: string): string[] {
  const range = /^\d{4}-\d{2}-\d{2}$/.test(since)
    ? `--since=${since} ${until}`
    : `${since}..${until}`;
  const out = git(`log --format=%H ${range}`);
  if (!out) return [];
  return out.split("\n").reverse(); // chronological oldest-first
}

function loadCommit(sha: string): CommitInfo {
  // %H sha, %ad short date, %an author, %s subject, %b body
  const meta = git(
    `show --no-patch --format='%H%x00%ad%x00%an%x00%s%x00%b' --date=short ${sha}`
  );
  // Strip surrounding single quotes that some shells add
  const cleaned = meta.replace(/^'|'$/g, "");
  const [fullSha, date, author, subject, ...bodyParts] = cleaned.split("\0");
  const body = bodyParts.join("\0").trim();

  // Files changed (name only). Use --no-renames so renames count as
  // delete + add — fine for categorization.
  let files: string[] = [];
  try {
    const fileOut = git(`show --name-only --no-renames --format="" ${sha}`);
    files = fileOut.split("\n").filter((l) => l && l.trim());
  } catch {
    files = [];
  }
  const fileCount = files.length;

  // Merge?
  const parentCount = git(`rev-list --parents -n 1 ${sha}`)
    .split(" ")
    .slice(1).length;
  const isMerge = parentCount > 1;

  // Manifest version bump?
  let bumpedManifest = false;
  let manifestVersion: number | null = null;
  if (files.some((f) => f === "instaclaw/lib/vm-manifest.ts")) {
    try {
      const diff = git(`show --format="" ${sha} -- instaclaw/lib/vm-manifest.ts`);
      const m = diff.match(/^\+\s+version:\s*(\d+),/m);
      if (m) {
        bumpedManifest = true;
        manifestVersion = parseInt(m[1], 10);
      }
    } catch {
      // ignore
    }
  }

  const categories = categorize(files, subject + "\n" + body);
  const coAuthored = /Co-Authored-By|Generated with \[Claude/i.test(body);

  return {
    sha: fullSha,
    shortSha: fullSha.slice(0, 8),
    date,
    author,
    subject,
    body,
    files,
    fileCount,
    categories,
    bumpedManifest,
    manifestVersion,
    isMerge,
    coAuthored,
  };
}

function categorize(files: string[], message: string): Category[] {
  const found = new Set<Category>();
  for (const rule of CATEGORY_RULES) {
    if (rule.matchPath) {
      if (files.some((f) => rule.matchPath!.test(f))) {
        found.add(rule.category);
      }
    }
    if (rule.matchMessage) {
      if (rule.matchMessage.test(message)) {
        found.add(rule.category);
      }
    }
  }
  // If only docs matched, but ALL files are .md, classify as docs only
  // (already handled by category rules — docs rule fires only on .md).
  // If nothing matched, treat as infrastructure (conservative default).
  if (found.size === 0) {
    return ["infrastructure"];
  }
  // Order by CATEGORY_ORDER, primary first
  return CATEGORY_ORDER.filter((c) => found.has(c));
}

// ── Rendering ────────────────────────────────────────────────────────

function renderCommit(c: CommitInfo): string {
  const tags: string[] = [];
  if (c.bumpedManifest) tags.push(`**MANIFEST v${c.manifestVersion}**`);
  if (c.categories.length > 1) {
    tags.push(`multi: [${c.categories.map((x) => x).join(", ")}]`);
  }
  if (c.coAuthored) tags.push("ai-assisted");
  if (c.isMerge) tags.push("merge");
  const tagStr = tags.length ? ` _(${tags.join("; ")})_` : "";
  return `- \`${c.shortSha}\` ${c.date} — ${escapeMd(c.subject)} [${c.fileCount} files]${tagStr}`;
}

function escapeMd(s: string): string {
  // Don't escape too aggressively — subjects often contain backticks
  // and arrows which we want preserved.
  return s.replace(/\|/g, "\\|");
}

function renderReport(
  commits: CommitInfo[],
  since: string,
  until: string,
  headSha: string
): string {
  const lines: string[] = [];
  const now = new Date().toISOString().split("T")[0];

  // Header
  lines.push(`# Changelog — generated ${now}`);
  lines.push("");
  lines.push(`Window: \`${since}\` → \`${until}\` (HEAD = \`${headSha.slice(0, 8)}\`)`);
  lines.push(`Total commits: ${commits.length}`);
  lines.push("");
  lines.push(`${MARKER} ${headSha} -->`);
  lines.push("");

  // Summary table
  const versionBumps = commits.filter((c) => c.bumpedManifest);
  const byCategory: Record<Category, CommitInfo[]> = {
    reconciler: [],
    infrastructure: [],
    feature: [],
    edge: [],
    docs: [],
  };
  for (const c of commits) {
    // Primary category is first in list
    byCategory[c.categories[0]].push(c);
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Manifest version bumps:** ${versionBumps.length}`);
  if (versionBumps.length) {
    const min = Math.min(...versionBumps.map((v) => v.manifestVersion!));
    const max = Math.max(...versionBumps.map((v) => v.manifestVersion!));
    lines.push(`  - Range: v${min} → v${max}`);
  }
  for (const cat of CATEGORY_ORDER) {
    lines.push(`- **${CATEGORY_LABELS[cat]}:** ${byCategory[cat].length}`);
  }
  const aiAssisted = commits.filter((c) => c.coAuthored).length;
  const merges = commits.filter((c) => c.isMerge).length;
  lines.push(`- AI-assisted commits (co-authored): ${aiAssisted}`);
  lines.push(`- Merge commits: ${merges}`);
  lines.push("");

  // Manifest version timeline
  if (versionBumps.length) {
    lines.push("## Manifest version timeline");
    lines.push("");
    for (const bump of versionBumps) {
      lines.push(
        `### v${bump.manifestVersion} — ${bump.date} — \`${bump.shortSha}\``
      );
      lines.push("");
      lines.push(`${escapeMd(bump.subject)}`);
      lines.push("");
      if (bump.body) {
        const firstPara = bump.body.split(/\n\n/)[0].trim();
        if (firstPara) {
          lines.push(`> ${firstPara.split("\n").join("\n> ")}`);
          lines.push("");
        }
      }
    }
  }

  // User-facing vs under-the-hood split
  lines.push("## What changed for users");
  lines.push("");
  const userFacing = [...byCategory.feature, ...byCategory.edge].sort(
    (a, b) => a.date.localeCompare(b.date)
  );
  if (userFacing.length === 0) {
    lines.push("_None in this window._");
  } else {
    for (const c of userFacing) {
      lines.push(renderCommit(c));
    }
  }
  lines.push("");

  lines.push("## What changed under the hood");
  lines.push("");
  const infra = [
    ...byCategory.reconciler,
    ...byCategory.infrastructure,
    ...byCategory.docs,
  ].sort((a, b) => a.date.localeCompare(b.date));
  for (const c of infra) {
    lines.push(renderCommit(c));
  }
  lines.push("");

  // Full categorical breakdown
  lines.push("## By category");
  lines.push("");
  for (const cat of CATEGORY_ORDER) {
    const items = byCategory[cat];
    lines.push(`### ${CATEGORY_LABELS[cat]} (${items.length})`);
    lines.push("");
    if (items.length === 0) {
      lines.push("_(none)_");
    } else {
      for (const c of items) {
        lines.push(renderCommit(c));
      }
    }
    lines.push("");
  }

  // Multi-category commits (flagged separately)
  const multi = commits.filter((c) => c.categories.length > 1);
  if (multi.length) {
    lines.push(`## Multi-category commits (${multi.length})`);
    lines.push("");
    lines.push(
      "These touch more than one category root and are listed in every applicable section above."
    );
    lines.push("");
    for (const c of multi) {
      lines.push(
        `- \`${c.shortSha}\` ${c.date} — [${c.categories.join(", ")}] — ${escapeMd(c.subject)}`
      );
    }
    lines.push("");
  }

  // AI-assisted flag list
  if (aiAssisted) {
    lines.push(`## AI-assisted commits (${aiAssisted})`);
    lines.push("");
    lines.push(
      "Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review."
    );
    lines.push("");
    for (const c of commits.filter((x) => x.coAuthored)) {
      lines.push(
        `- \`${c.shortSha}\` ${c.date} — ${escapeMd(c.subject)}`
      );
    }
    lines.push("");
  }

  // Full appendix
  lines.push("## Appendix — every commit (chronological)");
  lines.push("");
  for (const c of commits) {
    lines.push(renderCommit(c));
  }
  lines.push("");

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────

function parseArgs(): {
  since: string | null;
  until: string;
  appendRunning: boolean;
  out: string;
} {
  const argv = process.argv.slice(2);
  let since: string | null = null;
  let until = "HEAD";
  let appendRunning = false;
  let out = LATEST_PATH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") since = argv[++i];
    else if (a === "--until") until = argv[++i];
    else if (a === "--append-running") appendRunning = true;
    else if (a === "--out") out = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/generate-changelog.ts [--since <sha|date>] [--until <sha>] [--append-running] [--out <path>]"
      );
      process.exit(0);
    }
  }
  return { since, until, appendRunning, out };
}

function main() {
  const { since: sinceArg, until, appendRunning, out } = parseArgs();
  const sinceRef = resolveSince(sinceArg);
  const headSha = git(`rev-parse ${until}`);

  console.log(`[changelog] window: ${sinceRef} → ${until} (${headSha.slice(0, 8)})`);
  const shas = listCommits(sinceRef, until);
  console.log(`[changelog] ${shas.length} commits to process`);

  if (shas.length === 0) {
    console.log("[changelog] nothing to do.");
    process.exit(0);
  }

  const commits: CommitInfo[] = [];
  for (let i = 0; i < shas.length; i++) {
    if (i % 50 === 0 && i > 0) {
      console.log(`[changelog]   ${i}/${shas.length}...`);
    }
    commits.push(loadCommit(shas[i]));
  }

  const report = renderReport(commits, sinceRef, until, headSha);

  // Ensure docs dir exists
  if (!existsSync(dirname(out))) {
    mkdirSync(dirname(out), { recursive: true });
  }
  writeFileSync(out, report);
  console.log(`[changelog] wrote ${out} (${commits.length} commits)`);

  // Append-running mode: append a header + new commits only since the
  // last appended SHA in the running file.
  if (appendRunning) {
    let lastSha: string | null = null;
    if (existsSync(RUNNING_PATH)) {
      const text = readFileSync(RUNNING_PATH, "utf-8");
      const m = text.match(new RegExp(`${MARKER}\\s*([a-f0-9]{7,40})\\s*-->`));
      if (m) lastSha = m[1];
    }
    const newCommits = lastSha
      ? commits.filter((c) => {
          // Include only commits after lastSha (chronological order)
          const idx = commits.findIndex((x) => x.sha === lastSha);
          return idx === -1 || commits.indexOf(c) > idx;
        })
      : commits;

    if (newCommits.length === 0) {
      console.log(`[changelog] running file already up to date.`);
    } else {
      const now = new Date().toISOString();
      const header = `\n\n## ${now} — ${newCommits.length} commits (HEAD ${headSha.slice(0, 8)})\n\n${MARKER} ${headSha} -->\n\n`;
      const body = newCommits.map(renderCommit).join("\n") + "\n";
      if (!existsSync(RUNNING_PATH)) {
        writeFileSync(
          RUNNING_PATH,
          `# Changelog — running log\n\nAppend-only. Newest sections at the bottom. Generated by \`scripts/generate-changelog.ts --append-running\`.\n`
        );
      }
      appendFileSync(RUNNING_PATH, header + body);
      console.log(
        `[changelog] appended ${newCommits.length} commits to ${RUNNING_PATH}`
      );
    }
  }
}

main();
