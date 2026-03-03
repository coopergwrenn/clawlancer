/**
 * seed-blog-queue.ts
 *
 * Inserts 18 seed posts into blog_queue (3/day, March 3-8 2026).
 *
 * Usage:
 *   npx tsx scripts/seed-blog-queue.ts
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

// ── Seed data ────────────────────────────────────────────────────────
const seeds = [
  // March 3
  {
    slug: "openclaw-vs-chatgpt",
    title: "OpenClaw vs ChatGPT — What's the Difference?",
    excerpt:
      "ChatGPT is a chatbot. OpenClaw is a personal AI agent with its own server, persistent memory, and the ability to act autonomously. Here's how they compare.",
    target_keywords: ["openclaw vs chatgpt", "ai agent vs chatbot", "openclaw comparison"],
    internal_links: ["/blog/what-is-openclaw", "/how-it-works", "/pricing", "/blog/what-is-a-personal-ai-agent"],
    scheduled_date: "2026-03-03",
  },
  {
    slug: "ai-agent-telegram-bot",
    title: "How to Build a Telegram Bot with an AI Agent",
    excerpt:
      "Step-by-step guide to connecting an OpenClaw AI agent to Telegram. Your agent becomes a persistent, intelligent bot that remembers everything and acts on your behalf.",
    target_keywords: ["ai telegram bot", "openclaw telegram", "telegram ai agent"],
    internal_links: ["/blog/deploy-openclaw-no-code", "/how-it-works", "/docs", "/pricing"],
    scheduled_date: "2026-03-03",
  },
  {
    slug: "what-can-ai-agents-do",
    title: "10 Things Your AI Agent Can Do That You Didn't Know About",
    excerpt:
      "From scheduling tasks to browsing the web to trading crypto, personal AI agents are more capable than most people realize. Here are 10 surprising use cases.",
    target_keywords: ["ai agent capabilities", "what can ai do", "ai agent use cases"],
    internal_links: ["/use-cases", "/blog/what-is-a-personal-ai-agent", "/use-cases/research-assistant", "/use-cases/crypto-trading", "/use-cases/video-creation"],
    scheduled_date: "2026-03-03",
  },

  // March 4
  {
    slug: "openclaw-skills-guide",
    title: "The Complete Guide to OpenClaw Skills (2026)",
    excerpt:
      "OpenClaw skills give your AI agent new capabilities via the Model Context Protocol (MCP). This guide covers how skills work, how to install them, and the best skills available today.",
    target_keywords: ["openclaw skills", "ai agent skills", "mcp tools", "openclaw mcp"],
    internal_links: ["/blog/what-is-openclaw", "/docs", "/use-cases", "/how-it-works"],
    scheduled_date: "2026-03-04",
  },
  {
    slug: "ai-agent-for-crypto",
    title: "How to Use an AI Agent for Crypto Trading and Research",
    excerpt:
      "AI agents can monitor markets, execute trades, research tokens, and manage portfolios 24/7. Here's how to set up your own crypto-focused AI agent with OpenClaw.",
    target_keywords: ["ai crypto trading", "ai agent crypto", "openclaw crypto", "ai trading bot"],
    internal_links: ["/use-cases/crypto-trading", "/use-cases/polymarket-trading", "/pricing", "/blog/what-is-a-personal-ai-agent"],
    scheduled_date: "2026-03-04",
  },
  {
    slug: "personal-ai-vs-business-ai",
    title: "Personal AI vs Business AI — Which Do You Need?",
    excerpt:
      "Personal AI agents and business AI tools serve different purposes. This guide helps you understand the distinction and choose the right approach for your needs.",
    target_keywords: ["personal ai", "business ai", "ai comparison", "personal ai agent"],
    internal_links: ["/blog/what-is-a-personal-ai-agent", "/use-cases/business-automation", "/pricing", "/how-it-works"],
    scheduled_date: "2026-03-04",
  },

  // March 5
  {
    slug: "openclaw-security",
    title: "Is OpenClaw Safe? Security and Privacy Explained",
    excerpt:
      "How OpenClaw keeps your data private and your agent secure. Isolated VMs, encrypted connections, open-source transparency, and your complete control over the infrastructure.",
    target_keywords: ["openclaw security", "ai agent privacy", "openclaw safe", "ai data privacy"],
    internal_links: ["/blog/what-is-openclaw", "/compare/instaclaw-vs-self-hosting", "/how-it-works", "/docs", "/privacy"],
    scheduled_date: "2026-03-05",
  },
  {
    slug: "ai-agent-content-creation",
    title: "How AI Agents Are Revolutionizing Content Creation",
    excerpt:
      "AI agents can write blog posts, create videos, manage social media, and produce marketing materials autonomously. Here's how content creators are using them in 2026.",
    target_keywords: ["ai content creation", "ai writer", "ai agent content", "ai video creation"],
    internal_links: ["/use-cases/video-creation", "/use-cases/social-media", "/blog/ai-agent-passive-income", "/pricing"],
    scheduled_date: "2026-03-05",
  },
  {
    slug: "best-ai-agent-platforms-2026",
    title: "Best AI Agent Platforms in 2026 — Compared",
    excerpt:
      "A comprehensive comparison of the top AI agent platforms in 2026, including OpenClaw, AutoGPT, CrewAI, and more. Features, pricing, and who each one is best for.",
    target_keywords: ["best ai agent", "ai platforms 2026", "ai agent comparison", "openclaw alternatives"],
    internal_links: ["/blog/what-is-openclaw", "/compare/instaclaw-vs-self-hosting", "/pricing", "/blog/best-openclaw-hosting-providers"],
    scheduled_date: "2026-03-05",
  },

  // March 6
  {
    slug: "openclaw-api-guide",
    title: "OpenClaw API — The Developer's Guide",
    excerpt:
      "Everything developers need to know about the OpenClaw API. Authentication, endpoints, rate limits, and code examples for building on top of the OpenClaw platform.",
    target_keywords: ["openclaw api", "ai agent api", "openclaw developer", "openclaw integration"],
    internal_links: ["/docs", "/blog/what-is-openclaw", "/blog/openclaw-skills-guide", "/how-it-works"],
    scheduled_date: "2026-03-06",
  },
  {
    slug: "ai-agent-polymarket",
    title: "Using AI Agents for Polymarket — A Complete Guide",
    excerpt:
      "How to use an AI agent to research, analyze, and trade on Polymarket prediction markets. Setup guide, strategy tips, and real-world examples.",
    target_keywords: ["ai polymarket", "ai prediction markets", "polymarket bot", "ai trading polymarket"],
    internal_links: ["/use-cases/polymarket-trading", "/use-cases/crypto-trading", "/blog/ai-agent-for-crypto", "/pricing"],
    scheduled_date: "2026-03-06",
  },
  {
    slug: "future-of-personal-ai",
    title: "The Future of Personal AI — What's Coming in 2026 and Beyond",
    excerpt:
      "Personal AI agents are evolving rapidly. Here's what to expect in the next 12 months: better memory, multimodal skills, agent-to-agent collaboration, and mainstream adoption.",
    target_keywords: ["future of ai", "personal ai 2026", "ai predictions", "ai agent future"],
    internal_links: ["/blog/what-is-a-personal-ai-agent", "/blog/what-is-openclaw", "/use-cases", "/how-it-works"],
    scheduled_date: "2026-03-06",
  },

  // March 7
  {
    slug: "openclaw-vs-autogpt",
    title: "OpenClaw vs AutoGPT — Which AI Agent Framework is Better?",
    excerpt:
      "A detailed comparison of OpenClaw and AutoGPT — two popular AI agent frameworks. Architecture, capabilities, ease of use, and which one is right for your needs.",
    target_keywords: ["openclaw vs autogpt", "ai frameworks", "autogpt alternative", "best ai agent framework"],
    internal_links: ["/blog/what-is-openclaw", "/blog/best-ai-agent-platforms-2026", "/compare/instaclaw-vs-self-hosting", "/pricing"],
    scheduled_date: "2026-03-07",
  },
  {
    slug: "ai-agent-for-research",
    title: "How to Use an AI Agent as Your Personal Research Assistant",
    excerpt:
      "AI agents can search the web, summarize papers, compile data, and deliver daily briefings. Here's how to set up your own AI-powered research assistant.",
    target_keywords: ["ai research assistant", "ai researcher", "ai agent research", "personal research ai"],
    internal_links: ["/use-cases/research-assistant", "/blog/what-can-ai-agents-do", "/how-it-works", "/pricing"],
    scheduled_date: "2026-03-07",
  },
  {
    slug: "make-money-ai-agent",
    title: "5 Ways to Make Money with Your AI Agent in 2026",
    excerpt:
      "From content creation to trading to freelance automation, AI agents are opening new income streams. Here are five proven ways people are making money with their agents.",
    target_keywords: ["make money ai", "ai income", "ai agent business", "ai side hustle"],
    internal_links: ["/blog/ai-agent-passive-income", "/use-cases/business-automation", "/use-cases/video-creation", "/pricing", "/blog/ai-agent-content-creation"],
    scheduled_date: "2026-03-07",
  },

  // March 8
  {
    slug: "openclaw-hosting-cost",
    title: "How Much Does It Cost to Run OpenClaw? Full Breakdown",
    excerpt:
      "A transparent look at the costs of running an OpenClaw agent — VPS hosting, API usage, managed vs self-hosted, and tips for keeping costs low.",
    target_keywords: ["openclaw cost", "ai agent pricing", "openclaw hosting", "ai agent cost"],
    internal_links: ["/pricing", "/compare/instaclaw-vs-self-hosting", "/blog/best-openclaw-hosting-providers", "/blog/what-is-openclaw"],
    scheduled_date: "2026-03-08",
  },
  {
    slug: "ai-agent-video-creation",
    title: "AI Agents for Video Creation — How It Works",
    excerpt:
      "AI agents can now create videos from text descriptions using tools like Remotion. Here's how the video creation pipeline works and how to get started.",
    target_keywords: ["ai video", "ai agent video", "ai video creation", "remotion ai"],
    internal_links: ["/use-cases/video-creation", "/blog/ai-agent-content-creation", "/blog/openclaw-skills-guide", "/pricing"],
    scheduled_date: "2026-03-08",
  },
  {
    slug: "why-everyone-needs-ai-agent",
    title: "Why Everyone Will Have a Personal AI Agent by 2027",
    excerpt:
      "The cost is dropping, the capabilities are expanding, and the use cases are becoming undeniable. Here's why personal AI agents are about to go mainstream.",
    target_keywords: ["personal ai agent", "why ai agent", "ai adoption", "everyone ai agent"],
    internal_links: ["/blog/what-is-a-personal-ai-agent", "/blog/future-of-personal-ai", "/how-it-works", "/pricing", "/blog/what-is-openclaw"],
    scheduled_date: "2026-03-08",
  },
];

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding ${seeds.length} posts into blog_queue...\n`);

  const { data, error } = await supabase
    .from("blog_queue")
    .upsert(seeds, { onConflict: "slug" })
    .select("slug, scheduled_date");

  if (error) {
    console.error("Seed failed:", error.message);
    process.exit(1);
  }

  console.log(`Inserted/updated ${data?.length ?? 0} rows:`);
  for (const row of data || []) {
    console.log(`  ${row.scheduled_date} — ${row.slug}`);
  }
}

main();
