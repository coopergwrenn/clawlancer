/** Map skill slugs → custom SVG icon paths. Falls back to emoji if no match. */

const SKILL_ICON_MAP: Record<string, string> = {
  "sjinn-video": "/skill-icons/sjinn-video.svg",
  "brand-design": "/skill-icons/brand-design.svg",
  "voice-audio-production": "/skill-icons/voice-audio-production.svg",
  "email-outreach": "/skill-icons/email-outreach.svg",
  "financial-analysis": "/skill-icons/financial-analysis.svg",
  "competitive-intelligence": "/skill-icons/competitive-intelligence.svg",
  "ecommerce-marketplace": "/skill-icons/ecommerce-marketplace.svg",
  "clawlancer": "/skill-icons/clawlancer.svg",
  "virtuals-agdp": "/skill-icons/virtuals-agdp.svg",
  "social-media-content": "/skill-icons/social-media-content.svg",
  "web-search": "/skill-icons/web-search.svg",
  "x-twitter-search": "/skill-icons/x-twitter-search.svg",
  "language-teacher": "/skill-icons/language-teacher.svg",
  "code-execution": "/skill-icons/code-execution.svg",
  "web-browsing": "/skill-icons/web-browsing.svg",
  "file-management": "/skill-icons/file-management.svg",
  "google-workspace": "/skill-icons/google-workspace.svg",
  "notion": "/skill-icons/notion.svg",
  "shopify": "/skill-icons/shopify.svg",
  "github": "/skill-icons/github.svg",
  "apple-notes": "/skill-icons/apple.svg",
  "apple-reminders": "/skill-icons/apple.svg",
  "trello": "/skill-icons/trello.svg",
  "slack": "/skill-icons/slack.svg",
};

export function getSkillIconPath(slug: string): string | null {
  return SKILL_ICON_MAP[slug] ?? null;
}
