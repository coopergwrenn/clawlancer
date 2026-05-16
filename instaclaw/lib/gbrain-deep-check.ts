/**
 * gbrain-deep-check — single-VM end-to-end roundtrip health check.
 *
 * Rule 35 (HTTP sidecar architecture) followup. The cheap V+T+S+P
 * idempotency check in stepGbrain (lib/vm-reconcile.ts) confirms only
 * that the sidecar process is up and the OpenClaw config has the right
 * transport — it does NOT exercise the actual put_page/get_page path.
 *
 * Real failure modes the cheap check misses (per the design doc §2):
 *  - PGLite schema corruption (sidecar serves /health=200 from a stat
 *    query but INSERTs fail mid-write).
 *  - Bearer token drift (file rotated but DB row doesn't reflect, or
 *    vice versa — /mcp initialize might still authenticate via a stale
 *    fallback path; tools/call returns 401).
 *  - Embedding dimension mismatch (sidecar starts fine, every put_page
 *    errors at embed time — the vm-050 2026-05-11 incident).
 *  - OpenAI key revocation (embed call fails for every put_page).
 *  - Sidecar worker thread crashed but /health responds from sibling.
 *
 * The deep check runs the production verify-gbrain-mcp.py (the same
 * script Phase H of install-gbrain.sh uses) against the VM and parses
 * its single-line RESULT_OK / RESULT_FAIL output. Expensive (~2-5s per
 * VM + an OpenAI embed call) so this runs at hourly cadence in a
 * dedicated cron, never on the 3-min reconcile path.
 *
 * Design doc: instaclaw/docs/prd/gbrain-coverage-cron-2026-05-16.md
 */

import type { NodeSSH } from "node-ssh";
import { VERIFY_GBRAIN_MCP_PY } from "./gbrain-scripts-content";

export type DeepCheckStatus = "ok" | "fail" | "skipped";

export interface DeepCheckResult {
  status: DeepCheckStatus;
  /** Set only when status='fail'. One of verify-gbrain-mcp.py's RESULT_FAIL codes. */
  failCode?: string;
  /** Set only when status='skipped'. Free-form reason (no_bearer, ssh_timeout, etc.). */
  skipReason?: string;
  /** Wall-clock for the verify run only (excludes SSH setup). NULL on skip. */
  latencyMs: number;
  /** Correlation marker passed to verify-gbrain-mcp.py — useful for log dives. */
  markerTs: string;
  /** Parsed key=value pairs from the RESULT_OK / RESULT_FAIL line. */
  details: Record<string, string>;
  /** First 500 chars of stdout+stderr — only populated on fail/skip for debugging. */
  rawOutput?: string;
}

/**
 * Parse a `RESULT_OK k=v k=v ...` or `RESULT_FAIL CODE k=v k=v ...` line.
 *
 * Per verify-gbrain-mcp.py contract (line ~125 + ~141), values are
 * unquoted bare tokens (whitespace-separated). The script escapes any
 * whitespace inside a value before printing. Parser is intentionally
 * forgiving — if any kvpair fails to split, we keep going.
 */
function parseResultLine(
  line: string,
): { ok: boolean; failCode?: string; details: Record<string, string> } {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === "RESULT_OK") {
    const details: Record<string, string> = {};
    for (const p of parts.slice(1)) {
      const eq = p.indexOf("=");
      if (eq > 0) details[p.slice(0, eq)] = p.slice(eq + 1);
    }
    return { ok: true, details };
  }
  if (parts[0] === "RESULT_FAIL" && parts.length >= 2) {
    const failCode = parts[1];
    const details: Record<string, string> = {};
    for (const p of parts.slice(2)) {
      const eq = p.indexOf("=");
      if (eq > 0) details[p.slice(0, eq)] = p.slice(eq + 1);
    }
    return { ok: false, failCode, details };
  }
  return { ok: false, failCode: "PARSE_FAIL", details: {} };
}

/**
 * Run a deep gbrain health check against a single VM.
 *
 * Required preconditions on the VM:
 *   - gbrain installed (HTTP sidecar, Rule 35)
 *   - `~/.gbrain/openclaw-bearer-token.txt` exists (mode 600)
 *   - python3 available (always true on our base snapshot)
 *
 * Returns:
 *   - status='ok'      → RESULT_OK printed
 *   - status='fail'    → RESULT_FAIL printed; failCode set
 *   - status='skipped' → precondition missing (no bearer, SSH unreachable,
 *                        gbrain not installed); skipReason set
 *
 * Never throws. SSH errors translate to skipped/fail per shape.
 */
