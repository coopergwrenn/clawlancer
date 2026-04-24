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

import { VM_MANIFEST, CONFIG_SPEC, getTemplateContent, type ManifestFileEntry } from "./vm-manifest";
import { connectSSH, NVM_PREAMBLE, type VMRecord } from "./ssh";
import { getSupabase } from "./supabase";
import { logger } from "./logger";
import { TIER_DISPLAY_LIMITS } from "./credit-constants";
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
  /**
   * Per-key config-set failures observed in strict mode (non-empty only when
   * `strict: true` was passed). Each entry is `"key: reason"`. If this array
   * is non-empty, the caller MUST NOT advance `config_version` for this VM.
   */
  strictErrors: string[];
  /**
   * Canary probe outcome — only populated when `strict: true`.
   *   true  → proxy round-trip succeeded, response asserted "READY"
   *   false → round-trip failed (also pushed into `strictErrors` as "canary: ...")
   *   null  → canary was skipped: either strict mode was off, the VM has no
   *           gateway_token (BYOK), or the VM was at its daily budget limit.
   */
  canaryHealthy: boolean | null;
  /**
   * True when the canary step skipped specifically because the VM was at
   * ≥95% of its daily message limit (budget guard). Surfaced separately
   * from `canaryHealthy: null` so the cron can track "how often budget
   * is blocking coverage" vs "how often canary legitimately ran".
   */
  canarySkippedBudget: boolean;
}

export interface ReconcileOptions {
  /** If true, log intended changes without writing. Existing behavior. */
  dryRun?: boolean;
  /**
   * Strict mode. When true:
   *   - stepConfigSettings runs each `openclaw config set` INDIVIDUALLY
   *     (no `&& ... || true` batch), captures per-key exit codes + stderr,
   *     and records failures in `result.strictErrors`.
   *   - stepCanaryProbe runs AFTER the normal reconciler steps (unless the
   *     caller explicitly opts out via `canary: false`).
   *   - The caller (reconcile-fleet cron / admin endpoint) is responsible
   *     for NOT bumping config_version when `strictErrors.length > 0`.
   *
   * Default false. When false, behavior is bit-identical to the previous
   * implementation (batched config set with silent failures, no canary).
   */
  strict?: boolean;
  /**
   * Strict-mode canary toggle. Only meaningful when `strict: true`.
   * Default true. Set to false to skip the canary round-trip (e.g., when
   * the DB kill-switch `canary_enabled=false` — Anthropic rate-limit
   * emergency). Config-set strict validation still runs.
   */
  canary?: boolean;
}

// ── Reconciliation engine ──

