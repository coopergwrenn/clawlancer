/**
 * lib/cloud-init-userdata.ts -- tiny bash bootstrap for cloud-init first-boot.
 *
 * Generates ~2.3KB bash that does ONE thing:
 *   1. curl /api/vm/cloud-init-config with a one-time-use config_token to fetch a tarball
 *   2. extract the tarball to /tmp staging
 *   3. hand off to setup.sh (in the tarball; does gateway start + callback)
 *
 * This is the Linode user_data payload. All per-user content (openclaw.json,
 * auth-profiles.json, .env, workspace files, wallet key, partner overlays) lives
 * in the tarball, NOT here. The only secret in this bootstrap is configToken
 * -- one-time-use, useless after first /api/vm/cloud-init-config success.
 *
 * Architecture: see docs/cloud-init-builder-plan-2026-05-13.md (v2 bootstrap+fetch).
 * Security: plan Sec6 (two-token design + atomic claim-and-invalidate).
 * Rollback: plan Sec13 (6-layer rollback model).
 *
 * Phase 1A Day 3 deliverable. Pure function. No I/O. Same params -> same output.
 */

// ---- Public types --------------------------------------------------------

/**
 * Params for the bootstrap script. createUserVM passes these in after generating
 * the tokens server-side.
 */
export interface BootstrapParams {
  /** UUID of the user this VM is being provisioned for. */
  userId: string;
  /** VM name, e.g., "instaclaw-vm-a1b2c3d4". */
  vmName: string;
  /** One-time-use hex token authenticating the cloud-init-config fetch. */
  configToken: string;
  /** Vercel deployment URL, e.g., "https://instaclaw.io". HTTPS required. */
  nextauthUrl: string;
}

// ---- Internal constants --------------------------------------------------

/** Bash characters that would break our template-substitution safety guarantee. */
const SHELL_UNSAFE_RE = /[`$\\'"\n\r\t ]/;
/** Allowed shape for vmName (matches lib/providers/hetzner.ts convention). */
const VM_NAME_RE = /^instaclaw-vm-[a-zA-Z0-9_-]+$/;
/** Tokens must be hex (randomBytes(32).toString("hex")). */
const HEX_TOKEN_RE = /^[a-fA-F0-9]+$/;
/**
 * Bootstrap size budget. Expected output is ~2.3KB (template + ~4 short params).
 * 4KB caps template bloat and gives a ~12x safety margin under Linode's ~49KB
 * pre-base64 user_data limit. If this fires, the bootstrap has grown beyond its
 * design -- anything substantial belongs in the tarball.
 */
const BOOTSTRAP_MAX_BYTES = 4_096;

// ---- Validation ----------------------------------------------------------

function validateBootstrapParams(p: BootstrapParams): void {
  if (!p.userId) throw new Error("buildCloudInitUserdata: userId required");
  if (!p.vmName) throw new Error("buildCloudInitUserdata: vmName required");
  if (!VM_NAME_RE.test(p.vmName)) {
    throw new Error(`buildCloudInitUserdata: vmName "${p.vmName}" doesn't match ${VM_NAME_RE}`);
  }
  if (!p.configToken) throw new Error("buildCloudInitUserdata: configToken required");
  if (p.configToken.length < 32) {
    throw new Error(`buildCloudInitUserdata: configToken must be >= 32 chars (got ${p.configToken.length})`);
  }
  if (!HEX_TOKEN_RE.test(p.configToken)) {
    throw new Error("buildCloudInitUserdata: configToken must be hex (randomBytes(32).toString('hex'))");
  }
  if (!p.nextauthUrl) throw new Error("buildCloudInitUserdata: nextauthUrl required");
  if (!p.nextauthUrl.startsWith("https://")) {
    throw new Error(`buildCloudInitUserdata: nextauthUrl must start with https:// (got "${p.nextauthUrl}")`);
  }
  if (p.nextauthUrl.includes("?") || p.nextauthUrl.includes("#")) {
    throw new Error("buildCloudInitUserdata: nextauthUrl must not contain ? or # -- we append our own query string");
  }

  // Shell-injection guard. After this passes, params can be spliced into the bash
  // template without further escaping (the regex above ensures no `, $, \, ',
  // ", whitespace, newline, or carriage return makes it through).
  for (const [k, v] of [
    ["userId", p.userId],
    ["vmName", p.vmName],
    ["configToken", p.configToken],
    ["nextauthUrl", p.nextauthUrl],
  ] as const) {
    if (SHELL_UNSAFE_RE.test(v)) {
      throw new Error(`buildCloudInitUserdata: ${k} contains shell-unsafe character`);
    }
  }
}

