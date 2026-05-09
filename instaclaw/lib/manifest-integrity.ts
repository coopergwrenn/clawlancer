/**
 * Manifest integrity check — defense against Vercel's @vercel/nft trace
 * cache serving stale `vm-manifest.ts` to bundled cron routes.
 *
 * Background incident (2026-05-09 v91 lying-DB cohort, 20 VMs stuck):
 *   The reconcile-fleet cron route imports `VM_MANIFEST` from
 *   `lib/vm-manifest.ts`. Vercel's nft trace cache served the
 *   pre-v90 vm-manifest.ts to the route across deploys. The reconciler
 *   ran with stale `configSettings` in memory but somehow still bumped
 *   `config_version` to 91, leaving 20 VMs at cv=91 with old config on
 *   disk. The `lt(config_version, 91)` filter then excluded them
 *   forever — Rule 23-shape failure at the Vercel-bundle layer.
 *
 * Defense layers in place:
 *   1. Manual `touch route.ts` cache-bust comments (commits 5e710334,
 *      16aa97c9) — REACTIVE, requires someone to notice.
 *   2. .husky/pre-commit hook auto-touching route.ts when
 *      vm-manifest.ts changes (D.3) — MECHANIZES the manual habit.
 *   3. THIS module — runtime hash compare against GitHub raw —
 *      HARD prevention. The expected SHA is fetched from a source
 *      OUTSIDE Vercel's bundle (the GitHub raw URL of the live main
 *      branch). If our bundled VM_MANIFEST doesn't match the live
 *      source-of-truth on main, we KNOW our bundle is stale and
 *      refuse to bump cv until the bundle is rebuilt.
 *
 * Why GitHub raw and not Vercel env var:
 *   - GitHub raw is free, fast, authoritative, no deploy-hook
 *     automation required.
 *   - Vercel env var would require a pre-deploy script + Vercel API
 *     token to push the SHA on every manifest change. More moving
 *     parts that can themselves break and silently mask drift.
 *   - GitHub raw is decoupled from Vercel's deploy machinery: even if
 *     the deploy succeeded with a stale bundle, the GitHub raw still
 *     reflects the latest commit on main, so the comparison catches
 *     the drift.
 *
 * Cost: one HTTP fetch per cron cold-start (~100-300ms). Cron cold-
 * starts roughly once an hour on Vercel; warm requests use cached
 * Promise resolution. Negligible.
 *
 * Failure modes handled:
 *   - GitHub raw 5xx: treat as "can't verify" — DEGRADE to logging
 *     a warning but allow cv bump (don't block on transient GitHub
 *     outage). Rationale: a stale-bundle false negative is rarer and
 *     less costly than a GitHub-outage false positive that halts the
 *     entire reconcile pipeline.
 *   - GitHub raw 404 (file moved/renamed): warn loudly, allow cv
 *     bump. Investigate the rename.
 *   - Network timeout: treat as transient, allow cv bump.
 *   - Parse error in remote vm-manifest.ts: warn, allow cv bump.
 *   - SHA mismatch with parseable both sides: HARD STOP — refuse cv
 *     bump for this cycle.
 *
 * P0 alert criteria:
 *   - Successful GitHub fetch + parseable both sides + SHA mismatch.
 *     This is a confirmed bundle-staleness signal — page immediately.
 *
 * Dynamic-value keys (e.g., `String(BOOTSTRAP_MAX_CHARS)`):
 *   The parser regex only matches `"key": "value"` literal pairs. Lines
 *   like `"agents.defaults.bootstrapMaxChars": String(BOOTSTRAP_MAX_CHARS),`
 *   evaluate to a string at runtime but appear as a non-quoted expression
 *   in the source. If we naively hashed the runtime's computed value
 *   while the parser skipped the line entirely, the SHAs would never
 *   match and the integrity check would halt the cron on every tick (a
 *   guaranteed false positive). Fix: parseRemoteManifest also returns
 *   `dynamicKeys` (keys whose RHS isn't a quoted literal), and
 *   verifyManifestFreshness filters BOTH the runtime and parsed
 *   configSettings down to the same key subset before hashing.
 *
 *   Trade-off: drift in dynamic-value keys (e.g., a change to
 *   BOOTSTRAP_MAX_CHARS) is NOT caught by the integrity check. Acceptable
 *   because the alternative is the cron permanently 503-ing on every
 *   tick. If a dynamic-value key turns out to be load-bearing for stale-
 *   bundle detection, convert it to a quoted literal in the source.
 */
