/**
 * Freeze-v2 archive bundle composition + R2 integration.
 *
 * Pure data plumbing — no SSH, no DB. The cron orchestrators wire SSH
 * (to invoke gbrain's `snapshot_brain` MCP tool for the brain tarball
 * and `tar czf` for user-state) + DB (to persist the manifest) + this
 * module (which handles the format, encryption, and R2 wire).
 *
 * Per PRD §15.4 — `instaclaw/docs/prd/freeze-thaw-v2-archive-based.md`.
 *
 * ## Container format (no new dependencies — zero npm deps beyond the
 * existing R2 + crypto substrate)
 *
 * The "outer tar" referenced in the PRD is implemented here as a simple
 * length-prefixed binary container called ICAB (InstaClaw Archive Bundle):
 *
 *     ┌─────────────────────────────────────────────────────────────┐
 *     │  4 bytes:    magic "ICAB"                                   │
 *     │  1 byte:     format version (currently 1)                   │
 *     │  8 bytes:    big-endian uint64 — manifest_json length       │
 *     │  N bytes:    manifest_json (UTF-8 JSON)                     │
 *     │  8 bytes:    big-endian uint64 — brain tarball length       │
 *     │  M bytes:    brain.pglite.tar.gz                            │
 *     │  8 bytes:    big-endian uint64 — user-state tarball length  │
 *     │  P bytes:    user-state.tar.gz                              │
 *     └─────────────────────────────────────────────────────────────┘
 *
 * This is NOT standard POSIX tar — we don't need filenames or attributes
 * because the consumer (downloadAndExtractArchive) knows the slots by
 * position. Trade-off vs standard tar: no `tar -xf` for manual recovery,
 * but BIG simplicity win (no `tar` npm dep, no parsing edge cases). If
 * manual recovery is ever needed, the format above is small enough to
 * implement a 20-line Python extractor from this docstring alone.
 *
 * The OUTER container is then encrypted whole-blob with AES-256-GCM via
 * `lib/freeze-encryption.ts`. The ciphertext is what we upload to R2.
 *
 * ## Where the encryption key_id lives
 *
 * The plaintext manifest (inside the container) carries `encryption_key_id`
 * for self-describing recovery. But the consumer needs the key BEFORE it
 * can decrypt the container — so `encryption_key_id` is ALSO persisted in
 * the DB row's `frozen_archive_manifest` jsonb column. Belt-and-suspenders:
 * losing the DB row doesn't strand the archive (an operator can grep R2,
 * try each known key id until decryption succeeds), and losing R2 doesn't
 * leave us with no record of how a missing archive was encrypted.
 */

import { createHash } from "node:crypto";
import {
  putObject,
  getObject,
  deleteObject,
  listObjectsByPrefix,
  type R2ObjectInfo,
} from "./r2-storage";
import { encrypt, decrypt } from "./freeze-encryption";

// ── Format constants ─────────────────────────────────────────────────────
const MAGIC: Buffer = Buffer.from("ICAB", "utf-8");
const FORMAT_VERSION = 1;
const HEADER_BYTES = MAGIC.length + 1; // magic + version byte
const LEN_PREFIX_BYTES = 8;

/** Maximum permitted size of an inner tarball — guard against runaway. */
export const MAX_INNER_TARBALL_BYTES = 200 * 1024 * 1024; // 200 MB

/** Maximum permitted size of the outer archive (sum of inners + manifest + overhead). */
export const MAX_OUTER_ARCHIVE_BYTES = 256 * 1024 * 1024; // 256 MB

// ── Manifest schema ──────────────────────────────────────────────────────

/**
 * The plaintext manifest embedded in the archive AND persisted to
 * `instaclaw_vms.frozen_archive_manifest` (jsonb).
 *
 * Add new fields ONLY as optional (defaults: null/undefined). Removing or
 * renaming a field is a breaking change that requires manifest_version bump.
 */
