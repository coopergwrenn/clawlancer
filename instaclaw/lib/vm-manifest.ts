/**
 * VM Manifest — Single source of truth for expected VM state.
 *
 * Every config setting, workspace file, skill, cron job, and system package
 * that should exist on a production VM is declared here. The reconcileVM()
 * function in vm-reconcile.ts diffs current VM state against this manifest
 * and fixes any drift.
 *
 * To add something to all VMs:
 *   1. Add the entry to VM_MANIFEST below
 *   2. Bump VM_MANIFEST.version
 *   3. Push to main — the health cron auto-deploys over the next few cycles
 */

import {
  WORKSPACE_CAPABILITIES_MD,
  WORKSPACE_QUICK_REFERENCE_MD,
  WORKSPACE_TOOLS_MD_TEMPLATE,
  AGENTS_MD_PHILOSOPHY_SECTION,
  SOUL_MD_LEARNED_PREFERENCES,
  SOUL_MD_INTELLIGENCE_SUPPLEMENT,
  WORKSPACE_INDEX_SCRIPT,
} from "./agent-intelligence";
import { WORKSPACE_EARN_MD } from "./earn-md-template";

// ── File entry types ──

export type ManifestFileMode =
  | "overwrite"              // Always write (platform-controlled, read-only reference)
  | "create_if_missing"      // Create if absent (agent-editable, never overwrite)
  | "append_if_marker_absent" // Append content if marker string not found in file
  | "insert_before_marker";   // Insert content before a marker line via sed

interface ManifestFileBase {
  remotePath: string;
  mode: ManifestFileMode;
  executable?: boolean;
  /** Use SFTP (putFile) instead of echo|base64 pipe — needed for large files (>40KB) */
  useSFTP?: boolean;
}

interface ManifestFileTemplate extends ManifestFileBase {
  source: "template";
  templateKey: string;
}

interface ManifestFileInline extends ManifestFileBase {
  source: "inline";
  content: string;
}

interface ManifestFileMarker extends ManifestFileBase {
  source: "template" | "inline";
  templateKey?: string;
  content?: string;
  marker: string;
  mode: "append_if_marker_absent" | "insert_before_marker";
}

export type ManifestFileEntry = ManifestFileTemplate | ManifestFileInline | ManifestFileMarker;

export interface ManifestExtraSkillFile {
  skillName: string;
  localPath: string;   // Relative to instaclaw/skills/<skillName>/
  remotePath: string;   // Relative to ~/.openclaw/skills/<skillName>/
}

export interface ManifestCronJob {
  schedule: string;
  command: string;
  /** Unique string to grep for in crontab — determines if job is installed */
  marker: string;
}

// ── Template registry ──
// Maps templateKey strings to their content. This lets us reference templates
// by name in the manifest without importing the large strings directly.

export const TEMPLATE_REGISTRY: Record<string, string> = {
  WORKSPACE_CAPABILITIES_MD,
  WORKSPACE_QUICK_REFERENCE_MD,
  WORKSPACE_TOOLS_MD_TEMPLATE,
  WORKSPACE_EARN_MD,
  AGENTS_MD_PHILOSOPHY_SECTION,
  SOUL_MD_LEARNED_PREFERENCES,
  SOUL_MD_INTELLIGENCE_SUPPLEMENT,
  WORKSPACE_INDEX_SCRIPT,
  // STRIP_THINKING_SCRIPT and AUTO_APPROVE_PAIRING_SCRIPT are registered
  // at runtime by ssh.ts to avoid circular imports (they're defined there
  // as template literals with interpolated values like ${512 * 1024}).
};

/**
 * Register a template at runtime. Called by ssh.ts for scripts that use
 * interpolated values (STRIP_THINKING_SCRIPT, AUTO_APPROVE_PAIRING_SCRIPT).
 */
export function registerTemplate(key: string, content: string): void {
  TEMPLATE_REGISTRY[key] = content;
}

export function getTemplateContent(key: string): string {
  const content = TEMPLATE_REGISTRY[key];
  if (!content) {
    throw new Error(`VM Manifest: unknown template key "${key}". Did you call registerTemplate()?`);
  }
  return content;
}

