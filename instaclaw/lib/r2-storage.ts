/**
 * Cloudflare R2 storage wrapper for freeze-v2 archive bundles.
 *
 * Why R2 (PRD §16.1):
 *   - $0 egress to Linode (matters at thaw time when we download archives
 *     onto fresh VMs across many regions; S3 charges $0.09/GB egress).
 *   - 10 GB free tier covers us for years (~200-400 frozen users at p90
 *     archive size).
 *   - S3-compatible API means we can swap to AWS S3 or Supabase Storage
 *     by changing only env vars + endpoint URL.
 *
 * Auth (server-side only):
 *   - R2 API token credentials in Vercel env. No public access.
 *   - Created via R2 dashboard → "Manage API Tokens" → permissions scoped
 *     to the single bucket.
 *
 * Required env vars:
 *   - R2_ACCOUNT_ID            Cloudflare account ID (used in endpoint URL)
 *   - R2_ACCESS_KEY_ID         API token access key id
 *   - R2_SECRET_ACCESS_KEY     API token secret access key
 *   - R2_BUCKET                Bucket name (e.g., instaclaw-frozen-archives)
 *
 * Sizes:
 *   - Typical archive: 5-50 MB (PRD §6.1 estimates).
 *   - Single PutObject upload (no multipart) is fine up to 5 GB.
 *   - getObject returns Buffer (not stream). At our sizes (max ~100 MB cap
 *     per PRD §15.4), memory cost is negligible (~100 MB peak per concurrent
 *     thaw, and Vercel Pro functions have 3 GB memory).
 *
 * Failure semantics:
 *   - putObject / deleteObject: throw on any non-2xx. Caller decides retry.
 *   - getObject: throws ObjectNotFoundError (subclass of Error with .key)
 *     on 404 specifically — caller distinguishes "archive missing" from
 *     "network broke." Other errors throw raw.
 *   - objectExists: returns boolean. Never throws (logs warnings on
 *     unexpected errors and returns false — fail-CLOSED for "does the
 *     archive exist" gates).
 *   - listObjectsByPrefix: paginates internally. Caller gets full result.
 *
 * No retry logic at this layer. The AWS SDK has built-in exponential
 * backoff for transient 5xx/throttling. Higher-level retry (e.g., "retry
 * the whole archive cycle") lives in the cron, not here.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  type ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";

// ─── Custom error for 404 detection ──────────────────────────────────────

export class ObjectNotFoundError extends Error {
  public readonly key: string;
  constructor(key: string) {
    super(`R2 object not found: ${key}`);
    this.name = "ObjectNotFoundError";
    this.key = key;
  }
}

// ─── Singleton client (lazy, matches lib/email.ts pattern) ───────────────

let _client: S3Client | null = null;
let _bucket: string | null = null;

interface R2EnvSnapshot {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function readEnv(): R2EnvSnapshot {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const missing: string[] = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!bucket) missing.push("R2_BUCKET");
  if (missing.length > 0) {
    throw new Error(
      `R2 storage misconfigured: missing env vars [${missing.join(", ")}]. ` +
      `Set via Vercel env: see lib/r2-storage.ts doc comment.`,
    );
  }
  return { accountId: accountId!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, bucket: bucket! };
}

function getClient(): { client: S3Client; bucket: string } {
  if (_client && _bucket) return { client: _client, bucket: _bucket };
  const env = readEnv();
  _client = new S3Client({
    region: "auto", // R2 uses "auto" — region is determined by the account
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    // No request-signer config needed for R2. Default SigV4 works.
  });
  _bucket = env.bucket;
  return { client: _client, bucket: _bucket };
}

/**
 * Reset the lazy singleton. Called by tests; not used in production.
 * The smoke-test script uses this so successive test runs read fresh env
 * vars (e.g., after rotation).
 */
export function _resetForTest(): void {
  _client = null;
  _bucket = null;
}

// ─── Operations ──────────────────────────────────────────────────────────

