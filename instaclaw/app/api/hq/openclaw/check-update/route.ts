import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { OPENCLAW_PINNED_VERSION } from "@/lib/ssh";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const current = OPENCLAW_PINNED_VERSION;

    // Fetch latest version from npm registry (no shell needed, works on Vercel)
    const res = await fetch("https://registry.npmjs.org/openclaw/latest", {
      headers: { Accept: "application/json" },
      next: { revalidate: 0 },
    });
    if (!res.ok) {
      throw new Error(`npm registry returned ${res.status}`);
    }
    const pkg = await res.json();
    const latest = pkg.version as string;

    return NextResponse.json({
      current,
      latest,
      updateAvailable: current !== latest,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to check: ${String(err)}` },
      { status: 500 },
    );
  }
}
