/**
 * lib/base-skills-registry.ts — Base MCP skill plugin source-mode abstraction.
 *
 * The layering primitive every other piece of Base MCP integration depends on.
 *
 * Background: Base launched Base MCP on 2026-05-26 with 7 launch-partner skill
 * plugins (Morpho, Moonwell, Aerodrome, Uniswap, Avantis, Virtuals, Bankr).
 * "More is coming." Skill plugins are markdown files documenting how an LLM
 * agent should compose a protocol's HTTP endpoints to discover state and
 * construct unsigned calldata. We compose them natively (no mcp.base.org
 * OAuth dance) — see `instaclaw/docs/prd/base-mcp-integration.md` §4.1.
 *
 * This module provides the SOURCE-MODE ABSTRACTION:
 *
 *   • vendored      — read markdown from instaclaw/skills/base-*\/SKILL.md
 *                     (default; zero external dependency; full audit trail)
 *   • live-fetch    — HTTP GET each entry's upstreamUrl on demand
 *                     (falls back to vendored on fetch failure)
 *   • registry-api  — query Base's registry API endpoint (when shipped)
 *                     (falls back to live-fetch, then vendored)
 *
 * The mode is controlled by the env var BASE_SKILLS_SOURCE_MODE. Unknown
 * values default to "vendored" per CLAUDE.md Rule 61 (boolean-env value
 * validation).
 *
 * The agent runtime never knows or cares which mode is active — it always
 * reads from ~/.openclaw/skills/base-*\/SKILL.md on disk. What changes per
 * mode is the pipeline that puts the file there. Flipping modes is a single
 * Vercel env-var change; the on-VM agent is untouched.
 *
 * See:
 *   - PRD §4.5 (architectural guardrail), §4.6 (probe cron), §4.7 (done-when)
 *   - Addendum §1 (three-tier freshness design, upstream-change surface)
 *   - CLAUDE.md Rules 10 (verify-after-set), 23 (sentinel guard), 39
 *     (warnings vs errors), 47 (continuous reconciliation), 61 (env-var
 *     value validation)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type BaseSkillSourceMode = "vendored" | "live-fetch" | "registry-api";

export interface BaseSkillReference {
  /** Path relative to the skill directory, e.g. "references/api.md" */
  remotePath: string;
  /** Canonical upstream URL for live-fetch mode */
  upstreamUrl: string;
  /** Pinned upstream commit SHA for the vendored copy (audit trail) */
  upstreamCommitSha?: string;
}

export interface BaseSkillEntry {
  /** Short stable name. Used as cache key and in log lines. */
  name: string;
  /**
   * Subdirectory under `instaclaw/skills/`, conventionally `base-<name>`.
   * The on-VM path is always `~/.openclaw/skills/<vendoredPath>/SKILL.md`.
   */
  vendoredPath: string;
  /**
   * Canonical upstream URL for live-fetch mode. Today usually a github raw
   * URL; later may be a partner-hosted skill manifest or a Base registry API
   * endpoint.
   */
  upstreamUrl: string;
  /** Pinned upstream commit SHA for the vendored copy (audit trail). */
  upstreamCommitSha?: string;
  /** ISO date string when the vendored copy was last refreshed. */
  importedAt?: string;
  /**
   * Optional supplementary files (references, assets) deployed alongside
   * the main SKILL.md. Each goes to `~/.openclaw/skills/<vendoredPath>/<remotePath>`.
   */
  references?: BaseSkillReference[];
  /**
   * Strings that MUST appear in the resolved content (CLAUDE.md Rule 23).
   * If any sentinel is missing, validation fails — protects against silent
   * upstream content corruption and stale-module-cache regressions.
   * Typical: a version marker like "BASE_SKILL_MORPHO_V1".
   */
  requiredSentinels?: string[];
  /**
   * Whether this entry was authored by InstaClaw vs. vendored from an
   * upstream Base/partner publication. Affects how the probe cron alerts.
   */
  authorship?: "instaclaw-authored" | "vendored-from-upstream";
  /**
   * Short human-readable description of what the skill enables. Used in
   * coverage scripts and operator-facing tooling.
   */
  description?: string;
}

