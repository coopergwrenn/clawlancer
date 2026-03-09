import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface Dep {
  id: string;
  name: string;
  check_type: string;
  check_target: string | null;
  our_version: string | null;
}

function stripV(v: string): string {
  return v.replace(/^v/, "");
}

async function checkOne(dep: Dep): Promise<{ latest: string | null; status: string; error?: string }> {
  try {
    switch (dep.check_type) {
      case "github_release": {
        const res = await fetch(`https://api.github.com/repos/${dep.check_target}/releases/latest`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "instaclaw-hq" },
        });
        if (!res.ok) return { latest: null, status: "anomaly", error: `GitHub ${res.status}` };
        const data = await res.json();
        const latest = stripV(data.tag_name);
        const behind = dep.our_version ? latest !== dep.our_version : false;
        return { latest, status: behind ? "behind" : "current" };
      }
      case "npm": {
        const res = await fetch(`https://registry.npmjs.org/${dep.check_target}/latest`);
        if (!res.ok) return { latest: null, status: "anomaly", error: `npm ${res.status}` };
        const data = await res.json();
        const latest = data.version;
        const behind = dep.our_version ? latest !== dep.our_version : false;
        return { latest, status: behind ? "behind" : "current" };
      }
      case "pypi": {
        const res = await fetch(`https://pypi.org/pypi/${dep.check_target}/json`);
        if (!res.ok) return { latest: null, status: "anomaly", error: `PyPI ${res.status}` };
        const data = await res.json();
        const latest = data.info.version;
        const behind = dep.our_version ? latest !== dep.our_version : false;
        return { latest, status: behind ? "behind" : "current" };
      }
      case "http_health": {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(dep.check_target!, { signal: controller.signal, method: "GET" });
          clearTimeout(timeout);
          return { latest: null, status: res.ok ? "current" : "anomaly" };
        } catch {
          clearTimeout(timeout);
          return { latest: null, status: "anomaly", error: "Health check failed/timeout" };
        }
      }
      case "manual":
        return { latest: null, status: "manual" };
      default:
        return { latest: null, status: "unknown" };
    }
  } catch (err) {
    return { latest: null, status: "anomaly", error: String(err) };
  }
}

// GET — list all dependencies
export async function GET() {
  const authed = await verifyHQAuth();
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("instaclaw_dependencies")
    .select("*")
    .order("category")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ dependencies: data });
}

// POST — check one or all dependencies
export async function POST(req: Request) {
  const authed = await verifyHQAuth();
  if (!authed) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const checkAll = body.all === true;
  const singleId = body.id as string | undefined;

  let deps: Dep[];
  if (checkAll) {
    const { data } = await supabase
      .from("instaclaw_dependencies")
      .select("id, name, check_type, check_target, our_version")
      .neq("check_type", "manual");
    deps = data || [];
  } else if (singleId) {
    const { data } = await supabase
      .from("instaclaw_dependencies")
      .select("id, name, check_type, check_target, our_version")
      .eq("id", singleId)
      .single();
    deps = data ? [data] : [];
  } else {
    return NextResponse.json({ error: "Provide { id } or { all: true }" }, { status: 400 });
  }

  let checked = 0;
  let behind = 0;
  let anomalies = 0;
  const errors: { name: string; error: string }[] = [];

  for (const dep of deps) {
    const result = await checkOne(dep);
    checked++;

    const isBehind = result.status === "behind";
    if (isBehind) behind++;
    if (result.status === "anomaly") anomalies++;
    if (result.error) errors.push({ name: dep.name, error: result.error });

    await supabase
      .from("instaclaw_dependencies")
      .update({
        latest_version: result.latest,
        is_behind: isBehind,
        status: result.status,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", dep.id);

    // Rate-limit when checking all
    if (checkAll && deps.indexOf(dep) < deps.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return NextResponse.json({ checked, behind, anomalies, errors });
}
