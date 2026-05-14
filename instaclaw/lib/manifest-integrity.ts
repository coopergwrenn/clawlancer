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
 * P0 alert criteria (wired in the route, not here):
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
 *   configSettings + envVarDefaults down to the same key subset before
 *   hashing.
 *
 *   Trade-off: drift in dynamic-value keys (e.g., a change to
 *   BOOTSTRAP_MAX_CHARS) is NOT caught by the integrity check. Acceptable
 *   because the alternative is the cron permanently 503-ing on every
 *   tick. If a dynamic-value key turns out to be load-bearing for stale-
 *   bundle detection, convert it to a quoted literal in the source.
 *
 * Hash coverage (P1-4 §C, 2026-05-14):
 *   The fingerprint extends beyond `version + configSettings` to also
 *   include `cronJobs[].marker`, `requiredEnvVars`, and `envVarDefaults`.
 *   These were the most-likely drift candidates in a future nft-cache
 *   incident — currently each has its own per-step verify-after-set
 *   discipline at the SSH layer, but the manifest-level fingerprint
 *   catches drift before it ever reaches a VM. Other manifest fields
 *   (files, systemdOverrides, systemdUnitOverrides, etc.) contain
 *   non-quoted-literal values too widely to be cleanly parsed; the
 *   per-step verify-after-set patterns (Rule 10) are the load-bearing
 *   defense for those fields' drift.
 */
import { createHash } from "crypto";

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/coopergwrenn/clawlancer/main/instaclaw/lib/vm-manifest.ts";

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — re-fetch every 15 min

/**
 * Manifest fingerprint — the subset of VM_MANIFEST fields that the
 * integrity check hashes and compares.
 *
 * Picked for two properties:
 *   1. JSON-safe — every value is a string, number, or array of strings.
 *      Lets us hash deterministically without object-identity gotchas.
 *   2. Source-parseable — extractable via regex from vm-manifest.ts
 *      without TypeScript compilation. The parser's regex must be able
 *      to find every field in the raw source.
 *
 * Fields NOT included (and why):
 *   - `files`         — too complex (mix of inline strings + templateKey
 *                       references + JSON.stringify values). Per-entry
 *                       Rule 23 requiredSentinels are the load-bearing
 *                       defense.
 *   - `cronJobs.schedule/command` — these contain shell commands with
 *     quoting / interpolation that breaks the simple regex parser.
 *     Markers alone identify a cron entry uniquely.
 *   - `systemdOverrides/systemdUnitOverrides` — Record<string,string>
 *     but the values contain shell snippets / multi-line content.
 *     Could be added in a future hardening pass.
 *   - `pythonPackages/systemPackages` — simple arrays of strings, would
 *     be safe to include. Skipped for now to keep the parser simple;
 *     drift in these would surface via stepSystemPackages/PythonPackages
 *     errors quickly anyway.
 *   - `openclawJsonSettings` — only used at provision time, not by the
 *     reconciler. Not in the cv-bump path; not load-bearing.
 */
export interface ManifestFingerprint {
  version: number;
  configSettings: Record<string, string>;
  cronMarkers: string[];        // sorted at hash time; order-insensitive
  requiredEnvVars: string[];    // sorted at hash time; order-insensitive
  envVarDefaults: Record<string, string>;
}

/**
 * Build a ManifestFingerprint from the in-memory VM_MANIFEST. Callers
 * pass this to `verifyManifestFreshness` so the GitHub-raw comparison
 * is over the same shape on both sides.
 *
 * Typed loosely against the manifest's actual shape — accepting any
 * record with the fields we care about — to avoid a circular import
 * (manifest-integrity is imported by code that imports VM_MANIFEST).
 */
export function manifestFingerprint(m: {
  version: number;
  configSettings: Record<string, string>;
  cronJobs: ReadonlyArray<{ marker: string }>;
  requiredEnvVars: readonly string[];
  envVarDefaults: Record<string, string>;
}): ManifestFingerprint {
  return {
    version: m.version,
    configSettings: m.configSettings,
    cronMarkers: m.cronJobs.map((j) => j.marker),
    requiredEnvVars: [...m.requiredEnvVars],
    envVarDefaults: m.envVarDefaults,
  };
}

