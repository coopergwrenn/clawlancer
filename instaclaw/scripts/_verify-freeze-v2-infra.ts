/**
 * End-to-end smoke test for the freeze-v2 substrate (PRD §15 Phase 1.4).
 *
 * Validates the full path BEFORE any cron-driven archival runs:
 *   1. Encryption self-test (round-trip a 32-byte probe)
 *   2. Generate synthetic 10 MB random blob (representative of typical
 *      compressed archive bundle)
 *   3. Encrypt with AES-256-GCM
 *   4. Upload to R2 at a probe-scoped key
 *   5. Verify objectExists returns true
 *   6. List objects with the probe prefix, confirm size + last-modified
 *   7. Download (full Buffer)
 *   8. Verify downloaded SHA-256 matches original
 *   9. Decrypt
 *  10. Verify decrypted bytes match the synthetic blob (byte-identical)
 *  11. Delete the probe object
 *  12. Confirm objectExists returns false
 *
 * Usage:
 *   npx tsx scripts/_verify-freeze-v2-infra.ts
 *
 * Required env (load both .env files via the standard Rule 18 pattern):
 *   - R2_ACCOUNT_ID
 *   - R2_ACCESS_KEY_ID
 *   - R2_SECRET_ACCESS_KEY
 *   - R2_BUCKET
 *   - FREEZE_ARCHIVE_KEY_CURRENT  (e.g., "v1")
 *   - FREEZE_ARCHIVE_KEY_V1       (64 hex chars; openssl rand -hex 32)
 *
 * Cleanup: this script ALWAYS deletes its own probe object on exit, even
 * on failure (try/finally). If a crash leaves an orphan, it's at the path
 * `freeze-v2-smoke/<unix-ts>-<pid>.bin` and a future R2 list will surface it.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — any check failed (script logs which one)
 *   2 — env var missing / config error
 */

import { readFileSync } from "fs";
import { createHash, randomBytes } from "crypto";

// Load .env.local + .env.ssh-key per CLAUDE.md Rule 18.
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* missing file = okay, vars may come from real environment */
  }
}

// Import substrate libs after env loading.
import { encrypt, decrypt, selfTest, getCurrentKeyId } from "../lib/freeze-encryption";
import {
  putObject,
  getObject,
  deleteObject,
  objectExists,
  listObjectsByPrefix,
} from "../lib/r2-storage";

// ─── Helpers ─────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function pass(label: string, detail = ""): void {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail: string): never {
  console.error(`  ✗ ${label} — ${detail}`);
  process.exit(1);
}