export async function reconcileVM(
  vm: VMRecord & { gateway_token?: string; api_mode?: string },
  manifest: typeof VM_MANIFEST,
  options?: ReconcileOptions,
): Promise<ReconcileResult> {
  const dryRun = options?.dryRun ?? false;
  const strict = options?.strict ?? false;
  const canaryEnabled = options?.canary ?? true;
  const result: ReconcileResult = {
    fixed: [],
    alreadyCorrect: [],
    errors: [],
    gatewayRestartNeeded: false,
    gatewayRestarted: false,
    gatewayHealthy: true,
    strictErrors: [],
    canaryHealthy: null,
    canarySkippedBudget: false,
  };

  const ssh = await connectSSH(vm);

  // ── Strict-mode outer deadline ──
  // Budget the ENTIRE reconcile (all steps including canary) at 180s when
  // strict: true. Without this, pathological VMs (stuck openclaw CLI, slow
  // SSH) can burn the full Vercel 300s budget on a single VM and stall the
  // whole cron batch. Implemented via Promise.race — accept the limitation
  // that in-flight SSH commands may complete after the deadline (see
  // phase-2c-v2-todo.md for signal-threaded cancellation).
  const STRICT_DEADLINE_MS = 180_000;
  const STRICT_WARN_AT_MS = 150_000;
  let currentStep: string = "init";
  const warnTimer = strict
    ? setTimeout(() => {
        logger.warn("reconcileVM: approaching 180s strict deadline", {
          route: "reconcileVM",
          vmId: vm.id,
          currentStep,
          elapsedMs: STRICT_WARN_AT_MS,
        });
      }, STRICT_WARN_AT_MS)
    : null;

  const runSteps = async (): Promise<void> => {
    // ── Step 0: Pre-audit workspace backup ──
    currentStep = "backup";
    await stepBackup(ssh);

    // ── Step 0b: Remove _placeholder key from openclaw.json ──
    // Some VMs were provisioned with {"_placeholder": true} which fails
    // OpenClaw's strict config validator, blocking all config set operations.
    currentStep = "placeholder";
    await stepRemovePlaceholder(ssh, result, dryRun);

    // ── Step 0c: Workspace integrity — ensure critical files exist ──
    currentStep = "workspace-integrity";
    await stepWorkspaceIntegrity(ssh, result, dryRun);

    // ── Step 1: Config settings ──
    currentStep = "config-settings";
    await stepConfigSettings(ssh, manifest, result, dryRun, strict);

    // ── Step 2: Files ──
    currentStep = "files";
    await stepFiles(ssh, vm, manifest, result, dryRun);

    // ── Step 2b: Bootstrap safety ──
    currentStep = "bootstrap-consumed";
    await stepBootstrapConsumed(ssh, result, dryRun);

    // ── Step 2c: Rename video-production → motion-graphics ──
    currentStep = "rename-video-skill";
    await stepRenameVideoSkill(ssh, result, dryRun);

    // ── Step 2d: Fix blank identity in SOUL.md + remove legacy IDENTITY.md ──
    currentStep = "fix-blank-identity";
    await stepFixBlankIdentity(ssh, result, dryRun);

    // ── Step 2e: Remove duplicate skill directories that waste prompt budget ──
    currentStep = "remove-duplicate-skills";
    await stepRemoveDuplicateSkills(ssh, result, dryRun);

    // ── Step 3: Skills ──
    currentStep = "skills";
    await stepSkills(ssh, vm, manifest, result, dryRun);

    // ── Step 3b: Remotion dependencies (npm install in motion-graphics template) ──
    currentStep = "remotion-deps";
    await stepRemotionDeps(ssh, result, dryRun);

    // ── Step 4: Cron jobs ──
    currentStep = "cron-jobs";
    await stepCronJobs(ssh, manifest, result, dryRun);

    // ── Step 5: System packages ──
    currentStep = "system-packages";
    await stepSystemPackages(ssh, manifest, result, dryRun);

    // ── Step 6: Python packages ──
    currentStep = "python-packages";
    await stepPythonPackages(ssh, manifest, result, dryRun);

    // ── Step 7: Env vars ──
    currentStep = "env-vars";
    await stepEnvVars(ssh, vm, manifest, result, dryRun);

    // ── Step 8: Auth profiles ──
    currentStep = "auth-profiles";
    const authProfileFixed = await stepAuthProfiles(ssh, vm, result, dryRun);

    // ── Step 8b: Clear stale provider cooldown from auth-profiles.json ──
    currentStep = "clear-provider-cooldown";
    const cooldownCleared = await stepClearProviderCooldown(ssh, result, dryRun);
    if (cooldownCleared) result.gatewayRestartNeeded = true;

    // ── Step 8c: Systemd unit overrides (KillMode, crash-loop breaker, Chrome cleanup) ──
    currentStep = "systemd-unit";
    await stepSystemdUnit(ssh, manifest, result, dryRun);

    // ── Step 8d: sshd OOM protection (OOMScoreAdjust=-900 drop-in) ──
    currentStep = "sshd-protection";
    await stepSSHDProtection(ssh, result, dryRun);

    // ── Step 8e: Clean stale memory entries (proxy down, geoblock, etc.) ──
    currentStep = "clean-stale-memory";
    await stepCleanStaleMemory(ssh, result, dryRun);

    // ── Step 8f: Caddy UI block (redirect / to instaclaw.io/dashboard) ──
    currentStep = "caddy-ui-block";
    await stepCaddyUIBlock(ssh, result, dryRun);

    // ── Step 9: Gateway restart (if auth-profiles changed or cooldown cleared) ──
    if ((authProfileFixed || result.gatewayRestartNeeded) && !dryRun) {
      currentStep = "gateway-restart";
      result.gatewayRestartNeeded = true;
      await stepGatewayRestart(ssh, vm, result);
    }

    // ── Step 10: Canary probe (strict mode only) ──
    if (strict && canaryEnabled) {
      currentStep = "canary";
      await stepCanaryProbe(vm, result);
    } else if (strict && !canaryEnabled) {
      // DB kill-switch `canary_enabled=false` — strict config validation
      // still ran above, just don't run the round-trip. Leave
      // canaryHealthy=null so the caller knows the check was skipped.
      logger.info("stepCanaryProbe: skipped (canary_enabled=false)", {
        route: "reconcileVM",
        vmId: vm.id,
      });
    }
    currentStep = "done";
  };

  try {
    if (strict) {
      // Race the step runner against a 180s rejection. On deadline win, we
      // fall into the catch with a sentinel error and record the timeout in
      // strictErrors — any in-flight SSH command continues on the VM side
      // but our client returns cleanly.
      await Promise.race([
        runSteps(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("__STRICT_DEADLINE__")), STRICT_DEADLINE_MS),
        ),
      ]);
    } else {
      await runSteps();
    }
  } catch (err) {
    if (err instanceof Error && err.message === "__STRICT_DEADLINE__") {
      // Deadline win — record the timeout in strictErrors and let the
      // finally dispose SSH. In-flight SSH commands may still execute on
      // the VM side; the reconciler is idempotent so next cron cycle
      // re-evaluates and fixes whatever partial state resulted.
      const msg = `deadline: strict reconcile timeout after ${STRICT_DEADLINE_MS}ms (last step: ${currentStep})`;
      result.strictErrors.push(msg);
      logger.error("reconcileVM: strict deadline exceeded", {
        route: "reconcileVM",
        vmId: vm.id,
        lastStep: currentStep,
        deadlineMs: STRICT_DEADLINE_MS,
      });
    } else {
      // Non-deadline error — re-throw so the caller (auditVMConfig →
      // reconcile-fleet) catches it as a normal audit failure. The finally
      // block still runs ssh.dispose() + clearTimeout.
      throw err;
    }
  } finally {
    if (warnTimer) clearTimeout(warnTimer);
    ssh.dispose();
  }

  return result;
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

/**
 * Step 0c: Workspace integrity check.
 * Verifies that critical workspace files (SOUL.md, CAPABILITIES.md, MEMORY.md)
 * exist. If missing, creates a minimal version so subsequent reconciler steps
 * (append_if_marker_absent, insert_before_marker) don't silently fail.
 *
 * This catches VMs where configureOpenClaw() partially failed but the VM was
 * still marked as ready.
 */
