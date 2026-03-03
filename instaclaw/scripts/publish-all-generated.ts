/**
 * publish-all-generated.ts
 *
 * Batch-publishes all generated blog posts that are scheduled for today or earlier.
 * Batches git operations into a single commit + push.
 *
 * Usage:
 *   npx tsx scripts/publish-all-generated.ts [--limit 3]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

// ── Load .env.local ──────────────────────────────────────────────────
const envPath = resolve(".", ".env.local");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const INDEXNOW_KEY = "0f1c8f8f50854151ab18972b9048e856";
const SITE_URL = "https://instaclaw.io";

const ROOT = resolve(".");
const BLOG_DIR = resolve(ROOT, "app/(marketing)/blog");
const ROUTES_FILE = resolve(ROOT, "lib/routes.ts");
const BLOG_INDEX = resolve(ROOT, "app/(marketing)/blog/page.tsx");

// ── Helpers ──────────────────────────────────────────────────────────
function estimateReadTime(wordCount: number): string {
  const minutes = Math.max(1, Math.round(wordCount / 200));
  return `${minutes} min read`;
}

function pingIndexNow(urls: string[]) {
  if (urls.length === 0) return;
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
async function main() {
  // Parse --limit
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : 3;

  // Fetch all generated posts scheduled for today or earlier
  const today = new Date().toISOString().split("T")[0];
  const { data: posts, error: fetchErr } = await supabase
    .from("blog_queue")
    .select("*")
    .eq("status", "generated")
    .lte("scheduled_date", today)
    .order("scheduled_date", { ascending: true })
    .limit(limit);

  if (fetchErr) {
    console.error("Failed to fetch from blog_queue:", fetchErr.message);
    process.exit(1);
  }
  if (!posts || posts.length === 0) {
    console.log("No generated posts to publish.");
    process.exit(0);
  }

  console.log(`Publishing ${posts.length} post(s)...\n`);

  const publishedSlugs: string[] = [];
  const publishedUrls: string[] = [];
  const gitFiles: string[] = [];

  for (const post of posts) {
    console.log(`[${publishedSlugs.length + 1}/${posts.length}] "${post.title}" (${post.slug})`);

    // 1. Write the .tsx file
    const postDir = resolve(BLOG_DIR, post.slug);
    if (!existsSync(postDir)) {
      mkdirSync(postDir, { recursive: true });
    }
    writeFileSync(resolve(postDir, "page.tsx"), post.generated_tsx, "utf-8");
    gitFiles.push(`app/(marketing)/blog/${post.slug}/page.tsx`);
    console.log(`  Created: app/(marketing)/blog/${post.slug}/page.tsx`);

    // 2. Update routes.ts — append new route before privacy line
    let routesContent = readFileSync(ROUTES_FILE, "utf-8");
    const newRoute = `  { path: "/blog/${post.slug}", label: "${post.title.replace(/"/g, '\\"')}", changeFrequency: "monthly", priority: 0.6 },`;
    const privacyLine = '  { path: "/privacy"';
    if (routesContent.includes(privacyLine)) {
      routesContent = routesContent.replace(privacyLine, newRoute + "\n" + privacyLine);
    } else {
      routesContent = routesContent.replace(/\n];/, "\n" + newRoute + "\n];");
    }
    writeFileSync(ROUTES_FILE, routesContent, "utf-8");
    console.log(`  Updated: lib/routes.ts`);

    // 3. Update blog index — prepend to posts array
    let indexContent = readFileSync(BLOG_INDEX, "utf-8");
    const readTime = estimateReadTime(post.word_count || 1500);
    const newEntry = `  {
    slug: "${post.slug}",
    title: "${post.title.replace(/"/g, '\\"')}",
    excerpt:
      "${post.excerpt.replace(/"/g, '\\"')}",
    date: "March 2026",
    readTime: "${readTime}",
  },`;
    indexContent = indexContent.replace("const posts = [", "const posts = [\n" + newEntry);
    writeFileSync(BLOG_INDEX, indexContent, "utf-8");
    console.log(`  Updated: app/(marketing)/blog/page.tsx`);

    // 4. Update DB
    await supabase
      .from("blog_queue")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", post.id);

    publishedSlugs.push(post.slug);
    publishedUrls.push(`${SITE_URL}/blog/${post.slug}`);
  }

  // 5. Batch git operations
  gitFiles.push("lib/routes.ts", "app/(marketing)/blog/page.tsx");
  const uniqueFiles = Array.from(new Set(gitFiles));

  try {
    execSync(`git add ${uniqueFiles.map((f) => `"${f}"`).join(" ")}`, {
      cwd: ROOT,
      stdio: "pipe",
    });

    const commitMsg =
      publishedSlugs.length === 1
        ? `blog: publish "${posts[0].title}"`
        : `blog: publish ${publishedSlugs.length} posts (${publishedSlugs.join(", ")})`;

    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    console.log(`\nCommitted ${uniqueFiles.length} files to git`);
  } catch (err) {
    console.warn("Git commit failed:", err);
  }

  // 6. Ping IndexNow with all URLs
  pingIndexNow(publishedUrls);

  // Summary
  console.log(`\n--- Summary ---`);
  console.log(`Published: ${publishedSlugs.length} post(s)`);
  for (const slug of publishedSlugs) {
    console.log(`  - /blog/${slug}`);
  }
}

main();
