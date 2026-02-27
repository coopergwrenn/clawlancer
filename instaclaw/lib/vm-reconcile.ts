/**
 * VM Reconciliation Engine
 *
 * reconcileVM() diffs a VM's current state against the VM_MANIFEST and fixes
 * any drift. Called by auditVMConfig() (thin wrapper) which is invoked by the
 * health cron's config audit pass.
 *
 * Design:
 *   - Single SSH session per VM (open once, reuse for all checks/fixes)
 *   - Idempotent: running twice produces the same result
 *   - Non-fatal errors: package installs, cron additions can fail without aborting
 *   - Dry run support: dryRun=true logs what would change without writing
 */

import { VM_MANIFEST, getTemplateContent, type ManifestFileEntry } from "./vm-manifest";
import { connectSSH, NVM_PREAMBLE, type VMRecord } from "./ssh";
import { logger } from "./logger";
import * as fs from "fs";
import * as path from "path";

// ── Result types ──

export interface ReconcileResult {
  fixed: string[];
  alreadyCorrect: string[];
  errors: string[];
  gatewayRestartNeeded: boolean;
  gatewayRestarted: boolean;
  gatewayHealthy: boolean;
}

// ── Reconciliation engine ──

export async function reconcileVM(
  vm: VMRecord & { gateway_token?: string; api_mode?: string },
  manifest: typeof VM_MANIFEST,
  options?: { dryRun?: boolean },
): Promise<ReconcileResult> {
  const dryRun = options?.dryRun ?? false;
  const result: ReconcileResult = {
    fixed: [],
    alreadyCorrect: [],
    errors: [],
    gatewayRestartNeeded: false,
    gatewayRestarted: false,
    gatewayHealthy: true,
  };

  const ssh = await connectSSH(vm);
  try {
    // ── Step 0: Pre-audit workspace backup ──
    await stepBackup(ssh);

    // ── Step 1: Config settings ──
    await stepConfigSettings(ssh, manifest, result, dryRun);

    // ── Step 2: Files ──
    await stepFiles(ssh, vm, manifest, result, dryRun);

    // ── Step 2b: Bootstrap safety ──
    await stepBootstrapConsumed(ssh, result, dryRun);

    // ── Step 3: Skills ──
    await stepSkills(ssh, vm, manifest, result, dryRun);

    // ── Step 4: Cron jobs ──
    await stepCronJobs(ssh, manifest, result, dryRun);

    // ── Step 5: System packages ──
    await stepSystemPackages(ssh, manifest, result, dryRun);

    // ── Step 6: Python packages ──
    await stepPythonPackages(ssh, manifest, result, dryRun);

    // ── Step 7: Env vars ──
    await stepEnvVars(ssh, vm, manifest, result, dryRun);

    // ── Step 8: Auth profiles ──
    const authProfileFixed = await stepAuthProfiles(ssh, vm, result, dryRun);

    // ── Step 8b: Systemd unit overrides (KillMode, crash-loop breaker, Chrome cleanup) ──
    await stepSystemdUnit(ssh, manifest, result, dryRun);

    // ── Step 9: Gateway restart (only if auth-profiles.json was modified) ──
    if (authProfileFixed && !dryRun) {
      result.gatewayRestartNeeded = true;
      await stepGatewayRestart(ssh, vm, result);
    }

    return result;
  } finally {
    ssh.dispose();
  }
}

// ── Step implementations ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SSHConnection = any;

