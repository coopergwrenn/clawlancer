import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "InstaClaw Use Cases — What Your AI Agent Can Do For You",
  description:
    "Discover how people use InstaClaw for Polymarket trading, crypto, Shopify management, video creation, language learning, business automation, research, and social media.",
  path: "/use-cases",
});

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "InstaClaw Use Cases",
  description:
    "Explore the many ways people use InstaClaw personal AI agents.",
  url: "https://instaclaw.io/use-cases",
};

const categories = [
  {
    title: "Trading & Finance",
    items: [
      {
        slug: "polymarket-trading",
        title: "Polymarket Trading",
        description:
          "Automate prediction market research, track odds, and get real-time alerts on Polymarket events.",
      },
      {
        slug: "crypto-trading",
        title: "Crypto Trading",
        description:
          "Monitor token prices, track wallets, analyze on-chain data, and execute trades across DeFi protocols.",
      },
    ],
  },
  {
    title: "Business Automation",
    items: [
      {
        slug: "business-automation",
        title: "Business Automation",
        description:
          "Automate email triage, report generation, data entry, scheduling, and repetitive workflows.",
      },
      {
        slug: "shopify-management",
        title: "Shopify Management",
        description:
          "Manage products, track orders, handle customer inquiries, and analyze sales data for your Shopify store.",
      },
    ],
  },
  {
    title: "Content Creation",
    items: [
      {
        slug: "video-creation",
        title: "Video Creation",
        description:
          "Generate scripts, create short-form videos, edit clips, and produce content for YouTube, TikTok, and Instagram.",
      },
      {
        slug: "social-media",
        title: "Social Media Management",
        description:
          "Draft posts, schedule content, monitor mentions, and engage with your audience across platforms.",
      },
    ],
  },
  {
    title: "Learning & Research",
    items: [
      {
        slug: "language-learning",
        title: "Language Learning",
        description:
          "Practice conversations, get grammar corrections, build vocabulary, and immerse in your target language 24/7.",
      },
      {
        slug: "research-assistant",
        title: "Research Assistant",
        description:
          "Search the web, summarize papers, compile reports, track topics, and organize research findings.",
      },
    ],
  },
];

export default function UseCasesPage() {
  return (
    <>
      <JsonLd data={collectionJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              What Your AI Agent Can Do
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              InstaClaw agents come pre-loaded with 20+ skills and learn new
              ones as you use them. Here are some of the most popular use cases.
            </p>
          </div>

          {categories.map((category) => (
            <div key={category.title} className="mb-16">
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-6"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                {category.title}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {category.items.map((item) => (
                  <Link
                    key={item.slug}
                    href={`/use-cases/${item.slug}`}
                    className="block rounded-xl p-6 transition-all hover:scale-[1.01]"
                    style={{
                      background:
                        "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
                      boxShadow:
                        "rgba(0,0,0,0.05) 0px 2px 2px 0px inset, rgba(255,255,255,0.5) 0px -2px 2px 0px inset, rgba(0,0,0,0.1) 0px 2px 4px 0px, rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset",
                    }}
                  >
                    <h3
                      className="text-lg font-semibold mb-2"
                      style={{ color: "#333334" }}
                    >
                      {item.title}
                    </h3>
                    <p className="text-sm" style={{ color: "#6b6b6b" }}>
                      {item.description}
                    </p>
                    <span
                      className="inline-block mt-3 text-xs font-medium"
                      style={{ color: "#DC6743" }}
                    >
                      Learn more →
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}

          <div
            className="text-center mt-8 text-sm"
            style={{ color: "#6b6b6b" }}
          >
            <p>
              Don&apos;t see your use case?{" "}
              <Link
                href="/faq"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Check the FAQ
              </Link>{" "}
              or{" "}
              <Link
                href="/how-it-works"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                see how it works
              </Link>
              . Your agent can do almost anything — if it can be done on a
              computer, it can probably do it.
            </p>
            <p className="mt-4">
              <Link
                href="/pricing"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                View pricing
              </Link>{" "}
              ·{" "}
              <Link
                href="/blog/what-is-a-personal-ai-agent"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                What is a personal AI agent?
              </Link>{" "}
              ·{" "}
              <Link
                href="/docs"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Documentation
              </Link>
            </p>
          </div>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}