export type ManifestIntegrityVerdict =
  | {
      ok: true;
      fresh: true;
      reason: "verified";
      runtime_version: number;
      runtime_sha: string;
      remote_sha: string;
    }
  | {
      ok: true;
      fresh: false;
      reason: "stale_bundle";
      runtime_version: number;
      remote_version: number | null;
      runtime_sha: string;
      remote_sha: string;
      diff_summary: string; // human-readable hint about what differs
    }
  | {
      ok: false;
      reason:
        | "github_unreachable"
        | "github_5xx"
        | "github_404"
        | "github_parse_err"
        | "network_timeout";
      detail: string;
    };

interface CachedVerdict {
  v: ManifestIntegrityVerdict;
  ts: number;
}
let memoCache: CachedVerdict | null = null;

/**
 * Canonical JSON of a fingerprint, sorted at every level so the hash is
 * deterministic regardless of object property order or array order.
 *
 * Arrays (`cronMarkers`, `requiredEnvVars`) are sorted lexicographically
 * before hashing so marker re-ordering doesn't cause spurious mismatches.
 */
function canonicalizeFingerprint(fp: ManifestFingerprint): string {
  const sortedSettings = Object.fromEntries(
    Object.keys(fp.configSettings)
      .sort()
      .map((k) => [k, fp.configSettings[k]]),
  );
  const sortedEnvDefaults = Object.fromEntries(
    Object.keys(fp.envVarDefaults)
      .sort()
      .map((k) => [k, fp.envVarDefaults[k]]),
  );
  return JSON.stringify({
    version: fp.version,
    configSettings: sortedSettings,
    cronMarkers: [...fp.cronMarkers].sort(),
    requiredEnvVars: [...fp.requiredEnvVars].sort(),
    envVarDefaults: sortedEnvDefaults,
  });
}

/**
 * Compute a stable SHA of a fingerprint. Used both at runtime and against
 * the GitHub raw fetch's parsed result.
 */
export function computeManifestSha(fp: ManifestFingerprint): string {
  return createHash("sha256").update(canonicalizeFingerprint(fp)).digest("hex");
}

/**
 * Parsed shape returned by `parseRemoteManifest`. `dynamicConfigKeys` /
 * `dynamicEnvVarDefaultKeys` are the keys whose RHS in the source isn't
 * a quoted literal (e.g., `String(BOOTSTRAP_MAX_CHARS)`) — the verifier
 * filters these out of BOTH sides before hashing.
 */
interface ParsedManifest {
  version: number;
  configSettings: Record<string, string>;
  cronMarkers: string[];
  requiredEnvVars: string[];
  envVarDefaults: Record<string, string>;
  dynamicConfigKeys: string[];
  dynamicEnvVarDefaultKeys: string[];
}

/**
 * Walk forward from openBraceIdx tracking brace depth to find the matching
 * close. Returns -1 if unbalanced.
 */
function findMatchingClose(src: string, openBraceIdx: number): number {
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse a Record<string, string> object literal from the body. Returns
 * { settings, dynamicKeys } where dynamicKeys are quoted-key lines whose
 * RHS wasn't a quoted literal (and so the value couldn't be extracted).
 *
 * Walks line-by-line and matches the canonical shapes:
 *   "key": "value",       → extracted
 *   "key": "value"        → extracted (trailing comma optional)
 *   "key": String(VAR),   → recorded in dynamicKeys, value not extracted
 *   "key": SOME_CONST,    → recorded in dynamicKeys
 *   // comment            → skipped
 *   blank line            → skipped
 */
