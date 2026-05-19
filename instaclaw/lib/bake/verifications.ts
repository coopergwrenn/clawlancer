/**
 * lib/bake/verifications.ts — Reusable verification primitives.
 *
 * Verifications are the pre/post-condition checks that gate every step.
 * They are idempotent, side-effect-free, and composable. Each returns
 * {ok, detail} — never throws.
 *
 * Per design doc §2.5.
 *
 * Categories:
 *   - env: process.env presence + value-match
 *   - pin: source-of-truth pin alignment
 *   - file: local filesystem checks
 *   - ssh: remote-VM checks via SSH
 *   - linode: Linode API state checks
 *   - supabase: DB row checks
 *   - drift: cross-bake comparisons
 */

import { existsSync, readFileSync } from "fs";
import type { Verification, BakeContext, Severity } from "./step-spec";
import { getInstance, type LinodeInstance } from "./linode-api";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Client } from "ssh2";

// ─── ENV: process.env helpers ────────────────────────────────────────────────

/** Verify that a process.env variable is set (any non-empty value). */
export function envVarSet(name: string, severity: Severity = "P0"): Verification {
  return {
    id: `env-set-${name}`,
    severity,
    description: `process.env.${name} is set`,
    check: async () => {
      const val = process.env[name];
      const ok = !!val && val.length > 0;
      return {
        ok,
        detail: ok ? `(present; ${val!.length} chars)` : `missing`,
      };
    },
    remediation: `TRY: add ${name}=... to .env.local`,
  };
}

/** Verify that a process.env variable matches an expected string exactly. */
export function envVarEquals(name: string, expected: string, severity: Severity = "P0"): Verification {
  return {
    id: `env-equals-${name}`,
    severity,
    description: `process.env.${name} === ${JSON.stringify(expected)}`,
    check: async () => {
      const val = process.env[name];
      const ok = val === expected;
      return { ok, detail: ok ? `match` : `got ${JSON.stringify(val ?? "")}` };
    },
    remediation: `TRY: set ${name}="${expected}" in .env.local`,
  };
}

/** Verify that a process.env variable is NOT set (or is empty). */
export function envVarAbsent(name: string, severity: Severity = "P1"): Verification {
  return {
    id: `env-absent-${name}`,
    severity,
    description: `process.env.${name} is NOT set (avoiding canary contamination)`,
    check: async () => {
      const val = process.env[name];
      const ok = !val || val.length === 0;
      return { ok, detail: ok ? `(absent)` : `set to ${JSON.stringify(val!.slice(0, 50))}` };
    },
    remediation:
      `TRY: unset ${name} for this shell, OR confirm its value includes the bake VM id`,
  };
}

// ─── PIN: source-of-truth alignment ──────────────────────────────────────────

/**
 * Verify that a captured source-pin value matches an expected literal.
 * Used when an external script (like install-gbrain.sh) hardcodes a pin
 * and we want to assert it matches the source-of-truth in lib/vm-reconcile.ts.
 *
 * (Inverse: the BAKE itself reads pins live, never asserting equality.)
 */
export function pinMatches(name: string, captured: string, expected: string): Verification {
  return {
    id: `pin-${name}`,
    severity: "P0",
    description: `pin ${name} == ${expected}`,
    check: async () => {
      const ok = captured === expected;
      return { ok, detail: ok ? `match` : `got ${captured}, expected ${expected}` };
    },
  };
}

// ─── FILE: local filesystem checks ───────────────────────────────────────────

/** Verify that a local file exists. */
export function fileExists(path: string, severity: Severity = "P0"): Verification {
  return {
    id: `file-exists-${path.replace(/\//g, "-")}`,
    severity,
    description: `file exists: ${path}`,
    check: async () => {
      const ok = existsSync(path);
      return { ok, detail: ok ? "" : "not found" };
    },
  };
}

/** Verify that a local file contains a string. */
export function fileContains(
  path: string,
  needle: string | RegExp,
  severity: Severity = "P0",
): Verification {
  return {
    id: `file-contains-${path.replace(/\//g, "-")}`,
    severity,
    description: `${path} contains ${needle}`,
    check: async () => {
      if (!existsSync(path)) return { ok: false, detail: "file not found" };
      const src = readFileSync(path, "utf-8");
      const ok = typeof needle === "string" ? src.includes(needle) : needle.test(src);
      return { ok, detail: ok ? "" : "no match" };
    },
  };
}

// ─── SSH: remote-VM checks ───────────────────────────────────────────────────

/**
 * Open an SSH connection to a host. Used by ssh-check helpers.
 * Returns a connected ssh2 Client. Caller is responsible for `.end()`.
 */
export async function openSsh(
  host: string,
  user = "openclaw",
  privateKey?: string,
): Promise<Client> {
  const pk =
    privateKey ??
    Buffer.from(process.env.SSH_PRIVATE_KEY_B64 ?? "", "base64").toString("utf-8");
  if (!pk) throw new Error("SSH_PRIVATE_KEY_B64 not set");

  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c)).on("error", reject).connect({
      host,
      port: 22,
      username: user,
      privateKey: pk,
      readyTimeout: 15_000,
    });
  });
}

