/**
 * Synthetic-data tests for lib/freeze-v2-archive.ts.
 *
 * Validates composer/extractor + integrity checks WITHOUT needing R2 creds.
 * R2 paths (putObject/getObject) are exercised by scripts/_verify-freeze-v2-infra.ts
 * which needs real credentials — that's the integration test.
 *
 * Run: `npx tsx scripts/_test-freeze-v2-archive.ts`
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — any check failed (script logs which one)
 */

import { randomBytes } from "node:crypto";
import {
  composeArchiveBundle,
  extractArchiveBundle,
  buildArchiveKey,
  archivePrefixForVm,
  ArchiveExtractError,
  ArchiveIntegrityError,
  ArchiveSizeError,
  MAX_INNER_TARBALL_BYTES,
} from "../lib/freeze-v2-archive";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function expectThrows<T extends Error>(name: string, fn: () => unknown, ctor: new (...args: never[]) => T): void {
  try {
    fn();
    check(name, false, "expected throw, got success");
  } catch (err) {
    check(name, err instanceof ctor, `expected ${ctor.name}, got ${err instanceof Error ? err.constructor.name : typeof err}: ${err}`);
  }
}

// ── Test 1: Happy-path round trip ─────────────────────────────────────────
console.log("\n=== Test 1: round-trip 100 KB brain + 20 KB user-state ===");
{
  const brain = randomBytes(100 * 1024);
  const userState = randomBytes(20 * 1024);
  const { outerBundle, manifest } = composeArchiveBundle({
    brainTarball: brain,
    userStateTarball: userState,
    vmId: "vm-test-001",
    sourceManifestVersion: 104,
  });
  check("compose returns Buffer outerBundle", Buffer.isBuffer(outerBundle));
  check("manifest.manifest_version == 1", manifest.manifest_version === 1);
  check("manifest.vm_id matches", manifest.vm_id === "vm-test-001");
  check("manifest.source_manifest_version matches", manifest.source_manifest_version === 104);
  check("manifest.brain_size_bytes matches", manifest.brain_size_bytes === brain.length);
  check("manifest.user_state_size_bytes matches", manifest.user_state_size_bytes === userState.length);
  check("manifest.brain_sha256 is 64 hex chars", /^[a-f0-9]{64}$/.test(manifest.brain_sha256));
  check("manifest.user_state_sha256 is 64 hex chars", /^[a-f0-9]{64}$/.test(manifest.user_state_sha256));
  check("manifest.generated_at is ISO string", !Number.isNaN(Date.parse(manifest.generated_at)));

  const extracted = extractArchiveBundle(outerBundle);
  check("extracted brainTarball byte-identical", extracted.brainTarball.equals(brain));
  check("extracted userStateTarball byte-identical", extracted.userStateTarball.equals(userState));
  check("extracted manifest deep-equals", JSON.stringify(extracted.manifest) === JSON.stringify(manifest));
}

// ── Test 2: Magic mismatch detection ──────────────────────────────────────
console.log("\n=== Test 2: corrupted magic detected ===");
{
  const brain = randomBytes(1024);
  const userState = randomBytes(512);
  const { outerBundle } = composeArchiveBundle({
    brainTarball: brain,
    userStateTarball: userState,
    vmId: "vm-test-002",
    sourceManifestVersion: 104,
  });
  const corrupted = Buffer.from(outerBundle);
  corrupted[0] = 0x00; // mangle magic
  expectThrows("extract throws ArchiveExtractError on bad magic", () => extractArchiveBundle(corrupted), ArchiveExtractError);
}

// ── Test 3: Truncation detection ──────────────────────────────────────────
console.log("\n=== Test 3: truncation detected ===");
{
  const brain = randomBytes(1024);
  const userState = randomBytes(512);
  const { outerBundle } = composeArchiveBundle({
    brainTarball: brain,
    userStateTarball: userState,
    vmId: "vm-test-003",
    sourceManifestVersion: 104,
  });
  const truncated = outerBundle.subarray(0, outerBundle.length - 100);
  expectThrows("extract throws ArchiveExtractError on truncated buffer", () => extractArchiveBundle(truncated), ArchiveExtractError);
}