export interface ArchiveManifest {
  /** Schema version — bump on breaking changes. v1 ships 2026-05-18. */
  manifest_version: 1;
  /** Source VM id (instaclaw_vms.id). */
  vm_id: string;
  /** VM_MANIFEST.version at archive time. Used by thaw to pick a rewire path
   *  (gap-based: small gap = stepFiles only; large gap = full reconcile). */
  source_manifest_version: number;
  /** Archive creation timestamp (ISO 8601 UTC). */
  generated_at: string;
  /** key_id used to encrypt the outer container ("v1", "v2", ...). Stored
   *  here for self-describing recovery; ALSO mirrored in DB so the decryptor
   *  can read it without decrypting first. */
  encryption_key_id: string;
  /** SHA-256 hex of the inner brain.pglite tarball (the dumpDataDir gzip
   *  output before composition). */
  brain_sha256: string;
  /** Size in bytes of the inner brain tarball. */
  brain_size_bytes: number;
  /** SHA-256 hex of the inner user-state tarball. */
  user_state_sha256: string;
  /** Size in bytes of the inner user-state tarball. */
  user_state_size_bytes: number;
}

// ── Low-level helpers ────────────────────────────────────────────────────

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function writeLenPrefixedBlock(buf: Buffer): Buffer {
  const lenBuf = Buffer.alloc(LEN_PREFIX_BYTES);
  lenBuf.writeBigUInt64BE(BigInt(buf.length), 0);
  return Buffer.concat([lenBuf, buf]);
}

function readLenPrefixedBlock(
  input: Buffer,
  offset: number,
  fieldName: string,
): { data: Buffer; nextOffset: number } {
  if (offset + LEN_PREFIX_BYTES > input.length) {
    throw new ArchiveExtractError(
      `Truncated archive: cannot read ${fieldName} length at offset ${offset} (buffer is ${input.length} bytes)`,
    );
  }
  const rawLen = input.readBigUInt64BE(offset);
  if (rawLen > BigInt(MAX_OUTER_ARCHIVE_BYTES)) {
    throw new ArchiveExtractError(
      `Corrupt archive: ${fieldName} length ${rawLen} exceeds max ${MAX_OUTER_ARCHIVE_BYTES}`,
    );
  }
  const len = Number(rawLen);
  const dataStart = offset + LEN_PREFIX_BYTES;
  const dataEnd = dataStart + len;
  if (dataEnd > input.length) {
    throw new ArchiveExtractError(
      `Truncated archive: ${fieldName} extends past buffer (need ${dataEnd}, buffer ${input.length})`,
    );
  }
  return { data: input.subarray(dataStart, dataEnd), nextOffset: dataEnd };
}

// ── Errors (typed so callers can branch on root cause) ───────────────────

export class ArchiveExtractError extends Error {
  override readonly name = "ArchiveExtractError";
}
export class ArchiveIntegrityError extends Error {
  override readonly name = "ArchiveIntegrityError";
}
export class ArchiveSizeError extends Error {
  override readonly name = "ArchiveSizeError";
}

// ── Composition ──────────────────────────────────────────────────────────

/**
 * Combine two inner tarballs + manifest into a single outer ICAB buffer.
 *
 * The returned manifest has `encryption_key_id` set to the empty string —
 * `encryptAndUploadArchive` fills it in after calling `encrypt()`. If you
 * only want to compose (e.g. for an unencrypted test fixture), pass
 * `params.encryptionKeyIdForManifest` to set it explicitly.
 */
