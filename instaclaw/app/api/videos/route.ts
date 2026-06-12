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
      const empty: { quotas: VideoQuotas; renders: RenderItem[]; months: never[]; unsearchable_count: number; next_cursor: null } = {
        quotas: {
          free: { used: 0, cap: freeCapForTier(null) },
          plan: null,
          pack_clips: 0,
          seed_available: true,
        },
        renders: [],
        months: [],
        unsearchable_count: 0,
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
    const search = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
    const monthParam = req.nextUrl.searchParams.get("month"); // YYYY-MM

    // Filters are SERVER-SIDE (scale redesign): a "Premium" page of 24 mixed
    // rows used to come back part-empty because the filter ran in JS after
    // the fetch. In-query filters give full pages + true pagination, and they
    // compose with search + month-jump as plain params.
    const videoModels = Object.values(HF_MODELS).filter((m) => m.kind !== "image");
    const premiumEndpoints = videoModels.filter((m) => m.hfCostCredits >= 13).map((m) => m.endpoint);
    const quickEndpoints = videoModels.filter((m) => m.hfCostCredits < 13).map((m) => m.endpoint);

    const dayAgoISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    /** The shared WHERE for both the page query and the months index — the
     *  jump-menu counts must match what the gallery actually shows.
     *  (supabase-js builder generics are hostile to pass-through helpers;
     *  `any` in, same builder out.) */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyBaseWhere = (query: any) => {
      let out = query.eq("vm_id", vm.id);
      // Image-kind renders excluded AT THE QUERY (pagination-starvation guard).
      for (const m of Object.values(HF_MODELS)) {
        if (m.kind === "image") out = out.neq("endpoint", m.endpoint);
      }
      // Failed rows only within their 24h honesty window (same starvation logic).
      out = out.or(`status.neq.failed,created_at.gte.${dayAgoISO}`);
      return out;
    };

    let q = applyBaseWhere(
      supabase
        .from("instaclaw_video_transactions")
        .select("request_id, endpoint, status, is_free, created_at, metadata"),
    )
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE + 1);
    if (filter === "premium") q = q.in("endpoint", premiumEndpoints);
    if (filter === "quick") q = q.in("endpoint", quickEndpoints);
    if (search) {
      // Word-AND semantics (launch-readiness pass): "wolf tundra" should match
      // a prompt containing both words anywhere, not the contiguous substring.
      // Each word is its own ilike (PostgREST ANDs chained filters); LIKE
      // wildcards in user input are escaped per word. Capped at 6 words.
      const words = search.split(/\s+/).filter(Boolean).slice(0, 6);
      for (const w of words) {
        q = q.ilike("metadata->>prompt", `%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      }
    }
    if (monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
      const [yy, mm] = monthParam.split("-").map(Number);
      const start = new Date(Date.UTC(yy, mm - 1, 1)).toISOString();
      const end = new Date(Date.UTC(yy, mm, 1)).toISOString();
      q = q.gte("created_at", start).lt("created_at", end);
    }
    if (cursor) q = q.lt("created_at", cursor);
    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) {
      logger.error("videos list query failed", { route: "api/videos", error: rowsErr.message });
      return NextResponse.json({ error: "list_failed" }, { status: 500, headers: NO_CACHE_HEADERS });
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    type Row = { request_id: string; endpoint: string; status: string; is_free: boolean; created_at: string; metadata: RenderMetadata | null };
    // Defense-in-depth re-check (delisted slugs etc.) — the query already did
    // the heavy lifting, so this almost never drops anything.
    const visible = ((rows ?? []) as Row[]).filter((r) => {
      if (!isVideoKind(r.endpoint)) return false;
      if (r.status === "failed" && Date.parse(r.created_at) < dayAgo) return false;
      return true;
    });
    const hasMore = (rows ?? []).length > PAGE_SIZE;
    const pageRows = visible.slice(0, PAGE_SIZE);

    // ── Months index (the jump menu's map of the library) ──────────────
    // One timestamps-only query with the SAME base WHERE as the gallery, so
    // counts match what the user sees under "All time". Unfiltered by
    // filter/q/month on purpose — it's a navigation map of the LIBRARY, not
    // of the current view. Bounded at 5000 rows (timestamps only, ~150KB
    // worst case; the design ceiling is 1000 videos).
    const [{ data: stamps }, unsearchableRes] = await Promise.all([
      applyBaseWhere(supabase.from("instaclaw_video_transactions").select("created_at"))
        .order("created_at", { ascending: false })
        .range(0, 4999),
      // Rows with no stored prompt are invisible to search (pre-2026-06-12
      // renders; transcripts compacted — see the legacy-prompt closure doc).
      // The count lets the empty-search state say so instead of looking broken
      // while a matching clip sits on screen.
      applyBaseWhere(
        supabase
          .from("instaclaw_video_transactions")
          .select("request_id", { count: "exact", head: true }),
      ).is("metadata->>prompt", null),
    ]);
    const unsearchableCount = unsearchableRes.count ?? 0;
    const monthMap = new Map<string, number>();
    for (const s of stamps ?? []) {
      const d = new Date(s.created_at);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      monthMap.set(key, (monthMap.get(key) ?? 0) + 1);
    }
    const months = [...monthMap.entries()].map(([key, count]) => {
      const [yy, mm] = key.split("-").map(Number);
      return {
        key,
        label: new Date(Date.UTC(yy, mm - 1, 1)).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }),
        count,
      };
    });

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
        const body = (await res.json()) as { video?: { url?: string }; prompt?: string };
        const url = body?.video?.url;
        // Opportunistic prompt pickup (2026-06-12 audit): legacy rows predate
        // the gate's prompt persistence; when HF's status echoes the submitted
        // prompt, heal it alongside the URL. No-op when absent.
        const echoedPrompt =
          typeof meta.prompt !== "string" && typeof body?.prompt === "string" && body.prompt.trim()
            ? body.prompt.slice(0, 2000)
            : null;
        if (url || echoedPrompt) {
          if (url) meta.video_url = url;
          if (echoedPrompt) meta.prompt = echoedPrompt;
          // Cache back (best-effort merge) so the next view skips the fetch.
          await supabase
            .from("instaclaw_video_transactions")
            .update({ metadata: { ...meta } })
            .eq("vm_id", vm.id)
            .eq("request_id", r.request_id);
        }
      } catch {
        // expired/unreachable — the card shows its honest state
      }
    }

    const renders: RenderItem[] = pageRows.map((r: Row) => {
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
        months,
        unsearchable_count: unsearchableCount,
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
