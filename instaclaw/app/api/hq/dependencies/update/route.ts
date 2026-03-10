import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const REPO = "coopergwrenn/clawlancer";

interface Dep {
  id: string;
  name: string;
  category: string;
  check_type: string;
  check_target: string | null;
  latest_version: string | null;
  status: string;
}

export async function POST(req: Request) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const singleId = body.id as string | undefined;
  const batchIds = body.ids as string[] | undefined;
  const manualVersion = body.new_version as string | undefined;
  const manualNotes = body.notes as string | undefined;

  // Collect dep IDs
  const ids = batchIds || (singleId ? [singleId] : []);
  if (ids.length === 0) {
    return NextResponse.json({ error: "Provide { id } or { ids }" }, { status: 400 });
  }

  // Fetch dep records
  const { data: deps, error } = await supabase
    .from("instaclaw_dependencies")
    .select("id, name, category, check_type, check_target, latest_version, status")
    .in("id", ids);

  if (error || !deps || deps.length === 0) {
    return NextResponse.json({ error: "Dependencies not found" }, { status: 404 });
  }

  // Path B: Manual/API deps (non-npm or skill category) — single dep only
  const nonNpmDeps = deps.filter((d: Dep) => d.check_type !== "npm" || d.category === "skill");
  if (nonNpmDeps.length > 0) {
    if (deps.length > 1) {
      return NextResponse.json({ error: "Batch update only supported for npm deps" }, { status: 400 });
    }
    const dep = nonNpmDeps[0];
    if (!manualVersion) {
      return NextResponse.json({ error: "new_version required for non-npm deps" }, { status: 400 });
    }

    await supabase
      .from("instaclaw_dependencies")
      .update({
        our_version: manualVersion,
        notes: manualNotes || dep.name,
        status: "current",
        is_behind: false,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", dep.id);

    return NextResponse.json({ success: true });
  }

  // Path A: NPM deps — bump via GitHub API
  const npmDeps = deps as Dep[];

  // Validate all are npm + behind + have latest_version
  for (const dep of npmDeps) {
    if (dep.check_type !== "npm") {
      return NextResponse.json({ error: `${dep.name} is not an npm dep` }, { status: 400 });
    }
    if (dep.status !== "behind") {
      return NextResponse.json({ error: `${dep.name} is not behind` }, { status: 400 });
    }
    if (!dep.latest_version) {
      return NextResponse.json({ error: `${dep.name} has no latest_version` }, { status: 400 });
    }
  }

  // Fetch package.json from GitHub
  const ghRes = await fetch(
    `https://api.github.com/repos/${REPO}/contents/instaclaw/package.json`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "instaclaw-hq",
      },
    },
  );

  if (!ghRes.ok) {
    const text = await ghRes.text();
    return NextResponse.json({ error: `GitHub API error: ${ghRes.status} ${text}` }, { status: 502 });
  }

  const ghData = await ghRes.json();
  const sha = ghData.sha as string;
  const content = Buffer.from(ghData.content, "base64").toString("utf-8");
  const pkg = JSON.parse(content);

  // Bump versions
  const bumped: { name: string; from: string; to: string }[] = [];
  for (const dep of npmDeps) {
    const target = dep.check_target!;
    const found =
      (pkg.dependencies && target in pkg.dependencies) ||
      (pkg.devDependencies && target in pkg.devDependencies);

    if (!found) {
      return NextResponse.json(
        { error: `${dep.name} (${target}) not found in package.json dependencies` },
        { status: 422 },
      );
    }

    const section = pkg.dependencies && target in pkg.dependencies
      ? "dependencies"
      : "devDependencies";
    const oldVersion = pkg[section][target];
    pkg[section][target] = dep.latest_version!;
    bumped.push({ name: dep.name, from: oldVersion, to: dep.latest_version! });
  }

  // Commit to GitHub
  const commitMessage =
    bumped.length === 1
      ? `chore: bump ${bumped[0].name} to ${bumped[0].to}`
      : `chore: bump ${bumped.length} dependencies`;

  const newContent = Buffer.from(JSON.stringify(pkg, null, 2) + "\n").toString("base64");

  const putRes = await fetch(
    `https://api.github.com/repos/${REPO}/contents/instaclaw/package.json`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "instaclaw-hq",
      },
      body: JSON.stringify({
        message: commitMessage,
        content: newContent,
        sha,
      }),
    },
  );

  if (!putRes.ok) {
    const text = await putRes.text();
    return NextResponse.json({ error: `GitHub commit failed: ${putRes.status} ${text}` }, { status: 502 });
  }

  const putData = await putRes.json();
  const commitSha = putData.commit?.sha as string;

  // Update DB rows
  for (const dep of npmDeps) {
    await supabase
      .from("instaclaw_dependencies")
      .update({
        our_version: dep.latest_version,
        is_behind: false,
        status: "current",
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", dep.id);
  }

  return NextResponse.json({ success: true, commit_sha: commitSha, bumped });
}
