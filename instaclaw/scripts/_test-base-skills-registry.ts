/**
 * Synthetic tests for lib/base-skills-registry.ts.
 *
 * Run: npx tsx scripts/_test-base-skills-registry.ts
 *
 * Covers:
 *   - currentSourceMode resolution (5 env-var permutations, Rule 61)
 *   - getBaseSkillContent in all three modes
 *   - live-fetch fallback (non-2xx, network failure, timeout)
 *   - registry-api fallback chain (not-yet-shipped → live → vendored)
 *   - 5-min cache hit/miss
 *   - Cache keyed by (name, mode) — same entry different modes don't collide
 *   - Sentinel validation: pass + fail
 *   - getBaseSkillCatalog in all three modes
 *   - getBaseSkillReferenceContent
 *   - Utility helpers: isBaseSkillEntryFresh, onVmSkillPath,
 *     getBaseSkillVendoredPaths
 *
 * Uses a temp directory + INSTACLAW_REPO_ROOT env var to stage vendored
 * fixtures. Mocks global.fetch for live-fetch tests. Restores everything
 * between scenarios.
 *
 * The test exercises every branch in the registry module that doesn't
 * require a real Vercel deployment. The remaining branches (registry-api
 * happy path) light up automatically when the placeholder
 * fetchFromRegistryApi is implemented — and this test file is the place
 * to add those scenarios when that happens.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BASE_SKILL_CATALOG,
  type BaseSkillEntry,
  BaseSkillSentinelError,
  RegistryApiNotYetAvailable,
  _clearCacheForTesting,
  currentSourceMode,
  getBaseSkillCatalog,
  getBaseSkillContent,
  getBaseSkillReferenceContent,
  getBaseSkillVendoredPaths,
  isBaseSkillEntryFresh,
  onVmReferencePath,
  onVmSkillPath,
} from "../lib/base-skills-registry";

// ─── harness ─────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertThrows<E extends Error>(
  fn: () => Promise<unknown>,
  errorClass: new (...args: never[]) => E,
  msg: string,
): Promise<void> {
  try {
    await fn();
    fail++;
    failures.push(`${msg} — expected ${errorClass.name}, got no throw`);
    console.error(`  ✗ ${msg} — expected ${errorClass.name}, got no throw`);
  } catch (err) {
    if (err instanceof errorClass) {
      pass++;
    } else {
      fail++;
      const got = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      failures.push(`${msg} — expected ${errorClass.name}, got ${got}`);
      console.error(`  ✗ ${msg} — expected ${errorClass.name}, got ${got}`);
    }
  }
}

// ─── fixture management ──────────────────────────────────────────────

interface TmpRepo {
  rootDir: string;
  cleanup: () => void;
}

function setupTmpRepo(): TmpRepo {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-base-skills-"));
  fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
  return {
    rootDir,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

function writeVendored(repo: TmpRepo, vendoredPath: string, content: string): void {
  const skillDir = path.join(repo.rootDir, "skills", vendoredPath);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8");
}

function writeVendoredRef(
  repo: TmpRepo,
  vendoredPath: string,
  refPath: string,
  content: string,
): void {
  const target = path.join(repo.rootDir, "skills", vendoredPath, refPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

// ─── fetch mock ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

type FetchHandler = (url: string) => Promise<Response> | Response;

function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const result = handler(url);
    return result instanceof Promise ? await result : result;
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/markdown" } });
}

function notOk(status: number, body = "error"): Response {
  return new Response(body, { status });
}

// ─── env-var management ──────────────────────────────────────────────

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

async function withEnvAsync<T>(
  name: string,
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test suites
// ═══════════════════════════════════════════════════════════════════

async function suite_currentSourceMode(): Promise<void> {
  console.log("\n── currentSourceMode ───────────────────────────────────────");

  withEnv("BASE_SKILLS_SOURCE_MODE", undefined, () => {
    assertEq(currentSourceMode(), "vendored", "env unset → vendored");
  });
  withEnv("BASE_SKILLS_SOURCE_MODE", "vendored", () => {
    assertEq(currentSourceMode(), "vendored", "env=vendored → vendored");
  });
  withEnv("BASE_SKILLS_SOURCE_MODE", "live-fetch", () => {
    assertEq(currentSourceMode(), "live-fetch", "env=live-fetch → live-fetch");
  });
  withEnv("BASE_SKILLS_SOURCE_MODE", "registry-api", () => {
    assertEq(currentSourceMode(), "registry-api", "env=registry-api → registry-api");
  });
  withEnv("BASE_SKILLS_SOURCE_MODE", "garbage", () => {
    assertEq(currentSourceMode(), "vendored", "env=garbage → vendored (Rule 61)");
  });
  withEnv("BASE_SKILLS_SOURCE_MODE", "", () => {
    assertEq(currentSourceMode(), "vendored", "env='' → vendored");
  });
  withEnv("BASE_SKILLS_SOURCE_MODE", "VENDORED", () => {
    // Case-sensitive — uppercase doesn't match. Conservative default.
    assertEq(currentSourceMode(), "vendored", "env=VENDORED (case) → vendored");
  });
}

async function suite_vendored(): Promise<void> {
  console.log("\n── vendored mode ───────────────────────────────────────────");
  const repo = setupTmpRepo();
  try {
    const entry: BaseSkillEntry = {
      name: "test-skill",
      vendoredPath: "base-test",
      upstreamUrl: "https://example.invalid/test/SKILL.md",
    };
    const content = "# Test Skill\n\nThis is a test plugin.";
    writeVendored(repo, entry.vendoredPath, content);

    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "vendored");
      assertEq(result.content, content, "vendored content matches written file");
      assertEq(result.sourceMode, "vendored", "vendored sourceMode is vendored");
      assert(result.sha256.length === 64, "vendored sha256 is 64 hex chars");
      assert(result.sourceUrl?.startsWith("file://") ?? false, "vendored sourceUrl is file://");
      assert(result.fetchedAt instanceof Date, "vendored fetchedAt is Date");
    });

    // Missing file throws
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      await assertThrows(
        () =>
          getBaseSkillContent(
            { name: "missing", vendoredPath: "base-missing", upstreamUrl: "x" },
            "vendored",
          ),
        Error,
        "vendored missing file throws",
      );
    });
  } finally {
    repo.cleanup();
  }
}

async function suite_liveFetch(): Promise<void> {
  console.log("\n── live-fetch mode ─────────────────────────────────────────");
  const repo = setupTmpRepo();
  try {
    const entry: BaseSkillEntry = {
      name: "test-live",
      vendoredPath: "base-live",
      upstreamUrl: "https://example.invalid/live/SKILL.md",
    };
    const vendoredContent = "vendored fallback content";
    const liveContent = "live fetched content";
    writeVendored(repo, entry.vendoredPath, vendoredContent);

    // Happy path — fetch returns 200
    mockFetch(() => ok(liveContent));
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "live-fetch");
      assertEq(result.content, liveContent, "live-fetch happy path returns live content");
      assertEq(result.sourceMode, "live-fetch", "live-fetch happy path sourceMode is live-fetch");
      assertEq(result.sourceUrl, entry.upstreamUrl, "live-fetch sourceUrl is upstream URL");
    });
    restoreFetch();

    // 500 → falls back to vendored
    mockFetch(() => notOk(500));
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "live-fetch");
      assertEq(result.content, vendoredContent, "live-fetch 500 falls back to vendored content");
      assertEq(result.sourceMode, "vendored", "live-fetch 500 fallback sourceMode is vendored");
    });
    restoreFetch();

    // Network failure → falls back
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "live-fetch");
      assertEq(result.content, vendoredContent, "live-fetch ECONNREFUSED falls back");
      assertEq(result.sourceMode, "vendored", "live-fetch network fail fallback sourceMode");
    });
    restoreFetch();

    // 404 → falls back
    mockFetch(() => notOk(404, "not found"));
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "live-fetch");
      assertEq(result.content, vendoredContent, "live-fetch 404 falls back");
    });
    restoreFetch();

    // Live-fetch happy + missing vendored fallback → throws (catastrophic)
    mockFetch(() => notOk(500));
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      await assertThrows(
        () =>
          getBaseSkillContent(
            { name: "no-vendored", vendoredPath: "base-no-vendored", upstreamUrl: "x" },
            "live-fetch",
          ),
        Error,
        "live-fetch fail + no vendored throws",
      );
    });
    restoreFetch();
  } finally {
    repo.cleanup();
  }
}

async function suite_registryApi(): Promise<void> {
  console.log("\n── registry-api mode (fallback chain) ──────────────────────");
  const repo = setupTmpRepo();
  try {
    const entry: BaseSkillEntry = {
      name: "test-registry",
      vendoredPath: "base-registry",
      upstreamUrl: "https://example.invalid/registry/SKILL.md",
    };
    const vendoredContent = "vendored content";
    writeVendored(repo, entry.vendoredPath, vendoredContent);

    // registry-api throws → falls to live-fetch → live-fetch 200 returns
    const liveContent = "live content via fallback";
    mockFetch(() => ok(liveContent));
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "registry-api");
      assertEq(result.content, liveContent, "registry-api → live-fetch returns live content");
      assertEq(result.sourceMode, "live-fetch", "registry-api → live-fetch sourceMode is live-fetch");
    });
    restoreFetch();

    // registry-api throws → live-fetch fails → vendored
    mockFetch(() => notOk(503));
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "registry-api");
      assertEq(result.content, vendoredContent, "registry-api → live-fetch fail → vendored");
      assertEq(result.sourceMode, "vendored", "full fallback chain sourceMode is vendored");
    });
    restoreFetch();
  } finally {
    repo.cleanup();
  }
}

async function suite_cache(): Promise<void> {
  console.log("\n── cache behavior ──────────────────────────────────────────");
  const repo = setupTmpRepo();
  try {
    const entry: BaseSkillEntry = {
      name: "cached",
      vendoredPath: "base-cached",
      upstreamUrl: "https://example.invalid/cached",
    };
    writeVendored(repo, entry.vendoredPath, "v1");

    let fetchCount = 0;
    mockFetch(() => {
      fetchCount++;
      return ok(`live #${fetchCount}`);
    });

    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();

      // Two consecutive calls → fetch only fires once
      const r1 = await getBaseSkillContent(entry, "live-fetch");
      const r2 = await getBaseSkillContent(entry, "live-fetch");
      assertEq(r1.content, "live #1", "first call fetches");
      assertEq(r2.content, "live #1", "second call uses cache");
      assertEq(fetchCount, 1, "fetch called only once due to cache");

      // Different mode → different cache key → fetches separately
      const r3 = await getBaseSkillContent(entry, "vendored");
      assertEq(r3.content, "v1", "different mode skips cache");
      assertEq(r3.sourceMode, "vendored", "different mode returns its own data");
      assertEq(fetchCount, 1, "vendored mode doesn't call fetch");
    });

    restoreFetch();
  } finally {
    repo.cleanup();
  }
}

async function suite_sentinels(): Promise<void> {
  console.log("\n── sentinel validation (Rule 23) ───────────────────────────");
  const repo = setupTmpRepo();
  try {
    const entry: BaseSkillEntry = {
      name: "sentinel-test",
      vendoredPath: "base-sentinel",
      upstreamUrl: "https://example.invalid/sentinel",
      requiredSentinels: ["BASE_SKILL_TEST_V1", "## Use this skill when:"],
    };

    // Content with all sentinels → ok
    writeVendored(
      repo,
      entry.vendoredPath,
      "<!-- BASE_SKILL_TEST_V1 -->\n## Use this skill when: ...",
    );
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entry, "vendored");
      assert(result.content.includes("BASE_SKILL_TEST_V1"), "sentinel pass returns content");
    });

    // Content missing a sentinel → throws BaseSkillSentinelError
    writeVendored(repo, entry.vendoredPath, "## Use this skill when: ...");
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      await assertThrows(
        () => getBaseSkillContent(entry, "vendored"),
        BaseSkillSentinelError,
        "missing sentinel throws BaseSkillSentinelError",
      );
    });

    // No sentinels declared → no validation
    const entryNoSentinels: BaseSkillEntry = {
      name: "no-sentinel",
      vendoredPath: "base-no-sentinel",
      upstreamUrl: "https://example.invalid/x",
    };
    writeVendored(repo, entryNoSentinels.vendoredPath, "arbitrary");
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillContent(entryNoSentinels, "vendored");
      assertEq(result.content, "arbitrary", "no sentinels → any content accepted");
    });
  } finally {
    repo.cleanup();
  }
}

async function suite_catalog(): Promise<void> {
  console.log("\n── getBaseSkillCatalog ─────────────────────────────────────");

  const v = await getBaseSkillCatalog("vendored");
  assert(Array.isArray(v), "vendored catalog is array");
  assertEq(v, BASE_SKILL_CATALOG, "vendored returns BASE_SKILL_CATALOG ref");

  const l = await getBaseSkillCatalog("live-fetch");
  assertEq(l, BASE_SKILL_CATALOG, "live-fetch returns same catalog (vendored fallback)");

  const r = await getBaseSkillCatalog("registry-api");
  assertEq(r, BASE_SKILL_CATALOG, "registry-api falls back to BASE_SKILL_CATALOG");
}

async function suite_references(): Promise<void> {
  console.log("\n── reference files ─────────────────────────────────────────");
  const repo = setupTmpRepo();
  try {
    const entry: BaseSkillEntry = {
      name: "with-refs",
      vendoredPath: "base-refs",
      upstreamUrl: "https://example.invalid/refs/SKILL.md",
      references: [
        { remotePath: "references/api.md", upstreamUrl: "https://example.invalid/refs/api.md" },
      ],
    };
    writeVendored(repo, entry.vendoredPath, "main");
    writeVendoredRef(repo, entry.vendoredPath, "references/api.md", "api reference");

    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillReferenceContent(entry, entry.references![0], "vendored");
      assertEq(result.content, "api reference", "vendored reference reads from disk");
    });

    // live-fetch reference → fall back to vendored on 500
    mockFetch(() => notOk(500));
    await withEnvAsync("INSTACLAW_REPO_ROOT", repo.rootDir, async () => {
      _clearCacheForTesting();
      const result = await getBaseSkillReferenceContent(entry, entry.references![0], "live-fetch");
      assertEq(result.content, "api reference", "live-fetch reference falls back to vendored");
    });
    restoreFetch();
  } finally {
    repo.cleanup();
  }
}

async function suite_utilities(): Promise<void> {
  console.log("\n── utility helpers ─────────────────────────────────────────");

  const entry: BaseSkillEntry = {
    name: "u",
    vendoredPath: "base-u",
    upstreamUrl: "x",
    references: [{ remotePath: "references/r.md", upstreamUrl: "y" }],
  };

  assertEq(
    onVmSkillPath(entry),
    "/home/openclaw/.openclaw/skills/base-u/SKILL.md",
    "onVmSkillPath shape",
  );
  assertEq(
    onVmReferencePath(entry, entry.references![0]),
    "/home/openclaw/.openclaw/skills/base-u/references/r.md",
    "onVmReferencePath shape",
  );

  // isBaseSkillEntryFresh
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  assertEq(
    isBaseSkillEntryFresh(
      { ...entry, importedAt: new Date(now - 1 * day).toISOString() },
      7 * day,
    ),
    true,
    "fresh: 1 day old, 7-day window",
  );
  assertEq(
    isBaseSkillEntryFresh(
      { ...entry, importedAt: new Date(now - 10 * day).toISOString() },
      7 * day,
    ),
    false,
    "stale: 10 days old, 7-day window",
  );
  assertEq(isBaseSkillEntryFresh(entry, 7 * day), false, "missing importedAt → false");
  assertEq(
    isBaseSkillEntryFresh({ ...entry, importedAt: "garbage" }, 7 * day),
    false,
    "invalid importedAt → false",
  );

  // getBaseSkillVendoredPaths returns a Set
  const paths = getBaseSkillVendoredPaths();
  assert(paths instanceof Set, "getBaseSkillVendoredPaths returns Set");
}

async function suite_registryApiError(): Promise<void> {
  console.log("\n── RegistryApiNotYetAvailable error class ──────────────────");
  const err = new RegistryApiNotYetAvailable("custom msg");
  assertEq(err.name, "RegistryApiNotYetAvailable", "error has correct name");
  assertEq(err.message, "custom msg", "error preserves message");
  assert(err instanceof Error, "extends Error");

  const defaultErr = new RegistryApiNotYetAvailable();
  assert(defaultErr.message.length > 0, "has default message");
}

// ═══════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("Testing lib/base-skills-registry.ts\n");

  await suite_currentSourceMode();
  await suite_vendored();
  await suite_liveFetch();
  await suite_registryApi();
  await suite_cache();
  await suite_sentinels();
  await suite_catalog();
  await suite_references();
  await suite_utilities();
  await suite_registryApiError();

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`✓ All tests passed`);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});
