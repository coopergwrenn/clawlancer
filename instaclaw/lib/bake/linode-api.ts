/**
 * lib/bake/linode-api.ts — Linode API operations for the autonomous bake.
 *
 * Provides typed, defensive wrappers around the Linode v4 API for:
 *   - Provisioning the bake VM (POST /linode/instances)
 *   - Waiting for status transitions (running, offline)
 *   - Listing disks (to find ext4 for imagize)
 *   - Creating images (POST /images) with async availability polling
 *   - Deleting bake VMs after success/failure
 *   - Reading account images for storage-quota awareness
 *
 * Gotchas handled (per design doc Research §"Linode API gotchas"):
 *   - Image creation is async; we poll for status=available, treat 404 as
 *     async-rejection (likely disk-size overflow), with a sane timeout.
 *   - Shutdown must complete before imagize — separate poll for status=offline.
 *   - Disk listing returns swap + ext4; we filter by filesystem.
 *   - Label uniqueness — we generate timestamp-salted labels.
 *   - Rate limits ~800 req/min per token, never a real concern for bake.
 *   - Cloud-init regenerates SSH host keys on first boot — handled by
 *     `pollSshReady` which retries until handshake succeeds.
 *
 * The shape of every operation:
 *   - Network errors → throw with descriptive message (orchestrator catches).
 *   - HTTP errors → throw with HTTP status + body excerpt.
 *   - Timeouts → throw with `LinodeTimeoutError` (orchestrator can retry).
 *   - Async-rejection (image 404 after creation) → throw with body excerpt
 *     including Linode's failure reason if available.
 */

import { Client } from "ssh2";

const LINODE_API_BASE = "https://api.linode.com/v4";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LinodeInstance {
  id: number;
  label: string;
  status: "running" | "offline" | "booting" | "shutting_down" | "provisioning" | "deleting" | string;
  ipv4: string[];
  ipv6: string;
  region: string;
  type: string;
  image: string | null;
  created: string;
  tags: string[];
}

export interface LinodeDisk {
  id: number;
  label: string;
  status: string;
  size: number; // MB
  filesystem: "ext4" | "swap" | "raw" | "initrd" | string;
  created: string;
}

export interface LinodeImage {
  id: string; // "private/12345" form
  label: string;
  status: "creating" | "pending_upload" | "available" | string;
  size: number; // MB
  description: string | null;
  is_public: boolean;
  type: "manual" | "automatic" | string;
  expiry: string | null;
  created: string;
  created_by: string | null;
  vendor: string | null;
}

export interface CreateInstanceParams {
  label: string;
  region: string;
  type: string;
  image: string;            // e.g., "private/38575292"
  root_pass: string;
  authorized_keys: string[];
  tags?: string[];
}

export interface CreateImageParams {
  disk_id: number;
  label: string;
  description: string;
}

export class LinodeTimeoutError extends Error {
  constructor(public op: string, public elapsed_ms: number, message?: string) {
    super(message || `Linode ${op} timeout after ${elapsed_ms}ms`);
    this.name = "LinodeTimeoutError";
  }
}

