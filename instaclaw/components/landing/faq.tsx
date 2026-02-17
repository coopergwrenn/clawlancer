"use client";

import { useState } from "react";

const faqs = [
  {
    q: "What is InstaClaw?",
    a: "InstaClaw is a personal AI that actually does things for you — not just chat. It can send emails, manage your calendar, search the web, organize files, and handle tasks around the clock. You talk to it through Telegram, Discord, Slack, or WhatsApp, just like texting a friend.",
    tech: "Each user gets a dedicated OpenClaw instance running on an isolated VM. The agent has full shell access, persistent memory, skill learning, and MCP tool integration. It's not a wrapper — it's a real AI agent with its own compute environment.",
  },
  {
    q: "How is this different from ChatGPT?",
    a: "ChatGPT can only talk. InstaClaw can act. It has its own computer, so it can browse the web, run code, manage files, and use real tools on your behalf. Think of it as the difference between someone who gives advice and someone who actually does the work.",
    tech: "ChatGPT runs in a sandboxed session with no persistence. InstaClaw runs a persistent agent on a dedicated Linux VM with SSH access, file system persistence, cron scheduling, and the ability to install and run any software. It maintains long-term memory across conversations.",
  },
  {
    q: "What can it actually do for me?",
    a: "Sort and reply to your emails, research topics and summarize findings, manage your schedule, generate reports, post to social media, monitor websites, automate repetitive tasks, and much more. It comes pre-loaded with powerful skills and learns your preferences over time — the more you use it, the better it gets.",
    tech: "Under the hood: full bash shell execution, Python/Node runtime, web browsing via headless browser, file I/O, MCP tool servers, web search APIs, cron-based task scheduling, and a skills system that lets the agent learn and reuse complex workflows. The VM runs Ubuntu with 3 vCPU, 4GB RAM, and 80GB SSD.",
  },
  {
    q: "Do I need any technical knowledge?",
    a: "Not at all. You just talk to it in plain English. Setup takes about 2 minutes — you create a Telegram bot, paste the token, pick a plan, and you're live. No coding, no configuration, no terminal.",
    tech: "That said, if you are technical, you get full SSH access to the underlying VM. You can install packages, configure services, write custom scripts, and extend the agent however you want. The system is built on OpenClaw, which is fully open source.",
  },
  {
    q: "What are skills?",
    a: "Skills are superpowers you can add to your AI. Things like searching X/Twitter for the latest posts, monitoring websites, managing your inbox, or running safety checks. Every InstaClaw agent comes pre-loaded with the best skills, and we're constantly adding new ones as they come out. You can also teach your agent new skills just by talking to it.",
    tech: "Skills are MCP tool servers and OpenClaw skill packages that extend agent capabilities. We curate and pre-install top skills from the OpenClaw ecosystem. When a user teaches their agent a new workflow via chat, it's saved as a reusable skill and synced to the dashboard. Skills can also be added/removed/configured from the web dashboard. The skill system supports versioning — we push updates automatically as improved versions are released.",
  },
  {
    q: "How do I manage skills and API keys?",
    a: "Everything lives in your dashboard. You can browse available skills, add them with one click, and see all the skills your agent has learned. For API keys, we have a simple setup guide — just paste your key and you're done. You can add keys for different services to unlock even more capabilities for your agent.",
    tech: "The dashboard provides a full skill management UI: install from our curated library, view agent-learned skills (synced from chat interactions), configure per-skill settings, and manage API keys for third-party services (encrypted at rest with AES-256). Skills added via any channel (Telegram, WhatsApp, etc.) are automatically reflected in the dashboard in real time.",
  },
  {
    q: "What are credits?",
    a: "Every message your AI handles uses a small number of units. Starter gives you 400 units/day, Pro gives you 700/day, and Power gives you 2,500/day — limits reset at midnight UTC. Background heartbeat checks have their own separate budget and won't eat into your daily units. If you need more, you can grab a credit pack that kicks in instantly.",
    tech: "Units are weighted by model: Haiku costs 1 unit, Sonnet costs 4, Opus costs 19. A simple message with Haiku uses 1 unit. BYOK users bypass the unit system entirely and pay Anthropic directly. Credit packs (50/$5, 200/$15, 500/$30) are available for overflow beyond daily limits. Heartbeats run every 3 hours and consume from a dedicated 200-unit buffer that sits above the display limit.",
  },
  {
    q: "Is my data private?",
    a: "Yes. Every user gets their own isolated server — your data never touches another user's environment. We don't train on your conversations or share your information. Your AI's memory and files live on your dedicated machine only.",
    tech: "Each VM is a fully isolated cloud instance with its own firewall rules. No shared resources between users. Conversations are stored on-device only. We use end-to-end encryption for API key storage (AES-256). We never log message content on our infrastructure.",
  },
  {
    q: "Is there a free trial?",
    a: "Yes — every plan comes with a 3-day free trial. Full access to everything, no restrictions. You won't be charged until the trial ends, and you can cancel anytime before that.",
  },
  {
    q: "What's BYOK mode?",
    a: "Bring Your Own Key. If you already have an Anthropic API key (or want to get one), you can connect it directly and pay Anthropic for AI usage yourself. This cuts your InstaClaw price roughly in half. Great for power users who want more control over costs.",
    tech: "In BYOK mode, your API key is encrypted at rest and stored on your VM only. All API calls go directly from your VM to Anthropic — we never proxy or log them. You can choose any Claude model (Sonnet, Opus, Haiku) and configure rate limits, token budgets, and system prompts directly.",
  },
  {
    q: "What AI model does it use?",
    a: "InstaClaw runs on Claude by Anthropic — the same model behind Claude.ai. On All-Inclusive plans, we handle model selection automatically. On BYOK plans, you can choose your preferred Claude model and have full control over your API configuration.",
    tech: "Default model is Claude Haiku 4.5 — fast, capable, and the best value per unit. All models are always available: just tell your bot 'use Sonnet' or 'switch to Opus' mid-conversation. BYOK users can configure any Claude model via the dashboard or API.",
  },
  {
    q: "Do I get full access to the server?",
    a: "Yes. You get your own dedicated server that you can access directly. You can install software, run custom scripts, and configure it however you want. The AI has the same access, so you can also just ask it to do this for you.",
    tech: "Full SSH access (key-based auth) to a dedicated Ubuntu VM hosted in the US. Root-equivalent access for full control. Pre-installed: Python 3, Node.js, Docker-ready, OpenClaw runtime with local API gateway. You can install any apt/pip/npm package, set up cron jobs, run background services — it's your machine.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes, no questions asked. Cancel from your dashboard whenever you want. No contracts, no cancellation fees, no hoops to jump through. Your subscription ends at the close of your current billing period.",
  },
];

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="faq-section py-16 sm:py-[12vh] px-4">
      <div className="max-w-3xl mx-auto">
        <h2
          className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] text-center mb-12"
          style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
        >
          Frequently Asked Questions
        </h2>
        <div>
          {faqs.map((faq, i) => (
            <div
              key={i}
              className="faq-item"
              data-state={openIndex === i ? "open" : "closed"}
            >
              <button
                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                className="w-full text-left px-0 py-6 flex items-center justify-between cursor-pointer"
                style={{ color: "#333334" }}
              >
                <span className="font-medium text-base">{faq.q}</span>
                <span
                  className="faq-icon shrink-0 ml-4 text-xl leading-none select-none"
                  style={{ color: "#6b6b6b" }}
                >
                  +
                </span>
              </button>
              <div className="faq-answer">
                <p
                  className="text-sm leading-relaxed"
                  style={{ color: "#6b6b6b" }}
                >
                  {faq.a}
                </p>
                {faq.tech && (
                  <p
                    className="mt-3 pb-6 text-xs leading-relaxed"
                    style={{ color: "#999" }}
                  >
                    <span className="font-medium" style={{ color: "#888" }}>
                      Technical details:
                    </span>{" "}
                    {faq.tech}
                  </p>
                )}
                {!faq.tech && <div className="pb-6" />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
