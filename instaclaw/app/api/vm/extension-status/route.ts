import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const maxDuration = 15;

/**
 * Check if the Chrome Extension Relay is connected on the user's VM.
 * Proxies to the relay's /extension/status endpoint via the Caddy tunnel.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("gateway_url")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm?.gateway_url) {
      return NextResponse.json({ connected: false });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(
        `https://${vm.gateway_url}/relay/extension/status`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);

      if (!res.ok) {
        return NextResponse.json({ connected: false });
      }

      const data = await res.json();
      return NextResponse.json({ connected: !!data.connected });
    } catch {
      clearTimeout(timeout);
      return NextResponse.json({ connected: false });
    }
  } catch {
    return NextResponse.json({ connected: false });
  }
}
