/**
 * lib/bake/steps.ts — All BakeStep definitions in one place.
 *
 * Each step exposes: id, phase, description, estimated_seconds, retryable,
 * recovery_hint, preconditions, action, postconditions, rollback.
 *
 * The orchestrator iterates this array in order. Each step is idempotent
 * (safe to re-run on resume).
 *
 * Per design doc §3.3 "Order of operations".
 */

import { execSync } from "child_process";
import { existsSync, statSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

import type { BakeContext, BakeStep, StepResult } from "./step-spec";
import {
  createInstance,
  deleteInstance,
  shutdownInstance,
  waitForStatus,
  pollSshReady,
  createImage,
  waitForImageAvailable,
  findExt4Disk,
  getInstaclawDeployKey,
  generateRandomRootPassword,
  generateSnapshotLabel,
  countImagesInProgress,
  LinodeTimeoutError,
} from "./linode-api";
import { readSourcePins, detectEnvVarReferences, distinctEnvVars, hashReconcilerStepSequence, detectV106Landing } from "./source-of-truth";
import {
  readLastBakeFingerprint,
  writeBakeFingerprint,
  type BakeFingerprint,
} from "./state";
import { computeDriftReport, formatDriftReport } from "./drift";
import { auditVercelProdEnv } from "./vercel-env-audit";
import { buildSyntheticVM, runReconcileOnBakeVM } from "./synthetic-vm";
import { runStripBearer, verifyStripped } from "./strip-bearer";
import { verifyCheckpointInstall } from "./checkpoint-verify";
import { envVarSet, envVarAbsent, openSsh, sshExec } from "./verifications";
import { REQUIRED_BAKE_TOOLING_ENV, DANGER_BAKE_TOOLING_ENV } from "./env-loader";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

function getSshKey(): string {
  return Buffer.from(process.env.SSH_PRIVATE_KEY_B64 ?? "", "base64").toString("utf-8");
}

async function ssh<T>(ip: string, fn: (c: any) => Promise<T>): Promise<T> {
  const c = await openSsh(ip);
  try {
    return await fn(c);
  } finally {
    c.end();
  }
}

function ok(output: string[] = [], state_updates = {}): StepResult {
  return { ok: true, output, state_updates };
}

function fail(message: string, output: string[] = []): StepResult {
  return { ok: false, output: [...output, `FAIL: ${message}`] };
}

// ─── PHASE: preflight ────────────────────────────────────────────────────────

function preflightEnvVars(): BakeStep {
  return {
    id: "preflight-env-vars",
    phase: "preflight",
    description: "Required bake-tooling env vars present",
    estimated_seconds: 1,
    retryable: true,
    recovery_hint: "Add missing vars to instaclaw/.env.local and re-run.",
    preconditions: [],
    action: async (ctx) => {
      const out: string[] = [];
      const missing: string[] = [];
      for (const name of REQUIRED_BAKE_TOOLING_ENV) {
        if (!process.env[name]) missing.push(name);
        else out.push(`  ${name}: present`);
      }
      const warnings: string[] = [];
      for (const name of DANGER_BAKE_TOOLING_ENV) {
        if (process.env[name]) {
          warnings.push(
            `${name} is set to "${process.env[name]}" — silently skips bake VM if not whitelisting it. Unset for this shell.`,
          );
        }
      }
      if (missing.length > 0) {
        return fail(`missing required env: ${missing.join(", ")}`, out);
      }
      if (process.env.RECONCILE_SOUL_MIGRATION_ENABLED !== "true") {
        warnings.push(
          "RECONCILE_SOUL_MIGRATION_ENABLED is not 'true' — V2 templates will NOT deploy. Set in .env.local.",
        );
      }
      return ok(out, { warnings });
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function preflightCapturePins(): BakeStep {
  return {
    id: "preflight-capture-pins",
    phase: "preflight",
    description: "Read live source-of-truth pins (gbrain, manifest, OpenClaw, Node)",
    estimated_seconds: 1,
    retryable: true,
    recovery_hint: "If extraction fails, the source files may have been reorganized — update lib/bake/source-of-truth.ts regex patterns.",
    preconditions: [],
    action: async (ctx) => {
      const pins = readSourcePins(ctx.repo_root);
      return ok(
        [
          `  GBRAIN_PINNED_COMMIT=${pins.gbrain_commit}`,
          `  GBRAIN_PINNED_VERSION=${pins.gbrain_version}`,
          `  VM_MANIFEST.version=${pins.manifest_version}`,
          `  OPENCLAW_PINNED_VERSION=${pins.openclaw_pinned_version ?? "(unset)"}`,
          `  NODE_VERSION=${pins.node_version ?? "(unset)"}`,
          `  BOOTSTRAP_MAX_CHARS=${pins.bootstrap_max_chars}`,
          `  SECRET_VERSION=${pins.secret_version ?? "(unset)"}`,
          `  GBRAIN_PARTNER_ALLOWLIST=[${pins.gbrain_partner_allowlist.join(", ")}]`,
        ],
        { source_pins: pins },
      );
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function preflightV106Detect(): BakeStep {
  return {
    id: "preflight-v106-detect",
    phase: "preflight",
    description: "Detect v106 (stepDeployGbrainSoulRouting) landing path",
    estimated_seconds: 1,
    retryable: true,
    recovery_hint: "Path B is acceptable per design doc §2.6.6 — bake proceeds.",
    preconditions: [],
    action: async (ctx) => {
      const d = detectV106Landing(ctx.repo_root);
      return ok(
        [
          `  path: ${d.path}`,
          `  step_present: ${d.detected_signals.step_present}`,
          `  constant_present: ${d.detected_signals.constant_present}`,
          `  manifest >= 106: ${d.detected_signals.manifest_at_106_or_higher}`,
        ],
        { v106_path: d.path },
      );
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function preflightDriftDetect(): BakeStep {
  return {
    id: "preflight-drift-detect",
    phase: "preflight",
    description: "Compare against last-bake fingerprint (env vars, pins, reconciler hash)",
    estimated_seconds: 1,
    retryable: true,
    recovery_hint: "Drift is P1 by default — review and proceed unless concerned about a specific change.",
    preconditions: [],
    action: async (ctx) => {
      const last = readLastBakeFingerprint();
      const report = computeDriftReport(ctx.repo_root, last);
      const out = [`  ${formatDriftReport(report).split("\n").join("\n  ")}`];
      const warnings: string[] = [];
      if (report.any_drift) {
        if (report.new_env_vars.length > 0) {
          warnings.push(
            `New env vars detected in vm-reconcile.ts since last bake: ${report.new_env_vars.join(", ")}. ` +
              `Review whether they affect bake behavior and update lib/bake/env-loader.ts if so.`,
          );
        }
        if (report.reconciler_hash_changed) {
          warnings.push(
            "Reconciler step-sequence hash changed since last bake. A new step was likely added — verify it's bake-safe.",
          );
        }
      }
      const stepHash = hashReconcilerStepSequence(ctx.repo_root);
      return ok(out, {
        drift: {
          new_env_vars: report.new_env_vars,
          changed_pins: report.changed_pins,
          reconciler_hash_changed: report.reconciler_hash_changed,
          last_bake_hash: last?.reconciler_hash ?? null,
          current_hash: stepHash.hash,
        },
        warnings,
      });
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function preflightVercelAudit(): BakeStep {
  return {
    id: "preflight-vercel-audit",
    phase: "preflight",
    description: "Audit Vercel production env (Family C: convergence env vars)",
    estimated_seconds: 30,
    retryable: true,
    recovery_hint: "CLI may not be installed/authed — run `npx vercel login`. P1, not P0.",
    preconditions: [],
    action: async (ctx) => {
      const result = await auditVercelProdEnv();
      const out: string[] = [`  cli_available: ${result.cli_available}`];
      if (!result.cli_available) {
        return ok(
          [...out, ...result.notes.map((n) => `  note: ${n}`)],
          { warnings: ["Vercel CLI unavailable — Family C audit skipped (P1)."] },
        );
      }
      for (const v of result.vars) {
        out.push(`  ${v.present ? "✓" : "✗"} ${v.name} (${v.expected})`);
      }
      const warnings: string[] = result.ok ? [] : [
        `Vercel prod env missing: ${result.vars.filter((v) => !v.present).map((v) => v.name).join(", ")}`,
      ];
      return ok([...out, ...result.notes.map((n) => `  note: ${n}`)], { warnings });
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function preflightRunPreBakeCheck(): BakeStep {
  return {
    id: "preflight-pre-bake-check",
    phase: "preflight",
    description: "Run scripts/_pre-bake-check.ts (existing 964-line gate)",
    estimated_seconds: 30,
    retryable: true,
    recovery_hint: "Read _pre-bake-check.ts output and fix CRITICAL findings before retrying.",
    preconditions: [],
    action: async (ctx) => {
      const cmd = `cd ${JSON.stringify(ctx.repo_root)} && npx tsx scripts/_pre-bake-check.ts`;
      try {
        const stdout = execSync(cmd, { encoding: "utf-8", timeout: 60_000 });
        return ok([`  _pre-bake-check.ts: exit 0`, `  output lines: ${stdout.split("\n").length}`]);
      } catch (e: any) {
        const stdout = e.stdout?.toString?.() ?? "";
        const code = e.status ?? "?";
        return fail(
          `_pre-bake-check.ts exit ${code}. Review output for CRITICAL findings.`,
          stdout.split("\n").slice(-30),
        );
      }
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: provision ────────────────────────────────────────────────────────

function provisionCreateInstance(): BakeStep {
  return {
    id: "provision-create-instance",
    phase: "provision",
    description: "Create Linode g6-nanode-1 from LINODE_SNAPSHOT_ID",
    estimated_seconds: 60,
    retryable: false, // Re-running would create a duplicate VM. Resume should skip.
    recovery_hint: "If this fails, no Linode VM is created. Re-run.",
    preconditions: [envVarSet("LINODE_API_TOKEN")],
    action: async (ctx) => {
      const sshKey = await getInstaclawDeployKey();
      const label = `snapshot-bake-${ctx.state.run_id}`.replace(/:/g, "-");
      const inst = await createInstance({
        label,
        region: ctx.state.bake_vm.region,
        type: ctx.state.bake_vm.type,
        image: ctx.state.source_snapshot_id,
        root_pass: generateRandomRootPassword(),
        authorized_keys: [sshKey],
      });
      return ok(
        [`  linode_id=${inst.id}`, `  label=${inst.label}`, `  status=${inst.status}`],
        {
          bake_vm: {
            ...ctx.state.bake_vm,
            linode_id: inst.id,
            ip_address: inst.ipv4[0] ?? null,
            label,
          },
        },
      );
    },
    postconditions: [],
    rollback: async (ctx) => {
      if (ctx.state.bake_vm.linode_id) {
        try {
          await deleteInstance(ctx.state.bake_vm.linode_id);
          ctx.log(`rollback: deleted linode ${ctx.state.bake_vm.linode_id}`);
        } catch (e) {
          ctx.log(`rollback: delete failed: ${(e as Error).message}`);
        }
      }
    },
  };
}

function provisionWaitRunning(): BakeStep {
  return {
    id: "provision-wait-running",
    phase: "provision",
    description: "Wait for instance status=running (60-90s typical)",
    estimated_seconds: 90,
    retryable: true,
    recovery_hint: "If Linode is slow, re-run. If the VM is in a failed state, destroy + re-provision.",
    preconditions: [],
    action: async (ctx) => {
      const id = ctx.state.bake_vm.linode_id;
      if (!id) return fail("no linode_id in state");
      const inst = await waitForStatus(id, "running", 5 * 60 * 1000);
      return ok(
        [`  status=${inst.status}`, `  ipv4=${inst.ipv4.join(",")}`],
        {
          bake_vm: { ...ctx.state.bake_vm, ip_address: inst.ipv4[0] ?? null },
        },
      );
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function provisionWaitSSH(): BakeStep {
  return {
    id: "provision-wait-ssh",
    phase: "provision",
    description: "Wait for SSH ready (cloud-init host-key regen, ~60s)",
    estimated_seconds: 90,
    retryable: true,
    recovery_hint: "If SSH never comes up, the SSH key may not have been authorized — check Linode profile sshkeys.",
    preconditions: [],
    action: async (ctx) => {
      const ip = ctx.state.bake_vm.ip_address;
      if (!ip) return fail("no bake VM IP");
      await pollSshReady(ip, getSshKey(), 5 * 60 * 1000);
      return ok([`  SSH ready at ${ip}`]);
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: upgrade-os ───────────────────────────────────────────────────────

function upgradeOpenClawAndPinNode(): BakeStep {
  return {
    id: "upgrade-os-openclaw",
    phase: "upgrade-os",
    description: "Install latest openclaw (npm) + pin nodejs (apt-mark hold)",
    estimated_seconds: 120,
    retryable: true,
    recovery_hint: "Network issue or npm registry hiccup — re-run. Idempotent.",
    preconditions: [],
    action: async (ctx) => {
      const ip = ctx.state.bake_vm.ip_address!;
      const cmd = `
set -e
source ~/.nvm/nvm.sh
npm install -g openclaw@latest 2>&1 | tail -10
openclaw --version
sudo apt-mark hold nodejs 2>&1 || true
apt-mark showhold | grep nodejs || true
`;
      const r = await ssh(ip, (c) => sshExec(c, cmd, 180_000));
      if (r.code !== 0) return fail(`upgrade exit ${r.code}`, [r.stderr.slice(-300)]);
      return ok(r.stdout.split("\n").filter(Boolean).slice(-10));
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: reconcile ────────────────────────────────────────────────────────

function reconcileAcquireCronLock(): BakeStep {
  return {
    id: "reconcile-acquire-lock",
    phase: "reconcile",
    description: "Acquire reconcile-fleet cron lock (4h TTL)",
    estimated_seconds: 5,
    retryable: true,
    recovery_hint: "If lock is held by a Vercel cron run, wait 3 minutes and retry.",
    preconditions: [],
    action: async (ctx) => {
      // Dynamic import to avoid eager Supabase init.
      // @ts-ignore — dynamic path
      const mod = await import(resolve(ctx.repo_root, "lib/cron-lock.ts"));
      const acquired = await mod.tryAcquireCronLock(
        "reconcile-fleet",
        4 * 3600,
        `autonomous-bake-${ctx.state.run_id}`,
      );
      if (!acquired) return fail("reconcile-fleet lock held by another process");
      return ok([`  acquired (4h TTL)`], {
        cron_lock: { acquired: true, acquired_at: new Date().toISOString() },
      });
    },
    postconditions: [],
    rollback: async (ctx) => {
      if (ctx.state.cron_lock.acquired) {
        try {
          // @ts-ignore — dynamic path
          const mod = await import(resolve(ctx.repo_root, "lib/cron-lock.ts"));
          await mod.releaseCronLock("reconcile-fleet");
          ctx.log("rollback: released reconcile-fleet lock");
        } catch (e) {
          ctx.log(`rollback: release lock failed: ${(e as Error).message}`);
        }
      }
    },
  };
}

function reconcileRunAudit(): BakeStep {
  return {
    id: "reconcile-run-audit",
    phase: "reconcile",
    description: "Run auditVMConfig (50+ reconciler steps in strict mode)",
    estimated_seconds: 25 * 60,
    retryable: false, // re-running is idempotent but expensive — caller decides
    recovery_hint: "Read errors[] + strictErrors[] in output. Common: build-essential missing, ufw missing, GBRAIN_INSTALL_ENABLED unset for non-edge install path.",
    preconditions: [envVarSet("RECONCILE_SOUL_MIGRATION_ENABLED")],
    action: async (ctx) => {
      // ── Override reconcileVM's strict-mode 180s deadline for the bake ──
      // The bake VM provisions fresh from an N-version-old snapshot. The
      // reconcile must apply every fix from the snapshot's cv (e.g. 113)
      // up to the current manifest version (e.g. 120) — 7+ versions of
      // drift. Single-tick wall-clock can hit 8+ minutes legitimately
      // (Rule 44: "strict-deadline ≠ failure"). Vercel cron's 180s is
      // sized for steady-state 1-version drift — a fresh-snapshot bake
      // is a fundamentally different workload. Set to 45 min (estimated
      // 25 min step × 1.8 buffer) — bake runs in a local Node process
      // with no Vercel function-timeout pressure.
      // Bug surfaced 2026-05-25 (first 2026.4.26→v120 bake attempt
      // failed at 180s on step=config-settings, fresh from cv=113 source).
      // The env var is read by lib/vm-reconcile.ts:STRICT_DEADLINE_MS.
      const prevDeadlineOverride = process.env.STRICT_DEADLINE_MS_OVERRIDE;
      process.env.STRICT_DEADLINE_MS_OVERRIDE = String(45 * 60 * 1000);
      const synthVM = buildSyntheticVM(ctx.state);
      let r;
      try {
        r = await runReconcileOnBakeVM(
          synthVM,
          { strict: true, dryRun: ctx.dry_run, skipGatewayRestart: false },
          ctx.repo_root,
        );
      } finally {
        // Restore previous value so subsequent steps (or test runs) see
        // the production default behavior.
        if (prevDeadlineOverride === undefined) {
          delete process.env.STRICT_DEADLINE_MS_OVERRIDE;
        } else {
          process.env.STRICT_DEADLINE_MS_OVERRIDE = prevDeadlineOverride;
        }
      }
      const out = [
        `  fixed: ${r.fixed.length}`,
        `  alreadyCorrect: ${r.alreadyCorrect.length}`,
        `  warnings: ${r.warnings.length}`,
        `  errors: ${r.errors.length}`,
        `  strictErrors: ${r.strictErrors.length}`,
        `  gatewayRestarted: ${r.gatewayRestarted}`,
      ];
      if (r.errors.length > 0) {
        for (const e of r.errors.slice(0, 5)) out.push(`    err: ${e.slice(0, 150)}`);
      }
      if (r.strictErrors.length > 0) {
        for (const e of r.strictErrors.slice(0, 5)) out.push(`    strict-err: ${e.slice(0, 150)}`);
      }
      if (r.errors.length > 0 || r.strictErrors.length > 0) {
        return fail("auditVMConfig returned errors", out);
      }
      return ok(out, {
        synthetic_vm: { inserted: false, id: synthVM.id },
      });
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: gbrain-install ───────────────────────────────────────────────────

function gbrainInstall(): BakeStep {
  return {
    id: "gbrain-install",
    phase: "gbrain-install",
    description: "Install gbrain HTTP sidecar via install-gbrain.sh (Phase A-I)",
    estimated_seconds: 180,
    retryable: true,
    recovery_hint: "If PHASE_C2_WARN: patch failed — pglite-checkpoint will be inert. Investigate gbrain-patches.",
    preconditions: [],
    action: async (ctx) => {
      const ip = ctx.state.bake_vm.ip_address!;
      const sshKey = process.env.SSH_PRIVATE_KEY_B64
        ? Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString()
        : "";

      // SCP the install-gbrain.sh + dependencies to /tmp
      // We do this via ssh2's sftp interface to avoid shelling out.
      // @ts-ignore — ssh2 types
      const { Client: SshClient } = await import("ssh2");
      const filesToScp = [
        "scripts/install-gbrain.sh",
        "scripts/verify-gbrain-mcp.py",
        "scripts/pglite-checkpoint.sh",
        "scripts/gbrain-patches/0001-add-checkpoint-mcp-tool.patch",
      ];

      await new Promise<void>((resolveScp, reject) => {
        const c = new SshClient();
        c.on("ready", async () => {
          c.sftp(async (err, sftp) => {
            if (err) {
              c.end();
              return reject(err);
            }
            try {
              for (const rel of filesToScp) {
                const local = resolve(ctx.repo_root, rel);
                if (!existsSync(local)) {
                  ctx.log(`gbrain-install: skipping missing file ${rel}`);
                  continue;
                }
                const remote = `/tmp/${rel.split("/").pop()}`;
                await new Promise<void>((res, rej) => {
                  sftp.fastPut(local, remote, (e: Error | undefined) => (e ? rej(e) : res()));
                });
              }
              c.end();
              resolveScp();
            } catch (e) {
              c.end();
              reject(e);
            }
          });
        })
          .on("error", reject)
          .connect({ host: ip, port: 22, username: "openclaw", privateKey: sshKey, readyTimeout: 15_000 });
      });

      // Invoke install-gbrain.sh with current pins
      const pins = ctx.state.source_pins;
      const cmd = `GBRAIN_PINNED_COMMIT=${pins.gbrain_commit} GBRAIN_PINNED_VERSION=${pins.gbrain_version} bash /tmp/install-gbrain.sh`;
      const r = await ssh(ip, (c) => sshExec(c, cmd, 10 * 60 * 1000));

      const lines = (r.stdout + "\n" + r.stderr).split("\n");
      const phaseMarkers = ["A", "B", "C", "C2", "D", "E", "F", "G", "H", "I"]
        .map((p) => ({
          phase: p,
          ok: lines.some((l) => l.includes(`PHASE_${p}_OK`)),
          warn: lines.some((l) => l.includes(`PHASE_${p}_WARN`)),
        }));
      const installComplete = lines.some((l) => l.includes("INSTALL_COMPLETE"));

      const phaseLines = phaseMarkers
        .map((p) => `  PHASE_${p.phase}: ${p.warn ? "WARN" : p.ok ? "OK" : "MISSING"}`)
        .join("\n");

      if (!installComplete) {
        return fail("install-gbrain.sh did not reach INSTALL_COMPLETE", [
          phaseLines,
          ...lines.slice(-10),
        ]);
      }
      // C2 WARN is a P1 — Rule 54 protection is inert without it.
      const warnings: string[] = [];
      if (phaseMarkers.find((p) => p.phase === "C2")?.warn) {
        warnings.push(
          "PHASE_C2_WARN: CHECKPOINT MCP tool patch did not apply. The CHECKPOINT cron will be inert. Rule 54 protection degraded.",
        );
      }

      return ok([phaseLines, `  INSTALL_COMPLETE`], { warnings });
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: checkpoint-verify ────────────────────────────────────────────────

function checkpointVerify(): BakeStep {
  return {
    id: "checkpoint-verify",
    phase: "checkpoint-verify",
    description: "Verify Phase C2 patch + Phase I cron + ExecStop + trial CHECKPOINT",
    estimated_seconds: 30,
    retryable: true,
    recovery_hint: "If any check fails: re-run gbrain-install (idempotent — Phase A early-exits if version matches).",
    preconditions: [],
    action: async (ctx) => {
      const r = await verifyCheckpointInstall(ctx.state.bake_vm.ip_address!);
      const lines = r.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);
      if (r.trial_checkpoint_latency_ms !== null) {
        lines.push(`  trial CHECKPOINT latency: ${r.trial_checkpoint_latency_ms}ms`);
      }
      if (!r.ok) return fail("one or more checkpoint-verify checks failed", lines);
      return ok(lines);
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: v102-verify ──────────────────────────────────────────────────────

function v102Verify(): BakeStep {
  return {
    id: "v102-verify",
    phase: "v102-verify",
    description: "Verify GBRAIN_MEMORY_PROTOCOL_V1 marker in AGENTS.md",
    estimated_seconds: 5,
    retryable: true,
    recovery_hint: "If marker absent: re-run reconcile (stepDeployGbrainSoulProtocol gates on gbrain.service active).",
    preconditions: [],
    action: async (ctx) => {
      const ip = ctx.state.bake_vm.ip_address!;
      const r = await ssh(ip, (c) =>
        sshExec(c, `grep -c 'GBRAIN_MEMORY_PROTOCOL_V1' ~/.openclaw/workspace/AGENTS.md 2>/dev/null || echo 0`),
      );
      const count = parseInt(r.stdout.trim(), 10);
      if (count < 2) return fail(`expected ≥2 markers (open+close), got ${count}`);
      return ok([`  markers found: ${count} (expected 2: open + close)`]);
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: strip-bearer ─────────────────────────────────────────────────────

function stripBearerStep(): BakeStep {
  return {
    id: "strip-bearer",
    phase: "strip-bearer",
    description: "Strip per-VM bearer + access_tokens + disable gbrain.service",
    estimated_seconds: 30,
    retryable: true,
    recovery_hint: "If strip fails partway: the operation is idempotent — re-run safe.",
    preconditions: [],
    action: async (ctx) => {
      const r = await runStripBearer(ctx.state.bake_vm.ip_address!);
      if (!r.success) {
        return fail(`strip-bearer: ${r.steps_failed.join("; ")}`, r.output.slice(-15));
      }
      // Independent verification
      const checks = await verifyStripped(ctx.state.bake_vm.ip_address!);
      const lines = [
        `  steps_completed: ${r.steps_completed.join(", ")}`,
        ...checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`),
      ];
      const allOk = checks.every((c) => c.ok);
      if (!allOk) return fail("post-strip verification failed", lines);
      return ok(lines);
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: cleanup ──────────────────────────────────────────────────────────

function preBakeCleanup(): BakeStep {
  return {
    id: "pre-bake-cleanup",
    phase: "cleanup",
    description: "Run _prebake-cleanup.sh --confirm",
    estimated_seconds: 120,
    retryable: true,
    recovery_hint: "Idempotent — re-run safe. If new fail mode, inspect _prebake-cleanup.sh output for the specific section.",
    preconditions: [],
    action: async (ctx) => {
      const ip = ctx.state.bake_vm.ip_address!;

      // SCP the cleanup script
      const sshKey = process.env.SSH_PRIVATE_KEY_B64
        ? Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString()
        : "";
      // @ts-ignore — ssh2 types
      const { Client: SshClient } = await import("ssh2");
      await new Promise<void>((res, rej) => {
        const c = new SshClient();
        c.on("ready", () => {
          c.sftp((err, sftp) => {
            if (err) {
              c.end();
              return rej(err);
            }
            sftp.fastPut(
              resolve(ctx.repo_root, "scripts/_prebake-cleanup.sh"),
              "/tmp/_prebake-cleanup.sh",
              (e: Error | undefined) => {
                c.end();
                e ? rej(e) : res();
              },
            );
          });
        })
          .on("error", rej)
          .connect({ host: ip, port: 22, username: "openclaw", privateKey: sshKey, readyTimeout: 15_000 });
      });

      // Run cleanup
      const cmd = `
touch ~/.snapshot-bake-mode
sudo -v
bash /tmp/_prebake-cleanup.sh --confirm 2>&1 | tail -50
`;
      const r = await ssh(ip, (c) => sshExec(c, cmd, 5 * 60 * 1000));
      if (r.code !== 0) {
        return fail(`cleanup exit ${r.code}`, r.stdout.split("\n").slice(-30));
      }
      return ok(r.stdout.split("\n").slice(-20));
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: validate ─────────────────────────────────────────────────────────

function postBakeValidate(): BakeStep {
  return {
    id: "post-bake-validate",
    phase: "validate",
    description: "Run _postbake-validation.ts --mode=bake (110 checks)",
    estimated_seconds: 60,
    retryable: true,
    recovery_hint: "P0 fails block bake — read validator output for the specific check.",
    preconditions: [],
    action: async (ctx) => {
      const ip = ctx.state.bake_vm.ip_address!;
      const cmd = `cd ${JSON.stringify(ctx.repo_root)} && npx tsx scripts/_postbake-validation.ts --vm-ip=${ip} --mode=bake`;
      try {
        const stdout = execSync(cmd, { encoding: "utf-8", timeout: 5 * 60 * 1000 });
        const lines = stdout.split("\n");
        // Look for the standard summary line in _postbake-validation.ts output:
        //   "P0: X/Y passed" etc.
        const summary = lines.filter((l) => /^P[012]:/.test(l.trim())).slice(-5);
        return ok([...summary, `  exit=0`]);
      } catch (e: any) {
        const stdout = e.stdout?.toString?.() ?? "";
        return fail(`_postbake-validation exit ${e.status}`, stdout.split("\n").slice(-30));
      }
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: disk-check ───────────────────────────────────────────────────────

function diskCheck(): BakeStep {
  return {
    id: "disk-check",
    phase: "disk-check",
    description: "Verify disk usage < 5,900 MB (well under 6,144 MB Linode cap)",
    estimated_seconds: 5,
    retryable: true,
    recovery_hint: "If over: run additional cleanup. Common: ~/.cache, ~/.npm, ~/.gbrain/brain.pglite.PRE-WIPE-*.tar.gz.",
    preconditions: [],
    action: async (ctx) => {
      const ip = ctx.state.bake_vm.ip_address!;
      const r = await ssh(ip, (c) => sshExec(c, "df --output=used / | tail -1"));
      const usedKB = parseInt(r.stdout.trim(), 10);
      const usedMB = Math.round(usedKB / 1024);
      const out = [`  disk used: ${usedMB} MB (cap: 5900 MB target, 6144 MB hard)`];
      if (usedMB > 5900) {
        return fail(`disk usage ${usedMB} MB exceeds 5900 MB target`, out);
      }
      return ok(out);
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: imagize ──────────────────────────────────────────────────────────

function imagizeShutdown(): BakeStep {
  return {
    id: "imagize-shutdown",
    phase: "imagize",
    description: "Shutdown bake VM (must complete before imagize)",
    estimated_seconds: 60,
    retryable: true,
    recovery_hint: "If shutdown stalls > 5min, Linode dashboard force-power-off, then mark this step succeeded + re-run imagize-create.",
    preconditions: [],
    action: async (ctx) => {
      const id = ctx.state.bake_vm.linode_id!;
      await shutdownInstance(id);
      await waitForStatus(id, "offline", 5 * 60 * 1000);
      return ok([`  linode ${id} status=offline`]);
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function imagizeCreate(): BakeStep {
  return {
    id: "imagize-create",
    phase: "imagize",
    description: "Create private image from bake VM's ext4 disk + poll status=available",
    estimated_seconds: 8 * 60,
    retryable: false, // creates a Linode image — re-run would create a second
    recovery_hint: "If image rejected (404 after creation): disk likely > 6144 MB. Investigate cleanup. If timeout: Linode prep is slow — check dashboard.",
    preconditions: [],
    action: async (ctx) => {
      const id = ctx.state.bake_vm.linode_id!;
      const disk = await findExt4Disk(id);
      const label = generateSnapshotLabel(ctx.state.source_pins.manifest_version);
      const description = `OpenClaw + gbrain v${ctx.state.source_pins.gbrain_version} (commit ${ctx.state.source_pins.gbrain_commit}) HTTP sidecar pre-installed (gbrain.service inactive+disabled — per-VM mint at first reconcile). Phase I CHECKPOINT cron + ExecStop hook present (Rule 54). 110+ post-bake checks passed. Disk usage <6.0GB.`;
      const inflight = await countImagesInProgress();
      if (inflight > 3) {
        ctx.log(`note: ${inflight} private images currently in creating/pending state — may slow this bake's prep`);
      }
      const img = await createImage({ disk_id: disk.id, label, description });
      ctx.log(`  image creation initiated: ${img.id}`);
      const ready = await waitForImageAvailable(img.id, 15 * 60 * 1000);
      return ok(
        [
          `  image_id=${ready.id}`,
          `  label=${ready.label}`,
          `  size=${ready.size} MB`,
          `  status=${ready.status}`,
        ],
        {
          new_snapshot: {
            image_id: ready.id,
            label: ready.label,
            size_mb: ready.size,
            created_at: ready.created,
          },
        },
      );
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function imagizeReleaseLock(): BakeStep {
  return {
    id: "imagize-release-lock",
    phase: "imagize",
    description: "Release reconcile-fleet cron lock",
    estimated_seconds: 2,
    retryable: true,
    recovery_hint: "If release fails, the lock auto-expires after 4h — no permanent harm.",
    preconditions: [],
    action: async (ctx) => {
      try {
        // @ts-ignore
        const mod = await import(resolve(ctx.repo_root, "lib/cron-lock.ts"));
        await mod.releaseCronLock("reconcile-fleet");
        return ok([`  released`], {
          cron_lock: { acquired: false, acquired_at: null },
        });
      } catch (e) {
        return ok([`  release warning: ${(e as Error).message}`], {
          warnings: [`reconcile-fleet lock release returned error (will auto-expire): ${(e as Error).message}`],
        });
      }
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: soak ─────────────────────────────────────────────────────────────

function soakProvision(): BakeStep {
  return {
    id: "soak-provision",
    phase: "soak",
    description: "Provision soak VM from new snapshot (synthetic test)",
    estimated_seconds: 180,
    retryable: false,
    recovery_hint: "If provision fails, the new snapshot may be broken — see logs.",
    preconditions: [],
    action: async (ctx) => {
      if (!ctx.state.new_snapshot.image_id) return fail("no new snapshot id");
      const sshKey = await getInstaclawDeployKey();
      const label = `snapshot-soak-${ctx.state.run_id}`.replace(/:/g, "-");
      const inst = await createInstance({
        label,
        region: ctx.state.bake_vm.region,
        type: "g6-nanode-1",
        image: ctx.state.new_snapshot.image_id,
        root_pass: generateRandomRootPassword(),
        authorized_keys: [sshKey],
        tags: ["instaclaw", "snapshot-bake-soak", "auto"],
      });
      await waitForStatus(inst.id, "running", 5 * 60 * 1000);
      await pollSshReady(inst.ipv4[0], getSshKey(), 5 * 60 * 1000);
      return ok(
        [`  linode_id=${inst.id}`, `  ip=${inst.ipv4[0]}`, `  status=running, ssh-ready`],
        {
          soak_vm: { linode_id: inst.id, ip_address: inst.ipv4[0] ?? null, label },
        },
      );
    },
    postconditions: [],
    rollback: async (ctx) => {
      if (ctx.state.soak_vm.linode_id) {
        try {
          await deleteInstance(ctx.state.soak_vm.linode_id);
          ctx.log(`rollback: deleted soak vm ${ctx.state.soak_vm.linode_id}`);
        } catch (e) {
          ctx.log(`rollback: delete soak vm failed: ${(e as Error).message}`);
        }
      }
    },
  };
}

function soakValidate(): BakeStep {
  return {
    id: "soak-validate",
    phase: "soak",
    description: "Run _postbake-validation.ts --mode=test on soak VM",
    estimated_seconds: 120,
    retryable: true,
    recovery_hint: "If P0 fails on test mode, the new snapshot is broken — DO NOT cutover. Investigate.",
    preconditions: [],
    action: async (ctx) => {
      if (!ctx.state.soak_vm.ip_address) return fail("no soak VM IP");
      const cmd = `cd ${JSON.stringify(ctx.repo_root)} && npx tsx scripts/_postbake-validation.ts --vm-ip=${ctx.state.soak_vm.ip_address} --mode=test`;
      try {
        const stdout = execSync(cmd, { encoding: "utf-8", timeout: 5 * 60 * 1000 });
        const summary = stdout.split("\n").filter((l) => /^P[012]:/.test(l.trim())).slice(-5);
        return ok([...summary, `  exit=0 (soak VM healthy from snapshot)`]);
      } catch (e: any) {
        return fail(`_postbake-validation --mode=test exit ${e.status}`, (e.stdout ?? "").split("\n").slice(-30));
      }
    },
    postconditions: [],
    rollback: async () => {},
  };
}

function soakDestroy(): BakeStep {
  return {
    id: "soak-destroy",
    phase: "soak",
    description: "Destroy soak VM",
    estimated_seconds: 10,
    retryable: true,
    recovery_hint: "Best-effort cleanup — manual delete via Linode dashboard if API fails.",
    preconditions: [],
    action: async (ctx) => {
      if (!ctx.state.soak_vm.linode_id) return ok(["  no soak VM to destroy"]);
      try {
        await deleteInstance(ctx.state.soak_vm.linode_id);
        return ok([`  deleted linode ${ctx.state.soak_vm.linode_id}`]);
      } catch (e) {
        return ok([`  delete warning: ${(e as Error).message}`], {
          warnings: [`soak VM delete failed: ${(e as Error).message}`],
        });
      }
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── PHASE: report ───────────────────────────────────────────────────────────

function generateReport(): BakeStep {
  return {
    id: "generate-report",
    phase: "report",
    description: "Output summary + Cooper-action commands + persist fingerprint",
    estimated_seconds: 5,
    retryable: true,
    recovery_hint: "Idempotent — re-run safe.",
    preconditions: [],
    action: async (ctx) => {
      const s = ctx.state;
      const out: string[] = [];
      out.push("");
      out.push("═══ BAKE COMPLETE ═══");
      out.push(`run_id:           ${s.run_id}`);
      out.push(`source snapshot:  ${s.source_snapshot_id}`);
      out.push(`new snapshot:     ${s.new_snapshot.image_id}`);
      out.push(`new size:         ${s.new_snapshot.size_mb} MB`);
      out.push(`manifest version: ${s.source_pins.manifest_version}`);
      out.push(`gbrain pin:       ${s.source_pins.gbrain_version} (${s.source_pins.gbrain_commit})`);
      out.push(`v106 path:        ${s.v106_path}`);
      out.push(`bake VM linode:   ${s.bake_vm.linode_id}`);
      out.push(`soak VM linode:   ${s.soak_vm.linode_id ?? "(skipped)"}`);
      out.push(`elapsed:          ${Math.round(s.elapsed_seconds / 60)} min`);
      out.push(`warnings:         ${s.warnings.length}`);
      out.push(`errors:           ${s.errors.length}`);
      out.push("");

      // Cooper-action commands
      const cooperActions: string[] = [];
      cooperActions.push("# Update Vercel production env (per Rule 6: use printf, NOT <<< or echo)");
      cooperActions.push("# BOTH env vars must be updated atomically — see lib/ssh.ts:8920 operational contract.");
      cooperActions.push(`printf '${s.new_snapshot.image_id}' | npx vercel env add LINODE_SNAPSHOT_ID production`);
      // CV-init protection per Cooper's 2026-05-24 CRITICAL ADDITIONAL CHECK
      // (and the v113 cv-init bug forensics at lib/ssh.ts:8889-8930). Without
      // updating LINODE_SNAPSHOT_CV in parallel with LINODE_SNAPSHOT_ID, every
      // fresh-from-snapshot VM starts at the OLD baked cv (or 0 if unset) and
      // does the full v(OLD)→v(MANIFEST) reconcile delta on first message —
      // 3-15 min of work overlapping the user's first turn, multiple gateway
      // restarts mid-conversation, customer-down for Edge attendees.
      cooperActions.push(`printf '${s.source_pins.manifest_version}' | npx vercel env add LINODE_SNAPSHOT_CV production  # ← REQUIRED: prevents cv=0 reconcile-storm`);
      cooperActions.push("# Verify BOTH landed:");
      cooperActions.push("npx vercel env ls production | grep -E 'LINODE_SNAPSHOT_(ID|CV)'");
      cooperActions.push("");
      cooperActions.push(`# Bump VM_MANIFEST.version to ${s.source_pins.manifest_version + 1} in a follow-up commit so`);
      cooperActions.push(`# the reconciler's lt(cv, manifest) filter still includes new VMs and runs at`);
      cooperActions.push(`# least one cycle per provision (preserves Rule 23 lying-DB defense). Otherwise`);
      cooperActions.push(`# new VMs at cv=${s.source_pins.manifest_version} are excluded by lt(${s.source_pins.manifest_version}, ${s.source_pins.manifest_version})=false.`);
      cooperActions.push("");
      cooperActions.push("# Rollback (if needed): revert BOTH env vars to previous snapshot's values");
      cooperActions.push(`printf '${s.source_snapshot_id}' | npx vercel env add LINODE_SNAPSHOT_ID production`);
      cooperActions.push(`printf '<previous-LINODE_SNAPSHOT_CV>' | npx vercel env add LINODE_SNAPSHOT_CV production  # ← look up via 'vercel env pull' before cutover so you have the old value`);
      cooperActions.push("");
      cooperActions.push("# Delete bake VM (auto-deletes after successful imagize; this is defensive)");
      cooperActions.push(`curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" https://api.linode.com/v4/linode/instances/${s.bake_vm.linode_id}`);

      out.push("Cooper actions (paste-ready):");
      for (const c of cooperActions) out.push(`  ${c}`);

      // Persist fingerprint
      const fp: BakeFingerprint = {
        completed_at: new Date().toISOString(),
        snapshot_id: s.new_snapshot.image_id!,
        manifest_version: s.source_pins.manifest_version,
        source_pins: s.source_pins,
        reconciler_hash: s.drift.current_hash ?? hashReconcilerStepSequence(ctx.repo_root).hash,
        known_env_vars: distinctEnvVars(detectEnvVarReferences(ctx.repo_root)),
        v106_path: s.v106_path ?? "B",
      };
      writeBakeFingerprint(fp);
      out.push("");
      out.push("Fingerprint persisted to ~/.bake-state/last-bake-fingerprint.json");
      out.push("Next bake will diff against this for drift detection.");

      return ok(out, { cooper_actions: cooperActions, status: "succeeded" as const });
    },
    postconditions: [],
    rollback: async () => {},
  };
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────

/**
 * The full ordered step list. The orchestrator iterates this.
 */
export function buildAllSteps(): BakeStep[] {
  return [
    // preflight
    preflightEnvVars(),
    preflightCapturePins(),
    preflightV106Detect(),
    preflightDriftDetect(),
    preflightVercelAudit(),
    preflightRunPreBakeCheck(),

    // provision
    provisionCreateInstance(),
    provisionWaitRunning(),
    provisionWaitSSH(),

    // upgrade-os
    upgradeOpenClawAndPinNode(),

    // reconcile
    reconcileAcquireCronLock(),
    reconcileRunAudit(),

    // gbrain-install
    gbrainInstall(),

    // checkpoint-verify (BEFORE strip-bearer — trial CHECKPOINT needs active service)
    checkpointVerify(),

    // v102-verify
    v102Verify(),

    // strip-bearer
    stripBearerStep(),

    // cleanup
    preBakeCleanup(),

    // validate
    postBakeValidate(),

    // disk-check
    diskCheck(),

    // imagize
    imagizeShutdown(),
    imagizeCreate(),
    imagizeReleaseLock(),

    // soak (skip if --skip-soak)
    soakProvision(),
    soakValidate(),
    soakDestroy(),

    // report
    generateReport(),
  ];
}
