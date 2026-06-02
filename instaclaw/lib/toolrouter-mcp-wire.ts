/**
 * lib/toolrouter-mcp-wire.ts
 *
 * Shared wire/unwire/probe helpers for the ToolRouter MCP entry in
 * ~/.openclaw/openclaw.json. Used by:
 *
 *   - lib/vm-reconcile.ts:stepToolRouter — the reconciler's gated wire-up
 *     (writes when user.world_id_verified=true, unwires when false)
 *   - app/api/auth/world-id/verify/route.ts:propagateVerificationToVM —
 *     the instant-unlock hero path. A user taps verify, Worldcoin
 *     confirms, the existing SSH session writes the MCP config inline,
 *     premium tools appear in seconds. The reconciler is the safety net.
 *
 * Both callsites need to do the same gate checks (TOOLROUTER_ENABLED, API
 * key shape, transport selection, wrapper-on-disk sentinel) and the same
 * verify-after-write discipline. Extracting them here keeps both callers
 * in sync — any future change to the wire-up shape lands in one place.
 *
 * Failure posture (Rule 39): every helper returns a result discriminated
 * by `status`. None throw. Callers decide whether the outcome lands in
 * result.warnings, result.errors, a logger line, or just-keep-going.
 *
 * Rule 23 (sentinel guard): the wire path probes the wrapper .mjs for
 * the TOOLROUTER_WRAPPER_V1 sentinel before writing MCP config. A
 * stale-cache or half-written wrapper produces a clean DEFERRED result,
 * not a broken MCP entry that OpenClaw would fail to spawn.
 */

import {
  buildToolRouterMcpConfig,
  getToolRouterEnv,
  type ToolRouterTransport,
} from "./toolrouter-client";
import { NVM_PREAMBLE } from "./ssh";

// Canonical wrapper deployment path. Mirrors lib/vm-reconcile.ts's
// TOOLROUTER_WRAPPER_PATH constant; defined here to avoid an import cycle.
// Source of truth is the manifest entry in lib/vm-manifest.ts:files[]
// that deploys TOOLROUTER_WRAPPER_MJS to this path.
export const TOOLROUTER_WRAPPER_PATH =
  "/home/openclaw/.openclaw/scripts/toolrouter-wrapper.mjs";

// SSH shape both callers (NodeSSH directly + the wrapped ENOSPC-guarded
// proxy from lib/enospc-guard.ts) match structurally. Using `any` here
// keeps the module decoupled from node-ssh's exact type surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SSHLike = any;

// ── Probe result ─────────────────────────────────────────────────────────
export interface ToolRouterProbe {
  present: boolean;       // mcp.servers.toolrouter exists at all
  correct: boolean;       // discriminator matches expected for the active transport
  rawValue: string;       // current on-disk discriminator value (for diagnostics)
  transport: ToolRouterTransport;
}

/**
 * Probe ~/.openclaw/openclaw.json for the current state of the
 * `mcp.servers.toolrouter` entry. Returns:
 *   - present: anything at all under that key
 *   - correct: discriminator (.command for stdio, .transport for streamable-http)
 *     matches the expected K.4 value
 *   - rawValue: the actual discriminator string (empty if absent)
 *
 * Caller decides what to do with the combination:
 *   verified + correct       → no-op
 *   verified + present-wrong → rewrite
 *   verified + absent        → write
 *   unverified + present     → unset
 *   unverified + absent      → no-op
 */
export async function probeToolRouterMcp(
  ssh: SSHLike,
  transport: ToolRouterTransport,
): Promise<ToolRouterProbe> {
  // jq emits "" for missing/null. We probe BOTH .command and the full
  // .toolrouter object so we can distinguish "absent" from "present-wrong"
  // without two SSH round-trips.
  const probe = await ssh.execCommand(
    `jq -r '.mcp.servers.toolrouter // null | if . == null then "ABSENT" else ` +
      (transport === "stdio"
        ? `(.command // "") end' "$HOME/.openclaw/openclaw.json" 2>/dev/null`
        : `(.transport // "") end' "$HOME/.openclaw/openclaw.json" 2>/dev/null`),
  );
  const raw = (probe.stdout || "").trim();
  const expected = transport === "stdio" ? "node" : "streamable-http";
  if (raw === "ABSENT" || raw === "") {
    return { present: false, correct: false, rawValue: "", transport };
  }
  // raw === "" inside the present-but-empty-discriminator case (malformed entry)
  // collapses to present:true, correct:false — matches the "rewrite" path.
  return {
    present: true,
    correct: raw === expected,
    rawValue: raw,
    transport,
  };
}