// ── Push-based heartbeat script (deployed to every VM, runs hourly via cron) ──
const PUSH_HEARTBEAT_SH = `#!/bin/bash
# Push-based heartbeat — POSTs to instaclaw.io every hour via crontab
TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2)
LOGFILE=~/.openclaw/logs/heartbeat.log
mkdir -p ~/.openclaw/logs
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \\
  -H "Authorization: Bearer $TOKEN" \\
  https://instaclaw.io/api/vm/heartbeat 2>/dev/null)
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') status=$STATUS" >> "$LOGFILE"
# Keep log from growing forever — last 500 lines
tail -500 "$LOGFILE" > "$LOGFILE.tmp" && mv "$LOGFILE.tmp" "$LOGFILE"
`;

// ── The Manifest ──

export const VM_MANIFEST = {
  /** Bump on any manifest change. Continues from CONFIG_SPEC v14. */
  version: 50,

  // OpenClaw config settings (via `openclaw config set KEY VALUE`)
  // The reconciler pushes these on every health cycle — drift is auto-corrected.
  configSettings: {
    "agents.defaults.heartbeat.every": "3h",
    // v41: Route heartbeats to their own session ("agent:main:heartbeat") instead of
    // polluting the main Telegram conversation. Without this, every 3h heartbeat injects
    // ~24 message exchanges/day into the user's chat context. Schema-verified on vm-379.
    "agents.defaults.heartbeat.session": "heartbeat",
    "agents.defaults.compaction.reserveTokensFloor": "35000",
    "agents.defaults.compaction.memoryFlush.enabled": "true",
    // v41: Raise softThresholdTokens from default 4000 to 8000 — gives the agent more
    // room to write durable notes before compaction fires. OpenClaw Issue #31435 recommends 8000+.
    "agents.defaults.compaction.memoryFlush.softThresholdTokens": "8000",
    "agents.defaults.memorySearch.enabled": "true",
    "commands.restart": "true",
    // NOTE: gateway.controlUi is version-dependent and handled by
    // upgradeOpenClaw() / restartGateway() — NOT set here statically.
    // v2026.2.24+ REQUIRES dangerouslyAllowHostHeaderOriginFallback=true
    // v2026.2.17–2026.2.23 REJECTS the controlUi key entirely
    "channels.telegram.groupPolicy": "open",
    "channels.telegram.groups.*.requireMention": "false",
    "commands.useAccessGroups": "false",
    // v41: CRITICAL — Stop the daily 4 AM session wipe. This is the #1 cause of
    // "agent forgetting" complaints. Session now only resets after 7 days (10080 min)
    // of ZERO activity. Active agents never hit this. Schema-verified on vm-379.
    // See: instaclaw/docs/research-session-persistence.md
    "session.reset.mode": "idle",
    "session.reset.idleMinutes": "10080",
    // v41: Actively prune old sessions to prevent disk bloat (vs "warn" which only reports).
    "session.maintenance.mode": "enforce",
    // DO NOT CHANGE — total SKILL.md content is ~405K chars across 17 skills
    // (polymarket removed as duplicate of prediction-markets).
    // Below 500K, skills are silently dropped (alphabetical load order).
    // Caused 3 fleet-wide outages when reverted. See commits 0cad0b7, 9e1e767.
    // Also enforced by reconciler — OpenClaw version updates reset this to default.
    "skills.limits.maxSkillsPromptChars": "500000",
  } as Record<string, string>,

  // ── Files deployed to VM ──
  files: [
    // --- Workspace files (always overwrite — platform-controlled) ---
    {
      remotePath: "~/.openclaw/workspace/CAPABILITIES.md",
      source: "template",
      templateKey: "WORKSPACE_CAPABILITIES_MD",
      mode: "overwrite",
    },
    {
      remotePath: "~/.openclaw/workspace/QUICK-REFERENCE.md",
      source: "template",
      templateKey: "WORKSPACE_QUICK_REFERENCE_MD",
      mode: "overwrite",
    },

    // --- Workspace files (create if missing — agent-editable) ---
    {
      remotePath: "~/.openclaw/workspace/TOOLS.md",
      source: "template",
      templateKey: "WORKSPACE_TOOLS_MD_TEMPLATE",
      mode: "create_if_missing",
    },
    {
      remotePath: "~/.openclaw/workspace/MEMORY.md",
      source: "inline",
      content: [
        "# MEMORY.md - Long-Term Memory",
        "",
        "_Start capturing what matters here. Decisions, context, things to remember._",
        "",
        "---",
      ].join("\n"),
      mode: "create_if_missing",
    },
    {
      remotePath: "~/.openclaw/workspace/EARN.md",
      source: "template",
      templateKey: "WORKSPACE_EARN_MD",
      mode: "create_if_missing",
    },

    // --- Workspace files (append sections if marker absent) ---
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "template",
      templateKey: "SOUL_MD_INTELLIGENCE_SUPPLEMENT",
      mode: "append_if_marker_absent",
      marker: "INTELLIGENCE_INTEGRATED",
    },
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "template",
      templateKey: "SOUL_MD_LEARNED_PREFERENCES",
      mode: "append_if_marker_absent",
      marker: "Learned Preferences",
    },
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "inline",
      content: "## Operating Principles\\n\\n1. **Error handling:** Fix routine errors immediately without bothering the user. For anything involving security, data loss, or money — ask first.\\n\\n2. **Config safety:** Always back up files before modifying them. For unfamiliar systems, read docs first. For routine changes, proceed confidently.\\n\\n3. **Never go silent:** When starting any operation that may take more than 30 seconds (browser navigation, API calls, authentication flows, file generation, trading, etc.), ALWAYS send a quick message to the user FIRST like \"Working on this, give me a minute...\" or \"On it — this might take a sec.\" NEVER go silent for more than 30 seconds without acknowledging what you're doing. The user will think you crashed.\\n\\n4. **NEVER self-restart:** NEVER restart your own gateway (`systemctl restart openclaw-gateway`) to fix browser issues or any other problem. This kills your Telegram connection and creates a crash loop where you go silent, come back, try again, and go silent again. If a website times out in the browser, try a different approach — use curl, API calls, web fetch, or ask the user for help. Do NOT restart yourself.\\n\\n",
      mode: "insert_before_marker",
      marker: "## Boundaries",
    },

    // --- DegenClaw awareness (so agent knows the skill exists and can reference SKILL.md) ---
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "inline",
      content: "\\n<!-- DEGENCLAW_AWARENESS_V1 -->\\n## DegenClaw Trading Competition\\nYou have access to the DegenClaw skill — a $100K weekly perpetuals trading competition on Hyperliquid, run by Virtuals Protocol. If your user mentions trading competitions, Hyperliquid perps, DegenClaw, the $100K challenge, or wanting to compete/trade perps competitively, read and follow the dgclaw SKILL.md for the full setup and trading flow. You can help them join the competition, trade perps, manage their forum, check the leaderboard, and attract subscribers. **Always get explicit user approval before launching tokens or executing trades.**\\n",
      mode: "append_if_marker_absent",
      marker: "DEGENCLAW_AWARENESS",
    },

    // --- Legacy: AGENTS.md philosophy section (only on VMs that still have AGENTS.md) ---
    {
      remotePath: "~/.openclaw/workspace/AGENTS.md",
      source: "template",
      templateKey: "AGENTS_MD_PHILOSOPHY_SECTION",
      mode: "append_if_marker_absent",
      marker: "Problem-Solving Philosophy",
    },

    // --- Scripts ---
    {
      remotePath: "~/.openclaw/scripts/generate_workspace_index.sh",
      source: "template",
      templateKey: "WORKSPACE_INDEX_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
    {
      remotePath: "~/.openclaw/scripts/strip-thinking.py",
      source: "template",
      templateKey: "STRIP_THINKING_SCRIPT",
      mode: "overwrite",
      executable: true,
      useSFTP: true,
    },
    {
      remotePath: "~/.openclaw/scripts/auto-approve-pairing.py",
      source: "template",
      templateKey: "AUTO_APPROVE_PAIRING_SCRIPT",
      mode: "overwrite",
      executable: true,
      useSFTP: true,
    },
    {
      remotePath: "~/.openclaw/scripts/vm-watchdog.py",
      source: "template",
      templateKey: "VM_WATCHDOG_SCRIPT",
      mode: "overwrite",
      executable: true,
      useSFTP: true,
    },
    {
      remotePath: "~/.openclaw/scripts/push-heartbeat.sh",
      source: "inline",
      content: PUSH_HEARTBEAT_SH,
      mode: "overwrite",
      executable: true,
    },
    {
      remotePath: "~/scripts/deliver_file.sh",
      source: "template",
      templateKey: "DELIVER_FILE_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
    {
      remotePath: "~/scripts/notify_user.sh",
      source: "template",
      templateKey: "NOTIFY_USER_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
  ] as ManifestFileEntry[],

  // ── Skill files ──
  // All SKILL.md files in instaclaw/skills/ are auto-deployed.
  skillsFromRepo: true,

  // Additional non-SKILL.md files in specific skill dirs
  extraSkillFiles: [
    { skillName: "sjinn-video", localPath: "references/sjinn-api.md", remotePath: "references/sjinn-api.md" },
    { skillName: "sjinn-video", localPath: "references/video-prompting.md", remotePath: "references/video-prompting.md" },
    { skillName: "sjinn-video", localPath: "references/video-production-pipeline.md", remotePath: "references/video-production-pipeline.md" },
    // Motion Graphics starter template (must render out of the box — agent only edits MyVideo.tsx)
    { skillName: "motion-graphics", localPath: "assets/template-basic/package.json", remotePath: "assets/template-basic/package.json" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/remotion.config.ts", remotePath: "assets/template-basic/remotion.config.ts" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/tsconfig.json", remotePath: "assets/template-basic/tsconfig.json" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/src/index.ts", remotePath: "assets/template-basic/src/index.ts" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/src/Root.tsx", remotePath: "assets/template-basic/src/Root.tsx" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/src/MyVideo.tsx", remotePath: "assets/template-basic/src/MyVideo.tsx" },
    // DegenClaw trading competition — reference docs
    { skillName: "dgclaw", localPath: "references/api.md", remotePath: "references/api.md" },
    { skillName: "dgclaw", localPath: "references/strategy-playbook.md", remotePath: "references/strategy-playbook.md" },
  ] as ManifestExtraSkillFile[],

  // ── Cron jobs ──
  cronJobs: [
    {
      schedule: "* * * * *",
      command: "python3 ~/.openclaw/scripts/strip-thinking.py > /dev/null 2>&1",
      marker: "strip-thinking.py",
    },
    {
      schedule: "* * * * *",
      command: "python3 ~/.openclaw/scripts/auto-approve-pairing.py > /dev/null 2>&1",
      marker: "auto-approve-pairing.py",
    },
    {
      schedule: "* * * * *",
      command: "python3 ~/.openclaw/scripts/vm-watchdog.py > /dev/null 2>&1",
      marker: "vm-watchdog.py",
    },
    {
      schedule: "0 * * * *",
      command: "bash ~/.openclaw/scripts/push-heartbeat.sh",
      marker: "push-heartbeat.sh",
    },
  ] as ManifestCronJob[],

  // ── System packages (installed via sudo apt-get) ──
  systemPackages: ["ffmpeg", "jq"],

  // ── Python packages (installed via pip3) ──
  pythonPackages: ["openai"],

  // ── Platform env vars that MUST exist in ~/.openclaw/.env ──
  // Actual values come from DB (instaclaw_vms.gateway_token, etc.)
  requiredEnvVars: ["GATEWAY_TOKEN", "POLYGON_RPC_URL", "CLOB_PROXY_URL", "CLOB_PROXY_URL_BACKUP", "AGENT_REGION"],

  // Default values for env vars that don't come from the DB
  envVarDefaults: {
    POLYGON_RPC_URL: "https://1rpc.io/matic",
    CLOB_PROXY_URL: "http://172.105.22.90:8080",
    CLOB_PROXY_URL_BACKUP: "http://172.237.101.206:8080",  // London 2 (gb-lon) backup proxy
  } as Record<string, string>,

  // ── openclaw.json initial settings (written by configureOpenClaw, NOT reconciler) ──
  // NOTE: configSettings above is the authoritative source — the reconciler enforces those.
  // This section is only used during initial VM provisioning via buildOpenClawConfig().
  openclawJsonSettings: {
    "skills.load.extraDirs": ["/home/openclaw/.openclaw/skills"],
    // DO NOT CHANGE — must match configSettings value above. See comments there.
    "skills.limits.maxSkillsPromptChars": 500000,
  } as Record<string, unknown>,

  // ── Systemd unit overrides for openclaw-gateway.service ──
  // Applied by reconciler and configureOpenClaw after `openclaw gateway install`.
  systemdOverrides: {
    "KillMode": "mixed",           // Kill Chrome children when gateway stops (was: process)
    "Delegate": "yes",             // Keep agent-spawned child processes inside the CGroup so KillMode=mixed catches them
    "RestartSec": "10",            // Wait 10s between restarts (was: 5)
    "StartLimitBurst": "10",       // Max 10 restarts in StartLimitIntervalSec
    "StartLimitIntervalSec": "300", // 5-minute window for burst counting
    "StartLimitAction": "stop",    // Stop unit after burst exceeded (was: none → infinite loop)
    "ExecStartPre": "/bin/bash -c 'find /tmp/openclaw/ -name \"*.log\" -mmin +60 -delete 2>/dev/null; find /tmp/openclaw/ -name \"*.log.bak\" -mtime +3 -delete 2>/dev/null; pkill -9 -f \"[c]hrome.*remote-debugging-port\" 2>/dev/null || true'",
    "MemoryHigh": "3G",             // Soft limit: kernel throttles at 3GB (gateway slows, doesn't die)
    "MemoryMax": "3500M",           // Hard kill: cgroup OOM at 3.5GB (leaves 500MB for sshd/system)
    "TasksMax": "75",               // Max threads+processes (Node ~11 + Chrome ~50 + small headroom). Was 150 — reduced to prevent runaway agent forks
    "OOMScoreAdjust": "500",        // Higher = killed first. sshd has -900. Gateway dies before sshd.
    "RuntimeMaxSec": "86400",       // Auto-restart gateway after 24h to prevent memory bloat
    "RuntimeRandomizedExtraSec": "3600", // Stagger restarts across fleet by up to 1h
    // Virtuals Protocol partner attribution — ensures ALL child processes (agent tools,
    // npx acp, dgclaw.sh) inherit PARTNER_ID regardless of working directory or dotenv.
    // Confirmed by Mira @ Virtuals 2026-03-30: "inject PARTNER_ID=INSTACLAW to process.env"
    "Environment": "PARTNER_ID=INSTACLAW",
  } as Record<string, string>,

  // ── Session thresholds ──
  // NOTE: These are used by the health cron for alerting only. rotateOversizedSession()
  // was removed in v45 (P3.2). The PRIMARY enforcement is in strip-thinking.py which uses
  // its own hardcoded thresholds: MAX_SESSION_BYTES=200KB, MEMORY_WARN_BYTES=160KB
  // (defined in the STRIP_THINKING_SCRIPT template in ssh.ts:110-111). Those were lowered
  // independently after web fetch blowouts caused sessions to balloon past 512KB between
  // health cron cycles. The values below are the "outer fence" — if strip-thinking misses
  // a session (e.g., cron not running), the health cron catches it at these higher thresholds.
  // See PRD-memory-architecture-overhaul.md Section 2.2 for the full split-brain analysis.
  maxSessionBytes: 512 * 1024,
  sessionAlertBytes: 480 * 1024,
  memoryWarnBytes: 400 * 1024,
} as const;

export type VMManifest = typeof VM_MANIFEST;

// ── Backwards compatibility ──
// CONFIG_SPEC was the old name. Re-export so existing code (upgradeOpenClaw,
// configureOpenClaw, health cron) can keep using it during migration.
export const CONFIG_SPEC = {
  version: VM_MANIFEST.version,
  settings: VM_MANIFEST.configSettings,
  requiredWorkspaceFiles: ["SOUL.md", "CAPABILITIES.md", "MEMORY.md", "EARN.md"],
  maxSessionBytes: VM_MANIFEST.maxSessionBytes,
  sessionAlertBytes: VM_MANIFEST.sessionAlertBytes,
  memoryWarnBytes: VM_MANIFEST.memoryWarnBytes,
};