async function stepWorkspaceIntegrity(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const workspaceDir = "$HOME/.openclaw/workspace";

  // Check which required files are missing in a single SSH call
  const checkCommands = CONFIG_SPEC.requiredWorkspaceFiles
    .map((f) => `test -f ${workspaceDir}/${f} && echo "OK:${f}" || echo "MISSING:${f}"`)
    .join(" && ");
  const checkResult = await ssh.execCommand(checkCommands);

  const missing: string[] = [];
  for (const line of checkResult.stdout.split("\n")) {
    const m = line.match(/^MISSING:(.+)$/);
    if (m) missing.push(m[1]);
  }

  if (missing.length === 0) {
    result.alreadyCorrect.push("workspace: all critical files present");
    return;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] workspace: would create missing files: ${missing.join(", ")}`);
    return;
  }

  // Create missing files with minimal content so append/insert steps work
  const MINIMAL_TEMPLATES: Record<string, string> = {
    "SOUL.md": [
      "# SOUL.md — Who You Are",
      "",
      "_You're not a chatbot. You're becoming someone._",
      "",
      "## My Identity",
      "",
      "Your identity develops naturally through your conversations.",
      "",
      "## Hard Boundaries",
      "",
      "- Private things stay private. Period.",
      "- When in doubt, ask before acting externally.",
      "- **NEVER run `openclaw update` or `npm install -g openclaw`.** Your platform version is managed by InstaClaw.",
      "",
    ].join("\n"),
    "CAPABILITIES.md": [
      "# CAPABILITIES.md — What You Can Do",
      "",
      "_This file is managed by InstaClaw. It will be updated automatically._",
      "",
    ].join("\n"),
    "MEMORY.md": [
      "# MEMORY.md - Long-Term Memory",
      "",
      "_Start capturing what matters here. Decisions, context, things to remember._",
      "",
      "---",
    ].join("\n"),
  };

  await ssh.execCommand(`mkdir -p ${workspaceDir}`);

  for (const fileName of missing) {
    const template = MINIMAL_TEMPLATES[fileName];
    if (!template) {
      result.errors.push(`workspace: ${fileName} missing, no template available`);
      continue;
    }

    const b64 = Buffer.from(template, "utf-8").toString("base64");
    const writeResult = await ssh.execCommand(
      `echo '${b64}' | base64 -d > ${workspaceDir}/${fileName}`
    );

    if (writeResult.code === 0) {
      result.fixed.push(`workspace: created missing ${fileName}`);
      logger.warn(`[reconcile] Created missing workspace file: ${fileName}`, {
        note: "configureOpenClaw() may have partially failed on this VM",
      });
    } else {
      result.errors.push(`workspace: failed to create ${fileName}: ${writeResult.stderr}`);
    }
  }
}

async function stepConfigSettings(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
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

  if (!strict) {
    // Default (non-strict) path — BIT-IDENTICAL to the previous implementation.
    // Batched, `|| true` per key, no error capture. Preserved so Phase 2c
    // diffs deploy dormant when STRICT_RECONCILE_VM_IDS is unset, and existing
    // per-VM reconciles from callers that don't pass `strict: true` behave
    // exactly as they do today.
    const fixCommands = settingsToFix
      .map((key) => `openclaw config set ${key} '${settings[key]}' || true`)
      .join(' && ');
    await ssh.execCommand(`${NVM_PREAMBLE} && ${fixCommands}`);
    result.fixed.push(...settingsToFix);
    return;
  }

  // Strict path — per-key execution, no silent swallowing.
  //
  // We run each `openclaw config set` individually so a single exit code
  // + stderr maps to a single key. Any non-zero exit → the key is NOT
  // counted in `result.fixed` and the error is recorded in
  // `result.strictErrors`. Caller inspects strictErrors before bumping
  // config_version.
  //
  // This is the regression fix for the v59/v60 incident: a schema-rejected
  // key (`gateway.openai.chatCompletionsEnabled`) was silently swallowed by
  // `|| true`, config_version advanced, and every VM in the fleet looked
  // "up to date" while chat completions were disabled in prod.
  for (const key of settingsToFix) {
    const val = settings[key];
    const cmd = `${NVM_PREAMBLE} && openclaw config set ${key} '${val}'`;
    const res = await ssh.execCommand(cmd, { execOptions: { timeout: 15000 } });
    if (res.code === 0) {
      result.fixed.push(key);
    } else {
      const reason = (res.stderr || res.stdout || `exit ${res.code}`).slice(0, 300).trim();
      result.strictErrors.push(`${key}: ${reason}`);
    }
  }
}

/**
 * Canary probe — strict mode only.
 *
 * Sends a REAL user-chat request (not the default "ping" probe) through the
 * proxy with `x-strict-canary: true` so the proxy's heartbeat classification
 * is bypassed and the request hits Anthropic haiku — not the MiniMax
 * heartbeat shortcut. This is the whole point of strict canary: it catches
 * Anthropic-path breakage that the default ping probe silently misses.
 *
 * Writes the outcome to `result.canaryHealthy`:
 *   true  → proxy round-trip passed, response contains "READY"
 *   false → round-trip failed (also pushed into strictErrors as "canary: ...")
 *   null  → probe skipped (no gateway_token, or VM at budget limit)
 *
 * Budget guard: if the VM is already at 95%+ of its daily message limit when
 * the canary would fire, skip to avoid pushing the user over their quota.
 * Logged as `canary skipped: vm at budget limit` and recorded in the
 * per-batch counter so we can track how often this fires.
 */
async function stepCanaryProbe(
  vm: VMRecord & {
    gateway_token?: string;
    api_mode?: string;
    tier?: string | null;
    user_timezone?: string | null;
  },
  result: ReconcileResult,
): Promise<void> {
  if (!vm.gateway_token) {
    // BYOK VMs and pre-configured VMs have no platform token — the round-trip
    // probe doesn't apply. Null signals "skipped, not tested" to the caller.
    result.canaryHealthy = null;
    return;
  }

  // ── Budget guard ───────────────────────────────────────────────────────
  // Skip canary (DON'T fail it) if the target VM is already at ≥95% of its
  // daily tier limit. Firing here would push them over and degrade UX.
  // Tradeoff: miss canary coverage for that VM until next cycle; accept.
  // See phase-2c-v2-todo.md for canary-budget-bypass RPC flag (canary
  // wouldn't count against user quota at all).
  try {
    const tier = (vm.tier ?? "starter") as string;
    const limit = TIER_DISPLAY_LIMITS[tier] ?? TIER_DISPLAY_LIMITS.starter;
    const userTz = vm.user_timezone ?? "America/New_York";
    const supabase = getSupabase();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: userTz });
    const { data: usage } = await supabase
      .from("instaclaw_daily_usage")
      .select("message_count")
      .eq("vm_id", vm.id)
      .eq("usage_date", today)
      .maybeSingle();
    const count = usage?.message_count ?? 0;
    if (limit > 0 && count / limit >= 0.95) {
      logger.info("stepCanaryProbe: skipped (vm at budget limit)", {
        route: "reconcileVM",
        vmId: vm.id,
        tier,
        count,
        limit,
        pct: Math.round((count / limit) * 100),
      });
      result.canaryHealthy = null;
      result.canarySkippedBudget = true;
      return;
    }
  } catch (budgetErr) {
    // Budget lookup failure is non-fatal — fall through to run canary normally.
    logger.warn("stepCanaryProbe: budget check failed (proceeding anyway)", {
      route: "reconcileVM",
      vmId: vm.id,
      error: String(budgetErr),
    });
  }

  // Lazy import to avoid pulling ssh.ts's heavy graph into vm-reconcile when
  // strict mode isn't exercised.
  const { testProxyRoundTrip } = await import("./ssh");
  // strictCanary: true forces the "Reply with one word: READY" content + the
  // x-strict-canary bypass header, routing through Anthropic haiku not MiniMax.
  const probe = await testProxyRoundTrip(vm.gateway_token, 1, { strictCanary: true });
  result.canaryHealthy = probe.success;
  if (!probe.success) {
    result.strictErrors.push(`canary: ${probe.error ?? "round-trip failed"}`);
  }
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

      // Check if target file exists first
      const fileExistsCheck = await ssh.execCommand(
        `test -f ${remotePath} && echo EXISTS || echo MISSING`
      );
      if (fileExistsCheck.stdout.trim() === 'MISSING') {
        // For AGENTS.md: skip entirely (legacy VMs only)
        if (remotePath.includes('AGENTS.md')) {
          return;
        }
        // For other files: log error — stepWorkspaceIntegrity should have created it
        result.errors.push(`${fileName}: target file missing, cannot append (${marker})`);
        return;
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

      // Check if target file exists first
      const insertFileCheck = await ssh.execCommand(
        `test -f ${remotePath} && echo EXISTS || echo MISSING`
      );
      if (insertFileCheck.stdout.trim() === 'MISSING') {
        result.errors.push(`${fileName}: target file missing, cannot insert before ${marker}`);
        return;
      }

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
 * Step 2b: Clean up bootstrap on VMs that have already bootstrapped.
 *
 * The agent is supposed to delete BOOTSTRAP.md after the first conversation,
 * but it's unreliable. If BOOTSTRAP.md still exists, the agent reads it on
 * every new session and re-triggers the "first moment awake" intro — the
 * .bootstrap_consumed sentinel in SOUL.md is a rule the agent SHOULD follow
 * but doesn't reliably check before reading BOOTSTRAP.md directly.
 *
 * Fix: delete BOOTSTRAP.md AND create .bootstrap_consumed on VMs where the
 * agent has already been used (session files exist). New VMs (no sessions)
 * are left alone so the first-run bootstrap works normally.
 */
async function stepBootstrapConsumed(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const workspace = '~/.openclaw/workspace';
  const bootstrapFile = `${workspace}/BOOTSTRAP.md`;
  const flag = `${workspace}/.bootstrap_consumed`;

  // Check if BOOTSTRAP.md still exists
  const check = await ssh.execCommand(
    `test -f ${bootstrapFile} && echo EXISTS || echo GONE`
  );

  if (check.stdout.trim() !== 'EXISTS') {
    result.alreadyCorrect.push('bootstrap (BOOTSTRAP.md already removed)');
    return;
  }

  // BOOTSTRAP.md exists — check if agent has already been used
  const sessionCheck = await ssh.execCommand(
    `ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -1 | grep -q . && echo HAS_SESSIONS || echo NO_SESSIONS`
  );

  if (sessionCheck.stdout.trim() !== 'HAS_SESSIONS') {
    // New VM — agent hasn't been used yet, leave BOOTSTRAP.md for first-run
    result.alreadyCorrect.push('bootstrap (new VM, keeping BOOTSTRAP.md)');
    return;
  }

  // Agent has sessions — BOOTSTRAP.md should have been deleted after first conversation
  if (dryRun) {
    result.fixed.push('[dry-run] delete BOOTSTRAP.md + create .bootstrap_consumed');
    return;
  }

  await ssh.execCommand(`rm -f ${bootstrapFile} && touch ${flag}`);
  result.fixed.push('bootstrap cleanup (deleted BOOTSTRAP.md, created .bootstrap_consumed)');
}

async function stepFixBlankIdentity(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const workspace = '~/.openclaw/workspace';
  const soulFile = `${workspace}/SOUL.md`;
  const identityFile = `${workspace}/IDENTITY.md`;

  // Check if SOUL.md has the blank identity template
  const check = await ssh.execCommand(
    `grep -c '_(pick something you like)_' ${soulFile} 2>/dev/null || echo 0`
  );
  const isBlank = parseInt(check.stdout.trim(), 10) > 0;

  if (!isBlank) {
    // Also clean up legacy IDENTITY.md if it has the blank template
    const legacyCheck = await ssh.execCommand(
      `grep -c '_(pick something you like)_' ${identityFile} 2>/dev/null || echo 0`
    );
    if (parseInt(legacyCheck.stdout.trim(), 10) > 0) {
      if (!dryRun) {
        await ssh.execCommand(`rm -f ${identityFile}`);
        result.fixed.push('identity (deleted blank legacy IDENTITY.md)');
      } else {
        result.fixed.push('[dry-run] delete blank legacy IDENTITY.md');
      }
    } else {
      result.alreadyCorrect.push('identity (SOUL.md already personalized)');
    }
    return;
  }

  // SOUL.md has blank identity — replace the template section
  // The blank section spans from "## My Identity" to "## How I Communicate"
  // Replace the placeholder content with a neutral default
  const replacement = [
    '## My Identity',
    '',
    'Your identity develops naturally through your conversations. There is no need to',
    'announce or figure out your identity — just be helpful, be yourself, and let your',
    'personality emerge organically over time.',
    '',
    'If your user gives you a name or asks you to define your personality, update this',
    'section with what you decide together.',
    '',
  ].join('\\n');

  if (dryRun) {
    result.fixed.push('[dry-run] fix blank identity in SOUL.md');
    return;
  }

  // Use sed to replace the blank identity section
  // Match from "## My Identity" through the blank template to the line before "## How I Communicate"
  await ssh.execCommand(
    `sed -i '/^## My Identity$/,/^## How I Communicate$/{ /^## How I Communicate$/!d; }' ${soulFile} && ` +
    `sed -i '/^## How I Communicate$/i\\${replacement}' ${soulFile}`
  );

  // Verify it worked
  const verify = await ssh.execCommand(
    `grep -c '_(pick something you like)_' ${soulFile} 2>/dev/null || echo 0`
  );
  if (parseInt(verify.stdout.trim(), 10) > 0) {
    result.errors.push('identity fix failed — blank template still in SOUL.md');
    return;
  }

  result.fixed.push('identity (replaced blank template in SOUL.md)');

  // Also delete legacy blank IDENTITY.md
  await ssh.execCommand(`rm -f ${identityFile}`);
}

// Known duplicate skill directories that waste prompt budget.
// polymarket is identical to prediction-markets; solana-defi.disabled is identical to solana-defi.
const DUPLICATE_SKILL_DIRS = ["polymarket", "solana-defi.disabled"];

async function stepRemoveDuplicateSkills(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  for (const dir of DUPLICATE_SKILL_DIRS) {
    const check = await ssh.execCommand(
      `[ -d ~/.openclaw/skills/${dir} ] && echo "EXISTS" || echo "GONE"`
    );
    if (check.stdout.trim() === "EXISTS") {
      if (dryRun) {
        result.fixed.push(`[dry-run] remove duplicate skill dir: ${dir}`);
      } else {
        await ssh.execCommand(`rm -rf ~/.openclaw/skills/${dir}`);
        result.fixed.push(`removed duplicate skill dir: ${dir}`);
        logger.info(`[reconcile] Removed duplicate skill directory: ${dir}`);
      }
    } else {
      result.alreadyCorrect.push(`no duplicate: ${dir}`);
    }
  }
}

async function stepRemovePlaceholder(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const check = await ssh.execCommand(
    `python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/openclaw.json')); print('YES' if '_placeholder' in d else 'NO')" 2>/dev/null || echo "SKIP"`
  );
  const has = check.stdout.trim();
  if (has === "YES") {
    if (dryRun) {
      result.fixed.push("[dry-run] remove _placeholder from openclaw.json");
    } else {
      await ssh.execCommand(
        `python3 -c "
import json
p='/home/openclaw/.openclaw/openclaw.json'
d=json.load(open(p))
del d['_placeholder']
json.dump(d, open(p,'w'), indent=2)
" 2>/dev/null`
      );
      result.fixed.push("removed _placeholder from openclaw.json");
      logger.info("[reconcile] Removed _placeholder key from openclaw.json");
    }
  } else {
    result.alreadyCorrect.push("no _placeholder in openclaw.json");
  }
}

