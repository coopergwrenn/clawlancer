import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { encryptApiKey, decryptApiKey } from "@/lib/security";
import { updateEnvVars } from "@/lib/ssh";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const MAX_VARS_PER_USER = 50;
const MAX_VALUE_LENGTH = 500;

// GET — list env vars (names + masked values, no plaintext)
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vars } = await supabase
      .from("instaclaw_env_vars")
      .select("id, var_name, description, created_at, updated_at, encrypted_value")
      .eq("user_id", session.user.id)
      .order("var_name");

    // Mask values: show first 4 chars + dots
    const masked = (vars ?? []).map((v) => {
      let preview = "";
      try {
        // We don't decrypt for the list — just show a generic mask
        preview = v.encrypted_value ? "••••••••" : "";
      } catch {
        preview = "••••••••";
      }
      return {
        id: v.id,
        name: v.var_name,
        maskedValue: preview,
        description: v.description,
        createdAt: v.created_at,
        updatedAt: v.updated_at,
      };
    });

    return NextResponse.json({ vars: masked });
  } catch (err) {
    logger.error("Env vars list error", { error: String(err), route: "bot/env-vars" });
    return NextResponse.json(
      { error: "Failed to list environment variables" },
      { status: 500 }
    );
  }
}

// POST — add a new env var
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, value, description } = await req.json();

    // Validate name
    if (!name || typeof name !== "string" || !VAR_NAME_RE.test(name)) {
      return NextResponse.json(
        { error: "Variable name must be uppercase letters, digits, and underscores only (e.g. MY_API_KEY)" },
        { status: 400 }
      );
    }

    // Validate value
    if (!value || typeof value !== "string") {
      return NextResponse.json(
        { error: "Value is required" },
        { status: 400 }
      );
    }

    if (value.length > MAX_VALUE_LENGTH) {
      return NextResponse.json(
        { error: `Value must be ${MAX_VALUE_LENGTH} characters or less` },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    // Check var count limit
    const { count } = await supabase
      .from("instaclaw_env_vars")
      .select("*", { count: "exact", head: true })
      .eq("user_id", session.user.id);

    if ((count ?? 0) >= MAX_VARS_PER_USER) {
      return NextResponse.json(
        { error: `Maximum ${MAX_VARS_PER_USER} environment variables per user` },
        { status: 400 }
      );
    }

    // Encrypt value
    const encrypted = await encryptApiKey(value);

    // Insert
    const { error } = await supabase.from("instaclaw_env_vars").insert({
      user_id: session.user.id,
      var_name: name,
      encrypted_value: encrypted,
      description: description || null,
    });

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: `Variable ${name} already exists. Use PUT to update.` },
          { status: 409 }
        );
      }
      throw error;
    }

    // Audit log
    await supabase.from("instaclaw_env_var_audit").insert({
      user_id: session.user.id,
      var_name: name,
      action: "create",
    });

    // Sync to VM
    await syncEnvVarsToVM(session.user.id, supabase);

    return NextResponse.json({ created: true, name });
  } catch (err) {
    logger.error("Env var create error", { error: String(err), route: "bot/env-vars" });
    return NextResponse.json(
      { error: "Failed to create environment variable" },
      { status: 500 }
    );
  }
}

// PUT — update an existing env var
export async function PUT(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, value, description } = await req.json();

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const supabase = getSupabase();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {};

    if (value !== undefined) {
      if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) {
        return NextResponse.json(
          { error: `Value must be a string of ${MAX_VALUE_LENGTH} characters or less` },
          { status: 400 }
        );
      }
      updates.encrypted_value = await encryptApiKey(value);
    }

    if (description !== undefined) {
      updates.description = description || null;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const { error } = await supabase
      .from("instaclaw_env_vars")
      .update(updates)
      .eq("user_id", session.user.id)
      .eq("var_name", name);

    if (error) throw error;

    // Audit log
    await supabase.from("instaclaw_env_var_audit").insert({
      user_id: session.user.id,
      var_name: name,
      action: "update",
    });

    // Sync to VM
    await syncEnvVarsToVM(session.user.id, supabase);

    return NextResponse.json({ updated: true });
  } catch (err) {
    logger.error("Env var update error", { error: String(err), route: "bot/env-vars" });
    return NextResponse.json(
      { error: "Failed to update environment variable" },
      { status: 500 }
    );
  }
}

// DELETE — remove an env var
export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name } = await req.json();

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const supabase = getSupabase();

    const { error } = await supabase
      .from("instaclaw_env_vars")
      .delete()
      .eq("user_id", session.user.id)
      .eq("var_name", name);

    if (error) throw error;

    // Audit log
    await supabase.from("instaclaw_env_var_audit").insert({
      user_id: session.user.id,
      var_name: name,
      action: "delete",
    });

    // Sync to VM (will regenerate .env without this var)
    await syncEnvVarsToVM(session.user.id, supabase);

    // Also remove from VM directly
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (vm) {
      const { removeEnvVar } = await import("@/lib/ssh");
      await removeEnvVar(vm, name);
    }

    return NextResponse.json({ deleted: true });
  } catch (err) {
    logger.error("Env var delete error", { error: String(err), route: "bot/env-vars" });
    return NextResponse.json(
      { error: "Failed to delete environment variable" },
      { status: 500 }
    );
  }
}

// Helper: sync all env vars to the user's VM
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncEnvVarsToVM(userId: string, supabase: any) {
  try {
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", userId)
      .single();

    if (!vm) return;

    const { data: vars } = await supabase
      .from("instaclaw_env_vars")
      .select("var_name, encrypted_value")
      .eq("user_id", userId);

    if (!vars?.length) return;

    // Decrypt all values
    const decrypted = await Promise.all(
      vars.map(async (v: { var_name: string; encrypted_value: string }) => ({
        name: v.var_name,
        value: await decryptApiKey(v.encrypted_value),
      }))
    );

    await updateEnvVars(vm, decrypted);
  } catch (err) {
    logger.error("Failed to sync env vars to VM", { error: String(err), route: "bot/env-vars", userId });
  }
}
