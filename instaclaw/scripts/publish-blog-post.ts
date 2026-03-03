/**
 * publish-blog-post.ts
 *
 * Takes a generated blog post from blog_queue, writes the .tsx file,
 * updates routes.ts + blog index, git commits, and pings IndexNow.
 *
 * Usage:
 *   npx tsx scripts/publish-blog-post.ts [--slug specific-slug]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

// ── Load .env.local ──────────────────────────────────────────────────
const envPath = resolve(".", ".env.local");
const envContent = readFileSync(envPath, "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const INDEXNOW_KEY = "0f1c8f8f50854151ab18972b9048e856";
const SITE_URL = "https://instaclaw.io";

// ── Paths ────────────────────────────────────────────────────────────
const ROOT = resolve(".");
const BLOG_DIR = resolve(ROOT, "app/(marketing)/blog");
const ROUTES_FILE = resolve(ROOT, "lib/routes.ts");
const BLOG_INDEX = resolve(ROOT, "app/(marketing)/blog/page.tsx");

// ── Helpers ──────────────────────────────────────────────────────────
function estimateReadTime(wordCount: number): string {
  const minutes = Math.max(1, Math.round(wordCount / 200));
  return `${minutes} min read`;
}

function addRouteEntry(slug: string, title: string) {
  let content = readFileSync(ROUTES_FILE, "utf-8");

  // Find the last route entry before the closing ];
  // Insert new route before the privacy/terms entries (at the end of blog routes)
  const newRoute = `  { path: "/blog/${slug}", label: "${title.replace(/"/g, '\\"')}", changeFrequency: "monthly", priority: 0.6 },`;

  // Insert before the privacy line
  const privacyLine = '  { path: "/privacy"';
  if (content.includes(privacyLine)) {
    content = content.replace(privacyLine, newRoute + "\n" + privacyLine);
  } else {
    // Fallback: insert before closing ];
    content = content.replace(/\n];/, "\n" + newRoute + "\n];");
  }

  writeFileSync(ROUTES_FILE, content, "utf-8");
}

function addBlogIndexEntry(
  slug: string,
  title: string,
  excerpt: string,
  readTime: string
) {
  let content = readFileSync(BLOG_INDEX, "utf-8");

  const newEntry = `  {
    slug: "${slug}",
    title: "${title.replace(/"/g, '\\"')}",
    excerpt:
      "${excerpt.replace(/"/g, '\\"')}",
    date: "March 2026",
    readTime: "${readTime}",
  },`;

  // Insert after "const posts = ["
  content = content.replace("const posts = [", "const posts = [\n" + newEntry);

  writeFileSync(BLOG_INDEX, content, "utf-8");
}

function pingIndexNow(urls: string[]) {
  try {
    const body = JSON.stringify({
      host: "instaclaw.io",
      key: INDEXNOW_KEY,
      keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    });

    const res = execSync(
      `curl -s -o /dev/null -w "%{http_code}" -X POST "https://api.indexnow.org/indexnow" -H "Content-Type: application/json" -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: "utf-8" }
    ).trim();

    console.log(`IndexNow ping: HTTP ${res} for ${urls.length} URL(s)`);
  } catch (err) {
    console.warn("IndexNow ping failed (non-fatal):", err);
  }
}

// ── Main ─────────────────────────────────────────────────────────────
export async function publishPost(slug?: string): Promise<string | null> {
  // Fetch the post
  let query = supabase.from("blog_queue").select("*");
  if (slug) {
    query = query.eq("slug", slug).eq("status", "generated");
  } else {
    query = query
      .eq("status", "generated")
      .lte("scheduled_date", new Date().toISOString().split("T")[0])
      .order("scheduled_date", { ascending: true })
      .limit(1);
  }

  const { data: rows, error: fetchErr } = await query;
  if (fetchErr) {
    console.error("Failed to fetch from blog_queue:", fetchErr.message);
    return null;
  }
  if (!rows || rows.length === 0) {
    console.log("No generated posts to publish.");
    return null;
  }

  const post = rows[0];
  console.log(`Publishing: "${post.title}" (${post.slug})`);

  // 1. Write the .tsx file
  const postDir = resolve(BLOG_DIR, post.slug);
  if (!existsSync(postDir)) {
    mkdirSync(postDir, { recursive: true });
  }
  writeFileSync(resolve(postDir, "page.tsx"), post.generated_tsx, "utf-8");
  console.log(`  Created: app/(marketing)/blog/${post.slug}/page.tsx`);

  // 2. Update routes.ts
  addRouteEntry(post.slug, post.title);
  console.log(`  Updated: lib/routes.ts`);

  // 3. Update blog index
  const readTime = estimateReadTime(post.word_count || 1500);
  addBlogIndexEntry(post.slug, post.title, post.excerpt, readTime);
  console.log(`  Updated: app/(marketing)/blog/page.tsx`);

  // 4. Git commit
  try {
    execSync(
      `git add "app/(marketing)/blog/${post.slug}/page.tsx" "lib/routes.ts" "app/(marketing)/blog/page.tsx"`,
      { cwd: ROOT, stdio: "pipe" }
    );
    execSync(
      `git commit -m "blog: publish \\"${post.title.replace(/"/g, '\\"')}\\""`,
      { cwd: ROOT, stdio: "pipe" }
    );
    console.log(`  Committed to git`);
  } catch (err) {
    console.warn("  Git commit failed (may already be committed):", err);
  }

  // 5. Push
  try {
    execSync("git push origin main", { cwd: ROOT, stdio: "pipe" });
    console.log(`  Pushed to origin/main`);
  } catch (err) {
    console.warn("  Git push failed:", err);
  }

  // 6. Ping IndexNow
  const postUrl = `${SITE_URL}/blog/${post.slug}`;
  pingIndexNow([postUrl]);

  // 7. Update DB
  const { error: updateErr } = await supabase
    .from("blog_queue")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", post.id);

  if (updateErr) {
    console.error("Failed to update status to published:", updateErr.message);
  }

  console.log(`  Published: ${postUrl}`);
  return post.slug;
}

// ── CLI entry ────────────────────────────────────────────────────────
if (process.argv[1]?.includes("publish-blog-post")) {
  const slugArg = process.argv.find((a) => a === "--slug");
  const slugVal = slugArg
    ? process.argv[process.argv.indexOf("--slug") + 1]
    : undefined;

  publishPost(slugVal).then((result) => {
    if (!result) process.exit(1);
  });
}
