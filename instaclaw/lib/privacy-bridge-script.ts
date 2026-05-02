/**
 * Maximum Privacy Mode SSH command bridge.
 *
 * The actual bash lives in lib/privacy-bridge.sh — this module just reads it.
 * Keeping bash in a real .sh file (not a TS template literal) avoids the
 * `${VAR}` / template-literal escape conflicts and makes the script editable
 * with normal shell tooling.
 *
 * Deployed via stepDeployPrivacyBridge (lib/vm-reconcile.ts) to edge_city VMs
 * at ~/.openclaw/scripts/privacy-bridge.sh. The cutover script
 * (instaclaw/scripts/_deploy-privacy-bridge-cutover.ts) is what wires it into
 * ~/.ssh/authorized_keys via the OpenSSH `command="..."` directive.
 *
 * v0 KNOWN GAPS (intentional, document in PRD):
 *   - No pipes / chains / redirects allowed when privacy ON. Single command only.
 *   - journalctl --user CAN reveal LLM prompts/responses if the gateway logs
 *     them at debug level. Privacy mode does not redact gateway journals.
 *   - 30s cache TTL means toggle-OFF takes up to 30s to grant access back, and
 *     toggle-ON takes up to 30s to start enforcing.
 */
import * as fs from "fs";
import * as path from "path";

export const PRIVACY_BRIDGE_SCRIPT = fs.readFileSync(
  path.resolve(__dirname, "privacy-bridge.sh"),
  "utf-8",
);