function parseRecordBody(body: string): {
  settings: Record<string, string>;
  dynamicKeys: string[];
} {
  const settings: Record<string, string> = {};
  const dynamicKeys: string[] = [];
  for (const ln of body.split("\n")) {
    const trimmed = ln.trim();
    if (trimmed.startsWith("//") || trimmed.length === 0) continue;
    const kvMatch = trimmed.match(/^"([^"]+)":\s*"([^"]*)"/);
    if (kvMatch) {
      settings[kvMatch[1]] = kvMatch[2];
      continue;
    }
    const keyOnly = trimmed.match(/^"([^"]+)":/);
    if (keyOnly) dynamicKeys.push(keyOnly[1]);
  }
  return { settings, dynamicKeys };
}

/**
 * Extract `marker: "..."` literals from a cronJobs array body. Skips
 * comments and dynamic markers (treated as "missing" — same fail-soft
 * principle as dynamic configSettings keys; if drift in dynamic markers
 * matters, convert them to literals).
 */
function parseCronMarkers(body: string): string[] {
  const markers: string[] = [];
  // Match `marker: "value"` anywhere in the body (across object literals).
  // The `g` flag yields all matches.
  const re = /marker:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    markers.push(m[1]);
  }
  return markers;
}

/**
 * Extract a string array literal `["A", "B", ...]` from the source after
 * the named field. Returns the array, or null if the field can't be found
 * or the literal can't be parsed.
 */
function parseStringArrayField(src: string, fieldName: string): string[] | null {
  const idx = src.indexOf(`${fieldName}:`);
  if (idx < 0) return null;
  const openIdx = src.indexOf("[", idx);
  if (openIdx < 0) return null;
  // Find the matching close-bracket at depth 0
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return null;
  const body = src.slice(openIdx + 1, closeIdx);
  const items: string[] = [];
  // Match all "..." literals
  const re = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) items.push(m[1]);
  return items;
}

/**
 * Best-effort parse of the remote vm-manifest.ts source code. The file
 * is TypeScript, not JSON, so we extract via regex against known
 * declaration shapes. If the file shape changes substantially (e.g.,
 * refactored into a different export structure), one or more of these
 * extractors will fail and the caller gets `github_parse_err` — at
 * which point the manifest-integrity check should be revisited
 * alongside the refactor.
 *
 * Exported for the round-trip test (scripts/_verify-manifest-integrity-
 * roundtrip.ts). Not intended for general use; callers should use
 * `verifyManifestFreshness`.
 */