/**
 * Upload an object to R2. Throws on any non-2xx response.
 *
 * @param key - R2 object key (e.g., "vm-abc/1234567890-deadbeef.tar.enc")
 * @param body - Object body (Buffer). At our sizes, a single PutObject is
 *               fine; the SDK does multipart automatically for >5 GB which
 *               we'll never hit.
 * @param contentType - MIME type. Defaults to "application/octet-stream"
 *                      for encrypted blobs.
 */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string = "application/octet-stream",
): Promise<void> {
  const { client, bucket } = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
    }),
  );
}

/**
 * Download an object from R2. Throws ObjectNotFoundError on 404; throws
 * raw error on any other failure.
 *
 * @param key - R2 object key
 * @returns Buffer containing the full object body
 */
export async function getObject(key: string): Promise<Buffer> {
  const { client, bucket } = getClient();
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    // Body is a Node Readable stream (or Web ReadableStream). transformToByteArray
    // returns Uint8Array; we wrap in Buffer for the caller.
    if (!res.Body) {
      throw new Error(`R2 GetObject returned no body for key ${key}`);
    }
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (err) {
    if (isNoSuchKeyError(err)) {
      throw new ObjectNotFoundError(key);
    }
    throw err;
  }
}

/**
 * Delete an object from R2. Idempotent — succeeds even if the key didn't
 * exist (R2 returns 2xx for DELETE on a missing key, same as S3).
 *
 * @param key - R2 object key
 */
export async function deleteObject(key: string): Promise<void> {
  const { client, bucket } = getClient();
  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );
}

/**
 * Check if an object exists at the given key. Never throws — returns false
 * on any error (including 404). Use for fail-CLOSED gates ("if archive
 * doesn't exist, skip freeze").
 *
 * Logs unexpected errors to stderr so they remain visible without breaking
 * the caller's control flow.
 *
 * @param key - R2 object key
 */
export async function objectExists(key: string): Promise<boolean> {
  const { client, bucket } = getClient();
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return true;
  } catch (err) {
    if (isNoSuchKeyError(err)) return false;
    if (isNotFoundStatus(err)) return false;
    console.error(
      `r2-storage.objectExists: unexpected error for key ${key}: ${stringifyError(err)}`,
    );
    return false;
  }
}

/**
 * Object metadata returned by listObjectsByPrefix.
 */
export interface R2ObjectInfo {
  key: string;
  size: number;       // bytes
  modified: Date;     // last-modified
  etag: string | null; // S3 ETag (often a sha256 prefix or md5 hash)
}

/**
 * List all objects whose key starts with the given prefix. Paginates
 * internally — caller gets one combined array. At our scale (≤ 3 archives
 * per VM × ~200 frozen VMs = ~600 objects), no pagination is needed in
 * practice, but the SDK handles >1000 results transparently.
 *
 * @param prefix - R2 key prefix (e.g., "vm-abc/")
 * @returns Sorted by key, ascending.
 */
export async function listObjectsByPrefix(prefix: string): Promise<R2ObjectInfo[]> {
  const { client, bucket } = getClient();
  const results: R2ObjectInfo[] = [];
  let continuationToken: string | undefined = undefined;
  // Explicit Promise<ListObjectsV2CommandOutput> typing to satisfy TS — S3Client.send
  // is overloaded and the inferred return type collapses to void without this.
  while (true) {
    const page: ListObjectsV2CommandOutput = await (client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    ) as Promise<ListObjectsV2CommandOutput>);
    for (const obj of page.Contents ?? []) {
      if (!obj.Key) continue;
      results.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        modified: obj.LastModified ?? new Date(0),
        etag: obj.ETag ?? null,
      });
    }
    if (!page.IsTruncated || !page.NextContinuationToken) break;
    continuationToken = page.NextContinuationToken;
  }
  results.sort((a, b) => a.key.localeCompare(b.key));
  return results;
}

// ─── Error inspection helpers ────────────────────────────────────────────
//
// AWS SDK v3 throws errors with `.name` set to the operation-specific
// failure (e.g., "NoSuchKey", "NotFound") OR `.$metadata.httpStatusCode`
// for the raw status. We support both shapes.

function isNoSuchKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "NoSuchKey" || name === "NotFound";
}

function isNotFoundStatus(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const meta = (err as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return meta?.httpStatusCode === 404;
}

function stringifyError(err: unknown): string {
  if (!err) return "<no error>";
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err).slice(0, 200);
}