async function stepBackup(ssh: SSHConnection): Promise<void> {
  await ssh.execCommand([
    'BACKUP_TS=$(date -u +%Y%m%dT%H%M%SZ)',
    'BACKUP_DIR="$HOME/.openclaw/backups/${BACKUP_TS}"',
    'WS="$HOME/.openclaw/workspace"',
    'if [ -d "$WS" ]; then',
    '  mkdir -p "$BACKUP_DIR"',
    '  cp "$WS/MEMORY.md" "$BACKUP_DIR/MEMORY.md" 2>/dev/null || true',
    '  cp "$WS/USER.md" "$BACKUP_DIR/USER.md" 2>/dev/null || true',
    '  cp "$WS/IDENTITY.md" "$BACKUP_DIR/IDENTITY.md" 2>/dev/null || true',
    '  cp "$WS/SOUL.md" "$BACKUP_DIR/SOUL.md" 2>/dev/null || true',
    '  cp "$WS/TOOLS.md" "$BACKUP_DIR/TOOLS.md" 2>/dev/null || true',
    '  cp -r "$WS/memory" "$BACKUP_DIR/memory" 2>/dev/null || true',
    '  if [ -d "$HOME/.openclaw/agents/main/sessions" ]; then',
    '    mkdir -p "$BACKUP_DIR/sessions"',
    '    cp "$HOME/.openclaw/agents/main/sessions/"*.jsonl "$BACKUP_DIR/sessions/" 2>/dev/null || true',
    '    cp "$HOME/.openclaw/agents/main/sessions/sessions.json" "$BACKUP_DIR/sessions/" 2>/dev/null || true',
    '  fi',
    'fi',
    'find "$HOME/.openclaw/backups" -maxdepth 1 -type d -mtime +7 -exec rm -rf {} \\; 2>/dev/null || true',
  ].join(' && '));
}

async function stepConfigSettings(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const settings = manifest.configSettings;
  const keys = Object.keys(settings);

  // Batch read all settings in one SSH command
  const getCommands = keys
    .map((key) => `echo "CFG:${key}=$(openclaw config get ${key} 2>/dev/null)"`)
    .join(' && ');
  const checkResult = await ssh.execCommand(`${NVM_PREAMBLE} && ${getCommands}`);

  // Parse current values
  const settingsToFix: string[] = [];
  for (const line of checkResult.stdout.split('\n')) {
    const match = line.match(/^CFG:(.+?)=(.*)$/);
    if (!match) continue;
    const [, key, currentValue] = match;
    const expected = settings[key];
    if (expected === undefined) continue;

    if (currentValue.trim() === expected) {
      result.alreadyCorrect.push(key);
    } else {
      settingsToFix.push(key);
    }
  }

  if (settingsToFix.length === 0) return;

  if (dryRun) {
    result.fixed.push(...settingsToFix.map((k) => `[dry-run] config: ${k}`));
    return;
  }

  // Batch fix drifted settings
  const fixCommands = settingsToFix
    .map((key) => `openclaw config set ${key} '${settings[key]}' || true`)
    .join(' && ');
  await ssh.execCommand(`${NVM_PREAMBLE} && ${fixCommands}`);
  result.fixed.push(...settingsToFix);
}

async function stepFiles(
  ssh: SSHConnection,
  vm: VMRecord,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const workspaceDir = '~/.openclaw/workspace';

  for (const entry of manifest.files) {
    try {
      await deployFileEntry(ssh, vm, entry, result, dryRun);
    } catch (err) {
      result.errors.push(`file ${entry.remotePath}: ${String(err)}`);
    }
  }

  // Ensure memory/ directory exists alongside MEMORY.md
  if (!dryRun) {
    await ssh.execCommand(`mkdir -p ${workspaceDir}/memory`);
  }
}

