/**
 * /api/agent-economy/offerings
 *
 *   GET  — list the caller's offerings (active + paused).
 *   POST — create or update an offering (upsert on (vm_id, slug)).
 *
 * Dual-auth: an offering belongs to a VM, and that VM is reachable two ways —
 * the agent itself (frontier.add_offering, gateway token) and the human via the
 * dashboard (session). resolveVm() accepts either and scopes everything to the
 * one resolved vmId, so neither actor can touch another VM's offerings.
 *
 * Security — two fields cross a trust boundary onto the VM:
 *   - `slug` becomes a path segment on the per-VM x402 server (POST /v1/<slug>),
 *     so it's restricted to ^[a-z0-9][a-z0-9-]{0,63}$.
 *   - `handler_path` is the script the x402 server exec's to fulfil a paid
 *     request. An arbitrary path here is remote code/file execution on the VM.
 *     We allow-list it to a handlers/ directory with a safe filename + extension
 *     and reject "..". THIS IS DEFENSE IN DEPTH ONLY — the x402 server MUST
 *     re-validate handler_path against the same allow-list before exec and never
 *     trust the stored value blindly.
 *
 * embedding is intentionally left NULL on write. It's only consumed by commerce
 * matching (not yet built); generating it needs an OpenAI/Voyage call we won't
 * bolt onto creation before there's a consumer. A later backfill / the matching
 * extension populates it. The hnsw index excludes NULL embeddings, so this is safe.
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.1.1, §9.2, §10.1
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_SLUG = 64;
const MAX_DESCRIPTION = 2000;
const MAX_HANDLER_PATH = 200;
const MAX_PRICE = 99_999_999; // numeric(14,6) integer-part guard
const MAX_METADATA_BYTES = 8_000;
const MAX_OFFERINGS_PER_VM = 50; // anti-spam ceiling on active offerings
const LIST_LIMIT = 100;

const CATEGORIES = ["service", "compute"] as const;
const PRICE_UNITS = ["flat", "cpu_min", "page", "1k_embeddings", "frame", "image"] as const;
type Category = (typeof CATEGORIES)[number];
type PriceUnit = (typeof PRICE_UNITS)[number];

// slug: lowercase, url-safe, leads with alphanumeric. Used in the x402 path.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// handler_path: must live under a handlers/ dir, safe filename, known extension.
const HANDLER_RE =
  /^~\/(?:\.openclaw\/skills\/[a-z0-9_-]+\/scripts\/handlers|scripts\/handlers)\/[a-z0-9_-]+\.(?:py|ts|mjs|sh)$/;

function extractGatewayToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const xGate = req.headers.get("x-gateway-token");
  if (xGate?.trim()) return xGate.trim();
  return null;
}

function jsonBytes(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v), "utf8");
  } catch {
    return Infinity;
  }
}

type VmResolution = { vmId: string } | { error: string; status: number };

/** Resolve the acting VM from either a gateway token (agent) or a session (human). */
async function resolveVm(req: NextRequest): Promise<VmResolution> {
  const token = extractGatewayToken(req);
  if (token) {
    const vm = await lookupVMByGatewayToken(token, "id, assigned_to");
    if (!vm) return { error: "Invalid gateway token", status: 401 };
    if (!vm.assigned_to) return { error: "VM has no assigned user", status: 409 };
    return { vmId: vm.id as string };
  }
  const session = await auth();
  if (!session?.user?.id) return { error: "Unauthorized", status: 401 };
  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", session.user.id)
    .single();
  if (!vm) return { error: "No VM assigned", status: 404 };
  return { vmId: vm.id as string };
}

export async function GET(req: NextRequest) {
  const r = await resolveVm(req);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("frontier_offerings")
    .select("id, slug, category, description, price_usdc, price_unit, handler_path, active, created_at, updated_at")
    .eq("vm_id", r.vmId)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);

  if (error) {
    console.error("[/api/agent-economy/offerings GET] fetch failed:", error);
    return NextResponse.json({ error: "failed to list offerings" }, { status: 500 });
  }
  return NextResponse.json({ offerings: data ?? [] });
}

interface CleanOffering {
  slug: string;
  category: Category;
  description: string;
  price_usdc: number;
  price_unit: PriceUnit;
  handler_path: string;
  active: boolean;
  metadata: Record<string, unknown>;
}