import { createHash } from "crypto";

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/coopergwrenn/clawlancer/main/instaclaw/lib/vm-manifest.ts";

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — re-fetch every 15 min

export type ManifestIntegrityVerdict =
  | { ok: true; fresh: true; reason: "verified"; runtime_version: number; runtime_sha: string; remote_sha: string }
  | { ok: true; fresh: false; reason: "stale_bundle"; runtime_version: number; remote_version: number | null; runtime_sha: string; remote_sha: string }
  | { ok: false; reason: "github_unreachable" | "github_5xx" | "github_404" | "github_parse_err" | "network_timeout"; detail: string };

interface CachedVerdict { v: ManifestIntegrityVerdict; ts: number }
let memoCache: CachedVerdict | null = null;

/**
 * Compute a stable SHA of (version, configSettings) for the locally
 * imported VM_MANIFEST. Used both at runtime and against the GitHub
 * raw fetch's parsed result.
 *
 * configSettings is JSON-stringified with sorted keys so the SHA is
 * deterministic regardless of object property order.
 */
export function computeManifestSha(version: number, configSettings: Record<string, string>): string {
  const sortedKeys = Object.keys(configSettings).sort();
  const canonical = JSON.stringify({
    version,
    configSettings: Object.fromEntries(sortedKeys.map((k) => [k, configSettings[k]])),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Best-effort parse of the remote vm-manifest.ts source code. The file
 * is TypeScript, not JSON, so we extract `version` and `configSettings`
 * via regex against the known declaration shape:
 *   version: 91,
 *   configSettings: {
 *     "key": "value",
 *     ...
 *   },
 *
 * If the file shape changes substantially (e.g., refactored into a
 * different export structure), this regex will fail and the caller
 * gets `github_parse_err` — at which point the manifest-integrity
 * check should be revisited alongside the refactor.
 */
function parseRemoteManifest(src: string): {
  version: number;
  configSettings: Record<string, string>;
  dynamicKeys: string[];
} | null {
  const versionMatch = src.match(/version:\s*(\d+)/);
  if (!versionMatch) return null;
  const version = parseInt(versionMatch[1], 10);
  // Extract the configSettings object literal. Match from
  // `configSettings: {` to the matching closing `}` followed by `,`.
  const csStart = src.indexOf("configSettings:");
  if (csStart < 0) return null;
  const openBraceIdx = src.indexOf("{", csStart);
  if (openBraceIdx < 0) return null;
  // Walk forward, tracking brace depth, to find the matching close.
  let depth = 0;
  let closeBraceIdx = -1;
  for (let i = openBraceIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { closeBraceIdx = i; break; }
    }
  }
  if (closeBraceIdx < 0) return null;
  const csBody = src.slice(openBraceIdx + 1, closeBraceIdx);
  // Extract "key": "value" pairs. Skip lines starting with // (comments).
  // Lines that match the key-pattern but NOT a quoted-string value (e.g.,
  // `"key": String(VAR),` or `"key": SOME_CONSTANT,`) are recorded in
  // dynamicKeys so the verifier can filter them out of BOTH the runtime
  // and parsed sides before hashing — see file-level docblock.
  const settings: Record<string, string> = {};
  const dynamicKeys: string[] = [];
  const lines = csBody.split("\n");
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (trimmed.startsWith("//") || trimmed.length === 0) continue;
    const kvMatch = trimmed.match(/^"([^"]+)":\s*"([^"]*)"/);
    if (kvMatch) {
      settings[kvMatch[1]] = kvMatch[2];
      continue;
    }
    // Line starts with a quoted key but the RHS isn't a quoted literal.
    // Capture the key for the dynamicKeys exclusion list.
    const keyOnly = trimmed.match(/^"([^"]+)":/);
    if (keyOnly) dynamicKeys.push(keyOnly[1]);
  }
  return { version, configSettings: settings, dynamicKeys };
}