// ── Wire result ──────────────────────────────────────────────────────────
export type WireStatus =
  | "wired"           // MCP config written + verified
  | "already-correct" // on-disk state already matches; no write needed
  | "deferred"        // missing precondition (wrapper not on disk, no env, etc.)
  | "skipped"         // gate said "don't run" (TOOLROUTER_ENABLED=false)
  | "failed";         // a write/verify step failed

export interface WireResult {
  status: WireStatus;
  reason: string;
  transport?: ToolRouterTransport;
}

interface WireOptions {
  dryRun?: boolean;
  // vmId is used for the on-VM tempfile path (per-VM to avoid Date.now() races
  // in concurrent reconciles). Passed through; helper does not consult Supabase.
  vmId: string;
  gatewayToken: string | null;
  instaclawApiUrl?: string;
}

/**
 * Wire mcp.servers.toolrouter into the agent's openclaw.json. Idempotent:
 * - already-correct → returns `{status: "already-correct"}` with no write
 * - present-but-wrong-shape → rewrites + verifies
 * - absent → writes + verifies
 *
 * Returns a `status` that the caller maps to its preferred logging surface
 * (result.fixed / result.alreadyCorrect / result.warnings).
 *
 * Failure posture: any internal failure produces `status: "failed"` or
 * `status: "deferred"`. The helper never throws. The MCP wire is OPTIONAL
 * SaaS — failures must not cascade into the broader configure/verify flow.
 */
export async function wireToolRouterMcp(
  ssh: SSHLike,
  opts: WireOptions,
): Promise<WireResult> {
  // Gate A: TOOLROUTER_ENABLED (Rule 61 boolean-value check)
  const enabled = process.env.TOOLROUTER_ENABLED;
  if (enabled !== "true") {
    if (
      enabled !== undefined &&
      enabled !== "" &&
      enabled !== "false" &&
      enabled !== "0" &&
      enabled !== "no"
    ) {
      return {
        status: "skipped",
        reason: `TOOLROUTER_ENABLED='${enabled}' (expected 'true' — possible typo)`,
      };
    }
    return { status: "skipped", reason: "TOOLROUTER_ENABLED not 'true'" };
  }

  // Gate B: API key + URL present and shape-valid
  const env = getToolRouterEnv();
  if (!env) {
    return {
      status: "deferred",
      reason: "TOOLROUTER_API_KEY missing or failed shape check",
    };
  }

  // Gate C: transport selection
  const transport: ToolRouterTransport =
    process.env.TOOLROUTER_TRANSPORT === "streamable-http"
      ? "streamable-http"
      : "stdio";

  // Gate D: stdio-only — wrapper file must be present AND non-empty AND
  // contain the V1 sentinel. Catches Rule 23 stale-template-cache failures
  // before they reach OpenClaw's spawn machinery.
  let wrapperConfig: {
    wrapperPath: string;
    gatewayToken: string;
    instaclawApiUrl?: string;
  } | null = null;
  if (transport === "stdio") {
    if (!opts.gatewayToken) {
      return {
        status: "deferred",
        reason: "vm.gateway_token missing (wrapper requires it)",
      };
    }
    const wrapperProbe = await ssh.execCommand(
      `test -s "${TOOLROUTER_WRAPPER_PATH}" && ` +
        `grep -q TOOLROUTER_WRAPPER_V1 "${TOOLROUTER_WRAPPER_PATH}" && ` +
        `echo ok || echo missing`,
    );
    if (!((wrapperProbe.stdout || "").includes("ok"))) {
      return {
        status: "deferred",
        reason:
          "wrapper .mjs missing/empty/sentinel-absent — wait for stepFiles",
      };
    }
    wrapperConfig = {
      wrapperPath: TOOLROUTER_WRAPPER_PATH,
      gatewayToken: opts.gatewayToken,
      instaclawApiUrl: opts.instaclawApiUrl,
    };
  }

  // Probe current state — short-circuit on already-correct
  const probe = await probeToolRouterMcp(ssh, transport);
  if (probe.correct) {
    return {
      status: "already-correct",
      reason: `discriminator=${probe.rawValue}`,
      transport,
    };
  }

  if (opts.dryRun) {
    return {
      status: "wired",
      reason: `[dry-run] would write mcp.servers.toolrouter (transport=${transport}, was=${probe.rawValue || "absent"})`,
      transport,
    };
  }

  // Write via `openclaw mcp set` (atomic merge, hot-reload-trigger per Rule 32)
  const mcpJson = JSON.stringify(
    buildToolRouterMcpConfig(env.apiKey, transport, env.apiUrl, wrapperConfig),
  );
  const tmpPath = `/tmp/toolrouter-mcp-${opts.vmId}.json`;

  const upload = await ssh.execCommand(
    `cat > ${tmpPath} && chmod 600 ${tmpPath}`,
    { stdin: mcpJson },
  );
  if (upload.code !== 0) {
    return {
      status: "failed",
      reason: `upload mcp.json failed (exit=${upload.code}): ${(upload.stderr || "").slice(0, 150)}`,
      transport,
    };
  }

  const setCmd = await ssh.execCommand(
    `${NVM_PREAMBLE} && openclaw mcp set toolrouter "$(cat ${tmpPath})" 2>&1; SET_RC=$?; rm -f ${tmpPath}; exit $SET_RC`,
  );
  if (setCmd.code !== 0) {
    return {
      status: "failed",
      reason: `openclaw mcp set failed (exit=${setCmd.code}): ${(setCmd.stdout || "").slice(-200)}`,
      transport,
    };
  }

  // Verify-after-set per Rule 10
  const verify = await probeToolRouterMcp(ssh, transport);
  if (!verify.correct) {
    return {
      status: "failed",
      reason: `verify-after-set: discriminator=${verify.rawValue.slice(0, 50) || "absent"}`,
      transport,
    };
  }

  return {
    status: "wired",
    reason: `transport=${transport}, apiKeyPrefix=${env.apiKey.slice(0, 7)}`,
    transport,
  };
}