export function composeArchiveBundle(params: {
  brainTarball: Buffer;
  userStateTarball: Buffer;
  vmId: string;
  sourceManifestVersion: number;
  /** Override generated_at — for deterministic test fixtures. */
  generatedAt?: string;
  /** Set encryption_key_id directly in the manifest (skips encrypt). */
  encryptionKeyIdForManifest?: string;
}): { outerBundle: Buffer; manifest: ArchiveManifest } {
  if (params.brainTarball.length > MAX_INNER_TARBALL_BYTES) {
    throw new ArchiveSizeError(
      `brain tarball ${params.brainTarball.length} bytes > max ${MAX_INNER_TARBALL_BYTES}`,
    );
  }
  if (params.userStateTarball.length > MAX_INNER_TARBALL_BYTES) {
    throw new ArchiveSizeError(
      `user-state tarball ${params.userStateTarball.length} bytes > max ${MAX_INNER_TARBALL_BYTES}`,
    );
  }

  const manifest: ArchiveManifest = {
    manifest_version: 1,
    vm_id: params.vmId,
    source_manifest_version: params.sourceManifestVersion,
    generated_at: params.generatedAt ?? new Date().toISOString(),
    encryption_key_id: params.encryptionKeyIdForManifest ?? "",
    brain_sha256: sha256Hex(params.brainTarball),
    brain_size_bytes: params.brainTarball.length,
    user_state_sha256: sha256Hex(params.userStateTarball),
    user_state_size_bytes: params.userStateTarball.length,
  };
  const manifestJson = Buffer.from(JSON.stringify(manifest), "utf-8");

  const outerBundle = Buffer.concat([
    MAGIC,
    Buffer.from([FORMAT_VERSION]),
    writeLenPrefixedBlock(manifestJson),
    writeLenPrefixedBlock(params.brainTarball),
    writeLenPrefixedBlock(params.userStateTarball),
  ]);

  if (outerBundle.length > MAX_OUTER_ARCHIVE_BYTES) {
    throw new ArchiveSizeError(
      `outer bundle ${outerBundle.length} bytes > max ${MAX_OUTER_ARCHIVE_BYTES}`,
    );
  }

  return { outerBundle, manifest };
}

/**
 * Reverse of composeArchiveBundle. Validates magic, version, sha-256s.
 * Throws ArchiveExtractError on structural issues; ArchiveIntegrityError on
 * SHA-256 mismatch (== tampered or wrong source).
 */
export function extractArchiveBundle(outerBundle: Buffer): {
  brainTarball: Buffer;
  userStateTarball: Buffer;
  manifest: ArchiveManifest;
} {
  if (outerBundle.length < HEADER_BYTES) {
    throw new ArchiveExtractError(
      `Buffer too short for header: ${outerBundle.length} < ${HEADER_BYTES}`,
    );
  }
  const magic = outerBundle.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new ArchiveExtractError(
      `Magic mismatch: got 0x${magic.toString("hex")}, expected 0x${MAGIC.toString("hex")} (ICAB)`,
    );
  }
  const version = outerBundle[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new ArchiveExtractError(
      `Unsupported ICAB format version: ${version} (this build understands ${FORMAT_VERSION})`,
    );
  }

  let offset = HEADER_BYTES;
  const { data: manifestJson, nextOffset: o1 } = readLenPrefixedBlock(outerBundle, offset, "manifest");
  offset = o1;
  const { data: brainTarball, nextOffset: o2 } = readLenPrefixedBlock(outerBundle, offset, "brain tarball");
  offset = o2;
  const { data: userStateTarball } = readLenPrefixedBlock(outerBundle, offset, "user-state tarball");

  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse(manifestJson.toString("utf-8")) as ArchiveManifest;
  } catch (err) {
    throw new ArchiveExtractError(`manifest is not valid JSON: ${String(err)}`);
  }
  if (manifest.manifest_version !== 1) {
    throw new ArchiveExtractError(
      `Unsupported manifest_version ${manifest.manifest_version} (this build understands 1)`,
    );
  }

  // SHA-256 round-trip integrity check (defense vs. silent tarball corruption,
  // even if the outer-tar AES-GCM auth tag passed). The manifest's sha-256s
  // also catch composition bugs — if we ever produce an archive whose
  // manifest doesn't match the inner bytes, this fires immediately.
  const brainShaActual = sha256Hex(brainTarball);
  if (brainShaActual !== manifest.brain_sha256) {
    throw new ArchiveIntegrityError(
      `brain tarball sha256 mismatch — manifest=${manifest.brain_sha256.slice(0, 16)}..., actual=${brainShaActual.slice(0, 16)}...`,
    );
  }
  const userStateShaActual = sha256Hex(userStateTarball);
  if (userStateShaActual !== manifest.user_state_sha256) {
    throw new ArchiveIntegrityError(
      `user-state tarball sha256 mismatch — manifest=${manifest.user_state_sha256.slice(0, 16)}..., actual=${userStateShaActual.slice(0, 16)}...`,
    );
  }
  if (brainTarball.length !== manifest.brain_size_bytes) {
    throw new ArchiveIntegrityError(
      `brain size mismatch — manifest=${manifest.brain_size_bytes}, actual=${brainTarball.length}`,
    );
  }
  if (userStateTarball.length !== manifest.user_state_size_bytes) {
    throw new ArchiveIntegrityError(
      `user-state size mismatch — manifest=${manifest.user_state_size_bytes}, actual=${userStateTarball.length}`,
    );
  }

  return { brainTarball, userStateTarball, manifest };
}

