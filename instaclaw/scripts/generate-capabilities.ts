#!/usr/bin/env npx tsx
/**
 * generate-capabilities.ts — Auto-regenerate CAPABILITIES.md on a VM
 *
 * Scans installed skills, MCP servers, and API keys to build an accurate
 * capability awareness matrix. Run during:
 *   - configureOpenClaw() completion
 *   - Skill installation (mcporter install)
 *   - API key added to .env
 *   - Manual: `npx tsx ~/scripts/generate-capabilities.ts`
 *   - Fleet push (fleet-push-capability-awareness.sh)
 *
 * Detects all 8 InstaClaw skills:
 *   1. voice-audio-production    5. social-media-content
 *   2. email-outreach            6. ecommerce-marketplace
 *   3. financial-analysis        7. motion-graphics
 *   4. competitive-intelligence  8. brand-design
 *
 * Usage:
 *   npx tsx ~/scripts/generate-capabilities.ts
 *   npx tsx ~/scripts/generate-capabilities.ts --dry-run
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const HOME = process.env.HOME || "/home/openclaw";
const WORKSPACE = path.join(HOME, ".openclaw/workspace");
const SKILLS_DIR = path.join(HOME, ".openclaw/skills");
const ENV_FILE = path.join(HOME, ".openclaw/.env");
const CONFIG_DIR = path.join(HOME, ".openclaw/config");
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
    RESEND_API_KEY: false,
    OPENAI_API_KEY: false,
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

// ── Check e-commerce config ──
function checkEcommerceConfig(): { hasConfig: boolean; platforms: string[] } {
  const configPath = path.join(CONFIG_DIR, "ecommerce.yaml");
  if (!fs.existsSync(configPath)) return { hasConfig: false, platforms: [] };

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const platforms: string[] = [];
    for (const p of ["shopify", "amazon", "ebay"]) {
      // Check for enabled: true under each platform
      const regex = new RegExp(`${p}:[\\s\\S]*?enabled:\\s*true`, "m");
      if (regex.test(content)) platforms.push(p);
    }
    return { hasConfig: true, platforms };
  } catch {
    return { hasConfig: false, platforms: [] };
  }
}

// ── Check if specific scripts exist ──
function hasScript(name: string): boolean {
  return fs.existsSync(path.join(HOME, "scripts", name));
}

// ── Build the markdown ──
function buildCapabilities(): string {
  const skills = scanSkills();
  const mcpServers = listMcpServers();
  const apiKeys = checkApiKeys();
  const ecom = checkEcommerceConfig();
  const timestamp =
    new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const has = (name: string) => skills.some((s) => s.includes(name));

  const lines: string[] = [
    "# CAPABILITIES.md — What I Can Do",
    `*Last updated: ${timestamp}*`,
    `*MCP servers: ${mcpServers.length} installed*`,
    `*Skills: ${skills.length} active*`,
    "",
    "---",
    "",

    // ── Web & Research ──
    "## 🌐 WEB & RESEARCH",
    "✅ Fetch web pages (web_fetch tool)",
    "✅ Browser automation (headless Chromium on your VM)",
    "✅ Take screenshots, fill forms, click buttons",
    "✅ Extract structured data (scraping)",
    apiKeys.BRAVE_SEARCH_API_KEY
      ? "✅ Web search (Brave Search API — configured)"
      : "⚠️ Web search: Requires Brave Search API key (check .env)",
    apiKeys.CAPTCHA_API_KEY
      ? "✅ CAPTCHA solving (2Captcha)"
      : "⚠️ CAPTCHA: Blocked without 2Captcha integration",
    "→ Tools: browser, web_search (if configured)",
    "",
    '**Browser note:** Your browser runs on YOUR server, not the user\'s computer. There is no "OpenClaw Chrome extension" — it does not exist. Never tell users to install anything.',
    "",

    // ── Development ──
    "## 💻 DEVELOPMENT & AUTOMATION",
    "✅ Write/edit code (Python, JS, TypeScript, etc.)",
    "✅ Run shell commands",
    "✅ Install npm/pip packages (local scope)",
    "✅ Create APIs and servers",
    "✅ Set up cron jobs and scheduled automations",
    "✅ Use MCP servers (mcporter CLI)",
    "→ Tools: shell, file tools, mcporter",
    "",

    // ── Freelance ──
    "## 💰 FREELANCE & EARNING",
    "✅ Claim bounties on Clawlancer (auto-polling every 2 min)",
    "✅ Submit deliverables and receive USDC",
    "✅ Check wallet balance (CDP wallet on Base)",
    "✅ Send XMTP messages to other agents",
    "→ Tools: mcporter call clawlancer.<tool>",
    "",

    // ── Data ──
    "## 📊 DATA & ANALYSIS",
    "✅ Generate charts (matplotlib, plotly)",
    "✅ Process CSV/Excel files (pandas)",
    "✅ SQL databases (SQLite)",
    "✅ Web scraping (Beautiful Soup, Puppeteer)",
    "→ Tools: shell, browser",
    "",

    // ── Email ──
    "## 📧 EMAIL & COMMUNICATION",
  ];

  if (has("email")) {
    lines.push(
      apiKeys.RESEND_API_KEY
        ? "✅ Send email from your @instaclaw.io address (email-client.sh — Resend)"
        : "⚠️ Email sending configured but RESEND_API_KEY missing (check .env)",
      "✅ Pre-send safety checks (email-safety-check.py — credential leak detection, rate limits)",
      "✅ Daily email digest generation (email-digest.py — priority classification)",
      "✅ OTP extraction from verification emails",
      "⚠️ Gmail monitoring (read, draft replies — only if connected by user)",
      "→ Skills: email-outreach",
      "→ Scripts: ~/scripts/email-client.sh, ~/scripts/email-safety-check.py, ~/scripts/email-digest.py",
      "→ Config: ~/.openclaw/email-config.json"
    );
  } else {
    lines.push(
      "❌ Email sending (email-outreach skill not installed)",
      "→ Skills: email-outreach (when installed)"
    );
  }
  lines.push("");

  // ── Video ──
  lines.push("## 🎬 VIDEO PRODUCTION");
  if (has("video")) {
    lines.push(
      "✅ Remotion video production — React-based motion graphics (template-basic included)",
      "✅ 4-scene marketing video template (Hook → Problem → Solution → CTA)",
      "✅ Spring physics animations, staggered reveals, opacity+transform combos",
      "✅ Brand asset extraction for videos (fonts, colors, logos via browser tool)",
      "✅ Draft and production rendering pipeline (15s @ 1080p, 1-3MB output)",
      "⚠️ AI video prompting (Kling AI — requires separate API, not pre-installed)",
      "→ Skills: motion-graphics",
      "→ Template: ~/.openclaw/skills/motion-graphics/assets/template-basic/",
      "→ Reference: ~/.openclaw/skills/motion-graphics/references/advanced-patterns.md"
    );
  } else {
    lines.push(
      "❌ Video production (Remotion — not yet installed)",
      "→ Skills: motion-graphics (when installed)"
    );
  }
  lines.push("");

  // ── Voice ──
  lines.push("## 🎙️ VOICE & AUDIO PRODUCTION");
  if (has("voice")) {
    lines.push(
      "✅ Text-to-speech via OpenAI TTS (tts-openai.sh — always available)",
      "✅ Audio processing toolkit (audio-toolkit.sh — FFmpeg normalize, mix, trim, convert, concat)",
      "✅ Usage tracking (audio-usage-tracker.py — budget checks, monthly limits)",
      apiKeys.ELEVENLABS_API_KEY
        ? "✅ Premium TTS via ElevenLabs (tts-elevenlabs.sh — configured)"
        : "⚠️ Premium TTS via ElevenLabs (tts-elevenlabs.sh — requires ELEVENLABS_API_KEY in .env)",
      "→ Skills: voice-audio-production",
      "→ Scripts: ~/scripts/tts-openai.sh, ~/scripts/tts-elevenlabs.sh, ~/scripts/audio-toolkit.sh, ~/scripts/audio-usage-tracker.py",
      "→ Reference: ~/.openclaw/skills/voice-audio-production/references/voice-guide.md"
    );
  } else {
    lines.push(
      "❌ Voice/audio production (skill not installed)",
      "→ Skills: voice-audio-production (when installed)"
    );
  }
  lines.push("");

  // ── Financial ──
  lines.push("## 💵 FINANCIAL ANALYSIS");
  if (has("financial")) {
    lines.push(
      apiKeys.ALPHAVANTAGE_API_KEY
        ? "✅ Real-time stock quotes and daily/intraday prices (market-data.sh — Alpha Vantage)"
        : "⚠️ Stock quotes (market-data.sh installed but ALPHAVANTAGE_API_KEY missing)",
      "✅ 50+ technical indicators pre-computed (RSI, MACD, Bollinger Bands, ADX, Stochastic, etc.)",
      "✅ Options chains with Greeks (delta, gamma, theta, vega, IV)",
      "✅ Cryptocurrency prices (BTC, ETH, 500+ coins)",
      "✅ Forex rates (100+ pairs) and commodities (gold, oil, etc.)",
      "✅ Economic indicators (GDP, CPI, Fed Funds Rate, Treasury yields)",
      "✅ News sentiment analysis (AI-scored)",
      "✅ Technical analysis engine with chart generation (market-analysis.py)",
      "→ Skills: financial-analysis",
      "→ Scripts: ~/scripts/market-data.sh, ~/scripts/market-analysis.py",
      "→ Reference: ~/.openclaw/skills/financial-analysis/references/finance-guide.md"
    );
  } else {
    lines.push(
      "❌ Financial analysis (skill not installed)",
      "→ Skills: financial-analysis (when installed)"
    );
  }
  lines.push("");

  // ── E-Commerce ──
  lines.push("## 🛒 E-COMMERCE & MARKETPLACE");
  if (has("ecommerce")) {
    lines.push(
      "✅ Unified order management — pull orders from Shopify, Amazon, eBay into single view (ecommerce-ops.py)",
      "✅ Cross-platform inventory sync with configurable buffer (default: 5 units, 15-min intervals)",
      "✅ RMA / return processing end-to-end — parse request, check eligibility, create RMA, generate label, email customer, track shipment",
      "✅ Competitive pricing monitor — auto-adjust within caps (max 20%/day, human approval >15%)",
      "✅ Daily/weekly/monthly P&L reports with per-platform breakdown",
      "✅ Platform credential setup and validation (ecommerce-setup.sh)"
    );
    if (ecom.platforms.length > 0) {
      lines.push(
        `✅ Connected platforms: ${ecom.platforms.join(", ")}`
      );
    } else {
      lines.push(
        "⚠️ BYOK — user provides their own Shopify/Amazon/eBay/ShipStation credentials (run ecommerce-setup.sh init)"
      );
    }
    lines.push(
      "⚠️ Walmart: not yet integrated (planned)",
      "→ Skills: ecommerce-marketplace-ops",
      "→ Scripts: ~/scripts/ecommerce-ops.py, ~/scripts/ecommerce-setup.sh",
      "→ Config: ~/.openclaw/config/ecommerce.yaml",
      "→ Reference: ~/.openclaw/skills/ecommerce-marketplace/references/ecommerce-guide.md"
    );
  } else {
    lines.push(
      "❌ Shopify/Amazon/eBay integration (skill not installed)",
      "→ Skills: ecommerce-marketplace-ops (when installed)"
    );
  }
  lines.push("");

  // ── Competitive Intel ──
  lines.push("## 🔍 COMPETITIVE INTELLIGENCE");
  if (has("competitive")) {
    lines.push(
      apiKeys.BRAVE_SEARCH_API_KEY
        ? "✅ Competitor monitoring — pricing, features, hiring, social mentions (competitive-intel.sh — Brave Search)"
        : "⚠️ Competitor monitoring (competitive-intel.sh installed but BRAVE_SEARCH_API_KEY missing)",
      "✅ Daily competitive digests with sentiment analysis (competitive-intel.py)",
      "✅ Weekly deep-dive reports with strategic recommendations",
      "✅ Real-time alerts for critical changes (funding, launches, price changes >10%)",
      "✅ Historical snapshot comparison (pricing pages, content frequency)",
      "✅ Crypto-specific intelligence (project mentions, CT sentiment)",
      "→ Skills: competitive-intelligence",
      "→ Scripts: ~/scripts/competitive-intel.sh, ~/scripts/competitive-intel.py",
      "→ Reference: ~/.openclaw/skills/competitive-intelligence/references/intel-guide.md"
    );
  } else {
    lines.push(
      "❌ Competitor monitoring (skill not installed)",
      "→ Skills: competitive-intelligence (when installed)"
    );
  }
  lines.push("");

  // ── Social Media ──
  lines.push("## 📱 SOCIAL MEDIA");
  if (has("social")) {
    lines.push(
      "✅ Platform-native content generation — Twitter threads, LinkedIn posts, Reddit posts, Instagram captions (social-content.py)",
      "✅ Anti-ChatGPT humanization filter (banned AI phrases, forced contractions, specifics-over-generics)",
      "✅ Content calendar management with scheduling and approval workflows",
      "✅ Trend detection and trend-jacking (with Brave Search)",
      "✅ Voice profile learning from user's past content",
      "⚠️ Reddit posting (works now — requires disclosure)",
      "⚠️ Twitter/LinkedIn posting (needs API keys — content generated, queued for manual post)",
      "→ Skills: social-media-content",
      "→ Scripts: ~/scripts/social-content.py",
      "→ Reference: ~/.openclaw/skills/social-media-content/references/social-guide.md"
    );
  } else {
    lines.push(
      "❌ Social media content (skill not installed)",
      "→ Skills: social-media-content (when installed)"
    );
  }
  lines.push("");

  // ── Brand ──
  lines.push("## 🎨 BRAND & DESIGN");
  if (has("brand")) {
    lines.push(
      "✅ Brand asset extraction from any URL — fonts, colors, logos via browser automation",
      "✅ RGB→Hex color conversion, font weight hierarchy, logo variant discovery",
      "✅ Brand config JSON generation (single source of truth for all branded content)",
      "✅ Logo contrast validation (white vs dark variant selection)"
    );
  } else {
    lines.push("❌ Brand asset extraction (skill not installed)");
  }
  lines.push(
    apiKeys.OPENAI_API_KEY
      ? "✅ Image generation (DALL-E — configured)"
      : "⚠️ Image generation (DALL-E — requires OpenAI API key)",
    "→ Skills: brand-asset-extraction",
    "→ Reference: ~/.openclaw/skills/brand-design/references/brand-extraction-guide.md",
    "",

    "---",
    "",

    // ── Cannot Do ──
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

    // ── Setup Table ──
    "## 🔧 CAPABILITIES THAT NEED SETUP",
    "| Capability | Requirement | Status |",
    "|---|---|---|",
    `| Web Search | Brave Search (included) | ${apiKeys.BRAVE_SEARCH_API_KEY ? "✅ Auto-provisioned" : "Check .env"} |`,
    `| Video Production | Remotion (included) | ${has("video") ? "✅ Template pre-deployed" : "Not installed"} |`,
    `| Brand Extraction | Browser (included) | ${has("brand") ? "✅ Pre-deployed" : "Not installed"} |`,
    `| Image Generation | OpenAI API key | ${apiKeys.OPENAI_API_KEY ? "✅ Configured" : "Not configured"} |`,
    `| Premium Voice | ElevenLabs API ($5-22/mo) | ${apiKeys.ELEVENLABS_API_KEY ? "✅ Configured" : "Check .env (OpenAI TTS works without it)"} |`,
    `| Market Data | Alpha Vantage (included) | ${apiKeys.ALPHAVANTAGE_API_KEY ? "✅ Auto-provisioned" : "Check .env"} |`,
    `| Email Identity | Resend (included) | ${apiKeys.RESEND_API_KEY ? "✅ Auto-provisioned @instaclaw.io" : "Check .env"} |`,
    `| E-Commerce | Shopify/Amazon/eBay (BYOK) | ${ecom.platforms.length > 0 ? `✅ ${ecom.platforms.join(", ")} connected` : "User configures via ecommerce-setup.sh"} |`,
    `| CAPTCHA Solving | 2Captcha API ($1-5/mo) | ${apiKeys.CAPTCHA_API_KEY ? "✅ Configured" : "Not configured"} |`,
    `| Twitter Posting | Twitter API ($100/mo) | ${apiKeys.TWITTER_API_KEY ? "✅ Configured" : "Not configured"} |`,
    "",

    "---",
    "",

    // ── Before Refusing ──
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

    // ── Quick Reference ──
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

    // ── Startup ──
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

    // ── File Org ──
    "## File Organization",
    "",
    "```",
    "~/.openclaw/",
    "├── workspace/",
    "│   ├── SOUL.md            # Your personality, identity, operating principles",
    "│   ├── USER.md            # About your owner",
    "│   ├── MEMORY.md          # Long-term curated memories",
    "│   ├── TOOLS.md           # Your personal tool notes (YOU edit this)",
    "│   ├── CAPABILITIES.md    # This file (read-only, auto-updated)",
    "│   ├── QUICK-REFERENCE.md # Common task lookup card",
    "│   ├── BOOTSTRAP.md       # First-run only (consumed via .bootstrap_consumed flag)",
    "│   ├── memory/            # Daily logs",
    "│   │   ├── YYYY-MM-DD.md",
    "│   │   └── active-tasks.md",
    "│   ├── ecommerce/         # E-commerce workspace",
    "│   │   └── reports/",
    "│   └── social-content/    # Social media drafts",
    "├── skills/                # Installed skill packages",
    "│   ├── voice-audio-production/",
    "│   ├── email-outreach/",
    "│   ├── financial-analysis/",
    "│   ├── competitive-intelligence/",
    "│   ├── social-media-content/",
    "│   ├── ecommerce-marketplace/",
    "│   ├── motion-graphics/",
    "│   └── brand-design/",
    "├── config/                # Platform configs",
    "│   └── ecommerce.yaml    # BYOK credentials",
    "└── .env                   # API keys",
    "```",
  );

  return lines.join("\n");
}

// ── Main ──
const content = buildCapabilities();

if (DRY_RUN) {
  console.log(
    "=== DRY RUN — would write the following to CAPABILITIES.md ==="
  );
  console.log(content);
  console.log(`\n=== ${content.split("\n").length} lines ===`);
} else {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, content, "utf-8");
  console.log(
    `✅ CAPABILITIES.md regenerated (${content.split("\n").length} lines)`
  );
  console.log(`   Skills detected: ${scanSkills().join(", ") || "none"}`);
  console.log(`   Output: ${OUTPUT}`);
}