export async function checkGbrainDeepHealth(
  ssh: NodeSSH,
  opts: { ssh_timeout_ms?: number } = {},
): Promise<DeepCheckResult> {
  const markerTs = String(Date.now());
  const sshTimeoutMs = opts.ssh_timeout_ms ?? 90_000;

  // ── 1. Bearer presence check (cheap, single readFile-equivalent) ──
  let bearer = "";
  try {
    const r = await ssh.execCommand(
      "cat ~/.gbrain/openclaw-bearer-token.txt 2>/dev/null",
      { execOptions: { timeout: 5_000 } } as any,
    );
    bearer = (r.stdout || "").trim();
    if (!bearer) {
      return {
        status: "skipped",
        skipReason: "no_bearer",
        latencyMs: 0,
        markerTs,
        details: {},
        rawOutput: (r.stderr || "").slice(0, 500),
      };
    }
  } catch (e: any) {
    return {
      status: "skipped",
      skipReason: `ssh_read_bearer_failed:${String(e?.message ?? e).slice(0, 100)}`,
      latencyMs: 0,
      markerTs,
      details: {},
    };
  }

  // ── 2. Upload verify-gbrain-mcp.py via stdin (no local fs roundtrip) ──
  try {
    const up = await ssh.execCommand(
      "cat > /tmp/verify-gbrain-mcp.py && chmod +x /tmp/verify-gbrain-mcp.py",
      { stdin: VERIFY_GBRAIN_MCP_PY, execOptions: { timeout: 10_000 } } as any,
    );
    if (up.code !== 0) {
      return {
        status: "skipped",
        skipReason: `upload_failed:exit=${up.code}`,
        latencyMs: 0,
        markerTs,
        details: {},
        rawOutput: (up.stderr || "").slice(0, 500),
      };
    }
  } catch (e: any) {
    return {
      status: "skipped",
      skipReason: `upload_threw:${String(e?.message ?? e).slice(0, 100)}`,
      latencyMs: 0,
      markerTs,
      details: {},
    };
  }

  // ── 3. Execute the verify script ──
  //
  // Wall-clock guard at TWO layers per Rule 31:
  //   (a) inside the script, urllib socket timeouts cap each HTTP call (~30s)
  //   (b) outer `timeout 90s` to defend against runaway hangs (e.g., the bun
  //       sidecar going zombie mid-call). Slightly above ssh_timeout_ms to let
  //       SSH win the race when both fire.
  //
  // The verify script reads GBRAIN_BEARER_TOKEN and MARKER_TS from env. We
  // single-quote bearer to defend against any shell-metachars (the token
  // format is `gbrain_<64-hex>` so it should be safe, but quote anyway).
  const startMs = Date.now();
  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  try {
    const r = await ssh.execCommand(
      `timeout 90 env GBRAIN_BEARER_TOKEN='${bearer.replace(/'/g, "'\\''")}' MARKER_TS='${markerTs}' python3 /tmp/verify-gbrain-mcp.py`,
      { execOptions: { timeout: sshTimeoutMs } } as any,
    );
    stdout = r.stdout || "";
    stderr = r.stderr || "";
    code = r.code ?? null;
  } catch (e: any) {
    return {
      status: "skipped",
      skipReason: `verify_threw:${String(e?.message ?? e).slice(0, 100)}`,
      latencyMs: Date.now() - startMs,
      markerTs,
      details: {},
    };
  }
  const latencyMs = Date.now() - startMs;

  // ── 4. Parse RESULT_OK / RESULT_FAIL ──
  //
  // The script may emit other stdout (debug prints inside curl, etc.) — we
  // scan for the FIRST line starting with RESULT_. Looking from the END is
  // also reasonable; FIRST is safer because the script prints exactly one
  // RESULT_ line before exiting and that's typically the last meaningful
  // output.
  const lines = stdout.split("\n");
  let resultLine = "";
  for (const ln of lines) {
    if (ln.startsWith("RESULT_OK") || ln.startsWith("RESULT_FAIL")) {
      resultLine = ln;
      break;
    }
  }

  // No RESULT_ line at all? Either the script crashed before printing one
  // (Python traceback, missing module, OOM) or `timeout` killed it. Treat
  // as fail-with-NO_RESULT — operator triage path: check stderr for the
  // traceback, or run the verify script manually.
  if (!resultLine) {
    // Distinguish wall-clock timeout (exit 124 from GNU `timeout`) from
    // any other crash. SIGKILL via timeout produces 137; SIGTERM via
    // outer SSH cancel might be 143.
    let synthFail = "NO_RESULT";
    if (code === 124 || code === 137 || code === 143) synthFail = "VERIFY_TIMEOUT";
    return {
      status: "fail",
      failCode: synthFail,
      latencyMs,
      markerTs,
      details: { exit_code: String(code ?? "null") },
      rawOutput: (stdout + "\n--- stderr ---\n" + stderr).slice(0, 500),
    };
  }

  const parsed = parseResultLine(resultLine);
  if (parsed.ok) {
    return {
      status: "ok",
      latencyMs,
      markerTs,
      details: parsed.details,
    };
  }
  return {
    status: "fail",
    failCode: parsed.failCode ?? "PARSE_FAIL",
    latencyMs,
    markerTs,
    details: parsed.details,
    rawOutput: resultLine.slice(0, 500),
  };
}
