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

// ── The Manifest ──

export const VM_MANIFEST = {
  /** Bump on any manifest change. Continues from CONFIG_SPEC v14. */
  version: 16,

  // OpenClaw config settings (via `openclaw config set KEY VALUE`)
  configSettings: {
    "agents.defaults.heartbeat.every": "3h",
    "agents.defaults.compaction.reserveTokensFloor": "30000",
    "commands.restart": "true",
    "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback": "true",
    "channels.telegram.groupPolicy": "open",
    "channels.telegram.groups.default.requireMention": "false",
    "commands.useAccessGroups": "false",
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

    // --- Workspace files (append sections if marker absent) ---
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "template",
      templateKey: "SOUL_MD_INTELLIGENCE_SUPPLEMENT",
      mode: "append_if_marker_absent",
      marker: "Rule priority order",
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
      content: "## Operating Principles\\n\\n1. **Error handling:** Fix routine errors immediately without bothering the user. For anything involving security, data loss, or money — ask first.\\n\\n2. **Config safety:** Always back up files before modifying them. For unfamiliar systems, read docs first. For routine changes, proceed confidently.\\n\\n",
      mode: "insert_before_marker",
      marker: "## Boundaries",
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
  ] as ManifestFileEntry[],

  // ── Skill files ──
  // All SKILL.md files in instaclaw/skills/ are auto-deployed.
  skillsFromRepo: true,

  // Additional non-SKILL.md files in specific skill dirs
  extraSkillFiles: [
    { skillName: "sjinn-video", localPath: "references/sjinn-api.md", remotePath: "references/sjinn-api.md" },
    { skillName: "sjinn-video", localPath: "references/video-prompting.md", remotePath: "references/video-prompting.md" },
    { skillName: "sjinn-video", localPath: "references/video-production-pipeline.md", remotePath: "references/video-production-pipeline.md" },
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
  ] as ManifestCronJob[],

  // ── System packages (installed via sudo apt-get) ──
  systemPackages: ["ffmpeg"],

  // ── Python packages (installed via pip3) ──
  pythonPackages: ["openai"],

  // ── Platform env vars that MUST exist in ~/.openclaw/.env ──
  // Actual values come from DB (instaclaw_vms.gateway_token, etc.)
  requiredEnvVars: ["GATEWAY_TOKEN"],

  // ── openclaw.json settings to ensure ──
  openclawJsonSettings: {
    "skills.load.extraDirs": ["/home/openclaw/.openclaw/skills"],
  } as Record<string, unknown>,

  // ── Session thresholds (operational, kept for reference) ──
  maxSessionBytes: 512 * 1024,
  sessionAlertBytes: 256 * 1024,
  memoryWarnBytes: 400 * 1024,
} as const;

export type VMManifest = typeof VM_MANIFEST;

// ── Backwards compatibility ──
// CONFIG_SPEC was the old name. Re-export so existing code (rotateOversizedSession,
// upgradeOpenClaw, configureOpenClaw) can keep using it during migration.
export const CONFIG_SPEC = {
  version: VM_MANIFEST.version,
  settings: VM_MANIFEST.configSettings,
  requiredWorkspaceFiles: ["SOUL.md", "CAPABILITIES.md", "MEMORY.md"],
  maxSessionBytes: VM_MANIFEST.maxSessionBytes,
  sessionAlertBytes: VM_MANIFEST.sessionAlertBytes,
  memoryWarnBytes: VM_MANIFEST.memoryWarnBytes,
};
