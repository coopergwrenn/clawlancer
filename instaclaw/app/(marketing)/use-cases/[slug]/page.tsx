import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SITE_URL, SITE_NAME, TWITTER_HANDLE } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

interface UseCaseData {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  headline: string;
  intro: string;
  sections: { heading: string; content: string }[];
  howToStart: string[];
  relatedSlugs: string[];
}

const useCases: UseCaseData[] = [
  {
    slug: "polymarket-trading",
    title: "Polymarket Trading",
    metaTitle: "Use InstaClaw for Polymarket Trading — AI-Powered Prediction Markets",
    metaDescription: "Automate your Polymarket research with a personal AI agent. Track odds, get real-time alerts, analyze prediction market trends, and make data-driven bets.",
    headline: "Automate Your Polymarket Research with AI",
    intro: "Prediction markets move fast. By the time you've finished reading the news, odds have already shifted. InstaClaw gives you a personal AI agent that monitors Polymarket events 24/7, tracks odds movements, researches outcomes, and alerts you to opportunities — all while you sleep.",
    sections: [
      {
        heading: "Why Use an AI Agent for Polymarket?",
        content: "Polymarket traders who research more win more — but research takes time. Your InstaClaw agent can search the web for breaking news, analyze sentiment across social media, track historical odds data, compare multiple prediction markets, and compile everything into actionable summaries. It monitors the markets continuously, not just when you're online.\n\nUnlike manual research or basic alerts, your agent understands context. It knows the difference between a minor rumor and a significant development. It can cross-reference multiple sources, fact-check claims, and assess the reliability of information — giving you a genuine edge.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your InstaClaw agent can monitor specific Polymarket events and alert you when odds change significantly, research the underlying events by searching news, Twitter/X, and other sources, generate daily or weekly prediction market briefings, track your portfolio of positions and P&L, compare odds across multiple prediction market platforms, analyze historical resolution patterns for similar markets, and set up custom alerts based on your trading criteria.",
      },
      {
        heading: "Real-World Example",
        content: "Say you're tracking a political event on Polymarket. Your agent monitors 20+ news sources, Twitter sentiment, and polling data. At 3am, a major development breaks. Your agent catches it, cross-references with other sources, assesses the impact on odds, and sends you a Telegram message with a summary and suggested action — all before most traders wake up.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect Telegram",
      "Tell your agent which Polymarket events you want to track",
      "Set your alert thresholds (e.g., 'notify me if odds move more than 5%')",
      "Ask for daily briefings on your active markets",
      "Your agent runs 24/7 — you'll never miss a market-moving event",
    ],
    relatedSlugs: ["crypto-trading", "research-assistant", "business-automation"],
  },
  {
    slug: "shopify-management",
    title: "Shopify Management",
    metaTitle: "Use InstaClaw for Shopify Store Management — AI-Powered E-Commerce",
    metaDescription: "Manage your Shopify store with a personal AI agent. Automate product updates, track orders, handle customer inquiries, and analyze sales data.",
    headline: "Run Your Shopify Store with AI Assistance",
    intro: "Managing a Shopify store means juggling product listings, order tracking, customer support, inventory management, and sales analytics — often all at once. InstaClaw gives you a personal AI agent that handles the repetitive work so you can focus on growing your business.",
    sections: [
      {
        heading: "Why Use an AI Agent for Shopify?",
        content: "E-commerce success depends on speed and consistency. Customers expect fast responses, accurate product information, and smooth order fulfillment. But as your store grows, keeping up becomes impossible without help.\n\nYour InstaClaw agent operates 24/7, handling tasks that would otherwise pile up. It can process customer emails, update product descriptions, track shipments, flag low inventory, and generate sales reports — all without you lifting a finger.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your agent can draft responses to customer inquiries and support tickets, update product titles, descriptions, and pricing in bulk, monitor inventory levels and alert you when stock is low, generate daily or weekly sales reports with key metrics, track orders and provide shipping status updates, research competitor pricing and suggest adjustments, compile customer feedback and identify common issues, and create product listing drafts for new items.",
      },
      {
        heading: "Scaling Without Hiring",
        content: "Hiring a virtual assistant costs $500-2000/month. Your InstaClaw agent handles many of the same tasks for a fraction of the cost, runs around the clock, never calls in sick, and gets smarter over time as it learns your store's patterns and your preferences.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect your messaging app",
      "Tell your agent about your Shopify store and products",
      "Set up daily reporting ('every morning, send me yesterday's sales summary')",
      "Forward customer emails to your agent for draft responses",
      "Ask your agent to monitor inventory and alert you on low stock",
    ],
    relatedSlugs: ["business-automation", "social-media", "research-assistant"],
  },
  {
    slug: "video-creation",
    title: "Video Creation",
    metaTitle: "Use InstaClaw for AI Video Creation — Automated Content Production",
    metaDescription: "Create videos with a personal AI agent. Generate scripts, produce short-form content, edit clips, and publish to YouTube, TikTok, and Instagram automatically.",
    headline: "Create Videos Automatically with Your AI Agent",
    intro: "Video content is king, but creating it is time-consuming. Scripting, editing, rendering, and publishing across platforms can eat up your entire day. InstaClaw gives you a personal AI agent that handles the heavy lifting of video production — from ideation to publishing.",
    sections: [
      {
        heading: "Why Use an AI Agent for Video?",
        content: "The creators who win are the ones who publish consistently. But quality video production takes time — research, scripting, editing, thumbnail creation, caption writing, and cross-platform publishing. Most solo creators can manage 2-3 videos per week at best.\n\nYour InstaClaw agent can handle many of these steps autonomously. It researches trending topics, drafts scripts based on your style, generates short-form video content, creates thumbnails, writes descriptions and captions, and can even schedule posts across platforms.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your agent can research trending topics in your niche, write video scripts tailored to your voice and audience, generate short-form videos using AI video tools, create thumbnail concepts and social media graphics, write SEO-optimized titles, descriptions, and tags, draft social media captions for cross-posting, schedule content across YouTube, TikTok, and Instagram, and track performance metrics across platforms.",
      },
      {
        heading: "From Idea to Published — While You Sleep",
        content: "Imagine waking up to a fully scripted video ready for your review, with thumbnails, captions, and scheduling suggestions already prepared. Your agent does the 80% that's tedious so you can focus on the 20% that requires your creative touch.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect Telegram",
      "Tell your agent about your content niche, style, and target audience",
      "Ask it to research trending topics and draft scripts",
      "Enable the video creation skill from your dashboard",
      "Set up a content calendar: 'draft 3 video scripts per week on AI trends'",
    ],
    relatedSlugs: ["social-media", "business-automation", "research-assistant"],
  },
  {
    slug: "language-learning",
    title: "Language Learning",
    metaTitle: "Use InstaClaw for Language Learning — Your 24/7 AI Language Partner",
    metaDescription: "Learn a new language with a personal AI agent. Practice conversations, get grammar corrections, build vocabulary, and immerse yourself 24/7.",
    headline: "Learn Any Language with a 24/7 AI Conversation Partner",
    intro: "The best way to learn a language is immersion — but most people can't move to another country. InstaClaw gives you the next best thing: a personal AI agent that speaks your target language fluently, corrects your mistakes gently, adapts to your level, and is available for practice anytime, day or night.",
    sections: [
      {
        heading: "Why Use an AI Agent for Language Learning?",
        content: "Traditional language apps teach you vocabulary and grammar rules, but they can't hold a conversation. Language tutors are expensive and scheduling-dependent. Your InstaClaw agent combines the best of both worlds: unlimited conversation practice with real-time corrections, available 24/7, for a fraction of the cost of a tutor.\n\nBecause your agent has persistent memory, it remembers your level, the vocabulary you've struggled with, topics you enjoy, and your learning goals. Every conversation picks up where the last one left off.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your agent can hold natural conversations in your target language at your level, gently correct grammar and vocabulary mistakes with explanations, introduce new vocabulary in context during conversations, create custom exercises and quizzes based on your weak areas, translate phrases and explain nuances between similar words, practice specific scenarios (ordering food, job interviews, phone calls), track your progress and suggest areas to focus on, and send daily vocabulary words or conversation prompts.",
      },
      {
        heading: "Better Than Apps, Cheaper Than Tutors",
        content: "Duolingo costs $7/month but can't hold a conversation. A private tutor costs $30-60/hour with scheduling constraints. Your InstaClaw agent provides unlimited conversation practice, adapts to your level in real-time, and is available at 3am when you can't sleep and want to practice Spanish — all for $29/month.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect Telegram",
      "Tell your agent which language you're learning and your current level",
      "Set your learning goals ('I want to be conversational in French in 6 months')",
      "Start chatting in your target language — your agent will adapt",
      "Ask for daily vocabulary words or weekly conversation topics",
    ],
    relatedSlugs: ["research-assistant", "business-automation", "social-media"],
  },
  {
    slug: "business-automation",
    title: "Business Automation",
    metaTitle: "Use InstaClaw for Business Automation — AI-Powered Workflow Automation",
    metaDescription: "Automate business tasks with a personal AI agent. Email triage, report generation, scheduling, data entry, and repetitive workflow automation.",
    headline: "Automate Your Business Operations with AI",
    intro: "Every business has tasks that eat up hours every week: sorting emails, generating reports, scheduling meetings, updating spreadsheets, following up with leads. InstaClaw gives you a personal AI agent that handles these repetitive tasks around the clock, so you can focus on the work that actually moves the needle.",
    sections: [
      {
        heading: "Why Use an AI Agent for Business?",
        content: "Small business owners and professionals spend an average of 2-3 hours per day on administrative tasks. That's 10-15 hours per week — over 600 hours per year — spent on work that doesn't directly generate revenue.\n\nYour InstaClaw agent can take over the bulk of this administrative burden. It understands your business context, learns your preferences, and gets better over time. Unlike a virtual assistant, it never sleeps, never forgets, and costs a fraction of the price.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your agent can triage your inbox and draft responses to routine emails, generate daily, weekly, or monthly reports from your data, schedule meetings and manage your calendar, research prospects, competitors, or market trends, create and update documents, spreadsheets, and presentations, follow up with leads and clients on your behalf, monitor industry news and summarize relevant developments, and automate data entry and CRM updates.",
      },
      {
        heading: "Save 10+ Hours Per Week",
        content: "Imagine starting each morning with your inbox sorted, a summary of yesterday's key metrics, a list of today's priorities, and draft responses to your most important emails — all waiting for you before you've had your first coffee. That's what your InstaClaw agent delivers, every single day.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect your preferred messaging app",
      "Tell your agent about your business, role, and daily workflows",
      "Start with one task: 'every morning at 7am, send me a summary of my inbox'",
      "Gradually add more automations as you get comfortable",
      "Teach your agent your preferences by giving feedback on its outputs",
    ],
    relatedSlugs: ["shopify-management", "research-assistant", "social-media"],
  },
  {
    slug: "research-assistant",
    title: "Research Assistant",
    metaTitle: "Use InstaClaw as Your AI Research Assistant — Deep Research on Demand",
    metaDescription: "Use a personal AI agent for research. Search the web, summarize papers, compile reports, track topics, and organize findings automatically.",
    headline: "Your Personal AI Research Assistant",
    intro: "Whether you're a student, journalist, analyst, or just someone who needs to stay informed, research is time-consuming. InstaClaw gives you a personal AI agent that searches the web, summarizes findings, compiles reports, and tracks topics — producing in hours what would take you days.",
    sections: [
      {
        heading: "Why Use an AI Agent for Research?",
        content: "Good research requires breadth (searching many sources) and depth (reading and synthesizing carefully). Doing both manually is exhausting. ChatGPT can help with synthesis but can't search the web or access current information reliably.\n\nYour InstaClaw agent has web search capabilities, can access real-time information, and runs on a dedicated machine with persistent memory. It can search dozens of sources, read and summarize articles, cross-reference findings, identify patterns, and compile everything into structured reports — all while maintaining context from previous research sessions.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your agent can search the web across multiple sources for any topic, summarize articles, papers, and reports into key takeaways, compile structured research briefs with citations, track topics over time and alert you to new developments, compare and contrast information from different sources, organize findings into categories and themes, generate literature reviews and background summaries, and export research in various formats (bullet points, executive summaries, detailed reports).",
      },
      {
        heading: "Research That Compounds",
        content: "Because your agent has persistent memory, every research session builds on the last. Ask it to research 'the latest in AI regulation' today, and next week it already has context. Over time, your agent develops a deep knowledge base about your areas of interest — making each subsequent research task faster and more accurate.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect Telegram",
      "Give your agent a research topic: 'research the current state of AI regulation in the EU'",
      "Ask for specific deliverables: 'compile a 1-page summary with key points and sources'",
      "Set up ongoing tracking: 'every Friday, send me a summary of AI news this week'",
      "Build your agent's knowledge base by asking follow-up questions on past research",
    ],
    relatedSlugs: ["business-automation", "language-learning", "crypto-trading"],
  },
  {
    slug: "social-media",
    title: "Social Media Management",
    metaTitle: "Use InstaClaw for Social Media Management — AI Content & Engagement",
    metaDescription: "Manage social media with a personal AI agent. Draft posts, schedule content, monitor mentions, analyze engagement, and grow your audience automatically.",
    headline: "Manage Your Social Media with AI",
    intro: "Consistent social media presence requires daily attention — drafting posts, engaging with comments, tracking trends, and analyzing what works. InstaClaw gives you a personal AI agent that handles the grind of social media management so you can focus on creating great content.",
    sections: [
      {
        heading: "Why Use an AI Agent for Social Media?",
        content: "Social media algorithms reward consistency. Posting regularly, engaging with your audience, and staying on top of trends is how you grow — but it's also incredibly time-consuming. Most creators and businesses struggle to maintain presence across multiple platforms.\n\nYour InstaClaw agent monitors trends, drafts platform-specific content, tracks engagement metrics, and helps you stay consistent — all without you having to check every platform multiple times a day.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your agent can draft posts tailored to each platform (Twitter/X, LinkedIn, Instagram, TikTok), research trending topics and hashtags in your niche, create content calendars with scheduled posting suggestions, monitor mentions and conversations about your brand or topics, analyze engagement metrics and suggest what's working, repurpose content across platforms (turn a blog post into tweets, a thread into a LinkedIn post), draft replies to comments and messages, and track competitor activity and content strategies.",
      },
      {
        heading: "Scale Your Presence Without Burning Out",
        content: "Social media managers cost $2,000-5,000/month. Your InstaClaw agent handles the research, drafting, and analytics that make up 70% of social media work. You review, approve, and add your personal touch — turning what used to be 2 hours/day into 20 minutes.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect your messaging app",
      "Tell your agent about your brand, audience, and social media goals",
      "Ask it to create a content calendar for the next week",
      "Set up daily content drafts: 'every morning, draft 3 tweets about AI news'",
      "Ask for weekly analytics summaries to track what's working",
    ],
    relatedSlugs: ["video-creation", "business-automation", "research-assistant"],
  },
  {
    slug: "crypto-trading",
    title: "Crypto Trading",
    metaTitle: "Use InstaClaw for Crypto Trading — AI-Powered DeFi & Token Analysis",
    metaDescription: "Monitor crypto markets with a personal AI agent. Track token prices, analyze on-chain data, get wallet alerts, and research DeFi opportunities 24/7.",
    headline: "Monitor Crypto Markets 24/7 with Your AI Agent",
    intro: "Crypto markets never sleep, but you do. InstaClaw gives you a personal AI agent that monitors token prices, tracks wallet activity, analyzes on-chain data, researches new projects, and alerts you to opportunities — around the clock, even at 3am on a Sunday.",
    sections: [
      {
        heading: "Why Use an AI Agent for Crypto?",
        content: "The crypto market operates 24/7/365 across thousands of tokens, hundreds of DeFi protocols, and dozens of chains. No human can monitor all of it. Most traders miss opportunities simply because they were asleep or distracted when something happened.\n\nYour InstaClaw agent watches the market continuously. It can track specific tokens, monitor whale wallets, analyze on-chain metrics, search for breaking news, and alert you based on your custom criteria. It combines multiple data sources into actionable intelligence faster than any manual process.",
      },
      {
        heading: "What Your Agent Can Do",
        content: "Your agent can monitor token prices and alert you on significant movements, track whale wallets and large transactions, research new token launches and assess fundamentals, analyze DeFi protocol yields and suggest opportunities, compile daily or weekly crypto market summaries, monitor Twitter/X crypto influencers for early signals, track your portfolio value across wallets and chains, set up complex alerts ('notify me if ETH drops below $3,000 and BTC is also down more than 5%'), and research smart contract audit reports and security assessments.",
      },
      {
        heading: "Your Edge in a 24/7 Market",
        content: "The biggest crypto moves often happen outside business hours — on weekends, holidays, and overnight. Your InstaClaw agent is always watching. When a whale moves $10M of ETH to an exchange at 4am, or a major protocol announces a vulnerability, you'll know about it immediately — not when you check Twitter at breakfast.",
      },
    ],
    howToStart: [
      "Sign up for InstaClaw and connect Telegram",
      "Tell your agent which tokens, wallets, and protocols you want to track",
      "Set up price alerts: 'notify me if SOL moves more than 10% in a day'",
      "Ask for daily market summaries: 'every morning, send me the top crypto news and market overview'",
      "Enable the crypto trading skill for on-chain data and wallet tracking",
    ],
    relatedSlugs: ["polymarket-trading", "research-assistant", "business-automation"],
  },
];

export function generateStaticParams() {
  return useCases.map((uc) => ({ slug: uc.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const uc = useCases.find((u) => u.slug === slug);
  if (!uc) return {};
  const url = `${SITE_URL}/use-cases/${uc.slug}`;
  return {
    title: uc.metaTitle,
    description: uc.metaDescription,
    alternates: { canonical: url },
    openGraph: {
      title: uc.metaTitle,
      description: uc.metaDescription,
      url,
      siteName: SITE_NAME,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title: uc.metaTitle,
      description: uc.metaDescription,
      site: TWITTER_HANDLE,
    },
  };
}

export default async function UseCasePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const uc = useCases.find((u) => u.slug === slug);
  if (!uc) notFound();

  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: uc.headline,
    description: uc.metaDescription,
    url: `${SITE_URL}/use-cases/${uc.slug}`,
    publisher: {
      "@type": "Organization",
      name: "InstaClaw",
      url: SITE_URL,
    },
  };

  const related = uc.relatedSlugs
    .map((s) => useCases.find((u) => u.slug === s))
    .filter(Boolean) as UseCaseData[];

  return (
    <>
      <JsonLd data={articleJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-3xl mx-auto">
          <Link
            href="/use-cases"
            className="text-sm hover:underline mb-8 inline-block"
            style={{ color: "#6b6b6b" }}
          >
            &larr; All Use Cases
          </Link>

          <h1
            className="text-4xl sm:text-5xl font-normal tracking-[-1px] leading-[1.05] mb-6"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            {uc.headline}
          </h1>

          <p
            className="text-base sm:text-lg leading-relaxed mb-12"
            style={{ color: "#6b6b6b" }}
          >
            {uc.intro}
          </p>

          <div className="space-y-10">
            {uc.sections.map((section) => (
              <div key={section.heading}>
                <h2
                  className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {section.heading}
                </h2>
                {section.content.split("\n\n").map((paragraph, i) => (
                  <p
                    key={i}
                    className="text-sm leading-relaxed mb-4"
                    style={{ color: "#6b6b6b" }}
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            ))}
          </div>

          {/* How to get started */}
          <div className="mt-12">
            <h2
              className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              How to Get Started
            </h2>
            <ol className="space-y-2 text-sm" style={{ color: "#6b6b6b" }}>
              {uc.howToStart.map((step, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span
                    className="shrink-0 mt-0.5 font-medium"
                    style={{ color: "#DC6743" }}
                  >
                    {i + 1}.
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          {/* Related use cases */}
          {related.length > 0 && (
            <div className="mt-16">
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-6"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                Related Use Cases
              </h2>
              <div className="grid gap-4 sm:grid-cols-3">
                {related.map((r) => (
                  <Link
                    key={r.slug}
                    href={`/use-cases/${r.slug}`}
                    className="block rounded-xl p-5 transition-all hover:scale-[1.01]"
                    style={{
                      background:
                        "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
                      boxShadow:
                        "rgba(0,0,0,0.05) 0px 2px 2px 0px inset, rgba(255,255,255,0.5) 0px -2px 2px 0px inset, rgba(0,0,0,0.1) 0px 2px 4px 0px",
                    }}
                  >
                    <h3
                      className="text-sm font-semibold mb-1"
                      style={{ color: "#333334" }}
                    >
                      {r.title}
                    </h3>
                    <span
                      className="text-xs"
                      style={{ color: "#DC6743" }}
                    >
                      Learn more →
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div
            className="text-center mt-12 text-sm"
            style={{ color: "#6b6b6b" }}
          >
            <p>
              <Link
                href="/pricing"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                View pricing
              </Link>{" "}
              ·{" "}
              <Link
                href="/how-it-works"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                How it works
              </Link>
            </p>
          </div>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}
