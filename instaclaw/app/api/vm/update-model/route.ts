import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { updateModel } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import { ALLOWED_MODEL_IDS as ALLOWED_MODELS } from "@/lib/model-registry";

export async function POST(req: NextRequest) {
  try {
    // Dual auth: NextAuth session OR X-Mini-App-Token (from World mini app proxy)
    const session = await auth();
    let userId = session?.user?.id;

    if (!userId) {
      const { validateMiniAppToken } = await import("@/lib/security");
      userId = await validateMiniAppToken(req) ?? undefined;
    }

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { model } = await req.json();

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("assigned_to", userId)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // --- all-inclusive (credit): model pinning, DB-only ---
    // The proxy is authoritative over the served model (it overrides
    // parsedBody.model from pinned_model), so a credit pin is a pure DB write:
    // NO SSH, NO gateway restart. We write pinned_model ONLY and NEVER
    // default_model — the reconciler (stepEnforceModelPrimary) restarts the
    // gateway on default_model drift, so writing it would interrupt the user's
    // session. "automatic" (or empty) clears the pin -> NULL = content router.
    if (vm.api_mode === "all_inclusive") {
      let pinned: string | null;
      if (!model || model === "automatic") {
        pinned = null;
      } else if (ALLOWED_MODELS.includes(model)) {
        pinned = model;
      } else {
        return NextResponse.json(
          { error: "Invalid model. Must be 'automatic' or one of: " + ALLOWED_MODELS.join(", ") },
          { status: 400 }
        );
      }
      const { error: pinErr } = await supabase
        .from("instaclaw_vms")
        .update({ pinned_model: pinned })
        .eq("id", vm.id);
      if (pinErr) {
        return NextResponse.json({ error: "Failed to save model choice" }, { status: 500 });
      }
      return NextResponse.json({ updated: true, mode: "credit", pinned_model: pinned });
    }

    // --- BYOK / direct-provider: the on-disk primary IS the served model ---
    // No router in this path (the proxy 403s non-all-inclusive), so the pick
    // sticks only if we write it to the gateway's config over SSH.
    if (!model || !ALLOWED_MODELS.includes(model)) {
      return NextResponse.json(
        { error: "Invalid model. Must be one of: " + ALLOWED_MODELS.join(", ") },
        { status: 400 }
      );
    }

    const success = await updateModel(vm, model);
    if (!success) {
      return NextResponse.json(
        { error: "Failed to update model on VM" },
        { status: 500 }
      );
    }

    await supabase
      .from("instaclaw_vms")
      .update({ default_model: model })
      .eq("id", vm.id);

    return NextResponse.json({ updated: true, mode: "byok" });
  } catch (err) {
    logger.error("Update model error", { error: String(err), route: "vm/update-model" });
    return NextResponse.json(
      { error: "Failed to update model" },
      { status: 500 }
    );
  }
}
