import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import Link from "next/link";

export const metadata = createMetadata({
  title: "InstaClaw Blog — AI Agents, OpenClaw, and Personal AI",
  description:
    "Articles about personal AI agents, OpenClaw tutorials, AI agent income strategies, hosting comparisons, and the future of AI assistants.",
  path: "/blog",
});

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "InstaClaw Blog",
  description: "Articles about personal AI agents, OpenClaw, and the future of AI.",
  url: "https://instaclaw.io/blog",
};

const posts = [
  {
    slug: "what-is-openclaw",
    title: "What is OpenClaw? A Complete Guide for Beginners (2026)",
    excerpt:
      "Everything you need to know about OpenClaw — the open-source personal AI agent framework. What it does, how it works, and why it matters.",
    date: "March 2026",
    readTime: "8 min read",
  },
  {
    slug: "what-is-a-personal-ai-agent",
    title: "What is a Personal AI Agent? The Complete Guide (2026)",
    excerpt:
      "What makes a personal AI agent different from a chatbot? How they work, what they can do, and why everyone will have one soon.",
    date: "March 2026",
    readTime: "10 min read",
  },
  {
    slug: "deploy-openclaw-no-code",
    title: "How to Deploy OpenClaw Without Writing a Single Line of Code",
    excerpt:
      "Step-by-step guide to getting your own OpenClaw instance running — no coding, no servers, no terminal. Just a personal AI agent, live in minutes.",
    date: "March 2026",
    readTime: "6 min read",
  },
  {
    slug: "ai-agent-passive-income",
    title: "How People Are Making Passive Income with AI Agents in 2026",
    excerpt:
      "Real strategies for using personal AI agents to generate income — from content creation and research to trading and business automation.",
    date: "March 2026",
    readTime: "9 min read",
  },
  {
    slug: "best-openclaw-hosting-providers",
    title: "Best OpenClaw Hosting Providers Compared (2026)",
    excerpt:
      "A comprehensive comparison of OpenClaw hosting options — self-hosting, InstaClaw, and other providers. Costs, features, pros and cons.",
    date: "March 2026",
    readTime: "7 min read",
  },
];

export default function BlogPage() {
  return (
    <>
      <JsonLd data={collectionJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Blog
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              Guides, tutorials, and insights about personal AI agents, OpenClaw,
              and the future of AI.
            </p>
          </div>

          <div className="space-y-0">
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="block group"
              >
                <div
                  className="py-8 border-t transition-colors"
                  style={{ borderColor: "rgba(0,0,0,0.1)" }}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs" style={{ color: "#6b6b6b" }}>
                      {post.date}
                    </span>
                    <span className="text-xs" style={{ color: "#6b6b6b" }}>
                      ·
                    </span>
                    <span className="text-xs" style={{ color: "#6b6b6b" }}>
                      {post.readTime}
                    </span>
                  </div>
                  <h2
                    className="text-lg sm:text-xl font-normal tracking-[-0.5px] mb-2 group-hover:opacity-70 transition-opacity"
                    style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
                  >
                    {post.title}
                  </h2>
                  <p className="text-sm" style={{ color: "#6b6b6b" }}>
                    {post.excerpt}
                  </p>
                  <span
                    className="inline-block mt-3 text-xs font-medium group-hover:underline"
                    style={{ color: "#DC6743" }}
                  >
                    Read more →
                  </span>
                </div>
              </Link>
            ))}
            {/* Bottom border for last item */}
            <div
              className="h-px w-full"
              style={{ background: "rgba(0,0,0,0.1)" }}
            />
          </div>
        </div>
      </section>
    </>
  );
}
