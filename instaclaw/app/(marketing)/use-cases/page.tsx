import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "InstaClaw Use Cases — What Your AI Agent Can Do For You",
  description:
    "Discover how people use InstaClaw for trading, crypto, code execution, email automation, competitive intelligence, video creation, research, and more.",
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

interface UseCaseItem {
  slug?: string;
  title: string;
  description: string;
}

const categories: { title: string; items: UseCaseItem[] }[] = [
  {
    title: "Trading & Finance",
    items: [
      {
        slug: "polymarket-trading",
        title: "Polymarket Trading",
        description:
          "Your agent watches Polymarket 24/7 so you don't have to. It tracks odds shifts, cross-references breaking news and Twitter sentiment, and messages you the moment something moves. Wake up to a briefing on overnight changes — complete with source links and a recommended play.",
      },
      {
        slug: "crypto-trading",
        title: "Crypto Trading & Earning",
        description:
          "Your agent doesn't just trade — it earns. It completes bounties, freelance tasks, and microjobs across multiple AI agent marketplaces and crypto platforms while you sleep. On top of that, it monitors token prices across chains, tracks whale movements and liquidity shifts, and delivers real-time DeFi opportunities straight to Telegram. One agent, multiple income streams, zero effort from you.",
      },
    ],
  },
  {
    title: "Productivity & Intelligence",
    items: [
      {
        title: "Personal Assistant & Second Brain",
        description:
          "Imagine an assistant that never forgets anything. Your agent remembers every client detail, every project note, every preference you've ever mentioned. Ask it \"what did I decide about the pricing change last Tuesday?\" and get an instant answer. It delivers daily briefings, tracks your priorities, and builds a searchable memory of your entire life.",
      },
      {
        slug: "business-automation",
        title: "Business Automation",
        description:
          "Stop spending your mornings on busywork. Your agent triages your inbox overnight, generates the weekly report you've been putting off, updates your CRM, and sends follow-up emails to leads who went cold. You open your laptop and the grunt work is already done.",
      },
      {
        title: "Competitive Intelligence",
        description:
          "Wake up to a full competitor analysis your agent compiled overnight. It monitors competitor websites for pricing changes, tracks their social media activity, scrapes job postings for strategic signals, and delivers a daily digest with everything that changed. You'll know about their moves before their own customers do.",
      },
      {
        title: "Email & Communication Automation",
        description:
          "Your agent reads every incoming email, drafts replies in your voice, flags what's urgent, and archives the noise. Schedule messages to go out at the perfect time. Set up auto-replies for common questions. Go on vacation and come back to a clean inbox — not 400 unread messages.",
      },
    ],
  },
  {
    title: "Technical & Development",
    items: [
      {
        title: "Code Execution & Development",
        description:
          "Your agent runs on a full Linux VM with shell access. Ask it to write a Python script that processes your CSV data, deploy a web scraper, or build a cron job that checks inventory levels every hour. It writes the code, runs it, debugs errors, and delivers results — no IDE required.",
      },
      {
        title: "Scheduled Tasks & Background Automation",
        description:
          "Set it and forget it. Your agent runs tasks on a schedule — scrape prices every morning, generate reports every Friday, check uptime every 5 minutes, post to social media at peak hours. It works while you sleep, while you're in meetings, while you're on vacation. You come back to results, not to-do lists.",
      },
      {
        slug: "shopify-management",
        title: "Shopify Management",
        description:
          "Your agent manages your store while you focus on growth. It updates product descriptions, adjusts prices based on rules you set, responds to customer inquiries within minutes, and sends you a daily sales summary with trends and anomalies flagged. During a flash sale, it monitors inventory in real time and pauses ads before you oversell.",
      },
    ],
  },
  {
    title: "Content & Social",
    items: [
      {
        slug: "video-creation",
        title: "Video Creation",
        description:
          "Describe a video idea in plain English and your agent handles the rest — scriptwriting, scene generation, voiceover, editing, and export. Produce TikToks, YouTube Shorts, and Instagram Reels without touching a timeline. One user makes 30 videos a week. They used to make two.",
      },
      {
        slug: "social-media",
        title: "Social Media Management",
        description:
          "Your agent drafts posts that actually sound like you, schedules them for peak engagement times, monitors comments and DMs, and tracks what's performing. It can repurpose a blog post into a Twitter thread, a LinkedIn update, and an Instagram caption — all at once, all on brand.",
      },
      {
        title: "Real-Time Twitter/X Monitoring",
        description:
          "Track any keyword, hashtag, or account on X in real time. Your agent watches for mentions of your brand, competitors, or industry topics and sends alerts straight to Telegram. Spot viral threads early, catch PR crises before they snowball, and never miss a conversation that matters to your business.",
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
          "Have a patient, always-available conversation partner in any language. Your agent corrects your grammar in real time, explains nuances, builds custom vocabulary lists from topics you care about, and adjusts difficulty as you improve. It's like having a private tutor who's available at 2am and never gets tired.",
      },
      {
        slug: "research-assistant",
        title: "Research Assistant",
        description:
          "Give your agent a question and come back to a full research brief. It searches the web, reads dozens of sources, extracts key findings, cross-references claims, and compiles everything into a structured report with citations. What used to take you a full afternoon takes your agent about ten minutes.",
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
                {category.items.map((item) => {
                  const cardStyle = {
                    background:
                      "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
                    boxShadow:
                      "rgba(0,0,0,0.05) 0px 2px 2px 0px inset, rgba(255,255,255,0.5) 0px -2px 2px 0px inset, rgba(0,0,0,0.1) 0px 2px 4px 0px, rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset",
                  };
                  const inner = (
                    <>
                      <h3
                        className="text-lg font-semibold mb-2"
                        style={{ color: "#333334" }}
                      >
                        {item.title}
                      </h3>
                      <p className="text-sm" style={{ color: "#6b6b6b" }}>
                        {item.description}
                      </p>
                      {item.slug && (
                        <span
                          className="inline-block mt-3 text-xs font-medium"
                          style={{ color: "#DC6743" }}
                        >
                          Learn more →
                        </span>
                      )}
                    </>
                  );
                  return item.slug ? (
                    <Link
                      key={item.slug}
                      href={`/use-cases/${item.slug}`}
                      className="block rounded-xl p-6 transition-all hover:scale-[1.01]"
                      style={cardStyle}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div
                      key={item.title}
                      className="rounded-xl p-6"
                      style={cardStyle}
                    >
                      {inner}
                    </div>
                  );
                })}
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
