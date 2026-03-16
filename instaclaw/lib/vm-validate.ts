/**
 * VM Validation Engine — Comprehensive fleet health checks.
 *
 * Runs all checks over a single SSH connection with batched commands.
 * Reuses connectSSH(), NVM_PREAMBLE, and VM_MANIFEST from existing code.
 * Auto-fix support for known recoverable failures.
 */

import { connectSSH, NVM_PREAMBLE, GATEWAY_PORT, OPENCLAW_PINNED_VERSION, type VMRecord } from "./ssh";
import { VM_MANIFEST } from "./vm-manifest";
import { reconcileVM } from "./vm-reconcile";
import { getSupabase } from "./supabase";
import { logger } from "./logger";

// ── Types ──

export interface CheckResult {
  category: string;
  name: string;
  status: "pass" | "fail" | "warning";
  severity: "critical" | "warning" | "info";
  detail?: string;
  fixable?: boolean;
}

export interface ValidationResult {
  vmId: string;
  vmName: string;
  timestamp: string;
  overallStatus: "pass" | "fail" | "degraded";
  criticalFailures: number;
  warnings: number;
  checks: CheckResult[];
  fixed?: string[];
}

// ── Skill names expected on every VM ──
// Derived from instaclaw/skills/ directory. The reconciler deploys these.
const REQUIRED_SKILLS = [
  "agentbook",
  "brand-design",
  "code-execution",
  "competitive-intelligence",
  "ecommerce-marketplace",
  "email-outreach",
  "financial-analysis",
  "higgsfield-video",
  "instagram-automation",
  "language-teacher",
  "marketplace-earning",
  "motion-graphics",
  "polymarket",
  "prediction-markets",
  "sjinn-video",
  "social-media-content",
  "solana-defi",
  "voice-audio-production",
  "web-search-browser",
  "x-twitter-search",
];

// Workspace files that must exist
const REQUIRED_WORKSPACE_FILES = [
  "SOUL.md",
  "CAPABILITIES.md",
  "MEMORY.md",
];

// Required ~/.openclaw/scripts/ files
const REQUIRED_OPENCLAW_SCRIPTS = [
  "strip-thinking.py",
  "auto-approve-pairing.py",
  "vm-watchdog.py",
  "push-heartbeat.sh",
  "generate_workspace_index.sh",
];

// Cron job markers that must appear in crontab
const REQUIRED_CRON_MARKERS = VM_MANIFEST.cronJobs.map((j) => j.marker);

// Systemd override keys
const REQUIRED_SYSTEMD_KEYS = ["MemoryHigh", "MemoryMax", "TasksMax", "KillMode"];

// ── Batched SSH check command ──

