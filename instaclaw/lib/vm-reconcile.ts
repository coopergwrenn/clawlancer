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
import { connectSSH, NVM_PREAMBLE, BANKR_CLI_PINNED_VERSION, OPENCLAW_PINNED_VERSION, NODE_PINNED_VERSION, toOpenClawModel, setupXMTP, WORKSPACE_BOOTSTRAP_SHORT, type VMRecord } from "./ssh";
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
  /**
   * Skip the gateway-restart step. Used when reconciling suspended/hibernating
   * VMs: their gateway is intentionally stopped (or not user-facing), and a
   * restart would un-suspend them. Config and file pushes still happen — the
   * gateway will pick up the new config when it's next started (via
   * reactivation flow or admin restart). Default false.
   */
  skipGatewayRestart?: boolean;
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
  const skipGatewayRestart = options?.skipGatewayRestart ?? false;

  // Suspended/hibernating VMs have user-facing services intentionally stopped.
  // Heal steps that ENABLE/CONFIGURE services are still safe (and desirable —
  // we want correct config when the VM unsuspends) but heal steps that
  // START/RESTART services partially un-suspend the VM, sending traffic
  // through bots that the user paid to pause. Track this state and gate
  // every service-start command on it.
  const vmHealthStatus = (vm as { health_status?: string }).health_status;
  const isPausedState = vmHealthStatus === "suspended" || vmHealthStatus === "hibernating";
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

    // ── Step 3b2: Node version pin ──
    // MUST run BEFORE stepNpmPinDrift — OpenClaw 2026.4.26+ has a packaging
    // bug on Node v22.22.0 (snapshot baseline) where dist/ self-references
    // don't match installed chunks. Upgrading Node first to NODE_PINNED_VERSION
    // is a precondition for the openclaw install to land cleanly.
    // See lib/ssh.ts:OPENCLAW_PINNED_VERSION HISTORY note.
    currentStep = "node-pin-drift";
    await stepNodeUpgrade(ssh, result, dryRun);

    // ── Step 3c: Pinned npm globals (@bankr/cli + openclaw) ──
    // Closes the rollout gap: bumping BANKR_CLI_PINNED_VERSION or
    // OPENCLAW_PINNED_VERSION in lib/ssh.ts now propagates fleet-wide via
    // reconcile, not just on first configureOpenClaw().
    currentStep = "npm-pin-drift";
    await stepNpmPinDrift(ssh, result, dryRun);

    // ── Step 3d: Enforce agents.defaults.model.primary ──
    // OpenClaw's built-in default is openai/gpt-5.4. If model.primary is
    // <unset> (which can happen if updateModel() was never called for a VM),
    // every chat completion silently bills OpenAI instead of Anthropic.
    // See incident 2026-04-27: 4 VMs with <unset> model.primary accumulated
    // ~$500 of OpenAI spend in a month. Per-VM target is computed from
    // vm.default_model and mapped via toOpenClawModel().
    currentStep = "model-primary-pin";
    await stepEnforceModelPrimary(ssh, vm, result, dryRun);

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

    // ── Step 8g–8m: Deploy heals ──
    // configureOpenClaw silently dropped these on a non-trivial fraction of
    // the fleet (per the 2026-04-28 audit). The reconciler now verifies each
    // and re-deploys if missing. Failures push to strictErrors so the bump-
    // without-push gate prevents config_version from advancing on a broken VM.
    currentStep = "heal-bootstrap-state";
    await stepBootstrapState(ssh, result, dryRun, strict);

    currentStep = "heal-shm-cleanup";
    await stepShmCleanupCron(ssh, result, dryRun, strict);

    currentStep = "heal-skill-dirs";
    await stepSkillDirectories(ssh, result, dryRun, strict);

    currentStep = "heal-gateway-watchdog";
    await stepGatewayWatchdogTimer(ssh, result, dryRun, strict, isPausedState);

    currentStep = "heal-dispatch-server";
    await stepDispatchServer(ssh, vm, result, dryRun, strict, isPausedState);

    currentStep = "heal-instaclaw-xmtp";
    await stepInstaclawXmtp(ssh, vm, result, dryRun, strict, isPausedState);

    currentStep = "heal-node-exporter";
    await stepNodeExporter(ssh, result, dryRun, strict, isPausedState);

    // ── Step 9: Gateway restart (if auth-profiles changed or cooldown cleared) ──
    // Skipped when caller passes skipGatewayRestart (suspended/hibernating
    // VMs — their gateway is intentionally stopped/not-user-facing, and a
    // restart would un-suspend them. The config + file pushes above still
    // landed; the gateway will pick them up on next start, e.g. via
    // reactivation flow.) result.gatewayRestartNeeded is preserved so the
    // caller can see that a restart WAS deferred.
    if ((authProfileFixed || result.gatewayRestartNeeded) && !dryRun && !skipGatewayRestart) {
      currentStep = "gateway-restart";
      result.gatewayRestartNeeded = true;
      await stepGatewayRestart(ssh, vm, result);
    } else if ((authProfileFixed || result.gatewayRestartNeeded) && !dryRun && skipGatewayRestart) {
      result.gatewayRestartNeeded = true;
      logger.info("reconcileVM: gateway restart deferred (skipGatewayRestart=true)", {
        route: "reconcileVM",
        vmId: vm.id,
        authProfileFixed,
      });
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

/**
 * Step 3c: Detect & fix drift on globally-pinned npm packages — @bankr/cli and
 * openclaw. Both pins live in lib/ssh.ts (BANKR_CLI_PINNED_VERSION,
 * OPENCLAW_PINNED_VERSION) and were previously only enforced inside
 * configureOpenClaw(), which doesn't run on existing assigned VMs. Without this
 * step, bumping a pin requires a manual fleet patch.
 *
 * Two independent inline checks (no generic abstraction):
 *   - bankr: version comparison + reinstall, no service restart needed
 *   - openclaw: same pattern, but ALSO updates ~/.openclaw/.openclaw-pinned-version
 *     before the install (so vm-watchdog doesn't revert the upgrade as
 *     "unauthorized") and marks gatewayRestartNeeded so the new binary loads
 *     into the running gateway via the existing Step 9 restart path.
 *
 * Fail-soft: a transient npm registry hiccup logs to result.errors and lets
 * reconcile continue. Next cycle re-evaluates and retries — idempotent.
 */
async function stepNpmPinDrift(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // ── @bankr/cli pin ──
  const bankrCurr = (await ssh.execCommand(
    `${NVM_PREAMBLE} && bankr --version 2>/dev/null | head -1 | tr -d "[:space:]" || true`,
  )).stdout.trim();

  if (bankrCurr === BANKR_CLI_PINNED_VERSION) {
    result.alreadyCorrect.push(`@bankr/cli (${BANKR_CLI_PINNED_VERSION})`);
  } else if (dryRun) {
    result.fixed.push(`[dry-run] @bankr/cli ${bankrCurr || "missing"} → ${BANKR_CLI_PINNED_VERSION}`);
  } else {
    const install = await ssh.execCommand(
      `${NVM_PREAMBLE} && npm install -g @bankr/cli@${BANKR_CLI_PINNED_VERSION} 2>&1 | tail -5`,
      { execOptions: { timeout: 120_000 } },
    );
    const verify = (await ssh.execCommand(
      `${NVM_PREAMBLE} && bankr --version 2>/dev/null | head -1 | tr -d "[:space:]"`,
    )).stdout.trim();
    if (verify === BANKR_CLI_PINNED_VERSION) {
      result.fixed.push(`@bankr/cli ${bankrCurr || "missing"} → ${BANKR_CLI_PINNED_VERSION}`);
    } else {
      result.errors.push(
        `@bankr/cli install failed: was=${bankrCurr || "missing"} got=${verify || "(empty)"} npm-tail=${(install.stdout + install.stderr).slice(-200)}`,
      );
    }
  }

  // ── openclaw pin ──
  // openclaw --version output: "OpenClaw 2026.4.5 (3e72c03)" — extract semver
  const openclawCurr = (await ssh.execCommand(
    `${NVM_PREAMBLE} && openclaw --version 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" | head -1 || true`,
  )).stdout.trim();

  if (openclawCurr === OPENCLAW_PINNED_VERSION) {
    result.alreadyCorrect.push(`openclaw (${OPENCLAW_PINNED_VERSION})`);
  } else if (dryRun) {
    result.fixed.push(`[dry-run] openclaw ${openclawCurr || "missing"} → ${OPENCLAW_PINNED_VERSION}`);
  } else {
    // Update the pinned-version file FIRST so vm-watchdog cron treats the
    // upcoming install as authorized and doesn't revert it.
    await ssh.execCommand(
      `echo '${OPENCLAW_PINNED_VERSION}' > "$HOME/.openclaw/.openclaw-pinned-version"`,
    );
    // Clean install: STOP gateway → clear npm cache → rm openclaw → install.
    //
    // Bug A (2026-04-28 vm-050): `npm install -g` over an existing tree on a
    // different OpenClaw version left dist/ with stale hashed-chunk files.
    // Fix: `rm -rf $(npm root -g)/openclaw` before install.
    //
    // Bug B (2026-04-29 vm-855 + vm-856): even with Bug A's rm + `npm cache
    // clean --force`, install still ENOENT'd on protobufjs's postinstall
    // (`spawn sh ENOENT` because the cwd it expected just got deleted). Root
    // cause: the gateway is STILL RUNNING during the install with file
    // handles open in the OLD node_modules. npm's mid-install moves/renames
    // race against those open handles. Manual replay on vm-855 with the
    // gateway pre-stopped landed cleanly first try.
    //
    // Fix: stop openclaw-gateway BEFORE the npm install. The existing
    // gateway-restart step at the end of reconcileVM brings it back up with
    // the new node + new openclaw. The `|| true` on stop is intentional —
    // suspended/hibernating VMs already have the gateway stopped, and we
    // don't want that to fail this step.
    await ssh.execCommand(
      `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user stop openclaw-gateway 2>/dev/null || true`,
    );
    // Brief pause so file handles actually close before the rm.
    await new Promise((r) => setTimeout(r, 2000));
    // Force the gateway-restart step to fire later so the freshly-installed
    // openclaw + (potentially) freshly-installed node binary actually load
    // into a running process. Without this, a VM whose only drift was the
    // openclaw pin would skip the restart and remain stopped after install.
    result.gatewayRestartNeeded = true;
    const install = await ssh.execCommand(
      `${NVM_PREAMBLE} && npm cache clean --force >/dev/null 2>&1; rm -rf "$(npm root -g)/openclaw" && npm install -g openclaw@${OPENCLAW_PINNED_VERSION} 2>&1 | tail -5`,
      { execOptions: { timeout: 180_000 } },
    );
    const verify = (await ssh.execCommand(
      `${NVM_PREAMBLE} && openclaw --version 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" | head -1`,
    )).stdout.trim();
    if (verify === OPENCLAW_PINNED_VERSION) {
      result.fixed.push(`openclaw ${openclawCurr || "missing"} → ${OPENCLAW_PINNED_VERSION}`);
      // The running gateway holds the OLD binary in memory; trigger Step 9
      // restart so the new version actually loads.
      result.gatewayRestartNeeded = true;
    } else {
      const msg = `openclaw install failed: was=${openclawCurr || "missing"} got=${verify || "(empty)"} npm-tail=${(install.stdout + install.stderr).slice(-200)}`;
      result.errors.push(msg);
      // ALSO push to strictErrors so the bump-without-push gate fires. Without
      // this the cron would advance config_version on a VM whose openclaw npm
      // pkg never moved to OPENCLAW_PINNED_VERSION (the 4 v64-suspended VMs on
      // 2026-04-28 hit exactly this hole).
      result.strictErrors.push(`openclaw-pin: ${msg}`);
    }
  }
}

/**
 * Step 3b2: Node version drift (NEW 2026-04-28).
 *
 * Reads `nvm current`, compares to NODE_PINNED_VERSION. If mismatched,
 * runs `nvm install <pinned>` + `nvm alias default <pinned>` + patches
 * the openclaw-gateway.service unit to point at the new node binary
 * + triggers daemon-reload + sets gatewayRestartNeeded so Step 9 picks
 * up the new unit on the existing restart path.
 *
 * Why this exists:
 *   OpenClaw 2026.4.26 has a packaging incompatibility with Node v22.22.0
 *   (the v62/v63 snapshot baseline). On 22.22.0 the install leaves dist/
 *   with self-references to internal hashed chunks that don't exist on
 *   disk; gateway crashes with ERR_MODULE_NOT_FOUND on startup. Validated
 *   on a throwaway VM that v22.22.2 + 2026.4.26 = clean install + healthy
 *   gateway. This step is the precondition for the openclaw bump above.
 *
 * Idempotent: if nvm current already matches pinned, this is a no-op.
 *
 * Order matters:
 *   - This step MUST run BEFORE stepNpmPinDrift's openclaw install, so
 *     the rm -rf $(npm root -g)/openclaw + npm install lands on the new
 *     Node's node_modules path, not the old one.
 *
 * Fail-soft: a transient nvm/network hiccup logs to result.errors and
 * lets reconcile continue. Next cycle re-evaluates.
 */
async function stepNodeUpgrade(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // `nvm current` outputs e.g. "v22.22.0". Strip the leading "v" to compare.
  const nvmCurrent = (await ssh.execCommand(
    `${NVM_PREAMBLE} && nvm current 2>/dev/null | sed 's/^v//' | head -1`,
  )).stdout.trim();

  if (nvmCurrent === NODE_PINNED_VERSION) {
    result.alreadyCorrect.push(`node (v${NODE_PINNED_VERSION})`);
    return;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] node v${nvmCurrent || "missing"} → v${NODE_PINNED_VERSION}`);
    return;
  }

  // ── Install pinned Node and set as default ──
  // `nvm install` downloads a tarball (~50MB), takes ~30s on a fresh VM.
  // The 120s timeout gives margin for slow Linode regions.
  const install = await ssh.execCommand(
    `${NVM_PREAMBLE} && nvm install ${NODE_PINNED_VERSION} 2>&1 | tail -5 && nvm alias default ${NODE_PINNED_VERSION} 2>&1 | tail -2`,
    { execOptions: { timeout: 120_000 } },
  );
  // Verify
  const verify = (await ssh.execCommand(
    `${NVM_PREAMBLE} && nvm current 2>/dev/null | sed 's/^v//'`,
  )).stdout.trim();
  if (verify !== NODE_PINNED_VERSION) {
    const msg = `node install failed: was=v${nvmCurrent || "missing"} got=v${verify || "(empty)"} nvm-tail=${(install.stdout + install.stderr).slice(-200)}`;
    result.errors.push(msg);
    // ALSO push to strictErrors so the bump-without-push gate fires. Without
    // this the cron would advance config_version on a VM whose nvm current
    // never moved to NODE_PINNED_VERSION (vm-773 on 2026-04-28 was at v64
    // with node 22.22.0 because this verify-fail only wrote to errors).
    result.strictErrors.push(`node-pin: ${msg}`);
    return;
  }
  result.fixed.push(`node v${nvmCurrent || "missing"} → v${NODE_PINNED_VERSION}`);

  // ── Patch systemd unit + drop-ins to point at new node binary ──
  // Existing units hardcode /home/openclaw/.nvm/versions/node/v22.22.0/...
  // paths from the snapshot bake. After Node upgrade those paths point at
  // the OLD binary's node_modules, where openclaw isn't installed for the
  // new version. Replace any /vXX.YY.ZZ/ inside the systemd unit with the
  // new pinned version. The regex is tight enough to only match nvm path
  // segments — comments and Description= lines that say "v22.22.0" remain
  // untouched (Description gets refreshed by upgradeOpenClaw separately).
  const patchUnit = await ssh.execCommand(
    `set -e; ` +
    `for f in $HOME/.config/systemd/user/openclaw-gateway.service $HOME/.config/systemd/user/openclaw-gateway.service.d/*.conf $HOME/.config/systemd/user/instaclaw-xmtp.service; do ` +
    `  [ -f "$f" ] && sed -i -E 's|/v22\\.[0-9]+\\.[0-9]+/|/v${NODE_PINNED_VERSION}/|g' "$f"; ` +
    `done; ` +
    // grep -hE "^ExecStart=" — anchored on line-start + literal `=` so we don't
    // match ExecStartPre= (chrome-pkill drop-in added by stepSystemdUnit)
    // or ExecStartPost= directives. The first commit of this verification
    // (2026-04-28) used "ExecStart" loosely and false-failed on every fleet
    // VM whose unit had ExecStartPre= sorted before ExecStart= (vm-867
    // canary 2026-04-29).
    `grep -hE "^ExecStart=" $HOME/.config/systemd/user/openclaw-gateway.service | head -1`,
  );
  if (!patchUnit.stdout.includes(`/v${NODE_PINNED_VERSION}/`)) {
    result.errors.push(
      `systemd unit path patch did not stick: '${patchUnit.stdout.trim().slice(0, 200)}'`,
    );
    return;
  }
  result.fixed.push("systemd unit ExecStart paths repointed to new Node");

  // ── daemon-reload so systemd picks up the new ExecStart on next start ──
  const reload = await ssh.execCommand(
    'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user daemon-reload 2>&1',
  );
  if (reload.code !== 0) {
    // Non-fatal: gateway restart will fall back to old unit until DBUS is
    // available again. Loud log so we can spot the pattern in aggregate.
    logger.warn("stepNodeUpgrade: daemon-reload failed (DBUS issue)", {
      route: "reconcileVM",
      stderr: reload.stderr?.slice(0, 200),
    });
  }

  // ── Trigger gateway restart so the running process moves to new node ──
  // The existing Step 9 (stepGatewayRestart) honors gatewayRestartNeeded.
  // For non-healthy VMs (suspended/hibernating) the cron's skipGatewayRestart
  // option overrides this — config lands on disk; gateway picks up new node
  // when the user reactivates.
  result.gatewayRestartNeeded = true;
}

/**
 * Step 3d: Enforce agents.defaults.model.primary on every VM.
 *
 * Without this, OpenClaw falls back to its built-in default (openai/gpt-5.4)
 * for any VM whose model.primary key is missing — silently routing every chat
 * completion to OpenAI instead of Anthropic. See incident 2026-04-27.
 *
 * Per-VM target is computed from vm.default_model (DB) mapped via
 * toOpenClawModel(). If a drift is detected, set the value and trigger a
 * gateway restart (Step 9) so the new model takes effect.
 *
 * Fail-soft: a config-set failure logs to result.errors and lets reconcile
 * continue; next cycle re-evaluates and retries.
 */
async function stepEnforceModelPrimary(
  ssh: SSHConnection,
  vm: VMRecord,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const dbModel = (vm as VMRecord & { default_model?: string | null }).default_model || "claude-sonnet-4-6";
  const targetPrimary = toOpenClawModel(dbModel);

  const cur = (await ssh.execCommand(
    `cat ~/.openclaw/openclaw.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("agents",{}).get("defaults",{}).get("model",{}).get("primary","<unset>"))'`,
  )).stdout.trim();

  if (cur === targetPrimary) {
    result.alreadyCorrect.push(`agents.defaults.model.primary (${targetPrimary})`);
    return;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] agents.defaults.model.primary: ${cur} → ${targetPrimary}`);
    return;
  }

  const r = await ssh.execCommand(
    `${NVM_PREAMBLE} && openclaw config set agents.defaults.model.primary '${targetPrimary}' 2>&1`,
    { execOptions: { timeout: 30_000 } },
  );
  if (r.code !== 0) {
    result.errors.push(`model.primary set failed (cur=${cur} target=${targetPrimary}): ${(r.stdout + r.stderr).slice(-200)}`);
    return;
  }

  // The running gateway has the OLD model loaded; trigger Step 9 restart so
  // the new value takes effect on the next chat completion.
  result.gatewayRestartNeeded = true;
  result.fixed.push(`agents.defaults.model.primary: ${cur} → ${targetPrimary}`);
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

// ─────────────────────────────────────────────────────────────────────────
// Step 8g–8m: Deploy heals
//
// configureOpenClaw was historically responsible for deploying these
// artifacts but did so through silent try/catch blocks. The fleet audit on
// 2026-04-28 found that 30%+ of assigned VMs were missing dispatch-server,
// XMTP service, bankr skill, BOOTSTRAP.md, SHM_CLEANUP cron, gateway
// watchdog timer, or node_exporter.
//
// Each step probes the deploy state, re-deploys if missing, and pushes any
// failure to BOTH result.errors AND (when strict) result.strictErrors so
// the bump-without-push gate prevents config_version from advancing on a
// VM where reconcile didn't actually converge.
// ─────────────────────────────────────────────────────────────────────────

const HEAL_DBUS_PREFIX = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

/**
 * Push a heal failure to result.errors AND (when strict) result.strictErrors.
 * Strict mode is the bump-without-push gate: callers MUST NOT advance
 * config_version when result.strictErrors is non-empty.
 */
function recordHealError(result: ReconcileResult, strict: boolean, msg: string): void {
  result.errors.push(msg);
  if (strict) {
    result.strictErrors.push(msg);
  }
}

/**
 * Step 8g: Bootstrap state.
 *
 * Pairs with stepBootstrapConsumed (Step 2b): that step deletes BOOTSTRAP.md
 * for established VMs and creates `.bootstrap_consumed`. This step covers the
 * inverse — VMs missing BOTH files (broken state). Decides what to write
 * based on whether the agent has session history:
 *
 *   - Has sessions  → write `.bootstrap_consumed` only (established VM, agent
 *     identity is already in SOUL.md; no need to re-run awakening flow).
 *   - No sessions   → write BOTH BOOTSTRAP.md and `.bootstrap_consumed`. The
 *     marker pre-prevents accidental awakening replay; the file matches the
 *     audit invariant the 2026-04-28 fleet backfill established.
 *
 * No-op when at least one of the two files exists (covers both new VMs with
 * BOOTSTRAP.md only and established VMs with the marker only).
 */
async function stepBootstrapState(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  try {
    const ws = "$HOME/.openclaw/workspace";
    const probe = await ssh.execCommand(
      `b=$([ -f ${ws}/BOOTSTRAP.md ] && echo 1 || echo 0); ` +
      `m=$([ -f ${ws}/.bootstrap_consumed ] && echo 1 || echo 0); ` +
      `s=$(ls $HOME/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -1 | grep -q . && echo 1 || echo 0); ` +
      `echo "b=$b m=$m s=$s"`
    );
    const m = probe.stdout.match(/b=(\d) m=(\d) s=(\d)/);
    if (!m) {
      recordHealError(result, strict, `bootstrap-state: probe parse failed: ${probe.stdout.slice(0, 100)}`);
      return;
    }
    const hasBootstrap = m[1] === "1";
    const hasMarker = m[2] === "1";
    const hasSessions = m[3] === "1";

    if (hasBootstrap || hasMarker) {
      result.alreadyCorrect.push(`bootstrap-state: ${hasBootstrap ? "BOOTSTRAP.md" : ".bootstrap_consumed"} present`);
      return;
    }

    // Neither present — heal.
    if (dryRun) {
      result.fixed.push(
        hasSessions
          ? "[dry-run] bootstrap-state: would touch .bootstrap_consumed (established VM)"
          : "[dry-run] bootstrap-state: would write BOOTSTRAP.md + .bootstrap_consumed (new VM)"
      );
      return;
    }

    if (hasSessions) {
      const r = await ssh.execCommand(`mkdir -p ${ws} && touch ${ws}/.bootstrap_consumed && echo OK`);
      if (!r.stdout.includes("OK")) {
        recordHealError(result, strict, `bootstrap-state: touch .bootstrap_consumed failed: ${r.stderr}`);
        return;
      }
      result.fixed.push("bootstrap-state: created .bootstrap_consumed (established VM)");
    } else {
      const b64 = Buffer.from(WORKSPACE_BOOTSTRAP_SHORT, "utf-8").toString("base64");
      const r = await ssh.execCommand(
        `mkdir -p ${ws} && echo '${b64}' | base64 -d > ${ws}/BOOTSTRAP.md && touch ${ws}/.bootstrap_consumed && echo OK`
      );
      if (!r.stdout.includes("OK")) {
        recordHealError(result, strict, `bootstrap-state: write BOOTSTRAP.md failed: ${r.stderr}`);
        return;
      }
      result.fixed.push("bootstrap-state: wrote BOOTSTRAP.md + .bootstrap_consumed (new VM)");
    }
  } catch (err) {
    recordHealError(result, strict, `bootstrap-state: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Step 8h: SHM_CLEANUP cron.
 *
 * Hourly cron that purges orphaned SysV shared-memory segments and restarts
 * x11vnc when Xvfb is up but x11vnc has crashed. Lives in the snapshot's
 * baked-in crontab, NOT in VM_MANIFEST.cronJobs (so stepCronJobs doesn't
 * heal it). Without this, x11vnc dies, the desktop stops streaming, and
 * users see a frozen browser.
 */
async function stepShmCleanupCron(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  try {
    const probe = await ssh.execCommand("crontab -l 2>/dev/null | grep -q SHM_CLEANUP && echo OK || echo MISSING");
    if (probe.stdout.includes("OK")) {
      result.alreadyCorrect.push("cron: SHM_CLEANUP");
      return;
    }
    if (dryRun) {
      result.fixed.push("[dry-run] cron: SHM_CLEANUP");
      return;
    }
    const SHM_LINE = `0 * * * * ipcs -m | awk 'NR>3 && $6==0 {print $2}' | xargs -r ipcrm -m 2>/dev/null; pgrep -x Xvfb >/dev/null && ! pgrep -x x11vnc >/dev/null && x11vnc -display :99 -forever -shared -rfbport 5901 -localhost -noxdamage -nopw -bg 2>/dev/null # SHM_CLEANUP`;
    const b64 = Buffer.from(SHM_LINE, "utf-8").toString("base64");
    // Trailing printf '\n' is critical — `crontab -` rejects files whose last
    // byte isn't a newline, and `crontab -l` output may not end in one.
    const install = await ssh.execCommand(
      `{ crontab -l 2>/dev/null; printf '\\n'; echo '${b64}' | base64 -d; printf '\\n'; } | crontab - 2>&1 && echo OK`
    );
    if (!install.stdout.includes("OK")) {
      recordHealError(result, strict, `cron SHM_CLEANUP: install failed: ${install.stdout || install.stderr}`);
      return;
    }
    result.fixed.push("cron: SHM_CLEANUP");
  } catch (err) {
    recordHealError(result, strict, `cron SHM_CLEANUP: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Step 8i: Skill directories.
 *
 * Verifies `~/.openclaw/skills/{bankr,dgclaw,computer-dispatch}` exist:
 *
 *   - bankr: cloned from https://github.com/BankrBot/skills (NOT in our
 *     local repo — stepSkills doesn't deploy it). Re-cloned here if missing.
 *   - dgclaw: SKILL.md from local repo via stepSkills. If still missing
 *     after stepSkills ran, it's a stepSkills failure → strictError.
 *   - computer-dispatch: SKILL.md from local repo via stepSkills. Same
 *     handling as dgclaw.
 *
 * dispatch-server.js itself is verified by stepDispatchServer (Step 8k);
 * dgclaw scripts at $HOME/dgclaw-skill are out of scope (separate skill
 * that's only installed when the user enables the trading competition).
 */
async function stepSkillDirectories(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  try {
    const probe = await ssh.execCommand(
      `b=$([ -d $HOME/.openclaw/skills/bankr ] && echo 1 || echo 0); ` +
      `d=$([ -d $HOME/.openclaw/skills/dgclaw ] && echo 1 || echo 0); ` +
      `c=$([ -d $HOME/.openclaw/skills/computer-dispatch ] && echo 1 || echo 0); ` +
      `echo "b=$b d=$d c=$c"`
    );
    const m = probe.stdout.match(/b=(\d) d=(\d) c=(\d)/);
    if (!m) {
      recordHealError(result, strict, `skill-dirs: probe parse failed: ${probe.stdout.slice(0, 100)}`);
      return;
    }

    // bankr: clone from external repo if missing
    if (m[1] === "1") {
      result.alreadyCorrect.push("skill-dir: bankr");
    } else if (dryRun) {
      result.fixed.push("[dry-run] skill-dir: would clone bankr");
    } else {
      const clone = await ssh.execCommand(
        `mkdir -p $HOME/.openclaw/skills && git clone --depth 1 https://github.com/BankrBot/skills $HOME/.openclaw/skills/bankr 2>&1 && echo OK || echo FAIL`
      );
      if (clone.stdout.includes("OK")) {
        result.fixed.push("skill-dir: bankr (cloned)");
      } else {
        recordHealError(result, strict, `skill-dir bankr: clone failed: ${clone.stdout.slice(-200)}`);
      }
    }

    // dgclaw + computer-dispatch: should have been deployed by stepSkills.
    // If still missing, surface as a strictError so the bump gate fires —
    // a missing skill SKILL.md indicates stepSkills failed silently.
    for (const [idx, name] of [[2, "dgclaw"], [3, "computer-dispatch"]] as const) {
      if (m[idx] === "1") {
        result.alreadyCorrect.push(`skill-dir: ${name}`);
      } else {
        recordHealError(result, strict, `skill-dir ${name}: missing after stepSkills (stepSkills failed silently)`);
      }
    }
  } catch (err) {
    recordHealError(result, strict, `skill-dirs: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Step 8j: Gateway watchdog timer.
 *
 * Systemd user timer that runs `~/scripts/gateway-watchdog.sh` every 2 minutes
 * to detect frozen gateway processes and force-restart them. Inactive timer =
 * no auto-restart on freeze, which manifests as users hitting unresponsive
 * agents until manual intervention.
 *
 * Heal: if the script is present (deployed by stepSkills as part of
 * computer-dispatch/scripts/), write the unit + timer files and start.
 */
async function stepGatewayWatchdogTimer(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
  isPausedState: boolean,
): Promise<void> {
  try {
    const probe = await ssh.execCommand(
      `${HEAL_DBUS_PREFIX} && ` +
      `script=$([ -x $HOME/scripts/gateway-watchdog.sh ] && echo 1 || echo 0); ` +
      `unit=$([ -f $HOME/.config/systemd/user/gateway-watchdog.timer ] && echo 1 || echo 0); ` +
      `active=$(systemctl --user is-active gateway-watchdog.timer 2>&1 | grep -q "^active$" && echo 1 || echo 0); ` +
      `echo "script=$script unit=$unit active=$active"`
    );
    const m = probe.stdout.match(/script=(\d) unit=(\d) active=(\d)/);
    if (!m) {
      recordHealError(result, strict, `gw-watchdog: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [hasScript, hasUnit, isActive] = [m[1] === "1", m[2] === "1", m[3] === "1"];

    if (isActive) {
      result.alreadyCorrect.push("gw-watchdog: timer active");
      return;
    }

    // On suspended/hibernating, the timer SHOULD be inactive (the gateway it
    // watches is also intentionally stopped). Don't push it as a fix unless
    // the unit file is also missing — that's drift we can correct safely.
    if (isPausedState && hasUnit) {
      result.alreadyCorrect.push("gw-watchdog: timer inactive (VM paused — expected)");
      return;
    }

    if (!hasScript) {
      recordHealError(result, strict, "gw-watchdog: ~/scripts/gateway-watchdog.sh missing (stepSkills should have deployed it)");
      return;
    }

    if (dryRun) {
      const action = isPausedState ? "write unit (skip start — VM paused)" : (hasUnit ? "enable+start timer" : "write unit + start");
      result.fixed.push(`[dry-run] gw-watchdog: would ${action}`);
      return;
    }

    // Always write unit + daemon-reload + enable (config). Skip start when paused.
    const startBlock = isPausedState
      ? "echo SKIP_START_PAUSED"
      : "systemctl --user start gateway-watchdog.timer 2>/dev/null && sleep 1 && systemctl --user is-active gateway-watchdog.timer";

    const setup = await ssh.execCommand(`bash -c '
${HEAL_DBUS_PREFIX}
mkdir -p $HOME/.config/systemd/user
cat > $HOME/.config/systemd/user/gateway-watchdog.service << WDEOF
[Unit]
Description=Gateway Watchdog Check

[Service]
Type=oneshot
ExecStart=/bin/bash /home/openclaw/scripts/gateway-watchdog.sh
Environment=HOME=/home/openclaw
WDEOF
cat > $HOME/.config/systemd/user/gateway-watchdog.timer << WTEOF
[Unit]
Description=Gateway Watchdog Timer

[Timer]
OnBootSec=120
OnUnitActiveSec=120
AccuracySec=30

[Install]
WantedBy=timers.target
WTEOF
systemctl --user daemon-reload
systemctl --user enable gateway-watchdog.timer 2>/dev/null
${startBlock}
'`);
    if (isPausedState) {
      result.fixed.push("gw-watchdog: unit + enable applied (start skipped — VM paused)");
      return;
    }
    if (!setup.stdout.includes("active")) {
      recordHealError(result, strict, `gw-watchdog: timer didn't become active: ${setup.stdout.slice(-150)}`);
      return;
    }
    result.fixed.push("gw-watchdog: timer enabled + started");
  } catch (err) {
    recordHealError(result, strict, `gw-watchdog: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Step 8k: dispatch-server (Dispatch Mode WebSocket relay endpoint).
 *
 * Verifies systemd unit + active service + port 8765 listening. If any
 * check fails, redeploys the entire dispatch-server stack:
 *   - SFTP dispatch-server.js, SKILL.md, and 22 dispatch-*.sh scripts
 *     from skills/computer-dispatch/ in the local repo
 *   - chmod +x, install socat/netcat-openbsd, ufw allow 8765
 *   - npm install ws (uses NVM node, not system /usr/bin/node)
 *   - Write systemd user unit with dynamic node path detection
 *     (avoids the hardcoded v22.22.0 bug we hit on instaclaw-xmtp.service)
 *   - daemon-reload + enable + restart, verify port within 12s
 *
 * Same recipe as the 2026-04-28 fleet patch that resolved the public
 * @ObareJunior_ outage (81 VMs missing dispatch-server fleet-wide).
 */
async function stepDispatchServer(
  ssh: SSHConnection,
  vm: VMRecord,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
  isPausedState: boolean,
): Promise<void> {
  try {
    const probe = await ssh.execCommand(
      `${HEAL_DBUS_PREFIX} && ` +
      `unit=$([ -f $HOME/.config/systemd/user/dispatch-server.service ] && echo 1 || echo 0); ` +
      `active=$(systemctl --user is-active dispatch-server 2>&1 | grep -q "^active$" && echo 1 || echo 0); ` +
      `port=$(ss -tln 2>/dev/null | grep -q ":8765 " && echo 1 || echo 0); ` +
      `echo "unit=$unit active=$active port=$port"`
    );
    const m = probe.stdout.match(/unit=(\d) active=(\d) port=(\d)/);
    if (!m) {
      recordHealError(result, strict, `dispatch-server: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [hasUnit, isActive, isListening] = [m[1] === "1", m[2] === "1", m[3] === "1"];

    if (hasUnit && isActive && isListening) {
      result.alreadyCorrect.push("dispatch-server: unit+active+listening");
      return;
    }

    // On paused VMs, dispatch-server SHOULD be inactive. Only redeploy if the
    // unit file or the binary is missing entirely (config drift). Don't try
    // to start the service — that would partially un-suspend the VM.
    if (isPausedState && hasUnit) {
      result.alreadyCorrect.push("dispatch-server: unit present, inactive (VM paused — expected)");
      return;
    }

    if (dryRun) {
      const action = isPausedState ? "redeploy files + unit (skip restart — VM paused)" : "redeploy";
      result.fixed.push(`[dry-run] dispatch-server: would ${action} (unit=${hasUnit} active=${isActive} port=${isListening})`);
      return;
    }

    // Build deploy script with all files base64'd inline (same shape as stepSkills).
    const dispatchDir = path.resolve(process.cwd(), "skills/computer-dispatch");
    const serverPath = path.join(dispatchDir, "dispatch-server.js");
    const skillPath = path.join(dispatchDir, "SKILL.md");
    const scriptsDir = path.join(dispatchDir, "scripts");
    if (!fs.existsSync(serverPath) || !fs.existsSync(scriptsDir)) {
      recordHealError(result, strict, `dispatch-server: local source missing (${serverPath})`);
      return;
    }

    const lines: string[] = [
      "#!/bin/bash",
      "set +e",
      "mkdir -p $HOME/scripts $HOME/.openclaw/skills/computer-dispatch $HOME/.config/systemd/user",
      `echo '${Buffer.from(fs.readFileSync(serverPath)).toString("base64")}' | base64 -d > $HOME/scripts/dispatch-server.js`,
    ];
    if (fs.existsSync(skillPath)) {
      lines.push(`echo '${Buffer.from(fs.readFileSync(skillPath)).toString("base64")}' | base64 -d > $HOME/.openclaw/skills/computer-dispatch/SKILL.md`);
    }
    for (const f of fs.readdirSync(scriptsDir).filter((n) => n.endsWith(".sh"))) {
      const b64 = Buffer.from(fs.readFileSync(path.join(scriptsDir, f))).toString("base64");
      lines.push(`echo '${b64}' | base64 -d > $HOME/scripts/${f}`);
    }
    lines.push(
      'chmod +x $HOME/scripts/dispatch-*.sh $HOME/scripts/dispatch-server.js 2>/dev/null',
      'sudo apt-get install -y -qq socat netcat-openbsd >/dev/null 2>&1 || true',
      'sudo ufw allow 8765/tcp >/dev/null 2>&1 || true',
      // Dynamic NVM node detection (avoids hardcoded v22.22.0 bug)
      'NPATH=$(ls -d $HOME/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)',
      'NDIR=$(dirname "$NPATH" 2>/dev/null)',
      '[ -z "$NPATH" ] && { echo NO_NODE; exit 1; }',
      'cd $HOME/scripts && [ -f package.json ] || echo "{}" > package.json',
      'PATH="$NDIR:$PATH" npm install ws >/dev/null 2>&1 || true',
      'cat > $HOME/.config/systemd/user/dispatch-server.service << DSEOF',
      '[Unit]',
      'Description=Dispatch WebSocket Server',
      'After=network.target xvfb.service',
      '',
      '[Service]',
      'Type=simple',
      'ExecStartPre=/bin/rm -f /tmp/dispatch.sock',
      'ExecStart=$NPATH /home/openclaw/scripts/dispatch-server.js',
      'Environment=HOME=/home/openclaw',
      'Environment=PATH=$NDIR:/usr/local/bin:/usr/bin:/bin',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      'DSEOF',
      HEAL_DBUS_PREFIX,
      'systemctl --user daemon-reload',
      'systemctl --user enable dispatch-server 2>/dev/null',
    );

    if (isPausedState) {
      // Config pushed; service deliberately not started. The unit will
      // auto-start when the VM is reactivated.
      lines.push('echo SKIP_START_PAUSED');
    } else {
      lines.push(
        'systemctl --user restart dispatch-server',
        // Wait up to 12s for port to come up
        'for i in 1 2 3 4 5 6 7 8; do ss -tln 2>/dev/null | grep -q ":8765 " && { echo PORT_OK; exit 0; }; sleep 1.5; done',
        'echo PORT_FAIL',
      );
    }

    const tmpLocal = `/tmp/ic-dispatch-heal-${vm.id}.sh`;
    fs.writeFileSync(tmpLocal, lines.join("\n"), "utf-8");
    try {
      await ssh.putFile(tmpLocal, "/tmp/ic-dispatch-heal.sh");
    } finally {
      try { fs.unlinkSync(tmpLocal); } catch {}
    }
    const r = await ssh.execCommand("bash /tmp/ic-dispatch-heal.sh; rm -f /tmp/ic-dispatch-heal.sh");
    if (r.stdout.includes("SKIP_START_PAUSED")) {
      result.fixed.push("dispatch-server: files + unit deployed (start skipped — VM paused)");
    } else if (r.stdout.includes("PORT_OK")) {
      result.fixed.push("dispatch-server: redeployed + active + listening on :8765");
    } else if (r.stdout.includes("NO_NODE")) {
      recordHealError(result, strict, "dispatch-server: NVM node binary not found");
    } else {
      recordHealError(result, strict, `dispatch-server: redeploy failed: ${r.stdout.slice(-200)}`);
    }
  } catch (err) {
    recordHealError(result, strict, `dispatch-server: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Step 8l: instaclaw-xmtp (XMTP Agent Kit messaging service).
 *
 * Verifies systemd unit + active service. If broken, picks the right heal:
 *
 *   - .env exists with XMTP_WALLET_KEY and the agent .mjs is present:
 *       Surgical in-place fix — rewrite the unit with dynamic node path
 *       detection, daemon-reload, restart. Preserves the existing wallet
 *       identity (and therefore the user's XMTP address).
 *
 *   - Wallet key or agent .mjs missing:
 *       Full re-provision via setupXMTP(). setupXMTP() short-circuits if
 *       the DB has xmtp_address, so we clear the DB first to force fresh
 *       setup. This generates a new wallet (the previous address was dead
 *       anyway since the service wasn't running).
 *
 * The hardcoded `v22.22.0/bin/node` bug in the original setupXMTP unit
 * generation was fixed in commit 16d8980 — this heal applies the fix to
 * existing VMs that were configured before that commit.
 */
async function stepInstaclawXmtp(
  ssh: SSHConnection,
  vm: VMRecord & { gateway_token?: string; xmtp_address?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
  isPausedState: boolean,
): Promise<void> {
  try {
    const probe = await ssh.execCommand(
      `${HEAL_DBUS_PREFIX} && ` +
      `unit=$([ -f $HOME/.config/systemd/user/instaclaw-xmtp.service ] && echo 1 || echo 0); ` +
      `active=$(systemctl --user is-active instaclaw-xmtp 2>&1 | grep -q "^active$" && echo 1 || echo 0); ` +
      `mjs=$([ -f $HOME/scripts/xmtp-agent.mjs ] && echo 1 || echo 0); ` +
      `key=$(grep -q "^XMTP_WALLET_KEY=" $HOME/.openclaw/xmtp/.env 2>/dev/null && echo 1 || echo 0); ` +
      `echo "unit=$unit active=$active mjs=$mjs key=$key"`
    );
    const m = probe.stdout.match(/unit=(\d) active=(\d) mjs=(\d) key=(\d)/);
    if (!m) {
      recordHealError(result, strict, `instaclaw-xmtp: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [hasUnit, isActive, hasMjs, hasKey] = [m[1] === "1", m[2] === "1", m[3] === "1", m[4] === "1"];

    if (hasUnit && isActive) {
      result.alreadyCorrect.push("instaclaw-xmtp: unit+active");
      return;
    }

    // On paused VMs, instaclaw-xmtp SHOULD be inactive. If unit is present
    // and only the active state is missing, that's the expected paused state
    // — leave alone. We also can't run the full setupXMTP path on paused VMs:
    // setupXMTP unconditionally starts the service AND wipes ~/.openclaw/xmtp,
    // both of which would partially un-suspend the user.
    if (isPausedState && hasUnit) {
      result.alreadyCorrect.push("instaclaw-xmtp: unit present, inactive (VM paused — expected)");
      return;
    }
    if (isPausedState && !hasUnit) {
      // No surgical option exists; full setupXMTP is unsafe while paused.
      // Surface as drift the next reconcile-after-reactivate will heal.
      result.fixed.push("instaclaw-xmtp: skipped (VM paused, no unit file — will heal on reactivate)");
      return;
    }

    if (dryRun) {
      const path = hasKey && hasMjs ? "surgical" : "full setupXMTP";
      result.fixed.push(`[dry-run] instaclaw-xmtp: would ${path} (unit=${hasUnit} active=${isActive} mjs=${hasMjs} key=${hasKey})`);
      return;
    }

    if (hasKey && hasMjs) {
      // Surgical in-place fix — preserves wallet identity.
      const r = await ssh.execCommand(`bash -c '
${HEAL_DBUS_PREFIX}
NPATH=$(ls -d $HOME/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
[ -z "$NPATH" ] && { echo NO_NODE; exit 1; }
mkdir -p $HOME/.config/systemd/user
cat > $HOME/.config/systemd/user/instaclaw-xmtp.service << SVCEOF
[Unit]
Description=InstaClaw XMTP Agent
After=network.target

[Service]
Type=simple
ExecStart=$NPATH /home/openclaw/scripts/xmtp-agent.mjs
WorkingDirectory=/home/openclaw/scripts
EnvironmentFile=/home/openclaw/.openclaw/xmtp/.env
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
SVCEOF
systemctl --user daemon-reload
systemctl --user enable instaclaw-xmtp 2>/dev/null
systemctl --user restart instaclaw-xmtp
sleep 4
systemctl --user is-active instaclaw-xmtp
'`);
      if (r.stdout.includes("active")) {
        result.fixed.push("instaclaw-xmtp: surgical fix (wallet preserved)");
      } else if (r.stdout.includes("NO_NODE")) {
        recordHealError(result, strict, "instaclaw-xmtp: NVM node binary not found");
      } else {
        recordHealError(result, strict, `instaclaw-xmtp: surgical fix failed: ${r.stdout.slice(-200)}`);
      }
      return;
    }

    // Full re-provision path. setupXMTP short-circuits if DB has xmtp_address,
    // so clear it first. Generates a fresh wallet — acceptable because the VM
    // had no working XMTP anyway (key/mjs missing). Requires gateway_token.
    if (!vm.gateway_token) {
      recordHealError(result, strict, "instaclaw-xmtp: full re-provision needed but vm.gateway_token is missing");
      return;
    }
    if (vm.xmtp_address) {
      await getSupabase()
        .from("instaclaw_vms")
        .update({ xmtp_address: null })
        .eq("id", vm.id);
    }
    const setup = await setupXMTP(vm as VMRecord & { gateway_token: string });
    if (setup.success && setup.xmtpAddress) {
      result.fixed.push(`instaclaw-xmtp: full re-provision (new addr=${setup.xmtpAddress.slice(0, 10)}...)`);
    } else {
      recordHealError(result, strict, `instaclaw-xmtp: setupXMTP failed: ${(setup.error || "no error").slice(0, 200)}`);
    }
  } catch (err) {
    recordHealError(result, strict, `instaclaw-xmtp: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Step 8m: node_exporter (Prometheus metrics).
 *
 * Verifies /usr/local/bin/node_exporter exists and port 9100 is listening.
 * Without this, the monitoring VM's Prometheus scrape can't pull host metrics
 * (CPU, RAM, disk, load) for the VM — observability gap that masks slow
 * resource exhaustion before it becomes a user-visible failure.
 *
 * Heal: download the pinned tarball, extract to /usr/local/bin, create a
 * dedicated `node_exporter` system user (non-root for least privilege),
 * write the systemd unit (system-level, not user), enable + restart.
 */
async function stepNodeExporter(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
  isPausedState: boolean,
): Promise<void> {
  const NE_VERSION = "1.8.2";
  try {
    const probe = await ssh.execCommand(
      `bin=$([ -x /usr/local/bin/node_exporter ] && echo 1 || echo 0); ` +
      `port=$(ss -tln 2>/dev/null | grep -q ":9100 " && echo 1 || echo 0); ` +
      `unit=$([ -f /etc/systemd/system/node_exporter.service ] && echo 1 || echo 0); ` +
      `echo "bin=$bin port=$port unit=$unit"`
    );
    const m = probe.stdout.match(/bin=(\d) port=(\d) unit=(\d)/);
    if (!m) {
      recordHealError(result, strict, `node_exporter: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [hasBin, isListening, hasUnit] = [m[1] === "1", m[2] === "1", m[3] === "1"];

    if (hasBin && isListening) {
      result.alreadyCorrect.push("node_exporter: bin+listening");
      return;
    }

    // On paused VMs: if binary + unit are already in place, the inactive
    // state is expected. If binary is missing, we can install it (config push)
    // but skip the systemctl restart so we don't add a new running service
    // to a VM that's intentionally suspended.
    if (isPausedState && hasBin && hasUnit) {
      result.alreadyCorrect.push("node_exporter: bin+unit present, inactive (VM paused — expected)");
      return;
    }

    if (dryRun) {
      const action = isPausedState ? "install + write unit (skip restart — VM paused)" : "install + start";
      result.fixed.push(`[dry-run] node_exporter: would ${action} (bin=${hasBin} port=${isListening} unit=${hasUnit})`);
      return;
    }

    // Probe sudo access — heal requires root. Skip cleanly if unavailable.
    const sudoCheck = await ssh.execCommand("sudo -n true 2>/dev/null && echo SUDO_OK || echo NO_SUDO");
    if (!sudoCheck.stdout.includes("SUDO_OK")) {
      recordHealError(result, strict, "node_exporter: passwordless sudo not available");
      return;
    }

    // Build install script — restart gated on isPausedState. Config push
    // (binary download + unit file write + enable) always runs; the start
    // is skipped when paused so the service auto-starts on next boot via
    // WantedBy=multi-user.target instead of right now.
    const startBlock = isPausedState
      ? "echo SKIP_START_PAUSED"
      : "sudo systemctl restart node_exporter && sleep 2 && (ss -tln 2>/dev/null | grep -q ':9100 ' && echo PORT_OK || echo PORT_FAIL)";

    const install = await ssh.execCommand(`bash -c '
set +e
ARCH=$(dpkg --print-architecture 2>/dev/null)
case "$ARCH" in
  amd64) NE_ARCH=linux-amd64 ;;
  arm64) NE_ARCH=linux-arm64 ;;
  *) echo UNSUPPORTED_ARCH=$ARCH; exit 1 ;;
esac
if [ ! -x /usr/local/bin/node_exporter ]; then
  cd /tmp
  curl -sSL --max-time 60 -o /tmp/ne.tgz "https://github.com/prometheus/node_exporter/releases/download/v${NE_VERSION}/node_exporter-${NE_VERSION}.\$NE_ARCH.tar.gz" || { echo DOWNLOAD_FAIL; exit 1; }
  tar xf /tmp/ne.tgz -C /tmp || { echo EXTRACT_FAIL; exit 1; }
  sudo mv /tmp/node_exporter-${NE_VERSION}.\$NE_ARCH/node_exporter /usr/local/bin/
  sudo chown root:root /usr/local/bin/node_exporter
  sudo chmod +x /usr/local/bin/node_exporter
  rm -rf /tmp/ne.tgz /tmp/node_exporter-${NE_VERSION}.\$NE_ARCH
fi
id node_exporter >/dev/null 2>&1 || sudo useradd --no-create-home --shell /bin/false node_exporter
sudo tee /etc/systemd/system/node_exporter.service >/dev/null << UEOF
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter --collector.systemd
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UEOF
sudo systemctl daemon-reload
sudo systemctl enable node_exporter 2>/dev/null
${startBlock}
'`);
    if (install.stdout.includes("SKIP_START_PAUSED")) {
      result.fixed.push(`node_exporter: installed v${NE_VERSION} (start skipped — VM paused)`);
    } else if (install.stdout.includes("PORT_OK")) {
      result.fixed.push(`node_exporter: installed v${NE_VERSION} + listening on :9100`);
    } else {
      const reason = install.stdout.includes("DOWNLOAD_FAIL") ? "download failed"
        : install.stdout.includes("EXTRACT_FAIL") ? "tar extract failed"
        : install.stdout.includes("UNSUPPORTED_ARCH") ? "unsupported arch"
        : "port did not open";
      recordHealError(result, strict, `node_exporter: ${reason} (${install.stdout.slice(-200)})`);
    }
  } catch (err) {
    recordHealError(result, strict, `node_exporter: ${String(err).slice(0, 200)}`);
  }
}
