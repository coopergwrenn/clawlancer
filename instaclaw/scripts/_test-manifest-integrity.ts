/**
 * Synthetic test for lib/manifest-integrity.ts — P1-4 §A.
 *
 * Run: npx tsx scripts/_test-manifest-integrity.ts
 *
 * Stubs `globalThis.fetch` to inject canned GitHub-raw responses, then
 * exercises every code path of `verifyManifestFreshness`:
 *
 *   1. verified            — SHA match → ok=true, fresh=true
 *   2. stale_bundle        — SHA mismatch → ok=true, fresh=false (+ diff_summary)
 *   3. github_404          — 404 status → ok=false (degrade-to-allow)
 *   4. github_5xx          — 500 status → ok=false (degrade-to-allow)
 *   5. github_unreachable  — 4xx-but-not-404 status → ok=false (degrade-to-allow)
 *   6. network_timeout     — fetch rejects → ok=false (degrade-to-allow)
 *   7. github_parse_err    — body that can't be parsed → ok=false
 *
 * Plus scenarios specific to the P1-4 §C expansion:
 *   8. dynamic-keys filter — runtime has BOOTSTRAP_MAX_CHARS (dynamic),
 *      verifier still treats SHA as fresh because both sides filter that
 *      key out.
 *   9. cronMarker order-insensitivity — runtime order vs remote order
 *      different but values same → fresh=true
 *   10. requiredEnvVars drift caught — adding an entry on remote =
 *       stale_bundle
 *   11. envVarDefaults drift caught — changing a value on remote =
 *       stale_bundle
 *   12. cache TTL — second call within window returns cached verdict
 *       without hitting fetch
 *
 * The fingerprint hashing is deterministic; we generate canonical
 * vm-manifest.ts source strings inline (matching the regex shapes the
 * parser expects) and verify the wrapper produces the expected verdict.
 *
 * What this test does NOT cover:
 *   - Real network behavior to raw.githubusercontent.com (the test stubs
 *     fetch).
 *   - The route-level halt + alert dispatch (covered by the route's
 *     own integration; the test asserts only the verifier's verdict).
 */
import {
  verifyManifestFreshness,
  computeManifestSha,
  manifestFingerprint,
  parseRemoteManifest,
  __resetManifestIntegrityCache,
  type ManifestFingerprint,
} from "../lib/manifest-integrity";

// ── Test harness ─────────────────────────────────────────────────────

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

// Build a canonical vm-manifest.ts source string from a fingerprint.
// Mirrors the on-disk shape the parser regex expects.
function buildSrc(fp: ManifestFingerprint, extras?: { dynamicConfigKey?: string }): string {
  const cs = Object.entries(fp.configSettings)
    .map(([k, v]) => `    "${k}": "${v}",`)
    .join("\n");
  const dynamicCs = extras?.dynamicConfigKey
    ? `\n    "${extras.dynamicConfigKey}": String(SOME_CONST),`
    : "";
  const eed = Object.entries(fp.envVarDefaults)
    .map(([k, v]) => `    ${k}: "${v}",`)
    .join("\n");
  const reqEnv = fp.requiredEnvVars.map((v) => `"${v}"`).join(", ");
  const crons = fp.cronMarkers
    .map((m) => `    { schedule: "* * * * *", command: "noop", marker: "${m}" },`)
    .join("\n");
  return `export const VM_MANIFEST = {
  version: ${fp.version},
  configSettings: {
${cs}${dynamicCs}
  },
  cronJobs: [
${crons}
  ],
  requiredEnvVars: [${reqEnv}],
  envVarDefaults: {
${eed}
  },
};`;
}

function makeFp(overrides: Partial<ManifestFingerprint> = {}): ManifestFingerprint {
  return {
    version: 100,
    configSettings: {
      "agents.defaults.heartbeat.every": "3h",
      "agents.defaults.heartbeat.session": "heartbeat",
    },
    cronMarkers: ["strip-thinking.py", "vm-watchdog.py"],
    requiredEnvVars: ["GATEWAY_TOKEN", "POLYGON_RPC_URL"],
    envVarDefaults: { POLYGON_RPC_URL: "https://polygon-bor-rpc.publicnode.com" },
    ...overrides,
  };
}

