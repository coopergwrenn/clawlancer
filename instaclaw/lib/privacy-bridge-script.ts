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
 * Deployed via stepDeployPrivacyBridge (lib/vm-reconcile.ts) to edge_city VMs
 * at ~/.openclaw/scripts/privacy-bridge.sh. The cutover script
 * (instaclaw/scripts/_deploy-privacy-bridge-cutover.ts) is what wires it into
 * ~/.ssh/authorized_keys via the OpenSSH `command="..."` directive.
 */
import * as fs from "fs";
import * as path from "path";

let cached: string | null = null;

export function getPrivacyBridgeScript(): string {
  if (cached === null) {
    cached = fs.readFileSync(
      path.resolve(__dirname, "privacy-bridge.sh"),
      "utf-8",
    );
  }
  return cached;
}
