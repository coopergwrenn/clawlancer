import { SITE_URL } from "./seo";

export interface PublicRoute {
  path: string;
  label: string;
  changeFrequency:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority: number;
}

export const PUBLIC_ROUTES: PublicRoute[] = [
  { path: "/", label: "Home", changeFrequency: "weekly", priority: 1.0 },
  { path: "/pricing", label: "Pricing", changeFrequency: "weekly", priority: 0.9 },
  { path: "/how-it-works", label: "How It Works", changeFrequency: "monthly", priority: 0.9 },
  { path: "/faq", label: "FAQ", changeFrequency: "monthly", priority: 0.8 },
  { path: "/about", label: "About", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs", label: "Docs", changeFrequency: "monthly", priority: 0.8 },
  { path: "/docs/dispatch", label: "Dispatch Mode", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases", label: "Use Cases", changeFrequency: "monthly", priority: 0.8 },
  { path: "/use-cases/polymarket-trading", label: "Polymarket Trading", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases/shopify-management", label: "Shopify Management", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases/video-creation", label: "Video Creation", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases/language-learning", label: "Language Learning", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases/business-automation", label: "Business Automation", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases/research-assistant", label: "Research Assistant", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases/social-media", label: "Social Media", changeFrequency: "monthly", priority: 0.7 },
  { path: "/use-cases/crypto-trading", label: "Crypto Trading", changeFrequency: "monthly", priority: 0.7 },
  { path: "/compare/instaclaw-vs-self-hosting", label: "InstaClaw vs Self-Hosting", changeFrequency: "monthly", priority: 0.7 },
  { path: "/blog", label: "Blog", changeFrequency: "weekly", priority: 0.8 },
  { path: "/blog/what-is-openclaw", label: "What is OpenClaw?", changeFrequency: "monthly", priority: 0.7 },
  { path: "/blog/what-is-a-personal-ai-agent", label: "What is a Personal AI Agent?", changeFrequency: "monthly", priority: 0.7 },
  { path: "/blog/deploy-openclaw-no-code", label: "Deploy OpenClaw No Code", changeFrequency: "monthly", priority: 0.7 },
  { path: "/blog/ai-agent-passive-income", label: "AI Agent Passive Income", changeFrequency: "monthly", priority: 0.7 },
  { path: "/blog/best-openclaw-hosting-providers", label: "Best OpenClaw Hosting", changeFrequency: "monthly", priority: 0.7 },
  { path: "/blog/ai-agent-telegram-bot", label: "How to Build a Telegram Bot with an AI Agent", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/what-can-ai-agents-do", label: "10 Things Your AI Agent Can Do That You Didn't Know About", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/personal-ai-agent-vs-chatbot", label: "Personal AI Agent vs AI Chatbot — What's the Difference?", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/ai-agent-video-creation", label: "AI Agents for Video Creation — How It Works", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/openclaw-hosting-cost", label: "How Much Does It Cost to Run OpenClaw? Full Breakdown", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/ai-agent-content-creation", label: "How AI Agents Are Revolutionizing Content Creation", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/best-ai-agent-platforms-2026", label: "Best AI Agent Platforms in 2026 — Compared", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/future-of-personal-ai", label: "The Future of Personal AI — What's Coming in 2026 and Beyond", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/openclaw-api-guide", label: "OpenClaw API — The Developer's Guide", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/ai-agent-polymarket", label: "Using AI Agents for Polymarket — A Complete Guide", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/openclaw-vs-autogpt", label: "OpenClaw vs AutoGPT — Which AI Agent Framework is Better?", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/ai-agent-for-research", label: "How to Use an AI Agent as Your Personal Research Assistant", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/why-everyone-needs-ai-agent", label: "Why Everyone Will Have a Personal AI Agent by 2027", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/openclaw-skills-guide", label: "The Complete Guide to OpenClaw Skills (2026)", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/personal-ai-vs-business-ai", label: "Personal AI vs Business AI — Which Do You Need?", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/ai-agent-for-crypto", label: "How to Use an AI Agent for Crypto Trading and Research", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/make-money-ai-agent", label: "5 Ways to Make Money with Your AI Agent in 2026", changeFrequency: "monthly", priority: 0.6 },
  { path: "/blog/openclaw-security", label: "Is OpenClaw Safe? Security and Privacy Explained", changeFrequency: "monthly", priority: 0.6 },
  { path: "/privacy", label: "Privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", label: "Terms", changeFrequency: "yearly", priority: 0.3 },
];

export function fullUrl(path: string): string {
  return `${SITE_URL}${path}`;
}