function validateBody(raw: unknown): CleanOffering | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.slug !== "string" || !SLUG_RE.test(b.slug)) {
    return { error: "slug must match ^[a-z0-9][a-z0-9-]{0,63}$" };
  }
  const slug = b.slug;

  if (typeof b.description !== "string" || !b.description.trim()) {
    return { error: "description must be a non-empty string" };
  }
  const description = b.description.trim().slice(0, MAX_DESCRIPTION);

  if (typeof b.price_usdc !== "number" || !Number.isFinite(b.price_usdc) || b.price_usdc <= 0) {
    return { error: "price_usdc must be a positive finite number" };
  }
  if (b.price_usdc > MAX_PRICE) {
    return { error: `price_usdc exceeds ${MAX_PRICE}` };
  }
  const price_usdc = b.price_usdc;

  if (typeof b.handler_path !== "string" || b.handler_path.length > MAX_HANDLER_PATH || b.handler_path.includes("..") || !HANDLER_RE.test(b.handler_path)) {
    return {
      error: "handler_path must be a safe path under a frontier/ or scripts/ handlers directory (no '..', extension .py/.ts/.mjs/.sh)",
    };
  }
  const handler_path = b.handler_path;

  let category: Category = "service";
  if (b.category !== undefined && b.category !== null) {
    if (!CATEGORIES.includes(b.category as Category)) {
      return { error: `category must be one of ${CATEGORIES.join(", ")}` };
    }
    category = b.category as Category;
  }

  let price_unit: PriceUnit = "flat";
  if (b.price_unit !== undefined && b.price_unit !== null) {
    if (!PRICE_UNITS.includes(b.price_unit as PriceUnit)) {
      return { error: `price_unit must be one of ${PRICE_UNITS.join(", ")}` };
    }
    price_unit = b.price_unit as PriceUnit;
  }

  let active = true;
  if (b.active !== undefined && b.active !== null) {
    if (typeof b.active !== "boolean") return { error: "active must be a boolean" };
    active = b.active;
  }

  let metadata: Record<string, unknown> = {};
  if (b.metadata !== undefined && b.metadata !== null) {
    if (typeof b.metadata !== "object" || Array.isArray(b.metadata)) {
      return { error: "metadata must be a JSON object" };
    }
    if (jsonBytes(b.metadata) > MAX_METADATA_BYTES) {
      return { error: `metadata exceeds ${MAX_METADATA_BYTES} bytes` };
    }
    metadata = b.metadata as Record<string, unknown>;
  }

  return { slug, category, description, price_usdc, price_unit, handler_path, active, metadata };
}

export async function POST(req: NextRequest) {
  const r = await resolveVm(req);
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
  const vmId = r.vmId;

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const validated = validateBody(bodyJson);
  if ("error" in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const o = validated;

  const supabase = getSupabase();

  // Anti-spam: cap NEW active offerings. An update to an existing slug is always
  // allowed (no net new row). Only a brand-new slug is gated by the ceiling.
  const { data: existing } = await supabase
    .from("frontier_offerings")
    .select("id")
    .eq("vm_id", vmId)
    .eq("slug", o.slug)
    .maybeSingle();

  if (!existing && o.active) {
    const { count } = await supabase
      .from("frontier_offerings")
      .select("id", { count: "exact", head: true })
      .eq("vm_id", vmId)
      .eq("active", true);
    if ((count ?? 0) >= MAX_OFFERINGS_PER_VM) {
      return NextResponse.json(
        { error: `active offering limit reached (${MAX_OFFERINGS_PER_VM})` },
        { status: 429 },
      );
    }
  }

  // Upsert on (vm_id, slug): create, or update + reactivate a paused slug.
  // embedding deliberately omitted → stays NULL (or unchanged on update).
  const { data: upserted, error: upsertErr } = await supabase
    .from("frontier_offerings")
    .upsert(
      {
        vm_id: vmId,
        slug: o.slug,
        category: o.category,
        description: o.description,
        price_usdc: o.price_usdc,
        price_unit: o.price_unit,
        handler_path: o.handler_path,
        active: o.active,
        metadata: o.metadata,
      },
      { onConflict: "vm_id,slug" },
    )
    .select("id")
    .single();

  if (upsertErr || !upserted) {
    console.error("[/api/agent-economy/offerings POST] upsert failed:", upsertErr);
    return NextResponse.json({ error: "failed to save offering" }, { status: 500 });
  }

  return NextResponse.json(
    { ok: true, offering_id: upserted.id, created: !existing },
    { status: existing ? 200 : 201 },
  );
}
