import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getUserVm } from "@/lib/get-user-vm";
import { logger } from "@/lib/logger";
import { freeCapForTier, utcDayStartISO, HF_MODELS } from "@/lib/higgsfield-models";
import {
  renderProvenance,
  renderLabel,
  isVideoKind,
  type RenderItem,
  type RenderMetadata,
  type VideoQuotas,
} from "@/lib/videos";

export const dynamic = "force-dynamic";
// Lazy URL hydration calls Higgsfield (≤6 bounded fetches) — generous budget.
export const maxDuration = 60;

const NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-store, no-cache, must-revalidate",
  Vary: "Cookie",
};
const HF_BASE = "https://platform.higgsfield.ai";
const PAGE_SIZE = 24;
const HYDRATE_BUDGET = 6; // bounded per request — legacy rows heal across views

/**
 * GET /api/videos — the /videos page's single fetch (stage 1).
 *
 * Returns { quotas, renders, next_cursor }:
 *   quotas  — the three pools (free daily / plan allowance / pack clips) +
 *             the seed chip. Free-count semantics MIRROR the reserve RPC's
 *             (A)+(C) fixes exactly: pending+settled only, seed-excluded —
 *             the band must show the number the gate will actually enforce.
 *   renders — the user's video-kind transactions (gallery cards): pending
 *             (the in-place job queue) + settled + last-24h failed (the
 *             honest "didn't render, not charged" card). Cursor-paginated.
 *
 * LAZY URL HYDRATION (park finding F-2): rows settled before this page
 * shipped carry no metadata.video_url. For up to HYDRATE_BUDGET such rows
 * per request, re-fetch the authoritative status from Higgsfield with the
 * cloud key and cache the URL back into metadata — legacy galleries heal
 * within a couple of views. Expired upstream assets stay null (the card
 * shows an honest "expired" state).
 *
 * Session-authed (Rule 13.2 — middleware session check first, no allow-list
 * entry). Provider slugs never leave the server: cards get registry labels.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE_HEADERS });
    }

    const supabase = getSupabase();
    const vm = await getUserVm<{
      id: string;
      tier: string | null;
      video_credit_balance: number | null;
      video_plan_status: string | null;
      video_plan_allowance_remaining: number | null;
      video_plan_period_end: string | null;
    }>(supabase, session.user.id, {
      columns:
        "id, tier, video_credit_balance, video_plan_status, video_plan_allowance_remaining, video_plan_period_end",
    });

    if (!vm) {
      const empty: { quotas: VideoQuotas; renders: RenderItem[]; next_cursor: null } = {
        quotas: {
          free: { used: 0, cap: freeCapForTier(null) },
          plan: null,
          pack_clips: 0,
          seed_available: true,
        },
        renders: [],
        next_cursor: null,
      };
      return NextResponse.json(empty, { headers: NO_CACHE_HEADERS });
    }

    // ── Quotas ──────────────────────────────────────────────────────────
    const windowStart = utcDayStartISO();
    const [freeRes, seedRes] = await Promise.all([
      supabase
        .from("instaclaw_video_transactions")
        .select("id", { count: "exact", head: true })
        .eq("vm_id", vm.id)
        .eq("is_free", true)
        .in("status", ["pending", "settled"])
        .neq("metadata->>seed", "true")
        .gte("created_at", windowStart),
      supabase
        .from("instaclaw_video_transactions")
        .select("id")
        .eq("vm_id", vm.id)
        .eq("metadata->>seed", "true")
        .in("status", ["pending", "settled"])
        .limit(1),
    ]);

    const planActive = vm.video_plan_status === "active" || vm.video_plan_status === "past_due";
    const allowance = Number(vm.video_plan_allowance_remaining ?? 0);
    const quotas: VideoQuotas = {
      free: { used: freeRes.count ?? 0, cap: freeCapForTier(vm.tier) },
      plan: planActive
        ? {
            status: vm.video_plan_status!,
            clips_remaining: Math.floor(Math.max(allowance, 0) / 13),
            resets_at: vm.video_plan_period_end,
          }
        : null,
      pack_clips: Math.floor(Number(vm.video_credit_balance ?? 0) / 13),
      seed_available: !seedRes.data || seedRes.data.length === 0,
    };

    // ── Renders (gallery) ───────────────────────────────────────────────
    const cursor = req.nextUrl.searchParams.get("cursor");
    const filter = req.nextUrl.searchParams.get("filter"); // all | premium | quick
    let q = supabase
      .from("instaclaw_video_transactions")
      .select("request_id, endpoint, status, is_free, created_at, metadata")
      .eq("vm_id", vm.id)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE + 1);
    // Image-kind renders are excluded AT THE QUERY (not just the JS filter):
    // a heavy soul-image user could otherwise fill a whole page with filtered
    // rows, emptying `visible` and halting pagination before their videos.
    for (const m of Object.values(HF_MODELS)) {
      if (m.kind === "image") q = q.neq("endpoint", m.endpoint);
    }
    // Failed rows only count within their 24h honesty window — same
    // starvation logic (a burst of old failures could fill a page).
    const dayAgoISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    q = q.or(`status.neq.failed,created_at.gte.${dayAgoISO}`);
    if (cursor) q = q.lt("created_at", cursor);
    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) {
      logger.error("videos list query failed", { route: "api/videos", error: rowsErr.message });
      return NextResponse.json({ error: "list_failed" }, { status: 500, headers: NO_CACHE_HEADERS });
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const premiumSlugs = new Set(
      Object.values(HF_MODELS).filter((m) => m.hfCostCredits >= 13).map((m) => m.endpoint),
    );
    const visible = (rows ?? []).filter((r) => {
      if (!isVideoKind(r.endpoint)) return false;
      if (r.status === "failed" && Date.parse(r.created_at) < dayAgo) return false;
      if (filter === "premium" && !premiumSlugs.has(r.endpoint)) return false;
      if (filter === "quick" && premiumSlugs.has(r.endpoint)) return false;
      return true;
    });
    const hasMore = (rows ?? []).length > PAGE_SIZE;
    const pageRows = visible.slice(0, PAGE_SIZE);

    // ── Lazy URL hydration for legacy settled rows ──────────────────────
    const cloudKey = process.env.HIGGSFIELD_CLOUD_KEY;
    let budget = HYDRATE_BUDGET;
    for (const r of pageRows) {
      const meta = (r.metadata ?? {}) as RenderMetadata;
      if (budget <= 0) break;
      if (r.status !== "settled" || meta.video_url || !meta.hf_request_id || !cloudKey) continue;
      budget--;
      try {
        const res = await fetch(`${HF_BASE}/requests/${meta.hf_request_id}/status`, {
          headers: { Authorization: `Key ${cloudKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { video?: { url?: string } };
        const url = body?.video?.url;
        if (url) {
          meta.video_url = url;
          // Cache back (best-effort merge) so the next view skips the fetch.
          await supabase
            .from("instaclaw_video_transactions")
            .update({ metadata: { ...meta, video_url: url } })
            .eq("vm_id", vm.id)
            .eq("request_id", r.request_id);
        }
      } catch {
        // expired/unreachable — the card shows its honest state
      }
    }

    const renders: RenderItem[] = pageRows.map((r) => {
      const meta = (r.metadata ?? {}) as RenderMetadata;
      return {
        request_id: r.request_id,
        status: r.status as RenderItem["status"],
        created_at: r.created_at,
        label: renderLabel(r.endpoint),
        provenance: renderProvenance(r.is_free, meta),
        prompt: typeof meta.prompt === "string" ? meta.prompt : null,
        video_url: typeof meta.video_url === "string" ? meta.video_url : null,
      };
    });

    return NextResponse.json(
      {
        quotas,
        renders,
        next_cursor: hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].created_at : null,
      },
      { headers: NO_CACHE_HEADERS },
    );
  } catch (err) {
    logger.error("videos api error", {
      route: "api/videos",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "internal" }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