function buildCheckCommand(): string {
  // Build a single compound command that outputs structured markers for parsing.
  // Each check outputs: CHECK:<id>:<result>
  // Using a delimiter that won't appear in normal output.
  const parts: string[] = [];

  // 1. Playwright Chrome binary
  parts.push(`
echo -n "CHECK:chrome_bin:"; if [ -x /usr/local/bin/chromium-browser ]; then readlink -f /usr/local/bin/chromium-browser 2>/dev/null || echo "exists_no_readlink"; else echo "MISSING"; fi
`);

  // 2. OpenClaw version
  parts.push(`
echo -n "CHECK:openclaw_ver:"; ${NVM_PREAMBLE} && openclaw --version 2>/dev/null || echo "MISSING"
`);

  // 3. Node version
  parts.push(`
echo -n "CHECK:node_ver:"; ${NVM_PREAMBLE} && node --version 2>/dev/null || echo "MISSING"
`);

  // 4. Binaries: ffmpeg, python3, pip3
  parts.push(`
echo -n "CHECK:ffmpeg:"; which ffmpeg >/dev/null 2>&1 && echo "OK" || echo "MISSING"
echo -n "CHECK:python3:"; which python3 >/dev/null 2>&1 && echo "OK" || echo "MISSING"
echo -n "CHECK:pip3:"; which pip3 >/dev/null 2>&1 && echo "OK" || echo "MISSING"
`);

  // 5. Playwright cache dir
  parts.push(`
echo -n "CHECK:pw_cache:"; ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | head -1 || echo "MISSING"
`);

  // 6. Gateway health
  parts.push(`
echo -n "CHECK:gw_health:"; curl -sf --max-time 5 http://localhost:${GATEWAY_PORT}/health 2>/dev/null || echo "UNHEALTHY"
`);

  // 7. Gateway systemd status
  parts.push(`
echo -n "CHECK:gw_systemd:"; export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user is-active openclaw-gateway 2>/dev/null || echo "INACTIVE"
`);

  // 8. Config files exist
  parts.push(`
echo -n "CHECK:openclaw_json:"; [ -f ~/.openclaw/openclaw.json ] && echo "OK" || echo "MISSING"
echo -n "CHECK:auth_profiles:"; [ -f ~/.openclaw/agents/main/agent/auth-profiles.json ] && echo "OK" || echo "MISSING"
`);

  // 9. GATEWAY_TOKEN in .env
  parts.push(`
echo -n "CHECK:env_token:"; grep -q '^GATEWAY_TOKEN=' ~/.openclaw/.env 2>/dev/null && grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2 || echo "MISSING"
`);

  // 10. Skills — check for SKILL.md in each
  const skillChecks = REQUIRED_SKILLS.map(
    (s) => `echo -n "CHECK:skill_${s}:"; [ -f ~/.openclaw/skills/${s}/SKILL.md ] && echo "OK" || echo "MISSING"`
  ).join("\n");
  parts.push(skillChecks);

  // 11. ~/scripts/ files (skill scripts deployed by reconciler)
  parts.push(`
echo -n "CHECK:scripts_home:"; ls ~/scripts/ 2>/dev/null | wc -l | tr -d ' '
`);

  // 12. ~/.openclaw/scripts/ files
  const scriptChecks = REQUIRED_OPENCLAW_SCRIPTS.map(
    (s) => `echo -n "CHECK:oc_script_${s}:"; [ -f ~/.openclaw/scripts/${s} ] && echo "OK" || echo "MISSING"`
  ).join("\n");
  parts.push(scriptChecks);

  // 13. Workspace files
  const wsChecks = REQUIRED_WORKSPACE_FILES.map(
    (f) => `echo -n "CHECK:ws_${f}:"; [ -f ~/.openclaw/workspace/${f} ] && echo "OK" || echo "MISSING"`
  ).join("\n");
  parts.push(wsChecks);

  // 14. Cron jobs — check each marker individually
  const cronChecks = REQUIRED_CRON_MARKERS.map(
    (m) => `echo -n "CHECK:cron_${m.replace(/[^a-zA-Z0-9]/g, '_')}:"; crontab -l 2>/dev/null | grep -q "${m}" && echo "OK" || echo "MISSING"`
  ).join("\n");
  parts.push(cronChecks);

  // 15. Systemd override
  parts.push(`
echo -n "CHECK:systemd_override:"; cat ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo "MISSING"
`);

  // 16. SSHD OOM protection
  parts.push(`
echo -n "CHECK:sshd_oom:"; [ -f /etc/systemd/system/ssh.service.d/oom-protect.conf ] && echo "OK" || echo "MISSING"
`);

  // 17. Disk space
  parts.push(`
echo -n "CHECK:disk:"; df -h / | tail -1 | awk '{print $5}'
`);

  // 18. Swap
  parts.push(`
echo -n "CHECK:swap:"; swapon --show 2>/dev/null | grep -q swapfile && echo "OK" || echo "MISSING"
`);

  // 19. Global npm openclaw version
  parts.push(`
echo -n "CHECK:npm_openclaw:"; ${NVM_PREAMBLE} && npm list -g openclaw --depth=0 2>/dev/null | grep openclaw@ | sed 's/.*openclaw@//' || echo "MISSING"
`);

  // 20. pip3 openai
  parts.push(`
echo -n "CHECK:pip_openai:"; pip3 show openai 2>/dev/null | grep -q "^Name:" && echo "OK" || echo "MISSING"
`);

  // 21. Port listening
  parts.push(`
echo -n "CHECK:port_${GATEWAY_PORT}:"; ss -tlnp 2>/dev/null | grep -q ":${GATEWAY_PORT} " && echo "OK" || echo "MISSING"
`);

  return parts.join("\n");
}

