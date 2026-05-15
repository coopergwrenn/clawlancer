/**
 * GET /api/vm/cloud-init-config — per-VM tarball delivery endpoint.
 *
 * Called ONCE per VM by the cloud-init bootstrap (lib/cloud-init-userdata.ts).
 * The bootstrap curls this URL with:
 *   - X-Cloud-Init-Config-Token: <hex32+>  (one-time-use)
 *   - ?userId=<uuid>&vmName=<instaclaw-vm-XXX>
 *
 * Response: application/gzip tar.gz body (the per-VM tarball that setup.sh
 * extracts to /tmp/instaclaw-config/), or one of the failure status codes
 * documented in docs/cloud-init-builder-plan-2026-05-13.md §5.
 *
 * ── Security model ──
 * Atomic claim-and-invalidate (PRD §5.3.1 pattern). The UPDATE WHERE clause
 * insists on `cloud_init_config_consumed_at IS NULL` so concurrent or replay
 * attempts after the first success find no row → 401. Three different
 * failure classes all collapse to 401 so probing can't distinguish them
 * (defense in depth): wrong token, already consumed, VM not in provisioning.
 *
 * ── Failure handling ──
 * After the atomic claim succeeds but BEFORE the response is sent, two more
 * things can fail: param construction (buildParamsFromVmRow throws on a
 * NULL load-bearing column) or tarball generation (buildCloudInitTarball
 * throws on validation or stream errors). Both branches release the
 * consumed_at back to NULL so the bootstrap's curl retry can succeed once
 * the upstream defect is fixed.
 *
 * Plan reference: docs/cloud-init-builder-plan-2026-05-13.md §5.
 * Middleware allow-list entry: instaclaw/middleware.ts (self-auth via header).
 *
 * 2026-05-15 Phase 1A Day 9-10 deliverable.
 */
// Cache-bust: 2026-05-15 — initial deploy of cloud-init-config endpoint.

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { buildCloudInitTarball } from "@/lib/cloud-init-tarball";
import { buildParamsFromVmRow, type VmRow } from "@/lib/cloud-init-params";
import { Readable } from "stream";

export const dynamic = "force-dynamic";
// Tarball generation budget: ~1-3s for the file reads + gzip compression of
// ~10-17 entries depending on partner / Gmail / World-ID presence. 60s is
// comfortable headroom. Vercel Fluid Compute supports up to 800s on Pro;
// 60s is far below the ceiling. Per CLAUDE.md Rule 11.
export const maxDuration = 60;

// ── Input validation regexes ──
// Both validate at the request boundary BEFORE the DB lookup. Malformed
// inputs return 400 instead of 401 so legitimate-but-misspelled bootstraps
// get a clearer signal in logs while genuine attackers still can't probe
// (token-shape check is separate and rolls into the 401 path).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VM_NAME_RE = /^instaclaw-vm-[a-zA-Z0-9_-]+$/;
// Tokens minted via randomBytes(32).toString("hex") = 64 hex chars. Accept
// the broader 32-128 range for forward-compat with longer tokens.
const HEX_TOKEN_RE = /^[a-fA-F0-9]{32,128}$/;

/**
 * Consume a Readable stream into a single Buffer.
 *
 * Buffering instead of streaming the response: a tarball is 3-5 MB max, and
 * the atomicity benefit is worth the modest memory cost. If
 * buildCloudInitTarball throws mid-pack, we get the throw cleanly here
 * (caught by the route handler) and can release the consumed token. With
 * streaming, the response body would already be partially flushed before
 * the throw — the bootstrap's curl would see a truncated tarball and `tar
 * xzf` would fail in a confusing way, AND the consumed token would still
 * block retries.
 *
 * Vercel Fluid Compute functions have ample memory budget for a few-MB
 * buffer; this is the safer pattern.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // Buffer.concat() returns Buffer<ArrayBufferLike>; NextResponse's body
  // type accepts only the narrower Buffer<ArrayBuffer> variant (the one
  // returned by Buffer.from). Re-wrap with Buffer.from to coerce — a single
  // ~few-MB copy, negligible vs network send. Pattern matches
  // app/api/vm/desktop-thumbnail/route.ts which Buffer.from()s directly.
  return Buffer.from(Buffer.concat(chunks));
}

/**
 * Release a previously-claimed config_token by setting consumed_at back to
 * NULL. Used in failure paths AFTER the claim succeeded but BEFORE the
 * tarball was successfully delivered, so the bootstrap's curl retries can
 * succeed once the upstream defect (NULL column, tarball-builder bug) is
 * fixed.
 *
 * Best-effort: a release-write failure is logged but doesn't change the
 * caller's response. The next cron tick's cloud-init-poll will eventually
 * mark the VM `configure_failed` and trigger respawn if the bootstrap
 * never recovers, so a stuck-consumed token isn't load-bearing for
 * customer recovery.
 *
 * Important: never release on SUCCESS — that would mean the same token
 * could be replayed by an attacker who captured it. Only release when we
 * KNOW the tarball did not reach the bootstrap.
 */