// ---- Main ----------------------------------------------------------------

/**
 * Return the complete bash bootstrap script for cloud-init userdata.
 *
 * Caller (createUserVM) base64-encodes the output for the Linode
 * metadata.user_data API field.
 *
 * Throws on invalid params (validateBootstrapParams) or oversized output
 * (BOOTSTRAP_MAX_BYTES).
 */
export function buildCloudInitUserdata(params: BootstrapParams): string {
  validateBootstrapParams(params);
  // Normalize trailing slashes -- caller may pass "https://instaclaw.io" or
  // "https://instaclaw.io/" -- both produce the same URL.
  const base = params.nextauthUrl.replace(/\/+$/, "");

  const script = `#!/bin/bash
set -euo pipefail
mkdir -p /var/log
exec > >(tee -a /var/log/instaclaw-bootstrap.log) 2>&1
trap 'EC=$?; echo "[$(date -u +%FT%TZ)] FATAL bootstrap line $LINENO exit $EC"; touch /tmp/.instaclaw-failed; exit 1' ERR

echo "[$(date -u +%FT%TZ)] instaclaw bootstrap for user ${params.userId} vm ${params.vmName}"

mkdir -p /tmp/instaclaw-config

# Fetch per-user config tarball. config_token is one-time-use; first 200 consumes it.
# 3 attempts x 30s timeout + 5s backoff = max ~100s.
OK=false
for attempt in 1 2 3; do
  if curl -fsS -m 30 \\
      -H "X-Cloud-Init-Config-Token: ${params.configToken}" \\
      "${base}/api/vm/cloud-init-config?userId=${params.userId}&vmName=${params.vmName}" \\
      -o /tmp/instaclaw-config.tar.gz; then
    OK=true; break
  fi
  [ $attempt -lt 3 ] && sleep 5
done
[ "$OK" = "true" ] || { echo "[$(date -u +%FT%TZ)] FATAL: config fetch failed after 3 attempts"; touch /tmp/.instaclaw-failed; exit 1; }

# Extract to /tmp staging (root-owned). setup.sh moves files to final paths.
tar xzf /tmp/instaclaw-config.tar.gz -C /tmp/instaclaw-config
rm -f /tmp/instaclaw-config.tar.gz

# Hand off -- setup.sh owns gateway start, callback POST, sentinels.
bash /tmp/instaclaw-config/setup.sh

# setup.sh exited cleanly. Its tee subprocess has flushed.
# Safe to truncate /var/log/instaclaw-setup.log now (race-free; no live writer).
: > /var/log/instaclaw-setup.log 2>/dev/null || true

# Truncate userdata-at-rest. Cloud-init already loaded this bootstrap into memory
# at boot; the on-disk copy is just data and can be safely zeroed.
for f in /var/lib/cloud/instances/*/user-data.txt; do
  [ -f "$f" ] && : > "$f" 2>/dev/null || true
done

# Cleanup tarball staging. Contains setup.sh + per-user files (callback_token,
# wallet key, etc.) -- all written to final destinations by setup.sh already.
rm -rf /tmp/instaclaw-config

# NOTE: /var/log/instaclaw-bootstrap.log NOT truncated here -- this bootstrap's
# own tee subprocess is still alive, holding the fd. Truncating now would race
# with tee's buffered output. Systemd log rotation handles it.

echo "[$(date -u +%FT%TZ)] bootstrap complete"
exit 0
`;

  if (script.length > BOOTSTRAP_MAX_BYTES) {
    throw new Error(
      `buildCloudInitUserdata: script ${script.length} bytes exceeds BOOTSTRAP_MAX_BYTES (${BOOTSTRAP_MAX_BYTES}). ` +
        `Bootstrap should be tiny -- anything substantial belongs in the tarball. ` +
        `See cloud-init-builder-plan-2026-05-13.md Sec2.`,
    );
  }

  return script;
}

// ---- Test-only export ----------------------------------------------------
//
// For Phase 1A Day 13 size + correctness tests at scripts/_test-cloud-init-bootstrap.ts.
// Not exported for production use (no caller needs internals).
export const __TEST_ONLY = {
  BOOTSTRAP_MAX_BYTES,
  validateBootstrapParams,
};