export interface BaseSkillContent {
  /** The skill plugin markdown body. */
  content: string;
  /**
   * The mode that actually produced this content. May differ from the
   * caller's requested mode when fallback fires. Example: caller asks for
   * "live-fetch", upstream is 503, response returns sourceMode "vendored".
   */
  sourceMode: BaseSkillSourceMode;
  /** When the content was loaded (or, on cache hit, originally loaded). */
  fetchedAt: Date;
  /** sha256 hex digest of `content` for cheap comparison on the reconciler. */
  sha256: string;
  /** Where the content actually came from (file:// URL or HTTPS URL). */
  sourceUrl?: string;
}

/** Thrown by the registry-api path until Base ships an actual API. */
export class RegistryApiNotYetAvailable extends Error {
  constructor(msg: string = "Base registry API not yet shipped") {
    super(msg);
    this.name = "RegistryApiNotYetAvailable";
  }
}

/** Thrown when sentinel validation fails (Rule 23 enforcement). */
export class BaseSkillSentinelError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BaseSkillSentinelError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CATALOG — single source of truth for vendored + live-fetch modes
// ═══════════════════════════════════════════════════════════════════════════
//
// Populated in Task B alongside vendoring the actual SKILL.md files.
// Each entry's `upstreamUrl` is what the live-fetch mode HTTP-GETs and what
// the probe cron HEADs to detect upstream drift.
//
// AUTHORSHIP NOTE (decision 2026-05-26): the launch-day partner skill plugin
// markdowns are NOT yet published at canonical URLs we can subscribe to. The
// skills.sh API exists but its `source=base` index lists developer-tooling
// skills, not the protocol skill plugins. Rather than wait, we author v1
// versions ourselves based on each protocol's documented public API + the
// Base custom-plugin spec. The probe cron watches for upstream publications;
// when they appear we re-vendor or stay with ours (we keep what's better).
//
// See PRD §12.1 Task B and Addendum §1.2 for the full rationale.

// GitHub raw URL prefix for the upstreamUrl field. Lets live-fetch mode
// resolve against our own repo (any update committed + pushed reaches the
// fleet within ~5 min of the next file-drift cron). When the actual
// Base/partner-canonical URLs are published, individual entries' upstreamUrl
// should be updated to point at those.
const INSTACLAW_GH_RAW =
  "https://raw.githubusercontent.com/coopergwrenn/clawlancer/main/instaclaw/skills";

const VENDORED_2026_05_26 = "2026-05-26T00:00:00Z";