async function stepRenameVideoSkill(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const oldDir = '~/.openclaw/skills/video-production';
  const newDir = '~/.openclaw/skills/motion-graphics';

  // Check if old directory exists
  const check = await ssh.execCommand(
    `test -d ${oldDir} && echo EXISTS || echo GONE`
  );

  if (check.stdout.trim() !== 'EXISTS') {
    result.alreadyCorrect.push('skill rename (video-production already gone)');
    return;
  }

  if (dryRun) {
    result.fixed.push('[dry-run] rename video-production → motion-graphics');
    return;
  }

  // Remove new dir if it exists (stale partial rename), then move
  await ssh.execCommand(`rm -rf ${newDir} && mv ${oldDir} ${newDir}`);
  result.fixed.push('skill rename (video-production → motion-graphics)');
}

async function stepRemotionDeps(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const templateDir = '~/.openclaw/skills/motion-graphics/assets/template-basic';

  // Check if template directory exists
  const dirCheck = await ssh.execCommand(
    `test -f ${templateDir}/package.json && echo EXISTS || echo MISSING`
  );
  if (dirCheck.stdout.trim() !== 'EXISTS') {
    result.alreadyCorrect.push('remotion deps (template not deployed yet)');
    return;
  }

  // Check if node_modules already has remotion installed
  const installed = await ssh.execCommand(
    `test -d ${templateDir}/node_modules/remotion && echo YES || echo NO`
  );
  if (installed.stdout.trim() === 'YES') {
    result.alreadyCorrect.push('remotion deps (already installed)');
    return;
  }

  if (dryRun) {
    result.fixed.push('[dry-run] npm install in motion-graphics template');
    return;
  }

  // Run npm install with NVM
  const nvm = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';
  const install = await ssh.execCommand(
    `${nvm} && cd ${templateDir} && npm install --no-audit --no-fund 2>&1`,
    { execOptions: { timeout: 180000 } }
  );

  // Verify installation
  const verify = await ssh.execCommand(
    `test -d ${templateDir}/node_modules/remotion && echo YES || echo NO`
  );
  if (verify.stdout.trim() !== 'YES') {
    result.errors.push(`remotion deps install failed: ${install.stderr?.slice(0, 200) || install.stdout?.slice(-200)}`);
    return;
  }

  result.fixed.push('remotion deps (npm install in motion-graphics template)');
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

    // Deploy ~/scripts/ executables from each skill's scripts/ directory
    // This auto-heals missing scripts (e.g., polymarket-*.py, solana-*.py, kalshi-*.py)
    // Note: higgsfield-video scripts go to ~/.openclaw/skills/higgsfield-video/scripts/
    // (handled by installHiggsfield()), not ~/scripts/, so we skip it here.
    const SKILLS_WITH_OWN_SCRIPT_DIR = new Set(["higgsfield-video"]);
    let scriptFileCount = 0;
    deployLines.push('mkdir -p "$HOME/scripts"');
    for (const skillName of skillDirs) {
      if (SKILLS_WITH_OWN_SCRIPT_DIR.has(skillName)) continue;

      const scriptsDir = path.join(skillsBaseDir, skillName, "scripts");
      if (!fs.existsSync(scriptsDir)) continue;

      const scriptFiles = fs.readdirSync(scriptsDir).filter(
        f => f.endsWith(".py") || f.endsWith(".sh"),
      );
      for (const scriptFile of scriptFiles) {
        const scriptPath = path.join(scriptsDir, scriptFile);
        const stat = fs.statSync(scriptPath);
        if (!stat.isFile()) continue;

        const content = fs.readFileSync(scriptPath, "utf-8");
        const b64 = Buffer.from(content, "utf-8").toString("base64");
        deployLines.push(`echo '${b64}' | base64 -d > "$HOME/scripts/${scriptFile}"`);
        deployLines.push(`chmod +x "$HOME/scripts/${scriptFile}"`);
        scriptFileCount++;
      }
    }

    if (skillCount === 0) return;

    if (dryRun) {
      result.fixed.push(`[dry-run] skill SKILL.md files (${skillCount} skills, ${scriptFileCount} scripts)`);
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
    result.fixed.push(`skill SKILL.md files (${skillCount} skills, ${scriptFileCount} scripts)`);
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
  // Map env var names to their values from the VM record or manifest defaults
  const vmRegion = (vm as VMRecord & { region?: string }).region;
  const envValues: Record<string, string | undefined> = {
    GATEWAY_TOKEN: vm.gateway_token,
    POLYGON_RPC_URL: manifest.envVarDefaults?.POLYGON_RPC_URL,
    AGENT_REGION: vmRegion ?? undefined,
    // CLOB proxy vars only for US-region VMs
    ...(vmRegion?.startsWith("us-") || vmRegion?.startsWith("nyc")
      ? {
          CLOB_PROXY_URL: manifest.envVarDefaults?.CLOB_PROXY_URL,
          CLOB_PROXY_URL_BACKUP: manifest.envVarDefaults?.CLOB_PROXY_URL_BACKUP,
        }
      : {}),
  };

  // Env vars that are per-VM and should never be overwritten by the manifest
  const perVmEnvVars = new Set(["GATEWAY_TOKEN", "AGENT_REGION"]);

  for (const envName of manifest.requiredEnvVars) {
    const expectedValue = envValues[envName];
    if (!expectedValue) continue; // No value available in DB — skip

    // Read the current value on the VM
    const check = await ssh.execCommand(
      `grep "^${envName}=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2-`
    );
    const currentValue = check.stdout.trim();

    if (!currentValue) {
      // Missing — append
      if (dryRun) {
        result.fixed.push(`[dry-run] env: ${envName} (add)`);
        continue;
      }
      await ssh.execCommand(`echo "${envName}=${expectedValue}" >> "$HOME/.openclaw/.env"`);
      result.fixed.push(`env: ${envName} (added)`);
    } else if (currentValue !== expectedValue && !perVmEnvVars.has(envName)) {
      // Wrong value for platform-controlled var — fix it
      if (dryRun) {
        result.fixed.push(`[dry-run] env: ${envName} (correct: ${currentValue} → ${expectedValue})`);
        continue;
      }
      await ssh.execCommand(
        `sed -i "s|^${envName}=.*|${envName}=${expectedValue}|" "$HOME/.openclaw/.env"`
      );
      result.fixed.push(`env: ${envName} (corrected: ${currentValue} → ${expectedValue})`);
    } else {
      result.alreadyCorrect.push(envName);
    }
  }
}

async function stepClearProviderCooldown(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<boolean> {
  const authFile = '/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json';

  // Check if any provider has disabledUntil set
  const check = await ssh.execCommand(
    `python3 -c "import json; d=json.load(open('${authFile}')); s=d.get('usageStats',{}); print('COOLDOWN' if any(v.get('disabledUntil') for v in s.values() if isinstance(v, dict)) else 'CLEAN')" 2>/dev/null || echo SKIP`
  );

  if (check.stdout.trim() === 'CLEAN' || check.stdout.trim() === 'SKIP') {
    result.alreadyCorrect.push('provider cooldown (none active)');
    return false;
  }

  if (dryRun) {
    result.fixed.push('[dry-run] clear provider cooldown from auth-profiles.json');
    return true;
  }

  await ssh.execCommand(
    `python3 -c "
import json
f = '${authFile}'
d = json.load(open(f))
if 'usageStats' in d:
    d['usageStats'] = {}
json.dump(d, open(f, 'w'), indent=2)
"`
  );

  result.fixed.push('provider cooldown (cleared disabledUntil from auth-profiles.json)');
  return true;
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
  const DBUS_PREFIX = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
  result.gatewayRestarted = true;

  // Fix 1: Record restart timestamp for grace period
  try {
    const supabase = getSupabase();
    await supabase
      .from("instaclaw_vms")
      .update({ last_gateway_restart: new Date().toISOString() })
      .eq("id", vm.id);
  } catch { /* non-fatal */ }

  // Fix 4: Set restart lock file to prevent storms
  await ssh.execCommand('touch /tmp/ic-restart.lock');

  // Restart with DBUS workaround (required for SSH sessions without a login shell)
  const restartResult = await ssh.execCommand(
    `${DBUS_PREFIX} && systemctl --user restart openclaw-gateway`
  );

  // If restart failed, try kill + start as fallback
  if (restartResult.code !== 0) {
    logger.warn("systemctl restart failed, trying kill + start fallback", {
      route: "reconcileVM",
      vmId: vm.id,
      stderr: restartResult.stderr,
    });
    await ssh.execCommand('pkill -9 -f "openclaw-gateway" 2>/dev/null || true');
    await new Promise((r) => setTimeout(r, 2000));
    await ssh.execCommand(`${DBUS_PREFIX} && systemctl --user start openclaw-gateway`);
  }

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
    result.errors.push('gateway restart failed: not healthy after 30s');
  }
}

/**
 * Step 8c: Deploy systemd override.conf drop-in for openclaw-gateway.service.
 *
 * Uses a proper drop-in file (~/.config/systemd/user/openclaw-gateway.service.d/override.conf)
 * instead of sed-patching the main unit file. This is idempotent, reliable, and
 * survives gateway upgrades that rewrite the base unit file.
 *
 * IMPORTANT: This step writes the file and runs daemon-reload BEFORE any gateway
 * restart (step 9). The ordering prevents the vm-057 bug where the gateway was
 * restarted without the override applied.
 */
async function stepSystemdUnit(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const overrides = manifest.systemdOverrides;
  if (!overrides) return;

  const DBUS_PREFIX = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
  const unitPath = "$HOME/.config/systemd/user/openclaw-gateway.service";
  const overrideDir = "$HOME/.config/systemd/user/openclaw-gateway.service.d";
  const overridePath = `${overrideDir}/override.conf`;

  // Check if unit file exists (gateway installed)
  const check = await ssh.execCommand(`[ -f ${unitPath} ] && echo EXISTS || echo MISSING`);
  if (check.stdout.trim() !== "EXISTS") {
    result.alreadyCorrect.push("systemd unit: not installed (skip)");
    return;
  }

  // Build expected override.conf content
  const lines = ["[Service]"];
  for (const [key, value] of Object.entries(overrides)) {
    lines.push(`${key}=${value}`);
  }
  const expectedContent = lines.join("\n") + "\n";

  // Check if override.conf already matches
  const catResult = await ssh.execCommand(`cat ${overridePath} 2>/dev/null`);
  if (catResult.stdout === expectedContent) {
    result.alreadyCorrect.push("systemd override.conf: all settings correct");
    return;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] systemd override.conf: would write ${Object.keys(overrides).length} settings`);
    return;
  }

  // Write override.conf via base64 (avoids shell escaping issues)
  await ssh.execCommand(`mkdir -p ${overrideDir}`);
  const b64 = Buffer.from(expectedContent).toString("base64");
  const writeResult = await ssh.execCommand(`echo '${b64}' | base64 -d > ${overridePath}`);
  if (writeResult.code !== 0) {
    result.errors.push(`systemd override.conf write failed: ${writeResult.stderr}`);
    return;
  }

  // daemon-reload with DBUS workaround (required for SSH sessions)
  const reloadResult = await ssh.execCommand(`${DBUS_PREFIX} && systemctl --user daemon-reload`);
  if (reloadResult.code !== 0) {
    result.errors.push(`systemd daemon-reload failed: ${reloadResult.stderr}`);
    return;
  }

  result.fixed.push(`systemd override.conf (${Object.keys(overrides).length} settings)`);
  result.gatewayRestartNeeded = true;
}

/**
 * Step 8d: Deploy sshd OOM protection drop-in.
 * Sets OOMScoreAdjust=-900 for sshd so the system OOM killer will always
 * prefer the gateway (OOMScoreAdjust=500) over sshd. This is a belt-and-suspenders
 * defense alongside cgroup MemoryMax — even if cgroup limits somehow fail,
 * sshd stays alive.
 */
async function stepSSHDProtection(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const dropInPath = "/etc/systemd/system/ssh.service.d/oom-protect.conf";
  const expectedContent = "[Service]\nOOMScoreAdjust=-900";

  // Check if drop-in already exists with correct content
  const check = await ssh.execCommand(`cat ${dropInPath} 2>/dev/null || echo MISSING`);
  const current = check.stdout.trim();

  if (current === expectedContent) {
    result.alreadyCorrect.push("sshd OOM protection: already set");
    return;
  }

  if (dryRun) {
    result.fixed.push("[dry-run] sshd OOM protection: would deploy drop-in");
    return;
  }

  const cmd = [
    `sudo mkdir -p /etc/systemd/system/ssh.service.d/`,
    `echo -e "[Service]\\nOOMScoreAdjust=-900" | sudo tee ${dropInPath} > /dev/null`,
    `sudo systemctl daemon-reload`,
  ].join(" && ");

  const deployResult = await ssh.execCommand(cmd);
  if (deployResult.code === 0) {
    result.fixed.push("sshd OOM protection: deployed drop-in (OOMScoreAdjust=-900)");
  } else {
    result.errors.push(`sshd OOM protection failed: ${deployResult.stderr}`);
  }
}

async function stepCleanStaleMemory(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Patterns that indicate stale infrastructure complaints agents should forget
  const badPatterns = [
    "proxy.*down",
    "proxy.*unreachable",
    "proxy.*offline",
    "CLOB.*blocked",
    "CLOB.*unreachable",
    "geo.block",
    "geoblock",
    "trading.*restricted",
    "Trading restricted",
    "script.*broken",
    "doesn.t.*work",
    "can.t.*trade",
    "cannot.*trade",
    "wallet.*stuck",
    "wallet.*broken",
    "awaiting.*fix",
    "awaiting.*support",
    "403.*Forbidden",
    "Gamma API.*403",
    "blocked by geo",
    "Execution blocked",
    "insufficient.*balance.*stuck",
  ];

  const checkCmd = badPatterns
    .map((p) => `grep -ci '${p}' "$f" 2>/dev/null`)
    .join(" + ");

  // Count stale lines across all memory files
  const countResult = await ssh.execCommand(
    `TOTAL=0; for f in $HOME/.openclaw/workspace/memory/*.md $HOME/workspace/memory/*.md $HOME/memory/*.md 2>/dev/null; do [ -f "$f" ] && TOTAL=$((TOTAL + $(${checkCmd} || echo 0))); done; echo $TOTAL`,
  );

  const staleCount = parseInt(countResult.stdout.trim(), 10) || 0;

  if (staleCount === 0) {
    result.alreadyCorrect.push("memory: no stale entries");
    return;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] memory: would clean ${staleCount} stale lines`);
    return;
  }

  // Build sed command to delete all bad patterns
  const sedParts = badPatterns.map((p) => `/${p}/Id`).join(";");
  const cleanCmd = `for f in $HOME/.openclaw/workspace/memory/*.md $HOME/workspace/memory/*.md $HOME/memory/*.md 2>/dev/null; do [ -f "$f" ] && sed -i '${sedParts}' "$f"; done`;

  const cleanResult = await ssh.execCommand(cleanCmd);
  if (cleanResult.code === 0) {
    result.fixed.push(`memory: cleaned ${staleCount} stale lines`);
  } else {
    result.errors.push(`memory cleanup failed: ${cleanResult.stderr}`);
  }
}

// ── Step 8f: Caddy UI block — redirect / to instaclaw.io/dashboard ──
// Prevents users from accessing the raw OpenClaw control panel which can
// destroy their openclaw.json config. All other paths (API, health, WS) pass through.

async function stepCaddyUIBlock(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Check if Caddyfile already has the UI block
  const check = await ssh.execCommand(
    "sudo grep -c 'instaclaw.io/dashboard' /etc/caddy/Caddyfile 2>/dev/null || echo 0",
  );
  const count = parseInt(check.stdout.trim(), 10) || 0;

  if (count > 0) {
    result.alreadyCorrect.push("caddy: UI block present");
    return;
  }

  // Read current Caddyfile to extract hostname
  const catResult = await ssh.execCommand("sudo cat /etc/caddy/Caddyfile 2>/dev/null");
  if (catResult.code !== 0 || !catResult.stdout.trim()) {
    result.errors.push("caddy: no Caddyfile found — skipping UI block");
    return;
  }

  // Extract hostname from first line (e.g. "abc123.vm.instaclaw.io {")
  const hostnameMatch = catResult.stdout.match(/^([a-zA-Z0-9][a-zA-Z0-9.\-]+)\s*\{/);
  if (!hostnameMatch) {
    result.errors.push("caddy: could not parse hostname from Caddyfile");
    return;
  }
  const hostname = hostnameMatch[1];

  if (dryRun) {
    result.fixed.push(`[dry-run] caddy: would add UI block redirect for ${hostname}`);
    return;
  }

  // Build the new Caddyfile with the UI block
  const newCaddyfile = [
    `${hostname} {`,
    `  handle /.well-known/* {`,
    `    root * /home/openclaw`,
    `    file_server`,
    `  }`,
    `  handle /tmp-media/* {`,
    `    root * /home/openclaw/workspace`,
    `    file_server`,
    `  }`,
    `  handle /relay/* {`,
    `    uri strip_prefix /relay`,
    `    reverse_proxy localhost:18792`,
    `  }`,
    `  # Block Control UI — redirect to dashboard`,
    `  handle / {`,
    `    header Content-Type "text/html; charset=utf-8"`,
    `    respond "<html><head><meta http-equiv='refresh' content='0;url=https://instaclaw.io/dashboard'><title>InstaClaw</title></head><body style='font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa'><div style='text-align:center'><h2 style='color:#1a1a1a'>Manage your agent at</h2><a href='https://instaclaw.io/dashboard' style='color:#2563eb;font-size:1.25rem'>instaclaw.io/dashboard</a></div></body></html>" 200`,
    `  }`,
    `  reverse_proxy localhost:18789`,
    `}`,
    ``,
  ].join("\n");

  const b64 = Buffer.from(newCaddyfile, "utf-8").toString("base64");
  const writeResult = await ssh.execCommand(
    `echo '${b64}' | base64 -d | sudo tee /etc/caddy/Caddyfile > /dev/null`,
  );
  if (writeResult.code !== 0) {
    result.errors.push(`caddy: failed to write Caddyfile: ${writeResult.stderr}`);
    return;
  }

  // Reload Caddy (zero downtime)
  const reloadResult = await ssh.execCommand("sudo systemctl reload caddy 2>/dev/null");
  if (reloadResult.code !== 0) {
    result.errors.push(`caddy: reload failed: ${reloadResult.stderr}`);
    return;
  }

  result.fixed.push(`caddy: added UI block redirect for ${hostname}`);
}
