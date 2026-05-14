/**
 * Empirical verification of lib/manifest-integrity.ts against the
 * actual on-disk vm-manifest.ts. If both sides produce the same
 * fingerprint SHA, the integrity check is safe to ship. If they differ,
 * identify the diff before committing — a false-positive integrity
 * check would halt the reconcile-fleet cron entirely (route.ts returns
 * 503 on `stale_bundle` verdict).
 *
 * Run: npx tsx scripts/_verify-manifest-integrity-roundtrip.ts
 *
 * Updated 2026-05-14 for P1-4 §C: the fingerprint now includes
 * cronMarkers + requiredEnvVars + envVarDefaults. The round-trip
 * compares ALL of these between the runtime VM_MANIFEST and the
 * parser's view of the same on-disk source.
 */
import { readFileSync } from "fs";
import { VM_MANIFEST } from "../lib/vm-manifest";
import {
  computeManifestSha,
  parseRemoteManifest,
  manifestFingerprint,
  __resetManifestIntegrityCache,
  type ManifestFingerprint,
} from "../lib/manifest-integrity";

__resetManifestIntegrityCache();

const src = readFileSync(
  "/Users/cooperwrenn/wild-west-bots/instaclaw/lib/vm-manifest.ts",
  "utf-8",
);
const parsed = parseRemoteManifest(src);

if (!parsed) {
  console.error(
    "FATAL — parser returned null. One of the required fields couldn't " +
      "be extracted from vm-manifest.ts. The integrity check would log " +
      "github_parse_err and degrade to allowing cv bump (no halt). Still " +
      "a problem; investigate.",
  );
  process.exit(1);
}

const runtime = manifestFingerprint(VM_MANIFEST);

console.log("=== Parser vs runtime field-by-field ===");
console.log(`version:           runtime=${runtime.version}   parsed=${parsed.version}`);
console.log(
  `configSettings:    runtime=${Object.keys(runtime.configSettings).length} keys   ` +
    `parsed=${Object.keys(parsed.configSettings).length} keys ` +
    `(${parsed.dynamicConfigKeys.length} dynamic)`,
);
console.log(
  `cronMarkers:       runtime=${runtime.cronMarkers.length}   parsed=${parsed.cronMarkers.length}`,
);
console.log(
  `requiredEnvVars:   runtime=${runtime.requiredEnvVars.length}   parsed=${parsed.requiredEnvVars.length}`,
);
console.log(
  `envVarDefaults:    runtime=${Object.keys(runtime.envVarDefaults).length} keys   ` +
    `parsed=${Object.keys(parsed.envVarDefaults).length} keys ` +
    `(${parsed.dynamicEnvVarDefaultKeys.length} dynamic)`,
);

const runtimeKeys = new Set(Object.keys(runtime.configSettings));
const parsedKeys = new Set(Object.keys(parsed.configSettings));
const missingFromParsed = [...runtimeKeys].filter((k) => !parsedKeys.has(k));
const missingFromRuntime = [...parsedKeys].filter((k) => !runtimeKeys.has(k));
const valueMismatches: Array<{ key: string; runtime: string; parsed: string }> = [];
for (const k of runtimeKeys) {
  if (!parsedKeys.has(k)) continue;
  if (runtime.configSettings[k] !== parsed.configSettings[k]) {
    valueMismatches.push({
      key: k,
      runtime: runtime.configSettings[k],
      parsed: parsed.configSettings[k],
    });
  }
}

console.log(`\n=== configSettings diffs (raw, before dynamicKeys filter) ===`);
console.log(`Missing from parsed (runtime has, source-parser doesn't): ${missingFromParsed.length}`);
for (const k of missingFromParsed) console.log(`  - ${k} = "${runtime.configSettings[k]}"`);
console.log(`Missing from runtime (source-parser has, runtime doesn't): ${missingFromRuntime.length}`);
for (const k of missingFromRuntime) console.log(`  - ${k} = "${parsed.configSettings[k]}"`);
console.log(`Value mismatches: ${valueMismatches.length}`);
for (const m of valueMismatches)
  console.log(`  - ${m.key}  runtime="${m.runtime}"  parsed="${m.parsed}"`);

console.log(`\n=== Dynamic-value keys (excluded from SHA on both sides) ===`);
console.log(`Dynamic configSettings keys: ${parsed.dynamicConfigKeys.length}`);
for (const k of parsed.dynamicConfigKeys) {
  const rv = runtime.configSettings[k];
  console.log(`  - ${k}  runtime-evaluated="${rv ?? "(missing)"}"`);
}
console.log(`Dynamic envVarDefaults keys: ${parsed.dynamicEnvVarDefaultKeys.length}`);
for (const k of parsed.dynamicEnvVarDefaultKeys) {
  const rv = runtime.envVarDefaults[k];
  console.log(`  - ${k}  runtime-evaluated="${rv ?? "(missing)"}"`);
}

// Mirror the verifier's filter: drop dynamicKeys from runtime
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
const runtimeSha = computeManifestSha(runtimeFiltered);
const parsedSha = computeManifestSha(parsedFp);
console.log(`\n=== Fingerprint SHA comparison (post-filter) ===`);
console.log(`Runtime SHA: ${runtimeSha}`);
console.log(`Parsed SHA:  ${parsedSha}`);
if (runtimeSha === parsedSha) {
  console.log(`\nMATCH — integrity check is safe to ship as-is.`);
  process.exit(0);
} else {
  console.log(
    `\nMISMATCH — committing as-is would HALT the reconcile-fleet cron on every tick (false positive). Fix required before commit.`,
  );
  process.exit(1);
}
