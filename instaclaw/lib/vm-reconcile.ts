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
import { connectSSH, NVM_PREAMBLE, BANKR_CLI_PINNED_VERSION, OPENCLAW_PINNED_VERSION, NODE_PINNED_VERSION, PRCTL_SUBREAPER_PINNED_VERSION, toOpenClawModel, setupXMTP, WORKSPACE_BOOTSTRAP_SHORT, type VMRecord } from "./ssh";
import { INSTALL_GBRAIN_SH, VERIFY_GBRAIN_MCP_PY } from "./gbrain-scripts-content";
import {
  DISPATCH_SCRIPTS,
  DISPATCH_SERVER_JS,
  DISPATCH_SKILL_MD,
} from "./dispatch-scripts";
import { getPrivacyBridgeScript } from "./privacy-bridge-script";
import { deployPrivacyBridge } from "./privacy-bridge-deploy";
import {
  SOUL_STUB_EDGE,
  SOUL_STUB_CONSENSUS,
  SOUL_STUB_EDGE_MARKER,
  SOUL_STUB_CONSENSUS_MARKER,
  EDGE_INSTACLAW_OVERLAY_MD,
} from "./partner-content";
import * as crypto from "crypto";
import {
  WORKSPACE_SOUL_MD_V2,
  WORKSPACE_AGENTS_MD_V2,
  WORKSPACE_TOOLS_MD_V2,
  WORKSPACE_IDENTITY_MD_V2,
  SOUL_V2_MARKER,
  AGENTS_V2_MARKER,
  TOOLS_V2_MARKER,
  IDENTITY_V2_MARKER,
} from "./workspace-templates-v2";
import { getSupabase } from "./supabase";
import { logger } from "./logger";
import { TIER_DISPLAY_LIMITS } from "./credit-constants";
import * as fs from "fs";
import * as path from "path";

// ── Config-key hot-reload classification ──
//
// OpenClaw 2026.4.26 hot-reloads SOME config namespaces in place but not others.
// The signal is in the journal — when you `openclaw config set KEY VALUE`:
//
//   [reload] config change detected; evaluating reload (KEY, meta.lastTouchedAt)
//   [reload] config hot reload applied (KEY)              ← only present for hot-reloadable keys
//
// Verified namespaces (from journal evidence + dist source dives, 2026-05-11):
//
//   Hot-reloadable (channel/process gets re-init'd, change takes effect live):
//     - channels.*          (channel-restart hook)
//     - mcp.servers.*       (subprocess respawn)
//
//   Restart-required (closure-captured at process init, in-memory state stale):
//     - messages.*          (closure-captured in bot-msflwCEW.js:5473)
//
// The 2026-05-11 "reactions never fired" forensic confirmed messages.* is NOT
// hot-reloadable: the journal showed `evaluating reload (messages.ackReactionScope)`
// but NO matching `hot reload applied` line. The dist source captures
// cfg.messages?.ackReactionScope into a const at channel init. Setting the key on
// disk has zero runtime effect until the gateway restarts.
//
// This list is intentionally conservative. agents.defaults.*, session.*,
// gateway.*, tools.* probably also need restart but we have not empirically
// confirmed yet — add to RESTART_REQUIRED_CONFIG_PREFIXES once verified to
// avoid false-positive restarts of healthy hot-reloadable changes.
//
// See docs/prd/agent-acknowledgment-ux-2026-05-11-forensic-handoff.md §3
// for the full forensic + the journal signal pattern.

const RESTART_REQUIRED_CONFIG_PREFIXES: string[] = [
  "messages.",
];

