/**
 * Empirical verification of lib/manifest-integrity.ts against the
 * actual on-disk vm-manifest.ts. If both sides produce the same
 * SHA, the integrity check is safe to ship. If they differ, identify
 * the diff before committing — a false-positive integrity check would
 * halt the reconcile-fleet cron entirely (route.ts:163 returns 503).
 */
import { readFileSync } from "fs";
import { VM_MANIFEST } from "../lib/vm-manifest";
import {
  computeManifestSha,
  __resetManifestIntegrityCache,
} from "../lib/manifest-integrity";

// Inline copy of parseRemoteManifest so we don't have to expose it.
// Mirror of lib/manifest-integrity.ts (post-fix shape).
function parseRemoteManifest(src: string): {
  version: number;
  configSettings: Record<string, string>;
  dynamicKeys: string[];
} | null {
  const versionMatch = src.match(/version:\s*(\d+)/);
  if (!versionMatch) return null;
  const version = parseInt(versionMatch[1], 10);
  const csStart = src.indexOf("configSettings:");
  if (csStart < 0) return null;
  const openBraceIdx = src.indexOf("{", csStart);
  if (openBraceIdx < 0) return null;
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
    const keyOnly = trimmed.match(/^"([^"]+)":/);
    if (keyOnly) dynamicKeys.push(keyOnly[1]);
  }
  return { version, configSettings: settings, dynamicKeys };
}

__resetManifestIntegrityCache();

const src = readFileSync("/Users/cooperwrenn/wild-west-bots/instaclaw/lib/vm-manifest.ts", "utf-8");
const parsed = parseRemoteManifest(src);

if (!parsed) {
  console.error("FATAL — parser returned null. The integrity check would log github_parse_err and degrade to allowing cv bump (no halt). Still a problem; investigate.");
  process.exit(1);
}

console.log("=== Parser results ===");
console.log(`Parsed version: ${parsed.version}`);
console.log(`Runtime version: ${VM_MANIFEST.version}`);
console.log(`Parsed configSettings keys: ${Object.keys(parsed.configSettings).length}`);
console.log(`Runtime configSettings keys: ${Object.keys(VM_MANIFEST.configSettings).length}`);

const runtimeKeys = new Set(Object.keys(VM_MANIFEST.configSettings));
const parsedKeys = new Set(Object.keys(parsed.configSettings));
const missingFromParsed = [...runtimeKeys].filter((k) => !parsedKeys.has(k));
const missingFromRuntime = [...parsedKeys].filter((k) => !runtimeKeys.has(k));
const valueMismatches: Array<{ key: string; runtime: string; parsed: string }> = [];
for (const k of runtimeKeys) {
  if (!parsedKeys.has(k)) continue;
  if (VM_MANIFEST.configSettings[k] !== parsed.configSettings[k]) {
    valueMismatches.push({
      key: k,
      runtime: VM_MANIFEST.configSettings[k],
      parsed: parsed.configSettings[k],
    });
  }
}

console.log(`\n=== Diffs (raw, before dynamicKeys filter) ===`);
console.log(`Missing from parsed (runtime has, source-parser doesn't): ${missingFromParsed.length}`);
for (const k of missingFromParsed) {
  console.log(`  - ${k} = "${VM_MANIFEST.configSettings[k]}"`);
}
console.log(`Missing from runtime (source-parser has, runtime doesn't): ${missingFromRuntime.length}`);
for (const k of missingFromRuntime) {
  console.log(`  - ${k} = "${parsed.configSettings[k]}"`);
}
console.log(`Value mismatches: ${valueMismatches.length}`);
for (const m of valueMismatches) {
  console.log(`  - ${m.key}  runtime="${m.runtime}"  parsed="${m.parsed}"`);
}

console.log(`\n=== Dynamic-value keys (excluded from SHA on both sides) ===`);
console.log(`Dynamic keys reported by parser: ${parsed.dynamicKeys.length}`);
for (const k of parsed.dynamicKeys) {
  const rv = VM_MANIFEST.configSettings[k];
  console.log(`  - ${k}  runtime-evaluated="${rv ?? "(missing)"}"`);
}

// Mirror the verifier's filter: drop dynamicKeys from runtime; parser
// already excludes them.
const dynamicKeySet = new Set(parsed.dynamicKeys);
const filteredRuntime: Record<string, string> = {};
for (const [k, v] of Object.entries(VM_MANIFEST.configSettings)) {
  if (!dynamicKeySet.has(k)) filteredRuntime[k] = v;
}
const runtimeSha = computeManifestSha(VM_MANIFEST.version, filteredRuntime);
const parsedSha = computeManifestSha(parsed.version, parsed.configSettings);
console.log(`\n=== SHA comparison ===`);
console.log(`Runtime SHA: ${runtimeSha}`);
console.log(`Parsed SHA:  ${parsedSha}`);
if (runtimeSha === parsedSha) {
  console.log(`\nMATCH — integrity check is safe to ship as-is.`);
  process.exit(0);
} else {
  console.log(`\nMISMATCH — committing as-is would HALT the reconcile-fleet cron on every tick (false positive).`);
  console.log(`Fix required before commit.`);
  process.exit(1);
}
