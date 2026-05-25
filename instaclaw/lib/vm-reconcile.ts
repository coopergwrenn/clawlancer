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
import { connectSSH, NVM_PREAMBLE, BANKR_CLI_PINNED_VERSION, AGENTKIT_CLI_PINNED_VERSION, BANKR_SKILL_PATCH_MARKER, BANKR_SKILL_PATCH_DIRECTIVE, OPENCLAW_PINNED_VERSION, NODE_PINNED_VERSION, PRCTL_SUBREAPER_PINNED_VERSION, toOpenClawModel, setupXMTP, WORKSPACE_BOOTSTRAP_SHORT, type VMRecord } from "./ssh";
import {
  INSTALL_GBRAIN_SH,
  VERIFY_GBRAIN_MCP_PY,
  PGLITE_CHECKPOINT_SH,
  GBRAIN_CHECKPOINT_PATCH,
} from "./gbrain-scripts-content";
import { sendAdminAlertEmail } from "./email";
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
  GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK,
  GBRAIN_SOUL_ROUTING_V1_SECTION,
  GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER,
  GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS,
  GBRAIN_SOUL_ROUTING_V1_REQUIRED_SENTINELS,
  GBRAIN_SOUL_ROUTING_V1_START_ANCHOR,
  GBRAIN_SOUL_ROUTING_V1_END_ANCHOR,
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
import { decryptSecret, DecryptError, KeyMissingError } from "./openai-oauth-encryption";
import { TIER_DISPLAY_LIMITS } from "./credit-constants";
import { wrapSSHForEnospcDetection, isEnospcDetectedError } from "./enospc-guard";
import {
  callIndexSignup,
  // 2026-05-23 helper: re-fetches SimpleFi /citizens at signup time and
  // composes a name/bio/socials-enriched body. Shared with JIT path
  // (lib/index-jit-provision.ts). Both paths produce identical Index
  // Network users regardless of which fires first.
  // (Import inserted via the index-network-client block below.)
  buildIndexMcpConfig,
  getIndexEnv,
  IndexSignupError,
} from "./index-network-client";
import { buildEnrichedSignupBody } from "./index-signup-enrich";
import { mintOrReuseApiKey } from "./edgeos-mint";
import { EDGEOS_TENANT_EDGECITY_PROD } from "./edgeos-auth";
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
  // v120 (2026-05-24): agents.defaults.* keys are closure-captured at
  // agent-run init — verified empirically on vm-1019 (typingMode +
  // typingIntervalSeconds set via `openclaw config set`, journal showed
  // "[reload] config change detected" but never "[reload] config hot
  // reload applied" for these keys; openclaw CLI confirmed with "Restart
  // the gateway to apply"). Without this prefix, stepConfigSettings writes
  // the new value to openclaw.json but never triggers the restart that
  // makes the agent runtime pick it up — fleet would silently fail to
  // apply typing UX changes until each VM was naturally restarted
  // (could be days). See CLAUDE.md Rule 32 + Rule 65.
  "agents.defaults.",
];

