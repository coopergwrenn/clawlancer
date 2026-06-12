/**
 * POST /api/admin/backfill-video-prompts — one-shot legacy prompt backfill
 * (2026-06-12 audit fix 1).
 *
 * Every video row rendered before the F-1 prompt-persistence fix (gate commit
 * ae3c62d6) has no metadata.prompt — making the real library invisible to
 * /videos prompt-search and the prompt overlay/lightbox quote. IF Higgsfield's
 * status endpoint echoes the submitted prompt, this route recovers it through
 * the same authenticated path the URL-hydration already uses.
 *
 * Auth: X-Admin-Key (same as the other interactive admin ops). Runs in the
 * deployed app on purpose: HIGGSFIELD_CLOUD_KEY is Vercel-only (Sensitive).
 *
 * Body:
 *   { probe: true }                  → fetch ONE completed render's status and
 *                                      return its shape (top-level keys + every
 *                                      prompt-bearing field found recursively).
 *                                      No writes. Run this FIRST.
 *   { dryRun?: boolean, limit?: n }  → backfill all rows missing prompts that
 *                                      have an hf_request_id. dryRun reports
 *                                      what WOULD be written. Idempotent: rows
 *                                      that already have a prompt are skipped
 *                                      by the query itself.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // up to ~40 sequential HF status fetches

const HF_BASE = "https://platform.higgsfield.ai";

/** Recursively find every string field whose key contains "prompt". */
function findPromptFields(node: unknown, path = "", out: { path: string; value: string }[] = []) {
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (/prompt/i.test(k) && typeof v === "string" && v.trim()) {
      out.push({ path: p, value: v });
    }
    if (v && typeof v === "object") findPromptFields(v, p, out);
  }
  return out;
}

export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cloudKey = process.env.HIGGSFIELD_CLOUD_KEY;
  if (!cloudKey) {
    return NextResponse.json({ error: "HIGGSFIELD_CLOUD_KEY not configured" }, { status: 500 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    probe?: boolean;
    dryRun?: boolean;
    limit?: number;
  };
  const supabase = getSupabase();

  // Rows missing a prompt but carrying the HF request id we can ask about.
  const { data: rows, error } = await supabase
    .from("instaclaw_video_transactions")
    .select("request_id, vm_id, status, metadata")
    .is("metadata->>prompt", null)
    .not("metadata->>hf_request_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(Math.min(body.limit ?? 100, 200));
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!rows?.length) {
    return NextResponse.json({ message: "no rows missing prompts", candidates: 0 });
  }

  async function fetchStatus(hfRequestId: string) {
    const res = await fetch(`${HF_BASE}/requests/${hfRequestId}/status`, {
      headers: { Authorization: `Key ${cloudKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false as const, status: res.status };
    return { ok: true as const, body: (await res.json()) as unknown };
  }

  // ── PROBE: one settled row, full shape disclosure, zero writes ──────────
  if (body.probe) {
    const sample = rows.find((r) => r.status === "settled") ?? rows[0];
    const hfId = (sample.metadata as Record<string, unknown>)?.hf_request_id as string;
    const res = await fetchStatus(hfId);
    if (!res.ok) {
      return NextResponse.json({ probe: "fetch_failed", http: res.status, request_id: sample.request_id });
    }
    const prompts = findPromptFields(res.body);
    return NextResponse.json({
      probe: "ok",
      request_id: sample.request_id,
      top_level_keys: Object.keys(res.body as Record<string, unknown>),
      prompt_fields: prompts.map((p) => ({ path: p.path, preview: p.value.slice(0, 80) })),
      echoes_prompt: prompts.length > 0,
    });
  }

  // ── BACKFILL: sequential (rate-friendly), idempotent, best-effort ──────
  let written = 0;
  let noPromptInResponse = 0;
  let fetchFailed = 0;
  const samples: { request_id: string; prompt: string }[] = [];
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const hfId = meta.hf_request_id as string;
    const res = await fetchStatus(hfId);
    if (!res.ok) { fetchFailed++; continue; }
    const prompts = findPromptFields(res.body);
    if (!prompts.length) { noPromptInResponse++; continue; }
    const prompt = prompts[0].value.slice(0, 2000);
    if (samples.length < 5) samples.push({ request_id: r.request_id, prompt: prompt.slice(0, 60) });
    if (!body.dryRun) {
      const { error: upErr } = await supabase
        .from("instaclaw_video_transactions")
        .update({ metadata: { ...meta, prompt } })
        .eq("vm_id", r.vm_id)
        .eq("request_id", r.request_id);
      if (upErr) { fetchFailed++; continue; }
    }
    written++;
  }
  logger.info("video prompt backfill run", {
    route: "admin/backfill-video-prompts",
    candidates: rows.length, written, noPromptInResponse, fetchFailed, dryRun: !!body.dryRun,
  });
  return NextResponse.json({
    candidates: rows.length,
    written,
    no_prompt_in_response: noPromptInResponse,
    fetch_failed: fetchFailed,
    dry_run: !!body.dryRun,
    samples,
  });
}