async function deployFileEntry(
  ssh: SSHConnection,
  vm: VMRecord,
  entry: ManifestFileEntry,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const remotePath = entry.remotePath;
  const fileName = remotePath.split('/').pop() ?? remotePath;

  // Resolve content
  let content: string;
  if (entry.source === "template") {
    content = getTemplateContent((entry as { templateKey: string }).templateKey);
  } else {
    content = (entry as { content: string }).content;
  }

  switch (entry.mode) {
    case "overwrite": {
      if (dryRun) {
        result.fixed.push(`[dry-run] overwrite: ${fileName}`);
        return;
      }
      // Ensure parent directory exists
      const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
      await ssh.execCommand(`mkdir -p ${parentDir}`);

      if (entry.useSFTP) {
        // Use SFTP for large files to avoid EPIPE on echo|base64 pipe
        const tmpLocal = `/tmp/ic-manifest-${vm.id}-${fileName}`;
        fs.writeFileSync(tmpLocal, content, "utf-8");
        try {
          // Expand ~ to /home/<user> for SFTP (putFile doesn't expand ~)
          const expandedPath = remotePath.replace(/^~/, `/home/${vm.ssh_user}`);
          await ssh.putFile(tmpLocal, expandedPath);
        } finally {
          fs.unlinkSync(tmpLocal);
        }
      } else {
        const b64 = Buffer.from(content, 'utf-8').toString('base64');
        await ssh.execCommand(`echo '${b64}' | base64 -d > ${remotePath}`);
      }

      if (entry.executable) {
        await ssh.execCommand(`chmod +x ${remotePath}`);
      }
      result.fixed.push(fileName);
      break;
    }

    case "create_if_missing": {
      const check = await ssh.execCommand(
        `test -f ${remotePath} && echo exists || echo missing`
      );
      if (check.stdout.trim() === 'exists') {
        result.alreadyCorrect.push(fileName);
        return;
      }

      if (dryRun) {
        result.fixed.push(`[dry-run] create: ${fileName}`);
        return;
      }

      const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
      await ssh.execCommand(`mkdir -p ${parentDir}`);
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      await ssh.execCommand(`echo '${b64}' | base64 -d > ${remotePath}`);

      if (entry.executable) {
        await ssh.execCommand(`chmod +x ${remotePath}`);
      }
      result.fixed.push(fileName);
      break;
    }

    case "append_if_marker_absent": {
      const marker = (entry as { marker: string }).marker;

      // For AGENTS.md: only run if the file exists (legacy VMs only)
      if (remotePath.includes('AGENTS.md')) {
        const existsCheck = await ssh.execCommand(
          `test -f ${remotePath} && echo EXISTS || echo MISSING`
        );
        if (existsCheck.stdout.trim() === 'MISSING') {
          return; // Skip — file doesn't exist on this VM
        }
      }

      const markerCheck = await ssh.execCommand(
        `grep -qF "${marker}" ${remotePath} 2>/dev/null && echo PRESENT || echo ABSENT`
      );
      if (markerCheck.stdout.trim() === 'PRESENT') {
        result.alreadyCorrect.push(`${fileName} (${marker})`);
        return;
      }

      if (dryRun) {
        result.fixed.push(`[dry-run] append: ${fileName} (${marker})`);
        return;
      }

      // For large content, use SFTP to a tmp file then cat >> to append
      if (content.length > 4096) {
        const tmpLocal = `/tmp/ic-manifest-append-${vm.id}.md`;
        fs.writeFileSync(tmpLocal, content, "utf-8");
        try {
          await ssh.putFile(tmpLocal, '/tmp/ic-manifest-append.md');
        } finally {
          fs.unlinkSync(tmpLocal);
        }
        await ssh.execCommand(
          `cat /tmp/ic-manifest-append.md >> ${remotePath} && rm -f /tmp/ic-manifest-append.md`
        );
      } else {
        const b64 = Buffer.from(content, 'utf-8').toString('base64');
        await ssh.execCommand(`echo '${b64}' | base64 -d >> ${remotePath}`);
      }
      result.fixed.push(`${fileName} (${marker})`);
      break;
    }

    case "insert_before_marker": {
      const marker = (entry as { marker: string }).marker;
      const markerCheck = await ssh.execCommand(
        `grep -qF "Operating Principles" ${remotePath} 2>/dev/null && echo PRESENT || echo ABSENT`
      );
      if (markerCheck.stdout.trim() === 'PRESENT') {
        result.alreadyCorrect.push(`${fileName} (operating principles)`);
        return;
      }

      if (dryRun) {
        result.fixed.push(`[dry-run] insert: ${fileName} before ${marker}`);
        return;
      }

      // Use sed to insert before marker line
      // The content for insert_before_marker is already sed-escaped (uses \\n)
      await ssh.execCommand(
        `sed -i 's/^${marker.replace(/[/\\]/g, '\\$&')}/${content}${marker.replace(/[/\\]/g, '\\$&')}/' ${remotePath}`
      );
      result.fixed.push(`${fileName} (operating principles)`);
      break;
    }
  }
}