// ── Test 4: Tampered inner brain tarball detected via sha-256 ─────────────
console.log("\n=== Test 4: tampered brain tarball detected via sha-256 ===");
{
  const brain = randomBytes(1024);
  const userState = randomBytes(512);
  const { outerBundle, manifest } = composeArchiveBundle({
    brainTarball: brain,
    userStateTarball: userState,
    vmId: "vm-test-004",
    sourceManifestVersion: 104,
  });
  const corrupted = Buffer.from(outerBundle);
  // Find a byte deep inside the brain tarball region and flip it.
  // The structure: header(5) + len(8) + manifest_json(N) + len(8) + brain(1024) + ...
  // We don't know N statically but we know N ≈ JSON.stringify(manifest).length.
  // Cheat: flip a byte ~75% through the buffer (well into brain region for these sizes).
  const flipAt = Math.floor(corrupted.length * 0.75);
  corrupted[flipAt] ^= 0xff;
  expectThrows(
    "extract throws ArchiveIntegrityError on tampered brain",
    () => extractArchiveBundle(corrupted),
    ArchiveIntegrityError,
  );
  // Manifest's brain sha is still well-formed (we didn't touch the manifest)
  check("manifest brain_sha256 is set", manifest.brain_sha256.length === 64);
}

// ── Test 5: Size limit enforcement ────────────────────────────────────────
console.log("\n=== Test 5: oversize inner tarball rejected ===");
{
  // 250 MB > MAX_INNER_TARBALL_BYTES (200 MB). Allocate as a sparse-feeling
  // buffer to avoid spiking RAM during the test — just allocate the threshold
  // + 1 byte to confirm rejection without actually mining 250 MB of entropy.
  const oversize = Buffer.alloc(MAX_INNER_TARBALL_BYTES + 1);
  const userState = randomBytes(512);
  expectThrows(
    "compose throws ArchiveSizeError on oversize brain",
    () => composeArchiveBundle({
      brainTarball: oversize,
      userStateTarball: userState,
      vmId: "vm-test-005",
      sourceManifestVersion: 104,
    }),
    ArchiveSizeError,
  );
}

// ── Test 6: Deterministic composition (same inputs → same bytes) ──────────
console.log("\n=== Test 6: deterministic composition with fixed generatedAt ===");
{
  const brain = randomBytes(256);
  const userState = randomBytes(128);
  const fixedTs = "2026-05-18T00:00:00.000Z";
  const a = composeArchiveBundle({
    brainTarball: brain,
    userStateTarball: userState,
    vmId: "vm-test-006",
    sourceManifestVersion: 104,
    generatedAt: fixedTs,
  });
  const b = composeArchiveBundle({
    brainTarball: brain,
    userStateTarball: userState,
    vmId: "vm-test-006",
    sourceManifestVersion: 104,
    generatedAt: fixedTs,
  });
  check("two composes with identical inputs produce byte-identical outputs", a.outerBundle.equals(b.outerBundle));
}

// ── Test 7: Empty inner tarballs (edge case — should still round-trip) ────
console.log("\n=== Test 7: empty inner tarballs ===");
{
  const empty = Buffer.alloc(0);
  const { outerBundle, manifest } = composeArchiveBundle({
    brainTarball: empty,
    userStateTarball: empty,
    vmId: "vm-test-007",
    sourceManifestVersion: 104,
  });
  check("manifest brain_size_bytes is 0", manifest.brain_size_bytes === 0);
  check("manifest user_state_size_bytes is 0", manifest.user_state_size_bytes === 0);
  const extracted = extractArchiveBundle(outerBundle);
  check("extracted brain is empty buffer", extracted.brainTarball.length === 0);
  check("extracted user-state is empty buffer", extracted.userStateTarball.length === 0);
}

// ── Test 8: R2 key naming ────────────────────────────────────────────────
console.log("\n=== Test 8: R2 key naming + prefix ===");
{
  const vmId = "vm-test-008";
  const sha = "a".repeat(64);
  const ts = 1700000000000;
  const key = buildArchiveKey(vmId, sha, ts);
  check("key starts with freeze-v2/ prefix", key.startsWith("freeze-v2/vm-test-008/"));
  check("key includes ms timestamp", key.includes("1700000000000-"));
  check("key includes 12-char sha prefix", key.endsWith(`-${"a".repeat(12)}.bin`));
  check("archivePrefixForVm matches key root", key.startsWith(archivePrefixForVm(vmId)));
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n=== Summary: ${passed} passed / ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
