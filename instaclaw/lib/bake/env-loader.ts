/**
 * lib/bake/env-loader.ts — Standardized env loading for bake scripts.
 *
 * Per CLAUDE.md Rule 18, SSH-using scripts must load BOTH .env.local AND
 * .env.ssh-key. This helper does that idempotently — if a var is already
 * set in the environment (e.g., from an earlier import), it's preserved.
 *
 * Returns the list of env files that were loaded for log-trace purposes.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const CANONICAL_FILES = [".env.local", ".env.ssh-key"];

/**
 * Load env files at the given repo root. Returns the paths that were
 * successfully loaded.
 *
 * Existing process.env values take precedence — we don't overwrite.
 * This mirrors the pattern in scripts/_pre-bake-check.ts and
 * scripts/_audit-freeze-zombies.ts.
 */
export function loadBakeEnv(repoRoot: string): string[] {
  const loaded: string[] = [];
  for (const rel of CANONICAL_FILES) {
    const full = resolve(repoRoot, rel);
    if (!existsSync(full)) continue;
    const content = readFileSync(full, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      // Strip surrounding quotes — matches the pattern in _pre-bake-check.ts.
      const raw = m[2].trim();
      const value = raw.replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
    loaded.push(full);
  }
  return loaded;
}

/**
 * Return env vars required for the orchestrator to function.
 * Used at preflight to surface missing values BEFORE provisioning.
 */
export const REQUIRED_BAKE_TOOLING_ENV = [
  "LINODE_API_TOKEN",
  "LINODE_SNAPSHOT_ID",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SSH_PRIVATE_KEY_B64",
  // CDP backup-wallet keys (2026-05-24 Cooper P0 restoration). The
  // _pre-bake-check.ts also validates these, but the autonomous-bake
  // pipeline has its own preflight env check via this list — duplicating
  // the gate here ensures `--action=preflight` rejects a stale local
  // env before any provisioning starts.
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
] as const;

/**
 * Env vars whose presence is RECOMMENDED but not blocking.
 * RECONCILE_SOUL_MIGRATION_ENABLED gates V2 template deployment in §3.3.
 * Without it, the bake VM stays on V1.
 */
export const RECOMMENDED_BAKE_TOOLING_ENV = [
  "RECONCILE_SOUL_MIGRATION_ENABLED",
] as const;

/**
 * Env vars that, if set, indicate a canary-scope leftover that would
 * silently skip the bake VM during V2 migration. Preflight warns + offers
 * to unset for the bake shell.
 */
export const DANGER_BAKE_TOOLING_ENV = [
  "RECONCILE_SOUL_MIGRATION_VM_IDS",
] as const;