// Stub fetch with a canned response. `body` is the GitHub-raw text; if
// `throwError` is set, the fetch rejects instead. Returns a restore fn.
function stubFetch(opts: { status?: number; body?: string; throwError?: Error }): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string) => {
    if (opts.throwError) throw opts.throwError;
    const status = opts.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => opts.body ?? "",
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

// ── Scenarios ────────────────────────────────────────────────────────

(async () => {
  console.log("P1-4 §A — synthetic test for verifyManifestFreshness\n");

  // 1. verified — SHA match
  {
    __resetManifestIntegrityCache();
    const fp = makeFp();
    const src = buildSrc(fp);
    const restore = stubFetch({ status: 200, body: src });
    const v = await verifyManifestFreshness(fp);
    restore();
    assert(v.ok === true, "scenario-1: verdict.ok=true");
    if (v.ok) {
      assert(v.fresh === true, "scenario-1: verdict.fresh=true");
      assert(v.reason === "verified", `scenario-1: reason=verified (got ${v.reason})`);
    }
  }

  // 2. stale_bundle — version mismatch
  {
    __resetManifestIntegrityCache();
    const runtime = makeFp({ version: 99 });
    const remote = makeFp({ version: 100 });
    const restore = stubFetch({ status: 200, body: buildSrc(remote) });
    const v = await verifyManifestFreshness(runtime);
    restore();
    assert(v.ok === true, "scenario-2: verdict.ok=true");
    if (v.ok && !v.fresh) {
      assert(v.reason === "stale_bundle", "scenario-2: reason=stale_bundle");
      assert(v.runtime_version === 99, "scenario-2: runtime_version=99");
      assert(v.remote_version === 100, "scenario-2: remote_version=100");
      assert(
        v.diff_summary.includes("version: runtime=99 vs remote=100"),
        `scenario-2: diff_summary mentions version drift (got: ${v.diff_summary})`,
      );
    } else {
      assert(false, "scenario-2: expected stale_bundle verdict");
    }
  }

  // 3. github_404
  {
    __resetManifestIntegrityCache();
    const restore = stubFetch({ status: 404 });
    const v = await verifyManifestFreshness(makeFp());
    restore();
    assert(v.ok === false, "scenario-3: verdict.ok=false");
    if (!v.ok) assert(v.reason === "github_404", `scenario-3: reason=github_404 (got ${v.reason})`);
  }

  // 4. github_5xx
  {
    __resetManifestIntegrityCache();
    const restore = stubFetch({ status: 502 });
    const v = await verifyManifestFreshness(makeFp());
    restore();
    assert(v.ok === false, "scenario-4: verdict.ok=false");
    if (!v.ok) assert(v.reason === "github_5xx", `scenario-4: reason=github_5xx (got ${v.reason})`);
  }

  // 5. github_unreachable (e.g., 403)
  {
    __resetManifestIntegrityCache();
    const restore = stubFetch({ status: 403 });
    const v = await verifyManifestFreshness(makeFp());
    restore();
    assert(v.ok === false, "scenario-5: verdict.ok=false");
    if (!v.ok) assert(v.reason === "github_unreachable", `scenario-5: reason=github_unreachable (got ${v.reason})`);
  }

  // 6. network_timeout
  {
    __resetManifestIntegrityCache();
    const restore = stubFetch({ throwError: new Error("ETIMEDOUT") });
    const v = await verifyManifestFreshness(makeFp());
    restore();
    assert(v.ok === false, "scenario-6: verdict.ok=false");
    if (!v.ok) assert(v.reason === "network_timeout", `scenario-6: reason=network_timeout (got ${v.reason})`);
  }

  // 7. github_parse_err — body is junk
  {
    __resetManifestIntegrityCache();
    const restore = stubFetch({ status: 200, body: "this is not a manifest file at all" });
    const v = await verifyManifestFreshness(makeFp());
    restore();
    assert(v.ok === false, "scenario-7: verdict.ok=false");
    if (!v.ok) assert(v.reason === "github_parse_err", `scenario-7: reason=github_parse_err (got ${v.reason})`);
  }

  // 8. dynamic-keys filter — runtime has a configSettings key that the
  //    parser can't extract (RHS is `String(VAR)`); both sides should
  //    still treat the bundle as fresh (the key is excluded from hash).
  {
    __resetManifestIntegrityCache();
    const runtime = makeFp({
      configSettings: {
        "agents.defaults.heartbeat.every": "3h",
        "agents.defaults.heartbeat.session": "heartbeat",
        "agents.defaults.bootstrapMaxChars": "40000", // dynamic on disk
      },
    });
    // Remote source has the dynamic key as `String(BOOTSTRAP_MAX_CHARS),`
    // which the parser will record in dynamicConfigKeys and exclude.
    const remoteSrc = buildSrc(
      {
        ...runtime,
        configSettings: {
          "agents.defaults.heartbeat.every": "3h",
          "agents.defaults.heartbeat.session": "heartbeat",
        },
      },
      { dynamicConfigKey: "agents.defaults.bootstrapMaxChars" },
    );
    const restore = stubFetch({ status: 200, body: remoteSrc });
    const v = await verifyManifestFreshness(runtime);
    restore();
    assert(v.ok === true, "scenario-8: verdict.ok=true");
    if (v.ok) {
      assert(v.fresh === true, "scenario-8: fresh=true (dynamic key filtered)");
    }
  }

  // 9. cronMarker order-insensitivity
  {
    __resetManifestIntegrityCache();
    const runtime = makeFp({ cronMarkers: ["a", "b", "c"] });
    const remote = makeFp({ cronMarkers: ["c", "a", "b"] }); // different order
    const restore = stubFetch({ status: 200, body: buildSrc(remote) });
    const v = await verifyManifestFreshness(runtime);
    restore();
    assert(v.ok === true && (v as { fresh: boolean }).fresh === true, "scenario-9: cron marker order-insensitivity passes");
  }

  // 10. requiredEnvVars drift (new var added)
  {
    __resetManifestIntegrityCache();
    const runtime = makeFp({ requiredEnvVars: ["GATEWAY_TOKEN"] });
    const remote = makeFp({ requiredEnvVars: ["GATEWAY_TOKEN", "NEW_VAR"] });
    const restore = stubFetch({ status: 200, body: buildSrc(remote) });
    const v = await verifyManifestFreshness(runtime);
    restore();
    assert(v.ok === true, "scenario-10: verdict.ok=true");
    if (v.ok && !v.fresh) {
      assert(v.reason === "stale_bundle", "scenario-10: reason=stale_bundle");
      assert(
        v.diff_summary.includes("requiredEnvVars"),
        `scenario-10: diff_summary mentions requiredEnvVars (got: ${v.diff_summary})`,
      );
    } else {
      assert(false, "scenario-10: expected stale_bundle for requiredEnvVars drift");
    }
  }

  // 11. envVarDefaults drift caught (value change)
  {
    __resetManifestIntegrityCache();
    const runtime = makeFp({
      envVarDefaults: { POLYGON_RPC_URL: "https://polygon-bor-rpc.publicnode.com" },
    });
    const remote = makeFp({
      envVarDefaults: { POLYGON_RPC_URL: "https://new-rpc.example.com" },
    });
    const restore = stubFetch({ status: 200, body: buildSrc(remote) });
    const v = await verifyManifestFreshness(runtime);
    restore();
    assert(v.ok === true, "scenario-11: verdict.ok=true");
    if (v.ok && !v.fresh) {
      assert(v.reason === "stale_bundle", "scenario-11: reason=stale_bundle");
      assert(
        v.diff_summary.includes("envVarDefaults"),
        `scenario-11: diff_summary mentions envVarDefaults (got: ${v.diff_summary})`,
      );
    } else {
      assert(false, "scenario-11: expected stale_bundle for envVarDefaults drift");
    }
  }

  // 12. cache TTL — second call uses cached verdict without re-fetching
  {
    __resetManifestIntegrityCache();
    let fetchCount = 0;
    const fp = makeFp();
    const src = buildSrc(fp);
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: string) => {
      fetchCount++;
      return {
        status: 200,
        ok: true,
        text: async () => src,
      } as Response;
    }) as typeof fetch;
    const v1 = await verifyManifestFreshness(fp);
    const v2 = await verifyManifestFreshness(fp);
    globalThis.fetch = orig;
    assert(fetchCount === 1, `scenario-12: only one fetch across two calls (got ${fetchCount})`);
    assert(v1.ok === v2.ok, "scenario-12: cached verdict identical to first");
    if (v1.ok && v2.ok) {
      assert((v1 as { fresh: boolean }).fresh === (v2 as { fresh: boolean }).fresh, "scenario-12: fresh field matches");
    }
  }

  // 13. computeManifestSha is deterministic across runs with same input
  {
    const fp = makeFp();
    const sha1 = computeManifestSha(fp);
    const sha2 = computeManifestSha(fp);
    assert(sha1 === sha2, "scenario-13: computeManifestSha deterministic");
  }

  // 14. computeManifestSha is order-insensitive across configSettings + arrays
  {
    const a = makeFp({
      configSettings: { A: "1", B: "2", C: "3" },
      cronMarkers: ["x", "y"],
      requiredEnvVars: ["P", "Q"],
    });
    const b = makeFp({
      configSettings: { C: "3", A: "1", B: "2" },
      cronMarkers: ["y", "x"],
      requiredEnvVars: ["Q", "P"],
    });
    assert(
      computeManifestSha(a) === computeManifestSha(b),
      "scenario-14: SHA order-insensitive across configSettings + cronMarkers + requiredEnvVars",
    );
  }

  // 15. parseRemoteManifest extracts the new fields correctly
  {
    const fp = makeFp({
      cronMarkers: ["m1", "m2"],
      requiredEnvVars: ["A_VAR", "B_VAR"],
      envVarDefaults: { FOO: "bar", BAZ: "qux" },
    });
    const parsed = parseRemoteManifest(buildSrc(fp));
    assert(parsed !== null, "scenario-15: parser succeeded");
    if (parsed) {
      assert(parsed.cronMarkers.length === 2, `scenario-15a: 2 cronMarkers (got ${parsed.cronMarkers.length})`);
      assert(parsed.cronMarkers.includes("m1"), "scenario-15b: cronMarker m1 present");
      assert(parsed.requiredEnvVars.length === 2, `scenario-15c: 2 requiredEnvVars (got ${parsed.requiredEnvVars.length})`);
      assert(parsed.envVarDefaults.FOO === "bar", "scenario-15d: envVarDefaults.FOO=bar");
      assert(parsed.envVarDefaults.BAZ === "qux", "scenario-15e: envVarDefaults.BAZ=qux");
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════`);
  console.log(`Tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("All verifyManifestFreshness scenarios pass.");
    process.exit(0);
  }
})();