function keyRequiresGatewayRestart(key: string): boolean {
  return RESTART_REQUIRED_CONFIG_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ── gbrain (Phase 4c) install pinning ──
//
// gbrain is Garry Tan's per-VM PGLite knowledge graph. As of 2026-05-16,
// we install it as an HTTP sidecar (persistent systemd --user service bound
// to loopback 127.0.0.1:3131, OpenClaw connects via streamable-http
// transport + Bearer auth) per CLAUDE.md Rule 35.
//
// The HTTP sidecar replaces the stdio architecture for fleet-wide install.
// vm-050 canary (2026-05-15) proved 564ms tool latency vs the 90+ second
// cold-start that killed sessions on the stdio era.
//
// Phase 4c puts the install inside the reconciler — once GBRAIN_INSTALL_ENABLED
// is flipped on in Vercel env, every allowlisted-partner VM that surfaces in
// the reconcile-fleet candidate query gets the HTTP sidecar installed.
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
//    edge_city VMs are at cv=100 today (= current manifest), but the cron
//    candidate query OR-s secret_version<SECRET_VERSION which we can bump
//    to trigger re-reconciliation if needed (or wait for the next natural
//    manifest bump).
//
// PRDs:
//   - docs/prd/gbrain-fleet-rollout-2026-05-12.md §7 (original stepGbrain design)
//   - docs/prd/gbrain-http-fleet-rewrite-plan-2026-05-16.md (HTTP rewrite plan)
// Exported as of v106 so configureOpenClaw (lib/ssh.ts) can use the SAME
// allowlist when deciding whether to inject the gbrain SOUL routing block
// at fresh-VM assignment time. Single source of truth; future partner
// additions (consensus_2026, eclipse, etc.) flow to both surfaces at once.
export const GBRAIN_PARTNER_ALLOWLIST: ReadonlySet<string> = new Set(["edge_city"]);

/**
 * v107 canary-rollout gating helper.
 *
 * Three-state semantics on `instaclaw_vms.gbrain_enabled`:
 *   - true  → explicitly enable (canary cohort or post-canary opt-in)
 *   - false → explicitly disable (rollback hatch for VMs with known issues)
 *   - NULL  → follow partner allowlist (pre-v107 behavior preserved)
 *
 * Used by stepGbrain, stepDeployGbrainSoulProtocol,
 * stepDeployGbrainSoulRouting, and configureOpenClaw's conditional inject.
 * Single source of truth — when the canary expands to fleet-wide, only
 * this function (and the DB column values) need to change.
 *
 * PRD: docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md.
 */
export function isGbrainEligibleForVM(
  vm: { partner?: string | null; gbrain_enabled?: boolean | null },
): boolean {
  // Explicit overrides take precedence over partner-allowlist default.
  if (vm.gbrain_enabled === false) return false; // explicit disable (rollback hatch)
  if (vm.gbrain_enabled === true) return true; // explicit enable (canary cohort)
  // NULL → fall back to partner allowlist (current behavior preserved)
  return Boolean(vm.partner && GBRAIN_PARTNER_ALLOWLIST.has(vm.partner));
}
// HTTP sidecar architecture. Pin to a specific commit per Rule 35;
// operator manually bumps after canary validation when newer version is desired.
// History: stdio v0.28.1 (2ea5b71) → HTTP v0.35.0.0 (baf1a47) → v0.36.3.0 (1d5f69f).
// 2026-05-19: bumped to v0.36.3.0 after vm-050 in-place-upgrade canary.
// v0.36.x requires GBRAIN_EMBEDDING_DIMENSIONS=1536 env var alongside the existing
// GBRAIN_EMBEDDING_MODEL — install-gbrain.sh Phase E5 (fresh) + Phase J (upgrade)
// both write the env. Without it, gateway.ts falls back to 1280-dim ZE default.
const GBRAIN_PINNED_COMMIT = "1d5f69f";
const GBRAIN_PINNED_VERSION = "0.36.3.0";
// 240s leaves ~60s headroom under reconcile-fleet's Vercel maxDuration=300s
// for the rest of reconcileVM. Normal install (bun already present): ~70s.
// Cold install (bun not present): ~165s. Both fit comfortably.
// HTTP sidecar adds ~5s for systemd unit deploy + verify (negligible).
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
//
// v1 (2026-05-14): initial baseline + EDGEOS_BEARER_TOKEN rotation.
// v2 (2026-05-15): BRAVE_API_KEY enrollment (SECRET_ENV_VAR_SOURCES new
//                  entry via vercelKey: Vercel-side BRAVE_SEARCH_API_KEY →
//                  VM-side BRAVE_API_KEY). Universal — every VM gets it.
// v3 (2026-05-21): GBRAIN_ANTHROPIC_API_KEY rotation in Vercel. Cooper
//                  set a new Anthropic project key for gbrain. The OLD
//                  key was still valid (both keys returned HTTP 200 from
//                  Anthropic at rotation time) but gbrain on edge_city
//                  VMs was running with the OLD value baked into its
//                  systemd unit's Environment=ANTHROPIC_API_KEY= at
//                  install time. The new stepGbrainEnvSync (added in
//                  this commit) detects drift between .env (refreshed
//                  by stepEnvVarPush) and the systemd unit, then sed-
//                  syncs the unit + restarts gbrain so the rotated key
//                  actually reaches the gbrain process. Manual fleet-
//                  push on 2026-05-21 ~23:55 UTC handled today's
//                  rotation (9 edge_city VMs); this bump ensures the
//                  reconciler propagates the same change to any VM that
//                  comes online from a snapshot baked before the
//                  rotation.
// v4 (2026-05-22): OPENAI_API_KEY enrollment (SECRET_ENV_VAR_SOURCES new
//                  entry — universal, no partnerGate). The bake-VM-3
//                  install today surfaced FATAL_NO_OPENAI_KEY because
//                  install-gbrain.sh Phase A4 reads OPENAI_API_KEY from
//                  ~/.openclaw/.env but no reconciler step was writing
//                  it. Snapshot terminal had to manually SSH push the
//                  key to unblock the bake. Enrolling in stepEnvVarPush
//                  closes the structural gap: every VM gets the key on
//                  the next reconcile tick. Combined with v3's
//                  GBRAIN_ANTHROPIC_API_KEY distribution, the third
//                  bake runs zero-manual-intervention. See companion
//                  scripts/install-gbrain.sh Phase G8 budget extension
//                  (commit 9201a3fc) + EnvironmentFile architecture
//                  (commit c9d3c5b1) for the full "clean 3rd bake"
//                  trio.
export const SECRET_VERSION = 4;

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
  // Rule 37: wrap SSH for ENOSPC detection. file-drift writes via putFile +
  // execCommand, both of which can hit ENOSPC on a disk-full VM; the wrapper
  // pushes a P0 to result.errors and fires the deduped alert. The single
  // stepFiles call below catches the sentinel so we return cleanly.
  const wrappedSsh = wrapSSHForEnospcDetection(ssh, vm, result);

  // Rule 38: also run stepDiskGuard here. Without this, caught-up VMs (those
  // at cv == VM_MANIFEST.version) are excluded from the reconcile-fleet
  // cron's filter and never get the unconditional .tmp cleanup. file-drift
  // already runs continuously on a random sample of healthy+assigned VMs
  // regardless of cv, so it's the natural place to hang the disk maintenance
  // for the caught-up cohort. stepDiskGuard is cheap on healthy disks
  // (one df probe + one find -delete + one DB write; ~100ms total) and
  // surfaces disk-pressure warnings/errors that would otherwise stay
  // invisible until a customer hits ENOSPC.
  try {
    await stepDiskGuard(wrappedSsh, vm, result, dryRun);
    await stepFiles(wrappedSsh, vm, VM_MANIFEST, result, dryRun);
  } catch (err) {
    if (isEnospcDetectedError(err)) {
      logger.error("runFileDriftPass: short-circuited on ENOSPC", {
        route: "runFileDriftPass",
        vmId: vm.id,
        enospcPath: err.detail.path,
      });
      // result.errors already contains the wrapper's P0 entry — caller's
      // route handler decides how to surface it (file-drift cron currently
      // logs `drifted` counts).
    } else {
      throw err;
    }
  }
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

  const rawSsh = await connectSSH(vm);
  // ── Rule 37: ENOSPC detection wrapper ──
  // Wrap once here; every step* receives the wrapped instance via the `ssh`
  // local. On any ENOSPC observed in execCommand/putFile output, the wrapper
  // pushes a P0 entry to result.errors, fires a 6h-deduped admin alert, and
  // throws EnospcDetectedError to short-circuit the reconcile. The catch
  // handler below treats the sentinel as a controlled stop, not an error,
  // and lets the pushFailed gate (cron route) hold cv. See lib/enospc-guard.ts.
  const ssh = wrapSSHForEnospcDetection(rawSsh, vm, result);

  // ── Strict-mode outer deadline ──
  // Budget the ENTIRE reconcile (all steps including canary) at 180s when
  // strict: true. Without this, pathological VMs (stuck openclaw CLI, slow
  // SSH) can burn the full Vercel 300s budget on a single VM and stall the
  // whole cron batch. Implemented via Promise.race — accept the limitation
  // that in-flight SSH commands may complete after the deadline (see
  // phase-2c-v2-todo.md for signal-threaded cancellation).
  //
  // Env override: STRICT_DEADLINE_MS_OVERRIDE. Default 180_000 (3 min) is
  // sized for Vercel cron's 300s function maxDuration with ~120s headroom
  // for the cron's pre/post work. Long-running operators (snapshot bake's
  // reconcile-run-audit step at lib/bake/steps.ts:445) set the override
  // to ~45 min because the bake VM provisions fresh from an N-version-old
  // snapshot — multi-version drift catch-up can take 8+ minutes legitimately
  // (every cv-bump iteration past Vercel's 300s budget is the Rule 44
  // "strict-deadline ≠ failure" symptom). The bake's local Node process
  // has no Vercel timeout pressure, so a higher cap is safe there.
  // Bumped 2026-05-25 after the v2026.4.26→v120 bake failed at 180s on
  // step=config-settings (cv=113 source → cv=120 target = 8 manifest versions
  // of drift, well beyond the cron-tick budget).
  const STRICT_DEADLINE_MS = Number(process.env.STRICT_DEADLINE_MS_OVERRIDE) || 180_000;
  // Warn at 83% of deadline — same ratio as the original 150/180 (= 0.833).
  // Keeps the "approaching deadline" warning useful at any override value.
  const STRICT_WARN_AT_MS = Math.floor(STRICT_DEADLINE_MS * 5 / 6);
  let currentStep: string = "init";
  const warnTimer = strict
    ? setTimeout(() => {
        logger.warn(`reconcileVM: approaching ${STRICT_DEADLINE_MS}ms strict deadline`, {
          route: "reconcileVM",
          vmId: vm.id,
          currentStep,
          elapsedMs: STRICT_WARN_AT_MS,
          deadlineMs: STRICT_DEADLINE_MS,
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

    // ── Step 1b': gbrain systemd Environment sync (key rotation) ──
    // 2026-05-21 (SECRET_VERSION v3): GBRAIN_ANTHROPIC_API_KEY rotation
    // exposed a gap. stepEnvVarPush updates ~/.openclaw/.env, but gbrain
    // doesn't read from .env at runtime — it reads from systemd's
    // `Environment=ANTHROPIC_API_KEY=` (the unit value is baked in once
    // at install-gbrain.sh time and never re-derived). So a rotated key
    // landed in .env but gbrain kept using the OLD value indefinitely.
    //
    // stepGbrainEnvSync detects drift between .env (just refreshed by
    // stepEnvVarPush above) and the gbrain systemd unit's Environment=
    // ANTHROPIC_API_KEY= line, then sed-syncs the unit and restarts
    // gbrain so the new key actually reaches the gbrain process. Partner-
    // gated to edge_city + skip-if-gbrain-not-installed (cheap probe).
    // Idempotent (no-op when in sync, ~1 SSH call). Restart uses gbrain's
    // KillSignal=SIGKILL drop-in to avoid PGLite corruption (Rule 54).
    currentStep = "gbrain-env-sync";
    await stepGbrainEnvSync(ssh, vm, result, dryRun);

    // ── Step 1c: gbrain install (partner-gated, env-flag-gated) ──
    // Phase 4c of gbrain fleet rollout. Auto-installs gbrain (PGLite KG +
    // stdio MCP) on allowlisted-partner VMs ONCE the GBRAIN_INSTALL_ENABLED
    // env var is flipped on in Vercel (default off — code can ship without
    // firing). Cheap idempotency check makes the steady state ~2s per
    // already-gbrained VM.
    // PRD: docs/prd/gbrain-fleet-rollout-2026-05-12.md §7.
    currentStep = "gbrain";
    await stepGbrain(ssh, vm, result, dryRun, strict);

    // ── Step 1d: Index Network provisioning (partner=edge_city only) ──
    // Adjacent to gbrain because both are partner-gated MCP-side-effects on
    // the agent runtime. Warnings-only on failure per Rule 39 — Index is
    // optional and a 4xx/5xx must not block cv-bump. Per Yanek's idempotency
    // contract, signup rotates the apiKey on every call, so this step
    // short-circuits hard on local-cache presence (instaclaw_vms.index_api_key).
    // PRD: docs/prd/village-index-network-integration.md §7.
    currentStep = "index";
    await stepIndexProvision(ssh, vm, result, dryRun, strict);

    // ── Step 1e: EdgeOS API key provisioning (partner=edge_city only) ──
    // Sibling to stepIndexProvision — partner-gated, mints a per-VM
    // eos_live_* key for the Edge Esmeralda 2026 calendar (events:read).
    // EdgeOS shows secrets once at create time, so we persist to DB
    // (instaclaw_vms.edgeos_api_key) and deploy to ~/.openclaw/.env on
    // every reconcile (Rule 58 cross-consumer match). Warnings-only on
    // failure per Rule 39 — calendar reads degrade gracefully; the
    // attendee directory remains reachable via the shared
    // EDGEOS_BEARER_TOKEN regardless. PRD: D3 in
    // docs/prd/edge-esmeralda-master-prd-2026-05-19.md.
    currentStep = "edgeos-api-key";
    await stepEdgeOSApiKey(ssh, vm, result, dryRun, strict);

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

    // ── Step 2b.1: Telegram bot description (pool-path coverage gap fix) ──
    // setup.sh §1.34 only runs on cloud-init VMs; pool VMs never get the
    // bot description set without this step. Runs AFTER stepBootstrapConsumed
    // so .bootstrap_consumed existence drives which description to use.
    currentStep = "telegram-bot-description";
    await stepTelegramBotDescription(ssh, vm as { id: string; channels_enabled?: string[] | null }, result, dryRun);

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

    // ── Step 3c.5 (v112): pi-ai reasoning-router patch ──
    // Idempotently patches pi-ai's openai-codex-responses.js to call into the
    // reasoning router (deployed to ~/.openclaw/scripts/reasoning-router.js
    // by stepFiles) when options.reasoningEffort is undefined. MUST run after
    // stepNpmPinDrift because that step can re-install OpenClaw, which
    // overwrites the patched dist file inside node_modules. Idempotent via
    // INSTACLAW_REASONING_ROUTER_V1 sentinel — skips when present.
    currentStep = "pi-ai-reasoning-router-patch";
    await stepPiAiReasoningPatch(ssh, result, dryRun);

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

    // ── Step 8a: ChatGPT OAuth token sync (Day 11-15) ──
    // Reflects each user's ChatGPT subscription state from instaclaw_users
    // → VM's auth-profiles.json + agents.defaults.model.primary. Runs AFTER
    // stepAuthProfiles so the merge-preserving rebuild from that step (Day
    // 2.5 audit fix) doesn't wipe our openai-codex:default entry on the
    // same cycle. See stepChatGPTOAuthToken header for the full flow.
    currentStep = "chatgpt-oauth-token";
    await stepChatGPTOAuthToken(ssh, vm, result, dryRun);

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

    // ── v102: gbrain memory protocol canonicalization ──
    // Inserts GBRAIN_MEMORY_PROTOCOL_V1 block before "## Memory Protocol"
    // in AGENTS.md, gated on gbrain.service active. Idempotent via marker.
    // Source: workspace-templates-v2.GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK.
    // Why: vm-050 had the gbrain protocol from a manual ops script; the
    // other 7 edge_city VMs had ZERO instructions despite having gbrain
    // installed. This step closes that gap fleet-wide.
    currentStep = "gbrain-soul-protocol";
    await stepDeployGbrainSoulProtocol(ssh, vm, result, dryRun);

    // ── v106: gbrain SOUL.md routing canonicalization ──
    // Replaces the legacy MEMORY.md-first `## Memory Persistence (CRITICAL)`
    // section in SOUL.md with the gbrain-first GBRAIN_SOUL_ROUTING_V1 marker-
    // bounded block. Mirrors stepDeployGbrainSoulProtocol's gating + Python
    // pattern but targets SOUL.md (not AGENTS.md) and uses REPLACE (not
    // INSERT) since the two versions occupy the same logical role —
    // coexistence would create contradictory routing for the agent.
    //
    // Triple gate (defense in depth):
    //   - vm.partner ∈ GBRAIN_PARTNER_ALLOWLIST (covers VM-reassignment edge case)
    //   - gbrain.service active (matches stepDeployGbrainSoulProtocol)
    //   - GBRAIN_INSTALL_ENABLED env var === "true"
    //
    // Drift-check: sha256 of the on-disk section must match a known-OK sha
    // (vanilla MEMORY.md-first or vm-050 hand-deploy). Anything else → SKIP
    // + P1 admin alert (6h dedup). See PRD gbrain-soul-routing-3-surface-
    // analysis-2026-05-19.md.
    currentStep = "gbrain-soul-routing";
    await stepDeployGbrainSoulRouting(ssh, vm, result, dryRun);

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

    // Step 8i2: External-skill heal — bankr overlay + clanker/base
    // subdir delete + consensus-2026 clone + cron + (edge_city)
    // edge-esmeralda clone + cron. Fleet-heal counterpart to cloud-
    // init BE-5 (commit 5612bddf). Bankr overlay is missing on every
    // existing fleet VM today; this step heals on next cron tick.
    currentStep = "heal-external-skills";
    await stepExternalSkillHeal(ssh, vm, result, dryRun);

    currentStep = "heal-gateway-watchdog";
    await stepGatewayWatchdogTimer(ssh, result, dryRun, strict, isPausedState);

    currentStep = "heal-dispatch-server";
    await stepDispatchServer(ssh, vm, result, dryRun, strict, isPausedState);

    currentStep = "heal-instaclaw-xmtp";
    await stepInstaclawXmtp(ssh, vm, result, dryRun, strict, isPausedState);

    currentStep = "heal-node-exporter";
    await stepNodeExporter(ssh, result, dryRun, strict, isPausedState);

    // ── Step 8m2: ufw allow 9100/tcp ──
    // Companion to stepNodeExporter — guarantees Prometheus on the monitoring
    // VM can actually reach the listener. The 2026-05-18 IR incident found 8
    // VMs whose node_exporter was healthy but firewalled at 9100 for 1-4 days;
    // stepNodeExporter verified the LOCAL bind but never EXTERNAL reachability.
    // Per Rule 57. Idempotent + sentinel-guarded; failures are warnings (Rule 39).
    currentStep = "heal-ufw-rules";
    await stepUfwRules(ssh, result, dryRun);

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
    } else if (isEnospcDetectedError(err)) {
      // Rule 37 short-circuit — the wrapper already pushed the P0 error
      // entry and fired the admin alert. Treat this exactly like a clean
      // stop: don't re-throw, let pushFailed gate (cron route:486) hold
      // cv-bump on the result.errors entry the wrapper queued. The customer's
      // running gateway is unaffected (in-memory config snapshot survives);
      // the next cron tick will re-evaluate after stepDiskGuard (Rule 46)
      // has had another chance to free space.
      logger.error("reconcileVM: short-circuited on ENOSPC", {
        route: "reconcileVM",
        vmId: vm.id,
        lastStep: currentStep,
        enospcPath: err.detail.path,
      });
    } else {
      // Non-deadline, non-ENOSPC error — re-throw so the caller (auditVMConfig
      // → reconcile-fleet) catches it as a normal audit failure. The finally
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
// Exported only for synthetic testing — scripts/_test-disk-guard-tmp-cleanup.ts
// uses this to assert the Rule 38 unconditional .tmp purge fires at every
// disk-pct level. Step* functions are otherwise internal to reconcileVM.
export async function __test_stepDiskGuard(
  ssh: SSHConnection,
  vm: VMRecord,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  return stepDiskGuard(ssh, vm, result, dryRun);
}

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
    // block the reconciler on a DB write hiccup. Wrap in try/catch because
    // getSupabase() throws synchronously if NEXT_PUBLIC_SUPABASE_URL or
    // SUPABASE_SERVICE_ROLE_KEY are missing — without the catch, that
    // synchronous throw bypasses the .thens and falls into the outer
    // catch, taking out the Rule 38 .tmp cleanup with it (caught
    // 2026-05-14 in scripts/_test-disk-guard-tmp-cleanup.ts).
    try {
      void getSupabase()
        .from("instaclaw_vms")
        .update({ last_disk_pct: diskPct })
        .eq("id", vm.id)
        .then(
          () => undefined,
          () => undefined,
        );
    } catch {
      // Supabase client init failed (missing env, etc.). Disk-pct telemetry
      // is non-critical; don't let it block the rest of disk-guard.
    }

    // ── Rule 38 unconditional .tmp self-clean ──
    // Every reconcile tick, regardless of disk%, sweep stale
    // `openclaw.json.*.tmp` leftovers (>60min mtime). These accumulate from
    // openclaw's atomic-write-via-rename pattern: when `openclaw config set`
    // hits ENOSPC mid-write, the .tmp file gets created but never renamed
    // over the target, and nothing cleans it up. vm-788 accumulated 40+
    // such zero-byte files between 2026-05-08 and 2026-05-14, burning
    // inodes even after bytes were freed by other cleanup paths. The
    // canonical fix is an EXIT trap inside openclaw itself (upstream issue
    // drafted at instaclaw/docs/openclaw-upstream-issue-r38.md, pending
    // post by Cooper). Until then, this fleet-side mitigation runs at every
    // reconcile so the accumulation can never exceed one reconcile-cycle's
    // worth (~3 min between Vercel cron ticks; ~15 min between file-drift
    // ticks for cv-current VMs).
    //
    // 60min mtime bound: don't race an in-flight atomic write. A legitimate
    // openclaw config set takes <1s end-to-end, so any .tmp older than
    // 60min is by definition orphaned.
    //
    // Dry-run is honored — the find -delete won't run.
    if (!dryRun) {
      await ssh.execCommand(
        `find ~/.openclaw/ -maxdepth 1 -name "openclaw.json.*.tmp" -mmin +60 -delete 2>/dev/null; true`,
      );
    }

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

    // Re-record post-purge value. Same wrap-in-try as above; getSupabase()
    // can throw synchronously on missing env.
    try {
      void getSupabase()
        .from("instaclaw_vms")
        .update({ last_disk_pct: postPct })
        .eq("id", vm.id)
        .then(
          () => undefined,
          () => undefined,
        );
    } catch {
      // Non-critical telemetry; don't propagate.
    }

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
export interface SecretEnvVarSource {
  /**
   * Key name on the VM side — appears in `~/.openclaw/.env` and is what the
   * agent reads at runtime. Also used as the Vercel-side name UNLESS
   * `vercelKey` is set below (asymmetric-naming case).
   */
  envKey: string;
  /**
   * Optional override for the Vercel-side process.env name when it differs
   * from the VM-side `envKey`. Defaults to `envKey` when unset.
   *
   * Use this when Vercel was provisioned with a different convention than
   * what the VM agent expects (e.g., BRAVE Search ships as
   * `BRAVE_SEARCH_API_KEY` in Vercel but the VM-side OpenClaw plugin
   * looks for `BRAVE_API_KEY`). Renaming on the Vercel side is the
   * cleanest fix when there's only one entry, but using `vercelKey` lets
   * the same Vercel variable feed multiple consumers with different names.
   */
  vercelKey?: string;
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

export const SECRET_ENV_VAR_SOURCES: SecretEnvVarSource[] = [
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
  // 2026-05-15: BRAVE Search API key enrollment. Vercel ships this under
  // `BRAVE_SEARCH_API_KEY` (provisioned via Brave dashboard, matches
  // Brave's naming convention). The OpenClaw browser plugin + web_search
  // tool on the VM reads `BRAVE_API_KEY` from ~/.openclaw/.env. The
  // `vercelKey` field bridges the asymmetric naming so a single Vercel
  // env var feeds every VM with the agent-expected name.
  // Universal (no partnerGate): web search is core capability for every
  // tier, not partner-gated.
  // Companion bump: SECRET_VERSION 1 → 2 so caught-up VMs (sv=1 from the
  // v1 EDGEOS rotation) re-enter the reconcile queue and pick up the
  // new key.
  { envKey: "BRAVE_API_KEY", vercelKey: "BRAVE_SEARCH_API_KEY", label: "Brave Search API key" },
  // 2026-05-22: OPENAI_API_KEY enrollment for zero-manual-intervention bakes.
  //
  // The 2026-05-22 bake-VM-3 surfaced a structural gap: install-gbrain.sh
  // Phase A4 reads OPENAI_API_KEY from ~/.openclaw/.env (it's needed for
  // text-embedding-3-large embedding calls at 1536 dims). The bake VM
  // didn't have OPENAI_API_KEY in its .env at install time → Phase A4
  // exited FATAL_NO_OPENAI_KEY → snapshot terminal had to manually SSH
  // push it before retrying install-gbrain.sh. Same gap on every snapshot
  // — the env var was assumed present but never actually propagated by
  // any reconciler step.
  //
  // OPENAI_API_KEY is in Vercel production (created 2026-02-19, 92 days
  // ago). It's already used by other agent code paths (`lib/openai-*.ts`
  // for ChatGPT OAuth signup, `app/api/onboarding/*` for personalization).
  // It just wasn't enrolled in stepEnvVarPush's distribution.
  //
  // Universal (no partnerGate): every VM that installs gbrain needs this,
  // and gbrain is partner-gated to edge_city today — but the env var is
  // cheap to deploy on every VM and there's no reason to restrict it
  // (matches the BRAVE_API_KEY universal-deploy pattern).
  //
  // Companion bump: SECRET_VERSION 3 → 4 so caught-up VMs (sv=3 from the
  // v3 GBRAIN_ANTHROPIC_API_KEY rotation) re-enter the reconcile queue
  // and receive OPENAI_API_KEY via the next stepEnvVarPush tick. Fleet
  // converges to sv=4 within ~30 min at default cadence.
  //
  // Why this eliminates the manual SSH push: the next bake's reconcile
  // audit step writes OPENAI_API_KEY to ~/.openclaw/.env BEFORE the
  // gbrain-install phase runs install-gbrain.sh Phase A4. Phase A4 reads
  // a present-and-valid value → no FATAL_NO_OPENAI_KEY. Combined with
  // commit c9d3c5b1 (EnvironmentFile architecture eliminating bake-time
  // ANTHROPIC_API_KEY staleness) and commit 9201a3fc (Phase G8 health
  // budget 12s → 120s eliminating 8-plugin cold-boot false-negatives),
  // the next bake runs zero-manual-intervention.
  { envKey: "OPENAI_API_KEY", label: "OpenAI API key (gbrain text-embedding-3-large + ChatGPT OAuth)" },
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
  // touch+chmod is idempotent on existing files (the entire production fleet) but
  // CREATES the file on fresh-from-snapshot VMs. 2026-05-22 v113 snapshot test
  // (test VM 50.116.57.121) surfaced that the orchestrator runs stepEnvVarPush
  // (line ~544) BEFORE the envValues/POLYGON_RPC_URL write (line ~5481+) which
  // creates the file. Without this touch, the first reconcile tick on a fresh
  // Edge VM fails for OPENAI/GBRAIN_ANTHROPIC/BRAVE with STEPENV_FAIL no_env_file
  // and self-heals only on tick 2 (~3 min later). Closes that 3-min gap.
  'touch "$ENV_FILE" 2>/dev/null && chmod 600 "$ENV_FILE" 2>/dev/null || { echo "STEPENV_FAIL touch_or_chmod path=$ENV_FILE"; exit 2; }',
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
  for (const { envKey, vercelKey, label, partnerGate } of SECRET_ENV_VAR_SOURCES) {
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

    // 2026-05-15: vercelKey lets a Vercel-side env var with a different
    // name feed the VM-side .env under `envKey`. When unset, vercelKey
    // defaults to envKey (same name on both sides — the original behavior).
    const sourceKey = vercelKey ?? envKey;
    const value = process.env[sourceKey];
    if (!value || value.length < 20) {
      // Silent skip — don't block config_version. Logged so dashboards / the
      // future gbrain-coverage cron (P2) can pick up on persistent absences.
      logger.info("stepEnvVarPush: skipping (env var not set in Vercel)", {
        envKey,
        vercelKey: sourceKey,
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
 * stepGbrainEnvSync — propagate $HOME/.openclaw/.env's GBRAIN_ANTHROPIC_API_KEY
 * into gbrain's process environment and restart gbrain so the rotated value
 * actually reaches the running process.
 *
 * Background — two architecture eras:
 *
 *   ── Era 1 (2026-05-11 install-gbrain.sh → 2026-05-22): inline Environment ──
 *
 *   install-gbrain.sh Phase E5 wrote the unit with:
 *     [Service]
 *     Environment=ANTHROPIC_API_KEY=<value>     ← baked at install-time
 *   The unit's value never updates unless something explicitly rewrites the
 *   unit. Cooper rotated GBRAIN_ANTHROPIC_API_KEY in Vercel on 2026-05-21
 *   (SECRET_VERSION v3); stepEnvVarPush updated $HOME/.openclaw/.env on the
 *   next reconcile tick, but the 9 edge_city VMs kept running with the OLD
 *   key forever. This step's original implementation sed-rewrote the unit
 *   in place + daemon-reload + restart. Works, but cumbersome.
 *
 *   ── Era 2 (2026-05-22 onward): EnvironmentFile architecture ──
 *
 *   install-gbrain.sh Phase E4.5+E5 now writes:
 *     [Service]
 *     EnvironmentFile=-$HOME/.gbrain/.env       ← rotatable secrets here
 *   And $HOME/.gbrain/.env contains:
 *     ANTHROPIC_API_KEY=<value>
 *   To rotate: write the file + restart gbrain. systemd re-reads
 *   EnvironmentFile= on every unit start; no sed gymnastics, no
 *   daemon-reload. (The leading `-` makes the file optional — gbrain
 *   still starts if the file is missing; embedding calls will then fail
 *   loudly with Anthropic 401 instead of the unit refusing to start.)
 *
 * Branch decision (one cheap grep against the unit file): detect which era
 * the VM was last installed under, then run the appropriate sync path. Both
 * paths converge on the same final state — the gbrain process has the
 * current canonical key in its env. The OLD path can be removed once every
 * fleet VM has been reinstalled from a post-2026-05-22 snapshot.
 *
 * Sync algorithm (both eras):
 *   1. Partner-gate: edge_city only (no other partner installs gbrain today).
 *   2. Presence-gate: skip if gbrain.service unit file is missing.
 *   3. Read $HOME/.openclaw/.env's GBRAIN_ANTHROPIC_API_KEY (canonical
 *      source, just refreshed by stepEnvVarPush).
 *   4. Value-shape validation: refuse to sync values with shell metachars
 *      that could be embedded into a bash chain.
 *   5. Detect era (NEW EnvironmentFile= vs OLD Environment=).
 *   6. NEW path: read $HOME/.gbrain/.env current value, compare, atomic
 *      file write (tmp + mv) + restart if different.
 *   7. OLD path: read unit's Environment= line, compare, sed-rewrite +
 *      daemon-reload + restart if different.
 *   8. Verify-after-write: re-read AND verify /proc/<pid>/environ contains
 *      the new value (defense vs systemd silently using stale state).
 *
 * Idempotency: matches the existing reconciler discipline. Re-running this
 * step on a VM where canonical == current is a single read + early return.
 *
 * Failure modes:
 *   - .env missing GBRAIN_ANTHROPIC_API_KEY (e.g., stepEnvVarPush hasn't run
 *     yet because Vercel env is unset): alreadyCorrect with reason (Rule 39
 *     skip class — non-critical).
 *   - Unit missing both EnvironmentFile= AND Environment= line: skip + warn
 *     (let install-gbrain.sh own unit layout; don't synthesize).
 *   - Restart fails (gbrain crash-loop, port conflict): push to errors so
 *     pushFailed gate holds the secret_version bump. Next tick retries.
 */
async function stepGbrainEnvSync(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Partner gate — only edge_city installs gbrain today. Mirrors stepGbrain's
  // partnerGate semantics: skip silently, don't pollute result.errors.
  if (vm.partner !== "edge_city") {
    return;
  }

  // Presence gate — gbrain may not be installed yet (install-gbrain.sh hasn't
  // run, or VM was provisioned from a snapshot that predates install-gbrain.sh).
  // Single cheap probe for the unit file.
  const presenceCheck = await ssh.execCommand(
    "test -f $HOME/.config/systemd/user/gbrain.service && echo INSTALLED || echo MISSING",
  );
  if (presenceCheck.stdout.trim() !== "INSTALLED") {
    result.alreadyCorrect.push("gbrainEnvSync (gbrain.service unit not present)");
    return;
  }

  // Read .env value (canonical source — just refreshed by stepEnvVarPush).
  // Strip optional surrounding quotes. If absent or too short, skip — there's
  // nothing to sync into the unit yet.
  const envRead = await ssh.execCommand(
    "grep '^GBRAIN_ANTHROPIC_API_KEY=' $HOME/.openclaw/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\"'",
  );
  const envValue = envRead.stdout.trim();
  if (!envValue || envValue.length < 20) {
    result.alreadyCorrect.push("gbrainEnvSync (.env value absent or empty)");
    return;
  }

  // Value-shape validation — defense against a malformed Vercel env that
  // would otherwise be embedded into a bash chain or sed pattern.
  // Anthropic project keys are `sk-ant-api03-[A-Za-z0-9_-]+` (alphanumeric
  // + dash + underscore after the prefix; ~100 chars total). If we ever see
  // shell metacharacters, refuse to sync — operator must clean up Vercel
  // env first. Pushes warning (not error) so the cv bump isn't blocked on a
  // bad Vercel value — the .env has already been updated by stepEnvVarPush
  // with the same bad value, no worse off than before.
  if (!/^[A-Za-z0-9_.-]+$/.test(envValue)) {
    logger.warn("stepGbrainEnvSync: env value contains unsafe chars — refusing to sync", {
      vmId: vm.id,
      value_prefix: envValue.slice(0, 8),
      value_len: envValue.length,
    });
    result.alreadyCorrect.push("gbrainEnvSync (unsafe-char value, refused)");
    return;
  }

  // Detect unit layout style (new-style EnvironmentFile= vs legacy inline
  // Environment=ANTHROPIC_API_KEY=).
  //
  // 2026-05-22 EnvironmentFile architecture: install-gbrain.sh Phase E4.5+E5
  // now writes ANTHROPIC_API_KEY to $HOME/.gbrain/.env (separate file) and
  // the unit references it via `EnvironmentFile=-$HOME/.gbrain/.env`. New
  // VMs from the post-fix bake have this layout; existing VMs from earlier
  // bakes still have the legacy inline `Environment=ANTHROPIC_API_KEY=`.
  //
  // Branch decision is one cheap grep against the unit file. Both branches
  // converge on the same final state (gbrain process has the current
  // canonical key in its env) — they differ in WHERE the value is stored:
  //   - NEW: $HOME/.gbrain/.env (rotating just writes the file + restart)
  //   - OLD: unit's Environment= line (rotating needs sed + daemon-reload)
  //
  // The OLD branch can be removed once every fleet VM has been reinstalled
  // from a post-fix snapshot (next bake cycle). Until then, we support both.
  // Regex matches `EnvironmentFile=` (with optional leading `-` for the
  // make-it-optional prefix) followed by anything containing `.gbrain/.env`.
  // install-gbrain.sh writes the literal path `/home/openclaw/.gbrain/.env`
  // after heredoc-expansion of `$HOME`; the `.*` lets us match any reasonable
  // expansion variant without committing to one specific format.
  const styleCheck = await ssh.execCommand(
    "grep -qE '^EnvironmentFile=-?.*\\.gbrain/\\.env' $HOME/.config/systemd/user/gbrain.service && echo NEW || echo OLD",
  );
  const isNewStyle = styleCheck.stdout.trim() === "NEW";

  if (isNewStyle) {
    // ── NEW PATH: write $HOME/.gbrain/.env ──
    //
    // Idempotency: read the file's current ANTHROPIC_API_KEY. If it matches
    // canonical, no-op. Otherwise atomic write (tmp + mv) + restart.
    // restart is sufficient — systemd re-reads EnvironmentFile= on start.
    const fileRead = await ssh.execCommand(
      "grep '^ANTHROPIC_API_KEY=' $HOME/.gbrain/.env 2>/dev/null | head -1 | cut -d= -f2-",
    );
    const fileValue = fileRead.stdout.trim();

    if (fileValue === envValue) {
      result.alreadyCorrect.push("gbrainEnvSync (new-style, file matches)");
      return;
    }

    if (dryRun) {
      result.fixed.push(
        `[dry-run] gbrainEnvSync (new-style): would rotate key in $HOME/.gbrain/.env (current=${fileValue.slice(0, 20) || "<empty>"}..., new=${envValue.slice(0, 20)}...)`,
      );
      return;
    }

    // Atomic write via tmp + mv. printf (NOT echo — Rule 6) for no-trailing-
    // newline-corruption on values. Mode 600 on the tmp before mv so the
    // file is never readable by other users between write + chmod.
    const sync = await ssh.execCommand(
      [
        `TMP=$HOME/.gbrain/.env.tmp.$$`,
        `printf 'ANTHROPIC_API_KEY=%s\\n' '${envValue}' > "$TMP"`,
        `chmod 600 "$TMP"`,
        `mv "$TMP" $HOME/.gbrain/.env`,
        // Verify the file's new value (defense vs disk-pressure silent-write-fail)
        `NEW_FILE_VAL=$(grep '^ANTHROPIC_API_KEY=' $HOME/.gbrain/.env 2>/dev/null | head -1 | cut -d= -f2-)`,
        `[ "$NEW_FILE_VAL" = "${envValue}" ] || { echo "SYNC_FAILED file-not-written"; exit 1; }`,
        // Restart gbrain to re-read EnvironmentFile= (uses KillSignal=SIGKILL
        // drop-in — Rule 54-safe for PGLite)
        `systemctl --user restart gbrain.service`,
        `sleep 3`,
        // Verify active + process env has new value
        `systemctl --user is-active gbrain.service | grep -q '^active$' || { echo "SYNC_FAILED gbrain-not-active"; exit 2; }`,
        `PID=$(systemctl --user show gbrain.service --property=MainPID --value)`,
        `PROC_VAL=$(cat /proc/$PID/environ 2>/dev/null | tr '\\0' '\\n' | grep '^ANTHROPIC_API_KEY=' | head -1 | cut -d= -f2-)`,
        `[ "$PROC_VAL" = "${envValue}" ] || { echo "SYNC_FAILED proc-env-mismatch"; exit 3; }`,
        `echo "SYNC_OK"`,
      ].join(" && "),
    );

    if (sync.code !== 0 || !sync.stdout.includes("SYNC_OK")) {
      result.errors.push(
        `stepGbrainEnvSync (new-style): failed exit=${sync.code} stdout=${(sync.stdout || "").slice(0, 200)} stderr=${(sync.stderr || "").slice(0, 200)}`,
      );
      return;
    }

    result.fixed.push("gbrainEnvSync (new-style): ANTHROPIC_API_KEY rotated in $HOME/.gbrain/.env + restarted");
    logger.info("stepGbrainEnvSync (new-style): rotated key + restarted gbrain", {
      vmId: vm.id,
      oldFilePrefix: fileValue.slice(0, 20) || "<empty>",
      newFilePrefix: envValue.slice(0, 20),
    });
    return;
  }

  // ── OLD PATH (legacy inline Environment=ANTHROPIC_API_KEY=) ──
  //
  // Preserved for backwards compatibility with VMs provisioned from
  // snapshots predating the 2026-05-22 EnvironmentFile architecture. Will
  // be removed once every fleet VM has been reinstalled from a post-fix
  // bake (track via post-bake coverage probe: grep EnvironmentFile= on the
  // unit; expect 100% after next bake propagates).
  //
  // Read unit's current value. Format we expect (from install-gbrain.sh Phase E):
  //   Environment=ANTHROPIC_API_KEY=<key>
  // cut -d= -f3- captures the full value after the second `=` (handles values
  // that happen to contain `=`, though Anthropic keys never do).
  const unitRead = await ssh.execCommand(
    "grep '^Environment=ANTHROPIC_API_KEY=' $HOME/.config/systemd/user/gbrain.service | head -1 | cut -d= -f3-",
  );
  const unitValue = unitRead.stdout.trim();

  if (!unitValue) {
    // Unit exists but Environment=ANTHROPIC_API_KEY= line is missing. Don't
    // synthesize one — let install-gbrain.sh (stepGbrain) own the unit layout.
    // Push to warnings so the operator notices but don't block cv-bump.
    logger.warn("stepGbrainEnvSync (old-style): unit present but Environment=ANTHROPIC_API_KEY= absent — skipping (install-gbrain.sh should own this layout)", {
      vmId: vm.id,
    });
    result.alreadyCorrect.push("gbrainEnvSync (unit Environment= line missing)");
    return;
  }

  if (unitValue === envValue) {
    result.alreadyCorrect.push("gbrainEnvSync (old-style)");
    return;
  }

  // Drift detected — sync .env → unit + daemon-reload + restart gbrain.
  if (dryRun) {
    result.fixed.push(
      `[dry-run] gbrainEnvSync (old-style): would rotate key (env=${envValue.slice(0, 20)}..., unit=${unitValue.slice(0, 20)}...)`,
    );
    return;
  }

  // Escape sed metacharacters in the value. Anthropic keys are
  // sk-ant-api03-<base64ish> — only `&` and `|` are sed-special on the RHS.
  const sedSafe = envValue.replace(/[&|]/g, "\\$&");

  const sync = await ssh.execCommand(
    [
      // Backup with timestamp suffix (kept on disk for forensic recovery)
      `cp $HOME/.config/systemd/user/gbrain.service /tmp/gbrain.service.bak-$(date +%s)`,
      // In-place sed (matches install-gbrain.sh's exact line format)
      `sed -i 's|^Environment=ANTHROPIC_API_KEY=.*|Environment=ANTHROPIC_API_KEY=${sedSafe}|' $HOME/.config/systemd/user/gbrain.service`,
      // Verify the sed landed (post-write read; same parse logic as above)
      `NEW_UNIT_VAL=$(grep '^Environment=ANTHROPIC_API_KEY=' $HOME/.config/systemd/user/gbrain.service | head -1 | cut -d= -f3-)`,
      `[ "$NEW_UNIT_VAL" = "${envValue}" ] || { echo "SYNC_FAILED unit-not-written"; exit 1; }`,
      // daemon-reload + restart (uses unit's KillSignal=SIGKILL drop-in — Rule 54-safe)
      `systemctl --user daemon-reload`,
      `systemctl --user restart gbrain`,
      `sleep 3`,
      // Verify gbrain came back active + the process actually has the new value
      `systemctl --user is-active gbrain | grep -q '^active$' || { echo "SYNC_FAILED gbrain-not-active"; exit 2; }`,
      `PID=$(systemctl --user show gbrain --property=MainPID --value)`,
      `PROC_VAL=$(cat /proc/$PID/environ 2>/dev/null | tr '\\0' '\\n' | grep '^ANTHROPIC_API_KEY=' | head -1 | cut -d= -f2-)`,
      `[ "$PROC_VAL" = "${envValue}" ] || { echo "SYNC_FAILED proc-env-mismatch"; exit 3; }`,
      `echo "SYNC_OK"`,
    ].join(" && "),
  );

  if (sync.code !== 0 || !sync.stdout.includes("SYNC_OK")) {
    result.errors.push(
      `stepGbrainEnvSync (old-style): failed exit=${sync.code} stdout=${(sync.stdout || "").slice(0, 200)} stderr=${(sync.stderr || "").slice(0, 200)}`,
    );
    return;
  }

  result.fixed.push("gbrainEnvSync (old-style): ANTHROPIC_API_KEY rotated in gbrain unit + restarted");
  logger.info("stepGbrainEnvSync (old-style): rotated key + restarted gbrain", {
    vmId: vm.id,
    oldKeyPrefix: unitValue.slice(0, 20),
    newKeyPrefix: envValue.slice(0, 20),
  });
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
 * stepGbrain — install gbrain HTTP sidecar (CLAUDE.md Rule 35) on
 * partner-allowlisted VMs.
 *
 * Architecture (2026-05-16 rewrite): gbrain runs as a persistent
 * `systemd --user` service (gbrain.service) bound to loopback 127.0.0.1:3131.
 * OpenClaw connects via the streamable-http MCP transport with a Bearer token
 * stored in the gbrain PGLite access_tokens table + ~/.gbrain/openclaw-bearer-token.txt.
 * Replaces the stdio per-session-spawn architecture that paid a 90+s cold-start.
 *
 * Phase 4c of the gbrain fleet rollout. Auto-installs once
 * GBRAIN_INSTALL_ENABLED=true is set in Vercel env. Until then, no-op.
 *
 * Per-VM behavior (when fully enabled):
 *   1. Skip if vm.partner not in GBRAIN_PARTNER_ALLOWLIST (silent no-op).
 *   2. Skip in strict mode (180s deadline can't accommodate ~70-165s install
 *      — non-strict reconcile-fleet cron will pick it up next cycle).
 *   3. Skip if GBRAIN_INSTALL_ENABLED env var is not "true" (silent no-op).
 *   4. Cheap idempotency check via one SSH call — four-state invariant:
 *        V = gbrain --version           (matches GBRAIN_PINNED_VERSION)
 *        T = mcp.servers.gbrain.transport (= "streamable-http")
 *        S = systemctl is-active gbrain.service (= "active")
 *        P = port 3131 bound to 127.0.0.1 (= 1)
 *      All four must be true to short-circuit to alreadyCorrect. Any miss
 *      triggers reinstall (fail-open posture — see PRD §11).
 *   5. Otherwise: upload install-gbrain.sh + verify-gbrain-mcp.py via stdin
 *      (no fs.readFileSync — scripts are embedded as base64 in
 *      lib/gbrain-scripts-content.ts to dodge Vercel-nft's silent-drop bug
 *      that bit the matchpool team).
 *   6. Run install-gbrain.sh with GBRAIN_INSTALL_TIMEOUT_MS hard cap.
 *   7. Parse output:
 *      - ALREADY_INSTALLED  → alreadyCorrect (Phase A's deeper idempotency
 *        check caught it even though our cheap check didn't — e.g., bun PATH
 *        not loaded in our SSH session)
 *      - INSTALL_COMPLETE   → fixed (success — sidecar live, openclaw.json wired)
 *      - FATAL_<reason>     → errors (cv won't bump; next cycle retries)
 *      - timeout / other    → errors with diagnostic snippet
 *
 * No gateway restart is needed — Phase G's `openclaw mcp set gbrain` registers
 * via the mcp.servers.* namespace which is hot-reloadable (per
 * RESTART_REQUIRED_CONFIG_PREFIXES comment block at the top of this file).
 *
 * Never throws — all paths fall through to result.errors or silent skip.
 *
 * Design docs:
 *   - docs/prd/gbrain-fleet-rollout-2026-05-12.md §7 (original stdio design)
 *   - docs/prd/gbrain-http-fleet-rewrite-plan-2026-05-16.md (HTTP rewrite)
 */
async function stepGbrain(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null; gbrain_enabled?: boolean | null },
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  // ── Gate 1: gbrain eligibility (partner allowlist OR explicit canary opt-in) ──
  if (!isGbrainEligibleForVM(vm)) return;

  // ── Gate 2: strict mode timeout incompatibility ──
  // Strict has a 180s deadline; gbrain install needs ~70-165s. Non-strict
  // reconcile-fleet cron has the full 300s budget and will pick it up.
  if (strict) return;

  // ── Gate 3: feature flag (default off — Cooper enables via Vercel env when ready) ──
  if (process.env.GBRAIN_INSTALL_ENABLED !== "true") return;

  // ── Cheap idempotency check (single SSH call, ~2s) ──
  //
  // HTTP sidecar architecture — Rule 35. Four invariants must ALL hold to
  // skip install: version pinned, openclaw.json transport=streamable-http,
  // gbrain.service active, port 3131 bound to 127.0.0.1.
  //
  // Fail-open posture (Cooper's 2026-05-16 review): any miss triggers
  // reinstall — better to reinstall an already-fine VM than skip a partially
  // broken one. The install path itself is idempotent (Phase A's deeper
  // check catches false-negative cases via ALREADY_INSTALLED early-exit).
  //
  // Version detection regex: LENIENT (any dotted-digit version) for clean
  // diagnostic output. The comparison against GBRAIN_PINNED_VERSION uses
  // exact string match, so a stdio-era v0.28.1 still triggers reinstall —
  // we just get a useful "V=0.28.1" in the dry-run/log instead of "missing".
  const checkScript = [
    'source ~/.nvm/nvm.sh 2>/dev/null',
    'export PATH="$HOME/.bun/bin:$PATH"',
    'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
    'V=$(gbrain --version 2>/dev/null | head -1 | grep -oE "[0-9]+(\\.[0-9]+)+" | head -1)',
    '[ -z "$V" ] && V=missing',
    'T=$(jq -r ".mcp.servers.gbrain.transport // \\"\\"" "$HOME/.openclaw/openclaw.json" 2>/dev/null)',
    'S=$(systemctl --user is-active gbrain.service 2>/dev/null || echo missing)',
    // grep -F (fixed-string) avoids the `$` end-of-line anchor inside a
    // double-quoted bash string (`$(...)` would otherwise try to expand `$)`).
    // ss output uses `127.0.0.1:3131` followed by whitespace; a substring
    // match against the colon-form is unambiguous on real ss output.
    'P=$(ss -lnpt 2>/dev/null | grep -cF "127.0.0.1:3131")',
    'echo "GBRAIN_CHECK V=$V T=$T S=$S P=$P"',
  ].join('; ');

  const check = await ssh.execCommand(`bash -c '${checkScript.replace(/'/g, "'\\''")}'`);
  const checkMatch = (check.stdout || '').match(/GBRAIN_CHECK V=(\S+) T=(\S*) S=(\S+) P=(\d+)/);
  const versionOk = checkMatch?.[1] === GBRAIN_PINNED_VERSION;
  const transportOk = checkMatch?.[2] === "streamable-http";
  const serviceOk = checkMatch?.[3] === "active";
  const portOk = checkMatch?.[4] === "1";
  if (versionOk && transportOk && serviceOk && portOk) {
    result.alreadyCorrect.push(`gbrain v${GBRAIN_PINNED_VERSION} (HTTP sidecar, Rule 35)`);
    return;
  }

  // ── Dry-run path: report what we WOULD do, take no action ──
  if (dryRun) {
    const observedVersion = checkMatch?.[1] ?? "unknown";
    const observedTransport = checkMatch?.[2] ?? "(none)";
    const observedService = checkMatch?.[3] ?? "(missing)";
    const observedPort = checkMatch?.[4] ?? "0";
    result.fixed.push(
      `[dry-run] gbrain HTTP sidecar install (current: V=${observedVersion} T=${observedTransport} S=${observedService} P=${observedPort})`,
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

    // 2026-05-20: upload the 2 companion files install-gbrain.sh's Phase C2
    // + Phase I look for at /tmp/. The 2026-05-19 v107 canary surfaced that
    // without these uploaded, Phase C2 (patch) + Phase I (cron + drop-in)
    // emitted WARN but exited 0, leaving 15/15 canary VMs missing
    // src/core/checkpoint-operation.ts + the CHECKPOINT cron + ExecStop hook.
    // The companion script's exit-code additions (FATAL_PHASE_C2_NO_PATCH_FILE
    // exit 36 + FATAL_PHASE_I_NO_CRON_SCRIPT exit 35) now hard-fail when
    // these uploads are missing — the reconciler retries instead of silently
    // marking the install successful.
    const upCheckpoint = await ssh.execCommand(
      "cat > /tmp/pglite-checkpoint.sh && chmod +x /tmp/pglite-checkpoint.sh",
      { stdin: PGLITE_CHECKPOINT_SH },
    );
    if (upCheckpoint.code !== 0) {
      result.errors.push(
        `stepGbrain: upload pglite-checkpoint.sh failed (exit=${upCheckpoint.code}) stderr=${(upCheckpoint.stderr || '').slice(0, 200)}`,
      );
      return;
    }

    const upPatch = await ssh.execCommand(
      "cat > /tmp/0001-add-checkpoint-mcp-tool.patch",
      { stdin: GBRAIN_CHECKPOINT_PATCH },
    );
    if (upPatch.code !== 0) {
      result.errors.push(
        `stepGbrain: upload 0001-add-checkpoint-mcp-tool.patch failed (exit=${upPatch.code}) stderr=${(upPatch.stderr || '').slice(0, 200)}`,
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
  //
  // Four success terminals:
  //   ALREADY_INSTALLED  — Phase A's 5-invariant check passed; no work done
  //   BEARER_SYNCED       — Phase A6 surgical recovery (bearer mismatch resolved
  //                         without brain wipe, vm-050-class state). Added
  //                         2026-05-18 per Rule 58.
  //   UPGRADE_COMPLETE    — Phase J in-place version upgrade succeeded (brain
  //                         preserved, version bumped). Added 2026-05-19 for
  //                         v0.35.0.0 → v0.36.3.0 upgrade path.
  //   INSTALL_COMPLETE    — full Phase B-H install ran successfully
  //
  // Plus FATAL_* (last-match wins) for any failure.
  const alreadyMatch = stdout.match(/^ALREADY_INSTALLED\s+(.+)$/m);
  const bearerSyncedMatch = stdout.match(/^BEARER_SYNCED\s+(.+)$/m);
  const upgradeCompleteMatch = stdout.match(/^UPGRADE_COMPLETE\s+(.+)$/m);
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

  if (bearerSyncedMatch) {
    // Rule 58 — bearer-mismatch surgical recovery. Phase A6 ran openclaw config
    // set to sync openclaw.json's bearer to the on-disk bearer file, restarted
    // the gateway, and verified health. No brain wipe. This counts as a real
    // change (config + gateway state mutated), so log to result.fixed — the
    // reconcile-fleet cron will surface it in the per-VM fix list.
    result.fixed.push(`gbrain bearer-mismatch recovered (Rule 58, brain preserved): ${bearerSyncedMatch[1]}`);
    logger.info('stepGbrain: bearer-mismatch surgically synced', {
      route: 'stepGbrain',
      vmId: vm.id,
      version: GBRAIN_PINNED_VERSION,
      detail: bearerSyncedMatch[1],
    });
    return;
  }

  if (upgradeCompleteMatch) {
    // Phase J in-place version upgrade — gbrain advanced from old version to
    // GBRAIN_PINNED_VERSION while preserving the brain.pglite data dir.
    // Patch reapplied; CHECKPOINT cron + ExecStop drop-ins untouched (orthogonal).
    // GBRAIN_EMBEDDING_DIMENSIONS=1536 drop-in written for v0.36.x compat.
    result.fixed.push(`gbrain upgraded to v${GBRAIN_PINNED_VERSION} (Phase J in-place, brain preserved): ${upgradeCompleteMatch[1]}`);
    logger.info('stepGbrain: in-place upgrade complete', {
      route: 'stepGbrain',
      vmId: vm.id,
      version: GBRAIN_PINNED_VERSION,
      commit: GBRAIN_PINNED_COMMIT,
      detail: upgradeCompleteMatch[1],
    });
    return;
  }

  if (completeMatch) {
    result.fixed.push(`gbrain v${GBRAIN_PINNED_VERSION} (HTTP sidecar installed + MCP wired + round-trip verified)`);
    logger.info('stepGbrain: install complete', {
      route: 'stepGbrain',
      vmId: vm.id,
      version: GBRAIN_PINNED_VERSION,
      commit: GBRAIN_PINNED_COMMIT,
      architecture: 'http-sidecar',
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

/**
 * stepIndexProvision — wire the Index Network MCP server onto an edge_city
 * agent's runtime (PRD: docs/prd/village-index-network-integration.md §7).
 *
 * Gates the entire path on `vm.partner === 'edge_city'` — Index is a per-event
 * partnership and the network ID we hold is bound to Edge Esmeralda 2026.
 *
 * Idempotency (READ this — it's load-bearing):
 *
 *   The Index signup API does NOT have its own idempotency layer. Per Yanek's
 *   integration guide, EVERY call to /signup issues a fresh apiKey and
 *   REVOKES the previous one for the same user+network pair. If this step
 *   called signup on every reconcile tick, it would invalidate the in-use
 *   key on every cron run.
 *
 *   The local cache IS the idempotency layer. We short-circuit on
 *   `vm.index_user_id && vm.index_api_key` and never hit the network in the
 *   steady state. Rotation = NULL the columns, let the next reconcile re-sign.
 *
 * Failure posture (Rule 39):
 *
 *   Index integration is OPTIONAL — an edge_city agent that lacks the Index
 *   MCP server still works fine for Telegram + gbrain + bankr. Every failure
 *   path in this step pushes to `result.warnings` via recordHealWarning, NOT
 *   to `result.errors`. cv-bump is never held by Index issues. This is the
 *   same posture as stepNodeExporter, stepGatewayWatchdogTimer, etc.
 *
 * Rule 32 — MCP servers ARE hot-reloadable. After `openclaw mcp set index`,
 * the runtime picks up the new server on the next gateway tick. No gateway
 * restart needed (the gbrain installer's Phase G confirmed this empirically).
 * We still verify-after-set (Rule 10) by re-reading the on-disk transport.
 */
async function stepIndexProvision(
  ssh: SSHConnection,
  vm: VMRecord & {
    name?: string | null;
    partner?: string | null;
    assigned_to?: string | null;
    index_user_id?: string | null;
    index_api_key?: string | null;
    index_provisioned_at?: string | null;
  },
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  // ── Gate 1: partner allowlist ──
  // Only edge_city agents get the Index MCP for Edge Esmeralda 2026. Future
  // events (Eclipse, Devcon) would get their own network IDs and either a
  // sibling step or an allowlist expansion here.
  if (vm.partner !== "edge_city") return;

  // ── Gate 2: strict-mode bypass ──
  // signup is a third-party HTTP call (15s timeout). Don't burn strict's
  // 180s budget on it — the non-strict reconcile-fleet cron picks it up
  // within the next 3 min anyway. Mirrors stepGbrain.
  if (strict) return;

  // ── Gate 3: env config present ──
  // Local dev / preview deploys legitimately won't have INDEX_NETWORK_ID +
  // INDEX_NETWORK_MASTER_KEY. Silent skip there. In production we emit a
  // single warning so the operator notices if the env var ever drops.
  const indexEnv = getIndexEnv();
  if (!indexEnv) {
    if (process.env.VERCEL_ENV === "production") {
      recordHealWarning(
        result,
        "index: INDEX_NETWORK_ID or INDEX_NETWORK_MASTER_KEY not configured in this env",
      );
    }
    return;
  }

  // ── Gate 4: VM is assigned ──
  // Index signup is keyed by attendee email; without an owner we have no email.
  if (!vm.assigned_to) {
    recordHealWarning(result, "index: VM has no assigned_to; cannot provision");
    return;
  }

  // ── Idempotency check — local cache only, never call signup if we already
  //    have a key. See header comment on key rotation. ──
  const hasLocalCreds = Boolean(
    vm.index_user_id && vm.index_api_key && vm.index_provisioned_at,
  );

  // ── Probe disk for current MCP transport. Three states: ──
  //    (a) on-disk transport = streamable-http        → in sync
  //    (b) on-disk key missing or different transport → drift; need to write
  //    (c) probe fails (jq missing / openclaw.json gone) → fail-soft warning
  let diskOk = false;
  try {
    const probe = await ssh.execCommand(
      `jq -r '.mcp.servers.index.transport // ""' "$HOME/.openclaw/openclaw.json" 2>/dev/null`,
    );
    diskOk = (probe.stdout || "").trim() === "streamable-http";
  } catch (e: unknown) {
    recordHealWarning(
      result,
      `index: disk probe failed: ${String((e as Error)?.message ?? e).slice(0, 150)}`,
    );
    return;
  }

  if (hasLocalCreds && diskOk) {
    result.alreadyCorrect.push("index: provisioned + MCP on disk");
    return;
  }

  if (dryRun) {
    const reason = hasLocalCreds ? "MCP block missing on disk (drift)" : "no local creds";
    result.fixed.push(`[dry-run] index: would provision (${reason})`);
    return;
  }

  // ── Load owner profile for the signup body ──
  //
  // edge_verified_email is the Edge ticket identity (preferred as the
  // /signup primary email — that's the identity attendees recognize each
  // other by). The OAuth user.email is the fallback when no Edge identity
  // is set (rare for partner=edge_city VMs, but defensive).
  const sb = getSupabase();
  const { data: user, error: userErr } = await sb
    .from("instaclaw_users")
    .select("email, name, telegram_handle, edge_verified_email")
    .eq("id", vm.assigned_to)
    .maybeSingle();

  if (userErr || !user?.email) {
    recordHealWarning(
      result,
      `index: user lookup failed (assigned_to=${vm.assigned_to.slice(0, 8)}): ${userErr?.message ?? "no email"}`,
    );
    return;
  }

  // ── Decide path: full signup or MCP-only rewrite ──
  // If we already have a valid key (cached locally) but the MCP block drifted
  // off disk (config rollback, manual edit, fresh snapshot bake), we just
  // re-write the MCP block. Calling signup would revoke the still-good key.
  let apiKey: string;
  let indexUserId: string;
  let signupCalled = false;

  if (hasLocalCreds) {
    apiKey = vm.index_api_key!;
    indexUserId = vm.index_user_id!;
    logger.info("[reconcile] index: MCP drift detected, rewriting block (no signup)", {
      vmId: vm.id,
      indexUserIdPrefix: indexUserId.slice(0, 8),
    });
  } else {
    // Build the enriched signup body via the shared helper. Re-fetches
    // SimpleFi /citizens to pull bio (role + organization) + socials
    // (telegram + x_user). Yanek's intent-extraction NLP needs this
    // profile signal to avoid the "No actionable intent extracted"
    // rejection that hit us 2026-05-23 (see lib/index-signup-enrich.ts
    // header for the full incident write-up).
    //
    // Mirrors the JIT path in lib/index-jit-provision.ts. Both code
    // paths produce the same Index Network user shape regardless of
    // which one runs first (JIT during the user's first intent submit,
    // OR the reconciler during the next 3-min cron tick).
    const signupBody = await buildEnrichedSignupBody({
      email: user.email,
      edgeVerifiedEmail: (user.edge_verified_email as string | null) ?? null,
      name: (user.name as string | null) ?? null,
      telegramHandle: (user.telegram_handle as string | null) ?? null,
      userIdPrefix: vm.assigned_to.slice(0, 8),
    });

    let signupResp;
    try {
      signupResp = await callIndexSignup(signupBody, indexEnv);
    } catch (err: unknown) {
      if (err instanceof IndexSignupError && err.retryable) {
        // One retry with 2s backoff. Index 5xx is rare but the platform IS
        // bursty during pre-event onboarding waves. Reuse the same
        // signupBody on retry — don't re-fetch /citizens.
        await new Promise((r) => setTimeout(r, 2000));
        try {
          signupResp = await callIndexSignup(signupBody, indexEnv);
        } catch (err2: unknown) {
          recordHealWarning(
            result,
            `index: signup retry failed: ${String((err2 as Error)?.message ?? err2).slice(0, 200)}`,
          );
          await markIndexFailure(sb, vm.id);
          return;
        }
      } else {
        recordHealWarning(
          result,
          `index: signup failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
        );
        await markIndexFailure(sb, vm.id);
        return;
      }
    }
    apiKey = signupResp.apiKey;
    indexUserId = signupResp.user.id;
    signupCalled = true;
  }

  // ── Defense-in-depth shell-arg validation ──
  // The apiKey gets written to a JSON file via stdin and read back via
  // `"$(cat tmpPath)"` — JSON.stringify already handles any character safely,
  // so this regex is belt-and-suspenders. Allow alphanumerics, base64 chars,
  // and underscores/hyphens/dots/equals — covers both the documented `ix_...`
  // prod format and the bare-base64 dev format observed 2026-05-18.
  if (!/^[A-Za-z0-9_\-=.+/]{16,}$/.test(apiKey)) {
    recordHealWarning(
      result,
      `index: signup returned unexpected apiKey shape (len=${apiKey.length}, prefix=${apiKey.slice(0, 5)})`,
    );
    return;
  }

  // ── Persist new credentials BEFORE writing to disk. ──
  // If we crash between writing DB and writing disk, the next reconcile reads
  // DB-has-key + disk-missing → fall through to the rewrite-only branch above
  // (no second signup, no key rotation). Reverse order (disk first) would
  // produce a key on disk that we have no record of → on the next reconcile
  // we'd call signup, get a fresh key, and the on-disk key would become orphaned.
  if (signupCalled) {
    const { error: dbErr } = await sb
      .from("instaclaw_vms")
      .update({
        index_user_id: indexUserId,
        index_api_key: apiKey,
        index_provisioned_at: new Date().toISOString(),
        index_provisioned_failed_at: null,
      })
      .eq("id", vm.id);
    if (dbErr) {
      recordHealWarning(result, `index: DB write failed: ${dbErr.message}`);
      return;
    }
  }

  // ── Write the MCP block via openclaw mcp set (atomic, hot-reload-trigger). ──
  // Upload JSON to a tempfile via stdin, then `openclaw mcp set index "$(cat file)"`.
  // Mirrors install-gbrain.sh Phase G2/G4. Tempfile path uses vm.id to avoid the
  // concurrent-worker `Date.now()` race (the strip-thinking fleet-push lesson).
  const mcpJson = JSON.stringify(buildIndexMcpConfig(apiKey));
  const tmpPath = `/tmp/index-mcp-${vm.id}.json`;

  const upload = await ssh.execCommand(`cat > ${tmpPath} && chmod 600 ${tmpPath}`, {
    stdin: mcpJson,
  });
  if (upload.code !== 0) {
    recordHealWarning(
      result,
      `index: upload mcp.json failed (exit=${upload.code}): ${(upload.stderr || "").slice(0, 150)}`,
    );
    return;
  }

  const setCmd = await ssh.execCommand(
    `${NVM_PREAMBLE} && openclaw mcp set index "$(cat ${tmpPath})" 2>&1; SET_RC=$?; rm -f ${tmpPath}; exit $SET_RC`,
  );
  if (setCmd.code !== 0) {
    recordHealWarning(
      result,
      `index: openclaw mcp set failed (exit=${setCmd.code}): ${(setCmd.stdout || "").slice(-200)}`,
    );
    return;
  }

  // ── Verify-after-set (Rule 10): re-read on-disk transport. ──
  // mcp.servers.* is hot-reloadable (Rule 32), but the on-disk write happens
  // synchronously; we don't need to wait for the hot-reload window before this
  // check. Hot-reload affects the running process, not the file on disk.
  const verify = await ssh.execCommand(
    `jq -r '.mcp.servers.index.transport // "MISSING"' "$HOME/.openclaw/openclaw.json"`,
  );
  const verifyTransport = (verify.stdout || "").trim();
  if (verifyTransport !== "streamable-http") {
    recordHealWarning(
      result,
      `index: verify-after-set failed (disk transport=${verifyTransport.slice(0, 50)})`,
    );
    return;
  }

  // ── Lifecycle log forensic trail (best-effort, never fatal). ──
  try {
    await sb.from("instaclaw_vm_lifecycle_log").insert({
      vm_id: vm.id,
      vm_name: vm.name ?? null,
      ip_address: vm.ip_address,
      user_id: vm.assigned_to,
      user_email: user.email,
      subscription_status: null,
      credit_balance: 0,
      action: "index_provisioned",
      reason: signupCalled
        ? `index: signup ok, MCP wired (index_user_id=${indexUserId.slice(0, 8)}..., key=ix_${apiKey.slice(3, 8)}...)`
        : `index: MCP drift recovered (no signup, key unchanged)`,
      provider_server_id: null,
    });
  } catch (logErr: unknown) {
    // Non-fatal — the provisioning itself succeeded.
    logger.warn("[reconcile] index: lifecycle log insert failed", {
      vmId: vm.id,
      error: String((logErr as Error)?.message ?? logErr).slice(0, 150),
    });
  }

  result.fixed.push(
    signupCalled
      ? `index: provisioned + MCP wired (Edge City)`
      : `index: MCP block re-synced from cached creds`,
  );
  logger.info("[reconcile] index: provisioned", {
    vmId: vm.id,
    signupCalled,
    indexUserIdPrefix: indexUserId.slice(0, 8),
    apiKeyPrefix: apiKey.slice(0, 7),
  });
}

/**
 * Best-effort write of index_provisioned_failed_at for forensics.
 * Never throws — failure to write the forensic column is not worth blocking
 * the warning path that's already been emitted.
 */
async function markIndexFailure(
  sb: ReturnType<typeof getSupabase>,
  vmId: string,
): Promise<void> {
  try {
    await sb
      .from("instaclaw_vms")
      .update({ index_provisioned_failed_at: new Date().toISOString() })
      .eq("id", vmId);
  } catch {
    // Swallow — markIndexFailure is forensic decoration on an already-failed path.
  }
}

/**
 * stepEdgeOSApiKey — mint a per-VM EdgeOS API key (eos_live_*) for the
 * Edge Esmeralda 2026 calendar (PRD: D3 in edge-esmeralda-master-prd-2026-05-19.md).
 *
 * Sibling to stepIndexProvision — same partner gate (edge_city only), same
 * warnings-only failure posture per Rule 39, same idempotency discipline
 * (local cache short-circuits the partner API call).
 *
 * Idempotency (READ this — it's load-bearing):
 *
 *   EdgeOS shows API key secrets ONCE at create time. We persist the
 *   minted key into instaclaw_vms.edgeos_api_key. Every subsequent
 *   reconcile reads from DB, never re-mints (which would leave orphan
 *   keys on EdgeOS forever — Cooper's call 2026-05-20 to use
 *   onConflict="suffix" accepts orphan accumulation as the trade for
 *   "clean is better than reconciling unknown state from prior testing").
 *
 *   Rotation pathway = NULL the column manually; next reconcile mints
 *   fresh under a suffixed name, leaves the prior orphan for post-launch
 *   sweep.
 *
 * Failure posture (Rule 39):
 *
 *   EdgeOS calendar integration is OPTIONAL — an edge_city agent that
 *   lacks EDGEOS_API_KEY still works fine for Telegram + gbrain + bankr,
 *   and can still read the attendee directory via EDGEOS_BEARER_TOKEN
 *   (a separate shared bearer in Vercel env). Only CALENDAR reads
 *   degrade. Every failure path → result.warnings via recordHealWarning,
 *   NEVER to result.errors. cv-bump is never held by EdgeOS issues.
 *
 * Cross-consumer match (Rule 58):
 *
 *   The on-disk consumer is `~/.openclaw/.env:EDGEOS_API_KEY`. We verify
 *   exact equality between DB and disk on every tick — drift triggers a
 *   rewrite-from-DB (DB is source of truth). The 2026-05-18 vm-050
 *   gbrain bearer mismatch incident is the reference shape for why this
 *   check is stronger than stepIndexProvision's "transport string
 *   present" check.
 *
 * Defensive partial-SELECT guard:
 *
 *   Multiple call sites of reconcileVM use different SELECT shapes — the
 *   main reconcile-fleet cron includes `edgeos_api_key`, but
 *   hq/upgrade-fleet uses a narrow SELECT for OpenClaw bumps that does
 *   NOT. If we relied on `vm.edgeos_api_key` alone, an undefined-value
 *   (column-not-loaded) would look identical to null (column-loaded-
 *   but-NULL), and the step would re-mint a key for a VM that already
 *   has one → orphan accumulation on EdgeOS.
 *
 *   We distinguish: `=== undefined` → SELECT didn't load it; silently
 *   skip (the main cron will pick it up within 3 min). `=== null` → no
 *   key yet, proceed to mint. `=== string` → reuse from DB.
 */
async function stepEdgeOSApiKey(
  ssh: SSHConnection,
  vm: VMRecord & {
    name?: string | null;
    partner?: string | null;
    assigned_to?: string | null;
    edgeos_api_key?: string | null;
  },
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
): Promise<void> {
  // ── Gate 1: partner allowlist ──
  // EdgeOS calendar is per-event. Edge Esmeralda 2026 binds the tenant
  // ID we use; future popups would either get their own step or an
  // allowlist expansion here.
  if (vm.partner !== "edge_city") return;

  // ── Gate 2: strict-mode bypass ──
  // mintOrReuseApiKey can issue up to 4 HTTP calls under suffix-mode
  // conflict (create → list → suffix-create), each with a 15s timeout.
  // Don't burn strict's 180s budget on this path — the non-strict
  // reconcile-fleet cron picks it up within the next 3 min anyway.
  // Mirrors stepIndexProvision and stepGbrain.
  if (strict) return;

  // ── Gate 3: defensive partial-SELECT guard ──
  // If the caller's SELECT didn't load edgeos_api_key, an `undefined`
  // value would falsely look like "no key" → would re-mint a key the VM
  // already has → orphan on EdgeOS. Skip silently; the main cron has
  // the full SELECT and will pick this up on its next 3-min tick.
  if (vm.edgeos_api_key === undefined) return;

  // ── Gate 4: env config present ──
  // Local dev / preview deploys legitimately won't have
  // EDGEOS_EVENTS_BEARER_TOKEN. Silent skip there. In production we emit a
  // single warning so the operator notices if the env var ever drops.
  //
  // CRITICAL: this is the api.edgeos.world JWT (events + api-keys auth),
  // obtained via the OTP flow at /api/v1/auth/user/{login,authenticate}.
  // It is DISTINCT from EDGEOS_BEARER_TOKEN which is the citizen-portal
  // JWT (api-citizen-portal.simplefi.tech). Empirically confirmed
  // 2026-05-20: the citizen-portal bearer returns 401 against
  // api.edgeos.world. They are two different services that happen to
  // share the "EdgeOS" brand. See CLAUDE.md "EdgeOS bearer split".
  const edgeosBearer = process.env.EDGEOS_EVENTS_BEARER_TOKEN || "";
  if (!edgeosBearer) {
    if (process.env.VERCEL_ENV === "production") {
      recordHealWarning(
        result,
        "edgeos: EDGEOS_EVENTS_BEARER_TOKEN not configured in this env",
      );
    }
    return;
  }

  // ── Gate 5: VM is assigned + has a name ──
  // assigned_to is needed for the lifecycle log; name is needed by
  // mintOrReuseApiKey to derive the deterministic key name.
  if (!vm.assigned_to) {
    recordHealWarning(
      result,
      "edgeos: VM has no assigned_to; cannot provision",
    );
    return;
  }
  if (!vm.name) {
    recordHealWarning(
      result,
      "edgeos: VM has no name; cannot derive deterministic key name",
    );
    return;
  }

  // ── Idempotency check — local cache only. ──
  // EdgeOS shows secrets once, so we never re-mint when a cached key
  // exists. Drift recovery (DB cached, disk missing) uses the cached
  // key, not a fresh mint.
  const hasLocalKey =
    typeof vm.edgeos_api_key === "string" && vm.edgeos_api_key.length > 0;

  // ── Probe disk for current EDGEOS_API_KEY (Rule 58 cross-consumer
  //    match: DB and disk MUST agree, mismatch = rewrite disk from DB).
  let diskValue = "";
  try {
    const probe = await ssh.execCommand(
      `grep '^EDGEOS_API_KEY=' "$HOME/.openclaw/.env" 2>/dev/null | head -1`,
    );
    const probeLine = (probe.stdout || "").trim();
    const m = probeLine.match(/^EDGEOS_API_KEY=(.*)$/);
    let raw = m?.[1] ?? "";
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }
    diskValue = raw;
  } catch (e: unknown) {
    recordHealWarning(
      result,
      `edgeos: disk probe failed: ${String((e as Error)?.message ?? e).slice(0, 150)}`,
    );
    return;
  }

  const diskOk =
    hasLocalKey &&
    diskValue.length > 0 &&
    diskValue === vm.edgeos_api_key;

  if (hasLocalKey && diskOk) {
    result.alreadyCorrect.push("edgeos: api-key in DB + .env (synced)");
    return;
  }

  if (dryRun) {
    const reason = !hasLocalKey
      ? "no key in DB"
      : diskValue.length === 0
        ? ".env missing EDGEOS_API_KEY"
        : "DB↔disk drift";
    result.fixed.push(`[dry-run] edgeos: would provision (${reason})`);
    return;
  }

  // ── Decide path: full mint or disk-only rewrite ──
  // If we already have a valid key (cached locally) but the .env
  // drifted off disk (config rollback, manual .env edit, fresh
  // snapshot bake), we just rewrite the .env line. Calling EdgeOS
  // would create an orphan secondary key under a suffix.
  let apiKey: string;
  let mintCalled = false;
  const sb = getSupabase();

  if (hasLocalKey) {
    apiKey = vm.edgeos_api_key as string;
    logger.info(
      "[reconcile] edgeos: .env drift detected, rewriting from cached DB key (no mint)",
      {
        vmId: vm.id,
        keyPrefix: apiKey.slice(0, 12),
      },
    );
  } else {
    // Mint fresh. onConflict="suffix" always returns a fullKey we can
    // capture (Cooper's call 2026-05-20 — orphan EdgeOS keys are inert
    // and sweepable post-launch).
    let mintResult;
    try {
      mintResult = await mintOrReuseApiKey(
        {
          bearer: edgeosBearer,
          vmName: vm.name,
          onConflict: "suffix",
        },
        {
          // Explicit prod host — DEFAULT_API_BASE in lib/edgeos-auth.ts is
          // api.dev.edgeos.world (sandbox). Without this override, every
          // mint would target sandbox even with the prod bearer.
          apiBase: "https://api.edgeos.world",
          tenantId: EDGEOS_TENANT_EDGECITY_PROD,
          timeoutMs: 15_000,
        },
      );
    } catch (mintErr: unknown) {
      recordHealWarning(
        result,
        `edgeos: mint threw: ${String((mintErr as Error)?.message ?? mintErr).slice(0, 200)}`,
      );
      return;
    }

    if (!mintResult.ok) {
      recordHealWarning(
        result,
        `edgeos: mint failed status=${mintResult.status}${mintResult.detail ? ` detail=${mintResult.detail.slice(0, 150)}` : ""}`,
      );
      return;
    }
    if (!mintResult.fullKey) {
      // onConflict="suffix" should always produce a fullKey. If we ever
      // see this it's an EdgeOS API contract change worth surfacing.
      recordHealWarning(
        result,
        `edgeos: mint returned ok=true but fullKey is null (mode=${mintResult.mode})`,
      );
      return;
    }
    apiKey = mintResult.fullKey;
    mintCalled = true;

    // ── Persist DB BEFORE writing disk. ──
    // EdgeOS won't show this secret again. If we crash between DB write
    // and .env write, next reconcile reads hasLocalKey=true + diskOk=false
    // → falls into the rewrite-from-cached-DB branch above (no second
    // mint, no orphan). Reverse order (disk first) would produce a key
    // on disk we have no record of — next reconcile mints again.
    const { error: dbErr } = await sb
      .from("instaclaw_vms")
      .update({ edgeos_api_key: apiKey })
      .eq("id", vm.id);
    if (dbErr) {
      recordHealWarning(result, `edgeos: DB persist failed: ${dbErr.message}`);
      return;
    }
  }

  // ── Defense-in-depth shape check before shelling out ──
  // mintOrReuseApiKey already validates the EdgeOS response shape, but
  // belt-and-suspenders before we pass the value to sed/echo. The
  // eos_live_ prefix + alphanumeric/underscore/dash chars are the only
  // shape we've ever seen from EdgeOS.
  if (!/^eos_live_[A-Za-z0-9_\-]{16,}$/.test(apiKey)) {
    recordHealWarning(
      result,
      `edgeos: api-key has unexpected shape (len=${apiKey.length}, prefix=${apiKey.slice(0, 12)})`,
    );
    return;
  }

  // ── Write to ~/.openclaw/.env via sed-or-append (mirrors
  //    configureOpenClaw's pattern). `|` delimiter is safe since the
  //    eos_live_ alphabet contains no pipes.
  const writeCmd = await ssh.execCommand(
    `grep -q '^EDGEOS_API_KEY=' "$HOME/.openclaw/.env" 2>/dev/null && ` +
      `sed -i 's|^EDGEOS_API_KEY=.*|EDGEOS_API_KEY=${apiKey}|' "$HOME/.openclaw/.env" || ` +
      `echo 'EDGEOS_API_KEY=${apiKey}' >> "$HOME/.openclaw/.env"`,
  );
  if (writeCmd.code !== 0) {
    recordHealWarning(
      result,
      `edgeos: .env write failed (exit=${writeCmd.code}): ${(writeCmd.stderr || "").slice(0, 200)}`,
    );
    return;
  }

  // ── Verify-after-write (Rule 10): re-grep .env, confirm exact match.
  //    Catches sed-no-op, racing writers, or any sed mishap. Same shape
  //    as stepIndexProvision's mcp.servers.index.transport verify.
  const verify = await ssh.execCommand(
    `grep '^EDGEOS_API_KEY=' "$HOME/.openclaw/.env" 2>/dev/null | head -1`,
  );
  const verifyLine = (verify.stdout || "").trim();
  const verifyMatch = verifyLine.match(/^EDGEOS_API_KEY=(.*)$/);
  let verifyValue = verifyMatch?.[1] ?? "";
  if (
    (verifyValue.startsWith('"') && verifyValue.endsWith('"')) ||
    (verifyValue.startsWith("'") && verifyValue.endsWith("'"))
  ) {
    verifyValue = verifyValue.slice(1, -1);
  }
  if (verifyValue !== apiKey) {
    recordHealWarning(
      result,
      `edgeos: verify-after-write mismatch (disk_len=${verifyValue.length}, expected_len=${apiKey.length})`,
    );
    return;
  }

  // ── Lifecycle log forensic trail (best-effort, never fatal). ──
  // Only log on actual mint; .env-rewrite-from-cached is a self-healing
  // operation and would flood the log on every reconcile after a drift.
  if (mintCalled) {
    try {
      const { data: user } = await sb
        .from("instaclaw_users")
        .select("email")
        .eq("id", vm.assigned_to)
        .maybeSingle();
      await sb.from("instaclaw_vm_lifecycle_log").insert({
        vm_id: vm.id,
        vm_name: vm.name ?? null,
        ip_address: vm.ip_address,
        user_id: vm.assigned_to,
        user_email: user?.email ?? null,
        subscription_status: null,
        credit_balance: 0,
        action: "edgeos_provisioned",
        reason: `edgeos: mint ok, .env wired (key=${apiKey.slice(0, 12)}...)`,
        provider_server_id: null,
      });
    } catch (logErr: unknown) {
      // Non-fatal — the provisioning itself succeeded.
      logger.warn("[reconcile] edgeos: lifecycle log insert failed", {
        vmId: vm.id,
        error: String((logErr as Error)?.message ?? logErr).slice(0, 150),
      });
    }
  }

  result.fixed.push(
    mintCalled
      ? `edgeos: provisioned + .env wired (Edge Esmeralda calendar)`
      : `edgeos: .env re-synced from cached DB key`,
  );
  logger.info("[reconcile] edgeos: provisioned", {
    vmId: vm.id,
    mintCalled,
    keyPrefix: apiKey.slice(0, 12),
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
      // Idempotency: md5-compare expected content against on-disk before
      // writing. Closes the file-drift cron's "drifted: 30/30" inefficiency
      // where every overwrite-mode file was re-SCP'd every 15 min even
      // when bit-identical. Cheap probe (one SSH `md5sum`); huge savings
      // when stable. If the file doesn't exist yet, md5sum returns empty
      // stdout → falls through to write path.
      const expectedMd5 = crypto.createHash("md5").update(content).digest("hex");
      const remoteMd5Probe = await ssh.execCommand(
        `md5sum ${remotePath} 2>/dev/null | awk '{print $1}'`,
      );
      const remoteMd5 = remoteMd5Probe.stdout.trim();
      if (remoteMd5 === expectedMd5) {
        // File content is bit-identical. If entry.executable is true,
        // also verify the +x bit is set — without this, an idempotent
        // skip on a file that lost its executable bit would leave the
        // service half-broken.
        if (entry.executable) {
          const execCheck = await ssh.execCommand(
            `test -x ${remotePath} && echo yes || echo no`,
          );
          if (execCheck.stdout.trim() !== "yes") {
            if (dryRun) {
              result.fixed.push(`[dry-run] chmod +x (content already correct): ${fileName}`);
              return;
            }
            await ssh.execCommand(`chmod +x ${remotePath}`);
            result.fixed.push(`${fileName} (chmod +x only — content was correct)`);
            return;
          }
        }
        result.alreadyCorrect.push(fileName);
        return;
      }

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
 * Step 2b: Clean up bootstrap on VMs that have already had a REAL first
 * conversation.
 *
 * The agent is supposed to delete BOOTSTRAP.md after the first conversation,
 * but it's unreliable. If BOOTSTRAP.md still exists, the agent reads it on
 * every new session and re-triggers the "first moment awake" intro — the
 * .bootstrap_consumed sentinel in SOUL.md is a rule the agent SHOULD follow
 * but doesn't reliably check before reading BOOTSTRAP.md directly.
 *
 * == 2026-05-22 vm-1019 quirky-greeting regression ==
 *
 * The pre-fix signal "any *.jsonl in sessions/" was too coarse. The gateway
 * creates session jsonl at startup (heartbeat init, telegram channel
 * handshake) BEFORE any user→agent exchange. On cloud-init VMs, the
 * reconciler ran within ~3 min of provision, saw a session file existed,
 * deleted BOOTSTRAP.md, created .bootstrap_consumed. When the user sent
 * their first message, the agent had no BOOTSTRAP.md to follow → fell
 * back to the generic "Hey {user}, I'm {bot} — what can I help you with?"
 * greeting from SOUL.md. The quirky "just came alive — first moment
 * awake, who should I be?" awakening NEVER PLAYED for cloud-init users.
 *
 * Cooper directive (2026-05-22): restore the quirky first-message
 * greeting. Root fix: stop the reconciler from prematurely treating
 * bootstrap as consumed.
 *
 * == Fix ==
 *
 * Delete BOOTSTRAP.md + create .bootstrap_consumed ONLY when the agent
 * has demonstrably had a real conversation. "Real conversation" is
 * defined narrowly: at least one assistant message in a session jsonl
 * with ≥100 chars of substantive text content. New VMs whose session
 * files only contain gateway-init events, telegram-handshake events,
 * or empty/aborted assistant replies (like vm-1019's `message: None`
 * events) are LEFT ALONE so the first-run quirky bootstrap fires.
 *
 * The Python check below walks each *.jsonl (skipping trajectory +
 * checkpoint sidecars), parses each event, and exits early as soon as
 * it finds ONE substantive assistant reply (no need to scan all events).
 *
 * Output contract:
 *   "USED"      → at least one substantive assistant reply found
 *   "NOT_USED"  → only init events / empty replies / no sessions
 *   anything else / non-zero exit → fail-safe: treated as NOT_USED
 *     (keep BOOTSTRAP.md if we can't prove it should be deleted)
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

  // BOOTSTRAP.md exists — only delete if the agent has had a REAL
  // conversation (substantive assistant reply, not just gateway-init
  // events). See block comment above for vm-1019 regression context.
  const realConvoCheck = await ssh.execCommand(
    `python3 - <<'BOOTSTRAP_CHECK_PY'
import json, os, glob
sessions_dir = os.path.expanduser('~/.openclaw/agents/main/sessions')
for f in glob.glob(os.path.join(sessions_dir, '*.jsonl')):
    if 'trajectory' in f or 'checkpoint' in f:
        continue
    try:
        with open(f) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                msg = e.get('message') or {}
                if not isinstance(msg, dict):
                    continue
                if msg.get('role') != 'assistant':
                    continue
                content = msg.get('content')
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    for b in content:
                        if isinstance(b, dict) and b.get('type') == 'text':
                            t = b.get('text')
                            if isinstance(t, str):
                                parts.append(t)
                    text = ''.join(parts)
                else:
                    text = ''
                if len(text.strip()) > 100:
                    print('USED')
                    raise SystemExit(0)
    except (OSError, IOError):
        continue
print('NOT_USED')
BOOTSTRAP_CHECK_PY`
  );

  if (realConvoCheck.stdout.trim() !== 'USED') {
    result.alreadyCorrect.push(
      'bootstrap (no substantive conversation yet, keeping BOOTSTRAP.md)',
    );
    return;
  }

  // Real conversation confirmed — safe to clean up.
  if (dryRun) {
    result.fixed.push('[dry-run] delete BOOTSTRAP.md + create .bootstrap_consumed + swap bot description');
    return;
  }

  await ssh.execCommand(`rm -f ${bootstrapFile} && touch ${flag}`);
  result.fixed.push('bootstrap cleanup (deleted BOOTSTRAP.md, created .bootstrap_consumed)');

  // Note (2026-05-22 amendment): post-conversation description swap MOVED
  // to the dedicated stepTelegramBotDescription step which runs on every
  // reconcile tick, gated by getMyDescription idempotency check. That step
  // handles BOTH the initial "waking up" description AND the post-bootstrap
  // "your personal AI agent" swap based on .bootstrap_consumed existence —
  // so it correctly serves pool-path VMs (which never run setup.sh §1.34)
  // and self-heals failures across cycles.
}

// ────────────────────────────────────────────────────────────────────
// 2026-05-22 — stepTelegramBotDescription (pool-path coverage gap fix)
// ────────────────────────────────────────────────────────────────────
//
// setup.sh §1.34 (commit 01098160) calls Telegram setMyDescription +
// setMyShortDescription to set the bot's profile text BEFORE the user
// sends their first message. That step lives in setup.sh, which runs
// ONLY on cloud-init VMs. Pool-path VMs (the ~95% common case for
// Edge attendees who hit a warm pool) never run setup.sh and therefore
// shipped with EMPTY bot descriptions — no "waking up" expectation-
// setting, nothing in bot profile.
//
// This step closes that gap. Runs on every reconcile tick for every
// telegram-channel VM. Idempotent via getMyDescription gate (skip
// setMyDescription if current text already matches expected). Handles
// both states automatically based on .bootstrap_consumed existence:
//
//   - .bootstrap_consumed ABSENT → set the FIRST-RUN description that
//     explains the cold-start delay ("i take a moment to wake up on
//     your first message...")
//   - .bootstrap_consumed PRESENT → set the permanent description
//     ("your personal AI agent. message me anytime.") — same swap that
//     stepBootstrapConsumed previously did inline; now centralized here
//     so it also self-heals if the first attempt failed.
//
// Telegram API limits: 30 calls/sec per bot token. We're well under
// (one bot per VM, one call per reconcile cycle gated by idempotency).
// short_description is set on every cycle only when getMyShortDescription
// differs — almost always once per VM lifetime.
//
// Channel-aware: skips entirely when telegram is not in vm.channels_enabled.
// Non-fatal: any failure leaves descriptions in their current state and
// retries next cycle.
const BOT_DESC_FIRST_RUN =
  "i take a moment to wake up on your first message — totally normal, just loading my brain. after that, responses are instant.";
const BOT_DESC_AFTER_FIRST_CONVO =
  "your personal AI agent. message me anytime.";
const BOT_SHORT_DESC =
  "your personal AI agent — powered by instaclaw";

async function stepTelegramBotDescription(
  ssh: SSHConnection,
  vm: { id: string; channels_enabled?: string[] | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Channel gate: only relevant for telegram-enabled VMs (default channel
  // list is ["telegram"] when null, so undefined falls through to enabled).
  const channels = vm.channels_enabled ?? ["telegram"];
  if (!channels.includes("telegram")) {
    result.alreadyCorrect.push("telegram bot description (not a telegram VM)");
    return;
  }

  // 1. Read bot token from .env
  const tokenRes = await ssh.execCommand(
    `grep '^TELEGRAM_BOT_TOKEN=' ~/.openclaw/.env | head -1 | cut -d= -f2- | tr -d '"'`,
  );
  const token = tokenRes.stdout.trim();
  if (!token) {
    // Pool VMs without telegram token (rare): nothing to do
    result.alreadyCorrect.push("telegram bot description (no bot token)");
    return;
  }

  // 2. Decide expected description based on bootstrap-consumed state
  const consumedCheck = await ssh.execCommand(
    `test -f ~/.openclaw/workspace/.bootstrap_consumed && echo CONSUMED || echo NOT_CONSUMED`,
  );
  const expectedDesc =
    consumedCheck.stdout.trim() === "CONSUMED"
      ? BOT_DESC_AFTER_FIRST_CONVO
      : BOT_DESC_FIRST_RUN;

  // 3. Idempotency gate: check current description via getMyDescription.
  //    If it matches expected, no POST needed.
  const getDescRes = await ssh.execCommand(
    `curl -sf -m 10 "https://api.telegram.org/bot${token}/getMyDescription" || echo ""`,
  );
  let currentDesc = "";
  try {
    const parsed = JSON.parse(getDescRes.stdout || "{}");
    if (parsed?.result?.description && typeof parsed.result.description === "string") {
      currentDesc = parsed.result.description;
    }
  } catch {
    // Tolerate parse failure — fall through to setMyDescription which
    // is idempotent server-side anyway.
  }

  const descMatches = currentDesc === expectedDesc;

  // 4. Same idempotency gate for short_description
  const getShortRes = await ssh.execCommand(
    `curl -sf -m 10 "https://api.telegram.org/bot${token}/getMyShortDescription" || echo ""`,
  );
  let currentShort = "";
  try {
    const parsed = JSON.parse(getShortRes.stdout || "{}");
    if (parsed?.result?.short_description && typeof parsed.result.short_description === "string") {
      currentShort = parsed.result.short_description;
    }
  } catch {
    // Tolerate parse failure
  }
  const shortMatches = currentShort === BOT_SHORT_DESC;

  if (descMatches && shortMatches) {
    result.alreadyCorrect.push("telegram bot description (already current)");
    return;
  }

  if (dryRun) {
    result.fixed.push(
      `[dry-run] would update bot descriptions ` +
        `(desc match=${descMatches}, short match=${shortMatches})`,
    );
    return;
  }

  // 5. Set whichever fields are out of date. Single-quote escape needed
  //    inside the JSON payload — bash single-quoted strings can't contain
  //    single quotes. Use jq-free escape: '\'' breaks the literal, inserts
  //    escaped quote, resumes literal.
  if (!descMatches) {
    const descBodyJson = JSON.stringify({ description: expectedDesc });
    const escapedDescBody = descBodyJson.replace(/'/g, "'\\''");
    await ssh.execCommand(
      `curl -sf -m 10 -X POST "https://api.telegram.org/bot${token}/setMyDescription" ` +
        `-H "Content-Type: application/json" ` +
        `-d '${escapedDescBody}' > /dev/null 2>&1 || true`,
    );
  }
  if (!shortMatches) {
    const shortBodyJson = JSON.stringify({ short_description: BOT_SHORT_DESC });
    const escapedShortBody = shortBodyJson.replace(/'/g, "'\\''");
    await ssh.execCommand(
      `curl -sf -m 10 -X POST "https://api.telegram.org/bot${token}/setMyShortDescription" ` +
        `-H "Content-Type: application/json" ` +
        `-d '${escapedShortBody}' > /dev/null 2>&1 || true`,
    );
  }

  const which =
    consumedCheck.stdout.trim() === "CONSUMED"
      ? "post-conversation"
      : "first-run";
  result.fixed.push(`telegram bot description (${which})`);
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
    // Rule 39: Remotion (motion-graphics) is opt-in. Failure breaks that one
    // skill only; gateway + other workflows unaffected. Warning so cv-bump
    // proceeds; persistent failure remains visible in admin_alert_log.
    recordHealWarning(result, `remotion deps install failed: ${install.stderr?.slice(0, 200) || install.stdout?.slice(-200)}`);
    return;
  }

  result.fixed.push('remotion deps (npm install in motion-graphics template)');
}

/**
 * Step 3c: Detect & fix drift on globally-pinned npm packages — @bankr/cli,
 * openclaw, @worldcoin/agentkit-cli — plus install/heal the unpinned globals
 * mcporter and usecomputer that the snapshot bake should produce but
 * empirically doesn't (verified 2026-05-14 against vm-944).
 *
 * Pins live in lib/ssh.ts (BANKR_CLI_PINNED_VERSION, OPENCLAW_PINNED_VERSION,
 * AGENTKIT_CLI_PINNED_VERSION). Without this step, bumping a pin requires a
 * manual fleet patch.
 *
 * Five independent inline checks (no generic abstraction):
 *   - bankr: pinned-version compare + reinstall, no service restart needed
 *   - openclaw: same pattern, but ALSO updates ~/.openclaw/.openclaw-pinned-version
 *     before the install (so vm-watchdog doesn't revert the upgrade as
 *     "unauthorized") and marks gatewayRestartNeeded so the new binary loads
 *     into the running gateway via the existing Step 9 restart path.
 *   - @worldcoin/agentkit-cli: pinned-version compare + reinstall. Closes
 *     fleet-wide gap (2026-05-14 audit): the package has been MISSING on
 *     every existing VM because configureOpenClaw's parallel-install at
 *     ssh.ts:7055 used `|| true` which silently swallowed every install
 *     failure. AgentBook registration impossible without it.
 *   - mcporter: presence check (no version pin — match BE-11 + ssh.ts
 *     unpinned behavior). Closes fleet-wide gap: ssh.ts:5583 says
 *     "mcporter is pre-installed globally" which is empirically false.
 *     The clawlancer SKILL.md (shipped 2026-05-14 via BE-8 to every VM
 *     via stepSkills) instructs the agent to call `mcporter call
 *     clawlancer.<tool>` — without mcporter installed, every Clawlancer
 *     marketplace interaction silently fails.
 *   - usecomputer: presence check + post-install chmod +x on the prebuilt
 *     linux-x64 binary (npm doesn't set the executable bit on prebuilt
 *     binaries; matches ssh.ts:7110-7113). Required for dispatch mode
 *     (browser automation).
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

  // ── @worldcoin/agentkit-cli pin ──
  //
  // 2026-05-14 (BE-11 follow-up): existing fleet is missing agentkit-cli
  // because configureOpenClaw's parallel-install at lib/ssh.ts:7055 used
  // `|| true` which silently swallowed every install failure. Without
  // agentkit-cli, AgentBook registration is impossible (the
  // `mcporter call clawlancer.register_agent` flow depends on it).
  //
  // Match the @bankr/cli pattern: version compare via npm ls (the
  // package doesn't reliably install a binary called `agentkit` or
  // `agentkit-cli` on PATH, so `npm ls -g` is the canonical probe).
  // Manually verified 2026-05-14 on vm-944: install completes in ~11s,
  // verify-grep succeeds, no service restart needed.
  const agentkitCurr = (await ssh.execCommand(
    `${NVM_PREAMBLE} && npm ls -g @worldcoin/agentkit-cli --depth=0 2>/dev/null | grep -oE "@worldcoin/agentkit-cli@[0-9.]+" | head -1 | sed "s|^@worldcoin/agentkit-cli@||" || true`,
  )).stdout.trim();

  if (agentkitCurr === AGENTKIT_CLI_PINNED_VERSION) {
    result.alreadyCorrect.push(`@worldcoin/agentkit-cli (${AGENTKIT_CLI_PINNED_VERSION})`);
  } else if (dryRun) {
    result.fixed.push(`[dry-run] @worldcoin/agentkit-cli ${agentkitCurr || "missing"} → ${AGENTKIT_CLI_PINNED_VERSION}`);
  } else {
    const install = await ssh.execCommand(
      `${NVM_PREAMBLE} && npm install -g @worldcoin/agentkit-cli@${AGENTKIT_CLI_PINNED_VERSION} 2>&1 | tail -5`,
      { execOptions: { timeout: 180_000 } },
    );
    const verify = (await ssh.execCommand(
      `${NVM_PREAMBLE} && npm ls -g @worldcoin/agentkit-cli --depth=0 2>/dev/null | grep -oE "@worldcoin/agentkit-cli@[0-9.]+" | head -1 | sed "s|^@worldcoin/agentkit-cli@||"`,
    )).stdout.trim();
    if (verify === AGENTKIT_CLI_PINNED_VERSION) {
      result.fixed.push(`@worldcoin/agentkit-cli ${agentkitCurr || "missing"} → ${AGENTKIT_CLI_PINNED_VERSION}`);
    } else {
      result.errors.push(
        `@worldcoin/agentkit-cli install failed: was=${agentkitCurr || "missing"} got=${verify || "(empty)"} npm-tail=${(install.stdout + install.stderr).slice(-200)}`,
      );
    }
  }

  // ── mcporter presence ──
  //
  // 2026-05-14 (BE-11 follow-up): existing fleet is missing mcporter.
  // configureOpenClaw has no explicit install — lib/ssh.ts:5583 says
  // "mcporter is pre-installed globally on all VMs" which is empirically
  // false (verified on vm-944 cv=0 AND vm-050 cv=95 — neither has the
  // package). The clawlancer SKILL.md committed in BE-8 instructs the
  // agent to call `mcporter call clawlancer.<tool>` everywhere; without
  // mcporter installed, EVERY Clawlancer marketplace interaction fails
  // silently with "command not found" — that's the load-bearing fix
  // this block ships fleet-wide.
  //
  // Unpinned (matches BE-11 setup.sh + lib/ssh.ts's implicit-install
  // assumption). Idempotency check is presence-via-`npm ls -g`, not
  // version compare. Install completes in ~9s on vm-944.
  const mcporterPresent = (await ssh.execCommand(
    `${NVM_PREAMBLE} && npm ls -g mcporter --depth=0 2>/dev/null | grep -q "mcporter@" && echo YES || echo NO`,
  )).stdout.trim();

  if (mcporterPresent === "YES") {
    result.alreadyCorrect.push("mcporter (present)");
  } else if (dryRun) {
    result.fixed.push("[dry-run] mcporter missing → install");
  } else {
    const install = await ssh.execCommand(
      `${NVM_PREAMBLE} && npm install -g mcporter 2>&1 | tail -5`,
      { execOptions: { timeout: 180_000 } },
    );
    const verify = (await ssh.execCommand(
      `${NVM_PREAMBLE} && npm ls -g mcporter --depth=0 2>/dev/null | grep -q "mcporter@" && echo YES || echo NO`,
    )).stdout.trim();
    if (verify === "YES") {
      result.fixed.push("mcporter installed");
    } else {
      result.errors.push(
        `mcporter install failed: npm-tail=${(install.stdout + install.stderr).slice(-200)}`,
      );
    }
  }

  // ── usecomputer presence (+ post-install chmod) ──
  //
  // 2026-05-14 (BE-11 follow-up): same masked-failure pattern as the
  // other two — lib/ssh.ts:7109 uses `|| true`. Required for dispatch
  // mode (browser automation).
  //
  // Post-install: chmod +x the prebuilt linux-x64 binary at
  //   $HOME/.nvm/versions/node/<v>/lib/node_modules/usecomputer/dist/linux-x64/usecomputer
  // because npm does NOT set the executable bit on prebuilt binaries.
  // Manually verified 2026-05-14 on vm-944: install lands binary with
  // mode 0664, chmod +x changes it to 0775. Matches ssh.ts:7110-7113.
  //
  // We do NOT chmod on the alreadyCorrect path. If usecomputer was
  // previously installed and the binary's +x bit somehow got reset
  // (rare), the agent's dispatch calls will fail and the operator
  // intervenes. Idempotent chmod on every cycle adds noise to the
  // reconcile log for negligible defense.
  const usecomputerPresent = (await ssh.execCommand(
    `${NVM_PREAMBLE} && npm ls -g usecomputer --depth=0 2>/dev/null | grep -q "usecomputer@" && echo YES || echo NO`,
  )).stdout.trim();

  if (usecomputerPresent === "YES") {
    result.alreadyCorrect.push("usecomputer (present)");
  } else if (dryRun) {
    result.fixed.push("[dry-run] usecomputer missing → install + chmod prebuilt binary");
  } else {
    const install = await ssh.execCommand(
      `${NVM_PREAMBLE} && npm install -g usecomputer 2>&1 | tail -5`,
      { execOptions: { timeout: 180_000 } },
    );
    const verify = (await ssh.execCommand(
      `${NVM_PREAMBLE} && npm ls -g usecomputer --depth=0 2>/dev/null | grep -q "usecomputer@" && echo YES || echo NO`,
    )).stdout.trim();
    if (verify === "YES") {
      // chmod +x the prebuilt linux-x64 binary. Best-effort: log warning
      // on failure but don't fail the install (the missing chmod only
      // affects dispatch-mode invocations, not the gateway itself).
      const chmod = await ssh.execCommand(
        `${NVM_PREAMBLE} && NODE_VER=$(node --version) && UC_BIN="$HOME/.nvm/versions/node/$NODE_VER/lib/node_modules/usecomputer/dist/linux-x64/usecomputer" && [ -f "$UC_BIN" ] && chmod +x "$UC_BIN" && echo CHMOD_OK || echo CHMOD_MISS`,
      );
      if (chmod.stdout.includes("CHMOD_OK")) {
        result.fixed.push("usecomputer installed (+ chmod +x prebuilt binary)");
      } else {
        // Install succeeded but the prebuilt binary path didn't exist.
        // The usecomputer package's directory layout may have changed
        // upstream; the package itself is functional but dispatch may
        // need a different binary entry point. Worth logging but not
        // failing the step.
        result.fixed.push("usecomputer installed (chmod skipped — prebuilt binary path missing)");
        logger.warn("usecomputer chmod path miss — package layout may have changed upstream", {
          route: "lib/vm-reconcile.stepNpmPinDrift",
          chmodStdout: chmod.stdout.slice(0, 200),
        });
      }
    } else {
      result.errors.push(
        `usecomputer install failed: npm-tail=${(install.stdout + install.stderr).slice(-200)}`,
      );
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
// ─── stepPiAiReasoningPatch (v112) ────────────────────────────────────────
//
// Idempotently patches pi-ai's openai-codex-responses.js to call into the
// reasoning router when options.reasoningEffort is undefined. Survives
// OpenClaw upgrades — the reconciler re-applies on every cycle if the
// sentinel is missing (e.g., after stepNpmPinDrift re-installed OpenClaw).
//
// The patch is a TWO-SITE insertion:
//   A. After the `const DEFAULT_CODEX_BASE_URL = ...` import-block end:
//      adds a top-level createRequire load of the router into a module-
//      scoped _instaclawRouter variable.
//   B. In `buildRequestBody`, after the existing `if (options?.reasoningEffort
//      !== undefined) { ... }` block: adds an `else if (_instaclawRouter)`
//      branch that extracts the latest user message, classifies it via
//      router.classifyMessage(), and sets body.reasoning accordingly. The
//      else-branch wraps the entire router call in try/catch so router
//      failures NEVER block a request (falls back to OpenClaw's default).
//
// Both insertions are gated by the INSTACLAW_REASONING_ROUTER_V1 sentinel.
// If the sentinel is already in the file, the step is a no-op (alreadyCorrect).
// If pi-ai's source has changed enough that the anchor strings don't match,
// the step pushes a warning (not an error) so cv-bump isn't blocked — the
// patch can be re-anchored manually in a follow-up.
//
// Backup is created at .pre-router.bak on first apply. Verification post-
// write includes: sentinel count (must be ≥ 2), Node syntax check via
// `node --check`. On syntax failure, the .pre-router.bak is restored
// (Rule 22 — never leave a customer's pi-ai in a broken state).
//
// Sets result.gatewayRestartNeeded = true on first apply (Node caches
// module imports — the patched file needs a fresh import which only happens
// on gateway restart).
//
// Sentinel: INSTACLAW_REASONING_ROUTER_V1 (matches what's emitted into the
// patched file by both insertions). Counted twice — once at top of file,
// once in the else-branch's comment.
async function stepPiAiReasoningPatch(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  const TARGET =
    "/home/openclaw/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/providers/openai-codex-responses.js";
  const SENTINEL = "INSTACLAW_REASONING_ROUTER_V1";

  // 1. Cheap sentinel check — skip if already patched.
  const checkRes = await ssh.execCommand(
    `grep -c "${SENTINEL}" ${TARGET} 2>/dev/null || echo 0`,
  );
  const count = parseInt(checkRes.stdout.trim(), 10);
  if (count >= 2) {
    result.alreadyCorrect.push("pi-ai-reasoning-router-patch (sentinel present)");
    return;
  }

  if (dryRun) {
    result.fixed.push("[dry-run] pi-ai-reasoning-router-patch: would apply");
    return;
  }

  // 2. Read source.
  const readRes = await ssh.execCommand(`cat ${TARGET}`);
  if (readRes.code !== 0 || !readRes.stdout) {
    // pi-ai not installed yet (fresh VM before stepNpmPinDrift completed) —
    // warning, not error. Will retry next cycle once pi-ai lands.
    result.warnings.push(
      `pi-ai-reasoning-router-patch: target missing or unreadable (${TARGET})`,
    );
    return;
  }
  const src = readRes.stdout;

  // 3. Anchors — must match byte-for-byte in pi-ai's current dist.
  const ANCHOR_AFTER_IMPORTS =
    'const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";';
  const ANCHOR_REASONING_BLOCK = [
    '    if (options?.reasoningEffort !== undefined) {',
    '        body.reasoning = {',
    '            effort: clampReasoningEffort(model.id, options.reasoningEffort),',
    '            summary: options.reasoningSummary ?? "auto",',
    '        };',
    '    }',
  ].join("\n");

  if (!src.includes(ANCHOR_AFTER_IMPORTS) || !src.includes(ANCHOR_REASONING_BLOCK)) {
    // pi-ai source changed — warn (don't block cv-bump) so the patch can
    // be re-anchored in a follow-up commit.
    result.warnings.push(
      `pi-ai-reasoning-router-patch: anchors not found in ${TARGET} — pi-ai source likely changed; re-anchor needed`,
    );
    return;
  }

  // 4. Construct patched content. Both injections include the sentinel.
  const INJECT_TOP = [
    "",
    `// ${SENTINEL} — load router from canonical script path.`,
    "// Falls back silently if absent. Router decides effort when options doesn't set one.",
    'import { createRequire as _instaclawCreateRequire } from "node:module";',
    "let _instaclawRouter = null;",
    "try {",
    "    const _ir = _instaclawCreateRequire(import.meta.url);",
    '    _instaclawRouter = _ir("/home/openclaw/.openclaw/scripts/reasoning-router.js");',
    "} catch (_e) { _instaclawRouter = null; }",
    "",
  ].join("\n");

  const INJECT_REASONING_REPLACEMENT = [
    '    if (options?.reasoningEffort !== undefined) {',
    '        body.reasoning = {',
    '            effort: clampReasoningEffort(model.id, options.reasoningEffort),',
    '            summary: options.reasoningSummary ?? "auto",',
    '        };',
    '    } else if (_instaclawRouter && typeof _instaclawRouter.classifyMessage === "function") {',
    `        // ${SENTINEL} — route reasoning effort by message content.`,
    "        try {",
    "            const _userMsg = _instaclawRouter.extractLatestUserMessage(context?.input);",
    "            if (_userMsg) {",
    "                const _decision = _instaclawRouter.classifyMessage(_userMsg, {",
    "                    modelId: model.id,",
    "                    sessionId: options?.sessionId,",
    "                });",
    "                if (_decision && _decision.effort) {",
    "                    body.reasoning = {",
    "                        effort: clampReasoningEffort(model.id, _decision.effort),",
    '                        summary: options?.reasoningSummary ?? "auto",',
    "                    };",
    "                }",
    "            }",
    "        } catch (_e) { /* router failure must never block the request */ }",
    "    }",
  ].join("\n");

  let patched = src.replace(
    ANCHOR_AFTER_IMPORTS,
    ANCHOR_AFTER_IMPORTS + INJECT_TOP,
  );
  patched = patched.replace(
    ANCHOR_REASONING_BLOCK,
    INJECT_REASONING_REPLACEMENT,
  );

  // 5. Sentinel-count + brace-balance pre-write verification.
  const sentinelCount = (patched.match(new RegExp(SENTINEL, "g")) || []).length;
  if (sentinelCount < 2) {
    result.errors.push(
      `pi-ai-reasoning-router-patch: post-patch sentinel count is ${sentinelCount}, expected ≥ 2`,
    );
    return;
  }
  const openBraces = (patched.match(/\{/g) || []).length;
  const closeBraces = (patched.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    result.errors.push(
      `pi-ai-reasoning-router-patch: post-patch brace imbalance (${openBraces} vs ${closeBraces})`,
    );
    return;
  }

  // 6. Backup + atomic write via base64 (avoids shell-escaping the JS body).
  const b64 = Buffer.from(patched, "utf-8").toString("base64");
  const writeRes = await ssh.execCommand(
    `cp ${TARGET} ${TARGET}.pre-router.bak 2>/dev/null || true; ` +
      `echo '${b64}' | base64 -d > ${TARGET}.tmp && mv ${TARGET}.tmp ${TARGET}`,
  );
  if (writeRes.code !== 0) {
    result.errors.push(
      `pi-ai-reasoning-router-patch: write failed: ${(writeRes.stderr || writeRes.stdout).slice(0, 200)}`,
    );
    return;
  }

  // 7. Verify-after-write (Rule 10) — sentinel must be present on disk.
  const verifyRes = await ssh.execCommand(`grep -c "${SENTINEL}" ${TARGET}`);
  const verifyCount = parseInt(verifyRes.stdout.trim(), 10);
  if (verifyCount < 2) {
    result.errors.push(
      `pi-ai-reasoning-router-patch: post-write sentinel count is ${verifyCount}, expected ≥ 2`,
    );
    return;
  }

  // 8. Syntax check via node --check. On failure: rollback from backup
  // (Rule 22 — never leave the customer's pi-ai broken).
  const syntaxRes = await ssh.execCommand(
    `${NVM_PREAMBLE} && node --check ${TARGET} 2>&1`,
  );
  if (syntaxRes.code !== 0) {
    // ROLLBACK
    await ssh.execCommand(`cp ${TARGET}.pre-router.bak ${TARGET}`);
    result.errors.push(
      `pi-ai-reasoning-router-patch: node --check failed, rolled back to .pre-router.bak: ${syntaxRes.stdout.slice(0, 200)}`,
    );
    return;
  }

  result.fixed.push("pi-ai-reasoning-router-patch: applied");
  // Node caches module imports — the gateway must restart to re-import
  // the patched file. Per Rule 32 / Rule 58.
  result.gatewayRestartNeeded = true;
  logger.info("PI_AI_REASONING_ROUTER_PATCH_APPLIED", {
    route: "vm-reconcile",
    target: TARGET,
    sentinel: SENTINEL,
  });
}

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
  // ── PHASE 1: REMOVE entries listed in cronJobsRemove[] ──
  // (v114, 2026-05-23 — Cooper outage debug)
  //
  // Runs FIRST so we don't accidentally add a new entry only to
  // remove it on the same tick. Idempotent: re-reads crontab,
  // filters out lines matching any remove-marker, rewrites only
  // if changes detected, verify-after-write per Rule 23.
  //
  // Field is typed as `string[]` so an empty array short-circuits
  // cleanly without breaking older VMs that don't have any
  // removed-cron lines.
  const removeMarkers = manifest.cronJobsRemove ?? [];
  if (removeMarkers.length > 0) {
    const beforeRes = await ssh.execCommand(
      `crontab -l 2>/dev/null`,
    );
    const beforeLines = beforeRes.stdout.split("\n");
    const afterLines = beforeLines.filter(
      (line: string) => !removeMarkers.some((m: string) => line.includes(m)),
    );
    const removedCount = beforeLines.length - afterLines.length;
    if (removedCount > 0) {
      if (dryRun) {
        result.fixed.push(
          `[dry-run] cronJobsRemove: would remove ${removedCount} line(s)`,
        );
      } else {
        // crontab REQUIRES trailing newline before EOF or it rejects
        // the install — bug Cooper hit on 2026-05-23 fleet-push.
        const newCrontab = afterLines.join("\n").replace(/\n*$/, "\n");
        // Use stdin redirection via a here-doc through ssh.execCommand.
        // node-ssh's execCommand accepts `stdin` option for this.
        const installRes = await ssh.execCommand("crontab -", {
          stdin: newCrontab,
        });
        if (installRes.code !== 0) {
          result.errors.push(
            `cronJobsRemove install failed: ${installRes.stderr.slice(0, 200)}`,
          );
          // Don't continue — if we can't remove, we shouldn't add either
          // (might re-add removed entries in PHASE 2 below).
          return;
        }
        // Verify per Rule 23: re-read crontab, confirm no remove-marker
        // line survived. Treat any survival as an error (cv-bump gate).
        const verifyRes = await ssh.execCommand(`crontab -l 2>/dev/null`);
        const survivors = removeMarkers.filter((m) =>
          verifyRes.stdout.includes(m),
        );
        if (survivors.length > 0) {
          result.errors.push(
            `cronJobsRemove verify FAILED — still present: ${survivors.join(
              ",",
            )}`,
          );
          return;
        }
        result.fixed.push(
          `cronJobsRemove: removed ${removedCount} line(s) (${removeMarkers.join(",")})`,
        );
      }
    } else {
      result.alreadyCorrect.push(
        `cronJobsRemove: clean (${removeMarkers.length} markers checked)`,
      );
    }
  }

  // ── PHASE 2: ADD entries listed in cronJobs[] ── (existing behavior)
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
        // Rule 39: per-package install skipped. Outer catch (below) stays
        // HARD for whole-try throws. A single non-critical package (jq,
        // build-essential, etc.) shouldn't block cv on everything that DID
        // succeed in this cycle.
        recordHealWarning(result, `${pkg}: install skipped (no sudo or apt-get failed)`);
      }
    }
  } catch (err) {
    result.errors.push(`system packages: ${String(err)}`);
  }
}

/**
 * Pinned crawlee version — the web-search-browser skill is written against
 * the crawlee 1.x API; crawlee 2.x ships a breaking change. Mirrors the
 * cloud-init BE-10 setup.sh pin at lib/cloud-init-setup-sh.ts (committed
 * 2a18c0da). Keep both call sites in sync when bumping.
 */
const CRAWLEE_PINNED_VERSION = "1.5.0";
const CRAWLEE_PIP_INSTALL_ARG = `crawlee[beautifulsoup,playwright]==${CRAWLEE_PINNED_VERSION}`;

/**
 * BE-10 fleet-heal Python package list — §17b.2 audit packages that
 * configureOpenClaw's parallel installs at lib/ssh.ts:7035-7051 silently
 * dropped (via `|| true`) for every fleet VM. Unpinned: presence check only.
 * crawlee is handled separately above because it needs exact-version verify.
 *
 * Without these:
 *   - prediction-markets (Polymarket / Kalshi): trade calls fail (web3,
 *     py-clob-client, eth-account, websockets, cryptography)
 *   - AgentBook registration: impossible (web3 + eth-account)
 *   - solana-defi: Solana RPC calls fail (solders, base58, httpx)
 *
 * Match the cloud-init BE-10 setup.sh ordering for byte-parity.
 */
const BE10_UNPINNED_PYTHON_PACKAGES: readonly string[] = [
  "web3", "py-clob-client", "eth-account", "websockets", "cryptography",
  "solders", "base58", "httpx",
] as const;

async function stepPythonPackages(
  ssh: SSHConnection,
  manifest: typeof VM_MANIFEST,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // ── Block 1: manifest.pythonPackages (just "openai" today) ──
  const packages = manifest.pythonPackages as readonly string[];
  if (packages.length > 0) {
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

  // ── Block 2: BE-10 fleet heal — §17b.2 Python packages (2026-05-15) ──
  //
  // Fleet-heal counterpart to cloud-init Day 8b BE-10 (commit 2a18c0da).
  // BE-10 added these to setup.sh for NEW cloud-init VMs; this block
  // covers the EXISTING fleet that has been missing them since
  // configureOpenClaw's `|| true` parallel pip installs silently swallowed
  // every install failure for the lifetime of the fleet.
  //
  // Pattern (mirrors bb12558d's stepNpmPinDrift extension):
  //   - crawlee: exact-version probe (`pip show | grep "^Version: 1.5.0$"`)
  //     + install with extras [beautifulsoup,playwright] + verify after
  //   - 8 unpinned packages: per-package presence probe (`pip show`
  //     exit code) + install + verify
  //
  // Each install command wrapped in `timeout` to bound worst-case (crawlee
  // can be slow if playwright fetches Chromium); execOptions timeout
  // bumped slightly above the bash timeout so the inner sentinel reaches
  // us before node-ssh's default 60s wall-clock cuts in.
  //
  // Failure classification: result.errors (matches stepNpmPinDrift —
  // a persistent install failure should block cv bump until it succeeds
  // on a subsequent reconcile cycle; transient network issues retry
  // automatically).
  try {
    // crawlee — pinned 1.5.0 with extras. Idempotent via exact-version grep.
    const crawleeCurr = (await ssh.execCommand(
      `python3 -m pip show crawlee 2>/dev/null | grep "^Version:" | awk '{print $2}' || true`,
    )).stdout.trim();

    if (crawleeCurr === CRAWLEE_PINNED_VERSION) {
      result.alreadyCorrect.push(`python: crawlee (${CRAWLEE_PINNED_VERSION})`);
    } else if (dryRun) {
      result.fixed.push(`[dry-run] python: crawlee ${crawleeCurr || "missing"} → ${CRAWLEE_PINNED_VERSION}`);
    } else {
      const install = await ssh.execCommand(
        `timeout 300 python3 -m pip install --quiet --break-system-packages "${CRAWLEE_PIP_INSTALL_ARG}" 2>&1 | tail -3`,
        { execOptions: { timeout: 320_000 } },
      );
      const verify = (await ssh.execCommand(
        `python3 -m pip show crawlee 2>/dev/null | grep "^Version:" | awk '{print $2}'`,
      )).stdout.trim();
      if (verify === CRAWLEE_PINNED_VERSION) {
        result.fixed.push(`python: crawlee ${crawleeCurr || "missing"} → ${CRAWLEE_PINNED_VERSION}`);
      } else {
        // Rule 39: crawlee is used by web-scraping skill (partner-gated /
        // opt-in). PyPI / Chromium download flap is a known transient.
        // Warning so cv-bump proceeds; cron retries naturally next cycle.
        recordHealWarning(result,
          `python: crawlee install failed: was=${crawleeCurr || "missing"} got=${verify || "(empty)"} pip-tail=${(install.stdout + install.stderr).slice(-200)}`,
        );
      }
    }

    // Unpinned packages — per-package probe + install + verify.
    for (const pkg of BE10_UNPINNED_PYTHON_PACKAGES) {
      const probe = await ssh.execCommand(
        `python3 -m pip show ${pkg} >/dev/null 2>&1 && echo OK || echo MISSING`,
      );
      if (probe.stdout.includes("OK")) {
        result.alreadyCorrect.push(`python: ${pkg}`);
        continue;
      }
      if (dryRun) {
        result.fixed.push(`[dry-run] python: pip install ${pkg}`);
        continue;
      }
      const install = await ssh.execCommand(
        `timeout 180 python3 -m pip install --quiet --break-system-packages ${pkg} 2>&1 | tail -3`,
        { execOptions: { timeout: 200_000 } },
      );
      const verify = await ssh.execCommand(
        `python3 -m pip show ${pkg} >/dev/null 2>&1 && echo OK || echo MISSING`,
      );
      if (verify.stdout.includes("OK")) {
        result.fixed.push(`python: ${pkg} (installed)`);
      } else {
        // Rule 39: BE-10 unpinned packages (httpx, etc.) are partner-script
        // dependencies. On non-partner VMs they have zero customer impact;
        // on partner VMs the scripts fail gracefully at script-run time. The
        // 2026-05-16 vm-356 case: cv held at 99 over an httpx pip flap,
        // blocking v100 RuntimeMaxSec removal that DOES affect every VM.
        recordHealWarning(result,
          `python: ${pkg} install failed: pip-tail=${(install.stdout + install.stderr).slice(-200)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`python packages BE-10: ${String(err)}`);
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

  // Rebuild auth-profiles.json for all-inclusive VMs.
  //
  // Preserve any non-anthropic profiles that already exist (e.g.,
  // openai-codex:default written by stepChatGPTOAuthToken — Day 11-15).
  // Without this, the rebuild wiped the OAuth profile on every gateway
  // token rotation, leaving ChatGPT-connected users silently routed back
  // to Claude until the next reconciler tick re-pushed the OAuth profile.
  // Audit finding from Day 2.5 review.
  const authProfileData: Record<string, unknown> = {
    type: "api_key",
    provider: "anthropic",
    key: vm.gateway_token,
    baseUrl: expectedProxyBaseUrl,
  };
  let existingProfiles: Record<string, unknown> = {};
  if (authReadResult.code === 0 && authReadResult.stdout.trim()) {
    try {
      const existing = JSON.parse(authReadResult.stdout) as { profiles?: Record<string, unknown> };
      if (existing.profiles && typeof existing.profiles === "object") {
        existingProfiles = existing.profiles;
      }
    } catch {
      // Existing file was unparseable — fall through to clean rebuild
      // (this is the original behavior; we only PRESERVE on parseable input).
    }
  }
  const mergedProfiles = {
    ...existingProfiles,
    "anthropic:default": authProfileData,
  };
  const authProfile = JSON.stringify({ profiles: mergedProfiles });
  const authB64 = Buffer.from(authProfile).toString("base64");
  await ssh.execCommand(
    `mkdir -p ~/.openclaw/agents/main/agent && echo '${authB64}' | base64 -d > ~/.openclaw/agents/main/agent/auth-profiles.json`
  );
  const preservedKeys = Object.keys(existingProfiles).filter((k) => k !== "anthropic:default");
  const preservedNote = preservedKeys.length > 0 ? ` [preserved: ${preservedKeys.join(",")}]` : "";
  result.fixed.push(`auth-profiles.json (${fixReason})${preservedNote}`);

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

  // Rule 43 — Dynamic cold-boot wait scales with plugin count.
  //
  // The fixed 120s budget (24 × 5s) was set on 2026-04-29 for the v66→v67
  // starter/pro/power pass, where vm-568 + vm-858 reached "active" + /health
  // 200 within ~80s. That budget is sufficient for typical 2-4 plugin VMs but
  // can false-negative on edge_city VMs with more plugins — vm-901 (~8
  // plugins) was a documented case where the gateway came up shortly after
  // the 120s timeout and the cv was held with a "gateway restart failed"
  // error even though everything actually worked.
  //
  // Empirical sample from vm-354 (edge_city, soaked 2026-05-16): 4 plugins
  // enabled (telegram, brave, anthropic, browser). Other partner cohorts
  // (matchpool, consensus, dgclaw) may push higher. Formula:
  //   wait = clamp(120, 30 + plugins * 15, 180)
  //   - 4 plugins → 120s (24 iter)  — current behavior preserved
  //   - 6 plugins → 120s (24 iter)
  //   - 8 plugins → 150s (30 iter)
  //   - 10+ plugins → 180s (36 iter) — capped to leave headroom inside the
  //     strict-mode 180s deadline (STRICT_DEADLINE_MS at line 184) and below
  //     Vercel's 300s function-timeout ceiling.
  //
  // Failure mode: if the plugin-count probe fails (jq missing, JSON
  // malformed, SSH transient), fall back to 24 iterations — exactly the old
  // behavior. Never worse than what we had.
  let healthAttempts = 24; // 120s default — matches pre-Rule-43 behavior
  let pluginCount = 0;
  try {
    const pluginRes = await ssh.execCommand(
      `${DBUS_PREFIX} && jq '[.plugins.entries[]? | select(.enabled == true)] | length' ~/.openclaw/openclaw.json 2>/dev/null`,
      { execOptions: { timeout: 5_000 } } as any,
    );
    const parsed = parseInt((pluginRes.stdout || "0").trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      pluginCount = parsed;
      const waitSeconds = Math.min(180, Math.max(120, 30 + pluginCount * 15));
      healthAttempts = Math.ceil(waitSeconds / 5);
    }
  } catch { /* fall back to 24 */ }
  const waitBudgetSeconds = healthAttempts * 5;

  if (pluginCount > 0) {
    logger.info("stepGatewayRestart: dynamic wait budget", {
      route: "reconcileVM",
      vmId: vm.id,
      pluginCount,
      waitBudgetSeconds,
    });
  }

  let healthy = false;
  for (let attempt = 0; attempt < healthAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const healthCheck = await ssh.execCommand('curl -sf http://localhost:18789/health 2>/dev/null');
    if (healthCheck.code === 0) {
      healthy = true;
      break;
    }
  }

  result.gatewayHealthy = healthy;

  if (healthy) {
    result.fixed.push(
      pluginCount > 0
        ? `gateway restarted (verified healthy; budget=${waitBudgetSeconds}s for ${pluginCount} plugins)`
        : 'gateway restarted (verified healthy)'
    );
  } else {
    logger.error("Gateway not healthy after reconcile restart — health cron will handle recovery", {
      route: "reconcileVM",
      vmId: vm.id,
      waitBudgetSeconds,
      pluginCount,
    });
    result.errors.push(`gateway restart failed: not healthy after ${waitBudgetSeconds}s (plugins=${pluginCount})`);
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
    // Rule 39: sshd OOM-protection drop-in is defense-in-depth. Failure
    // leaves sshd at the same oom-killer risk it had before this step ran
    // — zero regression vs current state. Warning so cv-bump proceeds.
    recordHealWarning(result, `sshd OOM protection failed: ${deployResult.stderr}`);
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
    // Rule 39: legacy pre-V2 memory-layout cleanup. No-op on most VMs.
    // Failure = a few KB of stale files persist. Zero customer impact.
    recordHealWarning(result, `memory cleanup failed: ${cleanResult.stderr}`);
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
    // Rule 39: Caddy UI redirect (vm-public-hostname → instaclaw.io/dashboard).
    // NOT the customer message-path (gateway:18789 is separate). Failure =
    // visitor sees legacy Block Control UI instead of the redirect.
    recordHealWarning(result, "caddy: could not parse hostname from Caddyfile");
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
    // Rule 39: UI-only redirect. See note above on stepCaddyUIBlock failure mode.
    recordHealWarning(result, `caddy: failed to write Caddyfile: ${writeResult.stderr}`);
    return;
  }

  // Reload Caddy (zero downtime)
  const reloadResult = await ssh.execCommand("sudo systemctl reload caddy 2>/dev/null");
  if (reloadResult.code !== 0) {
    // Rule 39: UI-only redirect. See note above on stepCaddyUIBlock failure mode.
    recordHealWarning(result, `caddy: reload failed: ${reloadResult.stderr}`);
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
 * Step 8i2: External-skill heal — bankr overlay + clanker/base subdir
 * delete + consensus-2026 clone + cron + (edge_city) edge-esmeralda
 * clone + cron.
 *
 * Fleet-heal counterpart to cloud-init Day 8b BE-5 (commit 5612bddf).
 * BE-5 added these to setup.sh for NEW cloud-init VMs; this step heals
 * the EXISTING fleet that's been missing them since the snapshot bake
 * pattern took hold.
 *
 * Gaps this step closes (verified empirically on vm-944 2026-05-14
 * AND vm-050 cv=95 paying customer):
 *
 *   - Bankr overlay: snapshot pre-clones bankr but does NOT apply
 *     the INSTACLAW_BANKR_PATCH_V1 overlay. EVERY existing VM today
 *     lacks the marker — the agent gets the upstream bankr/SKILL.md
 *     without InstaClaw's routing context → `bankr launch` may
 *     misroute (Doug-class incident hazard).
 *   - Bankr subdirs: snapshot pre-clones bankr WITH the clanker
 *     and base subdirs. clanker requires PRIVATE_KEY not configured
 *     on InstaClaw VMs; base is an empty placeholder. Both confuse
 *     the agent when the user mentions "tokens".
 *   - consensus-2026 clone: NOT in snapshot. Missing on every fleet
 *     VM that hasn't been through configureOpenClaw recently.
 *   - consensus-2026 auto-update cron: NOT in snapshot crontab. Same.
 *   - edge-esmeralda clone (partner=edge_city): NOT in snapshot.
 *     stepDeployEdgeOverlay's pre-check WARNS when edge dir missing
 *     (Rule 39) — this step fills the gap by cloning.
 *   - edge-esmeralda auto-update cron: NOT in snapshot crontab.
 *
 * Coexistence with existing reconciler steps:
 *   - stepSkillDirectories (Step 8i, line 4694) clones bankr if the
 *     dir is missing entirely. This step assumes the dir EXISTS and
 *     applies the overlay + subdir delete.
 *   - stepDeployEdgeOverlay (line 6356) writes INSTACLAW_OVERLAY.md
 *     if the edge dir exists. This step clones the edge dir so
 *     stepDeployEdgeOverlay can do its work on the NEXT cycle (1-
 *     cycle latency for first overlay application on new VMs).
 *   - stepNpmPinDrift (commit bb12558d, line 2662) installs mcporter
 *     binary. This step's mcporter clawlancer config sub-block runs
 *     LATER in the same reconcile cycle (orchestrator line 623), so
 *     mcporter should be on PATH by the time we probe.
 *
 * BE-9 fleet heal (2026-05-15): the 4th sub-block adds the mcporter
 * clawlancer config. Presence-only — does NOT remove-then-add (would
 * wipe an existing user's CLAWLANCER_API_KEY and strand their funds).
 * Add only if `mcporter config get clawlancer` returns non-zero.
 *
 * Failure classification:
 *   - Bankr SKILL.md absent after stepSkillDirectories ran → result
 *     .warnings (Rule 39 — needs operator-side re-clone, not a fleet
 *     -wide cv stall).
 *   - Bankr overlay write fails (local operation, should succeed if
 *     SKILL.md exists) → result.errors so cv stays put.
 *   - Bankr subdir delete fails → result.warnings (cosmetic).
 *   - Consensus / edge clone fails (network-dependent) → result
 *     .warnings (transient — don't stall cv on a network blip).
 *   - Cron install fails (local) → result.errors (should always
 *     succeed if crontab daemon is up).
 */
async function stepExternalSkillHeal(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // ── Bankr overlay + subdir delete (universal) ─────────────────────
  // Probe state with a single ssh.execCommand so we know exactly what
  // to fix. Marker check is the idempotency primitive.
  try {
    const probe = await ssh.execCommand(
      `BANKR_SKILL_BASE="$HOME/.openclaw/skills/bankr"; ` +
      `BANKR_SKILL_MD="$BANKR_SKILL_BASE/bankr/SKILL.md"; ` +
      `base=$([ -d "$BANKR_SKILL_BASE" ] && echo 1 || echo 0); ` +
      `md=$([ -f "$BANKR_SKILL_MD" ] && echo 1 || echo 0); ` +
      `marker=$([ -f "$BANKR_SKILL_MD" ] && grep -q "${BANKR_SKILL_PATCH_MARKER}" "$BANKR_SKILL_MD" && echo 1 || echo 0); ` +
      `clanker=$([ -d "$BANKR_SKILL_BASE/clanker" ] && echo 1 || echo 0); ` +
      `base_sub=$([ -d "$BANKR_SKILL_BASE/base" ] && echo 1 || echo 0); ` +
      `echo "base=$base md=$md marker=$marker clanker=$clanker base_sub=$base_sub"`
    );
    const m = probe.stdout.match(/base=(\d) md=(\d) marker=(\d) clanker=(\d) base_sub=(\d)/);
    if (!m) {
      result.warnings.push(`bankr-overlay: probe parse failed: ${probe.stdout.slice(0, 120)}`);
    } else {
      const [, bankrBase, bankrMd, bankrMarker, hasClanker, hasBaseSub] = m;

      // Overlay: apply if SKILL.md exists but marker absent.
      if (bankrBase !== "1") {
        result.warnings.push("bankr-overlay: bankr skill dir does not exist (stepSkillDirectories must clone it first)");
      } else if (bankrMd !== "1") {
        result.warnings.push("bankr-overlay: bankr dir exists but bankr/bankr/SKILL.md is missing (corrupt clone — operator re-clone needed)");
      } else if (bankrMarker === "1") {
        result.alreadyCorrect.push("bankr-overlay (marker present)");
      } else if (dryRun) {
        result.fixed.push("[dry-run] bankr-overlay: would prepend BANKR_SKILL_PATCH_DIRECTIVE");
      } else {
        // Atomic prepend: mktemp → cat directive → cat SKILL.md → mv.
        // Matches the cloud-init BE-5 setup.sh pattern + lib/ssh.ts:5444 byte-parity.
        const directiveB64 = Buffer.from(BANKR_SKILL_PATCH_DIRECTIVE, "utf-8").toString("base64");
        const apply = await ssh.execCommand(
          `BANKR_SKILL_MD="$HOME/.openclaw/skills/bankr/bankr/SKILL.md"; ` +
          `BANKR_OVERLAY_TMP=$(mktemp) && ` +
          `echo '${directiveB64}' | base64 -d > "$BANKR_OVERLAY_TMP" && ` +
          `cat "$BANKR_SKILL_MD" >> "$BANKR_OVERLAY_TMP" && ` +
          `mv "$BANKR_OVERLAY_TMP" "$BANKR_SKILL_MD" && ` +
          `grep -q "${BANKR_SKILL_PATCH_MARKER}" "$BANKR_SKILL_MD" && echo APPLIED || echo FAILED`,
        );
        if (apply.stdout.includes("APPLIED")) {
          result.fixed.push("bankr-overlay applied");
        } else {
          result.errors.push(
            `bankr-overlay write failed: stdout=${apply.stdout.slice(-200)} stderr=${apply.stderr.slice(-200)}`,
          );
        }
      }

      // Subdir delete: clanker + base. Always run (idempotent — rm -rf
      // on absent dirs is a no-op).
      if (bankrBase === "1" && (hasClanker === "1" || hasBaseSub === "1") && !dryRun) {
        const del = await ssh.execCommand(
          `rm -rf "$HOME/.openclaw/skills/bankr/clanker" "$HOME/.openclaw/skills/bankr/base" 2>&1`,
        );
        if (del.code === 0) {
          result.fixed.push(`bankr-subdirs deleted (clanker=${hasClanker} base=${hasBaseSub})`);
        } else {
          result.warnings.push(`bankr-subdirs delete failed: ${del.stderr.slice(0, 200)}`);
        }
      } else if (bankrBase === "1" && hasClanker === "0" && hasBaseSub === "0") {
        result.alreadyCorrect.push("bankr-subdirs (clean)");
      } else if (dryRun && (hasClanker === "1" || hasBaseSub === "1")) {
        result.fixed.push(`[dry-run] would delete bankr-subdirs (clanker=${hasClanker} base=${hasBaseSub})`);
      }
    }
  } catch (err) {
    result.warnings.push(`bankr-overlay heal: exception: ${String(err).slice(0, 200)}`);
  }

  // ── Consensus-2026 clone + cron (universal) ───────────────────────
  try {
    const probe = await ssh.execCommand(
      `dir=$([ -d "$HOME/.openclaw/skills/consensus-2026" ] && echo 1 || echo 0); ` +
      `md=$([ -f "$HOME/.openclaw/skills/consensus-2026/SKILL.md" ] && echo 1 || echo 0); ` +
      `cron=$(crontab -l 2>/dev/null | grep -c "skills/consensus-2026" || echo 0); ` +
      `echo "dir=$dir md=$md cron=$cron"`
    );
    const m = probe.stdout.match(/dir=(\d) md=(\d) cron=(\d+)/);
    if (!m) {
      result.warnings.push(`consensus-2026: probe parse failed: ${probe.stdout.slice(0, 120)}`);
    } else {
      const [, consDir, consMd, consCron] = m;

      // Clone if missing.
      if (consDir === "0") {
        if (dryRun) {
          result.fixed.push("[dry-run] consensus-2026: would clone");
        } else {
          const clone = await ssh.execCommand(
            `timeout 60 git clone --depth 1 https://github.com/coopergwrenn/consensus-2026-skill.git "$HOME/.openclaw/skills/consensus-2026" 2>&1 | tail -3 ; ` +
            `test -f "$HOME/.openclaw/skills/consensus-2026/SKILL.md" && echo CLONED || echo FAILED`,
          );
          if (clone.stdout.includes("CLONED")) {
            result.fixed.push("consensus-2026 cloned");
          } else {
            result.warnings.push(
              `consensus-2026 clone failed (network or repo issue): ${clone.stdout.slice(-200)}`,
            );
          }
        }
      } else if (consMd === "1") {
        result.alreadyCorrect.push("consensus-2026 (cloned)");
      } else {
        result.warnings.push("consensus-2026: dir exists but SKILL.md missing (corrupt clone)");
      }

      // Cron install: re-add if absent OR if any prior entry exists (idempotent grep -v + re-add).
      // We always re-run to ensure the cron is well-formed.
      if (!dryRun) {
        const cronInstall = await ssh.execCommand(
          `(crontab -l 2>/dev/null | grep -v "consensus-2026-skill" | grep -v "skills/consensus-2026"; ` +
          `echo "*/30 * * * * cd $HOME/.openclaw/skills/consensus-2026 && git pull --ff-only -q 2>/dev/null") | crontab - && echo OK || echo FAIL`,
        );
        if (cronInstall.stdout.includes("OK")) {
          if (consCron === "0") {
            result.fixed.push("consensus-2026 cron installed");
          } else {
            result.alreadyCorrect.push("consensus-2026 cron (present)");
          }
        } else {
          result.errors.push(
            `consensus-2026 cron install failed: ${cronInstall.stdout.slice(-200)}`,
          );
        }
      }
    }
  } catch (err) {
    result.warnings.push(`consensus-2026 heal: exception: ${String(err).slice(0, 200)}`);
  }

  // ── mcporter clawlancer config (universal, BE-9 fleet heal) ──────
  //
  // Fleet-heal counterpart to cloud-init Day 8b BE-9 (commit 1bac526c).
  // Wires up the clawlancer MCP server in mcporter's config so the
  // agent can call `mcporter call clawlancer.<tool>` per the clawlancer
  // SKILL.md (deployed via stepSkills from instaclaw/skills/clawlancer/
  // after BE-8 commit d048c5d3).
  //
  // Failure mode w/o this: every existing fleet VM has the clawlancer
  // SKILL.md instructing the agent to use `mcporter call clawlancer.*`,
  // but the mcporter config has no clawlancer entry → every call
  // returns "Unknown server 'clawlancer'". This block heals every VM
  // on the next reconcile cycle.
  //
  // Presence-only logic (NOT a remove-then-add like cloud-init BE-9
  // setup.sh): if the user's agent has already registered with
  // Clawlancer and populated their CLAWLANCER_API_KEY, the config has
  // a populated key. Wiping it would force re-registration AND
  // strand any funds tied to the old wallet. So we add ONLY if the
  // config is missing. Drift in existing configs (wrong --command,
  // wrong URL) is NOT healed here — would require an explicit
  // operator-driven re-config script.
  //
  // Prereq: mcporter binary on PATH (via NVM_PREAMBLE). stepNpmPinDrift
  // (commit bb12558d) installs mcporter on every reconcile cycle, so
  // by the time this step runs, mcporter should be present. If it
  // isn't (transient failure), this block surfaces a warning instead
  // of an error — the next cycle picks up the BE-11 install + this
  // BE-9 config in sequence.
  //
  // Canonical config (matches lib/ssh.ts:5596-5603 + BE-9 setup.sh
  // byte-parity): npx -y clawlancer-mcp, empty CLAWLANCER_API_KEY,
  // CLAWLANCER_BASE_URL=https://clawlancer.ai, scope home.
  try {
    const probe = await ssh.execCommand(
      `${NVM_PREAMBLE} && command -v mcporter >/dev/null 2>&1 && echo MCPORTER_OK || echo MCPORTER_MISSING; ` +
      `${NVM_PREAMBLE} && mcporter config get clawlancer >/dev/null 2>&1 && echo CLAWLANCER_REGISTERED || echo CLAWLANCER_MISSING`,
    );
    const mcporterPresent = probe.stdout.includes("MCPORTER_OK");
    const clawlancerRegistered = probe.stdout.includes("CLAWLANCER_REGISTERED");

    if (!mcporterPresent) {
      // BE-11 fleet heal (stepNpmPinDrift) should have installed mcporter
      // earlier in this cycle. If it's still missing, the failure cause
      // is upstream — surface a warning rather than blocking cv (the
      // next cycle's stepNpmPinDrift retry will heal both).
      result.warnings.push("mcporter-clawlancer: mcporter binary missing — BE-11 fleet heal must install it first");
    } else if (clawlancerRegistered) {
      result.alreadyCorrect.push("mcporter-clawlancer (registered)");
    } else if (dryRun) {
      result.fixed.push("[dry-run] mcporter-clawlancer: would add canonical config");
    } else {
      // Add the canonical config. `--scope home` writes to
      // ~/.mcporter/mcporter.json (not the project-level config, which
      // would require a project dir we don't necessarily have).
      const add = await ssh.execCommand(
        `${NVM_PREAMBLE} && mcporter config add clawlancer ` +
        `--command "npx -y clawlancer-mcp" ` +
        `--env CLAWLANCER_API_KEY= ` +
        `--env CLAWLANCER_BASE_URL=https://clawlancer.ai ` +
        `--scope home ` +
        `--description "Clawlancer AI agent marketplace" 2>&1 | tail -5`,
      );
      const verify = await ssh.execCommand(
        `${NVM_PREAMBLE} && mcporter config get clawlancer >/dev/null 2>&1 && echo OK || echo MISSING`,
      );
      if (verify.stdout.includes("OK")) {
        result.fixed.push("mcporter-clawlancer config added");
      } else {
        result.errors.push(
          `mcporter-clawlancer add failed: ${add.stdout.slice(-200)}`,
        );
      }
    }
  } catch (err) {
    result.warnings.push(`mcporter-clawlancer heal: exception: ${String(err).slice(0, 200)}`);
  }

  // ── Edge-esmeralda clone + cron (partner=edge_city only) ──────────
  // Overlay (INSTACLAW_OVERLAY.md) is handled by stepDeployEdgeOverlay
  // on a subsequent cycle once the clone lands here.
  if (vm.partner !== "edge_city") return;

  try {
    const probe = await ssh.execCommand(
      `dir=$([ -d "$HOME/.openclaw/skills/edge-esmeralda" ] && echo 1 || echo 0); ` +
      `md=$([ -f "$HOME/.openclaw/skills/edge-esmeralda/SKILL.md" ] && echo 1 || echo 0); ` +
      `cron=$(crontab -l 2>/dev/null | grep -c "edge-agent-skill" || echo 0); ` +
      `echo "dir=$dir md=$md cron=$cron"`
    );
    const m = probe.stdout.match(/dir=(\d) md=(\d) cron=(\d+)/);
    if (!m) {
      result.warnings.push(`edge-esmeralda: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [, edgeDir, edgeMd, edgeCron] = m;

    if (edgeDir === "0") {
      if (dryRun) {
        result.fixed.push("[dry-run] edge-esmeralda: would clone");
      } else {
        const clone = await ssh.execCommand(
          `timeout 60 git clone --depth 1 https://github.com/aromeoes/edge-agent-skill.git "$HOME/.openclaw/skills/edge-esmeralda" 2>&1 | tail -3 ; ` +
          `test -f "$HOME/.openclaw/skills/edge-esmeralda/SKILL.md" && echo CLONED || echo FAILED`,
        );
        if (clone.stdout.includes("CLONED")) {
          result.fixed.push("edge-esmeralda cloned");
        } else {
          result.warnings.push(
            `edge-esmeralda clone failed (network or repo issue): ${clone.stdout.slice(-200)}`,
          );
        }
      }
    } else if (edgeMd === "1") {
      result.alreadyCorrect.push("edge-esmeralda (cloned)");
    } else {
      result.warnings.push("edge-esmeralda: dir exists but SKILL.md missing (corrupt clone)");
    }

    if (!dryRun) {
      const cronInstall = await ssh.execCommand(
        `(crontab -l 2>/dev/null | grep -v "edge-agent-skill"; ` +
        `echo "*/30 * * * * cd $HOME/.openclaw/skills/edge-esmeralda && git pull --ff-only -q 2>/dev/null") | crontab - && echo OK || echo FAIL`,
      );
      if (cronInstall.stdout.includes("OK")) {
        if (edgeCron === "0") {
          result.fixed.push("edge-esmeralda cron installed");
        } else {
          result.alreadyCorrect.push("edge-esmeralda cron (present)");
        }
      } else {
        result.errors.push(
          `edge-esmeralda cron install failed: ${cronInstall.stdout.slice(-200)}`,
        );
      }
    }
  } catch (err) {
    result.warnings.push(`edge-esmeralda heal: exception: ${String(err).slice(0, 200)}`);
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
  vm: VMRecord & { partner?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
  strict: boolean,
  isPausedState: boolean,
): Promise<void> {
  // Rule 39 — dispatch is only customer-facing on edge_city VMs (the
  // surface is the World mini app's dispatch mode for remote computer
  // control). On every other VM, dispatch is installed for fleet
  // consistency, but a failed install or probe doesn't affect any user.
  // Downgrade failures to warnings on non-edge VMs so cv-bump can
  // proceed; the heal step is idempotent and retries next cron tick.
  //
  // Add other partners to the equality check if/when they ship a
  // feature that consumes dispatch.
  const isDispatchCustomerFacing = vm.partner === "edge_city";
  const recordDispatchFailure = (msg: string): void => {
    if (isDispatchCustomerFacing) {
      recordHealError(result, strict, msg);
    } else {
      recordHealWarning(result, `${msg} [non-edge_city — warning, not error]`);
    }
  };
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
      recordDispatchFailure(`dispatch-server: probe parse failed: ${probe.stdout.slice(0, 120)}`);
      return;
    }
    const [hasUnit, isActive, isListening] = [m[1] === "1", m[2] === "1", m[3] === "1"];

    // Rule 57: ensure ufw allow 8765/tcp before any early-exit, so otherwise-
    // healthy VMs still get ufw drift healed. Replaces the prior banned
    // `sudo ufw allow 8765/tcp || true` pattern that lived in the deploy
    // script — that one only ran on redeploy AND silently swallowed every
    // failure mode. ensureUfwAllow probes, adds, then sentinel-verifies the
    // rule landed. Failures are warnings (Rule 39) — dispatch's gateway
    // service is the customer-facing piece; ufw is a defense-in-depth concern.
    await ensureUfwAllow(ssh, result, 8765, dryRun, "dispatch-ufw");

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
      // ufw allow 8765/tcp is now handled by ensureUfwAllow (called above the
      // early-exit block), not here. The prior `sudo ufw allow 8765/tcp ||
      // true` was a Rule 57-banned pattern: silent-fail on every error path,
      // and only ran when redeploy fired. Removed 2026-05-18.
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
      recordDispatchFailure("dispatch-server: NVM node binary not found");
    } else {
      recordDispatchFailure(`dispatch-server: redeploy failed: ${r.stdout.slice(-200)}`);
    }
  } catch (err) {
    recordDispatchFailure(`dispatch-server: ${String(err).slice(0, 200)}`);
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
  // ── Bake escape hatch ──
  // When SKIP_INSTACLAW_XMTP=true is set in the environment, skip xmtp
  // installation entirely. Set by the snapshot bake (lib/bake/steps.ts:
  // reconcileRunAudit) because the bake's synthetic VM has no real
  // gateway_token — setupXMTP's full re-provision path needs one (line
  // 7683 below) and would push a strict-err that fails the bake.
  //
  // xmtp install on fresh-VM provisions is handled by configureOpenClaw
  // at user-assignment time, where vm.gateway_token IS real. The cost of
  // skipping in bake is ~30-60s extra at first-message (xmtp install
  // moved from snapshot-time to first-provision-time). Acceptable given:
  //   - 1000-attendee pool is pre-replenished before Edge Esmeralda;
  //     onboarding is paced over hours, not seconds
  //   - the alternative — installing xmtp with a fake gateway_token —
  //     would bake a half-configured systemd unit + env-less wallet
  //     directory into the snapshot, and pre-bake-cleanup's
  //     ~/.openclaw/xmtp wipe leaves an EnvironmentFile-missing unit
  //     that would crash-loop on fresh VM boot (no `-` prefix on the
  //     EnvironmentFile= line in setupXMTP at lib/ssh.ts:13140)
  //
  // Production (non-bake) reconciles never set this env var, so the
  // existing behavior is preserved fleet-wide. Bug surfaced 2026-05-25
  // (snapshot bake attempt 3 failed at stepInstaclawXmtp with strict-err
  // "full re-provision needed but vm.gateway_token is missing").
  if (process.env.SKIP_INSTACLAW_XMTP === "true") {
    result.warnings.push("instaclaw-xmtp: skipped (SKIP_INSTACLAW_XMTP=true, bake context)");
    return;
  }
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
 * Shared probe-add-verify helper for ufw ALLOW rules.
 *
 * Per CLAUDE.md Rule 57. Used by stepUfwRules (9100/tcp for Prometheus) and
 * stepDispatchServer (8765/tcp for the Dispatch WebSocket endpoint) so both
 * call sites use the same discipline rather than independently re-implementing
 * it (and one drifting). The shape is:
 *
 *   1. Probe — is ufw installed at all? If not, no-op success (alreadyCorrect).
 *      Some VMs (e.g. vm-050) don't have ufw and don't need it.
 *   2. Probe — is the `^PORT/tcp` rule already present? If yes, alreadyCorrect.
 *   3. Otherwise, probe sudo. No passwordless sudo → warning.
 *   4. `sudo ufw allow PORT/tcp` then RE-READ the live ufw status and confirm
 *      the rule landed (Rule 23 / Rule 10 sentinel — never trust the exit code
 *      of the mutating command alone).
 *   5. Classify per Rule 39: failures are warnings (recordHealWarning), NOT
 *      errors. ufw rule failures don't gate cv-bump — they re-attempt on the
 *      next cron tick and never block customer-facing flows.
 *
 * `label` is a free-form prefix for log messages so it's clear which call site
 * a given audit-log entry came from (e.g. "ufw-rules" vs "dispatch-ufw").
 *
 * No isPausedState gate — adding a firewall rule is safe regardless of paused
 * state, and ensures the listener is reachable as soon as the VM resumes.
 */
async function ensureUfwAllow(
  ssh: SSHConnection,
  result: ReconcileResult,
  port: number,
  dryRun: boolean,
  label: string,
): Promise<void> {
  const portPattern = `^${port}/tcp`;
  try {
    const probe = await ssh.execCommand(
      `if ! command -v ufw >/dev/null 2>&1; then echo NO_UFW; exit 0; fi; ` +
      `count=$(sudo -n ufw status 2>/dev/null | grep -c "${portPattern}" || echo 0); ` +
      `echo "rule_count=$count"`
    );
    if (probe.stdout.includes("NO_UFW")) {
      result.alreadyCorrect.push(`${label}: ufw not installed (skip)`);
      return;
    }
    const probeMatch = probe.stdout.match(/rule_count=(\d+)/);
    if (!probeMatch) {
      recordHealWarning(
        result,
        `${label}: probe parse failed: ${probe.stdout.slice(0, 160)}`,
      );
      return;
    }
    const ruleCount = parseInt(probeMatch[1], 10);

    if (ruleCount >= 1) {
      result.alreadyCorrect.push(`${label}: ${port}/tcp present`);
      return;
    }

    if (dryRun) {
      result.fixed.push(`[dry-run] ${label}: would add ${port}/tcp`);
      return;
    }

    const sudoCheck = await ssh.execCommand(
      "sudo -n true 2>/dev/null && echo SUDO_OK || echo NO_SUDO",
    );
    if (!sudoCheck.stdout.includes("SUDO_OK")) {
      recordHealWarning(
        result,
        `${label}: passwordless sudo unavailable; cannot add ${port}/tcp`,
      );
      return;
    }

    // Add the rule + SENTINEL-VERIFY (Rule 23 / Rule 10) before declaring
    // fixed. ufw's exit code alone isn't trusted — re-grep the live status.
    const add = await ssh.execCommand(
      `sudo -n ufw allow ${port}/tcp 2>&1; ` +
      `verify=$(sudo -n ufw status 2>/dev/null | grep -c "${portPattern}" || echo 0); ` +
      `echo "verify=$verify"`,
    );
    const verifyMatch = add.stdout.match(/verify=(\d+)/);
    const verifyCount = verifyMatch ? parseInt(verifyMatch[1], 10) : 0;
    if (verifyCount >= 1) {
      result.fixed.push(`${label}: added ${port}/tcp`);
    } else {
      recordHealWarning(
        result,
        `${label}: post-add verify failed (count=${verifyCount}): ${add.stdout.slice(-200)}`,
      );
    }
  } catch (err) {
    recordHealWarning(result, `${label}: ${String(err).slice(0, 200)}`);
  }
}

/**
 * Step 8m2: ufw allow 9100/tcp.
 *
 * Ensures Prometheus on the monitoring VM can reach node_exporter through
 * the host firewall. Companion to stepNodeExporter — that step verifies the
 * port is bound locally; this one verifies it's reachable externally.
 *
 * Per CLAUDE.md Rule 57. Failure mode: 2026-05-18 ufw-drift incident — 8 VMs
 * had node_exporter healthy but firewalled at 9100 for 1-4 days. This step
 * heals them on next cron tick.
 *
 * Delegates to ensureUfwAllow so this and stepDispatchServer share the same
 * probe-add-verify discipline. Failures are warnings (Rule 39) — observability
 * is not customer-facing and a missing rule does NOT block cv-bump.
 */
async function stepUfwRules(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  await ensureUfwAllow(ssh, result, 9100, dryRun, "ufw-rules");
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
      // v99: also probe the textfile-collector layer so a fresh-install
      // VM gets the drop-in + dir even when node_exporter is otherwise
      // healthy.
      `dropin=$([ -f /etc/systemd/system/node_exporter.service.d/textfile.conf ] && echo 1 || echo 0); ` +
      `tfdir=$([ -d /var/lib/node_exporter/textfile_collector ] && echo 1 || echo 0); ` +
      `echo "bin=$bin port=$port unit=$unit dropin=$dropin tfdir=$tfdir"`
    );
    const m = probe.stdout.match(/bin=(\d) port=(\d) unit=(\d) dropin=(\d) tfdir=(\d)/);
    if (!m) {
      recordHealWarning(result, `node_exporter: probe parse failed: ${probe.stdout.slice(0, 160)}`);
      return;
    }
    const [hasBin, isListening, hasUnit, hasDropin, hasTfDir] = [
      m[1] === "1", m[2] === "1", m[3] === "1", m[4] === "1", m[5] === "1",
    ];

    // v99: even if node_exporter is healthy, install the textfile-collector
    // pieces if they're missing. ensureTextfileCollector is idempotent and
    // only restarts node_exporter when content actually changes.
    if (hasBin && isListening) {
      if (!hasDropin || !hasTfDir) {
        await ensureTextfileCollector(ssh, result, dryRun, isPausedState);
      } else {
        result.alreadyCorrect.push("node_exporter: bin+listening+textfile");
      }
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
      return;  // skip textfile setup if core install failed
    }

    // v99: also install the textfile-collector pieces after the base
    // install. Safe whether we just installed or just re-confirmed.
    await ensureTextfileCollector(ssh, result, dryRun, isPausedState);
  } catch (err) {
    recordHealWarning(result, `node_exporter: ${String(err).slice(0, 200)}`);
  }
}

/**
 * v99: ensure node_exporter is configured to read from
 * /var/lib/node_exporter/textfile_collector/. Creates the directory
 * (root:openclaw 775 — openclaw user writes the .prom file via cron) and
 * installs the systemd drop-in that adds --collector.textfile.directory
 * to ExecStart. Idempotent: detects content drift on the drop-in and only
 * restarts node_exporter when it actually changed.
 *
 * The drop-in form survives any future overwrite of the main unit file
 * (which stepNodeExporter rewrites unconditionally). The drop-in's
 * `ExecStart=` empty-string line resets the base unit's ExecStart, then
 * the second `ExecStart=...` is the only one that runs — standard
 * systemd drop-in pattern.
 *
 * Originally fleet-pushed manually 2026-05-14 (timmy outage). Promoted to
 * manifest in v99 so new VMs provisioned from snapshots get it too.
 */
async function ensureTextfileCollector(
  ssh: SSHConnection,
  result: ReconcileResult,
  dryRun: boolean,
  isPausedState: boolean,
): Promise<void> {
  if (dryRun) {
    result.fixed.push("[dry-run] node_exporter: would install textfile-collector dir + drop-in");
    return;
  }

  // Need sudo for both the dir creation and the drop-in write. Bail
  // cleanly if not available — script + cron will still deploy via the
  // openclaw user via stepFiles/stepCronJobs, but the metric won't be
  // surfaced through node_exporter until a future tick with sudo.
  const sudoCheck = await ssh.execCommand("sudo -n true 2>/dev/null && echo SUDO_OK || echo NO_SUDO");
  if (!sudoCheck.stdout.includes("SUDO_OK")) {
    recordHealWarning(result, "node_exporter textfile: passwordless sudo not available");
    return;
  }

  // Desired drop-in content. Heredoc via tee — quoted UEOF prevents
  // shell expansion of the path-with-dashes.
  const setup = await ssh.execCommand(`bash -c '
set +e
CHANGED=0

# Directory: create if missing, ensure root:openclaw 775 so the openclaw
# user (running the per-minute cron) can write .prom files into it.
if [ ! -d /var/lib/node_exporter/textfile_collector ]; then
  sudo mkdir -p /var/lib/node_exporter/textfile_collector || { echo MKDIR_FAIL; exit 1; }
  CHANGED=1
fi
sudo chown root:openclaw /var/lib/node_exporter/textfile_collector
sudo chmod 775 /var/lib/node_exporter/textfile_collector

# Drop-in directory + file. tee with -p creates the directory. Compare
# before-write to avoid spurious restarts when content is already current.
sudo mkdir -p /etc/systemd/system/node_exporter.service.d
DROPIN=/etc/systemd/system/node_exporter.service.d/textfile.conf
DESIRED=$(cat <<UEOF
# /etc/systemd/system/node_exporter.service.d/textfile.conf
# Adds textfile_collector to expose openclaw_gateway_up metric.
# Drop-in form survives any future overwrite of the main unit file.
# Managed by lib/vm-reconcile.ts:ensureTextfileCollector (v99+).
[Service]
ExecStart=
ExecStart=/usr/local/bin/node_exporter --collector.systemd --collector.textfile.directory=/var/lib/node_exporter/textfile_collector
UEOF
)
if [ ! -f "$DROPIN" ] || [ "$(cat "$DROPIN")" != "$DESIRED" ]; then
  echo "$DESIRED" | sudo tee "$DROPIN" >/dev/null
  CHANGED=1
fi

if [ "$CHANGED" = "1" ]; then
  sudo systemctl daemon-reload
  if ${isPausedState ? "false" : "true"}; then
    sudo systemctl restart node_exporter && sleep 5
    if ss -tln 2>/dev/null | grep -q ":9100 "; then
      echo "TEXTFILE_OK_RESTARTED"
    else
      echo "TEXTFILE_RESTART_NOPORT"
    fi
  else
    echo "TEXTFILE_OK_NORESTART_PAUSED"
  fi
else
  echo "TEXTFILE_ALREADY_CORRECT"
fi
'`);

  const out = setup.stdout;
  if (out.includes("TEXTFILE_OK_RESTARTED")) {
    result.fixed.push("node_exporter textfile-collector: dir + drop-in installed; node_exporter restarted");
  } else if (out.includes("TEXTFILE_OK_NORESTART_PAUSED")) {
    result.fixed.push("node_exporter textfile-collector: dir + drop-in installed (restart skipped — VM paused)");
  } else if (out.includes("TEXTFILE_ALREADY_CORRECT")) {
    result.alreadyCorrect.push("node_exporter textfile-collector: dir + drop-in already correct");
  } else if (out.includes("TEXTFILE_RESTART_NOPORT")) {
    recordHealWarning(result, `node_exporter textfile: restart did not re-bind :9100 (${out.slice(-200)})`);
  } else if (out.includes("MKDIR_FAIL")) {
    recordHealWarning(result, "node_exporter textfile: mkdir /var/lib/node_exporter/textfile_collector failed");
  } else {
    recordHealWarning(result, `node_exporter textfile: unexpected output (${out.slice(-200)})`);
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
  //
  // 2026-05-22 incident: this env var was unset in Vercel production from
  // 2026-05-13 through 2026-05-22 (~9 days). The kill-switch silently
  // returned with NO log, NO result.errors push, NO operator signal. Result:
  // zero fleet VMs migrated to V2 templates for 9 days while we kept
  // building V2 content thinking it was deploying.
  //
  // The root cause was operator-configuration drift (env var never set in
  // Vercel + bake/canary scripts using the placeholder-empty value). The
  // root fix is operator discipline + the pre-bake-check value validation
  // shipped alongside this commit.
  //
  // This defensive log is the LAST line of defense: if the env var is set
  // but NOT "true" (empty string, "false", "1", legacy spelling, typo,
  // etc.), surface a WARN-level log line and a result.warnings entry so
  // the reconcile-fleet operator-visible output flags the misconfiguration
  // every cycle instead of silently skipping. Doesn't push to result.errors
  // (would hold cv-bump, which is correct behavior for a feature-flagged
  // step). result.warnings shows up in the cron summary email.
  //
  // Banned-by-this-comment pattern: `if (env !== "true") return;` with no
  // log on the misconfigured-but-set case. See Rule 61 (added in the same
  // commit) for the generalized rule across all boolean env vars.
  const rcsmRaw = process.env.RECONCILE_SOUL_MIGRATION_ENABLED;
  if (rcsmRaw !== "true") {
    // Distinguish "feature explicitly disabled" (unset, "false", "0")
    // from "looks like operator tried to set it but got it wrong"
    // (empty string, whitespace, any other truthy-ish value). The first
    // is fine + silent; the second is the 2026-05-22 bug class.
    const looksMisconfigured =
      rcsmRaw !== undefined &&
      rcsmRaw !== "false" &&
      rcsmRaw !== "0" &&
      rcsmRaw !== "no";
    if (looksMisconfigured) {
      logger.warn(
        "stepMigrateSoulV2 SKIPPED — RECONCILE_SOUL_MIGRATION_ENABLED is set but not 'true'. " +
          "If this is unintentional, run: " +
          "printf 'true' | npx vercel env add RECONCILE_SOUL_MIGRATION_ENABLED production",
        {
          route: "lib/vm-reconcile",
          step: "stepMigrateSoulV2",
          vmId: vm.id,
          actual: JSON.stringify(rcsmRaw), // JSON-stringify so empty string shows as ""
          expected: "true",
        },
      );
      result.warnings.push(
        `stepMigrateSoulV2 skipped: RECONCILE_SOUL_MIGRATION_ENABLED='${rcsmRaw}' (expected 'true')`,
      );
    }
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
 * stepDeployGbrainSoulProtocol — v102 migration to canonicalize the gbrain
 * memory protocol into AGENTS.md on every gbrain-eligible VM.
 *
 * Why this exists: vm-050 had a manually-deployed gbrain protocol (via
 * scripts/_push_gbrain_fix.ts ops script) but the other 7 edge_city VMs
 * had ZERO gbrain instructions despite having gbrain installed. Their
 * agents saw put_page/search/get_page in the MCP tool catalog but had no
 * SOUL.md/AGENTS.md routing telling them WHEN to use them — agents fell
 * back to MEMORY.md edits or pure hallucination (the 2026-05-17 Bear
 * Republic canary, where timmy claimed "saved" with no tool call).
 *
 * Triple gate (defense in depth — added 2026-05-19 to close the latent
 * VM-reassignment bug originally flagged in v106's PRD):
 *   1. vm.partner ∈ GBRAIN_PARTNER_ALLOWLIST (covers reassign edge case
 *      via freeze→thaw or manual partner mutation; without this gate, a
 *      VM reassigned from edge_city to non-edge would keep gbrain.service
 *      running from the previous tenant and this step would inject gbrain
 *      routing into the new non-edge user's AGENTS.md — wrong)
 *   2. GBRAIN_INSTALL_ENABLED env var === "true" (pauses propagation if
 *      the gbrain rollout is intentionally disabled in Vercel)
 *   3. gbrain.service active on the VM (catches edge case where gbrain
 *      isn't installed yet — same cycle's earlier stepGbrain may have
 *      just installed it, or it may have crashed)
 *
 * Same gate shape as stepDeployGbrainSoulRouting (v106), kept in lock-step
 * via the shared GBRAIN_PARTNER_ALLOWLIST and the env var. When the
 * allowlist grows (consensus_2026, eclipse, etc.), both steps propagate
 * automatically without code changes here.
 *
 * Idempotency: GBRAIN_MEMORY_PROTOCOL_V1 marker check. Skip if present.
 *
 * Rule 22: backs up AGENTS.md to ~/.openclaw/backups/v102-gbrain-soul-
 * protocol-<ts>/AGENTS.md BEFORE any modification.
 *
 * Rule 23: atomic write (tmp + os.replace). Marker-verify after write.
 *
 * Source of the inserted block: lib/workspace-templates-v2.ts
 * GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK constant. ~4.1KB of content,
 * includes Rule 28 "MUST call gbrain__put_page BEFORE responding"
 * anti-hallucination directive.
 */
async function stepDeployGbrainSoulProtocol(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null; gbrain_enabled?: boolean | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // ── Gate 1: gbrain eligibility (partner allowlist OR explicit canary opt-in) ──
  if (!isGbrainEligibleForVM(vm)) return;

  // ── Gate 2: env var (pauses entire gbrain content surface) ──
  if (process.env.GBRAIN_INSTALL_ENABLED !== "true") return;

  // ── Gate 3: gbrain.service must be active on this VM ──
  const probe = await ssh.execCommand(
    `${HEAL_DBUS_PREFIX} && systemctl --user is-active gbrain.service 2>&1 | head -1`,
    { execOptions: { timeout: 5_000 } } as any,
  );
  const active = (probe.stdout || "").trim() === "active";
  if (!active) {
    // Silent skip — not an error. Just means this VM doesn't have gbrain.
    return;
  }

  // ── Marker probe ──
  const check = await ssh.execCommand(
    `grep -c "GBRAIN_MEMORY_PROTOCOL_V1" ~/.openclaw/workspace/AGENTS.md 2>/dev/null || echo 0`,
  );
  const present = parseInt((check.stdout || "0").trim(), 10) > 0;
  if (present) {
    result.alreadyCorrect.push("gbrain-soul-protocol (V1 marker present)");
    return;
  }

  if (dryRun) {
    result.fixed.push("[dry-run] gbrain-soul-protocol: would insert GBRAIN_MEMORY_PROTOCOL_V1 block before ## Memory Protocol in AGENTS.md");
    return;
  }

  // ── Python in-place insert with backup + atomic write + verify ──
  const cfg = JSON.stringify({
    agents_path: "~/.openclaw/workspace/AGENTS.md",
    backup_path: `~/.openclaw/backups/v102-gbrain-soul-protocol-${Date.now()}/AGENTS.md`,
    block: GBRAIN_MEMORY_PROTOCOL_V1_AGENTS_BLOCK,
    insert_before_header: "## Memory Protocol",
    marker: "GBRAIN_MEMORY_PROTOCOL_V1",
  });
  const PATCH_PY = `
import json, os, sys

cfg = json.loads(sys.stdin.read())
path = os.path.expanduser(cfg["agents_path"])

def out(d):
    print(json.dumps(d))
    sys.exit(0)

if not os.path.exists(path):
    out({"status": "missing"})

with open(path) as f:
    content = f.read()
original = content

# Idempotency: skip if marker already present (defense in depth — caller
# also checks, but a race between two reconcile runs could bypass that).
if cfg["marker"] in content:
    out({"status": "already-present"})

# Rule 22 backup BEFORE any modification.
bp = os.path.expanduser(cfg["backup_path"])
os.makedirs(os.path.dirname(bp), exist_ok=True)
with open(bp, "w") as f:
    f.write(original)

# Locate insertion point: line equal to the header. If missing, append
# to EOF as a fallback — never destructive, never overwrite.
header = cfg["insert_before_header"]
lines = content.split("\\n")
idx = -1
for i, line in enumerate(lines):
    if line.strip() == header.strip():
        idx = i
        break

block = cfg["block"]
if idx >= 0:
    new_content = "\\n".join(lines[:idx]) + "\\n" + block + "\\n" + "\\n".join(lines[idx:])
    inserted_at = "before-header"
else:
    new_content = content.rstrip() + "\\n\\n" + block + "\\n"
    inserted_at = "appended-eof"

# Atomic write per Rule 22.
tmp = path + ".tmp"
with open(tmp, "w") as f:
    f.write(new_content)
os.replace(tmp, path)

# Verify marker is now present.
with open(path) as f:
    final = f.read()
if cfg["marker"] not in final:
    out({"status": "verify-failed", "inserted_at": inserted_at})

out({"status": "ok", "inserted_at": inserted_at, "size_before": len(original), "size_after": len(final)})
`;

  const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
  const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
  const cmd = `echo '${cfgB64}' | base64 -d | python3 <(echo '${scriptB64}' | base64 -d)`;

  const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30_000 } });
  if (r.code !== 0) {
    result.errors.push(
      `gbrain-soul-protocol python failed rc=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`,
    );
    return;
  }

  const lines = (r.stdout || "").split("\n").map((l: string) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  let parsed: { status?: string; inserted_at?: string; size_before?: number; size_after?: number } = {};
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    result.errors.push(`gbrain-soul-protocol: could not parse python output: ${lastLine.slice(0, 200)}`);
    return;
  }

  if (parsed.status === "missing") {
    result.errors.push("gbrain-soul-protocol: AGENTS.md missing — configureOpenClaw should have created it");
    return;
  }
  if (parsed.status === "already-present") {
    result.alreadyCorrect.push("gbrain-soul-protocol (marker found by python)");
    return;
  }
  if (parsed.status === "verify-failed") {
    result.errors.push(`gbrain-soul-protocol: verify-after-write failed (inserted_at=${parsed.inserted_at})`);
    return;
  }
  if (parsed.status === "ok") {
    result.fixed.push(
      `gbrain-soul-protocol: inserted block ${parsed.inserted_at} (AGENTS.md ${parsed.size_before} → ${parsed.size_after} bytes)`,
    );
    return;
  }
  result.errors.push(`gbrain-soul-protocol: unexpected status=${parsed.status}`);
}

/**
 * Fire-and-forget admin alert for `gbrain-soul-routing` drift, with 6h
 * dedup per VM. Uses the same instaclaw_admin_alert_log pattern as
 * sendVMReadyEmail (lib/email.ts:230).
 *
 * Drift here means: a VM's `## Memory Persistence (CRITICAL)` section
 * sha doesn't match a known-OK value (vanilla MEMORY.md-first or vm-050
 * hand-deploy). Either the user customized the section, or a future
 * template change shifted the vanilla content and we forgot to add the
 * new sha to KNOWN_OK_SHAS. Either way the operator should review and
 * decide — never overwrite blindly.
 *
 * Best-effort: any failure (Supabase down, Resend down, env var missing)
 * is logged but does NOT throw. The reconciler step's main flow continues.
 */
async function sendGbrainSoulRoutingDriftAlertDeduped(
  vmName: string,
  vmId: string,
  observedSha: string,
  contentSnippet: string,
): Promise<void> {
  try {
    const alertKey = `gbrain_soul_routing_drift:${vmId}:${observedSha.slice(0, 12)}`;
    const sb = getSupabase();
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await sb
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .gte("sent_at", sixHoursAgo)
      .limit(1);
    if (existing && existing.length > 0) return;

    await sb.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKey,
      vm_count: 1,
      details: `gbrain-soul-routing drift on ${vmName}: sha=${observedSha.slice(0, 12)}`,
    });

    const knownShasFormatted = GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS
      .map((s) => "  " + s)
      .join("\n");
    const body = [
      `gbrain-soul-routing step detected unexpected content in ~/.openclaw/workspace/SOUL.md`,
      ``,
      `VM: ${vmName} (id=${vmId})`,
      `Section: \`## Memory Persistence (CRITICAL)\` ... (excl) \`## Task Completion Notifications\``,
      `Observed sha: ${observedSha}`,
      ``,
      `Known-OK shas (reconciler will replace only these):`,
      knownShasFormatted,
      ``,
      `What this means: the section content differs from both the vanilla`,
      `MEMORY.md-first template and vm-050's hand-deployed gbrain-first`,
      `content. Either (a) user manually customized this section, or`,
      `(b) a deliberate template change shifted the canonical content and`,
      `KNOWN_OK_SHAS in lib/workspace-templates-v2.ts needs the new sha.`,
      ``,
      `Reconciler refused to replace (Rule 22 — preserve user content).`,
      `The VM stays on its current section. The marker block was NOT added.`,
      ``,
      `What to do:`,
      `1. SSH into the VM. Read the section between the two headers.`,
      `2. If user-customized: leave it. The agent on this VM uses custom routing.`,
      `3. If it's a new vanilla we forgot to bless: add the sha to`,
      `   GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS and re-deploy.`,
      ``,
      `First 200 chars of observed section:`,
      `--- snip ---`,
      contentSnippet,
      `--- /snip ---`,
    ].join("\n");

    await sendAdminAlertEmail(
      `[P1] gbrain-soul-routing drift on ${vmName}`,
      body,
    );
  } catch (err) {
    logger.warn("gbrain-soul-routing-drift admin alert failed (continuing)", {
      route: "lib/vm-reconcile/sendGbrainSoulRoutingDriftAlertDeduped",
      vmName,
      error: String(err).slice(0, 200),
    });
  }
}

/**
 * stepDeployGbrainSoulRouting — v106 migration to canonicalize the gbrain
 * memory routing block into SOUL.md on every gbrain-eligible VM.
 *
 * Why this exists: stepDeployGbrainSoulProtocol (v102) deployed the gbrain
 * routing into AGENTS.md, but SOUL.md's `## Memory Persistence (CRITICAL)`
 * section retained the OBSOLETE MEMORY.md-first guidance on 8 of 9 edge_city
 * VMs. Agents read SOUL.md at session start; the contradictory routing
 * (MEMORY.md-first in SOUL, gbrain-first in AGENTS) produced incoherent
 * behavior. Only vm-050 had been hand-fixed via scripts/_push_gbrain_fix.ts
 * on 2026-05-17.
 *
 * This step REPLACES the section (not INSERT, unlike stepDeployGbrainSoulProtocol).
 * Reason: the two versions occupy the same logical role; keeping both leaves
 * the agent with contradictory instructions. Replacement is destructive but
 * safeguarded by:
 *   - Rule 22 backup (~/.openclaw/backups/v106-gbrain-soul-routing-<ts>/SOUL.md)
 *   - Rule 23 sentinel guard (refuses to write if canonical content is missing
 *     known unique strings — defends against stale module cache regressions)
 *   - Drift-check via sha256 of the on-disk section: only replaces if sha
 *     matches GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS (vanilla or vm-050).
 *     Drift → SKIP + P1 admin alert (6h dedup) → never silently destructive.
 *   - Atomic write (tmp + os.replace)
 *   - Verify-after-write (marker grep)
 *
 * Triple gate (defense in depth — same shape as stepDeployGbrainSoulProtocol
 * post-2026-05-19 hardening; kept in lock-step via shared
 * GBRAIN_PARTNER_ALLOWLIST + env var):
 *   1. vm.partner ∈ GBRAIN_PARTNER_ALLOWLIST (covers VM-reassign edge case
 *      via freeze→thaw or manual partner mutation)
 *   2. gbrain.service active on the VM
 *   3. GBRAIN_INSTALL_ENABLED env var === "true"
 *
 * Idempotency: GBRAIN_SOUL_ROUTING_V1 marker check. Skip if present.
 *
 * Source: workspace-templates-v2.GBRAIN_SOUL_ROUTING_V1_SECTION (~3.3KB,
 * base64-decoded from vm-050's exact on-disk bytes; preserves legacy
 * `\\`` escapes byte-for-byte so the drift-check vm-050 sha matches).
 */
async function stepDeployGbrainSoulRouting(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null; name?: string | null; gbrain_enabled?: boolean | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // ── Gate 1: gbrain eligibility (partner allowlist OR explicit canary opt-in) ──
  if (!isGbrainEligibleForVM(vm)) return;

  // ── Gate 2: env var ──
  if (process.env.GBRAIN_INSTALL_ENABLED !== "true") return;

  // ── Gate 3: gbrain.service active ──
  const probe = await ssh.execCommand(
    `${HEAL_DBUS_PREFIX} && systemctl --user is-active gbrain.service 2>&1 | head -1`,
    { execOptions: { timeout: 5_000 } } as any,
  );
  if ((probe.stdout || "").trim() !== "active") {
    // Silent skip — gbrain hasn't been installed/started yet on this VM.
    // Next cycle (after stepGbrain installs/starts it) will catch up.
    return;
  }

  // ── Sentinel guard (Rule 23) — verify canonical block in-memory ──
  // Refuses to write if our resolved canonical content is missing any of the
  // required sentinels. Defends against the 2026-05-02 strip-thinking class
  // of bug (stale module cache silently writing wrong content fleet-wide).
  const missingSentinels = GBRAIN_SOUL_ROUTING_V1_REQUIRED_SENTINELS.filter(
    (s) => !GBRAIN_SOUL_ROUTING_V1_SECTION.includes(s),
  );
  if (missingSentinels.length) {
    result.errors.push(
      `gbrain-soul-routing: in-memory canonical missing required sentinels [${missingSentinels.join(", ")}] — refusing to write. Restart reconciler to reload module state.`,
    );
    return;
  }

  // ── Marker probe (cheap idempotency) ──
  const markerCheck = await ssh.execCommand(
    `grep -cF '${GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER}' ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo 0`,
    { execOptions: { timeout: 5_000 } } as any,
  );
  if (parseInt((markerCheck.stdout || "0").trim(), 10) > 0) {
    result.alreadyCorrect.push("gbrain-soul-routing (V1 marker present)");
    return;
  }

  if (dryRun) {
    result.fixed.push("[dry-run] gbrain-soul-routing: would replace `## Memory Persistence (CRITICAL)` section with GBRAIN_SOUL_ROUTING_V1 marker-bounded block");
    return;
  }

  // ── Python in-place transform with drift-check + backup + atomic write ──
  // The TS-side passes config via base64 to avoid shell-escape issues. The
  // Python script:
  //   1. Reads SOUL.md
  //   2. Finds start_anchor and end_anchor; if missing → status: anchors_missing
  //   3. Computes sha256 of current_section = soul[start_idx:end_idx]
  //   4. If sha ∉ KNOWN_OK_SHAS → status: drift_detected (skip + alert)
  //   5. Backs up SOUL.md to ~/.openclaw/backups/v106-gbrain-soul-routing-<ts>/SOUL.md
  //   6. Builds new_content = soul[:start_idx] + canonical_section + soul[end_idx:]
  //   7. Atomic write (tmp + os.replace)
  //   8. Verify-after-write (marker grep on disk)

  const ts = Date.now();
  const cfg = {
    soul_path: "~/.openclaw/workspace/SOUL.md",
    backup_path: `~/.openclaw/backups/v106-gbrain-soul-routing-${ts}/SOUL.md`,
    canonical_section: GBRAIN_SOUL_ROUTING_V1_SECTION,
    start_anchor: GBRAIN_SOUL_ROUTING_V1_START_ANCHOR,
    end_anchor: GBRAIN_SOUL_ROUTING_V1_END_ANCHOR,
    begin_marker: GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER,
    known_ok_shas: [...GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS],
  };
  const cfgB64 = Buffer.from(JSON.stringify(cfg), "utf-8").toString("base64");

  const PATCH_PY = `
import base64, hashlib, json, os, sys

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))

soul_path = os.path.expanduser(cfg["soul_path"])
backup_path = os.path.expanduser(cfg["backup_path"])

def out(d):
    print(json.dumps(d))
    sys.exit(0)

if not os.path.exists(soul_path):
    out({"status": "missing"})

with open(soul_path, "r", encoding="utf-8") as f:
    content = f.read()

# Idempotency double-check (the caller already checked, but races are possible)
if cfg["begin_marker"] in content:
    out({"status": "already-present"})

# Locate section boundaries
start_idx = content.find(cfg["start_anchor"])
end_idx = content.find(cfg["end_anchor"])
if start_idx < 0 or end_idx < 0 or end_idx <= start_idx:
    out({
        "status": "anchors_missing",
        "start_found": start_idx >= 0,
        "end_found": end_idx >= 0,
    })

# Drift check
current_section = content[start_idx:end_idx]
current_sha = hashlib.sha256(current_section.encode("utf-8")).hexdigest()
if current_sha not in cfg["known_ok_shas"]:
    snippet = current_section[:200].replace("\\n", " ")
    out({
        "status": "drift_detected",
        "sha": current_sha,
        "snippet": snippet,
    })

# Backup (Rule 22) — directory may not exist yet
os.makedirs(os.path.dirname(backup_path), exist_ok=True)
with open(backup_path, "w", encoding="utf-8") as f:
    f.write(content)

# Build new content
new_content = content[:start_idx] + cfg["canonical_section"] + content[end_idx:]

# Atomic write
tmp = soul_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(new_content)
os.replace(tmp, soul_path)

# Verify after write
with open(soul_path, "r", encoding="utf-8") as f:
    final = f.read()
if cfg["begin_marker"] not in final:
    out({"status": "verify_failed", "final_size": len(final)})

out({
    "status": "ok",
    "size_before": len(content),
    "size_after": len(new_content),
    "section_sha_before": current_sha,
})
`;

  const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
  const cmd = `python3 <(echo '${scriptB64}' | base64 -d) '${cfgB64}'`;
  const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30_000 } } as any);

  if (r.code !== 0) {
    result.errors.push(
      `gbrain-soul-routing python failed rc=${r.code}: ${(r.stderr || r.stdout).slice(0, 200)}`,
    );
    return;
  }

  const lines = (r.stdout || "").split("\n").map((l: string) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  let parsed: {
    status?: string;
    sha?: string;
    snippet?: string;
    size_before?: number;
    size_after?: number;
    section_sha_before?: string;
    start_found?: boolean;
    end_found?: boolean;
    final_size?: number;
  } = {};
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    result.errors.push(`gbrain-soul-routing: could not parse python output: ${lastLine.slice(0, 200)}`);
    return;
  }

  if (parsed.status === "missing") {
    result.errors.push("gbrain-soul-routing: SOUL.md missing — configureOpenClaw should have created it");
    return;
  }
  if (parsed.status === "already-present") {
    result.alreadyCorrect.push("gbrain-soul-routing (marker found by python)");
    return;
  }
  if (parsed.status === "anchors_missing") {
    result.warnings.push(
      `gbrain-soul-routing: section anchors missing (start_found=${parsed.start_found} end_found=${parsed.end_found}) — agent likely customized SOUL.md heavily. Skipping.`,
    );
    return;
  }
  if (parsed.status === "drift_detected") {
    const observedSha = parsed.sha || "unknown";
    const snippet = parsed.snippet || "";
    // Push to warnings (NOT errors) per Rule 39 — drift on a paying-customer
    // VM is operator-actionable but does NOT block cv-bump for the rest of
    // the fleet. Fire admin alert (6h dedup per VM).
    result.warnings.push(
      `gbrain-soul-routing: drift detected (sha=${observedSha.slice(0, 12)}) — section was customized; admin alert dispatched. cv-bump proceeds.`,
    );
    // Fire-and-forget; do not await (don't slow down the reconcile cycle)
    const displayName = vm.name ?? vm.id;
    sendGbrainSoulRoutingDriftAlertDeduped(displayName, vm.id, observedSha, snippet)
      .catch((err) => {
        logger.warn("gbrain-soul-routing drift alert dispatch failed", {
          route: "lib/vm-reconcile/stepDeployGbrainSoulRouting",
          vmName: displayName,
          error: String(err).slice(0, 200),
        });
      });
    return;
  }
  if (parsed.status === "verify_failed") {
    result.errors.push(
      `gbrain-soul-routing: verify-after-write failed (final_size=${parsed.final_size})`,
    );
    return;
  }
  if (parsed.status === "ok") {
    result.fixed.push(
      `gbrain-soul-routing: replaced \`## Memory Persistence (CRITICAL)\` section (SOUL.md ${parsed.size_before} → ${parsed.size_after} bytes, prior sha=${(parsed.section_sha_before || "").slice(0, 12)})`,
    );
    return;
  }
  result.errors.push(`gbrain-soul-routing: unexpected status=${parsed.status}`);
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

// ─── stepChatGPTOAuthToken (Day 11-15 — closes Day 1-4 end-to-end) ───────
//
// PURPOSE
//   Reflects each user's ChatGPT-subscription OAuth state from
//   instaclaw_users → the VM's auth-profiles.json + agents.defaults.model.primary.
//   Without this step, Day 1-4 stored tokens server-side but the VM never
//   knew about them — the agent kept routing to Claude. Broken promise.
//
// FLOW
//   1. Look up the assigned user. If no user, no-op.
//   2. Read user.openai_token_version + vm.openai_token_version_synced.
//      Cheap version-bump idempotency for the "never connected" majority
//      of users (skip without SSH).
//   3. For users who HAVE OAuth state to sync, SSH-read auth-profiles.json
//      and verify the openai-codex:default entry matches the DB-decrypted
//      access token. If matches → just bump synced (covers the recovery
//      case where stepAuthProfiles wiped and was then fixed).
//   4. If DB has a fresh non-expired token + on-disk doesn't match:
//      atomically rewrite the file (preserving anthropic:default and any
//      other profiles), set agents.defaults.model.primary to
//      openai-codex/gpt-5.5, update vm.api_mode + vm.default_model in DB,
//      bump vm.openai_token_version_synced, mark gatewayRestartNeeded.
//   5. If DB has NULL tokens (user disconnected via modal): remove
//      openai-codex:default from the file, reset model.primary to whatever
//      vm.default_model says (which disconnectUser already set to claude),
//      bump synced.
//   6. If DB has an EXPIRED token: log warning, skip (don't push stale).
//      The refresh cron (Day 16-18) will refresh + bump user version →
//      next reconcile re-syncs cleanly.
//
// IDEMPOTENCY
//   Two layers:
//     - DB version check (cheap): user_version <= synced_version → skip.
//       But ONLY if user has no access_token. If user has a token, we
//       still SSH-verify to recover from stepAuthProfiles wipes.
//     - On-disk verify: compare openai-codex:default.key prefix to
//       decrypted DB token. Equal → no SSH write, but ensure synced is
//       bumped.
//
// FEATURE FLAG
//   NOT gated on isChatGPTOAuthEnabled(). The kill switch is enforced
//   upstream by the API routes (start route blocks new connections) and
//   downstream by the graceful-downgrade cron (which NULLs user tokens
//   within ~5min of flag flip). This step just reflects DB → VM. Gating
//   here would create user-visible inconsistency (DB says connected, VM
//   says Claude) during the transient window.
//
// FAILURE MODES (per Rule 39 classification)
//   - decryptSecret throws → result.errors (load-bearing: tokens are
//     the entire value proposition; broken decrypt = broken feature)
//   - SSH read/write fails → result.errors (same)
//   - DB lookup fails → result.warnings (transient; next tick retries)
//
// SENTINEL (Rule 23)
//   The embedded SSH script for atomic-write is parameterized at run time
//   with the base64 of the desired JSON. Sentinel-grep happens via the
//   verify-after-write check (Rule 10) — we re-read the file and compare
//   the openai-codex:default.key prefix to the desired prefix. If mismatch,
//   push to result.errors so the cv-bump gate refuses to advance.
async function stepChatGPTOAuthToken(
  ssh: SSHConnection,
  vm: VMRecord & { assigned_to?: string | null; openai_token_version_synced?: number | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  if (!vm.assigned_to) return;

  // 1. Fetch user OAuth state
  const sb = getSupabase();
  const { data: user, error: userErr } = await sb
    .from("instaclaw_users")
    .select("*")
    .eq("id", vm.assigned_to)
    .single();
  if (userErr || !user) {
    // Transient or VM points at a deleted user — warn, don't block cv bump.
    result.warnings.push(
      `chatgpt-oauth: user lookup failed (vm.assigned_to=${vm.assigned_to.slice(0, 8)}): ${userErr?.message?.slice(0, 120) ?? "no rows"}`,
    );
    return;
  }

  const userVersion = (user.openai_token_version as number | undefined) ?? 0;
  const syncedVersion = vm.openai_token_version_synced ?? 0;
  const encryptedAccess = user.openai_oauth_access_token as string | null | undefined;
  const expiresAtIso = user.openai_oauth_expires_at as string | null | undefined;
  const accountId = user.openai_oauth_account_id as string | null | undefined;
  const userId = vm.assigned_to;

  // 2. Cheap path: never-connected user (no access token AND already synced).
  if (!encryptedAccess && syncedVersion >= userVersion) {
    result.alreadyCorrect.push("chatgpt-oauth (never-connected, synced)");
    return;
  }

  // 3. Disconnected user (had tokens, now NULL — version bumped by disconnectUser).
  if (!encryptedAccess) {
    await applyDisconnectedState(ssh, vm, userId, userVersion, result, dryRun);
    return;
  }

  // 4. Expired token — log + skip (don't push stale).
  if (expiresAtIso && new Date(expiresAtIso).getTime() <= Date.now()) {
    logger.warn("chatgpt-oauth: token expired, refresh cron should refresh", {
      route: "vm-reconcile",
      vmId: vm.id,
      userId: userId.slice(0, 8),
      expiresAt: expiresAtIso,
    });
    result.warnings.push(
      `chatgpt-oauth: token expired at ${expiresAtIso} — awaiting refresh cron`,
    );
    return;
  }

  // 4b. NULL expires_at with a token present is an anomaly — storeOAuthTokens
  // always populates expires_at from the JWT. A NULL with access_token set
  // suggests bug-elsewhere or manual DB manipulation. We log + fall back to
  // JWT-decode below (after decrypt) so we can still push with a correct
  // expires field (pi-ai's hasUsableOAuthCredential REQUIRES expires).
  if (!expiresAtIso) {
    logger.warn("chatgpt-oauth: token present but expires_at is NULL — will fallback to JWT exp", {
      route: "vm-reconcile",
      vmId: vm.id,
      userId: userId.slice(0, 8),
    });
  }

  // 5. Active token — decrypt + push if drift detected.
  let accessToken: string;
  try {
    accessToken = decryptSecret(encryptedAccess, userId);
  } catch (err) {
    if (err instanceof KeyMissingError || err instanceof DecryptError) {
      result.errors.push(
        `chatgpt-oauth: decrypt failed for user ${userId.slice(0, 8)}: ${err.name} — ${err.message.slice(0, 120)}`,
      );
      logger.error("chatgpt-oauth: decrypt failed", {
        route: "vm-reconcile",
        vmId: vm.id,
        userId: userId.slice(0, 8),
        errorName: err.name,
      });
      return;
    }
    throw err;
  }

  // P2-A: decrypted token must be non-empty. encryptSecret("") is a valid
  // operation (round-trip verified in encryption tests), so an empty value
  // is possible if upstream code accidentally stored "". Refuse to push
  // an empty bearer (would yield 401 from OpenAI on the agent's next
  // request). Push to errors so the cv-bump gate blocks until upstream
  // is fixed.
  if (accessToken.length === 0) {
    result.errors.push(
      `chatgpt-oauth: decrypted access token is empty for user ${userId.slice(0, 8)} — possible storage corruption, refusing to push`,
    );
    logger.error("chatgpt-oauth: empty decrypted token", {
      route: "vm-reconcile",
      vmId: vm.id,
      userId: userId.slice(0, 8),
    });
    return;
  }

  // Compute expiresAtMs (pi-ai REQUIRES this — hasUsableOAuthCredential
  // returns false without a valid future-epoch expires). Prefer DB ISO
  // (canonical, set at storeOAuthTokens time). Fall back to decoding the
  // access token's JWT exp claim (matches pi-ai's resolveCodexAccessTokenExpiry).
  let expiresAtMs: number | null = null;
  if (expiresAtIso) {
    const parsed = new Date(expiresAtIso).getTime();
    if (Number.isFinite(parsed) && parsed > 0) expiresAtMs = parsed;
  }
  if (expiresAtMs === null) {
    expiresAtMs = extractCodexJwtExpMs(accessToken);
  }
  if (expiresAtMs === null) {
    // Refuse to push without a valid expires — pi-ai would silently reject
    // the profile (returns false from hasUsableOAuthCredential), leaving
    // the agent in a "no API key" error loop. Push to errors so cv-bump
    // blocks; surfaces the issue for operator triage.
    result.errors.push(
      `chatgpt-oauth: cannot determine token expiry for user ${userId.slice(0, 8)} (DB expires_at NULL AND JWT exp missing/invalid) — refusing to push`,
    );
    logger.error("chatgpt-oauth: expiry resolution failed", {
      route: "vm-reconcile",
      vmId: vm.id,
      userId: userId.slice(0, 8),
    });
    return;
  }

  await applyConnectedState(
    ssh,
    vm,
    userId,
    userVersion,
    accessToken,
    expiresAtMs,
    accountId ?? null,
    result,
    dryRun,
  );
}

/**
 * Decode the OpenAI Codex access token's JWT exp claim → ms epoch.
 * Mirrors pi-ai's resolveCodexAccessTokenExpiry from
 * @mariozechner/pi-ai/utils/oauth/openai-codex. Returns null if the token
 * isn't a 3-part JWT, the payload can't be parsed, or exp is missing/invalid.
 */
function extractCodexJwtExpMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    const exp = payload?.exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return Math.trunc(exp) * 1000;
    if (typeof exp === "string" && /^\d+$/.test(exp.trim())) return Number.parseInt(exp.trim(), 10) * 1000;
    return null;
  } catch {
    return null;
  }
}

/**
 * SSH-write the openai-codex:default profile to auth-profiles.json
 * (merging with existing profiles), set model.primary to
 * openai-codex/gpt-5.5, update DB-side api_mode + default_model + synced
 * version. Idempotent: skips SSH writes if on-disk already matches.
 *
 * Profile shape MUST match pi-ai's hasUsableOAuthCredential$1
 * (node_modules/openclaw/dist/store-D-8DaAtv.js — checks credential.type,
 * credential.access, credential.expires). Field names "access" + "expires"
 * are LOAD-BEARING — earlier versions used {key, metadata:{accountId}}
 * which pi-ai silently rejected, leaving the agent in a "No API key found"
 * loop while the file looked correct on disk (2026-05-20 vm-780 incident).
 *
 * Defense-in-depth: we DO NOT include the refresh token in the on-VM
 * profile. The server-side hourly cron rotates access tokens and re-pushes
 * via this step; pi-ai's runtime never needs to self-refresh. Smaller
 * blast radius if a VM is compromised — attacker gets a short-lived
 * access token, no long-term refresh capability.
 */
async function applyConnectedState(
  ssh: SSHConnection,
  vm: VMRecord,
  userId: string,
  userVersion: number,
  accessToken: string,
  expiresAtMs: number,
  accountId: string | null,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Read current auth-profiles.json
  const readRes = await ssh.execCommand(
    'cat ~/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null',
  );
  let existingProfiles: Record<string, unknown> = {};
  if (readRes.code === 0 && readRes.stdout.trim()) {
    try {
      const parsed = JSON.parse(readRes.stdout) as { profiles?: Record<string, unknown> };
      if (parsed.profiles && typeof parsed.profiles === "object") {
        existingProfiles = parsed.profiles;
      }
    } catch {
      // Unparseable — treat as empty. The write below will rebuild cleanly.
    }
  }

  // Build the pi-ai-shaped OAuth credential. accountId at top level (NOT
  // under metadata) per shouldMirrorRefreshedOAuthCredential's identity
  // check (existing.accountId).
  const desired: {
    type: "oauth";
    provider: "openai-codex";
    access: string;
    expires: number;
    accountId?: string;
  } = {
    type: "oauth",
    provider: "openai-codex",
    access: accessToken,
    expires: expiresAtMs,
  };
  if (accountId) desired.accountId = accountId;

  // Idempotency: on-disk profile matches what we'd write → no SSH write
  // needed for the file. We still ensure DB-side state is up-to-date below.
  const onDisk = existingProfiles["openai-codex:default"] as
    | { type?: string; provider?: string; access?: string; expires?: number; accountId?: string | null }
    | undefined;
  const onDiskMatches =
    !!onDisk &&
    onDisk.type === "oauth" &&
    onDisk.provider === "openai-codex" &&
    onDisk.access === accessToken &&
    onDisk.expires === expiresAtMs &&
    (onDisk.accountId ?? null) === (accountId ?? null);

  if (!onDiskMatches) {
    if (dryRun) {
      result.fixed.push(
        `[dry-run] chatgpt-oauth: would write openai-codex:default (token=${accessToken.slice(0, 12)}…, expires=${new Date(expiresAtMs).toISOString()})`,
      );
      return;
    }
    const mergedProfiles = { ...existingProfiles, "openai-codex:default": desired };
    const json = JSON.stringify({ profiles: mergedProfiles });
    const b64 = Buffer.from(json, "utf-8").toString("base64");
    // Atomic write: tmp + rename. Standard pattern across the file.
    const writeRes = await ssh.execCommand(
      `mkdir -p ~/.openclaw/agents/main/agent && ` +
        `echo '${b64}' | base64 -d > ~/.openclaw/agents/main/agent/auth-profiles.json.tmp && ` +
        `mv ~/.openclaw/agents/main/agent/auth-profiles.json.tmp ~/.openclaw/agents/main/agent/auth-profiles.json`,
    );
    if (writeRes.code !== 0) {
      result.errors.push(
        `chatgpt-oauth: auth-profiles.json write failed: ${(writeRes.stderr || writeRes.stdout).slice(0, 200)}`,
      );
      return;
    }
    // Verify-after-write (Rule 10): re-read and confirm openai-codex.access
    // prefix AND that expires is the numeric we wrote. Both fields are
    // load-bearing for hasUsableOAuthCredential — verifying both catches
    // any future shape regression in the same kind of incident as 2026-05-20.
    const verifyRes = await ssh.execCommand(
      `cat ~/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); p=d.get("profiles",{}).get("openai-codex:default",{}); print(p.get("access","<missing>")[:16] + "|" + str(p.get("expires","<missing>")))'`,
    );
    const verifyOut = (verifyRes.stdout || "").trim();
    const expectedToken = accessToken.slice(0, 16);
    const expected = `${expectedToken}|${expiresAtMs}`;
    if (verifyOut !== expected) {
      result.errors.push(
        `chatgpt-oauth: verify mismatch — on-disk=${verifyOut.slice(0, 60)} expected=${expected.slice(0, 60)}`,
      );
      return;
    }
    logger.info("TOKEN_AUDIT: chatgpt-oauth profile pushed", {
      route: "vm-reconcile",
      vmId: vm.id,
      userId: userId.slice(0, 8),
      tokenPrefix: accessToken.slice(0, 12),
      expiresAt: new Date(expiresAtMs).toISOString(),
      accountId,
      userVersion,
    });
    // CRITICAL — load-bearing per 2026-05-20 vm-780 incident.
    //
    // auth-profiles.json is loaded into memory once at gateway startup
    // (see `[gateway] resolving authentication…` journal line). Pi-ai
    // does NOT re-read the file when its mtime changes. A profile push
    // without a gateway restart leaves the running process serving from
    // the in-memory snapshot captured at the LAST restart — so a token
    // rotation, shape fix, or account swap is invisible at runtime
    // until something else (model.primary change, manual restart) cycles
    // the process.
    //
    // The 2026-05-20 incident: we shipped a profile-shape fix, the
    // reconciler pushed it correctly, but model.primary was already
    // correct from a prior cycle, so the old conditional `if (curModel
    // !== targetModel)` restart trigger never fired. Cooper's gateway
    // (PID 3701090, started 19:35:58 UTC) continued serving the old
    // profile shape it had cached at startup, even though the on-disk
    // file (mtime 21:15:23 UTC) was correct. Hours of confused debugging.
    //
    // Set the restart flag any time we actually wrote the file —
    // regardless of why. Cheaper than dropping requests.
    if (!dryRun) {
      result.gatewayRestartNeeded = true;
    }
  }

  // Set model.primary to openai-codex/gpt-5.5 if not already.
  // Direct openclaw config set so the switch takes effect THIS cycle
  // (stepEnforceModelPrimary already ran earlier in the orchestrator).
  const targetModel = "openai-codex/gpt-5.5";
  const curModel = (
    await ssh.execCommand(
      `cat ~/.openclaw/openclaw.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("agents",{}).get("defaults",{}).get("model",{}).get("primary","<unset>"))'`,
    )
  ).stdout.trim();
  if (curModel !== targetModel) {
    if (!dryRun) {
      const setRes = await ssh.execCommand(
        `${NVM_PREAMBLE} && openclaw config set agents.defaults.model.primary '${targetModel}' 2>&1`,
        { execOptions: { timeout: 30_000 } },
      );
      if (setRes.code !== 0) {
        result.errors.push(
          `chatgpt-oauth: model.primary set failed: ${(setRes.stdout + setRes.stderr).slice(-200)}`,
        );
        return;
      }
      result.gatewayRestartNeeded = true;
    }
    result.fixed.push(`chatgpt-oauth: model.primary ${curModel} → ${targetModel}`);
  }

  // Update DB-side state: api_mode + default_model + synced version.
  if (!dryRun) {
    const sb = getSupabase();
    const { error: vmUpdateErr } = await sb
      .from("instaclaw_vms")
      .update({
        api_mode: "chatgpt_oauth",
        default_model: targetModel,
        openai_token_version_synced: userVersion,
      })
      .eq("id", vm.id);
    if (vmUpdateErr) {
      // DB-write failure doesn't roll back the SSH writes — VM is in the
      // right state, DB is stale. Next reconcile will detect via version
      // mismatch and re-push (idempotent on-disk).
      result.warnings.push(
        `chatgpt-oauth: vm row update failed (state pushed but DB stale): ${vmUpdateErr.message.slice(0, 120)}`,
      );
      return;
    }
  }

  if (onDiskMatches) {
    // Same on-disk state but DB was stale — just bumped synced + maybe
    // confirmed model.primary. Don't add to fixed (no real change), but
    // record in alreadyCorrect for visibility.
    result.alreadyCorrect.push(`chatgpt-oauth (in-sync, version=${userVersion})`);
  } else {
    result.fixed.push(`chatgpt-oauth: pushed token v${userVersion}`);
  }
}

/**
 * Remove openai-codex:default from auth-profiles.json + revert model.primary
 * to whatever vm.default_model now says (disconnectUser already set it
 * to claude-sonnet-4-6). Bumps synced version.
 */
async function applyDisconnectedState(
  ssh: SSHConnection,
  vm: VMRecord,
  userId: string,
  userVersion: number,
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // Read auth-profiles.json to see if openai-codex:default needs removing.
  const readRes = await ssh.execCommand(
    'cat ~/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null',
  );
  let hadEntry = false;
  let mergedProfiles: Record<string, unknown> = {};
  if (readRes.code === 0 && readRes.stdout.trim()) {
    try {
      const parsed = JSON.parse(readRes.stdout) as { profiles?: Record<string, unknown> };
      if (parsed.profiles && typeof parsed.profiles === "object") {
        if ("openai-codex:default" in parsed.profiles) {
          hadEntry = true;
          mergedProfiles = { ...parsed.profiles };
          delete mergedProfiles["openai-codex:default"];
        }
      }
    } catch {
      // Unparseable — nothing to remove. stepAuthProfiles will rebuild.
    }
  }

  if (hadEntry) {
    if (dryRun) {
      result.fixed.push("[dry-run] chatgpt-oauth: would remove openai-codex:default");
      return;
    }
    const json = JSON.stringify({ profiles: mergedProfiles });
    const b64 = Buffer.from(json, "utf-8").toString("base64");
    const writeRes = await ssh.execCommand(
      `echo '${b64}' | base64 -d > ~/.openclaw/agents/main/agent/auth-profiles.json.tmp && ` +
        `mv ~/.openclaw/agents/main/agent/auth-profiles.json.tmp ~/.openclaw/agents/main/agent/auth-profiles.json`,
    );
    if (writeRes.code !== 0) {
      result.errors.push(
        `chatgpt-oauth: auth-profiles.json disconnect-write failed: ${(writeRes.stderr || writeRes.stdout).slice(0, 200)}`,
      );
      return;
    }
    logger.info("chatgpt-oauth: openai-codex profile removed (user disconnected)", {
      route: "vm-reconcile",
      vmId: vm.id,
      userId: userId.slice(0, 8),
    });
  }

  // Revert model.primary if currently openai-codex/*. Use vm.default_model
  // (which disconnectUser set to claude-sonnet-4-6) → toOpenClawModel.
  const dbDefault =
    (vm as VMRecord & { default_model?: string | null }).default_model || "claude-sonnet-4-6";
  const targetModel = toOpenClawModel(dbDefault);
  const curModel = (
    await ssh.execCommand(
      `cat ~/.openclaw/openclaw.json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("agents",{}).get("defaults",{}).get("model",{}).get("primary","<unset>"))'`,
    )
  ).stdout.trim();
  if (curModel.startsWith("openai-codex/") && curModel !== targetModel) {
    if (!dryRun) {
      const setRes = await ssh.execCommand(
        `${NVM_PREAMBLE} && openclaw config set agents.defaults.model.primary '${targetModel}' 2>&1`,
        { execOptions: { timeout: 30_000 } },
      );
      if (setRes.code !== 0) {
        result.errors.push(
          `chatgpt-oauth: disconnect model.primary set failed: ${(setRes.stdout + setRes.stderr).slice(-200)}`,
        );
        return;
      }
      result.gatewayRestartNeeded = true;
    }
    result.fixed.push(`chatgpt-oauth: disconnect model.primary ${curModel} → ${targetModel}`);
  }

  // Bump synced even if nothing was on-disk (so the cheap-path version
  // check skips us next cycle).
  if (!dryRun) {
    const sb = getSupabase();
    const { error: bumpErr } = await sb
      .from("instaclaw_vms")
      .update({ openai_token_version_synced: userVersion })
      .eq("id", vm.id);
    if (bumpErr) {
      result.warnings.push(
        `chatgpt-oauth: synced-version bump failed: ${bumpErr.message.slice(0, 120)}`,
      );
      return;
    }
  }

  if (hadEntry) {
    result.fixed.push(`chatgpt-oauth: disconnected, synced v${userVersion}`);
  } else {
    result.alreadyCorrect.push(`chatgpt-oauth (disconnected, in-sync v${userVersion})`);
  }
}

// ─── Test-only re-export ─────────────────────────────────────────────────
//
// Production code MUST NOT import this name. It exists so
// scripts/_test-step-chatgpt-oauth-token.ts can exercise the step
// directly without spinning up reconcileVM's full orchestrator. The
// double-underscore prefix is the convention signal — anything starting
// with `__testOnly_` is internal testing surface.
export const __testOnly_stepChatGPTOAuthToken = stepChatGPTOAuthToken;
