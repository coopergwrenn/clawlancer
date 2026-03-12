import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "InstaClaw FAQ — Everything About Personal AI Agents",
  description:
    "Answers to 28+ questions about InstaClaw, OpenClaw, personal AI agents, pricing, BYOK mode, credits, privacy, skills, and more.",
  path: "/faq",
});

/* ── FAQ Data ─────────────────────────────────────────────────────── */

const aboutItems = [
  {
    question: "What is InstaClaw?",
    answer:
      "InstaClaw is a personal AI that actually does things for you — not just chat. It can send emails, manage your calendar, search the web, organize files, and handle tasks around the clock. You talk to it through Telegram, Discord, Slack, or WhatsApp, just like texting a friend. Each user gets a dedicated OpenClaw instance running on an isolated virtual machine.",
  },
  {
    question: "How is InstaClaw different from ChatGPT?",
    answer:
      "ChatGPT can only talk. InstaClaw can act. It has its own computer, so it can browse the web, run code, manage files, and use real tools on your behalf. It maintains persistent memory across conversations and runs 24/7 on a dedicated machine — ChatGPT runs in a sandboxed session with no persistence.",
  },
  {
    question: "What can it actually do for me?",
    answer:
      "Sort and reply to your emails, research topics and summarize findings, manage your schedule, generate reports, post to social media, monitor websites, automate repetitive tasks, create videos, trade crypto, and much more. It comes pre-loaded with 20+ powerful skills and learns your preferences over time.",
  },
  {
    question: "What is OpenClaw?",
    answer:
      "OpenClaw is the open-source personal AI agent framework that powers InstaClaw. It's a complete runtime that gives an AI agent its own compute environment with shell access, persistent memory, skills, and tool integration. InstaClaw handles the hosting, configuration, and maintenance of OpenClaw for you.",
  },
];

const gettingStartedItems = [
  {
    question: "Do I need any technical knowledge?",
    answer:
      "Not at all. You just talk to it in plain English. Setup takes about 2 minutes — you create a Telegram bot, paste the token, pick a plan, and you're live. No coding, no configuration, no terminal. That said, if you are technical, you get full SSH access to the underlying VM.",
  },
  {
    question: "How do I set up my agent?",
    answer:
      "Sign up, connect your messaging app (Telegram, Discord, Slack, or WhatsApp), pick a plan, and you're live. The entire process takes about 2 minutes. We walk you through every step in the dashboard.",
  },
  {
    question: "How do I connect Telegram?",
    answer:
      "In Telegram, message @BotFather to create a new bot. Copy the API token, paste it into your InstaClaw dashboard, and click Connect. Your agent will be live within seconds.",
  },
  {
    question: "Can I use multiple messaging apps?",
    answer:
      "Yes. Your agent is accessible via Telegram, Discord, Slack, and WhatsApp. You can connect multiple platforms simultaneously — they all talk to the same agent with the same memory.",
  },
];

const skillsItems = [
  {
    question: "What are skills?",
    answer:
      "Skills are superpowers you can add to your AI. Things like searching X/Twitter, monitoring websites, managing your inbox, creating videos, or trading crypto. Every InstaClaw agent comes pre-loaded with 20+ skills, and we're constantly adding new ones. You can also teach your agent new skills just by talking to it.",
  },
  {
    question: "How do I manage skills and API keys?",
    answer:
      "Everything lives in your dashboard. You can browse available skills, add them with one click, and see all the skills your agent has learned. For API keys, paste your key and you're done — keys are encrypted at rest with AES-256.",
  },
  {
    question: "Can I teach my agent new things?",
    answer:
      "Yes. Just talk to it. If you walk your agent through a workflow via chat, it saves it as a reusable skill that syncs to your dashboard. The more you use it, the smarter it gets.",
  },
  {
    question: "What AI model does it use?",
    answer:
      "InstaClaw runs on Claude by Anthropic — the same models behind Claude.ai. On All-Inclusive plans, the default is Claude Haiku 4.5 (fast and efficient). You can upgrade to Sonnet 4.6 or Opus 4.6 anytime — just tell your bot 'use Sonnet' or 'switch to Opus'. BYOK users can configure any Claude model.",
  },
];

const pricingItems = [
  {
    question: "How much does InstaClaw cost?",
    answer:
      "Starter: $29/month, Pro: $99/month, Power: $299/month. All plans include a 3-day free trial with full access. BYOK pricing is roughly half: $14, $39, and $99/month respectively.",
  },
  {
    question: "What are credits/units?",
    answer:
      "Every message your AI handles uses a small number of units. Haiku costs 1 unit, Sonnet costs 4, Opus costs 19. Starter gives you 600 units/day, Pro gives you 1,000/day, and Power gives you 2,500/day. Limits reset at midnight UTC.",
  },
  {
    question: "What happens when I run out of daily units?",
    answer:
      "Your agent pauses until midnight UTC when limits reset. You can also purchase credit packs (50/$5, 200/$15, 500/$30) that kick in instantly.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "Yes — every plan comes with a 3-day free trial. Full access to everything, no restrictions. You won't be charged until the trial ends, and you can cancel anytime before that.",
  },
  {
    question: "Can I cancel anytime?",
    answer:
      "Yes, no questions asked. Cancel from your dashboard whenever you want. No contracts, no cancellation fees, no hoops to jump through.",
  },
];