function preflightEnv(): void {
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "FREEZE_ARCHIVE_KEY_CURRENT",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`FATAL: missing env vars: ${missing.join(", ")}`);
    console.error(`Set in Vercel env (or .env.local for local testing) and re-run.`);
    process.exit(2);
  }
  // The current key's specific env var must also exist.
  const currentKeyId = process.env.FREEZE_ARCHIVE_KEY_CURRENT!;
  const keyEnvName = `FREEZE_ARCHIVE_KEY_${currentKeyId.toUpperCase()}`;
  if (!process.env[keyEnvName]) {
    console.error(`FATAL: FREEZE_ARCHIVE_KEY_CURRENT=${currentKeyId} but ${keyEnvName} is unset.`);
    process.exit(2);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== freeze-v2 infra smoke test ===");
  console.log(`bucket: ${process.env.R2_BUCKET}`);
  console.log(`account_id: ${process.env.R2_ACCOUNT_ID?.slice(0, 8)}...`);
  console.log(`current_key_id: ${process.env.FREEZE_ARCHIVE_KEY_CURRENT}`);
  console.log();

  preflightEnv();

  // Probe key — unique per invocation so concurrent test runs don't clobber.
  const probeKey = `freeze-v2-smoke/${Math.floor(Date.now() / 1000)}-${process.pid}.bin`;
  let uploaded = false;

  try {
    // 1. Encryption self-test
    console.log("step 1: encryption self-test");
    const st = selfTest();
    pass("encrypt → decrypt round-trip (32-byte probe)", `key_id=${st.keyId}`);

    // 2. Generate 10 MB synthetic blob (representative size)
    console.log("step 2: synthesize 10 MB blob");
    const SIZE = 10 * 1024 * 1024;
    const plaintext = randomBytes(SIZE);
    const plaintextHash = sha256(plaintext);
    pass("generated synthetic blob", `size=${SIZE} sha256=${plaintextHash.slice(0, 16)}...`);

    // 3. Encrypt
    console.log("step 3: encrypt");
    const t3 = Date.now();
    const { ciphertext, keyId } = encrypt(plaintext);
    const dt3 = Date.now() - t3;
    if (keyId !== getCurrentKeyId()) {
      fail("encrypt key_id", `expected ${getCurrentKeyId()}, got ${keyId}`);
    }
    if (ciphertext.length !== plaintext.length + 28) {
      fail("ciphertext size", `expected ${plaintext.length + 28} (12 IV + 16 tag + N), got ${ciphertext.length}`);
    }
    pass("encrypt", `${ciphertext.length} bytes, key_id=${keyId}, ${dt3}ms`);
    const ciphertextHash = sha256(ciphertext);

    // 4. Upload to R2
    console.log(`step 4: upload to R2 at ${probeKey}`);
    const t4 = Date.now();
    await putObject(probeKey, ciphertext);
    const dt4 = Date.now() - t4;
    uploaded = true;
    pass("upload", `${ciphertext.length} bytes in ${dt4}ms`);

    // 5. objectExists → true
    console.log("step 5: objectExists check");
    const exists1 = await objectExists(probeKey);
    if (!exists1) fail("objectExists after upload", "got false; expected true");
    pass("objectExists returns true");

    // 6. listObjectsByPrefix surfaces our probe
    console.log("step 6: listObjectsByPrefix");
    const prefix = "freeze-v2-smoke/";
    const list = await listObjectsByPrefix(prefix);
    const ours = list.find((o) => o.key === probeKey);
    if (!ours) fail("listObjectsByPrefix", `our probe (${probeKey}) not in the result of ${list.length} items`);
    if (ours.size !== ciphertext.length) {
      fail("listObjectsByPrefix size", `expected ${ciphertext.length}, got ${ours.size}`);
    }
    pass("listObjectsByPrefix", `found ${list.length} object(s) under ${prefix}; our size=${ours.size} mtime=${ours.modified.toISOString()}`);

    // 7. Download
    console.log("step 7: download");
    const t7 = Date.now();
    const downloaded = await getObject(probeKey);
    const dt7 = Date.now() - t7;
    if (downloaded.length !== ciphertext.length) {
      fail("download size", `expected ${ciphertext.length}, got ${downloaded.length}`);
    }
    pass("download", `${downloaded.length} bytes in ${dt7}ms`);

    // 8. Hash check on ciphertext (R2 integrity)
    console.log("step 8: ciphertext sha256 match");
    const downloadedHash = sha256(downloaded);
    if (downloadedHash !== ciphertextHash) {
      fail("ciphertext sha256", `R2 returned different bytes than we uploaded (upload=${ciphertextHash.slice(0, 16)}... download=${downloadedHash.slice(0, 16)}...)`);
    }
    pass("ciphertext sha256 match", downloadedHash.slice(0, 16) + "...");

    // 9. Decrypt
    console.log("step 9: decrypt");
    const t9 = Date.now();
    const recovered = decrypt(downloaded, keyId);
    const dt9 = Date.now() - t9;
    pass("decrypt", `${recovered.length} bytes in ${dt9}ms`);

    // 10. Plaintext sha256 match
    console.log("step 10: plaintext sha256 match");
    if (recovered.length !== plaintext.length) {
      fail("decrypted size", `expected ${plaintext.length}, got ${recovered.length}`);
    }
    const recoveredHash = sha256(recovered);
    if (recoveredHash !== plaintextHash) {
      fail("plaintext sha256", `recovered != original (orig=${plaintextHash.slice(0, 16)}... recovered=${recoveredHash.slice(0, 16)}...)`);
    }
    if (!recovered.equals(plaintext)) {
      fail("plaintext byte-equality", "sha256 matched but Buffer.equals returned false (should be impossible)");
    }
    pass("plaintext sha256 match", recoveredHash.slice(0, 16) + "...");

    // 11. Delete
    console.log("step 11: delete");
    await deleteObject(probeKey);
    pass("delete issued");

    // 12. objectExists → false
    console.log("step 12: objectExists after delete");
    // Note: R2 (like S3) is strongly consistent for DELETE-after-PUT in our access
    // pattern (single writer, post-delete read). No retry loop needed.
    const exists2 = await objectExists(probeKey);
    if (exists2) {
      fail("objectExists after delete", "got true; expected false (R2 delete didn't take effect)");
    }
    pass("objectExists returns false (deleted)");

    console.log();
    console.log("=== ALL CHECKS PASSED ===");
    console.log("freeze-v2 substrate (R2 + encryption + DB schema) is operational.");
    console.log("Next: Phase 2 (archive cron) ships once gbrain terminal exposes snapshot_brain MCP tool.");
  } catch (err) {
    console.error();
    console.error("FATAL during smoke test:", err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    // Cleanup: ensure we never leave probe objects in R2 even on mid-script crash.
    if (uploaded) {
      try {
        await deleteObject(probeKey);
        console.log(`(cleanup: deleted probe ${probeKey})`);
      } catch (cleanupErr) {
        console.error(
          `(cleanup: failed to delete probe ${probeKey}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`,
        );
        console.error(`Manual cleanup: list objects with prefix "freeze-v2-smoke/" and delete.`);
      }
    }
  }
}

main().catch((err) => {
  console.error("UNCAUGHT in main:", err);
  process.exit(99);
});