// ── R2 path helpers ──────────────────────────────────────────────────────

/** Per-VM R2 key prefix. listObjects + delete operations scope here. */
export function archivePrefixForVm(vmId: string): string {
  return `freeze-v2/${vmId}/`;
}

/**
 * Build the R2 object key for a fresh archive. Format:
 *   freeze-v2/<vm-id>/<unix-ms>-<sha256-prefix-12chars>.bin
 *
 * The unix-ms prefix sorts lexicographically by recency. The sha-prefix
 * makes adjacent-timestamp collisions vanishingly unlikely (would need two
 * archives of the same VM at the same ms with identical content).
 */
export function buildArchiveKey(vmId: string, ciphertextSha256: string, generatedAtMs?: number): string {
  const ts = generatedAtMs ?? Date.now();
  return `${archivePrefixForVm(vmId)}${ts}-${ciphertextSha256.slice(0, 12)}.bin`;
}

// ── High-level: encrypt + upload + return DB-ready manifest ──────────────

export interface EncryptAndUploadResult {
  /** R2 object key — store in instaclaw_vms.frozen_archive_path */
  r2Key: string;
  /** sha256 of the ciphertext (the bytes that landed in R2) —
   *  store in instaclaw_vms.frozen_archive_sha256 */
  ciphertextSha256: string;
  /** Size in bytes of the ciphertext — store as ÷ 1024 in
   *  instaclaw_vms.frozen_archive_size_kb */
  ciphertextSizeBytes: number;
  /** The full manifest object — store in instaclaw_vms.frozen_archive_manifest (jsonb).
   *  Contains encryption_key_id, which the thaw cron reads to decrypt. */
  manifest: ArchiveManifest;
}

/**
 * Compose + encrypt + upload an archive to R2 in one call. Returns
 * everything the caller needs to update `instaclaw_vms` so the row's
 * archive state matches what's in R2.
 *
 * On any failure (encrypt error, R2 error), throws. The cron orchestrator
 * is responsible for the `freeze_state` transitions; this function only
 * commits to R2 state.
 */
export async function encryptAndUploadArchive(params: {
  brainTarball: Buffer;
  userStateTarball: Buffer;
  vmId: string;
  sourceManifestVersion: number;
}): Promise<EncryptAndUploadResult> {
  // Compose first WITHOUT key_id (encrypt() picks the current key); after
  // encrypt, fill the key_id back into the manifest so the persisted DB
  // copy mirrors what's described in the (still-encrypted) plaintext inside.
  const { outerBundle: plaintextWithoutKeyId, manifest: tentativeManifest } = composeArchiveBundle({
    brainTarball: params.brainTarball,
    userStateTarball: params.userStateTarball,
    vmId: params.vmId,
    sourceManifestVersion: params.sourceManifestVersion,
  });

  const { ciphertext, keyId } = encrypt(plaintextWithoutKeyId);

  // Rebuild manifest with the real key_id (the inner-tarball sha-256s are
  // unaffected — they're sha of the inner content, not the manifest). We do
  // NOT re-encode the outer bundle — that would change the ciphertext and
  // invalidate the sha256 we're about to compute. Instead, callers reading
  // the inner manifest later will see the encryptionKeyId from the OUTER
  // path (DB column) or from a fresh extractArchiveBundle whose result we
  // explicitly augment in downloadAndExtractArchive (below).
  const finalManifest: ArchiveManifest = { ...tentativeManifest, encryption_key_id: keyId };

  const ciphertextSha = sha256Hex(ciphertext);
  const r2Key = buildArchiveKey(params.vmId, ciphertextSha);

  await putObject(r2Key, ciphertext, "application/octet-stream");

  return {
    r2Key,
    ciphertextSha256: ciphertextSha,
    ciphertextSizeBytes: ciphertext.length,
    manifest: finalManifest,
  };
}