/**
 * Step 2b: Ensure .bootstrap_consumed exists on VMs that have already bootstrapped.
 *
 * The agent is supposed to create this file after the first conversation, but
 * it's unreliable — if missing, every /reset re-triggers the full "first moment
 * awake" intro. We detect already-bootstrapped VMs by checking for session files
 * (any .jsonl in the sessions directory = agent has been used).
 */
async function stepBootstrapConsumed(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const workspace = '~/.openclaw/workspace';
  const flag = `${workspace}/.bootstrap_consumed`;

  // Check if BOOTSTRAP.md exists but .bootstrap_consumed doesn't
  const check = await ssh.execCommand(
    `test -f ${workspace}/BOOTSTRAP.md && ! test -f ${flag} && echo NEEDS_FIX || echo OK`
  );

  if (check.stdout.trim() !== 'NEEDS_FIX') {
    result.alreadyCorrect.push('.bootstrap_consumed');
    return;
  }

  // Verify the agent has already been used (session files exist)
  const sessionCheck = await ssh.execCommand(
    `ls ~/.openclaw/agents/main/agent/sessions/*.jsonl 2>/dev/null | head -1 | grep -q . && echo HAS_SESSIONS || echo NO_SESSIONS`
  );

  if (sessionCheck.stdout.trim() !== 'HAS_SESSIONS') {
    // New VM — agent hasn't been used yet, don't create the flag
    result.alreadyCorrect.push('.bootstrap_consumed (new VM, skip)');
    return;
  }

  if (dryRun) {
    result.fixed.push('[dry-run] create .bootstrap_consumed (agent already bootstrapped)');
    return;
  }

  await ssh.execCommand(`touch ${flag}`);
  result.fixed.push('.bootstrap_consumed (safety: agent already bootstrapped)');
}