export function parseRemoteManifest(src: string): ParsedManifest | null {
  // ── version: <number> ──
  const versionMatch = src.match(/version:\s*(\d+)/);
  if (!versionMatch) return null;
  const version = parseInt(versionMatch[1], 10);

  // ── configSettings: { ... } ──
  const csStart = src.indexOf("configSettings:");
  if (csStart < 0) return null;
  const csOpen = src.indexOf("{", csStart);
  if (csOpen < 0) return null;
  const csClose = findMatchingClose(src, csOpen);
  if (csClose < 0) return null;
  const cs = parseRecordBody(src.slice(csOpen + 1, csClose));

  // ── cronJobs: [ ... ] ──
  // Extract just the markers. Multi-line array of nested objects.
  const cronStart = src.indexOf("cronJobs:");
  if (cronStart < 0) return null;
  const cronOpen = src.indexOf("[", cronStart);
  if (cronOpen < 0) return null;
  // Find matching close-bracket
  let cronDepth = 0;
  let cronClose = -1;
  for (let i = cronOpen; i < src.length; i++) {
    const c = src[i];
    if (c === "[") cronDepth++;
    else if (c === "]") {
      cronDepth--;
      if (cronDepth === 0) {
        cronClose = i;
        break;
      }
    }
  }
  if (cronClose < 0) return null;
  const cronMarkers = parseCronMarkers(src.slice(cronOpen + 1, cronClose));

  // ── requiredEnvVars: [...] ──
  const requiredEnvVars = parseStringArrayField(src, "requiredEnvVars");
  if (requiredEnvVars === null) return null;

  // ── envVarDefaults: { ... } ──
  const eedStart = src.indexOf("envVarDefaults:");
  if (eedStart < 0) return null;
  const eedOpen = src.indexOf("{", eedStart);
  if (eedOpen < 0) return null;
  const eedClose = findMatchingClose(src, eedOpen);
  if (eedClose < 0) return null;
  // envVarDefaults uses bare-key syntax (POLYGON_RPC_URL: "https://...")
  // not quoted-key. We need a slightly different parser here.
  const eedBody = src.slice(eedOpen + 1, eedClose);
  const envVarDefaults: Record<string, string> = {};
  const dynamicEnvVarDefaultKeys: string[] = [];
  for (const ln of eedBody.split("\n")) {
    const trimmed = ln.trim();
    if (trimmed.startsWith("//") || trimmed.length === 0) continue;
    // Either `KEY: "value"` or `"KEY": "value"` (both shapes valid TS)
    const bareKv = trimmed.match(/^([A-Z_][A-Z0-9_]*):\s*"([^"]*)"/);
    if (bareKv) {
      envVarDefaults[bareKv[1]] = bareKv[2];
      continue;
    }
    const quotedKv = trimmed.match(/^"([^"]+)":\s*"([^"]*)"/);
    if (quotedKv) {
      envVarDefaults[quotedKv[1]] = quotedKv[2];
      continue;
    }
    // Dynamic-value lines: bare-key or quoted-key with a non-literal RHS.
    const bareKey = trimmed.match(/^([A-Z_][A-Z0-9_]*):/);
    if (bareKey) {
      dynamicEnvVarDefaultKeys.push(bareKey[1]);
      continue;
    }
    const quotedKey = trimmed.match(/^"([^"]+)":/);
    if (quotedKey) dynamicEnvVarDefaultKeys.push(quotedKey[1]);
  }

  return {
    version,
    configSettings: cs.settings,
    cronMarkers,
    requiredEnvVars,
    envVarDefaults,
    dynamicConfigKeys: cs.dynamicKeys,
    dynamicEnvVarDefaultKeys,
  };
}

/**
 * Human-readable diff summary for the stale_bundle verdict. Surfaces the
 * specific drift (version delta, count of changed keys, top-3 examples)
 * so the operator can SSH in with a working theory instead of starting
 * from scratch.
 */
function diffSummary(
  runtime: ManifestFingerprint,
  parsed: ParsedManifest,
): string {
  const parts: string[] = [];
  if (runtime.version !== parsed.version) {
    parts.push(`version: runtime=${runtime.version} vs remote=${parsed.version}`);
  }
  const csDelta = diffRecord(runtime.configSettings, parsed.configSettings);
  if (csDelta.diffCount > 0) {
    parts.push(`configSettings: ${csDelta.diffCount} keys differ (e.g. ${csDelta.sample.slice(0, 3).join("; ")})`);
  }
  const cmRuntime = new Set(runtime.cronMarkers);
  const cmRemote = new Set(parsed.cronMarkers);
  const cmAdded = [...cmRemote].filter((m) => !cmRuntime.has(m));
  const cmRemoved = [...cmRuntime].filter((m) => !cmRemote.has(m));
  if (cmAdded.length || cmRemoved.length) {
    parts.push(`cronMarkers: +${cmAdded.length}/-${cmRemoved.length}`);
  }
  const reRuntime = new Set(runtime.requiredEnvVars);
  const reRemote = new Set(parsed.requiredEnvVars);
  const reAdded = [...reRemote].filter((m) => !reRuntime.has(m));
  const reRemoved = [...reRuntime].filter((m) => !reRemote.has(m));
  if (reAdded.length || reRemoved.length) {
    parts.push(`requiredEnvVars: +${reAdded.length}/-${reRemoved.length}`);
  }
  const eedDelta = diffRecord(runtime.envVarDefaults, parsed.envVarDefaults);
  if (eedDelta.diffCount > 0) {
    parts.push(`envVarDefaults: ${eedDelta.diffCount} keys differ`);
  }
  return parts.length > 0 ? parts.join("; ") : "no field-level diff detected (likely a dynamic-key drift outside the hash)";
}

