/**
 * i2v source-image upload — build order §6. The path every user photo
 * travels: VM (local file / media://inbound) → gate ?action=upload →
 * Supabase Storage public URL → Higgsfield image-to-video.
 *
 * Replaces the legacy higgsfield-video skill's uploader, which pointed at
 * the DEPRECATED Muapi CDN — the 2026-06-11 "Need to upload the image to
 * get a public URL first" leak happened because the cloud skill documented
 * no upload step and the agent improvised cross-skill.
 *
 * Storage pattern mirrors lib/token-image.ts (the codebase-proven Supabase
 * Storage usage: upload + getPublicUrl).
 *
 * DESIGN NOTES (hostile-walked):
 * - Raw-bytes transport (not file_id fetch): the photo is ALWAYS on the VM
 *   disk (media://inbound/<id>.jpg — verified on vm-050) while a Telegram
 *   file_id isn't reliably available to the agent; bytes are also
 *   channel-agnostic (iMessage photos travel the same path). Vercel's
 *   ~4.5MB body limit → 4MB cap; Telegram-compressed photos are ≪ that.
 * - Magic-byte sniffing, never caller content-type. JPEG/PNG/WEBP only
 *   (HF i2v wants a still; GIF rejected in v1).
 * - Flat, epoch-prefixed object names → names sort chronologically → the
 *   48h-TTL cleanup is ONE list (name-asc) + delete-until-unexpired.
 * - 48h TTL kills free-image-host abuse (public links die) — that, not a
 *   per-VM quota, is the v1 abuse bound: renders are the metered resource
 *   and storage cost is negligible (4MB × heavy use ≈ cents/month).
 * - Public bucket by design: Higgsfield must fetch the URL unauthenticated.
 *   If the bucket ever flips private, renders fail at submit (released, no
 *   charge) — loud, not silent.
 */

import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const SOURCE_BUCKET = "higgsfield-sources";
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel body limit headroom
export const SOURCE_TTL_MS = 48 * 60 * 60 * 1000;

/** Magic-byte image sniffing. Returns the canonical extension or null. */
export function sniffImageType(buf: Buffer): "jpg" | "png" | "webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "png";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) return "webp";
  return null;
}

/** Flat, chronologically-sortable object name. Epoch prefix drives the
 *  single-list cleanup; the random suffix makes the public URL unguessable. */
export function buildObjectName(vmId: string, ext: string, nowMs: number, rand: string): string {
  const vm8 = vmId.replace(/-/g, "").slice(0, 8);
  return `src_${String(nowMs).padStart(14, "0")}_${vm8}_${rand}.${ext}`;
}

/** Parse the epoch out of an object name built by buildObjectName. */
export function parseObjectEpoch(name: string): number | null {
  const m = /^src_(\d{14})_/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Idempotent bucket ensure — 409/already-exists tolerated. */
async function ensureBucket(): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.storage.createBucket(SOURCE_BUCKET, { public: true });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    // Unexpected error — surface it; upload will fail loudly anyway if real.
    logger.warn("higgsfield-upload: createBucket non-duplicate error", {
      route: "lib/higgsfield-upload", error: error.message,
    });
  }
}

export type UploadResult =
  | { ok: true; url: string; objectName: string; bytes: number; type: string }
  | { ok: false; error: "too_large" | "bad_type" | "storage_failed" };

/** Validate + store a source image; return its public URL. */
export async function uploadSourceImage(vmId: string, buf: Buffer): Promise<UploadResult> {
  if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "too_large" };
  }
  const ext = sniffImageType(buf);
  if (!ext) return { ok: false, error: "bad_type" };

  const supabase = getSupabase();
  await ensureBucket();

  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const objectName = buildObjectName(vmId, ext, Date.now(), rand);
  const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

  const { error } = await supabase.storage
    .from(SOURCE_BUCKET)
    .upload(objectName, buf, { contentType, upsert: false });
  if (error) {
    logger.error("higgsfield-upload: storage upload failed", {
      route: "lib/higgsfield-upload", vmId, bytes: buf.length, error: error.message,
    });
    return { ok: false, error: "storage_failed" };
  }

  const { data: urlData } = supabase.storage.from(SOURCE_BUCKET).getPublicUrl(objectName);
  return { ok: true, url: urlData.publicUrl, objectName, bytes: buf.length, type: ext };
}

/** 48h-TTL cleanup: one name-asc list (epoch prefix = chronological), delete
 *  everything expired, stop at the first unexpired name. Bounded per run. */
export async function cleanupExpiredSources(maxDelete = 200): Promise<{ deleted: number }> {
  const supabase = getSupabase();
  const cutoff = Date.now() - SOURCE_TTL_MS;
  const { data: objects, error } = await supabase.storage
    .from(SOURCE_BUCKET)
    .list("", { limit: maxDelete, sortBy: { column: "name", order: "asc" } });
  if (error) {
    // Bucket may not exist yet (no uploads ever) — that's a clean no-op.
    if (/not found/i.test(error.message)) return { deleted: 0 };
    logger.warn("higgsfield-upload: cleanup list failed", {
      route: "lib/higgsfield-upload", error: error.message,
    });
    return { deleted: 0 };
  }
  const expired: string[] = [];
  for (const obj of objects ?? []) {
    const epoch = parseObjectEpoch(obj.name);
    if (epoch === null) continue; // foreign object — leave it
    if (epoch >= cutoff) break; // names sort chronologically — done
    expired.push(obj.name);
  }
  if (expired.length === 0) return { deleted: 0 };
  const { error: delErr } = await supabase.storage.from(SOURCE_BUCKET).remove(expired);
  if (delErr) {
    logger.warn("higgsfield-upload: cleanup remove failed", {
      route: "lib/higgsfield-upload", error: delErr.message, count: expired.length,
    });
    return { deleted: 0 };
  }
  return { deleted: expired.length };
}