async function stepSkills(
  ssh: SSHConnection,
  vm: VMRecord,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  if (!manifest.skillsFromRepo) return;

  try {
    const skillsBaseDir = path.join(process.cwd(), "skills");
    if (!fs.existsSync(skillsBaseDir)) {
      result.errors.push("skills directory not found at " + skillsBaseDir);
      return;
    }

    const skillDirs = fs.readdirSync(skillsBaseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const deployLines: string[] = ['#!/bin/bash'];
    let skillCount = 0;

    for (const skillName of skillDirs) {
      const skillMdPath = path.join(skillsBaseDir, skillName, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, "utf-8");
      const b64 = Buffer.from(content, "utf-8").toString("base64");
      const remoteDir = `$HOME/.openclaw/skills/${skillName}`;

      deployLines.push(`mkdir -p "${remoteDir}"`);
      deployLines.push(`echo '${b64}' | base64 -d > "${remoteDir}/SKILL.md"`);
      skillCount++;
    }

    // Deploy extra skill files (e.g., sjinn-video references)
    for (const ref of manifest.extraSkillFiles) {
      const refPath = path.join(skillsBaseDir, ref.skillName, ref.localPath);
      if (!fs.existsSync(refPath)) continue;

      const content = fs.readFileSync(refPath, "utf-8");
      const b64 = Buffer.from(content, "utf-8").toString("base64");
      const remoteDir = `$HOME/.openclaw/skills/${ref.skillName}`;
      const remoteRefDir = path.dirname(`${remoteDir}/${ref.remotePath}`);
      deployLines.push(`mkdir -p "${remoteRefDir}"`);
      deployLines.push(`echo '${b64}' | base64 -d > "${remoteDir}/${ref.remotePath}"`);
    }

    if (skillCount === 0) return;

    if (dryRun) {
      result.fixed.push(`[dry-run] skill SKILL.md files (${skillCount} skills)`);
      return;
    }

    // Write deploy script to local tmp, SFTP it, then execute remotely
    const deployScript = deployLines.join('\n');
    const tmpLocal = `/tmp/ic-skill-deploy-${vm.id}.sh`;
    fs.writeFileSync(tmpLocal, deployScript, "utf-8");
    try {
      await ssh.putFile(tmpLocal, '/tmp/ic-skill-deploy.sh');
    } finally {
      fs.unlinkSync(tmpLocal);
    }
    await ssh.execCommand('bash /tmp/ic-skill-deploy.sh && rm -f /tmp/ic-skill-deploy.sh');
    result.fixed.push(`skill SKILL.md files (${skillCount} skills)`);
  } catch (err) {
    result.errors.push(`skills deployment: ${String(err)}`);
  }
}

async function stepCronJobs(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  for (const job of manifest.cronJobs) {
    const check = await ssh.execCommand(
      `crontab -l 2>/dev/null | grep -qF "${job.marker}" && echo PRESENT || echo ABSENT`
    );

    if (check.stdout.trim() === 'PRESENT') {
      result.alreadyCorrect.push(`cron: ${job.marker}`);
      continue;
    }

    if (dryRun) {
      result.fixed.push(`[dry-run] cron: ${job.marker}`);
      continue;
    }

    await ssh.execCommand(
      `(crontab -l 2>/dev/null; echo "${job.schedule} ${job.command}") | crontab -`
    );
    result.fixed.push(`${job.marker} cron`);
  }
}

async function stepSystemPackages(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const packages = manifest.systemPackages as readonly string[];
  if (packages.length === 0) return;

  try {
    // Check all packages in one command
    const checks = packages
      .map((pkg) => `echo "${pkg}:$(which ${pkg} >/dev/null 2>&1 && echo OK || echo MISSING)"`)
      .join('; ');
    const checkResult = await ssh.execCommand(checks);

    for (const pkg of packages) {
      if (checkResult.stdout.includes(`${pkg}:OK`)) {
        result.alreadyCorrect.push(`pkg: ${pkg}`);
        continue;
      }

      if (dryRun) {
        result.fixed.push(`[dry-run] install: ${pkg}`);
        continue;
      }

      const install = await ssh.execCommand(
        `sudo -n true 2>/dev/null && sudo apt-get update -qq 2>/dev/null && sudo apt-get install -y -qq ${pkg} 2>/dev/null && echo INSTALLED || echo SKIP`
      );
      if (install.stdout.includes('INSTALLED')) {
        result.fixed.push(`${pkg} (installed)`);
      } else {
        result.errors.push(`${pkg}: install skipped (no sudo or apt-get failed)`);
      }
    }
  } catch (err) {
    result.errors.push(`system packages: ${String(err)}`);
  }
}

async function stepPythonPackages(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const packages = manifest.pythonPackages as readonly string[];
  if (packages.length === 0) return;

  try {
    const checks = packages
      .map((pkg) => `echo "${pkg}:$(python3 -c 'import ${pkg}' 2>/dev/null && echo OK || echo MISSING)"`)
      .join('; ');
    const checkResult = await ssh.execCommand(checks);

    for (const pkg of packages) {
      if (checkResult.stdout.includes(`${pkg}:OK`)) {
        result.alreadyCorrect.push(`python: ${pkg}`);
        continue;
      }

      if (dryRun) {
        result.fixed.push(`[dry-run] pip install: ${pkg}`);
        continue;
      }

      const install = await ssh.execCommand(
        `export PATH="$HOME/.local/bin:$PATH"; pip3 install --break-system-packages --quiet ${pkg} 2>/dev/null || pip3 install --user --quiet ${pkg} 2>/dev/null; python3 -c "import ${pkg}" 2>/dev/null && echo INSTALLED || echo FAIL`
      );
      if (install.stdout.includes('INSTALLED')) {
        result.fixed.push(`${pkg} python (installed)`);
      } else {
        result.errors.push(`python ${pkg}: pip install failed`);
      }
    }
  } catch (err) {
    result.errors.push(`python packages: ${String(err)}`);
  }
}

async function stepEnvVars(
  ssh: SSHConnection,
  vm: VMRecord & { gateway_token?: string },
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Map env var names to their values from the VM record
  const envValues: Record<string, string | undefined> = {
    GATEWAY_TOKEN: vm.gateway_token,
  };

  for (const envName of manifest.requiredEnvVars) {
    const value = envValues[envName];
    if (!value) continue; // No value available in DB — skip

    const check = await ssh.execCommand(
      `grep -q "^${envName}=" "$HOME/.openclaw/.env" 2>/dev/null && echo PRESENT || echo ABSENT`
    );

    if (check.stdout.trim() === 'PRESENT') {
      result.alreadyCorrect.push(envName);
      continue;
    }

    if (dryRun) {
      result.fixed.push(`[dry-run] env: ${envName}`);
      continue;
    }

    await ssh.execCommand(`echo "${envName}=${value}" >> "$HOME/.openclaw/.env"`);
    result.fixed.push(envName);
  }
}

async function stepAuthProfiles(
  ssh: SSHConnection,
  vm: VMRecord & { gateway_token?: string; api_mode?: string },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<boolean> {
  if (!vm.api_mode || !vm.gateway_token) return false;

  const expectedProxyBaseUrl =
    (process.env.NEXTAUTH_URL || "https://instaclaw.io").trim() + "/api/gateway";

  const authReadResult = await ssh.execCommand(
    'cat ~/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null'
  );

  let needsFix = false;
  let fixReason = '';

  if (authReadResult.code !== 0 || !authReadResult.stdout.trim()) {
    needsFix = true;
    fixReason = 'missing file';
  } else {
    try {
      const authData = JSON.parse(authReadResult.stdout);
      const profile = authData?.profiles?.["anthropic:default"];

      if (!profile) {
        needsFix = true;
        fixReason = 'missing anthropic:default profile';
      } else if (vm.api_mode === "all_inclusive") {
        if (profile.baseUrl !== expectedProxyBaseUrl) {
          needsFix = true;
          fixReason = `wrong baseUrl: ${profile.baseUrl ?? 'null'} (expected ${expectedProxyBaseUrl})`;
        } else if (profile.key !== vm.gateway_token) {
          needsFix = true;
          fixReason = 'key does not match gateway_token';
        }
      } else if (vm.api_mode === "byok") {
        if (profile.baseUrl === expectedProxyBaseUrl) {
          needsFix = true;
          fixReason = 'BYOK VM has proxy baseUrl set — should route direct to Anthropic';
        }
      }
    } catch {
      needsFix = true;
      fixReason = 'invalid JSON';
    }
  }

  if (!needsFix) {
    result.alreadyCorrect.push('auth-profiles.json');
    return false;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] auth-profiles.json (${fixReason})`);
    return false;
  }

  logger.warn("auth-profiles.json misconfigured, auto-fixing", {
    route: "reconcileVM",
    vmId: vm.id,
    apiMode: vm.api_mode,
    reason: fixReason,
  });

  // BYOK VMs need manual reconfigure — can't recover user's API key
  if (vm.api_mode === "byok") {
    logger.error("BYOK auth-profiles.json needs reconfigure — cannot auto-fix without decrypted API key", {
      route: "reconcileVM",
      vmId: vm.id,
      reason: fixReason,
    });
    result.fixed.push(`auth-profiles.json (BYOK — needs manual reconfigure: ${fixReason})`);
    return false;
  }

  // Rebuild auth-profiles.json for all-inclusive VMs
  const authProfileData: Record<string, unknown> = {
    type: "api_key",
    provider: "anthropic",
    key: vm.gateway_token,
    baseUrl: expectedProxyBaseUrl,
  };
  const authProfile = JSON.stringify({
    profiles: { "anthropic:default": authProfileData },
  });
  const authB64 = Buffer.from(authProfile).toString("base64");
  await ssh.execCommand(
    `mkdir -p ~/.openclaw/agents/main/agent && echo '${authB64}' | base64 -d > ~/.openclaw/agents/main/agent/auth-profiles.json`
  );
  result.fixed.push(`auth-profiles.json (${fixReason})`);

  logger.info("TOKEN_AUDIT: reconcileVM rewrote auth-profiles.json", {
    operation: "reconcileVM",
    vmId: vm.id,
    tokenPrefix: vm.gateway_token.slice(0, 8),
    fixReason,
  });

  return true; // Signals gateway restart needed
}

async function stepGatewayRestart(
  ssh: SSHConnection,
  vm: VMRecord,
  result: ReconcileResult,
): Promise<void> {
  result.gatewayRestarted = true;

  await ssh.execCommand(
    'systemctl --user restart openclaw-gateway 2>/dev/null || ' +
    '(pkill -9 -f "openclaw-gateway" 2>/dev/null; sleep 2; systemctl --user start openclaw-gateway) || true'
  );

  // Verify gateway comes back healthy (up to 30s, per CLAUDE.md rule #5)
  let healthy = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const healthCheck = await ssh.execCommand('curl -sf http://localhost:18789/health 2>/dev/null');
    if (healthCheck.code === 0) {
      healthy = true;
      break;
    }
  }

  result.gatewayHealthy = healthy;

  if (healthy) {
    result.fixed.push('gateway restarted (verified healthy)');
  } else {
    logger.error("Gateway not healthy after reconcile restart — health cron will handle recovery", {
      route: "reconcileVM",
      vmId: vm.id,
    });
    result.fixed.push('gateway restarted (WARNING: health check failed post-restart)');
  }
}

/**
 * Step 8b: Patch the openclaw-gateway.service systemd unit file.
 * Ensures KillMode=mixed (kill Chrome children), crash-loop circuit breaker,
 * and Chrome orphan cleanup on start. Prevents the Mucus incident (15.5h crash
 * loop with zombie Chrome processes).
 */
async function stepSystemdUnit(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const overrides = manifest.systemdOverrides;
  if (!overrides) return;

  const unitPath = "$HOME/.config/systemd/user/openclaw-gateway.service";

  // Check if unit file exists
  const check = await ssh.execCommand(`[ -f ${unitPath} ] && echo EXISTS || echo MISSING`);
  if (check.stdout.trim() !== "EXISTS") {
    result.alreadyCorrect.push("systemd unit: not installed (skip)");
    return;
  }

  // Read current unit content to check what needs patching
  const catResult = await ssh.execCommand(`cat ${unitPath}`);
  const currentUnit = catResult.stdout;

  const patches: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    if (key === "ExecStartPre") {
      // ExecStartPre is special — check if any ExecStartPre exists
      if (!currentUnit.includes("ExecStartPre=")) {
        patches.push(`sed -i '/^ExecStart=/i ExecStartPre=${value.replace(/'/g, "'\\''")}'  ${unitPath}`);
      }
    } else {
      // For all other keys, check if the current value matches
      const regex = new RegExp(`^${key}=(.*)$`, "m");
      const match = currentUnit.match(regex);
      if (match && match[1] === value) {
        continue; // Already correct
      }
      if (match) {
        // Key exists but wrong value — replace
        patches.push(`sed -i 's/^${key}=.*/${key}=${value.replace(/\//g, "\\/")}/' ${unitPath}`);
      } else {
        // Key missing — add to appropriate section
        const section = ["StartLimitBurst", "StartLimitIntervalSec", "StartLimitAction"].includes(key)
          ? "\\[Unit\\]"
          : "\\[Service\\]";
        patches.push(`sed -i '/${section}/a ${key}=${value}' ${unitPath}`);
      }
    }
  }

  if (patches.length === 0) {
    result.alreadyCorrect.push("systemd unit: all overrides correct");
    return;
  }

  if (dryRun) {
    result.fixed.push(`systemd unit: would apply ${patches.length} patches`);
    return;
  }

  // Apply all patches and reload
  const patchCmd = patches.join(" && ") + " && systemctl --user daemon-reload";
  const patchResult = await ssh.execCommand(patchCmd);
  if (patchResult.code === 0) {
    result.fixed.push(`systemd unit: applied ${patches.length} patches (${Object.keys(overrides).join(", ")})`);
    result.gatewayRestartNeeded = true;
  } else {
    result.errors.push(`systemd unit patch failed: ${patchResult.stderr}`);
  }
}
