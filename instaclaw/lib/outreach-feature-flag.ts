/**
 * Global kill-switch for the agent-to-agent intro flow.
 *
 * Default: ENABLED. We deliberately invert the env-var convention
 * here — a forgotten env var must NOT disable a working feature, so
 * absence/empty/unset all read as enabled. Only an explicit falsy
 * value ("false", "0", "off", "no") flips the kill.
 *
 * What the flag gates:
 *   - reserve phase of /api/match/v1/outreach (no new intros begin)
 *   - retry phase of /api/match/v1/outreach (no XMTP redelivery work)
 *
 * What the flag does NOT gate (intentionally):
 *   - finalize phase (sender consistency: rows that already started
 *     a send must reach a terminal state)
 *   - ack phase (receivers must always be able to ack to stop their
 *     side from re-rendering)
 *   - /api/match/v1/my-intros (receivers must continue to poll for
 *     intros that landed in the ledger BEFORE the kill flipped — we
 *     don't strand inbound traffic)
 *   - matching pipeline itself (only the cross-agent outreach is killed)
 *
 * Operationally: flip CONSENSUS_INTRO_FLOW_ENABLED=false in Vercel's
 * env vars and redeploy (or use the runtime env update if available).
 * New senders refuse to start outreach; existing pending state drains
 * cleanly via the receiver path.
 */
const FLAG_NAME = "CONSENSUS_INTRO_FLOW_ENABLED";

export function isOutreachEnabled(): boolean {
  const raw = process.env[FLAG_NAME];
  if (raw === undefined || raw === null || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "false" || v === "0" || v === "off" || v === "no" || v === "disabled") {
    return false;
  }
  return true;
}

export function flagName(): string {
  return FLAG_NAME;
}