function diffRecord(
  a: Record<string, string>,
  b: Record<string, string>,
): { diffCount: number; sample: string[] } {
  const all = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: string[] = [];
  for (const k of all) {
    if (a[k] !== b[k]) {
      diffs.push(`${k}: "${a[k] ?? "(missing)"}" → "${b[k] ?? "(missing)"}"`);
    }
  }
  return { diffCount: diffs.length, sample: diffs };
}

/**
 * Fetch the live vm-manifest.ts from main on GitHub, parse it, compare
 * against the locally imported runtime fingerprint, return a verdict.
 *
 * Memoized for CACHE_TTL_MS to amortize the HTTP cost across cron fires
 * within the same warm window. Cold-starts always re-fetch (the memo is
 * module-local).
 */
export async function verifyManifestFreshness(
  runtime: ManifestFingerprint,
): Promise<ManifestIntegrityVerdict> {
  const now = Date.now();
  if (memoCache && now - memoCache.ts < CACHE_TTL_MS) return memoCache.v;

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
      detail: `Could not extract one or more required fields (version, configSettings, cronJobs, requiredEnvVars, envVarDefaults) from remote vm-manifest.ts (${body.length} bytes). Has the file shape changed? Update parseRemoteManifest in lib/manifest-integrity.ts.`,
    };
    memoCache = { v: verdict, ts: now };
    return verdict;
  }

  // Filter both sides to exclude dynamic-value keys (those the parser
  // could not extract because the RHS isn't a quoted string literal).
  // The runtime side has the evaluated value; the parsed side has nothing.
  // Hashing the union would always mismatch — see file-level docblock.
  const dynamicCsKeys = new Set(parsed.dynamicConfigKeys);
  const dynamicEedKeys = new Set(parsed.dynamicEnvVarDefaultKeys);
  const filteredRuntimeConfigSettings: Record<string, string> = {};
  for (const [k, v] of Object.entries(runtime.configSettings)) {
    if (!dynamicCsKeys.has(k)) filteredRuntimeConfigSettings[k] = v;
  }
  const filteredRuntimeEnvVarDefaults: Record<string, string> = {};
  for (const [k, v] of Object.entries(runtime.envVarDefaults)) {
    if (!dynamicEedKeys.has(k)) filteredRuntimeEnvVarDefaults[k] = v;
  }
  const runtimeFiltered: ManifestFingerprint = {
    version: runtime.version,
    configSettings: filteredRuntimeConfigSettings,
    cronMarkers: runtime.cronMarkers,
    requiredEnvVars: runtime.requiredEnvVars,
    envVarDefaults: filteredRuntimeEnvVarDefaults,
  };
  const parsedFp: ManifestFingerprint = {
    version: parsed.version,
    configSettings: parsed.configSettings,
    cronMarkers: parsed.cronMarkers,
    requiredEnvVars: parsed.requiredEnvVars,
    envVarDefaults: parsed.envVarDefaults,
  };
  const filteredRuntimeSha = computeManifestSha(runtimeFiltered);
  const remoteSha = computeManifestSha(parsedFp);
  const fresh = remoteSha === filteredRuntimeSha;
  const verdict: ManifestIntegrityVerdict = fresh
    ? {
        ok: true,
        fresh: true,
        reason: "verified",
        runtime_version: runtime.version,
        runtime_sha: filteredRuntimeSha,
        remote_sha: remoteSha,
      }
    : {
        ok: true,
        fresh: false,
        reason: "stale_bundle",
        runtime_version: runtime.version,
        remote_version: parsed.version,
        runtime_sha: filteredRuntimeSha,
        remote_sha: remoteSha,
        diff_summary: diffSummary(runtimeFiltered, parsed),
      };
  memoCache = { v: verdict, ts: now };
  return verdict;
}

/**
 * Test helper — clear the module-local cache. Used in unit tests to
 * exercise multiple verdicts in sequence. The synthetic test
 * (`scripts/_test-manifest-integrity.ts`) calls this between scenarios
 * and stubs `globalThis.fetch` directly to inject canned responses.
 */
export function __resetManifestIntegrityCache() {
  memoCache = null;
}