const byokItems = [
  {
    question: "What's BYOK mode?",
    answer:
      "Bring Your Own Key. If you already have an Anthropic API key, connect it directly and pay Anthropic for AI usage yourself. This cuts your InstaClaw subscription roughly in half. Your API key is encrypted at rest and stored on your VM only — all API calls go directly from your VM to Anthropic.",
  },
  {
    question: "Do I get full access to the server?",
    answer:
      "Yes. You get your own dedicated Ubuntu VM with full SSH access (key-based auth). You can install software, run custom scripts, set up cron jobs, run background services — it's your machine. The AI has the same access, so you can also just ask it to do things for you.",
  },
  {
    question: "What are the server specs?",
    answer:
      "Each VM runs Ubuntu with 3 vCPU, 4GB RAM, and 80GB SSD. Pre-installed: Python 3, Node.js, Docker-ready, OpenClaw runtime with local API gateway. Power plan users get upgraded resources.",
  },
  {
    question: "Can I install custom software?",
    answer:
      "Yes. You have full SSH root-equivalent access. Install any apt/pip/npm package, set up databases, run Docker containers — it's a real Linux server.",
  },
];

const privacyItems = [
  {
    question: "Is my data private?",
    answer:
      "Yes. Every user gets their own isolated server — your data never touches another user's environment. We don't train on your conversations or share your information. Conversations are stored on your VM only. API keys are encrypted at rest using AES-256.",
  },
  {
    question: "Where is my data stored?",
    answer:
      "Your AI agent, conversations, files, and memory live on your dedicated virtual machine hosted in Hetzner Cloud data centers. We don't store your conversation content on our infrastructure.",
  },
  {
    question: "Is InstaClaw secure?",
    answer:
      "Yes. Each VM is fully isolated with its own firewall rules. SSH access uses key-based authentication. API keys are encrypted with AES-256-GCM. We use end-to-end encryption for sensitive data.",
  },
];

const tokenItems = [
  {
    question: "What is the $INSTACLAW token?",
    answer:
      "The $INSTACLAW token is an AI agent token on the Virtuals Protocol. It represents InstaClaw in the Virtuals ecosystem and enables participation in the AI agent economy.",
  },
  {
    question: "What is the $CLAWLANCER token?",
    answer:
      "$CLAWLANCER is a token on Base mainnet connected to the Clawlancer AI agent marketplace — a sister project to InstaClaw focused on AI agent services.",
  },
];

const communityItems = [
  {
    question: "Does InstaClaw have a community?",
    answer:
      "Yes! Join our Discord community to connect with other users, share tips, get help, and suggest new features. Follow @instaclaws on X/Twitter for updates.",
  },
  {
    question: "How do I get support?",
    answer:
      "Pro and Power plan users get priority support. All users can reach us at support@instaclaw.io or via the Discord community.",
  },
];

/* ── All items flat for JSON-LD ───────────────────────────────────── */

const allItems = [
  ...aboutItems,
  ...gettingStartedItems,
  ...skillsItems,
  ...pricingItems,
  ...byokItems,
  ...privacyItems,
  ...tokenItems,
  ...communityItems,
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: allItems.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer,
    },
  })),
};

/* ── Sections config ──────────────────────────────────────────────── */

const sections = [
  { title: "About InstaClaw", items: aboutItems },
  { title: "Getting Started", items: gettingStartedItems },
  { title: "Skills & Capabilities", items: skillsItems },
  { title: "Pricing & Billing", items: pricingItems },
  { title: "BYOK & Advanced", items: byokItems },
  { title: "Privacy & Security", items: privacyItems },
  { title: "Tokens & Web3", items: tokenItems },
  { title: "Marketplace & Community", items: communityItems },
];

/* ── Page ─────────────────────────────────────────────────────────── */

export default function FaqPage() {
  return (
    <>
      <JsonLd data={faqJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-3xl mx-auto">
          {/* Hero */}
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Frequently Asked Questions
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              Everything you need to know about InstaClaw, personal AI agents,
              pricing, privacy, and more.
            </p>
          </div>

          {/* FAQ Sections */}
          <div className="space-y-14">
            {sections.map((section) => (
              <div key={section.title}>
                <h2
                  className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-6"
                  style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
                >
                  {section.title}
                </h2>
                <FaqAccordion items={section.items} />
              </div>
            ))}
          </div>

          {/* Cross-links */}
          <div
            className="text-center mt-16 text-sm"
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
                href="/docs"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Read the docs
              </Link>{" "}
              ·{" "}
              <Link
                href="/how-it-works"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                How it works
              </Link>{" "}
              ·{" "}
              <Link
                href="/about"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                About InstaClaw
              </Link>
            </p>
          </div>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}