/** Run an SSH command and return stdout + stderr + exit code. */
export async function sshExec(
  c: Client,
  cmd: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`SSH exec timeout (${timeoutMs}ms): ${cmd.slice(0, 80)}`));
    }, timeoutMs);
    c.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      stream
        .on("data", (d: Buffer) => (stdout += d.toString()))
        .on("close", (code: number) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        });
      stream.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    });
  });
}

/**
 * Verify that an SSH command on the bake VM exits with the expected code.
 * Pulls bake VM IP from ctx.state.bake_vm.ip_address.
 */
export function sshCommandExit(
  id: string,
  description: string,
  cmd: string,
  expectedExit: number,
  severity: Severity = "P0",
  remediation?: string,
): Verification {
  return {
    id,
    severity,
    description,
    remediation,
    check: async (ctx: BakeContext) => {
      const ip = ctx.state.bake_vm.ip_address;
      if (!ip) return { ok: false, detail: "bake VM IP not set" };
      let c: Client | null = null;
      try {
        c = await openSsh(ip);
        const r = await sshExec(c, cmd);
        const ok = r.code === expectedExit;
        return {
          ok,
          detail: ok
            ? ""
            : `exit=${r.code} expected=${expectedExit} stderr=${r.stderr.slice(0, 100)}`,
        };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 150) };
      } finally {
        if (c) c.end();
      }
    },
  };
}

/** Verify that an SSH command's stdout contains a pattern. */
export function sshCommandStdoutContains(
  id: string,
  description: string,
  cmd: string,
  needle: string | RegExp,
  severity: Severity = "P0",
  remediation?: string,
): Verification {
  return {
    id,
    severity,
    description,
    remediation,
    check: async (ctx: BakeContext) => {
      const ip = ctx.state.bake_vm.ip_address;
      if (!ip) return { ok: false, detail: "bake VM IP not set" };
      let c: Client | null = null;
      try {
        c = await openSsh(ip);
        const r = await sshExec(c, cmd);
        const ok = typeof needle === "string" ? r.stdout.includes(needle) : needle.test(r.stdout);
        return {
          ok,
          detail: ok ? "" : `stdout=${r.stdout.slice(0, 120)} stderr=${r.stderr.slice(0, 60)}`,
        };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 150) };
      } finally {
        if (c) c.end();
      }
    },
  };
}

// ─── LINODE: API state checks ────────────────────────────────────────────────

/** Verify that an instance has the expected status. */
export function linodeInstanceStatus(
  linodeId: number,
  expected: LinodeInstance["status"],
  severity: Severity = "P0",
): Verification {
  return {
    id: `linode-status-${linodeId}`,
    severity,
    description: `linode ${linodeId} status === ${expected}`,
    check: async () => {
      try {
        const inst = await getInstance(linodeId);
        const ok = inst.status === expected;
        return { ok, detail: ok ? "" : `got ${inst.status}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 100) };
      }
    },
  };
}

// ─── SUPABASE: DB row checks ─────────────────────────────────────────────────

export function dbRowExists(
  sb: SupabaseClient,
  table: string,
  where: Record<string, string | number | boolean>,
  severity: Severity = "P0",
): Verification {
  return {
    id: `db-${table}-${Object.entries(where).map(([k, v]) => `${k}=${v}`).join(",")}`,
    severity,
    description: `row exists in ${table} where ${JSON.stringify(where)}`,
    check: async () => {
      let q = sb.from(table).select("*", { count: "exact", head: true });
      for (const [k, v] of Object.entries(where)) {
        q = q.eq(k, v as any);
      }
      const { count, error } = await q;
      if (error) return { ok: false, detail: error.message };
      return { ok: (count ?? 0) > 0, detail: `count=${count ?? 0}` };
    },
  };
}

// ─── Composite runner ────────────────────────────────────────────────────────

/**
 * Run a list of verifications. Returns the results array.
 * Never throws — verifications encapsulate their own error handling.
 */
export async function runVerifications(
  verifications: Verification[],
  ctx: BakeContext,
): Promise<
  Array<{
    id: string;
    severity: Severity;
    ok: boolean;
    detail: string;
    remediation?: string;
    elapsed_ms: number;
  }>
> {
  const results: Array<{
    id: string;
    severity: Severity;
    ok: boolean;
    detail: string;
    remediation?: string;
    elapsed_ms: number;
  }> = [];
  for (const v of verifications) {
    const t0 = Date.now();
    try {
      const r = await v.check(ctx);
      results.push({
        id: v.id,
        severity: v.severity,
        ok: r.ok,
        detail: r.detail,
        remediation: v.remediation,
        elapsed_ms: Date.now() - t0,
      });
    } catch (e) {
      // A verification should never throw. If one does, treat as failure.
      results.push({
        id: v.id,
        severity: v.severity,
        ok: false,
        detail: `verification threw: ${(e as Error).message.slice(0, 150)}`,
        remediation: v.remediation,
        elapsed_ms: Date.now() - t0,
      });
    }
  }
  return results;
}

/**
 * Return true if all P0 verifications passed. P1/P2 failures are OK.
 */
export function passedAllP0(results: ReturnType<typeof runVerifications> extends Promise<infer R> ? R : never): boolean {
  return !results.some((r) => r.severity === "P0" && !r.ok);
}
