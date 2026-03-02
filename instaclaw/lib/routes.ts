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
  { path: "/privacy", label: "Privacy", changeFrequency: "yearly", priority: 0.3 },
  { path: "/terms", label: "Terms", changeFrequency: "yearly", priority: 0.3 },
];

export function fullUrl(path: string): string {
  return `${SITE_URL}${path}`;
}