export class LinodeApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public body: string,
  ) {
    super(`Linode ${method} ${path} → HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "LinodeApiError";
  }
}

// ─── Low-level fetch ─────────────────────────────────────────────────────────

async function linodeFetch(path: string, init?: RequestInit): Promise<unknown> {
  const token = process.env.LINODE_API_TOKEN;
  if (!token) throw new Error("LINODE_API_TOKEN not set");

  const res = await fetch(`${LINODE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  // Linode returns 200 for most success, 204 for DELETE. Anything else is an error.
  if (!res.ok && res.status !== 200 && res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new LinodeApiError(init?.method ?? "GET", path, res.status, body);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Sleep helper ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Instance lifecycle ──────────────────────────────────────────────────────

/**
 * Provision a fresh Linode instance from a snapshot image.
 *
 * Returns the LinodeInstance immediately (status will be `provisioning` or
 * `booting`). Caller should poll with `waitForStatus`.
 */
export async function createInstance(params: CreateInstanceParams): Promise<LinodeInstance> {
  const body = {
    label: params.label,
    region: params.region,
    type: params.type,
    image: params.image,
    root_pass: params.root_pass,
    authorized_keys: params.authorized_keys,
    tags: params.tags ?? ["instaclaw", "snapshot-bake", "auto"],
    booted: true,
  };
  return (await linodeFetch("/linode/instances", {
    method: "POST",
    body: JSON.stringify(body),
  })) as LinodeInstance;
}

/** Read current state of an instance. */
export async function getInstance(linodeId: number): Promise<LinodeInstance> {
  return (await linodeFetch(`/linode/instances/${linodeId}`)) as LinodeInstance;
}

/** Shutdown (clean) an instance. Async — caller polls for status=offline. */
export async function shutdownInstance(linodeId: number): Promise<void> {
  await linodeFetch(`/linode/instances/${linodeId}/shutdown`, { method: "POST" });
}

/** Delete an instance (and its disks). Irreversible. */
export async function deleteInstance(linodeId: number): Promise<void> {
  await linodeFetch(`/linode/instances/${linodeId}`, { method: "DELETE" });
}

/**
 * Wait for an instance to reach a target status. Polls every 5s.
 * Throws LinodeTimeoutError after `timeoutMs`.
 *
 * Per-status timeouts (typical):
 *   - provisioning → running: 60-90s
 *   - running → offline: 30-60s (shutdown)
 *   - offline → running: 30-60s (boot)
 */
export async function waitForStatus(
  linodeId: number,
  desired: LinodeInstance["status"],
  timeoutMs: number,
): Promise<LinodeInstance> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inst = await getInstance(linodeId);
    if (inst.status === desired) return inst;
    await sleep(5000);
  }
  throw new LinodeTimeoutError(`wait-for-${desired}`, Date.now() - start);
}

/**
 * Poll until SSH on the instance is reachable + handshake completes.
 * Used after status=running to wait for cloud-init's host-key regeneration.
 *
 * Returns when a clean handshake completes; throws on timeout.
 */
export async function pollSshReady(
  ipAddress: string,
  sshPrivateKey: string,
  timeoutMs: number,
  user = "openclaw",
): Promise<void> {
  const start = Date.now();
  let lastErr: Error | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const client = new Client();
        const timer = setTimeout(() => {
          client.end();
          reject(new Error("handshake timeout"));
        }, 10_000);
        client
          .on("ready", () => {
            clearTimeout(timer);
            client.end();
            resolve();
          })
          .on("error", (err: Error) => {
            clearTimeout(timer);
            reject(err);
          })
          .connect({
            host: ipAddress,
            port: 22,
            username: user,
            privateKey: sshPrivateKey,
            readyTimeout: 10_000,
          });
      });
      return;
    } catch (err) {
      lastErr = err as Error;
      await sleep(5000);
    }
  }
  throw new LinodeTimeoutError("ssh-ready", Date.now() - start, lastErr?.message);
}

// ─── Disk operations ─────────────────────────────────────────────────────────

/** List disks for an instance. */
export async function listDisks(linodeId: number): Promise<LinodeDisk[]> {
  const r = (await linodeFetch(`/linode/instances/${linodeId}/disks`)) as { data: LinodeDisk[] };
  return r.data ?? [];
}

/** Find the primary ext4 disk for imagizing (excludes swap and other types). */
export async function findExt4Disk(linodeId: number): Promise<LinodeDisk> {
  const disks = await listDisks(linodeId);
  const ext4 = disks.filter((d) => d.filesystem === "ext4");
  if (ext4.length === 0) {
    throw new Error(`No ext4 disk found on instance ${linodeId}`);
  }
  if (ext4.length > 1) {
    // Multiple ext4 disks — return the largest (which is conventionally the root disk).
    ext4.sort((a, b) => b.size - a.size);
  }
  return ext4[0];
}

// ─── Images ──────────────────────────────────────────────────────────────────

/**
 * Create a private image from a disk. Returns immediately with status=creating.
 * Caller MUST poll with `waitForImageAvailable` — Linode prepares the image
 * asynchronously and can silently fail (deleting the image) if the disk
 * exceeds the 6,144 MB cap. The 404 case is handled in `waitForImageAvailable`.
 */
export async function createImage(params: CreateImageParams): Promise<LinodeImage> {
  return (await linodeFetch("/images", {
    method: "POST",
    body: JSON.stringify(params),
  })) as LinodeImage;
}