export const BASE_SKILL_CATALOG: BaseSkillEntry[] = [
  {
    name: "morpho",
    vendoredPath: "base-morpho",
    upstreamUrl: `${INSTACLAW_GH_RAW}/base-morpho/SKILL.md`,
    importedAt: VENDORED_2026_05_26,
    authorship: "instaclaw-authored",
    requiredSentinels: ["BASE_SKILL_MORPHO_V1"],
    description:
      "Lend USDC and ERC20s on Morpho (Base) — list vaults by APY, supply, check positions, withdraw.",
  },
  {
    name: "moonwell",
    vendoredPath: "base-moonwell",
    upstreamUrl: `${INSTACLAW_GH_RAW}/base-moonwell/SKILL.md`,
    importedAt: VENDORED_2026_05_26,
    authorship: "instaclaw-authored",
    requiredSentinels: ["BASE_SKILL_MOONWELL_V1"],
    description:
      "Supply, borrow, and manage Moonwell money-market positions on Base (Compound v2 fork: mUSDC, mWETH, mcbBTC).",
  },
  {
    name: "aerodrome",
    vendoredPath: "base-aerodrome",
    upstreamUrl: `${INSTACLAW_GH_RAW}/base-aerodrome/SKILL.md`,
    importedAt: VENDORED_2026_05_26,
    authorship: "instaclaw-authored",
    requiredSentinels: ["BASE_SKILL_AERODROME_V1"],
    description:
      "Swap, LP, and stake on Aerodrome (Base's leading DEX) — stable + volatile pools, AERO emissions.",
  },
  {
    name: "uniswap",
    vendoredPath: "base-uniswap",
    upstreamUrl: `${INSTACLAW_GH_RAW}/base-uniswap/SKILL.md`,
    importedAt: VENDORED_2026_05_26,
    authorship: "instaclaw-authored",
    requiredSentinels: ["BASE_SKILL_UNISWAP_V1"],
    description:
      "Swap via Uniswap v3 on Base (Universal Router + QuoterV2) and manage concentrated-liquidity positions.",
  },
  {
    name: "avantis",
    vendoredPath: "base-avantis",
    upstreamUrl: `${INSTACLAW_GH_RAW}/base-avantis/SKILL.md`,
    importedAt: VENDORED_2026_05_26,
    authorship: "instaclaw-authored",
    requiredSentinels: ["BASE_SKILL_AVANTIS_V1"],
    description:
      "Open and manage USDC-margined perpetuals on Avantis (Base) — up to 100x leverage, multi-asset markets.",
  },
  {
    name: "virtuals",
    vendoredPath: "base-virtuals",
    upstreamUrl: `${INSTACLAW_GH_RAW}/base-virtuals/SKILL.md`,
    importedAt: VENDORED_2026_05_26,
    authorship: "instaclaw-authored",
    requiredSentinels: ["BASE_SKILL_VIRTUALS_V1"],
    description:
      "Discover and trade Virtuals Protocol agent tokens on Base (Sentient + Prototype) — includes $INSTACLAW awareness.",
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// MODE RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the active source mode from BASE_SKILLS_SOURCE_MODE env var.
 *
 * Per CLAUDE.md Rule 61: unknown values default to the safe baseline
 * (vendored). The pre-bake check (Rule 61 implementation in
 * scripts/_pre-bake-check.ts) catches misconfigured values at deploy time.
 *
 * Recognized values: "vendored", "live-fetch", "registry-api".
 * Anything else → "vendored" (silent default; the bake check is loud).
 */
export function currentSourceMode(): BaseSkillSourceMode {
  const raw = process.env.BASE_SKILLS_SOURCE_MODE;
  if (raw === "live-fetch" || raw === "registry-api" || raw === "vendored") {
    return raw;
  }
  return "vendored";
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE — in-memory, 5-min TTL, keyed by (name, mode)
// ═══════════════════════════════════════════════════════════════════════════
//
// Two callers benefit:
//   - The reconciler's stepBaseSkills (called per VM × per skill) reuses
//     within a single reconcile cycle (~30-60s for 5 VMs × 6 skills).
//   - The probe cron, when it checks upstream drift, reuses for the
//     hourly probe window (multiple checks within the same hour share).
//
// Errors are NEVER cached — every failed fetch retries.
// Cache is process-local — Vercel cold-starts get a fresh cache, which
// is fine (the next reconcile cycle re-warms).

interface CacheEntry {
  content: BaseSkillContent;
  expiresAt: number;
}

const _cache: Map<string, CacheEntry> = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(entry: BaseSkillEntry, mode: BaseSkillSourceMode): string {
  return `${entry.name}::${mode}`;
}

/** Test hook — DO NOT call from production code. */
export function _clearCacheForTesting(): void {
  _cache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the active skill catalog.
 *
 * In vendored / live-fetch modes: returns the static BASE_SKILL_CATALOG.
 * In registry-api mode: queries the (not-yet-shipped) Base registry API,
 *   falls back to BASE_SKILL_CATALOG on failure.
 *
 * The catalog determines WHICH skills exist. The content of each skill is
 * resolved separately via getBaseSkillContent().
 */
export async function getBaseSkillCatalog(
  mode: BaseSkillSourceMode = currentSourceMode(),
): Promise<BaseSkillEntry[]> {
  if (mode === "registry-api") {
    try {
      return await fetchCatalogFromRegistryApi();
    } catch (err) {
      if (err instanceof RegistryApiNotYetAvailable) {
        // Silent fallback — the probe cron alerts when the API arrives.
        return BASE_SKILL_CATALOG;
      }
      throw err;
    }
  }
  return BASE_SKILL_CATALOG;
}

/**
 * Resolve the content of a specific skill in the requested mode.
 *
 * Behavior per mode:
 *   - vendored: read from instaclaw/skills/<vendoredPath>/SKILL.md. Throws
 *     if the file is missing (programming or deploy bug).
 *   - live-fetch: HTTP GET upstreamUrl with 10s timeout. On any failure
 *     (timeout, non-2xx, network), falls back silently to vendored. Returns
 *     sourceMode: "vendored" in the response when fallback fires so the
 *     caller can tell.
 *   - registry-api: throws RegistryApiNotYetAvailable today; that error is
 *     caught and falls through to live-fetch, then vendored.
 *
 * Sentinel validation (CLAUDE.md Rule 23): if entry.requiredSentinels is
 * non-empty, the resolved content MUST contain every sentinel. On failure,
 * throws BaseSkillSentinelError. This defends against silent upstream
 * content corruption (e.g., the canonical URL starts returning a 200 page
 * with a "removed" notice instead of the real markdown).
 *
 * Cache: results cached for 5 minutes keyed by (entry.name, mode). Errors
 * are never cached.
 */
export async function getBaseSkillContent(
  entry: BaseSkillEntry,
  mode: BaseSkillSourceMode = currentSourceMode(),
): Promise<BaseSkillContent> {
  const key = cacheKey(entry, mode);
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.content;
  }

  let result: BaseSkillContent;
  if (mode === "vendored") {
    result = await fetchVendored(entry);
  } else if (mode === "live-fetch") {
    result = await fetchLiveOrFallback(entry);
  } else if (mode === "registry-api") {
    result = await fetchFromRegistryApiOrFallback(entry);
  } else {
    // Defensive — TypeScript guarantees we don't get here, but in case of
    // runtime corruption (e.g., loaded from a JSON config), fall back safely.
    result = await fetchVendored(entry);
  }

  // Sentinel validation runs AFTER resolution, regardless of mode/fallback.
  // This means a corrupt upstream + a missing-sentinel vendored copy will
  // both fail loudly. Failing loudly is the goal.
  validateSentinels(entry, result);

  _cache.set(key, { content: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Resolve the content of a supplementary reference file (e.g., a `references/`
 * markdown file alongside the main SKILL.md).
 *
 * Same mode semantics + fallback chain as getBaseSkillContent. Sentinel
 * validation does NOT apply to references — those are typically auxiliary
 * docs the agent reads on demand, not load-bearing routing surfaces.
 */
export async function getBaseSkillReferenceContent(
  entry: BaseSkillEntry,
  ref: BaseSkillReference,
  mode: BaseSkillSourceMode = currentSourceMode(),
): Promise<BaseSkillContent> {
  if (mode === "vendored") {
    return fetchVendoredReference(entry, ref);
  }
  if (mode === "live-fetch") {
    return fetchLiveReferenceOrFallback(entry, ref);
  }
  // registry-api: fall through to live-fetch then vendored
  try {
    return await fetchLiveReferenceOrFallback(entry, ref);
  } catch {
    return fetchVendoredReference(entry, ref);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION DETAILS — per-mode adapters
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the repository root for vendored-mode disk reads.
 *
 * Order of preference:
 *   1. INSTACLAW_REPO_ROOT env var (set in tests, dev scripts that need
 *      to point at a specific worktree)
 *   2. process.cwd() (Vercel function root, monorepo working dir)
 *
 * The skills directory must live at <root>/skills/. This matches the
 * existing stepSkills behavior at lib/vm-reconcile.ts:5397.
 */
function resolveRepoRoot(): string {
  const envRoot = process.env.INSTACLAW_REPO_ROOT;
  if (envRoot && envRoot.length > 0) return envRoot;
  return process.cwd();
}

async function fetchVendored(entry: BaseSkillEntry): Promise<BaseSkillContent> {
  const skillPath = path.join(
    resolveRepoRoot(),
    "skills",
    entry.vendoredPath,
    "SKILL.md",
  );
  const content = await fs.promises.readFile(skillPath, "utf-8");
  return {
    content,
    sourceMode: "vendored",
    fetchedAt: new Date(),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    sourceUrl: `file://${skillPath}`,
  };
}

async function fetchVendoredReference(
  entry: BaseSkillEntry,
  ref: BaseSkillReference,
): Promise<BaseSkillContent> {
  const refPath = path.join(
    resolveRepoRoot(),
    "skills",
    entry.vendoredPath,
    ref.remotePath,
  );
  const content = await fs.promises.readFile(refPath, "utf-8");
  return {
    content,
    sourceMode: "vendored",
    fetchedAt: new Date(),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    sourceUrl: `file://${refPath}`,
  };
}

async function fetchLiveOrFallback(
  entry: BaseSkillEntry,
): Promise<BaseSkillContent> {
  try {
    return await fetchUpstream(entry.upstreamUrl);
  } catch {
    // Silent fallback. The probe cron reports persistent upstream
    // failures separately so we don't double-alert from here.
    return fetchVendored(entry);
  }
}

async function fetchLiveReferenceOrFallback(
  entry: BaseSkillEntry,
  ref: BaseSkillReference,
): Promise<BaseSkillContent> {
  try {
    return await fetchUpstream(ref.upstreamUrl);
  } catch {
    return fetchVendoredReference(entry, ref);
  }
}

async function fetchFromRegistryApiOrFallback(
  entry: BaseSkillEntry,
): Promise<BaseSkillContent> {
  try {
    return await fetchFromRegistryApi(entry);
  } catch (err) {
    if (err instanceof RegistryApiNotYetAvailable) {
      return fetchLiveOrFallback(entry);
    }
    throw err;
  }
}

/**
 * Generic HTTP fetch helper with 10s timeout. Used by both content and
 * reference fetches. Throws on non-2xx, network failure, or timeout.
 *
 * Always returns sourceMode: "live-fetch" — callers can override if they
 * need to indicate fallback semantics.
 */
async function fetchUpstream(url: string): Promise<BaseSkillContent> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Polite UA so partners can identify InstaClaw traffic if they
        // want to whitelist or rate-limit us specifically.
        "user-agent": "instaclaw-base-skills-registry/1 (+https://instaclaw.io)",
      },
    });
    if (!res.ok) {
      throw new Error(`upstream ${url} returned HTTP ${res.status}`);
    }
    const content = await res.text();
    return {
      content,
      sourceMode: "live-fetch",
      fetchedAt: new Date(),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      sourceUrl: url,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Placeholder for the registry-api adapter. Throws RegistryApiNotYetAvailable
 * today; will be implemented when Base ships a real registry API. The probe
 * cron (app/api/cron/probe-base-skills-registry) watches for that API and
 * alerts an operator when it appears.
 *
 * When implemented, this function will:
 *   1. HTTP GET the per-entry endpoint (e.g.
 *      https://api.base.org/registry/skills/{entry.name})
 *   2. Parse the response; extract the canonical content blob
 *   3. Compute sha256, return as BaseSkillContent with sourceMode "registry-api"
 */
async function fetchFromRegistryApi(
  _entry: BaseSkillEntry,
): Promise<BaseSkillContent> {
  throw new RegistryApiNotYetAvailable(
    `No Base registry API endpoint configured. The probe cron at ` +
      `app/api/cron/probe-base-skills-registry watches for it and will ` +
      `alert when it appears.`,
  );
}

/**
 * Placeholder for the catalog-discovery adapter. Throws today; will be
 * implemented alongside fetchFromRegistryApi when Base ships the real API.
 *
 * When implemented, this function will:
 *   1. HTTP GET the registry's list endpoint
 *      (e.g. https://api.base.org/registry/skills?since=...)
 *   2. Return the list as BaseSkillEntry[], with upstreamUrl pointing back
 *      at the per-entry endpoint
 *
 * The major win: new launch partners light up in the fleet automatically,
 * no manual catalog edits required.
 */
async function fetchCatalogFromRegistryApi(): Promise<BaseSkillEntry[]> {
  throw new RegistryApiNotYetAvailable(
    `No Base registry API endpoint configured. Catalog falls back to ` +
      `BASE_SKILL_CATALOG (the hardcoded vendored set).`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enforce required sentinels (CLAUDE.md Rule 23).
 *
 * If entry.requiredSentinels is set, every listed string MUST appear in the
 * resolved content. Failure throws BaseSkillSentinelError, which the
 * reconciler (per Rule 39) translates into result.warnings and SKIPS the
 * on-disk write — leaving the previous good copy in place. The probe cron
 * surfaces the upstream-drift event for operator review.
 *
 * This protects against:
 *   - Upstream canonical URL replaced with a stub / 404 / redirect
 *   - Partner-shipped breaking change that removes the load-bearing prompt
 *   - Stale module cache returning empty/old content
 */
function validateSentinels(
  entry: BaseSkillEntry,
  result: BaseSkillContent,
): void {
  if (!entry.requiredSentinels?.length) return;
  const missing = entry.requiredSentinels.filter(
    (s) => !result.content.includes(s),
  );
  if (missing.length) {
    throw new BaseSkillSentinelError(
      `[base-skills-registry] resolved content for "${entry.name}" ` +
        `(source: ${result.sourceUrl ?? "<unknown>"}, mode: ${result.sourceMode}) ` +
        `is missing required sentinel(s): ` +
        `${missing.map((s) => JSON.stringify(s)).join(", ")}. ` +
        `Likely causes: upstream content stub, broken partner publish, ` +
        `stale module cache. The on-disk version (if any) is preserved.`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the on-VM target path for a skill's SKILL.md file. The agent
 * runtime reads from this path regardless of source mode.
 */
export function onVmSkillPath(entry: BaseSkillEntry): string {
  return `/home/openclaw/.openclaw/skills/${entry.vendoredPath}/SKILL.md`;
}

/**
 * Compute the on-VM target path for a reference file under the skill dir.
 */
export function onVmReferencePath(
  entry: BaseSkillEntry,
  ref: BaseSkillReference,
): string {
  return `/home/openclaw/.openclaw/skills/${entry.vendoredPath}/${ref.remotePath}`;
}

/**
 * Is this catalog entry "fresh" by import-date semantics? Used by the
 * probe cron to flag stale vendored entries that should be refreshed.
 */
export function isBaseSkillEntryFresh(
  entry: BaseSkillEntry,
  maxAgeMs: number,
): boolean {
  if (!entry.importedAt) return false;
  const importedAt = new Date(entry.importedAt).getTime();
  if (Number.isNaN(importedAt)) return false;
  return Date.now() - importedAt < maxAgeMs;
}

/**
 * Get the set of vendored-path strings — useful for stepSkills to skip
 * deploying base-* skills via the generic skillsFromRepo path (since
 * stepBaseSkills owns them exclusively).
 */
export function getBaseSkillVendoredPaths(): Set<string> {
  return new Set(BASE_SKILL_CATALOG.map((e) => e.vendoredPath));
}
