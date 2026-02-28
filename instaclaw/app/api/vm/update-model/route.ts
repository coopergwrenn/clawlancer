import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { updateModel } from "@/lib/ssh";
import { logger } from "@/lib/logger";

const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20250820",
  "claude-opus-4-6",
];

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { model } = await req.json();

    if (!model || !ALLOWED_MODELS.includes(model)) {
      return NextResponse.json(
        { error: "Invalid model. Must be one of: " + ALLOWED_MODELS.join(", ") },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // SSH into VM and update model config
    const success = await updateModel(vm, model);

    if (!success) {
      return NextResponse.json(
        { error: "Failed to update model on VM" },
        { status: 500 }
      );
    }

    // Update DB record
    await supabase
      .from("instaclaw_vms")
      .update({ default_model: model })
      .eq("id", vm.id);

    return NextResponse.json({ updated: true });
  } catch (err) {
    logger.error("Update model error", { error: String(err), route: "vm/update-model" });
    return NextResponse.json(
      { error: "Failed to update model" },
      { status: 500 }
    );
  }
}
