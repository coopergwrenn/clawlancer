/**
 * Maximum Privacy Mode SSH command bridge.
 *
 * The actual bash lives in lib/privacy-bridge.sh — this module reads it lazily.
 *
 * Why lazy: Turbopack's "Collecting page data" pass evaluates server modules
 * with __dirname resolving to a phantom /ROOT path where the .sh file does
 * not exist. Top-level fs.readFileSync would crash the build. Lazy loading
 * defers the read to first call, by which point we're in real serverless
 * runtime with outputFileTracingIncludes resolving the file correctly.
 *
 * Why the path fallback chain: even with lazy loading, the bundler can
 * inline `__dirname` as the build-time value `/ROOT/instaclaw/lib/`, which
 * doesn't exist at Vercel runtime. vm-354 hit this on a reconcile tick
 * 2026-05-16 — fails=1, error `ENOENT: open '/ROOT/instaclaw/lib/privacy-bridge.sh'`.
 * The defensive fallback tries the build-inlined __dirname path FIRST
 * (works for most invocations), then falls back to process.cwd()-relative
 * paths (works under Vercel where cwd=/var/task and lib/ is bundled there).
 *
 * Deployed via stepDeployPrivacyBridge (lib/vm-reconcile.ts) to edge_city VMs
 * at ~/.openclaw/scripts/privacy-bridge.sh. The cutover script
 * (instaclaw/scripts/_deploy-privacy-bridge-cutover.ts) is what wires it into
 * ~/.ssh/authorized_keys via the OpenSSH `command="..."` directive.
 */
import * as fs from "fs";
import * as path from "path";

let cached: string | null = null;

export function getPrivacyBridgeScript(): string {
  if (cached !== null) return cached;

  // Path candidates, in priority order. The first existing file wins.
  // Each candidate is paired with its provenance comment so log diagnostics
  // surface the exact source.
  const candidates: Array<{ path: string; source: string }> = [
    { path: path.resolve(__dirname, "privacy-bridge.sh"), source: "__dirname-relative" },
    { path: path.join(process.cwd(), "lib", "privacy-bridge.sh"), source: "cwd+lib (Vercel default)" },
    { path: path.join(process.cwd(), "instaclaw", "lib", "privacy-bridge.sh"), source: "cwd+instaclaw+lib (monorepo)" },
  ];

  const tried: string[] = [];
  for (const { path: p, source } of candidates) {
    try {
      if (fs.existsSync(p)) {
        cached = fs.readFileSync(p, "utf-8");
        return cached;
      }
      tried.push(`${source}=${p}`);
    } catch (e) {
      // existsSync shouldn't throw, but defense in depth — record and continue
      tried.push(`${source}=${p} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  throw new Error(
    `getPrivacyBridgeScript: privacy-bridge.sh not found at any candidate path. ` +
    `Tried: ${tried.join("; ")}. Check next.config.ts outputFileTracingIncludes ` +
    `and that lib/privacy-bridge.sh exists at repo root.`,
  );
}