/**
 * Fetch the live vm-manifest.ts from main on GitHub, parse it,
 * compare against the locally imported runtime values, return
 * a verdict.
 *
 * Memoized for CACHE_TTL_MS to amortize the HTTP cost across cron
 * fires within the same warm window.
 */
export async function verifyManifestFreshness(
  runtimeVersion: number,
  runtimeConfigSettings: Record<string, string>,
): Promise<ManifestIntegrityVerdict> {
  const now = Date.now();
  if (memoCache && now - memoCache.ts < CACHE_TTL_MS) return memoCache.v;

  // Runtime SHA is computed AFTER the parser returns, because we need
  // parsed.dynamicKeys to filter both sides to the same key subset.
  let res: Response;
  try {
    res = await fetch(GITHUB_RAW_URL, {
      method: "GET",
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const verdict: ManifestIntegrityVerdict = {
      ok: false,
      reason: "network_timeout",
      detail: (e as Error)?.message || String(e),
    };
    memoCache = { v: verdict, ts: now };
    return verdict;
  }
  if (res.status === 404) {
    const verdict: ManifestIntegrityVerdict = {
      ok: false,
      reason: "github_404",
      detail: `${GITHUB_RAW_URL} returned 404 — file may have moved or been renamed`,
    };
    memoCache = { v: verdict, ts: now };
    return verdict;
  }
  if (res.status >= 500) {
    const verdict: ManifestIntegrityVerdict = {
      ok: false,
      reason: "github_5xx",
      detail: `${GITHUB_RAW_URL} returned ${res.status}`,
    };
    memoCache = { v: verdict, ts: now };
    return verdict;
  }
  if (!res.ok) {
    const verdict: ManifestIntegrityVerdict = {
      ok: false,
      reason: "github_unreachable",
      detail: `${GITHUB_RAW_URL} returned ${res.status}`,
    };
    memoCache = { v: verdict, ts: now };
    return verdict;
  }

  const body = await res.text();
  const parsed = parseRemoteManifest(body);
  if (!parsed) {
    const verdict: ManifestIntegrityVerdict = {
      ok: false,
      reason: "github_parse_err",
      detail: `Could not extract version + configSettings from remote vm-manifest.ts (${body.length} bytes). Has the file shape changed? Update parseRemoteManifest in lib/manifest-integrity.ts.`,
    };
    memoCache = { v: verdict, ts: now };
    return verdict;
  }

  // Filter both sides to exclude dynamic-value keys (those the parser
  // could not extract because the RHS isn't a quoted string literal).
  // The runtime side has the evaluated value; the parsed side has nothing.
  // Hashing the union would always mismatch — see file-level docblock.
  const dynamicKeySet = new Set(parsed.dynamicKeys);
  const filteredRuntime: Record<string, string> = {};
  for (const [k, v] of Object.entries(runtimeConfigSettings)) {
    if (!dynamicKeySet.has(k)) filteredRuntime[k] = v;
  }
  const filteredRuntimeSha = computeManifestSha(runtimeVersion, filteredRuntime);
  const remoteSha = computeManifestSha(parsed.version, parsed.configSettings);
  const fresh = remoteSha === filteredRuntimeSha;
  const verdict: ManifestIntegrityVerdict = fresh
    ? {
        ok: true, fresh: true, reason: "verified",
        runtime_version: runtimeVersion, runtime_sha: filteredRuntimeSha, remote_sha: remoteSha,
      }
    : {
        ok: true, fresh: false, reason: "stale_bundle",
        runtime_version: runtimeVersion, remote_version: parsed.version,
        runtime_sha: filteredRuntimeSha, remote_sha: remoteSha,
      };
  memoCache = { v: verdict, ts: now };
  return verdict;
}

/**
 * Test helper — clear the module-local cache. Used in unit tests to
 * exercise multiple verdicts in sequence.
 */
export function __resetManifestIntegrityCache() { memoCache = null; }
