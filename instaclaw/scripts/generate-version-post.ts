/**
 * generate-version-post.ts
 *
 * Single command that:
 *   1. Runs scripts/generate-changelog.ts internally for the window
 *   2. Reads the changelog + style guide + canonical exemplar
 *   3. Calls Anthropic Sonnet 4.6 to produce 2-3 X-post drafts in
 *      Cooper's exact voice (per docs/x-post-style-guide.md)
 *   4. Audits drafts for banned style tokens and warns
 *   5. Writes drafts to docs/x-post-drafts/YYYY-MM-DD-vNN.md
 *
 * Usage:
 *   npx tsx scripts/generate-version-post.ts --since <last-version-sha>
 *   npx tsx scripts/generate-version-post.ts --since v62 --version v95
 *   npx tsx scripts/generate-version-post.ts --mode launch --product consensus
 *
 * Requires ANTHROPIC_API_KEY in .env.local or env.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

// ── Config ───────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..", "..");
const INSTACLAW_DIR = resolve(REPO_ROOT, "instaclaw");
const DOCS_DIR = resolve(INSTACLAW_DIR, "docs");
const STYLE_GUIDE = resolve(DOCS_DIR, "x-post-style-guide.md");
const CANONICAL_EXEMPLAR = resolve(DOCS_DIR, "changelog-thread-v62-v88.md");
const CONSENSUS_EXEMPLAR = resolve(DOCS_DIR, "consensus-2026-launch-kit.md");
const LATEST_CHANGELOG = resolve(DOCS_DIR, "changelog-latest.md");
const DRAFTS_DIR = resolve(DOCS_DIR, "x-post-drafts");
const HISTORY_PATH = resolve(DOCS_DIR, "x-post-history.md");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 16000;

// Banned style tokens (per style guide). If any appear in output, warn.
const BANNED_TOKENS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /🚀/, reason: "rocket emoji — Cooper does not use" },
  { pattern: /🎉/, reason: "party emoji — Cooper does not use" },
  { pattern: /✨/, reason: "sparkles — Cooper does not use" },
  { pattern: /🔥/, reason: "fire — Cooper does not use" },
  { pattern: /💪/, reason: "flex — Cooper does not use" },
  {
    pattern: /\b(we're|we are) (excited|thrilled|proud|pumped) to/i,
    reason: "marketing announcement opener",
  },
  { pattern: /\bintroducing\b/i, reason: "marketing verb" },
  { pattern: /\bgame[\s-]?changing\b/i, reason: "marketing cliché" },
  { pattern: /\brevolutionary\b/i, reason: "marketing cliché" },
  { pattern: /\bunlock\b/i, reason: "marketing cliché" },
  { pattern: /\bempower\b/i, reason: "marketing cliché" },
  { pattern: /\bdon't miss out\b/i, reason: "fomo bait" },
  { pattern: /\bstay tuned\b/i, reason: "teaser bait" },
  { pattern: /^#\w/m, reason: "hashtags — Cooper does not use" },
  { pattern: /\bTL;DR\b/i, reason: "lead tweet IS the tldr" },
];

// ── Env loading ──────────────────────────────────────────────────────

function loadEnv() {
  const candidates = [
    resolve(INSTACLAW_DIR, ".env.local"),
    resolve(REPO_ROOT, ".env.local"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, "utf-8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

interface Args {
  since: string | null;
  version: string | null;
  mode: "release" | "launch";
  product: string | null;
  variants: number;
  skipChangelog: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {
    since: null,
    version: null,
    mode: "release",
    product: null,
    variants: 3,
    skipChangelog: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") out.since = argv[++i];
    else if (a === "--version") out.version = argv[++i];
    else if (a === "--mode") {
      const v = argv[++i];
      if (v !== "release" && v !== "launch") {
        throw new Error(`--mode must be 'release' or 'launch' (got ${v})`);
      }
      out.mode = v;
    } else if (a === "--product") out.product = argv[++i];
    else if (a === "--variants") out.variants = parseInt(argv[++i], 10);
    else if (a === "--skip-changelog") out.skipChangelog = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/generate-version-post.ts [--since <sha>] [--version vN] [--mode release|launch] [--product <name>] [--variants 3] [--skip-changelog] [--dry-run]"
      );
      process.exit(0);
    }
  }
  return out;
}

// ── Steps ────────────────────────────────────────────────────────────

function runChangelogGenerator(since: string | null): void {
  const args = ["scripts/generate-changelog.ts"];
  if (since) {
    args.push("--since", since);
  }
  const cmd = `npx tsx ${args.join(" ")}`;
  console.log(`[post] running: ${cmd}`);
  execSync(cmd, { cwd: INSTACLAW_DIR, stdio: "inherit" });
}

function loadChangelog(): string {
  if (!existsSync(LATEST_CHANGELOG)) {
    throw new Error(
      `Changelog missing at ${LATEST_CHANGELOG}. Run with --skip-changelog=false or generate first.`
    );
  }
  return readFileSync(LATEST_CHANGELOG, "utf-8");
}

function loadStyleGuide(): string {
  if (!existsSync(STYLE_GUIDE)) {
    throw new Error(
      `Style guide missing at ${STYLE_GUIDE}. This is the load-bearing voice reference — generation cannot proceed without it.`
    );
  }
  return readFileSync(STYLE_GUIDE, "utf-8");
}

function loadExemplars(mode: "release" | "launch"): string {
  const parts: string[] = [];
  if (mode === "release" && existsSync(CANONICAL_EXEMPLAR)) {
    parts.push("# CANONICAL RELEASE-THREAD EXEMPLAR\n\n");
    parts.push(readFileSync(CANONICAL_EXEMPLAR, "utf-8"));
  }
  if (mode === "launch" && existsSync(CONSENSUS_EXEMPLAR)) {
    parts.push("# CANONICAL LAUNCH-THREAD EXEMPLAR\n\n");
    parts.push(readFileSync(CONSENSUS_EXEMPLAR, "utf-8"));
  }
  if (existsSync(HISTORY_PATH)) {
    parts.push("\n\n# RECENT POST HISTORY (most recent first)\n\n");
    parts.push(readFileSync(HISTORY_PATH, "utf-8"));
  }
  return parts.join("\n\n");
}

function detectVersionRange(changelog: string): {
  from: number | null;
  to: number | null;
} {
  // Look for v## markers in the timeline
  const matches = [...changelog.matchAll(/^### v(\d+)\s+—/gm)];
  if (matches.length === 0) return { from: null, to: null };
  const nums = matches.map((m) => parseInt(m[1], 10)).sort((a, b) => a - b);
  return { from: nums[0], to: nums[nums.length - 1] };
}

// ── Prompt construction ──────────────────────────────────────────────

function buildSystemPrompt(styleGuide: string, exemplars: string): string {
  return `You are drafting a multi-tweet X thread for Cooper Wrenn (@cooperwrenn), founder of InstaClaw (instaclaw.io). InstaClaw is a managed-hosting platform for OpenClaw — the open-source personal AI agent framework.

Cooper's voice is highly specific. You MUST match it exactly. The style guide below is the authoritative reference. Treat it as a hard contract — do not paraphrase, do not soften, do not add marketing energy.

═══════════════════════════════════════════════════
STYLE GUIDE (verbatim — DO NOT VIOLATE)
═══════════════════════════════════════════════════

${styleGuide}

═══════════════════════════════════════════════════
EXEMPLARS (Cooper's actual prior posts — match this voice)
═══════════════════════════════════════════════════

${exemplars}

═══════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════

Produce 2-3 distinct variants, separated by lines containing exactly five hyphens (-----). Each variant must:

1. Open with \`## Variant <A|B|C> — <one-line description>\` so the human can pick one.
2. Use plain text for each tweet (NOT markdown headings or bullet lists inside the tweets themselves — markdown only as the variant header).
3. Number each tweet \`1/\`, \`2/\`, ... \`N/\`.
4. Insert a blank line between tweets.
5. Keep individual tweets under 280 characters when possible. If a tweet exceeds 280, add a comment \`<!-- exceeds 280 — split or Premium -->\` immediately after it.

After the final variant, add a \`## Notes\` section that lists:
- What you intentionally excluded from the changelog and why
- Tweets that would benefit from screenshots (and what those screenshots should show)
- Any factual claims you'd like the user to verify before posting

Do NOT include any preamble before the first variant. Start the response with \`## Variant A\`.

═══════════════════════════════════════════════════
HARD CONSTRAINTS
═══════════════════════════════════════════════════

- DO NOT use 🚀 🎉 ✨ 🔥 💪 emojis or any emoji not listed in the style guide.
- DO NOT use marketing verbs (excited to announce, introducing, unlock, empower, revolutionary, game-changing).
- DO NOT use hashtags.
- DO NOT start any variant with "We're excited to..." or "Today we're announcing..."
- DO write lowercase except for proper nouns and acronyms.
- DO use specific numbers wherever possible.
- DO end the thread with the "Next: ... Onward." pattern (release mode) or a URL repeat (launch mode).
- DO include a "by the numbers" tweet in release-mode threads.

If you find yourself wanting to use a banned token, that's a signal you're slipping out of Cooper's voice. Step back and rewrite that line plainly.`;
}

function buildUserPrompt(
  changelog: string,
  args: Args,
  detected: { from: number | null; to: number | null }
): string {
  const versionHeader =
    args.version ||
    (detected.from && detected.to
      ? `v${detected.from} → v${detected.to}`
      : "this release");

  const modeNote =
    args.mode === "launch"
      ? `MODE: launch. Use Mode B from the style guide. No emojis. No em-dashes. Hook + URL pattern. Product: ${args.product || "(unspecified — ask in Notes section)"}.`
      : `MODE: release. Use Mode A from the style guide. Single brand emoji 🦀 in lead tweet only. One category emoji per topic tweet. Em-dashes everywhere. Closer with "Next: ... Onward."`;

  return `Draft an X thread covering the ${versionHeader} release.

${modeNote}

Produce ${args.variants} variants:
${args.variants >= 1 ? "- Variant A: a tight 5-7 tweet thread for casual readers (focus on user-facing wins).\n" : ""}${args.variants >= 2 ? "- Variant B: a 12-18 tweet detailed thread for the technical audience (the full release post).\n" : ""}${args.variants >= 3 ? "- Variant C: a single banger tweet that could stand alone (the headline summary).\n" : ""}

═══════════════════════════════════════════════════
CHANGELOG TO DRAW FROM
═══════════════════════════════════════════════════

${changelog}

═══════════════════════════════════════════════════

Prioritize per the style guide: user-facing wins first, specific numbers, open-source artifacts, discipline/post-mortem honesty, partner mentions. Never name individual customer VM IDs or paying customers without consent — use "some VMs" or "a slice of the fleet."

Begin the response with \`## Variant A\` — no preamble.`;
}

// ── Anthropic call ───────────────────────────────────────────────────

async function callAnthropic(system: string, user: string): Promise<string> {
  // Accept either name. Some .env.local files have only the GBRAIN_-prefixed
  // variant (used by the gbrain-integration tooling); both contain a valid
  // Anthropic key.
  const apiKey =
    process.env.ANTHROPIC_API_KEY || process.env.GBRAIN_ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY (or GBRAIN_ANTHROPIC_API_KEY) not set. Add either to instaclaw/.env.local or the env."
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${body}`);
    }
    const data = await res.json();
    const text =
      data.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "";
    if (!text) throw new Error("Empty response from Anthropic API");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Style audit ──────────────────────────────────────────────────────

function auditStyle(draft: string): { violations: string[]; passed: boolean } {
  const violations: string[] = [];
  for (const { pattern, reason } of BANNED_TOKENS) {
    const m = draft.match(pattern);
    if (m) {
      violations.push(
        `- BANNED TOKEN matched (${reason}): \`${m[0]}\` at offset ${m.index ?? "?"}`
      );
    }
  }
  return { violations, passed: violations.length === 0 };
}

// ── Output ───────────────────────────────────────────────────────────

function writeDrafts(
  drafts: string,
  detected: { from: number | null; to: number | null },
  args: Args
): string {
  if (!existsSync(DRAFTS_DIR)) {
    mkdirSync(DRAFTS_DIR, { recursive: true });
  }
  const date = new Date().toISOString().split("T")[0];
  const versionTag =
    args.version ||
    (detected.to ? `v${detected.to}` : `untagged-${Date.now().toString(36)}`);
  const filename = `${date}-${versionTag.replace(/[^a-z0-9]/gi, "-")}.md`;
  const path = resolve(DRAFTS_DIR, filename);

  const audit = auditStyle(drafts);
  const auditSection = audit.passed
    ? "\n\n## Style audit\n\nAll banned tokens passed. Manual review still recommended.\n"
    : `\n\n## Style audit — VIOLATIONS DETECTED\n\nThe model emitted banned style tokens. Review before posting:\n\n${audit.violations.join("\n")}\n`;

  const header = `# X-post drafts — ${versionTag} (${date})\n\nGenerated by \`scripts/generate-version-post.ts\` (mode: ${args.mode}, model: ${MODEL}).\nSource changelog: \`docs/changelog-latest.md\`.\nStyle guide: \`docs/x-post-style-guide.md\`.\n\n---\n\n`;

  writeFileSync(path, header + drafts + auditSection);
  return path;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const args = parseArgs();

  if (!args.skipChangelog) {
    runChangelogGenerator(args.since);
  }

  const changelog = loadChangelog();
  const styleGuide = loadStyleGuide();
  const exemplars = loadExemplars(args.mode);
  const detected = detectVersionRange(changelog);

  console.log(
    `[post] detected version range: v${detected.from ?? "?"} → v${detected.to ?? "?"}`
  );

  const system = buildSystemPrompt(styleGuide, exemplars);
  const user = buildUserPrompt(changelog, args, detected);

  if (args.dryRun) {
    console.log("[post] --dry-run — printing prompts and exiting.");
    console.log("\n=== SYSTEM PROMPT ===\n");
    console.log(system.slice(0, 4000) + "\n... (truncated)\n");
    console.log("\n=== USER PROMPT ===\n");
    console.log(user.slice(0, 4000) + "\n... (truncated)\n");
    return;
  }

  console.log(`[post] calling ${MODEL}...`);
  const drafts = await callAnthropic(system, user);

  const path = writeDrafts(drafts, detected, args);
  console.log(`[post] wrote drafts to ${path}`);

  const audit = auditStyle(drafts);
  if (audit.passed) {
    console.log("[post] style audit: clean.");
  } else {
    console.warn(
      `[post] style audit: ${audit.violations.length} VIOLATIONS — see end of drafts file.`
    );
  }
}

main().catch((err) => {
  console.error("[post] error:", err.message || err);
  process.exit(1);
});