// ── High-level: download + decrypt + extract ─────────────────────────────

export interface DownloadAndExtractResult {
  brainTarball: Buffer;
  userStateTarball: Buffer;
  manifest: ArchiveManifest;
}

/**
 * Download from R2, decrypt with `encryptionKeyId` (read from DB by the
 * caller), and extract the inner tarballs + manifest. Verifies ciphertext
 * sha-256 (defense vs. R2 corruption) and inner-tarball sha-256s
 * (extractArchiveBundle does this).
 *
 * @param expectedCiphertextSha256 - sha of what's stored in
 *        instaclaw_vms.frozen_archive_sha256. Pass undefined to skip the
 *        outer-blob check (extract-time fields still validate inner shas).
 */
export async function downloadAndExtractArchive(params: {
  r2Key: string;
  encryptionKeyId: string;
  expectedCiphertextSha256?: string;
}): Promise<DownloadAndExtractResult> {
  const ciphertext = await getObject(params.r2Key);
  if (params.expectedCiphertextSha256) {
    const actual = sha256Hex(ciphertext);
    if (actual !== params.expectedCiphertextSha256) {
      throw new ArchiveIntegrityError(
        `R2 ciphertext sha256 mismatch — expected=${params.expectedCiphertextSha256.slice(0, 16)}..., actual=${actual.slice(0, 16)}...`,
      );
    }
  }
  const plaintext = decrypt(ciphertext, params.encryptionKeyId);
  return extractArchiveBundle(plaintext);
}

// ── R2 management: list, retention sweep, GDPR delete ────────────────────

/** All archive objects for a VM, sorted recent-first. */
export async function listVmArchives(vmId: string): Promise<R2ObjectInfo[]> {
  const objs = await listObjectsByPrefix(archivePrefixForVm(vmId));
  // Sort by modified desc (recent first); key-name lexicographic order
  // (unix-ms prefix) is the same ordering modulo identical-ms collisions.
  return objs.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Retention sweep: keep the N most recent archives per VM, delete older.
 * Defaults to keeping 3 (matches PRD §15.5 step 12). Returns the keys that
 * were deleted (or would have been, if dryRun).
 *
 * Why this lives in the library and not just the cron: it's also the
 * cleanup path for a manual operator script (`_freeze-v2-retention-sweep.ts`)
 * and for the GDPR delete endpoint's "keep none" variant (keep=0).
 */
export async function pruneVmArchives(params: {
  vmId: string;
  keep?: number;
  dryRun?: boolean;
}): Promise<{ deleted: string[]; kept: string[] }> {
  const keep = params.keep ?? 3;
  if (keep < 0) throw new RangeError(`keep must be >= 0, got ${keep}`);
  const all = await listVmArchives(params.vmId);
  const kept = all.slice(0, keep).map((o) => o.key);
  const toDelete = all.slice(keep).map((o) => o.key);
  if (!params.dryRun) {
    for (const key of toDelete) {
      await deleteObject(key);
    }
  }
  return { deleted: toDelete, kept };
}

/**
 * GDPR delete — remove EVERY archive for a VM from R2. The caller is
 * responsible for also clearing the DB columns (frozen_archive_*) so the
 * row no longer references the now-gone objects. We don't touch the DB
 * here because the cron / admin endpoint that calls this owns the
 * transaction semantics around the VM row.
 *
 * Returns the count of objects deleted.
 */
export async function deleteAllVmArchives(vmId: string): Promise<{ deletedCount: number; deletedKeys: string[] }> {
  const result = await pruneVmArchives({ vmId, keep: 0, dryRun: false });
  return { deletedCount: result.deleted.length, deletedKeys: result.deleted };
}