// ── Parse structured output ──

function parseCheckOutput(output: string): Map<string, string> {
  const results = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^CHECK:([^:]+):(.*)/);
    if (match) {
      results.set(match[1], match[2].trim());
    }
  }
  return results;
}

// ── Main validation function ──

export async function validateVM(
  vm: VMRecord & { name?: string; gateway_token?: string },
): Promise<ValidationResult> {
  const checks: CheckResult[] = [];
  const timestamp = new Date().toISOString();

  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (err) {
    checks.push({
      category: "connectivity",
      name: "ssh",
      status: "fail",
      severity: "critical",
      detail: `SSH connection failed: ${String(err)}`,
    });
    return {
      vmId: vm.id,
      vmName: vm.name ?? vm.id,
      timestamp,
      overallStatus: "fail",
      criticalFailures: 1,
      warnings: 0,
      checks,
    };
  }

  try {
    const cmd = buildCheckCommand();
    const result = await ssh.execCommand(cmd, { execOptions: { pty: false } });
    const raw = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
    const data = parseCheckOutput(raw);

    // 1. Chrome binary
    const chromeBin = data.get("chrome_bin") ?? "MISSING";
    if (chromeBin === "MISSING") {
      checks.push({ category: "binary", name: "chromium-browser", status: "fail", severity: "critical", detail: "/usr/local/bin/chromium-browser missing", fixable: true });
    } else if (!chromeBin.includes("ms-playwright")) {
      checks.push({ category: "binary", name: "chromium-browser", status: "warning", severity: "warning", detail: `Symlink points to: ${chromeBin} (not Playwright)` });
    } else {
      checks.push({ category: "binary", name: "chromium-browser", status: "pass", severity: "critical" });
    }

    // 2. OpenClaw version
    const ocVer = data.get("openclaw_ver") ?? "MISSING";
    if (ocVer === "MISSING" || !ocVer.includes(OPENCLAW_PINNED_VERSION)) {
      checks.push({ category: "binary", name: "openclaw-version", status: "fail", severity: "critical", detail: `Expected ${OPENCLAW_PINNED_VERSION}, got: ${ocVer}` });
    } else {
      checks.push({ category: "binary", name: "openclaw-version", status: "pass", severity: "critical" });
    }

    // 3. Node version
    const nodeVer = data.get("node_ver") ?? "MISSING";
    if (nodeVer === "MISSING" || !nodeVer.startsWith("v22")) {
      checks.push({ category: "binary", name: "node-version", status: "fail", severity: "critical", detail: `Expected v22.x, got: ${nodeVer}` });
    } else {
      checks.push({ category: "binary", name: "node-version", status: "pass", severity: "critical" });
    }

    // 4. Utility binaries
    for (const bin of ["ffmpeg", "python3", "pip3"]) {
      const val = data.get(bin) ?? "MISSING";
      checks.push({
        category: "binary",
        name: bin,
        status: val === "OK" ? "pass" : "fail",
        severity: "warning",
        detail: val === "OK" ? undefined : `${bin} not found`,
        fixable: bin === "ffmpeg",
      });
    }

    // 5. Playwright cache
    const pwCache = data.get("pw_cache") ?? "MISSING";
    if (pwCache === "MISSING") {
      checks.push({ category: "playwright", name: "playwright-cache", status: "fail", severity: "critical", detail: "No Playwright Chromium in ~/.cache/ms-playwright/", fixable: true });
    } else {
      checks.push({ category: "playwright", name: "playwright-cache", status: "pass", severity: "critical" });
    }

    // 6. Gateway health
    const gwHealth = data.get("gw_health") ?? "UNHEALTHY";
    if (gwHealth.includes('"ok"') || gwHealth.includes("ok")) {
      checks.push({ category: "gateway", name: "health-endpoint", status: "pass", severity: "critical" });
    } else {
      checks.push({ category: "gateway", name: "health-endpoint", status: "fail", severity: "critical", detail: `Health response: ${gwHealth.slice(0, 200)}` });
    }

    // 7. Gateway systemd
    // NOTE: systemctl --user often fails over SSH due to missing DBUS session.
    // If health endpoint is OK and port is listening, downgrade to warning.
    const gwSys = data.get("gw_systemd") ?? "INACTIVE";
    const healthOk = (data.get("gw_health") ?? "").includes("ok");
    const portOk = (data.get(`port_${GATEWAY_PORT}`) ?? "") === "OK";
    if (gwSys.trim() === "active") {
      checks.push({ category: "gateway", name: "systemd-status", status: "pass", severity: "critical" });
    } else if (healthOk && portOk) {
      checks.push({ category: "gateway", name: "systemd-status", status: "warning", severity: "warning", detail: `systemctl reports "${gwSys.trim()}" but health+port OK (DBUS SSH issue)` });
    } else {
      checks.push({ category: "gateway", name: "systemd-status", status: "fail", severity: "critical", detail: `Status: ${gwSys}` });
    }

    // 8. Config files
    const ocJson = data.get("openclaw_json") ?? "MISSING";
    checks.push({
      category: "config",
      name: "openclaw.json",
      status: ocJson === "OK" ? "pass" : "fail",
      severity: "critical",
      detail: ocJson === "OK" ? undefined : "~/.openclaw/openclaw.json missing",
    });

    const authProf = data.get("auth_profiles") ?? "MISSING";
    checks.push({
      category: "config",
      name: "auth-profiles.json",
      status: authProf === "OK" ? "pass" : "fail",
      severity: "critical",
      detail: authProf === "OK" ? undefined : "auth-profiles.json missing",
    });

    // 9. GATEWAY_TOKEN in .env
    const envToken = data.get("env_token") ?? "MISSING";
    if (envToken === "MISSING") {
      checks.push({ category: "config", name: "env-gateway-token", status: "fail", severity: "critical", detail: "GATEWAY_TOKEN not set in .env" });
    } else {
      checks.push({ category: "config", name: "env-gateway-token", status: "pass", severity: "critical" });
    }

    // 10. Token match (compare .env token with DB token)
    if (envToken !== "MISSING" && vm.gateway_token) {
      if (envToken === vm.gateway_token) {
        checks.push({ category: "config", name: "token-match", status: "pass", severity: "critical" });
      } else {
        checks.push({ category: "config", name: "token-match", status: "fail", severity: "critical", detail: "DB gateway_token does not match .env GATEWAY_TOKEN" });
      }
    }

    // 11. Skills
    for (const skill of REQUIRED_SKILLS) {
      const val = data.get(`skill_${skill}`) ?? "MISSING";
      checks.push({
        category: "skill",
        name: `${skill}/SKILL.md`,
        status: val === "OK" ? "pass" : "fail",
        severity: "warning",
        detail: val === "OK" ? undefined : `Missing skill: ${skill}`,
        fixable: true,
      });
    }

    // 12. ~/scripts/ count
    const scriptsCount = parseInt(data.get("scripts_home") ?? "0", 10);
    if (scriptsCount < 10) {
      checks.push({ category: "scripts", name: "home-scripts", status: "fail", severity: "warning", detail: `Only ${scriptsCount} files in ~/scripts/ (expected 30+)`, fixable: true });
    } else {
      checks.push({ category: "scripts", name: "home-scripts", status: "pass", severity: "warning", detail: `${scriptsCount} scripts present` });
    }

    // 13. ~/.openclaw/scripts/ files
    for (const script of REQUIRED_OPENCLAW_SCRIPTS) {
      const val = data.get(`oc_script_${script}`) ?? "MISSING";
      checks.push({
        category: "scripts",
        name: `openclaw-scripts/${script}`,
        status: val === "OK" ? "pass" : "fail",
        severity: "warning",
        detail: val === "OK" ? undefined : `Missing: ~/.openclaw/scripts/${script}`,
        fixable: true,
      });
    }

    // 14. Workspace files
    for (const f of REQUIRED_WORKSPACE_FILES) {
      const val = data.get(`ws_${f}`) ?? "MISSING";
      checks.push({
        category: "workspace",
        name: f,
        status: val === "OK" ? "pass" : "fail",
        severity: "warning",
        detail: val === "OK" ? undefined : `Missing: ~/.openclaw/workspace/${f}`,
        fixable: true,
      });
    }

    // 15. Cron jobs
    for (const marker of REQUIRED_CRON_MARKERS) {
      const key = `cron_${marker.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const val = data.get(key) ?? "MISSING";
      checks.push({
        category: "cron",
        name: marker,
        status: val === "OK" ? "pass" : "fail",
        severity: "warning",
        detail: val === "OK" ? undefined : `Cron job missing: ${marker}`,
        fixable: true,
      });
    }

    // 16. Systemd override
    const sysOverride = data.get("systemd_override") ?? "MISSING";
    if (sysOverride === "MISSING") {
      checks.push({ category: "systemd", name: "override.conf", status: "fail", severity: "warning", detail: "systemd override.conf missing", fixable: true });
    } else {
      // Check required keys are present
      const missingKeys = REQUIRED_SYSTEMD_KEYS.filter((k) => !sysOverride.includes(k));
      if (missingKeys.length > 0) {
        checks.push({ category: "systemd", name: "override.conf", status: "warning", severity: "warning", detail: `Missing keys: ${missingKeys.join(", ")}` });
      } else {
        checks.push({ category: "systemd", name: "override.conf", status: "pass", severity: "warning" });
      }
    }

    // 17. SSHD OOM protection
    const sshdOom = data.get("sshd_oom") ?? "MISSING";
    checks.push({
      category: "systemd",
      name: "sshd-oom-protect",
      status: sshdOom === "OK" ? "pass" : "fail",
      severity: "info",
      detail: sshdOom === "OK" ? undefined : "sshd OOM protection config missing",
      fixable: true,
    });

    // 18. Disk space
    const diskPct = data.get("disk") ?? "0%";
    const usedPct = parseInt(diskPct.replace("%", ""), 10);
    if (usedPct >= 90) {
      checks.push({ category: "disk", name: "disk-space", status: "fail", severity: "critical", detail: `${diskPct} used (>= 90%)` });
    } else if (usedPct >= 80) {
      checks.push({ category: "disk", name: "disk-space", status: "warning", severity: "warning", detail: `${diskPct} used (>= 80%)` });
    } else {
      checks.push({ category: "disk", name: "disk-space", status: "pass", severity: "critical", detail: `${diskPct} used` });
    }

    // 19. Swap
    const swap = data.get("swap") ?? "MISSING";
    checks.push({
      category: "swap",
      name: "swap-file",
      status: swap === "OK" ? "pass" : "fail",
      severity: "warning",
      detail: swap === "OK" ? undefined : "No swap file active",
    });

    // 20. npm openclaw version
    const npmOc = (data.get("npm_openclaw") ?? "MISSING").trim();
    if (npmOc === "MISSING" || !npmOc.includes(OPENCLAW_PINNED_VERSION)) {
      checks.push({ category: "package", name: "npm-openclaw", status: "fail", severity: "critical", detail: `Expected ${OPENCLAW_PINNED_VERSION}, got: ${npmOc}` });
    } else {
      checks.push({ category: "package", name: "npm-openclaw", status: "pass", severity: "critical" });
    }

    // 21. pip openai
    const pipOai = data.get("pip_openai") ?? "MISSING";
    checks.push({
      category: "package",
      name: "pip-openai",
      status: pipOai === "OK" ? "pass" : "fail",
      severity: "warning",
      detail: pipOai === "OK" ? undefined : "openai pip package missing",
      fixable: true,
    });

    // 22. Port listening
    const portCheck = data.get(`port_${GATEWAY_PORT}`) ?? "MISSING";
    checks.push({
      category: "port",
      name: `port-${GATEWAY_PORT}`,
      status: portCheck === "OK" ? "pass" : "fail",
      severity: "critical",
      detail: portCheck === "OK" ? undefined : `Port ${GATEWAY_PORT} not listening`,
    });
  } finally {
    ssh.dispose();
  }

  const criticalFailures = checks.filter((c) => c.severity === "critical" && c.status === "fail").length;
  const warnings = checks.filter((c) => c.status !== "pass" && c.severity !== "critical").length;
  const overallStatus: ValidationResult["overallStatus"] =
    criticalFailures > 0 ? "fail" : warnings > 0 ? "degraded" : "pass";

  return {
    vmId: vm.id,
    vmName: vm.name ?? vm.id,
    timestamp,
    overallStatus,
    criticalFailures,
    warnings,
    checks,
  };
}

// ── Auto-fix known failures ──

export async function fixVM(
  vm: VMRecord & { name?: string; gateway_token?: string; api_mode?: string },
  result: ValidationResult,
): Promise<string[]> {
  const fixed: string[] = [];
  const failures = result.checks.filter((c) => c.status === "fail" && c.fixable);

  if (failures.length === 0) return fixed;

  // Categorize failures
  const hasPlaywrightIssue = failures.some(
    (c) => c.name === "chromium-browser" || c.name === "playwright-cache"
  );
  const hasMissingSkills = failures.some((c) => c.category === "skill");
  const hasMissingScripts = failures.some(
    (c) => c.category === "scripts"
  );
  const hasMissingWorkspace = failures.some((c) => c.category === "workspace");
  const hasMissingCron = failures.some((c) => c.category === "cron");
  const hasMissingSystemd = failures.some(
    (c) => c.category === "systemd" && c.name === "override.conf"
  );
  const hasMissingSshdOom = failures.some(
    (c) => c.name === "sshd-oom-protect"
  );
  const hasMissingPipPkg = failures.some(
    (c) => c.name === "pip-openai"
  );

  // Fix 1: Playwright Chrome
  if (hasPlaywrightIssue) {
    try {
      const ssh = await connectSSH(vm);
      try {
        logger.info("fixVM: Installing Playwright Chrome", { vm: vm.name });
        const installCmd = [
          NVM_PREAMBLE,
          "npx playwright install chromium",
          'CHROME_BIN=$(find ~/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1)',
          '[ -n "$CHROME_BIN" ] && sudo ln -sfn "$CHROME_BIN" /usr/local/bin/chromium-browser && echo "FIXED" || echo "FAILED"',
        ].join(" && ");
        const r = await ssh.execCommand(installCmd);
        if ((r.stdout ?? "").includes("FIXED")) {
          fixed.push("Installed Playwright Chrome + symlink");
        }
      } finally {
        ssh.dispose();
      }
    } catch (err) {
      logger.error("fixVM: Playwright fix failed", { vm: vm.name, error: String(err) });
    }
  }

  // Fix 2: Missing skills, scripts, workspace, cron, systemd, sshd — use reconcileVM
  if (hasMissingSkills || hasMissingScripts || hasMissingWorkspace || hasMissingCron || hasMissingSystemd || hasMissingSshdOom) {
    try {
      logger.info("fixVM: Running reconcileVM", { vm: vm.name });
      const reconcileResult = await reconcileVM(vm, VM_MANIFEST);
      if (reconcileResult.fixed.length > 0) {
        fixed.push(...reconcileResult.fixed.map((f) => `reconcile: ${f}`));
      }
      if (reconcileResult.errors.length > 0) {
        logger.warn("fixVM: reconcileVM had errors", { vm: vm.name, errors: reconcileResult.errors });
      }
    } catch (err) {
      logger.error("fixVM: reconcileVM failed", { vm: vm.name, error: String(err) });
    }
  }

  // Fix 3: Missing pip packages
  if (hasMissingPipPkg) {
    try {
      const ssh = await connectSSH(vm);
      try {
        const r = await ssh.execCommand("pip3 install --break-system-packages --quiet openai && echo FIXED");
        if ((r.stdout ?? "").includes("FIXED")) {
          fixed.push("Installed openai pip package");
        }
      } finally {
        ssh.dispose();
      }
    } catch (err) {
      logger.error("fixVM: pip fix failed", { vm: vm.name, error: String(err) });
    }
  }

  return fixed;
}

// ── Store audit results ──

export async function storeAuditResult(
  result: ValidationResult,
  fixedCount: number,
): Promise<void> {
  const supabase = getSupabase();
  try {
    await supabase.from("instaclaw_vm_audits").insert({
      vm_id: result.vmId,
      overall_status: result.overallStatus,
      critical_count: result.criticalFailures,
      warning_count: result.warnings,
      checks: result.checks,
      fixed_count: fixedCount,
    });
  } catch (err) {
    logger.error("Failed to store audit result", { vmId: result.vmId, error: String(err) });
  }
}