/** Read an image's state. Returns null if 404 (image was rejected and deleted). */
export async function getImage(imageId: string): Promise<LinodeImage | null> {
  try {
    return (await linodeFetch(`/images/${imageId}`)) as LinodeImage;
  } catch (err) {
    if (err instanceof LinodeApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Poll until an image reaches status=available, OR 404 (rejection).
 * Returns the image on success; throws on rejection or timeout.
 *
 * Typical wall-clock: 5-10 minutes for a ~5 GB ext4 disk.
 */
export async function waitForImageAvailable(
  imageId: string,
  timeoutMs: number,
  pollMs = 15_000,
): Promise<LinodeImage> {
  const start = Date.now();
  let lastStatus = "creating";
  while (Date.now() - start < timeoutMs) {
    const img = await getImage(imageId);
    if (img === null) {
      throw new Error(
        `Image ${imageId} was rejected by Linode after async prep (404). ` +
          `Most common cause: disk size exceeded the 6,144 MB private-image limit. ` +
          `Verify the bake VM's disk usage was < 5,900 MB before imagize.`,
      );
    }
    if (img.status === "available") return img;
    lastStatus = img.status;
    await sleep(pollMs);
  }
  throw new LinodeTimeoutError(
    "wait-for-image-available",
    Date.now() - start,
    `Image ${imageId} stuck in status=${lastStatus} after ${timeoutMs}ms`,
  );
}

/** Delete a private image. Irreversible. */
export async function deleteImage(imageId: string): Promise<void> {
  await linodeFetch(`/images/${imageId}`, { method: "DELETE" });
}

/** List all private images on the account. Useful for storage-quota check. */
export async function listPrivateImages(): Promise<LinodeImage[]> {
  const all: LinodeImage[] = [];
  let page = 1;
  // Cap at 10 pages defensively (~1000 images) — accounts shouldn't approach this.
  while (page <= 10) {
    const r = (await linodeFetch(`/images?page=${page}&page_size=100`)) as {
      data: LinodeImage[];
      pages: number;
    };
    all.push(...(r.data ?? []).filter((img) => !img.is_public));
    if (page >= (r.pages ?? 1)) break;
    page++;
  }
  return all;
}

// ─── Storage quota awareness ─────────────────────────────────────────────────

/**
 * Linode private-image storage. Per-account quota is policy-driven and not
 * exposed via the API, but counting images-in-progress is a useful pre-flight
 * gate (excess in-flight prep can throttle a new image's prep).
 */
export async function countImagesInProgress(): Promise<number> {
  const all = await listPrivateImages();
  return all.filter((img) => img.status === "creating" || img.status === "pending_upload").length;
}

// ─── SSH key lookup (used during instance provisioning) ──────────────────────

export interface LinodeSSHKey {
  id: number;
  label: string;
  ssh_key: string;
  created: string;
}

/** List the account's SSH keys. */
export async function listSshKeys(): Promise<LinodeSSHKey[]> {
  const r = (await linodeFetch("/profile/sshkeys")) as { data: LinodeSSHKey[] };
  return r.data ?? [];
}

/** Find the canonical "instaclaw-deploy" public key for bake VM provision. */
export async function getInstaclawDeployKey(): Promise<string> {
  const keys = await listSshKeys();
  const match = keys.find((k) => k.label === "instaclaw-deploy");
  if (!match) {
    throw new Error(
      "SSH key 'instaclaw-deploy' not found in Linode profile. " +
        "Add it via the Linode dashboard or `provision-clob-proxy.sh` reference pattern.",
    );
  }
  return match.ssh_key;
}

// ─── Helpers exported for the orchestrator ───────────────────────────────────

/**
 * Generate a random root password for bake VMs. Cooper doesn't need this —
 * SSH auth uses the deploy key — but Linode requires the field to be set.
 */
export function generateRandomRootPassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  let out = "";
  const arr = new Uint8Array(32);
  if (typeof crypto !== "undefined" && (crypto as any).getRandomValues) {
    (crypto as any).getRandomValues(arr);
  } else {
    // Node.js fallback
    const { randomBytes } = require("crypto");
    arr.set(randomBytes(32));
  }
  for (let i = 0; i < 32; i++) {
    out += chars[arr[i] % chars.length];
  }
  return out;
}

/**
 * Generate a snapshot image label that's unique within the account.
 * Format: `instaclaw-base-vNNN-YYYY-MM-DD-HHMM-utc`.
 */
export function generateSnapshotLabel(manifestVersion: number, now = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  const dateStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const timeStr = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `instaclaw-base-v${manifestVersion}-${dateStr}-${timeStr}-utc`;
}
