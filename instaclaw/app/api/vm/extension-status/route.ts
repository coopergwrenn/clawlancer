import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/lib/auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Possible `status` values returned to clients:
//   "no_vm"        — caller has no assigned VM
//   "unavailable"  — relay backend is not reachable on the VM (e.g. 5xx from
//                    the gateway). Treat as service-side maintenance, not user
//                    error. Render a "temporarily unavailable" state.
//   "connected"    — extension is connected and live
//   "disconnected" — relay backend is reachable but no extension connected yet
type ExtensionStatus = "no_vm" | "unavailable" | "connected" | "disconnected";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("gateway_url")
      .eq("assigned_user_id", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm?.gateway_url) {
      return NextResponse.json({
        connected: false,
        available: false,
        status: "no_vm" as ExtensionStatus,
      });
    }

    const gwUrl = vm.gateway_url.replace(/\/+$/, "");
    const res = await fetch(`${gwUrl}/relay/extension/status`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      // Upstream returned non-2xx (e.g. 502 when the relay backend isn't
      // running on the VM). Surface as service-side unavailable so the UI
      // can render a clearer state than "not connected".
      return NextResponse.json({
        connected: false,
        available: false,
        status: "unavailable" as ExtensionStatus,
        upstreamStatus: res.status,
      });
    }

    const data = await res.json().catch(() => ({}));
    const connected = !!data.connected;
    return NextResponse.json({
      connected,
      available: true,
      status: (connected ? "connected" : "disconnected") as ExtensionStatus,
    });
  } catch {
    // Network error reaching upstream — treat as unavailable.
    return NextResponse.json({
      connected: false,
      available: false,
      status: "unavailable" as ExtensionStatus,
    });
  }
}