/**
 * Remove mcp.servers.toolrouter from openclaw.json. Idempotent:
 * - absent → returns `{status: "already-correct"}` with no write
 * - present → unsets + verifies absent
 *
 * Used when the WorldID gate detects the user is unverified. Reading the
 * helper's name as a verb makes the call-site readable:
 *   if (!verified) await unwireToolRouterMcp(ssh)
 */
export async function unwireToolRouterMcp(
  ssh: SSHLike,
  opts: { dryRun?: boolean } = {},
): Promise<WireResult> {
  // Determine current transport just so probeToolRouterMcp can report
  // accurately. unwire itself doesn't care about transport — `openclaw mcp
  // unset toolrouter` removes the key regardless.
  const transport: ToolRouterTransport =
    process.env.TOOLROUTER_TRANSPORT === "streamable-http"
      ? "streamable-http"
      : "stdio";

  const probe = await probeToolRouterMcp(ssh, transport);
  if (!probe.present) {
    return {
      status: "already-correct",
      reason: "mcp.servers.toolrouter already absent",
      transport,
    };
  }

  if (opts.dryRun) {
    return {
      status: "wired", // semantic abuse: "did what was needed"; caller logs explicitly
      reason: `[dry-run] would unset mcp.servers.toolrouter (was discriminator=${probe.rawValue})`,
      transport,
    };
  }

  const unset = await ssh.execCommand(
    `${NVM_PREAMBLE} && openclaw mcp unset toolrouter 2>&1`,
  );
  if (unset.code !== 0) {
    return {
      status: "failed",
      reason: `openclaw mcp unset failed (exit=${unset.code}): ${(unset.stdout || "").slice(-200)}`,
      transport,
    };
  }

  // Verify-after-unset per Rule 10 — re-probe and confirm absent
  const verify = await probeToolRouterMcp(ssh, transport);
  if (verify.present) {
    return {
      status: "failed",
      reason: `verify-after-unset: still present (discriminator=${verify.rawValue.slice(0, 50)})`,
      transport,
    };
  }

  return {
    status: "wired", // semantic abuse: caller will log as "unset" explicitly
    reason: `was discriminator=${probe.rawValue}`,
    transport,
  };
}
