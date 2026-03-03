/**
 * generate-blog-post.ts
 *
 * Fetches a pending post from blog_queue, generates the TSX page content
 * via Anthropic API, and stores it back in the DB.
 *
 * Usage:
 *   npx tsx scripts/generate-blog-post.ts [--slug specific-slug]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

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

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 12000;

// ── System prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a blog content writer for InstaClaw (instaclaw.io), a managed hosting platform for OpenClaw — the open-source personal AI agent framework.

Your job is to write a complete Next.js page component as a .tsx file. The output must be ONLY valid TypeScript/JSX code — no markdown fences, no explanation, just the raw .tsx file content.

STRICT RULES:
1. The file must start with imports and export a metadata object using createMetadata() and a default function component.
2. Use these exact imports:
   import { createMetadata } from "@/lib/seo";
   import { JsonLd } from "@/components/marketing/json-ld";
   import { CtaBanner } from "@/components/marketing/cta-banner";
   import Link from "next/link";

3. The metadata export must use createMetadata({ title, description, path: "/blog/{slug}" }).
4. The component must include:
   - <JsonLd> with Article schema including datePublished
   - An <article> wrapper with className="mx-auto max-w-2xl px-6 py-16 sm:py-24" style={{ color: "#333334" }}
   - A back-to-blog link at the top: <Link href="/blog" className="text-sm hover:underline" style={{ color: "#DC6743" }}>&larr; Back to Blog</Link>
   - A header with <h1> using className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}
   - Date + read time: <p className="text-sm" style={{ color: "#6b6b6b" }}>
   - Multiple <section className="mb-12"> blocks for content
   - <h2> headings: className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4" style={{ fontFamily: "var(--font-serif)" }}
   - <p> paragraphs: className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}
   - <strong> text uses style={{ color: "#333334" }}
   - Internal links use: <Link href="..." className="underline" style={{ color: "#DC6743" }}>
   - A "Related Pages" section at the end with border-t
   - End with <CtaBanner />
5. Use &apos; for apostrophes in JSX text, &middot; for the dot separator.
6. Write 1500-2000 words of substantive, SEO-optimized content. No filler, no fluff.
7. Naturally incorporate the target keywords throughout the content.
8. Include ALL specified internal links as <Link> elements within the body text where contextually relevant.
9. The function name should be PascalCase based on the slug (e.g., "openclaw-vs-chatgpt" -> OpenclawVsChatgptPage).
10. DO NOT wrap the output in markdown code fences. Output ONLY the .tsx file content.
11. Include 2-3 natural CTA moments throughout the post — not just at the end. These should feel like helpful suggestions, not ads. Examples: "If you want to try this yourself, InstaClaw lets you deploy an agent in 60 seconds" or "InstaClaw handles all of this automatically — plans start at $29/month." Place one around the 1/3 mark, one around the 2/3 mark, and the final CtaBanner at the end. Never use phrases like "Sign up now!" or "Don&apos;t miss out!" — just state what InstaClaw does and link to the relevant page.`;

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const slugArg = process.argv.find((a) => a === "--slug");
  const slugVal = slugArg
    ? process.argv[process.argv.indexOf("--slug") + 1]
    : null;

  // Fetch the post to generate
  let query = supabase.from("blog_queue").select("*");
  if (slugVal) {
    query = query.eq("slug", slugVal);
  } else {
    query = query
      .eq("status", "pending")
      .lte("scheduled_date", new Date().toISOString().split("T")[0])
      .order("scheduled_date", { ascending: true })
      .limit(1);
  }

  const { data: rows, error: fetchErr } = await query;
  if (fetchErr) {
    console.error("Failed to fetch from blog_queue:", fetchErr.message);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.log("No pending posts to generate.");
    process.exit(0);
  }

  const post = rows[0];
  console.log(`Generating: "${post.title}" (${post.slug})`);

  // Set status to generating
  await supabase
    .from("blog_queue")
    .update({ status: "generating" })
    .eq("id", post.id);

  // Build user prompt
  const userPrompt = `Write a blog post with the following details:

Title: ${post.title}
Slug: ${post.slug}
Path: /blog/${post.slug}
Date Published: ${post.scheduled_date}
Target Keywords: ${(post.target_keywords || []).join(", ")}
Internal Links to Include: ${(post.internal_links || []).map((l: string) => `<Link href="${l}">`).join(", ")}
Word Count Target: 1500-2000 words

The excerpt for this post is: "${post.excerpt}"

Write the complete .tsx file now.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);

    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawTsx =
      data.content
        ?.filter((b: { type: string }) => b.type === "text")
        .map((b: { text: string }) => b.text)
        .join("") || "";

    if (!rawTsx) {
      throw new Error("Empty response from Anthropic API");
    }

    // Strip markdown fences if present (safety)
    const tsx = rawTsx
      .replace(/^```(?:tsx|typescript|ts)?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    // Count words (rough)
    const wordCount = tsx
      .replace(/<[^>]+>/g, " ")
      .replace(/[{}]/g, " ")
      .split(/\s+/)
      .filter((w: string) => w.length > 2).length;

    // Update DB
    const { error: updateErr } = await supabase
      .from("blog_queue")
      .update({
        status: "generated",
        generated_tsx: tsx,
        word_count: wordCount,
      })
      .eq("id", post.id);

    if (updateErr) {
      throw new Error(`DB update failed: ${updateErr.message}`);
    }

    console.log(
      `Generated "${post.title}" — ${wordCount} words (approx). Status: generated`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Generation failed for "${post.slug}":`, message);

    await supabase
      .from("blog_queue")
      .update({ status: "failed", error: message })
      .eq("id", post.id);

    process.exit(1);
  }
}

main();
