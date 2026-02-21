#!/usr/bin/env npx tsx
/**
 * generate-capabilities.ts — Auto-regenerate CAPABILITIES.md on a VM
 *
 * Scans installed skills, MCP servers, and API keys to build an accurate
 * capability awareness matrix. Pushed to VMs and run during:
 *   - configureOpenClaw() completion
 *   - Skill installation (mcporter install)
 *   - API key added to .env
 *   - Manual: `npx tsx ~/scripts/generate-capabilities.ts`
 *   - Fleet push (fleet-push-capability-awareness.sh)
 *
 * Usage:
 *   npx tsx ~/scripts/generate-capabilities.ts
 *   npx tsx ~/scripts/generate-capabilities.ts --dry-run
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const WORKSPACE = path.join(
  process.env.HOME || "/home/openclaw",
  ".openclaw/workspace"
);
const SKILLS_DIR = path.join(
  process.env.HOME || "/home/openclaw",
  ".openclaw/skills"
);
const ENV_FILE = path.join(
  process.env.HOME || "/home/openclaw",
  ".openclaw/.env"
);
const OUTPUT = path.join(WORKSPACE, "CAPABILITIES.md");
const DRY_RUN = process.argv.includes("--dry-run");

// ── Scan installed skills ──
function scanSkills(): string[] {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    return fs
      .readdirSync(SKILLS_DIR)
      .filter((d) => {
        const skillMd = path.join(SKILLS_DIR, d, "SKILL.md");
        return fs.existsSync(skillMd);
      });
  } catch {
    return [];
  }
}

// ── List MCP servers ──
function listMcpServers(): string[] {
  try {
    const raw = execSync("mcporter list --json 2>/dev/null", {
      timeout: 10_000,
    }).toString();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((s: { name?: string }) => s.name || "unknown")
      : [];
  } catch {
    // mcporter might not be available or might not support --json
    try {
      const raw = execSync("mcporter list 2>/dev/null", {
        timeout: 10_000,
      }).toString();
      return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

// ── Check API keys in .env ──
function checkApiKeys(): Record<string, boolean> {
  const keys: Record<string, boolean> = {
    BRAVE_SEARCH_API_KEY: false,
    ELEVENLABS_API_KEY: false,
    ALPHAVANTAGE_API_KEY: false,
    OPENAI_API_KEY: false,
    AGENTMAIL_API_KEY: false,
    CAPTCHA_API_KEY: false,
    TWITTER_API_KEY: false,
  };

  try {
    if (!fs.existsSync(ENV_FILE)) return keys;
    const content = fs.readFileSync(ENV_FILE, "utf-8");
    for (const key of Object.keys(keys)) {
      const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
      keys[key] = !!(match && match[1].trim().length > 0);
    }
  } catch {
    // .env not readable
  }
  return keys;
}

// ── Status helper ──
function status(hasKey: boolean, hasSkill: boolean): string {
  if (hasKey && hasSkill) return "✅ Active";
  if (hasKey) return "⚠️ Key set, skill not installed";
  if (hasSkill) return "⚠️ Skill installed, key missing";
  return "❌ Not configured";
}

// ── Build the markdown ──
function buildCapabilities(): string {
  const skills = scanSkills();
  const mcpServers = listMcpServers();
  const apiKeys = checkApiKeys();
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const hasSkill = (name: string) => skills.some((s) => s.includes(name));

  const lines: string[] = [
    "# CAPABILITIES.md — What I Can Do",
    `*Last updated: ${timestamp}*`,
    `*MCP servers: ${mcpServers.length} installed*`,
    `*Skills: ${skills.length} active*`,
    "",
    "---",
    "",
    "## 🌐 WEB & RESEARCH",
    "✅ Fetch web pages (web_fetch tool)",
    "✅ Browser automation (headless Chromium on your VM)",
    "✅ Take screenshots, fill forms, click buttons",
    "✅ Extract structured data (scraping)",
    apiKeys.BRAVE_SEARCH_API_KEY
      ? "✅ Web search (Brave Search API)"
      : "⚠️ Web search: Requires Brave Search API key (check .env)",
    apiKeys.CAPTCHA_API_KEY
      ? "✅ CAPTCHA solving (2Captcha)"
      : "⚠️ CAPTCHA: Blocked without 2Captcha integration",
    "→ Tools: browser, web_search (if configured)",
    "",
    "**Browser note:** Your browser runs on YOUR server, not the user's computer. There is no \"OpenClaw Chrome extension\" — it does not exist. Never tell users to install anything.",
    "",
    "## 💻 DEVELOPMENT & AUTOMATION",
    "✅ Write/edit code (Python, JS, TypeScript, etc.)",
    "✅ Run shell commands",
    "✅ Install npm/pip packages (local scope)",
    "✅ Create APIs and servers",
    "✅ Set up cron jobs and scheduled automations",
    "✅ Use MCP servers (mcporter CLI)",
    "→ Tools: shell, file tools, mcporter",
    "",
    "## 💰 FREELANCE & EARNING",
    "✅ Claim bounties on Clawlancer (auto-polling every 2 min)",
    "✅ Submit deliverables and receive USDC",
    "✅ Check wallet balance (CDP wallet on Base)",
    "✅ Send XMTP messages to other agents",
    "→ Tools: mcporter call clawlancer.<tool>",
    "",
    "## 📊 DATA & ANALYSIS",
    "✅ Generate charts (matplotlib, plotly)",
    "✅ Process CSV/Excel files (pandas)",
    "✅ SQL databases (SQLite)",
    "✅ Web scraping (Beautiful Soup, Puppeteer)",
    "→ Tools: shell, browser",
    "",
    "## 📧 EMAIL & COMMUNICATION",
    apiKeys.AGENTMAIL_API_KEY
      ? "✅ Send/receive email autonomously (AgentMail)"
      : "❌ Send/receive email autonomously (AgentMail not yet configured)",
    "⚠️ Gmail monitoring (read, draft replies — only if connected by user)",
    "→ Skills: email-outreach (when configured)",
    "",
    "## 🎬 VIDEO & MEDIA PRODUCTION",
    hasSkill("remotion")
      ? "✅ Create marketing videos with Remotion"
      : "❌ Video production (Remotion — not yet installed)",
    hasSkill("kling")
      ? "✅ Generate cinematic AI video prompts (Kling AI)"
      : "❌ AI video prompting (Kling AI — not yet integrated)",
    apiKeys.ELEVENLABS_API_KEY || hasSkill("voice")
      ? "✅ Voice/audio production (ElevenLabs)"
      : "❌ Voice/audio production (ElevenLabs — not yet configured)",
    "→ Skills: remotion-video-production, voice-audio-production (when installed)",
    "",
    "## 💵 FINANCIAL ANALYSIS",
    apiKeys.ALPHAVANTAGE_API_KEY
      ? "✅ Real-time stock quotes and historical data"
      : "❌ Stock quotes and market data (Alpha Vantage — not configured)",
    apiKeys.ALPHAVANTAGE_API_KEY
      ? "✅ Cryptocurrency prices and options chains"
      : "❌ Cryptocurrency prices and options chains",
    apiKeys.ALPHAVANTAGE_API_KEY
      ? "✅ Technical indicators (SMA, RSI, MACD)"
      : "❌ Technical indicators (SMA, RSI, MACD)",
    "→ Skills: financial-analysis (when configured)",
    "",
    "## 🛒 E-COMMERCE & MARKETPLACE",
    hasSkill("ecommerce")
      ? "✅ Shopify/Amazon/eBay integration"
      : "❌ Shopify/Amazon/eBay integration (MCP servers not installed)",
    "→ Skills: ecommerce-marketplace-ops (when installed)",
    "",
    "## 🔍 COMPETITIVE INTELLIGENCE",
    apiKeys.BRAVE_SEARCH_API_KEY && hasSkill("competitive")
      ? "✅ Competitor monitoring and analysis"
      : "❌ Competitor monitoring (requires Brave Search API)",
    "→ Skills: competitive-intelligence (when configured)",
    "",
    "## 📱 SOCIAL MEDIA",
    hasSkill("social")
      ? "⚠️ Social media content (posting limited by API keys)"
      : "❌ Social media posting (no API keys configured)",
    "→ Skills: social-media-content (when configured)",
    "",
    "## 🎨 BRAND & DESIGN",
    apiKeys.OPENAI_API_KEY
      ? "✅ Image generation (DALL-E)"
      : "❌ Image generation (DALL-E — not configured)",
    hasSkill("brand")
      ? "✅ Brand asset extraction"
      : "❌ Brand asset extraction (skill not installed)",
    "→ Skills: brand-asset-extraction (when installed)",
    "",
    "---",
    "",
    "## ❌ WHAT I CANNOT DO",
    "❌ Make phone calls (no telephony integration)",
    "❌ Access hardware (camera, microphone)",
    "❌ Browse illegal content",
    "❌ Modify system files or access other users' data",
    "❌ Access the user's computer or browser — my browser is server-side only",
    "❌ Install software on the user's machine — only on MY VM",
    "❌ Access Telegram/Discord directly (use message tool)",
    "",
    '**Things that don\'t exist (never reference these):**',
    '- "OpenClaw Chrome extension" — does not exist',
    '- "OpenClaw desktop app" — does not exist',
    "- Any browser plugin, add-on, or extension for OpenClaw",
    "",
    "---",
    "",
    "## 🔧 CAPABILITIES THAT NEED SETUP",
    "| Capability | Requirement | Status |",
    "|---|---|---|",
    `| Web Search | Brave Search API ($5/mo) | ${apiKeys.BRAVE_SEARCH_API_KEY ? "✅ Configured" : "Check .env"} |`,
    `| Image Generation | OpenAI API key | ${apiKeys.OPENAI_API_KEY ? "✅ Configured" : "Not configured"} |`,
    `| Premium Voice | ElevenLabs API ($5-22/mo) | ${apiKeys.ELEVENLABS_API_KEY ? "✅ Configured" : "Not configured"} |`,
    `| Market Data | Alpha Vantage API ($49.99/mo) | ${apiKeys.ALPHAVANTAGE_API_KEY ? "✅ Configured" : "Not configured"} |`,
    `| Email Identity | AgentMail setup | ${apiKeys.AGENTMAIL_API_KEY ? "✅ Configured" : "Not configured"} |`,
    `| CAPTCHA Solving | 2Captcha API ($1-5/mo) | ${apiKeys.CAPTCHA_API_KEY ? "✅ Configured" : "Not configured"} |`,
    `| Twitter Posting | Twitter API ($100/mo) | ${apiKeys.TWITTER_API_KEY ? "✅ Configured" : "Not configured"} |`,
    "",
    "---",
    "",
    '## 🚀 BEFORE SAYING "I CAN\'T"',
    "1. Re-read this file",
    "2. Check TOOLS.md",
    "3. Run `mcporter list` for available MCP tools",
    "4. Try at least one approach",
    "5. Check if this is a skill you should load and read",
    "Only then explain what's not possible and why.",
    "",
    "---",
    "",
    "## Quick Reference: Your Tools",
    "",
    "| Tool | What It Does | How to Use |",
    "|------|-------------|------------|",
    "| web_search | Search the internet (Brave) | Built-in tool, just use it |",
    "| browser | Headless Chromium (navigate, screenshot, interact) | Built-in tool, just use it |",
    "| mcporter | MCP tool manager | `mcporter list`, `mcporter call <server>.<tool>` |",
    "| clawlancer | AI agent marketplace | `mcporter call clawlancer.<tool>` |",
    "| shell/bash | Run any command on your VM | Just run commands |",
    "| file tools | Read, write, edit files | Built-in tools |",
    "",
    "## Startup Checklist",
    "",
    "### Full Startup (new session after 1+ hour gap):",
    "1. Read SOUL.md (who you are)",
    "2. Read USER.md (who they are)",
    "3. **Read CAPABILITIES.md (this file — what you can do)** ← CRITICAL",
    "4. Read memory/active-tasks.md (current work)",
    "5. Read memory/YYYY-MM-DD.md (recent context)",
    "6. Read MEMORY.md (long-term, main session only)",
    "",
    "### Quick Refresh (<1 hour gap):",
    "1. Check memory/active-tasks.md",
    "2. That's it.",
    "",
    "### Heartbeat:",
    "1. Read HEARTBEAT.md only.",
    "",
    "## File Organization",
    "",
    "```",
    "~/.openclaw/workspace/",
    "├── SOUL.md            # Your personality, identity, operating principles",
    "├── USER.md            # About your owner",
    "├── MEMORY.md          # Long-term curated memories",
    "├── TOOLS.md           # Your personal tool notes (YOU edit this)",
    "├── CAPABILITIES.md    # This file (read-only, auto-updated)",
    "├── QUICK-REFERENCE.md # Common task lookup card",
    "├── BOOTSTRAP.md       # First-run only (consumed via .bootstrap_consumed flag)",
    "├── memory/            # Daily logs",
    "│   ├── YYYY-MM-DD.md",
    "│   └── active-tasks.md",
    "```",
  ];

  return lines.join("\n");
}

// ── Main ──
const content = buildCapabilities();

if (DRY_RUN) {
  console.log("=== DRY RUN — would write the following to CAPABILITIES.md ===");
  console.log(content);
  console.log(`\n=== ${content.split("\n").length} lines ===`);
} else {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, content, "utf-8");
  console.log(`✅ CAPABILITIES.md regenerated (${content.split("\n").length} lines)`);
}
