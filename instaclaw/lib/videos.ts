/**
 * /videos page data layer — provenance mapping + quota semantics.
 *
 * Stage 1 of the videos-page design (parked + green-lit 2026-06-12).
 * Pure functions here, I/O in app/api/videos/route.ts — testable without a
 * session (Rule 31).
 */

import { HF_MODELS } from "@/lib/higgsfield-models";

/** A render row's display provenance — shown as a chip on the gallery card.
 *  Post-plan, a per-render "cost" number is ambiguous (plan? pack? free?
 *  seed?) — provenance chips are truer than a number (design divergence from
 *  the rail PRD's "cost per job", reasoned in the park). */
export type RenderProvenance = "seed" | "free" | "plan" | "pack";

export interface RenderMetadata {
  seed?: boolean;
  plan_used?: number;
  balance_used?: number;
  prompt?: string;
  video_url?: string;
  hf_request_id?: string;
  [k: string]: unknown;
}

export function renderProvenance(isFree: boolean, metadata: RenderMetadata | null): RenderProvenance {
  if (metadata?.seed === true) return "seed";
  if (isFree) return "free";
  if (Number(metadata?.plan_used ?? 0) > 0) return "plan";
  return "pack";
}

/** Registry label for a slug — NEVER the slug itself (provider names stay
 *  backstage). Unknown slugs (delisted models on old rows) get a neutral
 *  label rather than leaking the endpoint string. */
export function renderLabel(endpoint: string): string {
  return HF_MODELS[endpoint]?.label ?? "Clip";
}

/** Video-kind filter: the page is /videos — image renders are excluded in
 *  v1 (the soul source frames are pipeline intermediates; standalone images
 *  are a fast-follow toggle). */
export function isVideoKind(endpoint: string): boolean {
  const kind = HF_MODELS[endpoint]?.kind;
  if (kind) return kind === "image2video" || kind === "text2video";
  // Unknown/delisted slug: include unless it's the known image model shape.
  return !/soul/.test(endpoint);
}

/** The gallery card + lightbox shape the API returns. */
export interface RenderItem {
  request_id: string;
  status: "pending" | "settled" | "failed";
  created_at: string;
  label: string;
  provenance: RenderProvenance;
  prompt: string | null;
  video_url: string | null;
}

/** Quota band shape — the three pools + the seed chip, one fetch. */
export interface VideoQuotas {
  free: { used: number; cap: number };
  plan: { status: string; clips_remaining: number; resets_at: string | null } | null;
  pack_clips: number;
  seed_available: boolean;
}