async function releaseConsumedToken(
  supabase: ReturnType<typeof getSupabase>,
  vmId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("instaclaw_vms")
    .update({ cloud_init_config_consumed_at: null })
    .eq("id", vmId);
  if (error) {
    logger.error("cloud-init-config: release-consumed failed", {
      route: "vm/cloud-init-config",
      vmId,
      reason,
      error: error.message,
    });
  } else {
    logger.warn("cloud-init-config: released consumed token after delivery failure", {
      route: "vm/cloud-init-config",
      vmId,
      reason,
    });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── 1. Extract + shape-validate header ──
  const configToken = req.headers.get("X-Cloud-Init-Config-Token");
  if (!configToken || !HEX_TOKEN_RE.test(configToken)) {
    // Missing header OR malformed token shape → 401. Don't log the token
    // value (even prefix) on missing-header so log volume doesn't grow
    // under DDoS noise; log the prefix on shape mismatch so legit-but-typo
    // tokens get a forensic breadcrumb.
    if (configToken) {
      logger.warn("cloud-init-config: rejected malformed token", {
        route: "vm/cloud-init-config",
        tokenLen: configToken.length,
      });
    }
    return new NextResponse("unauthorized", { status: 401 });
  }

  // ── 2. Extract + shape-validate query params ──
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  const vmName = url.searchParams.get("vmName");
  if (!userId || !vmName) {
    return new NextResponse("missing params", { status: 400 });
  }
  if (!UUID_RE.test(userId) || !VM_NAME_RE.test(vmName)) {
    return new NextResponse("invalid params", { status: 400 });
  }

  const supabase = getSupabase();

  // ── 3. Atomic claim-and-invalidate ──
  // PostgREST UPDATE with WHERE clauses that all must match. Race-safe:
  // two concurrent requests with the same token both attempt the UPDATE;
  // exactly one finds a row matching `cloud_init_config_consumed_at IS NULL`
  // and commits its consumed_at=now(); the other sees 0 rows (PGRST116 on
  // .single()) and returns 401.
  const claimAt = new Date().toISOString();
  const { data: vmRow, error: claimErr } = await supabase
    .from("instaclaw_vms")
    .update({ cloud_init_config_consumed_at: claimAt })
    .eq("cloud_init_config_token", configToken)
    .eq("assigned_to", userId)
    .eq("name", vmName)
    .eq("status", "provisioning")
    .is("cloud_init_config_consumed_at", null)
    .select("*")
    .single();

  if (claimErr || !vmRow) {
    // Four reasons to land here, all collapse to 401:
    //   1. Wrong token (attacker without the real value)
    //   2. Token already consumed (replay / second-bootstrap-tick)
    //   3. user/vm-name mismatch (token doesn't belong to this VM)
    //   4. VM not in provisioning status (already respawned / mid-thaw)
    // Internal log captures truncated token prefix for correlation but
    // the response body stays uniform.
    logger.warn("cloud-init-config: claim failed", {
      route: "vm/cloud-init-config",
      userId,
      vmName,
      tokenPrefix: configToken.slice(0, 8),
      reasonCode: claimErr?.code ?? "no_match",
    });
    return new NextResponse("unauthorized", { status: 401 });
  }

  const vmId = (vmRow as VmRow).id as string;

  // ── 4. Build TarballParams from claimed row + env vars ──
  // buildParamsFromVmRow throws on a NULL load-bearing column (gateway_token,
  // tier, region, etc.) — those indicate the upstream createUserVM didn't
  // populate the row correctly. Release the token so retry can succeed
  // once that upstream defect is fixed.
  let params: Awaited<ReturnType<typeof buildParamsFromVmRow>>;
  try {
    params = await buildParamsFromVmRow(supabase, vmRow as VmRow);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("cloud-init-config: param construction failed", {
      route: "vm/cloud-init-config",
      vmId,
      vmName,
      error: msg,
    });
    await releaseConsumedToken(supabase, vmId, `param-construction: ${msg.slice(0, 200)}`);
    return new NextResponse("internal error", { status: 500 });
  }

  // ── 5. Build tarball, buffer it, then send ──
  // Buffering rationale: see streamToBuffer docstring. Atomic success/failure
  // matters more than memory savings on 3-5 MB tarballs.
  let body: Buffer;
  try {
    const stream = buildCloudInitTarball(params);
    body = await streamToBuffer(stream);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("cloud-init-config: tarball build failed", {
      route: "vm/cloud-init-config",
      vmId,
      vmName,
      error: msg,
    });
    await releaseConsumedToken(supabase, vmId, `tarball-build: ${msg.slice(0, 200)}`);
    return new NextResponse("tarball build failed", { status: 500 });
  }

  // ── 6. Success ──
  // Token stays consumed (never released on success). The bootstrap extracts
  // the tarball and POSTs to /api/vm/cloud-init-callback to mark the VM
  // healthy (callback owns the consumed_at side of its own callback_token).
  logger.info("cloud-init-config: tarball served", {
    route: "vm/cloud-init-config",
    vmId,
    vmName,
    bytes: body.length,
    partner: params.partner ?? null,
  });

  // NextResponse accepts Node Buffer at runtime — Buffer extends Uint8Array
  // which is a valid BodyInit/BufferSource. The TS type-narrowing complains
  // because Buffer.concat() returns the generic Buffer<ArrayBufferLike> while
  // BodyInit prefers the concrete Buffer<ArrayBuffer>. The cast is safe:
  // every code path here originates from Buffer chunks under our control
  // (no SharedArrayBuffer surface). Pattern matches what desktop-thumbnail/
  // route.ts:49 gets to skip because Buffer.from() returns the narrower
  // generic variant.
  return new NextResponse(body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(body.length),
    },
  });
}