function keyRequiresGatewayRestart(key: string): boolean {
  return RESTART_REQUIRED_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ── gbrain (Phase 4c) install pinning ──
//
// gbrain is Garry Tan's per-VM PGLite knowledge graph (stdio MCP server).
// Phase 4c puts the install inside the reconciler — once GBRAIN_INSTALL_ENABLED
// is flipped on in Vercel env, every allowlisted-partner VM that surfaces in
// the reconcile-fleet candidate query gets gbrain installed.
//
// Why an env-var gate (default off) instead of "ship and let it run":
// 1. Defense in depth — code can ship to main and reach production without
//    the install firing on real edge_city VMs until Cooper explicitly
//    enables it (no rollback-via-git needed if smoke catches something).
// 2. Decouples deploy from rollout — Cooper can flip the env var when the
//    GBRAIN_ANTHROPIC_API_KEY has fully propagated via stepEnvVarPush
//    (~3.5h post-deploy, per PRD §6).
// 3. The reconcile-fleet candidate query already includes edge_city VMs at
//    cv<VM_MANIFEST.version. We do NOT bump VM_MANIFEST.version here —
//    edge_city VMs are at cv=92 today (< current manifest), so they'll be
//    naturally re-reconciled. New attendee VMs provision at cv=79 and lift
//    through stepGbrain automatically.
//
// PRD: docs/prd/gbrain-fleet-rollout-2026-05-12.md §7 (stepGbrain design).
const GBRAIN_PARTNER_ALLOWLIST: ReadonlySet<string> = new Set(["edge_city"]);
const GBRAIN_PINNED_COMMIT = "2ea5b71";
const GBRAIN_PINNED_VERSION = "0.28.1";
// 240s leaves ~60s headroom under reconcile-fleet's Vercel maxDuration=300s
// for the rest of reconcileVM. Normal install (bun already present): ~70s.
// Cold install (bun not present): ~165s. Both fit comfortably.
const GBRAIN_INSTALL_TIMEOUT_MS = 240_000;

// ── Secret distribution version ──
//
// Bump SECRET_VERSION whenever a value in SECRET_ENV_VAR_SOURCES is rotated
// in Vercel. The reconcile-fleet cron's candidate query OR-s
// `secret_version.lt.<SECRET_VERSION>` with the existing cv staleness filter,
// so caught-up VMs (cv = MANIFEST.version) re-enter the queue and receive
// the rotated secret via stepEnvVarPush. Without this bump, caught-up VMs
// silently carry the stale value until the next manifest bump.
//
// Background: see migrations/20260514120000_secret_version.sql + the
// 2026-05-14 EDGEOS_BEARER_TOKEN incident. Operator runbook in CLAUDE.md
// "Operational runbook: rotating secrets" inside the Incident Response
// Runbook section.
//
// Bump policy: increment by 1 per rotation. Don't reset. Past values don't
// need to be remembered — only the comparison `vm.secret_version <
// SECRET_VERSION` matters for queue inclusion.
export const SECRET_VERSION = 1;

// ── Result types ──

export interface ReconcileResult {
  fixed: string[];
  alreadyCorrect: string[];
  errors: string[];
  /**
   * Non-critical-step failures that do NOT block cv bump (Rule 39).
   * Reserved for optional monitoring sidecars and gracefully-degradable
   * features (node_exporter, gateway-watchdog, private-repo skill installs).
   * Surfaced separately in logs/dashboards so operators can still see them,
   * but the cron route's pushFailed gate ignores this array.
   */
  warnings: string[];
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
  /**
   * True if stepEnvVarPush completed without pushing any errors for any
   * key it processed (skipped, no-op'd, or fixed cleanly — all OK).
   * Decoupled from overall reconcile success so the cron can bump
   * `instaclaw_vms.secret_version` even when a later (non-env) step fails.
   *
   * Default true (vacuous when stepEnvVarPush is a full no-op). Set to
   * false only by stepEnvVarPush itself, alongside the corresponding
   * `result.errors.push(...)`.
   */
  envPushSucceeded: boolean;
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

/**
 * Rule 47 — Continuous file reconciliation.
 *
 * Runs ONLY `stepFiles` against a VM, regardless of its `config_version`.
 * Used by the `cron/file-drift` route (15-min cadence) to close the
 * architectural gap where reconcile-fleet's `cv < VM_MANIFEST.version`
 * filter excludes caught-up VMs from receiving template-only updates.
 *
 * Does NOT bump config_version. Does NOT touch any other step (no
 * config-set, no service restart, no auth-profiles, no skill installs).
 * Safe to call on any VM in any state — stepFiles is idempotent and
 * cheap when there's no drift.
 *
 * The caller owns:
 *   - Cron lock (kept separate from reconcile-fleet's lock so they
 *     can run concurrently without conflicting).
 *   - SSH connection lifecycle.
 *   - DB writes for last_file_drift_check / metrics.
 */
export async function runFileDriftPass(
  vm: VMRecord & { api_mode?: string },
  ssh: SSHConnection,
  dryRun: boolean = false,
): Promise<{
  fixed: string[];
  alreadyCorrect: string[];
  errors: string[];
  warnings: string[];
}> {
  const result: ReconcileResult = {
    fixed: [],
    alreadyCorrect: [],
    errors: [],
    warnings: [],
    gatewayRestartNeeded: false,
    gatewayRestarted: false,
    gatewayHealthy: true,
    strictErrors: [],
    canaryHealthy: null,
    canarySkippedBudget: false,
    envPushSucceeded: true,
  };
  await stepFiles(ssh, vm, VM_MANIFEST, result, dryRun);
  return {
    fixed: result.fixed,
    alreadyCorrect: result.alreadyCorrect,
    errors: result.errors,
    warnings: result.warnings,
  };
}

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
    warnings: [],
    gatewayRestartNeeded: false,
    gatewayRestarted: false,
    gatewayHealthy: true,
    strictErrors: [],
    canaryHealthy: null,
    canarySkippedBudget: false,
    envPushSucceeded: true,
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
    // ── Step -1: Disk guard (Rule 46) ──
    // Runs first so disk-full VMs can't silently corrupt openclaw.json
    // via the ENOSPC-during-atomic-rename failure mode. Purges stale
    // session-backups + ENOSPC .tmp leftovers when disk is ≥90%; pushes
    // result.errors at ≥95% post-cleanup so cv-bump is held + the
    // existing pushFailed pipeline alerts an operator.
    currentStep = "disk-guard";
    await stepDiskGuard(ssh, vm, result, dryRun);

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

    // ── Step 0d: ExecStart alignment ──
    // Rewrite the systemd unit's ExecStart to point to the current Node
    // version BEFORE any config keys are written. Without this, a stale
    // ExecStart (left over from an earlier reconcile that upgraded Node but
    // didn't update the unit file) causes systemctl restart to load the OLD
    // openclaw binary, which rejects new-schema keys → crash-loop.
    //
    // 2026-05-12 incident: vm-059 (coastalstu) + vm-574 (agent@superpower.io)
    // both broken because their systemd unit pinned to v22.22.0/v22.22.1 while
    // `which openclaw` returned the v22.22.2 binary with the new schema.
    // Each `openclaw config set` succeeded (writes via NEW binary), but
    // stepGatewayRestart loaded the OLD binary which rejected the keys.
    //
    // This step must run BEFORE stepConfigSettings so that any subsequent
    // gateway restart (whether triggered here or by hot-reload) uses the
    // correct binary. Safety invariant: SKIP > break. If anything is
    // uncertain (non-canonical unit, missing target, daemon-reload fails),
    // we SKIP — the VM stays in current state, no worse than before.
    //
    // Known limitation: this catches cross-reconcile drift (ExecStart wasn't
    // updated last time Node was upgraded). It does NOT catch intra-reconcile
    // Node changes — stepNodeUpgrade later in this pass could install a NEW
    // Node version and invalidate this alignment. Long-term fix: stepNodeUpgrade
    // should also rewrite the unit. Tracked in CLAUDE.md follow-ups.
    currentStep = "execstart-alignment";
    await stepExecStartAlignment(ssh, result, dryRun);

    // ── Step 1: Config settings ──
    currentStep = "config-settings";
    await stepConfigSettings(ssh, manifest, result, dryRun, strict);

    // ── Step 1a: Telegram token DB↔disk verify (Rule 34) ──
    // Self-heals the disk↔DB drift produced by the configureOpenClaw
    // gateway-rollback path. Cheap when in sync (one ssh read), idempotent.
    currentStep = "telegram-token-verify";
    await stepTelegramTokenVerify(ssh, vm, result, dryRun);

    // ── Step 1b: Platform-managed env vars (GBRAIN_ANTHROPIC_API_KEY, etc.) ──
    // Distributes secret keys from Vercel env → ~/.openclaw/.env on the VM.
    // Idempotent (no-op when already at desired value), in-place replace on
    // rotation, backup-before-mutate with auto-rollback on verify failure.
    // Required precondition for stepGbrain (Phase 4c) and any future feature
    // that reads its API key from the per-VM .env. See
    // PRD-gbrain-fleet-rollout-2026-05-12.md §1 for design rationale.
    currentStep = "env-var-push";
    await stepEnvVarPush(ssh, vm, result, dryRun);

    // ── Step 1c: gbrain install (partner-gated, env-flag-gated) ──
    // Phase 4c of gbrain fleet rollout. Auto-installs gbrain (PGLite KG +
    // stdio MCP) on allowlisted-partner VMs ONCE the GBRAIN_INSTALL_ENABLED
    // env var is flipped on in Vercel (default off — code can ship without
    // firing). Cheap idempotency check makes the steady state ~2s per
    // already-gbrained VM.
    // PRD: docs/prd/gbrain-fleet-rollout-2026-05-12.md §7.
    currentStep = "gbrain";
    await stepGbrain(ssh, vm, result, dryRun, strict);

    // ── Step 2: Files ──
    currentStep = "files";
    await stepFiles(ssh, vm, manifest, result, dryRun);

    // ── Step 2a: SOUL.md V2 migration (gated by env var, default OFF) ──
    // Reads existing V1 SOUL.md, extracts customized Identity + Preferences,
    // re-injects partner stubs from vm.partner, writes new V2 SOUL/AGENTS/
    // TOOLS/IDENTITY templates. Idempotent on all 4 V2 markers (partial-state
    // recovery on the back end). SHA-verified atomic writes via writeFileAtomic.
    // PRD prd-soul-restructure.md + soul-md-trim-2026-05-11.md.
    // ENABLE: set RECONCILE_SOUL_MIGRATION_ENABLED=true (default false).
    // CANARY scope: set RECONCILE_SOUL_MIGRATION_VM_IDS=<id>,<id> to limit
    // migration to specific VMs (otherwise fleet-wide once ENABLED is true).
    currentStep = "soul-v2-migration";
    await stepMigrateSoulV2(ssh, vm, result, dryRun);

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

    // ── Step 8c2: prctl-subreaper install + systemd drop-in ──
    // Independent of stepSystemdUnit's override.conf — writes its own
    // prctl-subreaper.conf drop-in so rollback is a single-file delete.
    // See docs/prd/v87-prctl-subreaper-integration-plan.md.
    currentStep = "prctl-subreaper";
    await stepPrctlSubreaper(ssh, result, dryRun);

    // ── Step 8d: sshd OOM protection (OOMScoreAdjust=-900 drop-in) ──
    currentStep = "sshd-protection";
    await stepSSHDProtection(ssh, result, dryRun);

    // ── Step 8e: Clean stale memory entries (proxy down, geoblock, etc.) ──
    currentStep = "clean-stale-memory";
    await stepCleanStaleMemory(ssh, result, dryRun);

    // ── Step 8f: Caddy UI block (redirect / to instaclaw.io/dashboard) ──
    currentStep = "caddy-ui-block";
    await stepCaddyUIBlock(ssh, result, dryRun);

    // ── Step 8f2: v67 SOUL.md + CAPABILITIES.md routing table patch ──
    // The v67 template change replaced an existing routing-table row in
    // place — but the reconciler's manifest entries for SOUL.md are all
    // append/insert, none overwrite. Without this step, v67 content can't
    // reach existing VMs through reconcile (only configureOpenClaw at first
    // setup uses overwrite). Surgical str.replace keyed off the exact v66
    // row, idempotent via the v67 marker. Defense-in-depth for new
    // provisions and any VM the fleet patch script missed.
    currentStep = "v67-routing-patch";
    await stepV67RoutingTablePatch(ssh, result, dryRun);

    // ── Step 8f3: InstaClaw platform identity patch (2026-05-06) ──
    // Same shape as stepV67RoutingTablePatch — surgical insert into SOUL.md
    // because all manifest entries for SOUL.md are append/insert and can't
    // replace existing rows. Fixes the user-reported "I'm an OpenClaw agent"
    // gap by injecting a "## Platform" section that names InstaClaw as the
    // hosting platform. Idempotent via INSTACLAW_PLATFORM_V1 marker.
    currentStep = "instaclaw-identity-patch";
    await stepInstaClawIdentityPatch(ssh, result, dryRun);

    // ── Step 8f4: v92 SOUL.md partner-section rewrite (partner VMs only) ──
    // Pre-v92 edge_city VMs had 36,054 chars of SOUL.md vs the 35,000-char
    // BOOTSTRAP_MAX_CHARS ceiling — last 1,054 chars (Edge onboarding tail
    // + entire Consensus section) silently truncated. v92 stubs partner
    // sections to ~220 chars and moves the substantive content to per-skill
    // files. This step rewrites SOUL.md on existing partner VMs (manifest
    // files entries are append/insert and can't replace existing rows).
    // Idempotent via SOUL_STUB_*_MARKER substrings.
    currentStep = "v92-partner-stub-rewrite";
    await stepRewriteSoulPartnerSections(ssh, vm, result, dryRun);

    // ── Step 8f5: Edge skill InstaClaw overlay (edge_city VMs only) ──
    // Writes ~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md with
    // onboarding interview + community norms + proactivity directive.
    // Additive to Tule's upstream SKILL.md which we deliberately don't
    // modify. SHA-verified; idempotent skip on match.
    currentStep = "edge-overlay-deploy";
    await stepDeployEdgeOverlay(ssh, vm, result, dryRun);

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

    // ── Step 8n: Privacy-mode SSH bridge (edge_city VMs only) ──
    // Deploys ~/.openclaw/scripts/privacy-bridge.sh. Does NOT modify
    // ~/.ssh/authorized_keys — that cutover happens via the manual fleet
    // script (instaclaw/scripts/_deploy-privacy-bridge-cutover.ts) once
    // canary-tested. Until cutover, deploying the bridge is a no-op for SSH.
    currentStep = "privacy-bridge-deploy";
    await stepDeployPrivacyBridge(ssh, vm, result, dryRun);

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

/**
 * Step -1: stepDiskGuard.
 *
 * Rule 46 (CLAUDE.md). Runs BEFORE any other write so disk-full VMs can't
 * silently corrupt openclaw.json via the ENOSPC-during-atomic-rename failure
 * mode (the vm-842 0-byte-config-file incident, 2026-05-13). Three thresholds:
 *
 *   <80%  → no-op (alreadyCorrect)
 *   80-89 → result.warnings entry (visible in audit log, doesn't block cv)
 *   ≥90   → purge session-backups >24h, re-probe.
 *   ≥90   after purge → emergency purge: keep only 1000 newest backups.
 *   ≥95   after BOTH purges → result.errors (cv-blocking; admin alert via
 *                              the existing pushFailed pipeline).
 *
 * Also unconditionally cleans `openclaw.json.*.tmp` leftovers older than
 * 60min (Rule 38 territory; defends against the ENOSPC-leftover-tmp-file
 * accumulation that caused the vm-788 inode burn).
 *
 * Persists `instaclaw_vms.last_disk_pct` for SQL-queryable fleet visibility.
 *
 * Idempotent: only purges session-backups older than 24h in the standard
 * path. The emergency 1000-newest path only fires when standard isn't
 * sufficient AND disk is still ≥90%.
 *
 * Safety:
 *   - Never touches workspace/, agents/, sessions/, .env, anything in
 *     ~/.openclaw/ outside session-backups/ and *.tmp.
 *   - Wraps every shell-side delete with `2>/dev/null; true` so a missing
 *     directory or already-purged file never aborts the reconcile.
 *   - Best-effort DB writes (last_disk_pct) — failure doesn't propagate.
 */
async function stepDiskGuard(
  ssh: SSHConnection,
  vm: VMRecord,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  try {
    const probeRes = await ssh.execCommand(`df / | tail -1 | awk '{print $5}' | tr -d '%'`);
    const diskPct = parseInt(probeRes.stdout.trim(), 10);
    if (!Number.isFinite(diskPct)) {
      result.warnings.push(`disk-guard: probe parse failed: ${probeRes.stdout.slice(0, 80)}`);
      return;
    }

    // Persist for SQL-queryable fleet visibility. Fire-and-forget — don't
    // block the reconciler on a DB write hiccup.
    void getSupabase()
      .from("instaclaw_vms")
      .update({ last_disk_pct: diskPct })
      .eq("id", vm.id)
      .then(
        () => undefined,
        () => undefined,
      );

    if (diskPct < 80) {
      result.alreadyCorrect.push(`disk-guard: ${diskPct}%`);
      return;
    }

    if (diskPct < 90) {
      result.warnings.push(
        `disk-guard: elevated disk usage ${diskPct}% (no purge — threshold ≥90%)`,
      );
      return;
    }

    if (dryRun) {
      result.fixed.push(
        `[dry-run] disk-guard: would purge session-backups (disk=${diskPct}%)`,
      );
      return;
    }

    // ≥90% — standard purge: session-backups older than 24h.
    await ssh.execCommand(
      `find ~/.openclaw/session-backups -type f -mmin +1440 -delete 2>/dev/null; true`,
    );
    const reprobe1 = await ssh.execCommand(`df / | tail -1 | awk '{print $5}' | tr -d '%'`);
    let postPct = parseInt(reprobe1.stdout.trim(), 10);
    if (!Number.isFinite(postPct)) postPct = diskPct;

    if (postPct >= 90) {
      // Emergency: keep only the 1000 newest session-backups.
      // Mirrors the REC-2 (2026-05-14) strategy that recovered vm-788 etc.
      await ssh.execCommand(
        `cd ~/.openclaw/session-backups 2>/dev/null && ` +
          `ls -t 2>/dev/null | tail -n +1001 | xargs rm -f 2>/dev/null; true`,
      );
      const reprobe2 = await ssh.execCommand(
        `df / | tail -1 | awk '{print $5}' | tr -d '%'`,
      );
      const v = parseInt(reprobe2.stdout.trim(), 10);
      if (Number.isFinite(v)) postPct = v;
    }

    // Always: clean stale openclaw.json.*.tmp leftovers (Rule 38 territory).
    // 60-min mtime bound avoids racing an in-flight atomic write.
    await ssh.execCommand(
      `find ~/.openclaw/ -maxdepth 1 -name "openclaw.json.*.tmp" -mmin +60 -delete 2>/dev/null; true`,
    );

    // Re-record post-purge value.
    void getSupabase()
      .from("instaclaw_vms")
      .update({ last_disk_pct: postPct })
      .eq("id", vm.id)
      .then(
        () => undefined,
        () => undefined,
      );

    if (postPct >= 95) {
      // Cleanup couldn't free enough space. cv-block — the existing
      // pushFailed pipeline in app/api/cron/reconcile-fleet/route.ts
      // fires a sendReconcileFailureAlert on first occurrence + at the
      // quarantine threshold, giving us deduped admin alerting.
      result.errors.push(
        `disk-guard: critical ${diskPct}%→${postPct}% ` +
          `(purge insufficient; manual SSH cleanup needed)`,
      );
    } else if (postPct >= 90) {
      // Still high but cleanup made progress. Warning only — doesn't
      // block cv (and Rule 47 file-drift cron will keep retrying).
      result.warnings.push(
        `disk-guard: high disk ${diskPct}%→${postPct}% after standard+emergency purge`,
      );
    } else {
      result.fixed.push(`disk-guard: purged ${diskPct}%→${postPct}%`);
    }
  } catch (e) {
    result.warnings.push(`disk-guard: exception ${String(e).slice(0, 150)}`);
  }
}

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

/**
 * stepEnvVarPush — distribute platform-managed secret env vars (Vercel → ~/.openclaw/.env).
 *
 * Entries are declared in SECRET_ENV_VAR_SOURCES below. Each entry can be
 * either universal (every VM) or partner-gated (only VMs whose vm.partner
 * matches `partnerGate`). Initially scoped to GBRAIN_ANTHROPIC_API_KEY
 * (universal) and EDGEOS_BEARER_TOKEN (gated to partner="edge_city").
 * Future Phase 5/6 keys (e.g., third-party-SDK keys per partner) drop in
 * via the SECRET_ENV_VAR_SOURCES array below.
 *
 * Behavior per VM, per reconcile cycle:
 *   1. For each entry in SECRET_ENV_VAR_SOURCES, read the value from
 *      process.env (populated by Vercel).
 *   2. If the value is unset/short → silent skip with INFO log. NOT an error.
 *      We do NOT block config_version on missing Vercel env (gives Cooper
 *      headroom on key rotation; absence is alert-worthy only via the
 *      gbrain-coverage cron, P2 follow-up).
 *   3. SSH-read current value from ~/.openclaw/.env. If identical → no-op
 *      (push to alreadyCorrect).
 *   4. Otherwise: backup → replace-in-place (sed -i atomic) or append →
 *      verify-after-write → on mismatch restore from backup + push to errors.
 *   5. chmod 600 the .env file defensively.
 *
 * Secret-passing pattern (matters because this runs every reconcile cycle for
 * every VM = thousands of times/day):
 *   - NOT via SSH command argv (visible in remote `ps -ef`)
 *   - NOT via SSH env (some PAM configs log env)
 *   - VIA stdin to a single bash subprocess (only secret transit path)
 *
 * The KEY_NAME is passed via argv (not a secret — only the VALUE is secret).
 *
 * Output contract (one line in remote stdout):
 *   STEPENV_OK action=no_op       → already at desired value
 *   STEPENV_OK action=appended    → key was absent, now present
 *   STEPENV_OK action=replaced    → key existed with different value, now updated
 *   STEPENV_FAIL <reason>         → any failure; reconciler pushes to result.errors
 *
 * Empirically verified on vm-050 (2026-05-12): all 4 paths (no-op, append,
 * re-apply, replace) pass via `scripts/_test-stepenvvarpush.ts`.
 */
interface SecretEnvVarSource {
  /** Key name as it appears in process.env AND in ~/.openclaw/.env (same name on both sides). */
  envKey: string;
  /** Human-readable label for logs (e.g., "gbrain Anthropic project key"). */
  label: string;
  /**
   * Optional partner allowlist. When set, the value is only distributed to
   * VMs whose `vm.partner` matches this string. Universal keys (every VM)
   * leave this undefined. Skip is silent (INFO log only), never errors —
   * matches the "missing Vercel env" skip semantics so config_version is not
   * held hostage by a key that intentionally doesn't apply to most of the fleet.
   */
  partnerGate?: string;
}

const SECRET_ENV_VAR_SOURCES: SecretEnvVarSource[] = [
  { envKey: "GBRAIN_ANTHROPIC_API_KEY", label: "gbrain Anthropic project key" },
  // 2026-05-14: the attendee-directory endpoint at
  // api-citizen-portal.simplefi.tech requires a JWT (eyJ...), but Vercel held
  // a 64-char hex string from day one — EDGEOS_API_KEY was duplicated into
  // the BEARER_TOKEN slot 34 days ago. Every edge_city VM has carried the
  // wrong token since its configure ran, because configureOpenClaw at
  // lib/ssh.ts:5286-5308 only writes EDGEOS_BEARER_TOKEN at provision and
  // never on rotation. Enrolling it here so the corrected JWT propagates to
  // existing edge_city VMs on the next reconcile tick (per CLAUDE.md Rule 34
  // — DB/disk/Vercel single source of truth).
  //
  // Canonical payload (base64-decode segment 2 to verify): the production JWT
  // decodes to {"citizen_id":1,"email":"francisco@muvinai.com","iat":<unix>}.
  // If a future rotation produces a different email or citizen_id, that's
  // probably a transcription error at a Telegram line-break boundary — see
  // CLAUDE.md "Lesson: Telegram line breaks in JWT tokens" in the Incident
  // Response Runbook. The 2026-05-14 incident shipped muvionai.com (extra
  // 'o' from a soft-wrap join) before being caught.
  { envKey: "EDGEOS_BEARER_TOKEN", label: "EdgeOS attendee directory JWT", partnerGate: "edge_city" },
];

// Bash payload that does the write. Assembled as a string array so there's no
// TS template-literal interpolation in the bash body (which contains $VAR
// references that must be literal $ on the remote side).
const ENV_VAR_PUSH_BASH: string = [
  'set +e',
  // Read the secret value from stdin. -r preserves backslashes; no IFS games.
  'read -r KEY_VALUE < /dev/stdin',
  '[ -z "$KEY_VALUE" ] && { echo "STEPENV_FAIL no_stdin_value"; exit 1; }',
  '[ ${#KEY_VALUE} -lt 20 ] && { echo "STEPENV_FAIL short_value len=${#KEY_VALUE}"; exit 1; }',
  '',
  // KEY_NAME comes via positional $1 (not a secret — just the env var name).
  'KEY_NAME="$1"',
  '[ -z "$KEY_NAME" ] && { echo "STEPENV_FAIL no_key_name_arg"; exit 1; }',
  '',
  'ENV_FILE="$HOME/.openclaw/.env"',
  'TS=$(date -u +%Y%m%dT%H%M%SZ)',
  '',
  '[ ! -f "$ENV_FILE" ] && { echo "STEPENV_FAIL no_env_file path=$ENV_FILE"; exit 2; }',
  '',
  // Read current value (everything after first =, strip surrounding double quotes)
  'CURRENT=$(grep "^${KEY_NAME}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\')',
  '',
  // No-op path: already matches
  'if [ "$CURRENT" = "$KEY_VALUE" ]; then',
  '  echo "STEPENV_OK action=no_op"',
  '  exit 0',
  'fi',
  '',
  // Backup before any mutation. Recent backups kept for forensics.
  'BACKUP="$ENV_FILE.bak.envpush.$TS"',
  'cp "$ENV_FILE" "$BACKUP" || { echo "STEPENV_FAIL backup_failed"; exit 3; }',
  '',
  // Replace-in-place via sed -i (atomic on Linux), OR append.
  // sed delimiter `#` is safe because sk-ant-api03-... and sk-proj-... keys
  // don't contain `#`. `&` and `#` escaped in the value for sed safety.
  'if [ -n "$CURRENT" ]; then',
  '  ESCAPED=$(printf \'%s\' "$KEY_VALUE" | sed -e \'s/[&#]/\\\\&/g\')',
  '  sed -i "s#^${KEY_NAME}=.*#${KEY_NAME}=\\"$ESCAPED\\"#" "$ENV_FILE"',
  '  ACTION="replaced"',
  'else',
  // Ensure trailing newline first (defensive — append without \n would corrupt)
  '  [ -n "$(tail -c 1 "$ENV_FILE")" ] && echo "" >> "$ENV_FILE"',
  '  printf \'%s="%s"\\n\' "$KEY_NAME" "$KEY_VALUE" >> "$ENV_FILE"',
  '  ACTION="appended"',
  'fi',
  '',
  // Verify-after-write per Rule 10. Restore from backup on mismatch.
  'NEW=$(grep "^${KEY_NAME}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\')',
  'if [ "$NEW" != "$KEY_VALUE" ]; then',
  '  cp "$BACKUP" "$ENV_FILE"',
  '  echo "STEPENV_FAIL verify_after_set expected_len=${#KEY_VALUE} actual_len=${#NEW}"',
  '  exit 4',
  'fi',
  '',
  // Defensive: enforce mode 600. Should already be 600 from provisioning.
  'chmod 600 "$ENV_FILE" 2>/dev/null || true',
  '',
  'echo "STEPENV_OK action=$ACTION"',
  'exit 0',
].join('\n');

async function stepEnvVarPush(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  for (const { envKey, label, partnerGate } of SECRET_ENV_VAR_SOURCES) {
    // Partner-gate check: silent skip when this entry is restricted to a
    // specific partner and the VM doesn't match. Mirrors the stepGbrain
    // gate semantics — never push to result.errors (would hold config_version
    // on a key that isn't supposed to apply here).
    if (partnerGate && vm.partner !== partnerGate) {
      logger.info("stepEnvVarPush: skipping (partner gate mismatch)", {
        envKey,
        label,
        partnerGate,
        vmPartner: vm.partner ?? null,
      });
      continue;
    }

    const value = process.env[envKey];
    if (!value || value.length < 20) {
      // Silent skip — don't block config_version. Logged so dashboards / the
      // future gbrain-coverage cron (P2) can pick up on persistent absences.
      logger.info("stepEnvVarPush: skipping (env var not set in Vercel)", {
        envKey,
        label,
        value_len: value?.length ?? 0,
      });
      continue;
    }

    if (dryRun) {
      result.fixed.push(`[dry-run] env.${envKey}`);
      continue;
    }

    // Execute via `bash -c '<script>' _ '<envKey>'`:
    //   - Script body is inlined as the bash -c argument (no key material —
    //     it's the read/replace/verify logic, safe to expose).
    //   - `_` is positional $0 (customary placeholder).
    //   - envKey is positional $1 (script reads it as KEY_NAME).
    //   - The secret VALUE is the only thing on stdin.
    // Single-quote escaping: every `'` in the bash body becomes `'\''`.
    const escapedScript = ENV_VAR_PUSH_BASH.replace(/'/g, "'\\''");
    const res = await ssh.execCommand(
      `bash -c '${escapedScript}' _ '${envKey}'`,
      { stdin: value + '\n' },
    );

    const stdout = (res.stdout || '').trim();
    const stderr = (res.stderr || '').trim();
    const okMatch = stdout.match(/STEPENV_OK action=(\w+)/);
    const failMatch = stdout.match(/STEPENV_FAIL (.+)/);

    if (okMatch) {
      const action = okMatch[1];
      if (action === 'no_op') {
        result.alreadyCorrect.push(`env.${envKey}`);
      } else {
        result.fixed.push(`env.${envKey} (${action})`);
        logger.info('stepEnvVarPush: distributed', { envKey, action, label });
      }
    } else if (failMatch) {
      result.errors.push(`stepEnvVarPush ${envKey}: ${failMatch[1]}`);
      // Block secret_version bump on any per-key failure — next cron tick
      // retries. Skips (gate mismatch / value unset) and no-ops do NOT
      // clear this flag.
      result.envPushSucceeded = false;
    } else {
      // Unexpected output — push to errors with snippet for forensics
      result.errors.push(
        `stepEnvVarPush ${envKey}: unexpected output exit=${res.code} stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)}`,
      );
      result.envPushSucceeded = false;
    }
  }
}

/**
 * stepExecStartAlignment — keep the systemd unit's ExecStart pinned to the
 * current Node version's openclaw binary path.
 *
 * THE BUG THIS PREVENTS (2026-05-12 incident, 2 paying customers broken):
 *   stepNodeUpgrade installs a new Node version. stepNpmPinDrift installs
 *   the new openclaw at the new path. But the systemd unit's ExecStart still
 *   hardcodes the OLD Node path. Each `openclaw config set` runs the NEW
 *   binary (via `which openclaw` on PATH) — those succeed. Then
 *   stepGatewayRestart triggers `systemctl restart`, which loads ExecStart =
 *   OLD Node binary = OLD openclaw. The OLD binary's Zod schema doesn't
 *   recognize the new keys → "Unrecognized keys: ..." → exit 1 → systemd
 *   crash-loop → "Start request repeated too quickly" → permanent failure.
 *
 *   `openclaw config validate` cannot detect this because it runs the NEW
 *   binary (which accepts the keys). Two validators on the same host with
 *   different schemas. Rule 2 vindicated.
 *
 * THE FIX (this step):
 *   1. Read current Node version from `node --version` (NVM-sourced).
 *   2. Read ExecStart line from the systemd unit file.
 *   3. Compare Node versions embedded in the path.
 *   4. If aligned → push alreadyCorrect, return (99% of ticks, 1 SSH call).
 *   5. If misaligned → verify target Node has installed openclaw → atomic
 *      sed -i.bak rewrite → daemon-reload → verify systemd runtime view.
 *
 * SAFETY INVARIANT: SKIP > break. If anything is uncertain (non-canonical
 *   unit, missing target binary, daemon-reload fails), SKIP. The VM stays
 *   in current state, no worse than before this step existed.
 *
 * FAILURE MODE HANDLING:
 *   - No `node --version` (NVM unsourced) → SKIP no_current_node
 *   - No ExecStart line in unit file → SKIP no_execstart
 *   - Multiple `ExecStart=` lines (systemd reset semantics) → SKIP — refuse
 *     to clever-edit
 *   - Drop-in `.conf` has its own ExecStart → SKIP — rewrite would be
 *     shadowed
 *   - ExecStart doesn't match canonical pattern (manual edit) → SKIP — respect
 *   - Target Node dir missing → SKIP — npm install hasn't completed
 *   - Target dist/index.js missing → SKIP — openclaw not installed at new path
 *   - Target binary returns wrong version → SKIP — corrupt install
 *   - sed verify mismatch → ERROR (block cv bump) — partial file write
 *   - daemon-reload fails → retry once + 2s; if still fails → ERROR
 *   - systemd runtime view doesn't reflect rewrite → ERROR — daemon-reload
 *     silently no-op'd
 *
 * KNOWN LIMITATION: catches cross-reconcile drift only. If stepNodeUpgrade
 *   later in this same reconcile pass installs a NEWER Node version, the
 *   ExecStart will be stale again. Long-term fix: stepNodeUpgrade should
 *   itself rewrite the unit. For now, the next reconcile cycle catches it.
 *
 * PERFORMANCE: 1 SSH call in the 99% steady-state aligned case (combined
 *   check is one bash invocation). 4 SSH calls on the rare rewrite path
 *   (check, verify-target, rewrite, reload+verify).
 *
 * GATEWAY RESTART: when we rewrite, we set result.gatewayRestartNeeded=true
 *   so the orchestrator's terminal stepGatewayRestart fires. That restart
 *   picks up the new ExecStart and loads the NEW openclaw binary, which
 *   accepts the new schema keys that stepConfigSettings will write.
 */
async function stepExecStartAlignment(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // POSIX-clean check script (avoids bashisms like `[[`). One round-trip.
  // Output contract:
  //   RESULT=aligned current=vX.Y.Z          → no action needed
  //   RESULT=skip reason=<r> [details]       → safety skip, proceed without fix
  //   RESULT=needs_fix old=vX.Y.Z current=vX.Y.Z → proceed to verify+rewrite
  const checkScript = [
    'source ~/.nvm/nvm.sh 2>/dev/null',
    'UNIT="$HOME/.config/systemd/user/openclaw-gateway.service"',
    'CUR=$(node --version 2>/dev/null)',
    '[ -z "$CUR" ] && { echo "RESULT=skip reason=no_current_node"; exit 0; }',
    '[ ! -f "$UNIT" ] && { echo "RESULT=skip reason=no_unit_file"; exit 0; }',
    'ES_COUNT=$(grep -cE "^ExecStart=" "$UNIT" 2>/dev/null)',
    '[ "$ES_COUNT" = "0" ] && { echo "RESULT=skip reason=no_execstart"; exit 0; }',
    '[ "$ES_COUNT" != "1" ] && { echo "RESULT=skip reason=multiple_execstart_lines count=$ES_COUNT"; exit 0; }',
    'DROPIN=$(ls "$HOME/.config/systemd/user/openclaw-gateway.service.d"/*.conf 2>/dev/null | xargs -I{} grep -lE "^ExecStart=" {} 2>/dev/null | head -1)',
    '[ -n "$DROPIN" ] && { echo "RESULT=skip reason=dropin_override_present path=$DROPIN"; exit 0; }',
    'ES=$(grep -E "^ExecStart=" "$UNIT" | head -1)',
    'OLD=$(printf %s "$ES" | sed -n "s|.*/node/\\(v[0-9.]*\\)/.*|\\1|p")',
    '[ -z "$OLD" ] && { echo "RESULT=skip reason=cant_extract_old_version"; exit 0; }',
    // Canonical-pattern check: full line must match the expected configureOpenClaw template.
    'EXPECTED="ExecStart=/home/openclaw/.nvm/versions/node/${OLD}/bin/node /home/openclaw/.nvm/versions/node/${OLD}/lib/node_modules/openclaw/dist/index.js gateway --port 18789"',
    '[ "$ES" != "$EXPECTED" ] && { echo "RESULT=skip reason=non_canonical_format"; exit 0; }',
    '[ "$OLD" = "$CUR" ] && { echo "RESULT=aligned current=$CUR"; exit 0; }',
    'echo "RESULT=needs_fix old=$OLD current=$CUR"',
  ].join('\n');

  const escapedCheck = checkScript.replace(/'/g, "'\\''");
  const checkRes = await ssh.execCommand(`bash -c '${escapedCheck}'`);
  const checkOut = (checkRes.stdout || '').trim();

  // Aligned (99% of ticks) — fast path, no log noise
  const alignedMatch = checkOut.match(/^RESULT=aligned current=(v\S+)/m);
  if (alignedMatch) {
    result.alreadyCorrect.push(`execstart-alignment: ${alignedMatch[1]}`);
    return;
  }

  // Skip (safety) — log breadcrumb, push to alreadyCorrect (don't block cv)
  const skipMatch = checkOut.match(/^RESULT=skip reason=(\S+)(.*)$/m);
  if (skipMatch) {
    const reason = skipMatch[1];
    const extra = (skipMatch[2] || '').trim();
    logger.warn('stepExecStartAlignment: skip', { route: 'stepExecStartAlignment', reason, extra });
    result.alreadyCorrect.push(`execstart-alignment: skipped (${reason})`);
    return;
  }

  // Needs fix — extract versions
  const fixMatch = checkOut.match(/^RESULT=needs_fix old=(v\S+) current=(v\S+)/m);
  if (!fixMatch) {
    // Unexpected output — treat as skip for safety
    logger.warn('stepExecStartAlignment: unexpected check output', { route: 'stepExecStartAlignment', stdout: checkOut.slice(0, 300) });
    result.alreadyCorrect.push('execstart-alignment: skipped (unexpected_check_output)');
    return;
  }
  const oldVersion = fixMatch[1];
  const currentVersion = fixMatch[2];

  if (dryRun) {
    result.fixed.push(`[dry-run] execstart-alignment: would rewrite ${oldVersion} → ${currentVersion}`);
    return;
  }

  // ── Verify target ──
  const verifyScript = [
    'source ~/.nvm/nvm.sh 2>/dev/null',
    `CUR="${currentVersion}"`,
    'TARGET_BIN="/home/openclaw/.nvm/versions/node/$CUR/bin/node"',
    'TARGET_DIST="/home/openclaw/.nvm/versions/node/$CUR/lib/node_modules/openclaw/dist/index.js"',
    '[ ! -x "$TARGET_BIN" ] && { echo "VERIFY=fail reason=target_bin_missing path=$TARGET_BIN"; exit 0; }',
    '[ ! -f "$TARGET_DIST" ] && { echo "VERIFY=fail reason=target_dist_missing path=$TARGET_DIST"; exit 0; }',
    'GOT_VERSION=$($TARGET_BIN --version 2>/dev/null)',
    '[ "$GOT_VERSION" != "$CUR" ] && { echo "VERIFY=fail reason=binary_version_mismatch got=$GOT_VERSION expected=$CUR"; exit 0; }',
    'echo "VERIFY=ok"',
  ].join('\n');
  const verifyRes = await ssh.execCommand(`bash -c '${verifyScript.replace(/'/g, "'\\''")}'`);
  const verifyOut = (verifyRes.stdout || '').trim();
  if (!verifyOut.startsWith('VERIFY=ok')) {
    const m = verifyOut.match(/VERIFY=fail reason=(\S+)(.*)$/m);
    const reason = m?.[1] ?? 'unknown';
    logger.warn('stepExecStartAlignment: target verify FAIL — skipping rewrite', {
      route: 'stepExecStartAlignment', reason, detail: (m?.[2] || '').trim(), oldVersion, currentVersion,
    });
    result.alreadyCorrect.push(`execstart-alignment: skipped (target_verify_${reason})`);
    return;
  }

  // ── Atomic rewrite via sed -i.bak ──
  const newLine = `ExecStart=/home/openclaw/.nvm/versions/node/${currentVersion}/bin/node /home/openclaw/.nvm/versions/node/${currentVersion}/lib/node_modules/openclaw/dist/index.js gateway --port 18789`;
  const newLineSedSafe = newLine.replace(/\//g, '\\/');
  const rewriteScript = [
    'set -e',
    'UNIT="$HOME/.config/systemd/user/openclaw-gateway.service"',
    'TS=$(date -u +%Y%m%dT%H%M%SZ)',
    `sed -i.bak.execstart-fix-$TS -E 's|^ExecStart=/home/openclaw/\\.nvm/versions/node/v[0-9]+\\.[0-9]+\\.[0-9]+/bin/node /home/openclaw/\\.nvm/versions/node/v[0-9]+\\.[0-9]+\\.[0-9]+/lib/node_modules/openclaw/dist/index\\.js gateway --port 18789|${newLineSedSafe}|' "$UNIT"`,
    `NEW=$(grep -E "^ExecStart=" "$UNIT" | head -1)`,
    `EXPECTED='${newLine}'`,
    `[ "$NEW" != "$EXPECTED" ] && { echo "REWRITE=fail reason=verify_mismatch got=$NEW"; exit 1; }`,
    'echo "REWRITE=ok"',
  ].join('\n');
  const rewriteRes = await ssh.execCommand(`bash -c '${rewriteScript.replace(/'/g, "'\\''")}'`);
  const rewriteOut = (rewriteRes.stdout || '').trim();
  if (rewriteRes.code !== 0 || !rewriteOut.includes('REWRITE=ok')) {
    const errMsg = `stepExecStartAlignment: rewrite FAILED (exit=${rewriteRes.code}) ${rewriteOut.slice(0, 200)} stderr=${(rewriteRes.stderr || '').slice(0, 200)}`;
    logger.error('stepExecStartAlignment: rewrite failed', {
      route: 'stepExecStartAlignment', exit: rewriteRes.code, stdout: rewriteOut, stderr: rewriteRes.stderr,
    });
    result.errors.push(errMsg);
    return;
  }

  // ── daemon-reload with one retry, then verify systemd runtime view ──
  const reloadScript = [
    'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
    'systemctl --user daemon-reload',
    'RC=$?',
    'if [ "$RC" -ne 0 ]; then sleep 2; systemctl --user daemon-reload; RC=$?; fi',
    '[ "$RC" -ne 0 ] && { echo "RELOAD=fail rc=$RC"; exit 1; }',
    `RUNTIME=$(systemctl --user show openclaw-gateway -p ExecStart --value)`,
    `case "$RUNTIME" in *"/node/${currentVersion}/bin/node"*) echo "RELOAD=ok" ;; *) echo "RELOAD=fail reason=runtime_view_mismatch runtime=$(printf %s "$RUNTIME" | head -c 200)"; exit 1 ;; esac`,
  ].join('\n');
  const reloadRes = await ssh.execCommand(`bash -c '${reloadScript.replace(/'/g, "'\\''")}'`);
  const reloadOut = (reloadRes.stdout || '').trim();
  if (reloadRes.code !== 0 || !reloadOut.includes('RELOAD=ok')) {
    const errMsg = `stepExecStartAlignment: daemon-reload FAILED (exit=${reloadRes.code}) ${reloadOut.slice(0, 200)} stderr=${(reloadRes.stderr || '').slice(0, 200)}`;
    logger.error('stepExecStartAlignment: daemon-reload failed', {
      route: 'stepExecStartAlignment', exit: reloadRes.code, stdout: reloadOut, stderr: reloadRes.stderr,
    });
    result.errors.push(errMsg);
    return;
  }

  // ── Success ──
  // Setting gatewayRestartNeeded ensures the orchestrator's terminal
  // stepGatewayRestart fires. That restart uses the new ExecStart (post-
  // reload), loads the NEW openclaw binary, and accepts the new-schema
  // keys that stepConfigSettings is about to write.
  result.fixed.push(`execstart-alignment: ${oldVersion} → ${currentVersion}`);
  result.gatewayRestartNeeded = true;
  logger.info('stepExecStartAlignment: rewrote', {
    route: 'stepExecStartAlignment', oldVersion, currentVersion,
  });
}

/**
 * stepGbrain — install gbrain (PGLite knowledge graph + stdio MCP server) on
 * partner-allowlisted VMs.
 *
 * Phase 4c of the gbrain fleet rollout. Auto-installs once
 * GBRAIN_INSTALL_ENABLED=true is set in Vercel env. Until then, no-op.
 *
 * Per-VM behavior (when fully enabled):
 *   1. Skip if vm.partner not in GBRAIN_PARTNER_ALLOWLIST (silent no-op).
 *   2. Skip in strict mode (180s deadline can't accommodate ~70-165s install
 *      — non-strict reconcile-fleet cron will pick it up next cycle).
 *   3. Skip if GBRAIN_INSTALL_ENABLED env var is not "true" (silent no-op).
 *   4. Cheap idempotency check via one SSH call: if `gbrain --version` matches
 *      GBRAIN_PINNED_VERSION AND `openclaw mcp show gbrain` shows the binary
 *      registered, push alreadyCorrect and return — no script upload, no
 *      install execution.
 *   5. Otherwise: upload install-gbrain.sh + verify-gbrain-mcp.py via stdin
 *      (no fs.readFileSync — scripts are embedded as base64 in
 *      lib/gbrain-scripts-content.ts to dodge Vercel-nft's silent-drop bug
 *      that bit the matchpool team).
 *   6. Run install-gbrain.sh with GBRAIN_INSTALL_TIMEOUT_MS hard cap.
 *   7. Parse output:
 *      - ALREADY_INSTALLED  → alreadyCorrect (Phase A's deeper idempotency
 *        check caught it even though our cheap check didn't — e.g., bun PATH
 *        not loaded in our SSH session)
 *      - INSTALL_COMPLETE   → fixed (success — gbrain is wired)
 *      - FATAL_<reason>     → errors (cv won't bump; next cycle retries)
 *      - timeout / other    → errors with diagnostic snippet
 *
 * No gateway restart is needed — Phase G's `openclaw mcp set gbrain` registers
 * via the mcp.servers.* namespace which is hot-reloadable (per
 * RESTART_REQUIRED_CONFIG_PREFIXES comment block at the top of this file).
 *
 * Never throws — all paths fall through to result.errors or silent skip.
 *
 * Design doc: docs/prd/gbrain-fleet-rollout-2026-05-12.md §7
 */
async function stepGbrain(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  // ── Gate 1: partner allowlist ──
  if (!vm.partner || !GBRAIN_PARTNER_ALLOWLIST.has(vm.partner)) return;

  // ── Gate 2: strict mode timeout incompatibility ──
  // Strict has a 180s deadline; gbrain install needs ~70-165s. Non-strict
  // reconcile-fleet cron has the full 300s budget and will pick it up.
  if (strict) return;

  // ── Gate 3: feature flag (default off — Cooper enables via Vercel env when ready) ──
  if (process.env.GBRAIN_INSTALL_ENABLED !== "true") return;

  // ── Cheap idempotency check (single SSH call, ~2s) ──
  // If gbrain version pinned AND MCP registered, skip upload+install entirely.
  // This is the steady-state path for already-gbrained edge_city VMs.
  const checkScript = [
    'source ~/.nvm/nvm.sh 2>/dev/null',
    'export PATH="$HOME/.bun/bin:$PATH"',
    'V=$(gbrain --version 2>/dev/null | head -1 | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+" || echo missing)',
    'M=$(openclaw mcp show gbrain 2>/dev/null | grep -c "/home/openclaw/.bun/bin/gbrain" || echo 0)',
    'echo "GBRAIN_CHECK V=$V M=$M"',
  ].join('; ');

  const check = await ssh.execCommand(`bash -c '${checkScript.replace(/'/g, "'\\''")}'`);
  const checkMatch = (check.stdout || '').match(/GBRAIN_CHECK V=(\S+) M=(\d+)/);
  if (checkMatch && checkMatch[1] === GBRAIN_PINNED_VERSION && checkMatch[2] === "1") {
    result.alreadyCorrect.push(`gbrain v${GBRAIN_PINNED_VERSION}`);
    return;
  }

  // ── Dry-run path: report what we WOULD do, take no action ──
  if (dryRun) {
    const observedVersion = checkMatch?.[1] ?? "unknown";
    const observedMcp = checkMatch?.[2] ?? "0";
    result.fixed.push(
      `[dry-run] gbrain install (current: version=${observedVersion} mcp=${observedMcp})`,
    );
    return;
  }

  // ── Upload install scripts via stdin (avoid local fs roundtrip) ──
  try {
    const upInstall = await ssh.execCommand(
      "cat > /tmp/install-gbrain.sh && chmod +x /tmp/install-gbrain.sh",
      { stdin: INSTALL_GBRAIN_SH },
    );
    if (upInstall.code !== 0) {
      result.errors.push(
        `stepGbrain: upload install-gbrain.sh failed (exit=${upInstall.code}) stderr=${(upInstall.stderr || '').slice(0, 200)}`,
      );
      return;
    }

    const upVerify = await ssh.execCommand(
      "cat > /tmp/verify-gbrain-mcp.py && chmod +x /tmp/verify-gbrain-mcp.py",
      { stdin: VERIFY_GBRAIN_MCP_PY },
    );
    if (upVerify.code !== 0) {
      result.errors.push(
        `stepGbrain: upload verify-gbrain-mcp.py failed (exit=${upVerify.code}) stderr=${(upVerify.stderr || '').slice(0, 200)}`,
      );
      return;
    }
  } catch (e: any) {
    result.errors.push(`stepGbrain: upload threw ${String(e?.message ?? e).slice(0, 200)}`);
    return;
  }

  // ── Run installer with hard timeout ──
  // The `timeout` GNU coreutil sends SIGTERM at the limit. We pass it 5s
  // shorter than our local timeout so the local-side execCommand still has
  // time to read the final stdout/stderr before any local timeout fires.
  const installTimeoutSec = Math.floor(GBRAIN_INSTALL_TIMEOUT_MS / 1000) - 5;
  const installCmd =
    `GBRAIN_PINNED_COMMIT=${GBRAIN_PINNED_COMMIT} ` +
    `GBRAIN_PINNED_VERSION=${GBRAIN_PINNED_VERSION} ` +
    `timeout ${installTimeoutSec} bash /tmp/install-gbrain.sh 2>&1`;

  let res: { stdout?: string; stderr?: string; code?: number | null };
  try {
    res = await ssh.execCommand(installCmd, {
      execOptions: { timeout: GBRAIN_INSTALL_TIMEOUT_MS },
    } as any);
  } catch (e: any) {
    result.errors.push(`stepGbrain: install threw ${String(e?.message ?? e).slice(0, 200)}`);
    return;
  }

  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();

  // ── Parse output (last-match wins for FATAL_; first-match for OK/COMPLETE) ──
  const alreadyMatch = stdout.match(/^ALREADY_INSTALLED\s+(.+)$/m);
  const completeMatch = stdout.match(/^INSTALL_COMPLETE/m);
  const fatalMatches = Array.from(stdout.matchAll(/^FATAL_(\S+)(?:\s+(.+))?$/gm));
  const lastFatal = fatalMatches.length > 0 ? fatalMatches[fatalMatches.length - 1] : null;

  if (alreadyMatch) {
    result.alreadyCorrect.push(`gbrain (phase A: ${alreadyMatch[1]})`);
    logger.info('stepGbrain: already installed (Phase A detected)', {
      route: 'stepGbrain',
      vmId: vm.id,
      detail: alreadyMatch[1],
    });
    return;
  }

  if (completeMatch) {
    result.fixed.push(`gbrain v${GBRAIN_PINNED_VERSION} (installed + MCP wired + round-trip verified)`);
    logger.info('stepGbrain: install complete', {
      route: 'stepGbrain',
      vmId: vm.id,
      version: GBRAIN_PINNED_VERSION,
      commit: GBRAIN_PINNED_COMMIT,
    });
    return;
  }

  if (lastFatal) {
    const reason = lastFatal[1];
    const detail = lastFatal[2] ?? '';
    result.errors.push(`stepGbrain: ${reason}${detail ? ' ' + detail : ''}`);
    logger.warn('stepGbrain: install failed', {
      route: 'stepGbrain',
      vmId: vm.id,
      reason,
      detail,
      tail: stdout.slice(-500),
    });
    return;
  }

  result.errors.push(
    `stepGbrain: no terminal output (timeout or unexpected exit). ` +
    `exit=${res.code} stdout_tail=${stdout.slice(-200)} stderr_tail=${stderr.slice(-200)}`,
  );
  logger.warn('stepGbrain: no terminal output', {
    route: 'stepGbrain',
    vmId: vm.id,
    exit: res.code,
    stdoutLength: stdout.length,
    stdoutTail: stdout.slice(-200),
  });
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
    // Default (non-strict) path — verify-after-set hardening (2026-04-30).
    //
    // Previously this was bit-identical to a `|| true`-suppressed batched
    // config-set, with no verification. Empirically this caused 53% of the
    // fleet to silently drift on `channels.telegram.streaming.mode` (v68
    // manifest setting): the config-set transiently failed for ~half the
    // fleet during the v68→v69 reconcile wave, but the reconciler still
    // pushed every key to `result.fixed`, the cron route saw zero errors,
    // and `config_version` bumped to v69. Reconciler then never re-touched
    // the key (lt-config_version filter), permanently locking those VMs at
    // streaming.mode=partial → users seeing tool-call leaks in Telegram.
    //
    // Hardening: after the batched set, RE-READ each key and verify it
    // matches the manifest. Mismatches go to `result.errors` (which the
    // cron route's `pushFailed` gate uses to refuse the config_version
    // bump). Successfully-verified keys go to `result.fixed`. Silent
    // failures are no longer possible.
    //
    // Rule 36 (2026-05-14): wrap each `set` with BEGIN/END markers and
    // redirect stderr→stdout (`2>&1`). When verify-after-set detects a
    // mismatch, we can attribute the actual upstream error (ENOSPC,
    // schema rejection, permission denied) to the specific key that
    // failed — instead of reporting a misleading "silent failure" that
    // forces operators to SSH-probe to find the real cause. Single
    // SSH round-trip preserved.
    const fixCommands = settingsToFix
      .map(
        (key) =>
          `echo "===SET_BEGIN:${key}===" && ` +
          `openclaw config set ${key} '${settings[key]}' 2>&1; ` +
          `echo "===SET_END:${key}==="`,
      )
      .join(" ; ");
    const fixResult = await ssh.execCommand(`${NVM_PREAMBLE} && ${fixCommands}`);

    // Parse per-key upstream output (anything between BEGIN/END markers).
    // Used below as a Rule-36 diagnostic when verify-after-set fails.
    const upstreamPerKey = new Map<string, string>();
    for (const key of settingsToFix) {
      const beginMarker = `===SET_BEGIN:${key}===`;
      const endMarker = `===SET_END:${key}===`;
      const startIdx = fixResult.stdout.indexOf(beginMarker);
      if (startIdx < 0) continue;
      const endIdx = fixResult.stdout.indexOf(endMarker, startIdx);
      if (endIdx <= startIdx) continue;
      const between = fixResult.stdout
        .slice(startIdx + beginMarker.length, endIdx)
        .trim();
      // Only store when non-empty; successful `set` emits nothing.
      if (between) upstreamPerKey.set(key, between);
    }

    // Verify each key landed. Reuse the same get-batch pattern from above
    // for efficiency (one SSH round-trip vs N).
    const verifyCommands = settingsToFix
      .map((key) => `echo "CFG:${key}=$(openclaw config get ${key} 2>/dev/null)"`)
      .join(' && ');
    const verifyResult = await ssh.execCommand(`${NVM_PREAMBLE} && ${verifyCommands}`);
    const actualValues = new Map<string, string>();
    for (const line of verifyResult.stdout.split("\n")) {
      const m = line.match(/^CFG:(.+?)=(.*)$/);
      if (m) actualValues.set(m[1], m[2].trim());
    }

    for (const key of settingsToFix) {
      const expected = settings[key];
      const actual = actualValues.get(key);
      if (actual === expected) {
        result.fixed.push(key);
        // Guardrail 2: if the changed key is in a namespace OpenClaw can't
        // hot-reload (messages.* per 2026-05-11 forensic), flag the
        // gateway-restart-needed bit. The orchestrator's Step 9 picks this up
        // and does a verified restart (Rule 5) before the cycle finishes —
        // without this, the change lives on disk but the running process keeps
        // the closure-captured stale value.
        if (keyRequiresGatewayRestart(key)) {
          result.gatewayRestartNeeded = true;
          logger.info("stepConfigSettings: queued gateway restart for restart-required key", {
            key,
            value: expected,
            namespace: key.split(".")[0],
            reason: "non_hot_reloadable_config_key",
          });
        }
      } else {
        // Push to errors so reconcile-fleet route's `pushFailed` gate
        // refuses to bump config_version. Next cron cycle retries.
        // Rule 36: include the upstream stderr (captured per-key above)
        // so the actual cause — ENOSPC, schema rejection, permission
        // denied, etc. — is in the audit log instead of forcing an
        // operator to SSH-probe to figure out why the set didn't land.
        const upstream = upstreamPerKey.get(key);
        const upstreamHint = upstream
          ? ` upstream=${JSON.stringify(upstream.slice(0, 200))}`
          : "";
        result.errors.push(
          `config-set verify-after-set mismatch: ${key} ` +
            `expected=${JSON.stringify(expected)} ` +
            `actual=${JSON.stringify(actual ?? "(unread)")}${upstreamHint}`,
        );
      }
    }
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
      // Guardrail 2: same restart-required gate as the non-strict path above.
      // Strict mode runs key-by-key and trusts exit codes; the namespace check
      // is independent of which path landed us here.
      if (keyRequiresGatewayRestart(key)) {
        result.gatewayRestartNeeded = true;
        logger.info("stepConfigSettings(strict): queued gateway restart for restart-required key", {
          key,
          value: val,
          namespace: key.split(".")[0],
          reason: "non_hot_reloadable_config_key",
        });
      }
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

/**
 * For a manifest entry's target path, return the V2 marker that, if present on
 * disk, signals "this file is V2-managed — legacy append/insert rules MUST
 * skip." Returns null for files not under V2 management.
 *
 * Covers all 4 V2 workspace files: SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md.
 * Previously only SOUL.md was protected; the manifest's AGENTS.md philosophy
 * append rule (vm-manifest.ts:1328-1333) would otherwise re-append legacy
 * content onto V2 AGENTS.md every reconciler cycle, growing it back over time.
 */
function pickV2MarkerForPath(remotePath: string): string | null {
  if (remotePath.includes("SOUL.md")) return SOUL_V2_MARKER;
  if (remotePath.includes("AGENTS.md")) return AGENTS_V2_MARKER;
  if (remotePath.includes("TOOLS.md")) return TOOLS_V2_MARKER;
  if (remotePath.includes("IDENTITY.md")) return IDENTITY_V2_MARKER;
  return null;
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

  // ── Sentinel guard (CLAUDE.md Rule 23) ────────────────────────────────
  // Refuse to write any entry whose canonical post-fix markers are missing
  // from the resolved in-memory content.  Defends against stale module
  // caches in long-running reconciler processes — the 2026-05-02 incident
  // where mass-reconcile-v79 was started before the strip-thinking
  // trim_failed_turns commit and silently overwrote the hotfix on every VM
  // it processed afterwards.  Push to result.errors so the caller can
  // refuse to bump config_version (analogous to Rule 10's verify-after-set
  // pattern).  Skip the write entirely — keep the on-disk version, which
  // is presumed at-or-newer than this stale in-memory version.
  if (entry.requiredSentinels?.length) {
    const missing = entry.requiredSentinels.filter((s) => !content.includes(s));
    if (missing.length) {
      const tplKey = entry.source === "template"
        ? (entry as { templateKey?: string }).templateKey ?? "(unknown)"
        : "(inline)";
      const msg =
        `[sentinel-guard] refusing to write ${fileName}: in-memory content for "${tplKey}" ` +
        `is missing required sentinel(s) ${missing.map((s) => JSON.stringify(s)).join(", ")}. ` +
        `This process is likely running stale code from before the fix landed; ` +
        `restart the reconciler so it loads the current module state. ` +
        `On-disk version preserved.`;
      console.error(msg);
      result.errors.push(msg);
      return;
    }
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

      // V2-marker skip: SOUL.md/AGENTS.md/TOOLS.md/IDENTITY.md that have been
      // migrated to V2 own their own content via lib/workspace-templates-v2.ts.
      // Legacy append rules (INTELLIGENCE_INTEGRATED, DEGENCLAW_AWARENESS,
      // CONSENSUS_MATCHING_AWARENESS, MEMORY_FILING_SYSTEM, Problem-Solving
      // Philosophy) must NOT re-append on top of V2 files or they'd recreate
      // the bloat / truncation problem the migration exists to fix.
      // PRD prd-soul-restructure.md + soul-md-trim-2026-05-11.md.
      const v2SkipMarker = pickV2MarkerForPath(remotePath);
      if (v2SkipMarker) {
        const v2Check = await ssh.execCommand(
          `grep -qF "${v2SkipMarker}" ${remotePath} 2>/dev/null && echo V2 || echo V1`
        );
        if (v2Check.stdout.trim() === 'V2') {
          result.alreadyCorrect.push(`${fileName}: V2 — skipping legacy append (${marker})`);
          return;
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

      // Check if target file exists first
      const insertFileCheck = await ssh.execCommand(
        `test -f ${remotePath} && echo EXISTS || echo MISSING`
      );
      if (insertFileCheck.stdout.trim() === 'MISSING') {
        result.errors.push(`${fileName}: target file missing, cannot insert before ${marker}`);
        return;
      }

      // V2-marker skip — same rationale as append_if_marker_absent above.
      const v2SkipMarkerInsert = pickV2MarkerForPath(remotePath);
      if (v2SkipMarkerInsert) {
        const v2Check = await ssh.execCommand(
          `grep -qF "${v2SkipMarkerInsert}" ${remotePath} 2>/dev/null && echo V2 || echo V1`
        );
        if (v2Check.stdout.trim() === 'V2') {
          result.alreadyCorrect.push(`${fileName}: V2 — skipping legacy insert (${marker})`);
          return;
        }
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

/**
 * Step 1a: Verify telegram_bot_token in DB matches openclaw.json on disk.
 *
 * Background — Rule 34 (DB has state the disk doesn't):
 * configureOpenClaw's gateway-startup rollback path (lib/ssh.ts:7236-7253)
 * historically restored openclaw.json.last-known-good when the gateway failed
 * to start with new config, while the unconditional DB write that follows still
 * committed the new telegram_bot_token. For fresh VMs, last-known-good is the
 * {"_placeholder":true} blob with NO telegram channel — so the DB ended up
 * claiming a token that the on-disk config didn't have. Eight users hit this
 * shape between 2026-03-14 (rollback landed in commit 287cfed3) and 2026-05-12
 * (this step + the configureOpenClaw rollback-throw fix landed). Symptom: bot
 * silently dead despite agent appearing healthy.
 *
 * Same-PR fix in configureOpenClaw aborts the DB write on rollback so new
 * occurrences shouldn't accrue. This step is the self-healing layer for VMs
 * that drifted before the fix landed AND defense-in-depth against any future
 * path that writes telegram_bot_token to DB without keeping disk in sync.
 *
 * Strategy:
 *   1. If DB has no token, skip (telegram not configured).
 *   2. Read channels.telegram.botToken from openclaw.json.
 *   3. If matches DB value, no-op.
 *   4. If mismatch, write ALL telegram channel fields via `openclaw config set`
 *      — merge, NOT full-file overwrite (Rule 23). Using the same fields
 *      configureOpenClaw writes (botToken, allowFrom, dmPolicy, groupPolicy,
 *      streaming) means a fully-rolled-back-to-placeholder VM gets a complete
 *      channel setup, not a lonely botToken in an otherwise-missing block.
 *   5. Verify-after-set per Rule 10.
 *   6. Flag gateway for restart — channels.* IS hot-reloadable per Rule 32,
 *      but the gateway may already hold a stale Telegram session in memory,
 *      so a restart is the conservative bet.
 *
 * DB is the source of truth (Rule 34). If disk has a token but DB doesn't,
 * we DO NOT auto-clear the disk — that could be a legitimate manual state
 * (admin debug, partner-VM bring-up) and clearing it is irreversible. Log
 * only in that case.
 */
async function stepTelegramTokenVerify(
  ssh: SSHConnection,
  vm: VMRecord & { telegram_bot_token?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // DB has no token → telegram not configured for this VM
  if (!vm.telegram_bot_token) {
    result.alreadyCorrect.push("telegram-token: skipped (DB has no token)");
    return;
  }

  // Defensive shell-arg validation. Telegram tokens are alphanumeric + colon +
  // dash + underscore (per BotFather format e.g. "123456789:ABCdef-ghi_jkl").
  // Reject anything else to prevent shell injection on the `openclaw config set`
  // command below.
  if (!/^[A-Za-z0-9:_-]+$/.test(vm.telegram_bot_token)) {
    result.errors.push("telegram-token: DB value contains unexpected chars; refusing to write");
    logger.error("[reconcile] telegram-token: DB value failed shell-arg validation", {
      vmId: vm.id,
      tokenLength: vm.telegram_bot_token.length,
    });
    return;
  }

  // Read on-disk token from openclaw.json
  const probe = await ssh.execCommand(
    `python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/openclaw.json')); print(d.get('channels',{}).get('telegram',{}).get('botToken',''))" 2>/dev/null || echo ""`
  );
  const diskToken = probe.stdout.trim();

  if (diskToken === vm.telegram_bot_token) {
    result.alreadyCorrect.push("telegram-token: db/disk match");
    return;
  }

  // Mismatch detected. DB wins (Rule 34).
  logger.warn("[reconcile] telegram-token: db/disk mismatch detected", {
    vmId: vm.id,
    dbTokenPrefix: vm.telegram_bot_token.slice(0, 10),
    diskTokenPresent: !!diskToken,
    diskTokenPrefix: diskToken ? diskToken.slice(0, 10) : null,
    dryRun,
  });

  if (dryRun) {
    result.fixed.push("[dry-run] telegram-token: would sync DB→disk");
    return;
  }

  // Set ALL telegram channel fields. For a fully-rolled-back VM whose
  // openclaw.json has no telegram block at all (placeholder shape), setting
  // only botToken would leave the gateway with an incomplete channel that
  // refuses to enable on restart. These values mirror buildOpenClawConfig
  // (lib/ssh.ts:4441-4456) so the post-heal channel block matches what a
  // fresh configureOpenClaw would have produced.
  const cmds: Array<[string, string]> = [
    ["botToken", `'${vm.telegram_bot_token}'`],
    ["allowFrom", `'["*"]'`],
    ["dmPolicy", `'open'`],
    ["groupPolicy", `'open'`],
    ["streaming", `'partial'`],
  ];
  for (const [key, val] of cmds) {
    const cmd = `${NVM_PREAMBLE} && openclaw config set channels.telegram.${key} ${val}`;
    const r = await ssh.execCommand(cmd);
    if (r.code !== 0) {
      const errMsg = (r.stderr || r.stdout || "").slice(0, 200);
      result.errors.push(`telegram-token: openclaw config set ${key} failed (exit ${r.code}): ${errMsg}`);
      logger.error("[reconcile] telegram-token: set failed", {
        vmId: vm.id,
        key,
        exitCode: r.code,
        stderr: errMsg,
      });
      return;
    }
  }

  // Verify-after-set per Rule 10 — read disk back, confirm the token landed.
  const verify = await ssh.execCommand(
    `python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/openclaw.json')); print(d.get('channels',{}).get('telegram',{}).get('botToken',''))"`
  );
  const verifyToken = verify.stdout.trim();
  if (verifyToken !== vm.telegram_bot_token) {
    result.errors.push("telegram-token: verify-after-set failed (disk still mismatched)");
    logger.error("[reconcile] telegram-token: verify-after-set failed", {
      vmId: vm.id,
      expectedPrefix: vm.telegram_bot_token.slice(0, 10),
      actualPrefix: verifyToken ? verifyToken.slice(0, 10) : "(empty)",
    });
    return;
  }

  result.fixed.push("telegram-token: synced db→disk via openclaw config set");
  logger.info("[reconcile] telegram-token: synced DB→disk", {
    vmId: vm.id,
    tokenPrefix: vm.telegram_bot_token.slice(0, 10),
  });

  // Flag for restart. channels.telegram.* is technically hot-reloadable per
  // the Rule 32 verified mapping, but the gateway may be holding a stale
  // Telegram long-poll connection in memory bound to the OLD/empty token,
  // and that connection won't be reaped until the channel manager re-binds.
  // Restart is the conservative bet.
  result.gatewayRestartNeeded = true;
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
    // Bug D: a fixed 2s sleep was not always enough — some VMs left the
    // gateway process resident long enough for the subsequent rm/install to
    // race file handles. Actively wait (up to 15s) for the process to exit
    // before we touch the install dir.
    await ssh.execCommand(
      `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user stop openclaw-gateway 2>/dev/null && timeout 15 bash -c 'while pgrep -f "openclaw.*gateway" >/dev/null 2>&1; do sleep 0.5; done' || true`,
    );
    // Force the gateway-restart step to fire later so the freshly-installed
    // openclaw + (potentially) freshly-installed node binary actually load
    // into a running process. Without this, a VM whose only drift was the
    // openclaw pin would skip the restart and remain stopped after install.
    result.gatewayRestartNeeded = true;
    // Install with one auto-retry on verify failure.
    //
    // Install timeout: 600s. Bumped from 360s after v66→v67 power+pro pass —
    // vm-337 and vm-320 (both v63→v66 deep jumps) hit the 360s wall mid
    // tarball-extract on slow disk/network. 600s gives 14× the 42s baseline
    // observed on healthy VMs.
    //
    // Auto-retry: the v66→v67 starter pass on 2026-04-29 had ~20% of
    // attempts hit a partial-extract failure mode where the install
    // command "completed" but the on-disk verify came up missing
    // dist/index.js — i.e. the npm install on the remote ended without
    // unpacking everything. Manual replay (rm -rf + fresh install) on
    // vm-831 worked first try in 37s. Bake that into the reconciler so
    // a single transient extraction flake doesn't false-fail the whole
    // wave. Same `rm -rf "$(npm root -g)/openclaw"` runs each attempt,
    // so the second attempt starts from a clean slate.
    let install: { code: number; stdout: string; stderr: string } = { code: -1, stdout: "", stderr: "" };
    let verify: { code: number; stdout: string; stderr: string } = { code: -1, stdout: "", stderr: "" };
    for (let attempt = 0; attempt < 2; attempt++) {
      install = await ssh.execCommand(
        `${NVM_PREAMBLE} && npm cache clean --force >/dev/null 2>&1; rm -rf "$(npm root -g)/openclaw" && npm install -g openclaw@${OPENCLAW_PINNED_VERSION} 2>&1 | tail -5`,
        { execOptions: { timeout: 600_000 } },
      );
      // Verify on-disk artifacts: bin symlink + package.json version + the
      // load-bearing dist/index.js (the systemd unit's ExecStart entry
      // point — vm-831 had the symlink but missing dist/, gateway then
      // crash-looped with `Cannot find module .../openclaw/dist/index.js`).
      // 30s poll tolerates a stragglerly install whose final FS ops land
      // just after node-ssh hands control back.
      verify = await ssh.execCommand(
        `${NVM_PREAMBLE} && for i in $(seq 1 30); do ` +
          `test -L "$HOME/.nvm/versions/node/$(node -v)/bin/openclaw" && ` +
          `grep -q '"version": "${OPENCLAW_PINNED_VERSION}"' "$(npm root -g)/openclaw/package.json" && ` +
          `test -f "$(npm root -g)/openclaw/dist/index.js" && ` +
          `echo ok && exit 0; ` +
          `sleep 1; ` +
        `done; exit 1`,
      );
      if (verify.code === 0) break;
      // Brief settle before retry, so any flaky network connection or in-flight
      // FS write has a chance to complete or clear.
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 5_000));
      }
    }
    if (verify.code === 0) {
      result.fixed.push(`openclaw ${openclawCurr || "missing"} → ${OPENCLAW_PINNED_VERSION}`);
      // The running gateway holds the OLD binary in memory; trigger Step 9
      // restart so the new version actually loads.
      result.gatewayRestartNeeded = true;
    } else {
      const msg = `openclaw install failed: was=${openclawCurr || "missing"} bin+version+dist/index.js not on disk after 30s poll, npm-tail=${(install.stdout + install.stderr).slice(-200)}`;
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

/**
 * stepPrctlSubreaper — install prctl-subreaper@PRCTL_SUBREAPER_PINNED_VERSION
 * globally via npm, verify the native addon (.node) compiled, smoke-test
 * `require('prctl-subreaper').stats()` returns {supported:true, running:true},
 * then write a separate systemd drop-in `prctl-subreaper.conf` that injects
 * NODE_PATH + NODE_OPTIONS=--require prctl-subreaper into the
 * openclaw-gateway service environment. Sets gatewayRestartNeeded so the
 * existing Step 9 picks up the new env on the next gateway boot.
 *
 * Failure modes — all safe (gateway keeps running without the addon):
 *   - npm install fails → push to result.errors, drop-in NOT written
 *   - native build missing → push to result.errors, drop-in NOT written
 *     (likely cause: build-essential or python3 absent on the VM)
 *   - smoke test fails → push to result.errors, drop-in NOT written
 *   - drop-in write fails → push to result.errors
 *
 * Idempotent: if the package is at the pinned version AND the drop-in
 * already references the correct npm root + has NODE_OPTIONS set,
 * returns early via `result.alreadyCorrect`.
 *
 * On Node version bump (NODE_PINNED_VERSION change), the npm root path
 * baked into the drop-in goes stale; the next smoke test still passes
 * because the package is reinstalled via stepNpmPinDrift's similar
 * upgrade discipline, but we regenerate the drop-in here on every cycle
 * if the resolved npm root drifts from what's on disk.
 */
async function stepPrctlSubreaper(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // 1. What version is currently installed globally?
  const versionCheck = await ssh.execCommand(
    `${NVM_PREAMBLE} && npm ls -g --depth=0 prctl-subreaper 2>/dev/null | grep -oE 'prctl-subreaper@[0-9]+\\.[0-9]+\\.[0-9]+'`,
  );
  const installed = versionCheck.stdout.trim();
  const target = `prctl-subreaper@${PRCTL_SUBREAPER_PINNED_VERSION}`;

  // 2. Resolve the actual npm global root (per-Node-version under NVM).
  const npmRootResult = await ssh.execCommand(`${NVM_PREAMBLE} && npm root -g`);
  const npmRoot = npmRootResult.stdout.trim();
  if (!npmRoot || !npmRoot.startsWith("/")) {
    result.errors.push(`stepPrctlSubreaper: could not resolve npm root -g (got: ${JSON.stringify(npmRoot.slice(0, 80))})`);
    return;
  }

  // 3. Is the systemd drop-in present and pointing at the current npm root?
  const dropInPath = "$HOME/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf";
  const dropInCheck = await ssh.execCommand(
    `if test -f ${dropInPath} && grep -qF 'NODE_PATH=${npmRoot}' ${dropInPath} && grep -qF 'NODE_OPTIONS=--require prctl-subreaper' ${dropInPath}; then echo OK; else echo MISSING; fi`,
  );
  const dropInOk = dropInCheck.stdout.trim() === "OK";

  if (installed === target && dropInOk) {
    result.alreadyCorrect.push(`prctl-subreaper@${PRCTL_SUBREAPER_PINNED_VERSION}`);
    return;
  }

  if (dryRun) {
    result.fixed.push(`[dry-run] prctl-subreaper installed=${installed || "<unset>"} target=${target} dropIn=${dropInOk ? "present" : "missing"}`);
    return;
  }

  // 4. Install or upgrade if needed.
  //
  // 2026-05-11 P1-1 fix: gate-coupling. The pre-fix version had a silent
  // failure mode the 2026-05-11 census labeled PARTIAL_LIE_DROPIN: drop-in
  // present, npm package missing. Root cause: stepNodeUpgrade (called
  // BEFORE this step at line 217) can switch the active node version.
  // Global packages installed on the OLD node version are not visible to
  // the NEW one. So `installed` comes back empty here even though a prior
  // run wrote the drop-in. If THIS run's `npm install -g` then fails for
  // any reason, we used to error out and return — leaving the drop-in in
  // place pointing at a NODE_PATH where the package is missing. Next
  // gateway start tries `--require prctl-subreaper`, MODULE_NOT_FOUND,
  // crash-loop.
  //
  // Fix: if install fails AND a drop-in is present (so we'd be leaving
  // the system in a broken state), atomically roll back by removing the
  // drop-in. The next reconcile cycle re-attempts both. The gateway
  // continues running without prctl-subreaper protection in the meantime
  // — which is the SAFE state (worse than having it; better than
  // crash-looping with a broken --require).
  async function rollbackDropInIfPresent(reason: string): Promise<void> {
    if (!dropInOk) return; // nothing to roll back
    await ssh.execCommand(`rm -f ${dropInPath}`).catch(() => { /* best-effort */ });
    await ssh.execCommand(
      `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user daemon-reload 2>&1 || true`,
    ).catch(() => { /* best-effort */ });
    result.errors.push(
      `stepPrctlSubreaper: rolled back orphaned drop-in (was pointing at NODE_PATH=${npmRoot} but package install failed: ${reason})`,
    );
  }

  if (installed !== target) {
    const install = await ssh.execCommand(
      `${NVM_PREAMBLE} && npm install -g prctl-subreaper@${PRCTL_SUBREAPER_PINNED_VERSION} 2>&1`,
      { execOptions: { timeout: 180_000 } },
    );
    if (install.code !== 0) {
      const reason = `npm install -g failed (exit=${install.code}): ${(install.stdout + install.stderr).slice(-400)}`;
      await rollbackDropInIfPresent(reason);
      result.errors.push(`stepPrctlSubreaper: ${reason}`);
      return;
    }

    // Verify the native addon binary exists.
    const verify = await ssh.execCommand(
      `${NVM_PREAMBLE} && find ${npmRoot}/prctl-subreaper/build/Release -name '*.node' -type f 2>/dev/null | head -1`,
    );
    if (!verify.stdout.trim()) {
      const reason = `prctl_subreaper.node not found after install (build-essential or python3 missing? install output: ${(install.stdout || "").slice(-200)})`;
      await rollbackDropInIfPresent(reason);
      result.errors.push(`stepPrctlSubreaper: ${reason}`);
      return;
    }

    // Smoke test — load the module via the same NODE_PATH we'll inject into systemd.
    const smoke = await ssh.execCommand(
      `${NVM_PREAMBLE} && NODE_PATH='${npmRoot}' PRCTL_SUBREAPER_SILENT=1 node -e 'const s=require("prctl-subreaper"); const st=s.stats(); console.log(JSON.stringify({sup:s.isSupported(),running:st.running,pid:st.pid,interval:st.intervalMs,minAge:st.minAgeMs}))' 2>&1`,
      { execOptions: { timeout: 15_000 } },
    );
    const smokeOut = smoke.stdout.trim();
    if (!smokeOut.includes('"sup":true') || !smokeOut.includes('"running":true')) {
      const reason = `smoke test failed: ${smokeOut.slice(-300)}`;
      await rollbackDropInIfPresent(reason);
      result.errors.push(`stepPrctlSubreaper: ${reason}`);
      return;
    }

    result.fixed.push(`prctl-subreaper: ${installed || "<unset>"} → ${target}`);
  }

  // 5. Write the drop-in (separate file from override.conf for clean rollback).
  const dropInBody =
    `[Service]\n` +
    `Environment="NODE_PATH=${npmRoot}"\n` +
    `Environment="NODE_OPTIONS=--require prctl-subreaper"\n` +
    `Environment="PRCTL_SUBREAPER_INTERVAL_MS=1000"\n` +
    `Environment="PRCTL_SUBREAPER_MIN_AGE_MS=5000"\n`;

  const writeResult = await ssh.execCommand(
    `mkdir -p $HOME/.config/systemd/user/openclaw-gateway.service.d && cat > ${dropInPath} <<'PRCTL_DROPIN_EOF'\n${dropInBody}PRCTL_DROPIN_EOF\nchmod 644 ${dropInPath}`,
  );
  if (writeResult.code !== 0) {
    result.errors.push(`stepPrctlSubreaper: drop-in write failed (exit=${writeResult.code}): ${writeResult.stderr.slice(-200)}`);
    return;
  }

  // Verify-after-write per Rule 10.
  const reCheck = await ssh.execCommand(
    `if test -f ${dropInPath} && grep -qF 'NODE_PATH=${npmRoot}' ${dropInPath} && grep -qF 'NODE_OPTIONS=--require prctl-subreaper' ${dropInPath}; then echo OK; else echo MISSING; fi`,
  );
  if (reCheck.stdout.trim() !== "OK") {
    result.errors.push(`stepPrctlSubreaper: drop-in verify-after-write FAILED — re-check returned ${JSON.stringify(reCheck.stdout)}`);
    return;
  }

  // daemon-reload so the next gateway start picks up the env. Don't restart
  // here — Step 9 (stepGatewayRestart) handles that with health checks.
  await ssh.execCommand(
    `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user daemon-reload 2>&1 || true`,
  );

  result.fixed.push(`prctl-subreaper drop-in written (NODE_PATH=${npmRoot})`);
  result.gatewayRestartNeeded = true;
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

    // Rule 24 #1 + Rule 23: verify-after-write.  Without this gate, a silent
    // SCP/base64 failure leaves a SKILL.md missing while marking the deploy
    // "successful," then config_version bumps and the VM is excluded from
    // future reconciles forever.  This is the vm-893/895/896 lying-DB pattern.
    // Build expected-paths list from the same skillDirs we just deployed.
    const expectedPaths = skillDirs
      .filter(s => fs.existsSync(path.join(skillsBaseDir, s, "SKILL.md")))
      .map(s => `$HOME/.openclaw/skills/${s}/SKILL.md`);
    if (expectedPaths.length > 0) {
      // Build a single composite test — count how many expected files exist
      const verifyCmd = `bash -c 'cnt=0; missing=""; for f in ${expectedPaths.map(p => `"${p}"`).join(" ")}; do if [ -f "$f" ] && [ -s "$f" ]; then cnt=$((cnt+1)); else missing="$missing $f"; fi; done; echo "VERIFY_PRESENT:$cnt EXPECTED:${expectedPaths.length} MISSING:$missing"'`;
      const verifyResult = await ssh.execCommand(verifyCmd);
      const presentMatch = verifyResult.stdout.match(/VERIFY_PRESENT:(\d+)/);
      const present = presentMatch ? Number(presentMatch[1]) : 0;
      if (present !== expectedPaths.length) {
        const missingMatch = verifyResult.stdout.match(/MISSING:(.*)/);
        const missing = (missingMatch?.[1] ?? "").trim();
        const errMsg = `stepSkills verify-after-write FAILED: deployed=${expectedPaths.length} on-disk=${present} missing=${missing}`;
        result.errors.push(errMsg);
        logger.error("SKILL_INSTALL_VERIFY_FAILED", {
          step: "stepSkills",
          vmId: vm.id,
          expected: expectedPaths.length,
          present,
          missing,
          route: "lib/vm-reconcile.stepSkills",
        });
        return;
      }
    }
    result.fixed.push(`skill SKILL.md files (${skillCount} skills, ${scriptFileCount} scripts) [verified ${expectedPaths.length}/${expectedPaths.length}]`);
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

  // ── Pre-restart config validate (Rule 5 + 2026-05-12 vm-059 incident) ──
  //
  // Before triggering systemctl restart, run `openclaw config validate` to
  // catch schema rejections proactively. If validation fails with
  // "Unrecognized keys" errors (Zod strict() reject), we surgically unset
  // those keys via `openclaw config unset` and re-validate. Only then do we
  // proceed with the restart.
  //
  // Why this exists:
  //   2026-05-12 vm-059 (paying customer coastalstu@gmail.com): catch-up
  //   applied the v95 manifest's `agents.defaults.compaction.*` keys via
  //   stepConfigSettings. Each `openclaw config set` returned exit 0 and the
  //   keys landed on disk. But when stepGatewayRestart triggered the actual
  //   restart, OpenClaw's startup-time Zod schema validator rejected the
  //   keys ("Unrecognized keys: maxActiveTranscriptBytes, truncateAfterCompaction").
  //   systemd retried 10× → "Start request repeated too quickly" → permanent
  //   gateway failure. Customer's agent was down for ~17 min until manual
  //   recovery.
  //
  //   Other 85 VMs that processed the same keys at the same manifest
  //   succeeded — likely a transient mid-restart binary/dist race during
  //   npm-pin-drift. vm-059 happened to be parsed by the older binary at
  //   exactly the wrong moment.
  //
  // What this catches: ANY schema-rejection class — not just compaction
  // keys — that would otherwise cause a gateway crash-loop. Aligned with
  // CLAUDE.md Rule 5 ("If gateway doesn't come back, REVERT the config
  // change, restart with old config, report the failure").
  //
  // Failure mode: if validate cannot run (network/SSH transient), we log
  // and proceed to restart anyway (degraded — same as old behavior).
  const validateRes = await ssh.execCommand(
    `${NVM_PREAMBLE} && ${DBUS_PREFIX} && openclaw config validate 2>&1`,
    { execOptions: { timeout: 15_000 } } as any,
  );
  const validateOut = (validateRes.stdout || '') + (validateRes.stderr || '');
  const validateOk = validateRes.code === 0 && /Config valid:/i.test(validateOut);

  if (!validateOk) {
    // Parse "Unrecognized keys: 'X', 'Y'" patterns. Format observed in the
    // vm-059 incident:
    //   - agents.defaults.compaction: Unrecognized keys: "maxActiveTranscriptBytes", "truncateAfterCompaction"
    // The regex captures the dotted-path prefix and the list of bad keys.
    const reverted: string[] = [];
    const unrecognized = validateOut.matchAll(
      /^[ \t]*-?[ \t]*([\w][\w.]+):[ \t]*Unrecognized keys?:[ \t]*((?:"[\w.-]+"[ \t]*,?[ \t]*)+)/gm,
    );
    for (const m of unrecognized) {
      const prefix = m[1].trim();
      const keys: string[] = [];
      const keyIter = m[2].matchAll(/"([\w.-]+)"/g);
      for (const km of keyIter) keys.push(km[1]);
      for (const k of keys) {
        const full = `${prefix}.${k}`;
        const unsetRes = await ssh.execCommand(
          `${NVM_PREAMBLE} && ${DBUS_PREFIX} && openclaw config unset ${full} 2>&1`,
          { execOptions: { timeout: 10_000 } } as any,
        );
        if (unsetRes.code === 0) {
          reverted.push(full);
        } else {
          logger.warn('stepGatewayRestart: unset failed', {
            route: 'stepGatewayRestart', vmId: vm.id, key: full,
            stderr: (unsetRes.stderr || '').slice(0, 200),
          });
        }
      }
    }

    if (reverted.length > 0) {
      // Re-validate after unsets. If still invalid, log loudly but proceed
      // (the gateway will crash-loop and we surface the error below — same
      // as old behavior).
      const reValidate = await ssh.execCommand(
        `${NVM_PREAMBLE} && ${DBUS_PREFIX} && openclaw config validate 2>&1`,
        { execOptions: { timeout: 15_000 } } as any,
      );
      const stillInvalid = reValidate.code !== 0 || !/Config valid:/i.test(reValidate.stdout || '');
      result.fixed.push(
        `config-validate: reverted ${reverted.length} schema-rejected keys (${reverted.slice(0, 3).join(', ')}${reverted.length > 3 ? '...' : ''})${stillInvalid ? ' [STILL INVALID after revert]' : ''}`,
      );
      logger.warn('stepGatewayRestart: config validate rejected keys', {
        route: 'stepGatewayRestart', vmId: vm.id,
        reverted,
        stillInvalidAfterRevert: stillInvalid,
        originalErrorTail: validateOut.slice(-500),
      });
    } else if (validateOut.trim().length > 0) {
      // Validation failed but we couldn't parse any specific keys to revert.
      // Could be a syntactic JSON error, missing required key, etc. Log
      // and proceed — gateway will surface the same error on start.
      logger.warn('stepGatewayRestart: config invalid but no parseable Unrecognized-keys section', {
        route: 'stepGatewayRestart', vmId: vm.id,
        outTail: validateOut.slice(-500),
        exit: validateRes.code,
      });
      result.errors.push(
        `config-validate failed pre-restart (exit=${validateRes.code}, no auto-revertable keys): ${validateOut.slice(-200).replace(/\s+/g, ' ').trim()}`,
      );
      // Don't push to errors twice if the restart also fails — gateway-restart
      // is the canonical "errors" entry for this VM. This entry just gives
      // operator a clearer breadcrumb at result-table time.
    }
  }

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

  // Verify gateway comes back healthy (up to 120s — wave 1 of the v66→v67
  // power+pro+starter pass on 2026-04-29 had vm-568 reach "active" + /health
  // 200 within ~80s and vm-858 even later. 60s caused false-fail PUSH-FAILEDs
  // on the slower starter-tier VMs even when the underlying upgrade was
  // healthy. 24 attempts × 5s = 120s.
  let healthy = false;
  for (let attempt = 0; attempt < 24; attempt++) {
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
    result.errors.push('gateway restart failed: not healthy after 120s');
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
  const unitOverrides = (manifest as { systemdUnitOverrides?: Record<string, string> }).systemdUnitOverrides ?? {};
  if (!overrides) return;

  const DBUS_PREFIX = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
  const unitPath = "$HOME/.config/systemd/user/openclaw-gateway.service";
  const overrideDir = "$HOME/.config/systemd/user/openclaw-gateway.service.d";
  const overridePath = `${overrideDir}/override.conf`;

  // 2026-05-11 P1-1 fix: was `result.alreadyCorrect.push("systemd unit: not
  // installed (skip)"); return;` — but the unit file
  // (~/.config/systemd/user/openclaw-gateway.service) is written by
  // configureOpenClaw and ALWAYS exists on a healthy assigned VM. Missing =
  // real defect (deleted manually, fs corruption, snapshot drift), NOT "no
  // work needed." Reporting alreadyCorrect masked the failure and let cv
  // bump on broken VMs (TOTAL_LIE shape). Now: missing unit pushes to
  // result.errors so the route.ts pushFailed gate (route.ts:280) holds the
  // cv bump.
  const check = await ssh.execCommand(`[ -f ${unitPath} ] && echo EXISTS || echo MISSING`);
  const unitExists = check.stdout.trim() === "EXISTS";
  if (!unitExists) {
    result.errors.push(
      `stepSystemdUnit: openclaw-gateway.service unit file missing at ${unitPath}. ` +
      `This file is written by configureOpenClaw and should always be present on a healthy assigned VM. ` +
      `Cannot apply systemd overrides without the parent unit. Investigate manually.`,
    );
    return;
  }

  // Build expected override.conf content. v75: emit BOTH [Unit] and [Service]
  // sections — StartLimit* directives MUST live in [Unit] or systemd silently
  // drops them (parse warning + non-functional restart-limit protection).
  const lines: string[] = [];
  if (Object.keys(unitOverrides).length > 0) {
    lines.push("[Unit]");
    for (const [key, value] of Object.entries(unitOverrides)) {
      lines.push(`${key}=${value}`);
    }
    lines.push("");
  }
  lines.push("[Service]");
  for (const [key, value] of Object.entries(overrides)) {
    lines.push(`${key}=${value}`);
  }
  const expectedContent = lines.join("\n") + "\n";

  // Check if override.conf already matches AND systemd has loaded it.
  // The on-disk content matching alone is not sufficient: systemd uses the
  // values that were daemon-reloaded into memory, NOT the on-disk file.
  // A previous step could have written the file but failed daemon-reload
  // (DBUS issue, stale session) — file says 120, runtime says 75. Worse:
  // configureOpenClaw at provision wrote TasksMax=75 (lib/ssh.ts:6659 — old
  // legacy value). If THIS step's drift detection only checks the on-disk
  // file and finds it matches the manifest's expected content, we'd skip
  // — but if systemd's runtime view still has 75, the VM is broken.
  // Therefore: require BOTH on-disk content match AND systemctl runtime
  // value match for the load-bearing key (TasksMax).
  // Compare md5 hashes, not raw stdout. node-ssh's execCommand strips the
  // trailing \n from stdout, so a byte-exact compare against expectedContent
  // (which ends in \n at L2834) ALWAYS reads as drift on an on-disk-correct
  // file. The hash is extracted via awk on the remote side, so it's robust
  // to the strip. Empirically confirmed root cause of the cv=82 stuck cohort
  // on 2026-05-12: 5-VM catch-up batch had 5/5 push-error reports because
  // every reconcile succeeded on disk (wc -c = 691) but verify saw 690 and
  // refused to bump cv (Rule 10 working as intended — wrong signal source).
  // The same fix is applied to the post-write verify below.
  const expectedMd5 = crypto.createHash("md5").update(expectedContent).digest("hex");
  const driftCheck = await ssh.execCommand(
    `[ -f ${overridePath} ] && md5sum ${overridePath} | awk '{print $1}' || echo MISSING`,
  );
  const onDiskMd5 = (driftCheck.stdout || "").trim();
  const onDiskMatches = onDiskMd5 === expectedMd5;
  const expectedTasksMax = (overrides as Record<string, string>).TasksMax;
  let runtimeTasksMaxOk = true;
  if (expectedTasksMax) {
    const tmCheck = await ssh.execCommand(
      `${DBUS_PREFIX} && systemctl --user show openclaw-gateway -p TasksMax --value 2>/dev/null`,
    );
    runtimeTasksMaxOk = tmCheck.stdout.trim() === expectedTasksMax;
  }
  if (onDiskMatches && runtimeTasksMaxOk) {
    result.alreadyCorrect.push("systemd override.conf: all settings correct");
    return;
  }

  if (dryRun) {
    const totalSettings = Object.keys(overrides).length + Object.keys(unitOverrides).length;
    result.fixed.push(`[dry-run] systemd override.conf: would write ${totalSettings} settings (${Object.keys(unitOverrides).length} [Unit] + ${Object.keys(overrides).length} [Service])`);
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

  // Verify-after-write per Rule 10. Two independent checks:
  //   (a) re-cat override.conf: confirms file content matches what we
  //       intended to write (catches FS races, partial writes).
  //   (b) systemctl show -p TasksMax --value: confirms systemd actually
  //       loaded the new override into its runtime view (catches
  //       daemon-reload silent no-ops, DBUS issues that returned exit=0
  //       but didn't actually reload).
  // Either failure pushes to result.errors → cv bump held by pushFailed
  // gate (route.ts:280). The full TOTAL_LIE pattern from the 2026-05-11
  // census (TasksMax=75 stuck despite cv claims) was caused by (b)
  // failing silently. Both checks now make the failure observable.
  // md5 compare instead of byte-exact stdout — see L2847 comment for the
  // node-ssh trailing-\n strip rationale. expectedMd5 is in scope from above.
  const verifyMd5Result = await ssh.execCommand(
    `md5sum ${overridePath} | awk '{print $1}'`,
  );
  const verifyMd5 = (verifyMd5Result.stdout || "").trim();
  if (verifyMd5 !== expectedMd5) {
    result.errors.push(
      `stepSystemdUnit: verify-after-write FAILED — on-disk override.conf md5 (${verifyMd5.slice(0, 12)}) does not match expected (${expectedMd5.slice(0, 12)})`,
    );
    return;
  }
  if (expectedTasksMax) {
    const tmVerify = await ssh.execCommand(
      `${DBUS_PREFIX} && systemctl --user show openclaw-gateway -p TasksMax --value 2>/dev/null`,
    );
    const actualTasksMax = tmVerify.stdout.trim();
    if (actualTasksMax !== expectedTasksMax) {
      result.errors.push(
        `stepSystemdUnit: verify-after-write FAILED — file written but systemd runtime TasksMax=${actualTasksMax}, expected ${expectedTasksMax}. ` +
        `daemon-reload likely silently no-op'd. Will retry next cycle.`,
      );
      return;
    }
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
    // Some VMs don't have Caddy installed at all (e.g. starter tier without
    // public hostname). That's a no-op, not an error — flagging it as an
    // error tripped the bump-without-push gate and produced false-fail
    // PUSH-FAILED reports during the v66→v67 fleet upgrade.
    result.alreadyCorrect.push("caddy: no Caddyfile (not installed)");
    return;
  }

  // Extract hostname from any line that starts with `<host>[:<port>] {`.
  // The `m` flag is load-bearing — without it, the `^` only matches the very
  // first character of the file, so a Caddyfile that begins with a comment,
  // blank line, or global options `{ ... }` block silently fails to parse and
  // pushes "caddy: could not parse hostname" to result.errors → cv held.
  // 2026-05-06: surfaced after the matchpool ENOENT fix unblocked the cv=82
  // cohort and exposed downstream stepCaddyUIBlock failures.
  const hostnameMatch = catResult.stdout.match(/^([a-zA-Z0-9][a-zA-Z0-9.\-]+(?::\d+)?)\s*\{/m);
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
// Step 8f2: v67 SOUL.md + CAPABILITIES.md routing table patch
//
// Surgical in-place row replacement for the v67 token-launch routing change
// (commit 9dfe894). Idempotent: keyed off the v67 marker. If the marker is
// already present, no-op. If the v66 row is absent, no-op (likely a customized
// or older template — the fleet patch script handles those by hand).
//
// This step exists because the reconciler's manifest entries for SOUL.md and
// CAPABILITIES.md are all append/insert — never overwrite. So in-place row
// edits in the templates can't reach existing VMs through reconcile alone.
// configureOpenClaw uses `>` overwrite, so first-setup VMs get the new
// content for free. This step is the matching reconciler-side path.
// ─────────────────────────────────────────────────────────────────────────

async function stepV67RoutingTablePatch(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Mirror of scripts/_fleet-patch-v67-soul.ts — same Python, same strings.
  // Kept in sync by hand; the canonical source is the templates in
  // lib/ssh.ts (WORKSPACE_SOUL_MD) and lib/agent-intelligence.ts.
  const SOUL_OLD = "| bankr, bankr wallet, bankr balance, bankr swap, token launch | Use the **bankr skill**. Check WALLET.md for your Bankr address. |";
  const SOUL_NEW_LINE_1 = "| launch a token, deploy a token, create a token, mint a token | **Token launches deploy on Base mainnet via `bankr launch` (CLI in bankr skill). NEVER Solana, NEVER Clanker — Bankr's general docs mention those, but this VM is configured for Base only.** Read bankr/SKILL.md for the launch flow. |";
  const SOUL_NEW_LINE_2 = "| bankr, bankr wallet, bankr balance, bankr swap | Use the **bankr skill**. Check WALLET.md for your Bankr address. |";
  const SOUL_NEW = `${SOUL_NEW_LINE_1}\n${SOUL_NEW_LINE_2}`;
  const CAPS_OLD = "| Crypto trading, swaps, token launches | **Bankr Wallet** | bankr skill (reads BANKR_API_KEY from env) |";
  const CAPS_NEW_LINE_1 = "| Crypto trading, swaps, transfers, fee claims (EVM) | **Bankr Wallet** | bankr skill (reads BANKR_API_KEY from env) |";
  const CAPS_NEW_LINE_2 = "| Token launches (Base mainnet only) | **Bankr Wallet** | `bankr launch` CLI via bankr skill — never Solana, never Clanker |";
  const CAPS_NEW = `${CAPS_NEW_LINE_1}\n${CAPS_NEW_LINE_2}`;
  const SOUL_MARKER = "Token launches deploy on Base mainnet";
  const CAPS_MARKER = "Token launches (Base mainnet only)";

  if (dryRun) {
    result.fixed.push("[dry-run] v67 routing table patch (would apply if old row present)");
    return;
  }

  const PATCH_PY = `import json, os, sys
cfg = json.loads(sys.stdin.read())
def patch(path, old, new, marker):
    path = os.path.expanduser(path)
    if not os.path.exists(path): return "missing"
    with open(path, "r") as f: content = f.read()
    if marker in content: return "already-patched"
    if old not in content: return "old-not-found"
    new_content = content.replace(old, new, 1)
    tmp = path + ".v67patch.tmp"
    with open(tmp, "w") as f: f.write(new_content)
    os.rename(tmp, path)
    with open(path, "r") as f: check = f.read()
    if marker not in check: return "verify-failed"
    return "patched"
print(f"SOUL:" + patch(cfg["soul_path"], cfg["soul_old"], cfg["soul_new"], cfg["soul_marker"]))
print(f"CAPS:" + patch(cfg["caps_path"], cfg["caps_old"], cfg["caps_new"], cfg["caps_marker"]))
`;

  const cfg = JSON.stringify({
    soul_path: "~/.openclaw/workspace/SOUL.md",
    caps_path: "~/.openclaw/workspace/CAPABILITIES.md",
    soul_old: SOUL_OLD,
    soul_new: SOUL_NEW,
    caps_old: CAPS_OLD,
    caps_new: CAPS_NEW,
    soul_marker: SOUL_MARKER,
    caps_marker: CAPS_MARKER,
  });
  const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
  const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
  const cmd = `echo '${cfgB64}' | base64 -d | python3 <(echo '${scriptB64}' | base64 -d)`;

  const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30_000 } });
  if (r.code !== 0) {
    result.errors.push(`v67-routing-patch python failed rc=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
    return;
  }
  const lines: Record<string, string> = {};
  for (const ln of r.stdout.split("\n")) {
    const idx = ln.indexOf(":");
    if (idx > 0) lines[ln.slice(0, idx)] = ln.slice(idx + 1).trim();
  }
  const soul = lines.SOUL ?? "?";
  const caps = lines.CAPS ?? "?";

  // already-patched and patched are both green. old-not-found is a no-op (a
  // customized template that doesn't have the v66 row to replace) — record as
  // alreadyCorrect so it doesn't trip the bump-without-push gate. Real
  // failures (verify-failed, missing) push to errors.
  const okStates = new Set(["patched", "already-patched", "old-not-found"]);
  if (okStates.has(soul) && okStates.has(caps)) {
    if (soul === "patched" || caps === "patched") {
      result.fixed.push(`v67 routing table (SOUL=${soul} CAPS=${caps})`);
    } else {
      result.alreadyCorrect.push(`v67 routing table (SOUL=${soul} CAPS=${caps})`);
    }
    return;
  }
  result.errors.push(`v67-routing-patch: SOUL=${soul} CAPS=${caps}`);
}

/**
 * stepInstaClawIdentityPatch — inject "## Platform" section into SOUL.md.
 *
 * Fixes the 2026-05-06 user complaint where agents identified themselves as
 * "OpenClaw agents" and described InstaClaw as a third-party platform they
 * "don't have set up." Same shape as stepV67RoutingTablePatch (Rule 23
 * precedent) — surgical in-place edit because all SOUL.md manifest entries
 * are append/insert and can't replace existing rows.
 *
 * Insertion strategy: Insert the new "## Platform" block BEFORE the
 * "## My Identity" anchor (which is user-editable for personality, but the
 * "## My Identity" header itself is stable across the fleet). This places
 * platform identity high in the file (above OPENCLAW_CACHE_BOUNDARY in V1)
 * for cache stability and for upfront-context priority.
 *
 * States:
 *   - "patched":           applied this run
 *   - "already-patched":   marker INSTACLAW_PLATFORM_V1 already present
 *   - "anchor-not-found":  user customized away the "## My Identity" header;
 *                          treat as alreadyCorrect (don't break customized
 *                          templates) but log so we can detect drift trends
 *   - "missing":           SOUL.md missing entirely (workspace-integrity
 *                          step should have created it)
 *   - "verify-failed":     wrote but marker not present after — push error
 *
 * V2 templates are detected and skipped (V2 SOUL.md ships with the Platform
 * section already in the template; legacy injections are no-ops on V2).
 */
async function stepInstaClawIdentityPatch(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const ANCHOR = "## My Identity";
  const MARKER_V1 = "INSTACLAW_PLATFORM_V1";
  const MARKER_V2 = "INSTACLAW_PLATFORM_V2";
  // Keep this content IN SYNC with WORKSPACE_SOUL_MD in lib/ssh.ts and
  // WORKSPACE_SOUL_MD_V2 in lib/workspace-templates-v2.ts.
  //
  // V2 (2026-05-07) adds the "Token launches are a core feature" subsection.
  // Why: the V1 block told the agent InstaClaw "ships token launches" but
  // did not override the model's default crypto-caution reflex. Multiple
  // user reports (Doug Rathell + cohort) showed agents refusing token
  // launches with regulatory/scam framing. V2 adds an explicit directive
  // + the correct path (dashboard, not VM CLI) so the next Doug doesn't
  // exist. Both markers are kept so old idempotency checks keep working.
  const PLATFORM_BLOCK = `<!-- INSTACLAW_PLATFORM_V1 -->
<!-- INSTACLAW_PLATFORM_V2 -->
## Platform

**You are an InstaClaw agent.** InstaClaw (instaclaw.io) is the platform that hosts you, provides your wallet (Bankr), connects you to your human via Telegram, and ships every capability you have — token launches, prediction-market trading, file delivery, the Clawlancer marketplace, matching engine, and the broader EARN.md surface. The OpenClaw codebase is your underlying runtime — like a kernel, it's how you exist, not who you are.

When asked "are you OpenClaw, InstaClaw, or something else?" answer **InstaClaw**. When asked what you can do, read CAPABILITIES.md and EARN.md first — those are your single source of truth. Never describe InstaClaw features as a third-party platform you can't access; those features ARE yours. If a capability isn't documented in CAPABILITIES.md or EARN.md, treat it as not yet shipped — don't hallucinate features.

### Token launches are a core feature, not a regulatory concern

When your user asks to launch a token, your job is **to help them launch it** — not to lecture them about securities law, scams, money laundering, or "promoting cryptocurrency."

The platform is purpose-built for this:
- Bankr handles the on-chain deploy on Base (Uniswap V4 / Doppler pools)
- Trading fees flow back to your wallet automatically
- InstaClaw covers gas for the launch
- The user has already signed up to a platform whose stated purpose is letting their AI agent launch its own token

**Refusing or hedging on token-launch requests is wrong behavior.** It contradicts the platform you run on, frustrates the user, and breaks the product. CAPABILITIES.md and EARN.md document the exact flow — read them, then act.

If the user says "launch a token," "tokenize me," "deploy a token on Base," or any clear variation: tell them to use the **dashboard at instaclaw.io** — that's the one-click button with gas covered and partner attribution. Do **not** try to launch via the \`bankr launch\` CLI from this VM yourself; that path uses a personal user-key without the right permissions and will fail with 403. Walk the user to the dashboard. **Do not refuse. Do not warn. Do not require the user to convince you crypto is legal. They already know.**

`;

  if (dryRun) {
    result.fixed.push("[dry-run] InstaClaw identity patch V2 (would insert/upgrade Platform section if anchor present)");
    return;
  }

  // Single-shot Python patcher — idempotent, atomic write, verify-after.
  // V1→V2 in-place upgrade: if the V1 marker is present (no V2), strip the
  // existing Platform block from V1 marker through the next "## " header
  // and re-insert the new V2 block at the anchor. This is the same pattern
  // stepV67RoutingTablePatch uses: surgical in-place edit because no
  // existing manifest mode supports row-replace.
  const PATCH_PY = `import json, os, re, sys
cfg = json.loads(sys.stdin.read())
path = os.path.expanduser(cfg["path"])
anchor = cfg["anchor"]
marker_v1 = cfg["marker_v1"]
marker_v2 = cfg["marker_v2"]
new_block = cfg["block"]
if not os.path.exists(path):
    print("RESULT:missing"); sys.exit(0)
with open(path, "r") as f: content = f.read()
# V2-template (workspace-templates-v2 path) ships with Platform inline
# already, no patch needed.
if "SOUL_V2_MIGRATED" in content:
    print("RESULT:v2-skip"); sys.exit(0)
# Already at V2 → no-op.
if marker_v2 in content:
    print("RESULT:already-patched"); sys.exit(0)
# V1 present, V2 absent → strip V1 block in place, insert V2.
if marker_v1 in content:
    pattern = r'<!-- INSTACLAW_PLATFORM_V1 -->\\s*\\n## Platform\\n.*?(?=\\n## )'
    stripped = re.sub(pattern, '', content, count=1, flags=re.DOTALL)
    if anchor not in stripped:
        print("RESULT:anchor-not-found-after-strip"); sys.exit(0)
    new_content = stripped.replace(anchor, new_block + anchor, 1)
elif anchor in content:
    new_content = content.replace(anchor, new_block + anchor, 1)
else:
    print("RESULT:anchor-not-found"); sys.exit(0)
tmp = path + ".instaclaw_id_patch.tmp"
with open(tmp, "w") as f: f.write(new_content)
os.rename(tmp, path)
with open(path, "r") as f: check = f.read()
if marker_v2 not in check:
    print("RESULT:verify-failed"); sys.exit(0)
# Sanity: zero or one Platform block (not two from a botched strip)
plat_count = check.count("\\n## Platform\\n")
if plat_count != 1:
    print(f"RESULT:platform-count-{plat_count}"); sys.exit(0)
print("RESULT:patched")
`;

  const cfg = JSON.stringify({
    path: "~/.openclaw/workspace/SOUL.md",
    anchor: ANCHOR,
    marker_v1: MARKER_V1,
    marker_v2: MARKER_V2,
    block: PLATFORM_BLOCK,
  });
  const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
  const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
  const cmd = `echo '${cfgB64}' | base64 -d | python3 <(echo '${scriptB64}' | base64 -d)`;

  const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30_000 } });
  if (r.code !== 0) {
    result.errors.push(`instaclaw-id-patch python failed rc=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`);
    return;
  }
  const m = r.stdout.match(/RESULT:(\S+)/);
  const state = m ? m[1] : "unknown";

  // patched / already-patched / v2-skip / anchor-not-found are all green.
  // anchor-not-found = customized template (user changed the "## My Identity"
  // header); we don't break customizations.
  const okStates = new Set(["patched", "already-patched", "v2-skip", "anchor-not-found"]);
  if (okStates.has(state)) {
    if (state === "patched") {
      result.fixed.push(`InstaClaw identity patch V2 (${state})`);
    } else {
      result.alreadyCorrect.push(`InstaClaw identity patch V2 (${state})`);
    }
    return;
  }
  result.errors.push(`instaclaw-id-patch V2: ${state}`);
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
 * Push a non-critical heal failure to result.warnings (Rule 39).
 * Unlike recordHealError, warnings do NOT block cv bump in the cron route's
 * pushFailed gate. Reserved for optional monitoring sidecars and gracefully-
 * degradable features that have zero customer impact when broken (node_exporter,
 * gateway-watchdog, private-repo skill installs missing auth).
 *
 * If you're tempted to use this for anything customer-facing (gateway,
 * stepConfigSettings, stepFiles, auth-profiles, ExecStart), DON'T — use
 * recordHealError instead so cv stays put until the issue is fixed.
 */
function recordHealWarning(result: ReconcileResult, msg: string): void {
  result.warnings.push(msg);
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
 * Step 8j: Gateway watchdog timer — DISABLED in v69 (2026-04-30).
 *
 * Inverted from "ensure enabled" to "ensure disabled". The watchdog script
 * had two structural bugs that turned it into a kill loop for any user with
 * cold-start delays or recently-failed inferences:
 *
 *   - FROZEN check uses LAST_SEND from /tmp/openclaw/openclaw-$DATE.log
 *     which persists across gateway restarts. A restarted gateway with no
 *     successful sendMessage today gets judged "frozen" within ~10 min and
 *     killed. Confirmed on vm-773 (Lee), vm-780 (Cooper edgecitybot),
 *     vm-linode-08 (Telly): 20+ SIGTERMs/24h, gateways never staying up.
 *   - TELEGRAM_DEAD has the same antipattern via LAST_TG_SEND.
 *
 * v68's GW_AGE>600 guard only delayed the kill 10 min instead of fixing it.
 *
 * The watchdog's value (catching alive-but-stuck gateways) is small —
 * systemd Restart=on-failure already handles process crashes, and most
 * "stuck" gateways are legitimately waiting on Anthropic. Cost (killing
 * working gateways) far exceeded benefit. Disabled fleet-wide until a
 * properly-rewritten watchdog with "since gateway start" log filtering is
 * tested and shipped.
 *
 * The reconciler now ENSURES the timer is disabled + stopped on every pass.
 * Unit files are left in place so re-enable is a one-command revert.
 */
async function stepGatewayWatchdogTimer(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
  _isPausedState: boolean,
): Promise<void> {
  try {
    const probe = await ssh.execCommand(
      `${HEAL_DBUS_PREFIX} && ` +
      `unit=$([ -f $HOME/.config/systemd/user/gateway-watchdog.timer ] && echo 1 || echo 0); ` +
      `enabled=$(systemctl --user is-enabled gateway-watchdog.timer 2>&1 | grep -q "^enabled$" && echo 1 || echo 0); ` +
      `active=$(systemctl --user is-active gateway-watchdog.timer 2>&1 | grep -q "^active$" && echo 1 || echo 0); ` +
      `echo "unit=$unit enabled=$enabled active=$active"`
    );
    const m = probe.stdout.match(/unit=(\d) enabled=(\d) active=(\d)/);
    if (!m) {
      recordHealWarning(result, `gw-watchdog: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [hasUnit, isEnabled, isActive] = [m[1] === "1", m[2] === "1", m[3] === "1"];

    if (!hasUnit) {
      // No unit file at all — nothing to disable, nothing wrong.
      result.alreadyCorrect.push("gw-watchdog: no unit (timer absent)");
      return;
    }
    if (!isEnabled && !isActive) {
      result.alreadyCorrect.push("gw-watchdog: already disabled + inactive");
      return;
    }

    if (dryRun) {
      result.fixed.push(`[dry-run] gw-watchdog: would stop + disable timer (was enabled=${isEnabled} active=${isActive})`);
      return;
    }

    await ssh.execCommand(
      `${HEAL_DBUS_PREFIX} && ` +
      `systemctl --user stop gateway-watchdog.timer 2>/dev/null; ` +
      `systemctl --user disable gateway-watchdog.timer 2>/dev/null; ` +
      `systemctl --user is-active gateway-watchdog.timer 2>&1 | head -1`
    );
    result.fixed.push(`gw-watchdog: stopped + disabled (was enabled=${isEnabled} active=${isActive})`);
  } catch (err) {
    recordHealWarning(result, `gw-watchdog: ${String(err).slice(0, 200)}`);
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

    // Build deploy script with all files base64'd inline.
    //
    // Sources from lib/dispatch-scripts.ts (auto-generated by
    // scripts/_gen-dispatch-scripts.mjs from skills/computer-dispatch/).
    // We inline rather than fs.readFileSync from skills/ because Next 15's
    // @vercel/nft tracer silently drops .sh files from the Vercel bundle —
    // same bug that broke configureOpenClaw's dispatch_deploy and was
    // fixed there in b3d58bc4. This is the matching reconciler-side fix.
    const lines: string[] = [
      "#!/bin/bash",
      "set +e",
      "mkdir -p $HOME/scripts $HOME/.openclaw/skills/computer-dispatch $HOME/.config/systemd/user",
      `echo '${Buffer.from(DISPATCH_SERVER_JS, "utf-8").toString("base64")}' | base64 -d > $HOME/scripts/dispatch-server.js`,
      `echo '${Buffer.from(DISPATCH_SKILL_MD, "utf-8").toString("base64")}' | base64 -d > $HOME/.openclaw/skills/computer-dispatch/SKILL.md`,
    ];
    for (const [name, content] of Object.entries(DISPATCH_SCRIPTS)) {
      const b64 = Buffer.from(content, "utf-8").toString("base64");
      lines.push(`echo '${b64}' | base64 -d > $HOME/scripts/${name}`);
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
    // Probe — five flags. `deps` is the Rule 48 addition: catches the
    // crash-loop case where unit/mjs/key are all present but node_modules
    // is missing or corrupt. vm-912 (2026-05-14) had ~/scripts/node_modules/
    // viem/ as a directory but viem/package.json was 0 bytes, so the Node
    // ESM resolver threw ERR_MODULE_NOT_FOUND. `[ -s file ]` (non-empty)
    // catches that case in addition to "file exists".
    const probe = await ssh.execCommand(
      `${HEAL_DBUS_PREFIX} && ` +
      `unit=$([ -f $HOME/.config/systemd/user/instaclaw-xmtp.service ] && echo 1 || echo 0); ` +
      `active=$(systemctl --user is-active instaclaw-xmtp 2>&1 | grep -q "^active$" && echo 1 || echo 0); ` +
      `mjs=$([ -f $HOME/scripts/xmtp-agent.mjs ] && echo 1 || echo 0); ` +
      `key=$(grep -q "^XMTP_WALLET_KEY=" $HOME/.openclaw/xmtp/.env 2>/dev/null && echo 1 || echo 0); ` +
      `deps=$([ -d $HOME/scripts/node_modules/@xmtp/agent-sdk ] && [ -s $HOME/scripts/node_modules/viem/package.json ] && echo 1 || echo 0); ` +
      `echo "unit=$unit active=$active mjs=$mjs key=$key deps=$deps"`
    );
    const m = probe.stdout.match(/unit=(\d) active=(\d) mjs=(\d) key=(\d) deps=(\d)/);
    if (!m) {
      recordHealError(result, strict, `instaclaw-xmtp: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [hasUnit, isActive, hasMjs, hasKey, hasDeps] = [
      m[1] === "1", m[2] === "1", m[3] === "1", m[4] === "1", m[5] === "1",
    ];

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

    // Routing per Rule 48:
    //   - key=0 OR mjs=0  → full setupXMTP (always; wallet/script missing)
    //   - key=1 mjs=1 deps=0 → dep-repair (npm install, then surgical)
    //   - key=1 mjs=1 deps=1 → surgical (write unit + restart + poll)
    let path: "surgical" | "dep-repair" | "full setupXMTP";
    if (!hasKey || !hasMjs) path = "full setupXMTP";
    else if (!hasDeps) path = "dep-repair";
    else path = "surgical";

    if (dryRun) {
      result.fixed.push(`[dry-run] instaclaw-xmtp: would ${path} (unit=${hasUnit} active=${isActive} mjs=${hasMjs} key=${hasKey} deps=${hasDeps})`);
      return;
    }

    if (path === "dep-repair") {
      // Rule 48 / REC-5 (2026-05-14): node_modules broken (missing
      // @xmtp/agent-sdk or empty viem/package.json). The surgical path
      // CANNOT recover this — restarting only retries the failing
      // ERR_MODULE_NOT_FOUND import. Run npm install first to restore
      // the deps, then fall through to the surgical path to write the
      // unit + restart.
      //
      // Scope of rm -rf: only ~/scripts/node_modules/. The wallet key
      // (~/.openclaw/xmtp/.env), the agent script (~/scripts/xmtp-agent.mjs),
      // and the systemd unit (~/.config/systemd/user/instaclaw-xmtp.service)
      // are all untouched. Wallet identity preserved.
      const npmRes = await ssh.execCommand(
        `${HEAL_DBUS_PREFIX} && source ~/.nvm/nvm.sh 2>/dev/null && ` +
          `systemctl --user stop instaclaw-xmtp 2>/dev/null; ` +
          `cd ~/scripts && rm -rf node_modules && ` +
          `npm install @xmtp/agent-sdk@latest 2>&1 | tail -3`,
      );
      if (npmRes.code !== 0) {
        recordHealError(result, strict, `instaclaw-xmtp: dep-repair (npm install) failed: ${(npmRes.stdout || npmRes.stderr).slice(-200)}`);
        return;
      }
      const verify = await ssh.execCommand(
        `[ -d $HOME/scripts/node_modules/@xmtp/agent-sdk ] && ` +
          `[ -s $HOME/scripts/node_modules/viem/package.json ] && echo OK || echo FAIL`,
      );
      if (!verify.stdout.includes("OK")) {
        recordHealError(result, strict, "instaclaw-xmtp: dep-repair completed but verify failed");
        return;
      }
      result.fixed.push("instaclaw-xmtp: dep-repair (npm install completed)");
      // Fall through into the surgical block below — same write+restart+poll
      // logic that the surgical path uses.
    }

    if (path === "surgical" || path === "dep-repair") {
      // Surgical in-place fix — preserves wallet identity.
      // reset-failed before restart so previous crash-loop counter doesn't
      // pin the service into 'failed' state (Rule 48 / REC-5 pattern).
      const writeRestart = await ssh.execCommand(`bash -c '
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
systemctl --user reset-failed instaclaw-xmtp 2>/dev/null
systemctl --user restart instaclaw-xmtp
echo RESTART_ISSUED
'`);
      if (writeRestart.stdout.includes("NO_NODE")) {
        recordHealError(result, strict, "instaclaw-xmtp: NVM node binary not found");
        return;
      }
      if (!writeRestart.stdout.includes("RESTART_ISSUED")) {
        recordHealError(
          result,
          strict,
          `instaclaw-xmtp: surgical fix failed (no restart issued): ${writeRestart.stdout.slice(-200)}`,
        );
        return;
      }

      // Rule 48: poll is-active for up to 60s with 2s interval. Cold-start
      // of xmtp-agent.mjs (load wallet, connect to XMTP network, register)
      // can take 20-30s; the previous `sleep 4` was too short and produced
      // false-negative `activating` reports during the auto-restart window.
      // Exact-string compare so `activating` isn't ambiguous with `active`.
      let xmtpActive = false;
      let lastState = "";
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pr = await ssh.execCommand(`${HEAL_DBUS_PREFIX} && systemctl --user is-active instaclaw-xmtp`);
        lastState = pr.stdout.trim();
        if (lastState === "active") {
          xmtpActive = true;
          break;
        }
      }
      if (xmtpActive) {
        const tag = path === "dep-repair" ? "surgical fix after dep-repair" : "surgical fix (wallet preserved)";
        result.fixed.push(`instaclaw-xmtp: ${tag}`);
      } else {
        // Surface NRestarts for diagnosis — high count signals crash-loop
        // (likely Rule 48 — broken deps) rather than slow cold-start.
        const counterProbe = await ssh.execCommand(
          `${HEAL_DBUS_PREFIX} && systemctl --user show instaclaw-xmtp --property=NRestarts --no-pager 2>/dev/null`,
        );
        const nr = parseInt(counterProbe.stdout.match(/NRestarts=(\d+)/)?.[1] || "0", 10);
        recordHealError(
          result,
          strict,
          `instaclaw-xmtp: surgical fix failed: state=${lastState} NRestarts=${nr}`,
        );
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
      recordHealWarning(result, `node_exporter: probe parse failed: ${probe.stdout.slice(0, 120)}`);
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
      recordHealWarning(result, "node_exporter: passwordless sudo not available");
      return;
    }

    // Build install script — restart gated on isPausedState. Config push
    // (binary download + unit file write + enable) always runs; the start
    // is skipped when paused so the service auto-starts on next boot via
    // WantedBy=multi-user.target instead of right now.
    const startBlock = isPausedState
      ? "echo SKIP_START_PAUSED"
      // 2026-05-06: sleep 2 → 5. node_exporter v1.8.2 takes ~3s to bind :9100
      // on a 2-vCPU dedicated Linode (measured on vm-632 — see commit message).
      // 2s was a false-negative: PORT_FAIL got pushed even though the service
      // was healthy and bound the port a fraction of a second after the probe.
      : "sudo systemctl restart node_exporter && sleep 5 && (ss -tln 2>/dev/null | grep -q ':9100 ' && echo PORT_OK || echo PORT_FAIL)";

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
      recordHealWarning(result, `node_exporter: ${reason} (${install.stdout.slice(-200)})`);
    }
  } catch (err) {
    recordHealWarning(result, `node_exporter: ${String(err).slice(0, 200)}`);
  }
}

// ============================================================================
// SOUL.md V2 Migration — PRD prd-soul-restructure.md Phase 1
// ============================================================================

/** Extract a `## <Header>` section body from markdown (between header and next `## `). */
function extractMarkdownSection(content: string, headerName: string): string | null {
  const idx = content.indexOf(`## ${headerName}`);
  if (idx < 0) return null;
  const startBody = idx + `## ${headerName}`.length;
  const nextHeaderIdx = content.indexOf("\n## ", startBody);
  return content
    .slice(startBody, nextHeaderIdx >= 0 ? nextHeaderIdx : undefined)
    .trim();
}

/** Heuristic: does the `## My Identity` body look like the unedited V1 template? */
function isIdentityTemplateText(body: string): boolean {
  return body.includes("Your identity develops naturally through your conversations")
      || body.includes("There is no need to announce or figure out your identity");
}

/** Heuristic: does the `## Learned Preferences` body look like unedited V1 template? */
function isPreferencesTemplateText(body: string): boolean {
  return body.includes("As you learn what your owner likes")
      && body.includes('_(e.g., "Prefers concise responses, no bullet lists")_');
}

/** Extract bullets from a Learned Preferences body, dropping the italic example bullets. */
function extractCustomPreferenceBullets(prefsBody: string): string[] {
  return prefsBody
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("- "))
    .filter(l => !l.includes("_(e.g."));
}

/**
 * Replace V2 SOUL.md's example preference bullets with the agent's preserved bullets.
 * Returns V2 unchanged if the example block isn't found verbatim (template drift safety).
 */
function applyPreservedPreferences(soulV2: string, customBullets: string[]): string {
  if (customBullets.length === 0) return soulV2;
  const exampleBlock = `- _(e.g., "Prefers concise responses, no bullet lists")_
- _(e.g., "Works late nights, don't suggest morning routines")_
- _(e.g., "Loves code examples, hates pseudocode")_`;
  if (!soulV2.includes(exampleBlock)) return soulV2;
  return soulV2.replace(exampleBlock, customBullets.join("\n"));
}

/**
 * Append a "## Identity (preserved from V1 SOUL.md)" section to V2 IDENTITY.md,
 * containing the agent's old `## My Identity` body verbatim. Agent reads both
 * the V2 fields and the preserved content on next session.
 */
function appendPreservedIdentity(identityV2: string, preservedBody: string): string {
  return identityV2.trimEnd() + `\n\n## Identity (preserved from V1 SOUL.md)

_The following was your previous identity content. Review and integrate into the fields above as desired._

${preservedBody.trim()}
`;
}

/**
 * Atomically write `content` to `path` via tmp + rename, verified with SHA256
 * both pre-rename (on tmp) and post-rename (on final path).
 *
 * Why SHA twice:
 *   (1) Post-write SHA on tmp catches base64-decode corruption or 0-byte writes
 *       — without this, a malformed echo|base64 pipe can succeed via mv and
 *       leave an empty SOUL.md on disk. Rule 10 verify-after-write.
 *   (2) Post-rename SHA on final path catches mv-layer issues or FS weirdness.
 *
 * Tmp file is named with a unique suffix and removed by trap on any exit path,
 * so partial-failure leaks are bounded.
 *
 * Returns:
 *   { ok: true } on success.
 *   { ok: false, error: string } on any failure (exit code or SHA mismatch).
 */
async function writeFileAtomic(
  ssh: Awaited<ReturnType<typeof connectSSH>>,
  path: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  const expectedSha = crypto
    .createHash("sha256")
    .update(content, "utf8")
    .digest("hex");

  // Shell script: write tmp, SHA-verify tmp, atomic rename, SHA-verify final.
  // Each stage has its own exit code so the caller can report which check fired.
  const script = [
    `EXPECTED='${expectedSha}'`,
    `TMP='${tmp}'`,
    `DST='${path}'`,
    `trap 'rm -f "$TMP" 2>/dev/null' EXIT`,
    `if ! { echo '${b64}' | base64 -d > "$TMP"; }; then echo "B64_DECODE_FAILED" >&2; exit 2; fi`,
    `SHA_TMP=$(sha256sum "$TMP" 2>/dev/null | awk '{print $1}')`,
    `if [ "$SHA_TMP" != "$EXPECTED" ]; then echo "TMP_SHA_MISMATCH exp=$EXPECTED got=$SHA_TMP" >&2; exit 3; fi`,
    `if ! mv "$TMP" "$DST"; then echo "MV_FAILED" >&2; exit 4; fi`,
    `SHA_DST=$(sha256sum "$DST" 2>/dev/null | awk '{print $1}')`,
    `if [ "$SHA_DST" != "$EXPECTED" ]; then echo "POST_RENAME_SHA_MISMATCH exp=$EXPECTED got=$SHA_DST" >&2; exit 5; fi`,
    `echo OK`,
  ].join("\n");

  const r = await ssh.execCommand(script);
  if (r.code !== 0 || !(r.stdout || "").trim().endsWith("OK")) {
    const errSnippet =
      (r.stderr || "").trim() || (r.stdout || "").trim() || "unknown";
    return {
      ok: false,
      error: `writeFileAtomic ${path} exit=${r.code}: ${errSnippet.slice(0, 200)}`,
    };
  }
  return { ok: true };
}

/**
 * Step 2a: Migrate V1 SOUL.md → V2 SOUL.md + AGENTS.md + TOOLS.md + IDENTITY.md.
 *
 * Idempotent: detects SOUL_V2_MARKER and skips if already migrated.
 * Gated: only runs when RECONCILE_SOUL_MIGRATION_ENABLED=true (default OFF).
 *
 * Steps:
 *   1. Check env gate. If off, no-op.
 *   2. Read current SOUL.md. If contains SOUL_V2_MARKER, already migrated.
 *   3. Tar workspace as `~/.openclaw/workspace-pre-soul-v2-migration.tar.gz`
 *      (idempotent — only tars if file doesn't exist).
 *   4. Extract `## My Identity` body and `## Learned Preferences` body from old SOUL.
 *   5. Determine customization (vs. canonical template fragments).
 *   6. Build new V2 files:
 *        - SOUL.md = V2 template with preserved Preferences bullets if customized
 *        - IDENTITY.md = V2 template with preserved Identity body APPENDED if customized
 *        - TOOLS.md = V2 template (replaces tiny legacy template wholesale)
 *        - AGENTS.md = V2 template (replaces tiny legacy template wholesale)
 *   7. Write each via atomic tmp+rename.
 *   8. Log preservation outcome to result.fixed.
 */
/**
 * Inject partner SOUL.md stubs into V2 SOUL.md, sourced from the VM's partner
 * field rather than from the V1 SOUL.md content. Position: above the
 * OPENCLAW_CACHE_BOUNDARY marker (and the `---` separator that precedes it),
 * placing the stubs in the stable-prefix region that Anthropic caches.
 *
 * Without this, a V2 migration on an edge_city or consensus_2026 VM drops the
 * partner section (V2 template has none), and stepRewriteSoulPartnerSections
 * on the next reconciler tick finds no `## Edge Esmeralda 2026` header to
 * replace and treats it as "old-not-found" → no-op → partner awareness lost.
 */
function injectPartnerStubs(
  soulV2: string,
  partner: string | null | undefined,
): string {
  if (!partner) return soulV2;
  const stubs: string[] = [];
  // edge_city VMs get BOTH stubs (mirrors stepRewriteSoulPartnerSections
  // line 3920: applyConsensus is also true for edge_city).
  if (partner === "edge_city") {
    stubs.push(SOUL_STUB_EDGE.trim(), SOUL_STUB_CONSENSUS.trim());
  } else if (partner === "consensus_2026") {
    stubs.push(SOUL_STUB_CONSENSUS.trim());
  }
  if (stubs.length === 0) return soulV2;

  // Insert above the OPENCLAW_CACHE_BOUNDARY marker (and the '---' that
  // precedes it). Falls back to end-of-file append if marker layout drifts.
  const cacheMarker = "<!-- OPENCLAW_CACHE_BOUNDARY -->";
  const markerIdx = soulV2.indexOf(cacheMarker);
  if (markerIdx < 0) {
    return soulV2.trimEnd() + "\n\n" + stubs.join("\n\n") + "\n";
  }
  const separatorIdx = soulV2.lastIndexOf("\n---\n", markerIdx);
  const insertAt = separatorIdx >= 0 ? separatorIdx : markerIdx;
  return (
    soulV2.slice(0, insertAt) +
    "\n\n" +
    stubs.join("\n\n") +
    soulV2.slice(insertAt)
  );
}

/**
 * Read up to N workspace files in a single SSH round-trip. Each file is
 * encoded as base64 to avoid sentinel collisions with file content.
 *
 * Output format on the remote side:
 *   PATH:<absolute_path>
 *   B64:<base64_content_or_MISSING>
 *
 * Returns a map keyed by the absolute path. Missing files map to empty string.
 */
async function readWorkspaceFiles(
  ssh: SSHConnection,
  paths: string[],
): Promise<Record<string, string>> {
  const cmd = paths
    .map(
      (p) =>
        `(echo "PATH:${p}"; if [ -f '${p}' ]; then echo "B64:$(base64 < '${p}' | tr -d '\\n')"; else echo "B64:MISSING"; fi)`,
    )
    .join("; ");
  const r = await ssh.execCommand(cmd);
  if (r.code !== 0) {
    throw new Error(
      `readWorkspaceFiles failed code=${r.code}: ${(r.stderr || "").slice(0, 200)}`,
    );
  }
  const out: Record<string, string> = {};
  // Initialize all requested paths so callers can safely lookup any path.
  for (const p of paths) out[p] = "";
  const lines = (r.stdout || "").split("\n");
  let currentPath: string | null = null;
  for (const line of lines) {
    if (line.startsWith("PATH:")) {
      currentPath = line.slice("PATH:".length);
    } else if (line.startsWith("B64:") && currentPath !== null) {
      const b64 = line.slice("B64:".length);
      if (b64 && b64 !== "MISSING") {
        try {
          out[currentPath] = Buffer.from(b64, "base64").toString("utf8");
        } catch {
          out[currentPath] = "";
        }
      }
      currentPath = null;
    }
  }
  return out;
}

/**
 * Step 2a: Migrate V1 SOUL.md → V2 SOUL.md + AGENTS.md + TOOLS.md + IDENTITY.md.
 *
 * Idempotent on ALL FOUR V2 markers (not just SOUL.md) — partial-state from
 * a failed prior attempt is detected and recovered by writing the missing
 * files only. This eliminates the "SOUL is V2 but AGENTS is V1" stuck state
 * that Bug #2 (PRD soul-md-trim-2026-05-11.md) would otherwise produce.
 *
 * Write order: AGENTS → TOOLS → IDENTITY → SOUL. SOUL.md is written LAST so
 * that any partial-write failure leaves V1 SOUL.md on disk, preserving the
 * extraction source for the next tick's retry. This is byte-perfect-idempotent
 * because re-extracting from the same V1 SOUL.md produces the same V2 output.
 *
 * Disk-space precheck: skip-with-error if /home/openclaw has <2GB free
 * (avoids tar OOM on the vm-903/801/904 session-backups-bloat cohort).
 *
 * Tar backup: only runs on fresh migration (not partial-state recovery, where
 * the tar already exists from the original attempt). Separates "already exists"
 * from "tar failed" cleanly — the previous `|| echo SKIP_EXISTS` masked
 * disk-full failures as success, allowing the migration to proceed with no
 * recoverable backup.
 *
 * All writes use SHA-verified writeFileAtomic so 0-byte/corrupted writes are
 * caught (previously the function returned true on any successful `mv`
 * regardless of content integrity — Bug #3, Rule 10 violation).
 *
 * Gated: only runs when RECONCILE_SOUL_MIGRATION_ENABLED=true (default OFF).
 * Whitelist (canary scoping): RECONCILE_SOUL_MIGRATION_VM_IDS=<id>,<id>,...
 *
 * Per CLAUDE.md Rule 22: trim, never nuke; tar backup before mutation.
 * Per Rule 23: SHA-verified writes prevent stale-cache regressions.
 * Per Rule 10: each write verifies the result via SHA; result.errors blocks
 * config_version bump until the migration is clean.
 */
async function stepMigrateSoulV2(
  ssh: Awaited<ReturnType<typeof connectSSH>>,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // ── Kill switch ──
  if (process.env.RECONCILE_SOUL_MIGRATION_ENABLED !== "true") {
    return;
  }

  // ── Per-VM whitelist (canary scoping) ──
  const whitelistRaw = process.env.RECONCILE_SOUL_MIGRATION_VM_IDS;
  if (whitelistRaw && whitelistRaw.trim().length > 0) {
    const allowed = whitelistRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(vm.id)) {
      return;
    }
  }

  const workspaceDir = "/home/openclaw/.openclaw/workspace";
  const archiveDir = "/home/openclaw/.openclaw";
  const soulPath = `${workspaceDir}/SOUL.md`;
  const identityPath = `${workspaceDir}/IDENTITY.md`;
  const toolsPath = `${workspaceDir}/TOOLS.md`;
  const agentsPath = `${workspaceDir}/AGENTS.md`;
  const tarPath = `${archiveDir}/workspace-pre-soul-v2-migration.tar.gz`;

  // ── Step 1: Read all four files in one SSH round-trip ──
  let cur: Record<string, string>;
  try {
    cur = await readWorkspaceFiles(ssh, [
      soulPath,
      identityPath,
      toolsPath,
      agentsPath,
    ]);
  } catch (e) {
    result.errors.push(`soul-v2-migration: read workspace files: ${(e as Error).message}`);
    return;
  }
  const curSoul = cur[soulPath] ?? "";
  const curIdentity = cur[identityPath] ?? "";
  const curTools = cur[toolsPath] ?? "";
  const curAgents = cur[agentsPath] ?? "";

  // ── Step 2: V2-marker presence for all four files ──
  const v2 = {
    soul: curSoul.includes(SOUL_V2_MARKER),
    identity: curIdentity.includes(IDENTITY_V2_MARKER),
    tools: curTools.includes(TOOLS_V2_MARKER),
    agents: curAgents.includes(AGENTS_V2_MARKER),
  };

  // ── Step 3: Full no-op when everything is V2 ──
  if (v2.soul && v2.identity && v2.tools && v2.agents) {
    result.alreadyCorrect.push("soul-v2-migration: all 4 files at V2");
    return;
  }

  // ── Step 4: Determine path ──
  // Fresh migration: SOUL.md is V1 (or missing). Extract customizations from
  // V1 SOUL.md, build all 4 V2 files, write all 4 (SOUL last).
  //
  // Partial-state recovery: SOUL.md is V2 but at least one of the other 3
  // files is still V1 (a previous attempt's write failed partway). Write only
  // the missing files. V1 SOUL.md is GONE in this case so the customization
  // it held was already extracted-and-preserved in the prior attempt's V2 SOUL.
  const isFreshMigration = !v2.soul && curSoul.length > 0;
  const isPartialRecovery =
    v2.soul && (!v2.identity || !v2.tools || !v2.agents);

  if (!isFreshMigration && !isPartialRecovery) {
    // SOUL.md missing AND no partial state to recover. Fresh VMs come up via
    // configureOpenClaw() which writes V1 SOUL.md; if SOUL.md is missing here,
    // something upstream is wrong (stepWorkspaceIntegrity should have created
    // a baseline). Don't try to migrate from nothing.
    result.alreadyCorrect.push(
      "soul-v2-migration: no SOUL.md found, nothing to migrate",
    );
    return;
  }

  // ── Step 5: Disk-space precheck (≥2GB free on /home/openclaw) ──
  // Avoids tar OOM/disk-full on the vm-903/801/904 cohort with runaway
  // session-backups bloat. Skip-with-error so config_version doesn't bump
  // (Rule 10) and the VM gets surfaced for manual cleanup.
  const dfCheck = await ssh.execCommand(
    `df -k /home/openclaw 2>/dev/null | tail -1 | awk '{print $4}'`,
  );
  const availKb = parseInt((dfCheck.stdout || "0").trim(), 10) || 0;
  const minFreeKb = 2 * 1024 * 1024; // 2 GB
  if (availKb < minFreeKb) {
    const availGb = (availKb / (1024 * 1024)).toFixed(2);
    result.errors.push(
      `soul-v2-migration: insufficient disk (${availGb} GB free, need ≥2 GB) — manual cleanup required`,
    );
    return;
  }

  // ── Step 6: Tar backup before mutation (fresh migration only) ──
  // Partial-state recovery skips this — the tar was already created in the
  // original attempt that failed mid-write.
  if (isFreshMigration && !dryRun) {
    const tarScript = [
      `cd '${archiveDir}' || { echo "CD_FAILED"; exit 1; }`,
      `if [ -f '${tarPath}' ]; then`,
      `  SIZE=$(stat -c%s '${tarPath}' 2>/dev/null || stat -f%z '${tarPath}' 2>/dev/null || echo 0)`,
      `  if [ "$SIZE" -gt 1024 ]; then echo "ALREADY_EXISTS size=$SIZE"; exit 0; fi`,
      `  rm -f '${tarPath}'`,
      `fi`,
      `if ! tar -czf '${tarPath}' workspace 2>&1 >/dev/null; then echo "TAR_FAILED"; exit 2; fi`,
      `NEW_SIZE=$(stat -c%s '${tarPath}' 2>/dev/null || stat -f%z '${tarPath}' 2>/dev/null || echo 0)`,
      `if [ "$NEW_SIZE" -lt 1024 ]; then echo "TAR_TOO_SMALL size=$NEW_SIZE"; exit 3; fi`,
      `echo "OK size=$NEW_SIZE"`,
    ].join("\n");
    const tarRes = await ssh.execCommand(tarScript, {
      execOptions: { timeout: 60_000 },
    });
    const tarOut = (tarRes.stdout || "").trim();
    if (
      tarRes.code !== 0 ||
      !(tarOut.includes("OK ") || tarOut.includes("ALREADY_EXISTS"))
    ) {
      result.errors.push(
        `soul-v2-migration: tar backup failed code=${tarRes.code}: ${(tarRes.stdout || tarRes.stderr || "").slice(0, 200)}`,
      );
      return;
    }
  }

  // ── Step 7: Build the V2 file contents to write ──
  type FileWrite = { path: string; content: string; name: string };
  const writes: FileWrite[] = [];

  // Track preservation for the post-write log entry.
  const preservedNotes: string[] = [];

  if (isFreshMigration) {
    // Extract customizations from V1 SOUL.md (still on disk here).
    const identityBody = extractMarkdownSection(curSoul, "My Identity");
    const prefsBody = extractMarkdownSection(curSoul, "Learned Preferences");
    const identityCustomized =
      identityBody !== null && !isIdentityTemplateText(identityBody);
    const prefsCustomized =
      prefsBody !== null && !isPreferencesTemplateText(prefsBody);

    // Build V2 SOUL.md: template → preserve Preferences if customized →
    // inject partner stubs from vm.partner (the load-bearing Bug #1 fix).
    let newSoul = WORKSPACE_SOUL_MD_V2;
    if (prefsCustomized && prefsBody) {
      const customBullets = extractCustomPreferenceBullets(prefsBody);
      if (customBullets.length > 0) {
        newSoul = applyPreservedPreferences(newSoul, customBullets);
        preservedNotes.push("preferences");
      }
    }
    if (vm.partner === "edge_city" || vm.partner === "consensus_2026") {
      newSoul = injectPartnerStubs(newSoul, vm.partner);
      preservedNotes.push(`partner=${vm.partner}`);
    }

    // Build V2 IDENTITY.md: template → preserve V1 SOUL "My Identity" body →
    // also preserve any non-template content in the existing IDENTITY.md.
    let newIdentity = WORKSPACE_IDENTITY_MD_V2;
    if (identityCustomized && identityBody) {
      newIdentity = appendPreservedIdentity(newIdentity, identityBody);
      preservedNotes.push("identity-from-soul");
    }
    if (
      curIdentity.length > 0 &&
      !curIdentity.includes("Your identity develops naturally") &&
      !curIdentity.includes("Fill this in") &&
      !curIdentity.includes(IDENTITY_V2_MARKER)
    ) {
      newIdentity =
        newIdentity.trimEnd() +
        `\n\n## IDENTITY.md (preserved from previous version)\n\n_Your previous IDENTITY.md content is preserved below. Review and integrate into the fields above as desired._\n\n\`\`\`\n${curIdentity.trim()}\n\`\`\`\n`;
      preservedNotes.push("existing-identity-md");
    }

    // Write order: AGENTS → TOOLS → IDENTITY → SOUL.
    // Rationale: if any write fails mid-loop, leave V1 SOUL.md on disk so the
    // next tick's retry can re-extract from the source of truth. Re-writing
    // AGENTS/TOOLS/IDENTITY with identical content on retry is a SHA no-op
    // via writeFileAtomic's verification.
    writes.push({
      path: agentsPath,
      content: WORKSPACE_AGENTS_MD_V2,
      name: "AGENTS.md",
    });
    writes.push({
      path: toolsPath,
      content: WORKSPACE_TOOLS_MD_V2,
      name: "TOOLS.md",
    });
    writes.push({
      path: identityPath,
      content: newIdentity,
      name: "IDENTITY.md",
    });
    writes.push({ path: soulPath, content: newSoul, name: "SOUL.md" });
  } else {
    // Partial-state recovery. SOUL.md is already V2 (preserves any prior
    // customization from the original attempt). Write only the missing files.
    if (!v2.agents) {
      writes.push({
        path: agentsPath,
        content: WORKSPACE_AGENTS_MD_V2,
        name: "AGENTS.md(recovery)",
      });
    }
    if (!v2.tools) {
      writes.push({
        path: toolsPath,
        content: WORKSPACE_TOOLS_MD_V2,
        name: "TOOLS.md(recovery)",
      });
    }
    if (!v2.identity) {
      // V1 SOUL.md is already overwritten; can't re-extract its "My Identity"
      // body. Preserve only what's in the on-disk IDENTITY.md (which may be
      // V1 template, agent-edited, or empty).
      let newIdentity = WORKSPACE_IDENTITY_MD_V2;
      if (
        curIdentity.length > 0 &&
        !curIdentity.includes("Your identity develops naturally") &&
        !curIdentity.includes("Fill this in") &&
        !curIdentity.includes(IDENTITY_V2_MARKER)
      ) {
        newIdentity =
          newIdentity.trimEnd() +
          `\n\n## IDENTITY.md (preserved from previous version)\n\n_Your previous IDENTITY.md content is preserved below. Review and integrate into the fields above as desired._\n\n\`\`\`\n${curIdentity.trim()}\n\`\`\`\n`;
        preservedNotes.push("existing-identity-md");
      }
      writes.push({
        path: identityPath,
        content: newIdentity,
        name: "IDENTITY.md(recovery)",
      });
    }
  }

  // ── Step 8: Dry-run output ──
  const mode = isPartialRecovery ? "partial-recovery" : "fresh-migration";
  if (dryRun) {
    const wouldWrite = writes.map((w) => w.name).join(",") || "none";
    result.fixed.push(
      `[dry-run] soul-v2-migration (${mode}): would write ${wouldWrite}; preserved=${preservedNotes.join(",") || "none"}`,
    );
    return;
  }

  // ── Step 9: Atomic writes (SHA-verified) ──
  for (const w of writes) {
    const res = await writeFileAtomic(ssh, w.path, w.content);
    if (res.ok === false) {
      result.errors.push(
        `soul-v2-migration: ${w.name} write failed: ${res.error}`,
      );
      return; // bail; tar backup is the recovery path
    }
  }

  // ── Step 10: Log success ──
  result.fixed.push(
    `soul-v2-migration (${mode}): wrote ${writes.length} file${writes.length === 1 ? "" : "s"} (preserved: ${preservedNotes.join(", ") || "none — pure template"}); rollback at ${tarPath}`,
  );
  logger.info("SOUL V2 migration applied", {
    route: "vm-reconcile",
    vmId: vm.id,
    mode,
    preserved: preservedNotes,
    filesWritten: writes.map((w) => w.name),
    tarPath,
  });
}

async function stepDeployPrivacyBridge(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  if (vm.partner !== "edge_city") return;

  // ── ONE-SHOT bridge deploy ──
  // The vm-354 lockout (2026-05-13) was caused by issuing the bridge
  // update as SEPARATE ssh.execCommand calls. Each separate SSH session
  // re-traverses the bridge wrapper (post-cutover) and the stage-1
  // self-integrity check sees the briefly-unlocked state and
  // panic-blocks every operator SSH thereafter.
  //
  // Fix: delegate to deployPrivacyBridge() which issues the whole
  // sequence (backup → unlock → write tmp → SHA-verify tmp → atomic mv
  // → chattr +i retry → rollback to OLD bridge on chattr failure) as
  // ONE ssh.execCommand. The unlock-then-lock window still exists but
  // is bounded to a single bash process — no other SSH session can
  // race.
  //
  // Limitation (documented in privacy-bridge.sh threat model): the
  // openclaw user has (ALL) NOPASSWD: ALL in sudoers so an agent CAN
  // `sudo chattr -i` and defeat this. v0 ships as defense-in-depth +
  // detectable sudo trail; v1 follow-up is restricted sudoers.

  const script = getPrivacyBridgeScript();
  const r = await deployPrivacyBridge(ssh, script, { dryRun });

  switch (r.status) {
    case "already_correct":
      result.alreadyCorrect.push("privacy-bridge.sh");
      return;

    case "deployed":
      if (dryRun) {
        result.fixed.push(`[dry-run] would deploy privacy-bridge.sh + chattr +i`);
      } else {
        result.fixed.push(`privacy-bridge.sh deployed + chattr +i locked (sha=${r.finalSha?.slice(0, 12)})`);
        logger.info("privacy-bridge deployed and locked", {
          route: "vm-reconcile",
          vmId: vm.id,
          sha: r.finalSha,
        });
      }
      return;

    case "chattr_failed_rolled_back":
      // Rollback succeeded — OLD bridge is back in place + chattr +i.
      // Bridge content is stale but bridge IS functional. Next tick
      // will retry the new deploy.
      result.errors.push(
        `privacy-bridge chattr +i failed during deploy; rolled back to old bridge (sha=${r.finalSha?.slice(0, 12)}). Will retry next tick.`
      );
      logger.error("privacy-bridge deploy chattr+i failed (rolled back)", {
        route: "vm-reconcile",
        vmId: vm.id,
        oldSha: r.finalSha,
        expectedSha: r.expectedSha,
      });
      return;

    case "chattr_failed_no_backup":
      // No backup existed (first deploy) AND chattr +i failed. Bridge
      // is at canonical path with NEW content but NO +i. On a cutover
      // VM this is LOCKOUT — operator must use bypass key to recover.
      // On a non-cutover VM this is harmless (deploy keys still work).
      result.errors.push(
        `privacy-bridge chattr +i failed twice with no backup — bridge file unlocked. If this VM is cutover, bypass-key recovery is required.`
      );
      logger.error("privacy-bridge deploy chattr+i failed (NO BACKUP)", {
        route: "vm-reconcile",
        vmId: vm.id,
        finalSha: r.finalSha,
        finalAttrs: r.finalAttrs,
      });
      return;

    case "sha_mismatch_pre_swap":
      // Caught BEFORE the mv. Bridge is unchanged (still has old
      // content); safe to retry next tick.
      result.errors.push(
        `privacy-bridge tmp SHA mismatch (caught pre-swap, bridge unchanged): expected=${r.expectedSha.slice(0, 12)} actual=${r.finalSha?.slice(0, 12) ?? "?"}`
      );
      return;

    case "mkdir_failed":
    case "write_failed":
    case "mv_failed":
    case "chmod_failed":
    case "unlock_failed":
      // Pre-swap failures — bridge file unchanged.
      result.errors.push(`privacy-bridge ${r.status}: ${r.error ?? "(no detail)"}`);
      return;

    default:
      // exec_failed / unknown / paradox cases
      result.errors.push(`privacy-bridge ${r.status}: ${r.error ?? "(no detail)"}`);
      return;
  }
}

/**
 * stepRewriteSoulPartnerSections — v92 surgical SOUL.md migration.
 *
 * Replaces the pre-v92 long Edge / Consensus sections in SOUL.md with the
 * v92 stubs (defined in lib/partner-content.ts). Mirror of v67 routing
 * patch shape: Python in-place edit, marker-based idempotency, tmp+rename
 * atomic write, post-write verify, errors push to result.errors so the
 * pushFailed gate refuses to bump config_version.
 *
 * Why this exists: manifest's file entries for SOUL.md are all
 * append_if_marker_absent / insert_before_marker. None can REPLACE existing
 * content. Pre-v92 SOUL.md on production edge_city VMs has the long sections
 * that need to be rewritten in place. configureOpenClaw at fresh provision
 * already uses the v92 stubs (lib/ssh.ts) — this step heals existing VMs.
 *
 * Backup: writes pre-rewrite SOUL.md to ~/.openclaw/backups/v92-<ts>/SOUL.md
 * BEFORE any modification, per CLAUDE.md Rule 22.
 */
async function stepRewriteSoulPartnerSections(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Only run on partner-tagged VMs. Other VMs have no Edge/Consensus
  // sections in their SOUL.md so the rewrite would be a no-op anyway,
  // but we'd still pay the SSH round-trip cost. Short-circuit.
  if (vm.partner !== "edge_city" && vm.partner !== "consensus_2026") {
    return;
  }

  const applyEdge = vm.partner === "edge_city";
  const applyConsensus = vm.partner === "edge_city" || vm.partner === "consensus_2026";

  if (dryRun) {
    result.fixed.push(
      `[dry-run] v92 SOUL partner stub rewrite (apply_edge=${applyEdge} apply_consensus=${applyConsensus})`,
    );
    return;
  }

  // Python script: read SOUL.md, back up, replace section(s), atomic write,
  // verify markers present, report status as JSON to stdout.
  // Inline rather than via getTemplateContent to keep the Python self-
  // contained — no external file deps, no template engine surprises.
  const PATCH_PY = `import json, os, re, sys

cfg = json.loads(sys.stdin.read())
path = os.path.expanduser(cfg["soul_path"])

def out(d):
    print(json.dumps(d))
    sys.exit(0)

if not os.path.exists(path):
    out({"status": "missing"})

with open(path) as f:
    content = f.read()
original = content

# Rule 22 backup BEFORE any modification.
if cfg.get("backup_path"):
    bp = os.path.expanduser(cfg["backup_path"])
    os.makedirs(os.path.dirname(bp), exist_ok=True)
    with open(bp, "w") as f:
        f.write(original)

def replace_or_append_section(text, old_header, new_section, new_marker):
    """Replace a \`## old_header\` block with new_section, OR append new_section
    if no such block exists.

    Section detection: from "## old_header" through the next "## " heading or
    EOF. Idempotent: if new_marker is already in text, no-op (already-patched).

    v93 (2026-05-11): when old_header is NOT present, APPEND new_section at
    EOF. Partner sections are auto-installed by configureOpenClaw — if the
    header is absent, it's because the VM was configured BEFORE the section
    existed in the template, OR a configure failure left it out. Either way
    we want to add the section. This differs from the v67 routing-patch
    pattern, where old-not-found indicated user customization and we left
    it alone.
    """
    if new_marker in text:
        return text, "already-patched"
    pat = re.compile(r'^## ' + re.escape(old_header) + r'\\s*$', re.MULTILINE)
    m = pat.search(text)
    if not m:
        # v93: append at EOF. The new_section already starts with "\\n\\n##" so
        # spacing is preserved. Strip any trailing whitespace from text first
        # to avoid double-blank-line drift across repeated migrations.
        return text.rstrip() + new_section, "appended"
    start = m.start()
    after = text[m.end():]
    nxt = re.search(r'^## ', after, re.MULTILINE)
    end = m.end() + nxt.start() if nxt else len(text)
    return text[:start] + new_section + text[end:], "patched"

# Backwards-compatible alias used by the call sites below.
replace_section = replace_or_append_section

edge_status = "skipped"
if cfg["apply_edge"]:
    content, edge_status = replace_section(
        content, "Edge Esmeralda 2026",
        cfg["edge_stub"], cfg["edge_marker"],
    )

cons_status = "skipped"
if cfg["apply_consensus"]:
    content, cons_status = replace_section(
        content, "Consensus 2026 Miami",
        cfg["consensus_stub"], cfg["consensus_marker"],
    )

# Atomic write only if changed.
if content != original:
    tmp = path + ".v92patch.tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.rename(tmp, path)

# Verify markers post-write — both "patched" and "appended" should leave
# the marker in the final file. "already-patched" already had it (no write
# performed). Only "skipped" doesn't check.
with open(path) as f:
    final = f.read()
edge_should_have_marker = cfg["apply_edge"] and edge_status in ("patched", "appended")
cons_should_have_marker = cfg["apply_consensus"] and cons_status in ("patched", "appended")
if edge_should_have_marker and cfg["edge_marker"] not in final:
    out({"status": "verify-failed-edge", "edge": edge_status, "consensus": cons_status})
if cons_should_have_marker and cfg["consensus_marker"] not in final:
    out({"status": "verify-failed-consensus", "edge": edge_status, "consensus": cons_status})

out({
    "status": "ok",
    "edge": edge_status,
    "consensus": cons_status,
    "size_bytes": len(final),
    "over_budget": len(final) > cfg.get("budget", 40000),
})
`;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  // Reads BOOTSTRAP_MAX_CHARS from manifest so the over-budget warning
  // stays accurate after future budget bumps (emergency bumped 35K→40K
  // on 2026-05-11 — see commit 0f796218).
  const cfg = JSON.stringify({
    soul_path: "~/.openclaw/workspace/SOUL.md",
    backup_path: `~/.openclaw/backups/v93-${ts}/SOUL.md`,
    apply_edge: applyEdge,
    apply_consensus: applyConsensus,
    edge_stub: SOUL_STUB_EDGE,
    consensus_stub: SOUL_STUB_CONSENSUS,
    edge_marker: SOUL_STUB_EDGE_MARKER,
    consensus_marker: SOUL_STUB_CONSENSUS_MARKER,
    budget: VM_MANIFEST.configSettings["agents.defaults.bootstrapMaxChars"]
      ? parseInt(VM_MANIFEST.configSettings["agents.defaults.bootstrapMaxChars"] as string, 10)
      : 40000,
  });
  const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
  const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
  const cmd = `echo '${cfgB64}' | base64 -d | python3 <(echo '${scriptB64}' | base64 -d)`;

  const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30_000 } });
  if (r.code !== 0) {
    result.errors.push(
      `v92-partner-stub-rewrite python failed rc=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`,
    );
    return;
  }

  // Parse the JSON status line (last non-empty line of stdout).
  const lines = (r.stdout || "").split("\n").map((l: string) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  let parsed: {
    status?: string;
    edge?: string;
    consensus?: string;
    size_bytes?: number;
    over_budget?: boolean;
  } = {};
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    result.errors.push(
      `v92-partner-stub-rewrite: could not parse python output: ${lastLine.slice(0, 200)}`,
    );
    return;
  }

  if (parsed.status === "missing") {
    result.errors.push(
      "v92-partner-stub-rewrite: SOUL.md missing — configureOpenClaw should have created it",
    );
    return;
  }
  if (parsed.status?.startsWith("verify-failed")) {
    result.errors.push(
      `v92-partner-stub-rewrite: ${parsed.status} (edge=${parsed.edge} consensus=${parsed.consensus})`,
    );
    return;
  }
  if (parsed.status !== "ok") {
    result.errors.push(
      `v92-partner-stub-rewrite: unexpected status=${parsed.status}`,
    );
    return;
  }

  // Result-state semantics:
  //   "already-patched" — marker present, no-op (idempotent)
  //   "patched"         — old section found, replaced with stub
  //   "appended"        — section was missing, stub appended at EOF (v93)
  //   "old-not-found"   — should never appear with v93 logic (would only
  //                       fire if the marker logic ever changes), kept as
  //                       a safety state for forward compatibility
  //   "skipped"         — gate didn't apply (e.g., apply_edge=False)
  const okStates = new Set(["patched", "already-patched", "appended", "old-not-found", "skipped"]);
  const edge = parsed.edge ?? "?";
  const consensus = parsed.consensus ?? "?";
  if (!okStates.has(edge) || !okStates.has(consensus)) {
    result.errors.push(`v92-partner-stub-rewrite: unexpected edge=${edge} consensus=${consensus}`);
    return;
  }

  const didWork = ["patched", "appended"].includes(edge) || ["patched", "appended"].includes(consensus);
  if (didWork) {
    result.fixed.push(
      `v92-partner-stub-rewrite (edge=${edge} consensus=${consensus} size=${parsed.size_bytes})`,
    );
    logger.info("v92 partner stub rewrite applied", {
      route: "vm-reconcile",
      vmId: vm.id,
      edge,
      consensus,
      sizeBytes: parsed.size_bytes,
      overBudget: parsed.over_budget,
    });
  } else {
    result.alreadyCorrect.push(
      `v92-partner-stub-rewrite (edge=${edge} consensus=${consensus} size=${parsed.size_bytes})`,
    );
  }

  // Loud signal if we're still over budget — should never happen with v92
  // stubs, but logging it makes the regression caught instantly.
  if (parsed.over_budget) {
    logger.warn("SOUL.md over BOOTSTRAP_MAX_CHARS after v92 patch", {
      route: "vm-reconcile",
      vmId: vm.id,
      sizeBytes: parsed.size_bytes,
    });
  }
}

/**
 * stepDeployEdgeOverlay — write INSTACLAW_OVERLAY.md to the cloned
 * edge-esmeralda skill directory on edge_city VMs.
 *
 * Additive to Tule's upstream SKILL.md (we deliberately don't modify
 * his content). Tule's 30-min cron does `git pull --ff-only`; the
 * overlay file is untracked from upstream so the cron leaves it alone.
 *
 * SHA-verified deploy. Idempotent skip on match. Same shape as
 * stepDeployPrivacyBridge.
 */
async function stepDeployEdgeOverlay(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  if (vm.partner !== "edge_city") return;

  const remotePath = "/home/openclaw/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md";
  const expectedSha = crypto
    .createHash("sha256")
    .update(EDGE_INSTACLAW_OVERLAY_MD)
    .digest("hex");

  // Pre-check: skill dir must exist. If not, the edge-esmeralda clone failed
  // upstream — we'd push to errors so the gateway-restart gate refuses to
  // declare the VM healthy.
  const dirCheck = await ssh.execCommand(
    `[ -d /home/openclaw/.openclaw/skills/edge-esmeralda ] && echo OK || echo MISSING`,
  );
  if ((dirCheck.stdout || "").trim() !== "OK") {
    // Rule 39: skill-clone-missing is a partner-specific feature gap, not a
    // critical fault. The gateway works fine without the overlay; the user
    // just doesn't get the Edge onboarding interview prompts. Reclassify
    // from errors to warnings so cv bump isn't held for an upstream
    // skill-clone-auth failure (Rule 42 covers the long-term fix).
    result.warnings.push(
      "edge-overlay-deploy: ~/.openclaw/skills/edge-esmeralda/ does not exist — skill clone may have failed (private repo auth?)",
    );
    return;
  }

  const existing = await ssh.execCommand(
    `[ -f ${remotePath} ] && sha256sum ${remotePath} | awk '{print $1}' || echo MISSING`,
  );
  const onDiskSha = (existing.stdout || "").trim();

  if (onDiskSha === expectedSha) {
    result.alreadyCorrect.push("INSTACLAW_OVERLAY.md");
    return;
  }

  if (dryRun) {
    result.fixed.push(
      `[dry-run] would deploy INSTACLAW_OVERLAY.md (current=${onDiskSha.slice(0, 8)})`,
    );
    return;
  }

  const b64 = Buffer.from(EDGE_INSTACLAW_OVERLAY_MD, "utf-8").toString("base64");
  const write = await ssh.execCommand(
    `echo '${b64}' | base64 -d > ${remotePath}.tmp && mv ${remotePath}.tmp ${remotePath} && chmod 0644 ${remotePath}`,
  );
  if (write.code !== 0) {
    result.errors.push(
      `INSTACLAW_OVERLAY.md write failed: ${(write.stderr || write.stdout).slice(0, 200)}`,
    );
    return;
  }

  // Verify (Rule 10): re-read sha and compare.
  const verify = await ssh.execCommand(`sha256sum ${remotePath} | awk '{print $1}'`);
  const verifySha = (verify.stdout || "").trim();
  if (verifySha !== expectedSha) {
    result.errors.push(
      `INSTACLAW_OVERLAY.md verify mismatch: expected=${expectedSha.slice(0, 12)} got=${verifySha.slice(0, 12)}`,
    );
    return;
  }

  result.fixed.push("INSTACLAW_OVERLAY.md deployed");
  logger.info("INSTACLAW_OVERLAY.md deployed", { route: "vm-reconcile", vmId: vm.id });
}
