/**
 * VM Manifest — Single source of truth for expected VM state.
 *
 * Every config setting, workspace file, skill, cron job, and system package
 * that should exist on a production VM is declared here. The reconcileVM()
 * function in vm-reconcile.ts diffs current VM state against this manifest
 * and fixes any drift.
 *
 * To add something to all VMs:
 *   1. Add the entry to VM_MANIFEST below
 *   2. Bump VM_MANIFEST.version
 *   3. Push to main — the health cron auto-deploys over the next few cycles
 */

import {
  WORKSPACE_CAPABILITIES_MD,
  WORKSPACE_QUICK_REFERENCE_MD,
  WORKSPACE_TOOLS_MD_TEMPLATE,
  AGENTS_MD_PHILOSOPHY_SECTION,
  SOUL_MD_LEARNED_PREFERENCES,
  SOUL_MD_INTELLIGENCE_SUPPLEMENT,
  SOUL_MD_MEMORY_FILING_SYSTEM,
  WORKSPACE_INDEX_SCRIPT,
  MEMORY_SNAPSHOT_SCRIPT,
} from "./agent-intelligence";
import { WORKSPACE_EARN_MD } from "./earn-md-template";

// ── File entry types ──

export type ManifestFileMode =
  | "overwrite"              // Always write (platform-controlled, read-only reference)
  | "create_if_missing"      // Create if absent (agent-editable, never overwrite)
  | "append_if_marker_absent" // Append content if marker string not found in file
  | "insert_before_marker";   // Insert content before a marker line via sed

interface ManifestFileBase {
  remotePath: string;
  mode: ManifestFileMode;
  executable?: boolean;
  /** Use SFTP (putFile) instead of echo|base64 pipe — needed for large files (>40KB) */
  useSFTP?: boolean;
  /**
   * Refuse to write if any of these strings is missing from the resolved
   * content.  Defends against stale module caches in long-running reconciler
   * processes (CLAUDE.md Rule 23).  Use canonical post-fix markers; when
   * this list is non-empty, a regression check runs before any disk write,
   * and a missing sentinel pushes an error to result.errors instead of
   * overwriting good on-disk content with stale in-memory content.
   *
   * The classic motivating bug: 2026-05-02 mass-reconcile-v79 was started
   * before the strip-thinking trim_failed_turns commit landed.  Its Node
   * process held the OLD STRIP_THINKING_SCRIPT in memory and silently
   * overwrote every VM's hotfix as it crawled the queue.  A sentinel
   * ["def trim_failed_turns", "SESSION TRIMMED:"] would have caught this
   * on the FIRST VM and surfaced a loud error instead of regressing 141.
   */
  requiredSentinels?: string[];
}

interface ManifestFileTemplate extends ManifestFileBase {
  source: "template";
  templateKey: string;
}

interface ManifestFileInline extends ManifestFileBase {
  source: "inline";
  content: string;
}

interface ManifestFileMarker extends ManifestFileBase {
  source: "template" | "inline";
  templateKey?: string;
  content?: string;
  marker: string;
  mode: "append_if_marker_absent" | "insert_before_marker";
}

export type ManifestFileEntry = ManifestFileTemplate | ManifestFileInline | ManifestFileMarker;

export interface ManifestExtraSkillFile {
  skillName: string;
  localPath: string;   // Relative to instaclaw/skills/<skillName>/
  remotePath: string;   // Relative to ~/.openclaw/skills/<skillName>/
}

export interface ManifestCronJob {
  schedule: string;
  command: string;
  /** Unique string to grep for in crontab — determines if job is installed */
  marker: string;
}

// ── Template registry ──
// Maps templateKey strings to their content. This lets us reference templates
// by name in the manifest without importing the large strings directly.

export const TEMPLATE_REGISTRY: Record<string, string> = {
  WORKSPACE_CAPABILITIES_MD,
  WORKSPACE_QUICK_REFERENCE_MD,
  WORKSPACE_TOOLS_MD_TEMPLATE,
  WORKSPACE_EARN_MD,
  AGENTS_MD_PHILOSOPHY_SECTION,
  SOUL_MD_LEARNED_PREFERENCES,
  SOUL_MD_INTELLIGENCE_SUPPLEMENT,
  SOUL_MD_MEMORY_FILING_SYSTEM,
  WORKSPACE_INDEX_SCRIPT,
  MEMORY_SNAPSHOT_SCRIPT,
  // STRIP_THINKING_SCRIPT and AUTO_APPROVE_PAIRING_SCRIPT are registered
  // at runtime by ssh.ts to avoid circular imports (they're defined there
  // as template literals with interpolated values like ${512 * 1024}).
};

/**
 * Register a template at runtime. Called by ssh.ts for scripts that use
 * interpolated values (STRIP_THINKING_SCRIPT, AUTO_APPROVE_PAIRING_SCRIPT).
 */
export function registerTemplate(key: string, content: string): void {
  TEMPLATE_REGISTRY[key] = content;
}

export function getTemplateContent(key: string): string {
  const content = TEMPLATE_REGISTRY[key];
  if (!content) {
    throw new Error(`VM Manifest: unknown template key "${key}". Did you call registerTemplate()?`);
  }
  return content;
}

// ── Silence watchdog — universal safety net against agent going silent ──
// Runs every 30 seconds (via cron + sleep 30). Detects when a user message
// has gone unanswered for >60 seconds and sends a fallback directly via
// Telegram API, bypassing OpenClaw entirely. Catches ALL silence causes:
// rate limits, tool failures, context overflow, frozen API, dead gateway.
export const SILENCE_WATCHDOG_SCRIPT = `#!/usr/bin/env python3
"""Silence Watchdog — universal fallback for unresponsive agents.

If a user sent a message >60 seconds ago and the agent hasn't replied,
send a fallback message directly via Telegram API and restart the gateway.
This is the LAST LINE OF DEFENSE — independent of OpenClaw.
"""
import json, os, glob, time, subprocess, re, sys

SILENCE_THRESHOLD_SEC = 60
STATE_FILE = os.path.expanduser("~/.openclaw/.silence-watchdog-state.json")
CONFIG_FILE = os.path.expanduser("~/.openclaw/openclaw.json")
SESSIONS_DIR = os.path.expanduser("~/.openclaw/agents/main/sessions")
COOLDOWN_SEC = 300  # Don't send more than 1 fallback per 5 minutes

FALLBACK_MSG = "Sorry about that — I hit a processing issue. Could you send that again?"

def get_bot_token():
    try:
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
        channels = cfg.get("channels", {})
        tg = channels.get("telegram", {})
        return tg.get("botToken", "")
    except Exception:
        return ""

def get_telegram_session_info():
    """Find the most-recently-updated telegram-origin session.

    Returns (chat_id, session_file_path) or (None, None). Filters strictly to
    sessions where origin.provider == "telegram" so heartbeat / openai / other
    provider sessions can never be inspected by the silence watchdog.
    """
    sessions_json = os.path.expanduser("~/.openclaw/agents/main/sessions/sessions.json")
    try:
        with open(sessions_json) as f:
            data = json.load(f)
        candidates = []
        for k, v in data.items():
            origin = v.get("origin", {})
            if origin.get("provider") != "telegram":
                continue
            fr = origin.get("from", "") or v.get("lastTo", "")
            m = re.search(r"telegram:(\\d+)", fr)
            if not m:
                continue
            chat_id = m.group(1)
            session_file = v.get("sessionFile")
            session_id = v.get("sessionId")
            if not session_file and session_id:
                session_file = os.path.join(SESSIONS_DIR, f"{session_id}.jsonl")
            if session_file and os.path.exists(session_file):
                updated_at = v.get("updatedAt", 0)
                candidates.append((updated_at, chat_id, session_file))
        if candidates:
            candidates.sort(reverse=True)
            _, chat_id, session_file = candidates[0]
            return chat_id, session_file
    except Exception:
        pass
    return None, None

def get_chat_id():
    """Return chat_id for the active telegram session, if any."""
    chat_id, _ = get_telegram_session_info()
    return chat_id or ""

def get_latest_session_timing(session_file=None):
    """Read the given session file and find the last user message and last assistant message timestamps.

    The caller MUST pass a session_file (resolved from get_telegram_session_info()).
    Passing None returns (None, None) — we no longer fall back to the latest-by-mtime
    file because that picks up heartbeat/openai sessions and falsely fires the watchdog.
    """
    if not session_file:
        return None, None

    last_user_ts = None
    last_assistant_ts = None

    try:
        # Read last 30 lines (enough to find recent messages)
        lines = subprocess.run(
            ["tail", "-30", session_file],
            capture_output=True, text=True, timeout=5
        ).stdout.strip().split("\\n")

        for line in lines:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                msg = entry.get("message", {})
                role = msg.get("role", "")
                ts_str = entry.get("timestamp", "")

                if not ts_str:
                    continue

                # Parse ISO timestamp to epoch
                # Handle both "2026-03-30T15:36:00.812Z" and epoch ms
                if isinstance(ts_str, str) and "T" in ts_str:
                    from datetime import datetime, timezone
                    dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    ts = dt.timestamp()
                elif isinstance(ts_str, (int, float)):
                    ts = ts_str / 1000 if ts_str > 1e12 else ts_str
                else:
                    continue

                if role == "user":
                    last_user_ts = ts
                elif role == "assistant":
                    content = msg.get("content", [])
                    # Only count assistant messages with actual visible text (not empty, not just tool calls)
                    has_text = False
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text" and block.get("text", "").strip():
                            has_text = True
                            break
                    if has_text:
                        last_assistant_ts = ts
            except (json.JSONDecodeError, ValueError):
                continue
    except Exception:
        pass

    return last_user_ts, last_assistant_ts

def read_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def write_state(data):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(data, f)
    except Exception:
        pass

def send_telegram_fallback(bot_token, chat_id):
    """Send fallback message directly via Telegram API — bypasses OpenClaw entirely."""
    try:
        import urllib.request, urllib.parse
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        data = urllib.parse.urlencode({
            "chat_id": chat_id,
            "text": FALLBACK_MSG,
        }).encode()
        req = urllib.request.Request(url, data=data, method="POST")
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception:
        return False

def should_restart():
    """Check if a gateway restart is warranted. Returns False if restarting
    would be pointless (recent restart by any source within 5 min)."""
    lock_path = "/tmp/ic-restart.lock"
    try:
        if os.path.exists(lock_path):
            age = time.time() - os.path.getmtime(lock_path)
            if age < 300:
                return False  # Any source restarted within 5 min — skip
    except Exception:
        pass
    return True

def restart_gateway():
    """Restart the OpenClaw gateway (with lock file coordination)."""
    lock_path = "/tmp/ic-restart.lock"
    try:
        with open(lock_path, "w") as f:
            f.write(str(time.time()))
    except Exception:
        pass
    try:
        env = os.environ.copy()
        env["XDG_RUNTIME_DIR"] = f"/run/user/{os.getuid()}"
        subprocess.run(
            ["systemctl", "--user", "restart", "openclaw-gateway"],
            env=env, timeout=15, capture_output=True
        )
    except Exception:
        pass

def main():
    now = time.time()
    state = read_state()

    # Cooldown: don't spam fallbacks
    last_fallback = state.get("last_fallback_ts", 0)
    if now - last_fallback < COOLDOWN_SEC:
        return

    bot_token = get_bot_token()
    if not bot_token:
        return  # No Telegram configured — nothing to watch

    # Resolve the SAME telegram session for both chat_id and session timing.
    # Critical: never read a non-telegram session (heartbeat/openai/etc.) — those
    # contain role:"user" entries (heartbeat pings) that have no visible text reply
    # and would falsely trigger a fallback message into the user's chat.
    chat_id, session_file = get_telegram_session_info()
    if not chat_id or not session_file:
        return  # No active telegram session — nothing to watch

    # Check session timing on the telegram session specifically
    last_user_ts, last_assistant_ts = get_latest_session_timing(session_file)

    if last_user_ts is None:
        return  # No user messages — nothing to check

    user_age = now - last_user_ts

    # User message must be recent (last 90 seconds) to be actionable
    if user_age > 90:
        return  # Old message — not a current silence issue

    # Check if user message is unanswered for >SILENCE_THRESHOLD_SEC
    if user_age < SILENCE_THRESHOLD_SEC:
        return  # Still within threshold — give the agent time

    # Is there an assistant response AFTER the user message?
    if last_assistant_ts and last_assistant_ts > last_user_ts:
        return  # Agent responded — no silence

    # SILENCE DETECTED: user message is >60s old with no visible assistant response
    # Always send fallback (within cooldown) but only restart if it would help
    sent = send_telegram_fallback(bot_token, chat_id)
    if sent:
        if should_restart():
            restart_gateway()
            write_state({"last_fallback_ts": now, "trigger": "silence_detected", "restarted": True})
        else:
            write_state({"last_fallback_ts": now, "trigger": "silence_detected", "restarted": False})

if __name__ == "__main__":
    main()
`;

// ── Push-based heartbeat script (deployed to every VM, runs hourly via cron) ──
export const PUSH_HEARTBEAT_SH = `#!/bin/bash
# Push-based heartbeat — POSTs to instaclaw.io every hour via crontab
TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2)
LOGFILE=~/.openclaw/logs/heartbeat.log
mkdir -p ~/.openclaw/logs
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \\
  -H "Authorization: Bearer $TOKEN" \\
  https://instaclaw.io/api/vm/heartbeat 2>/dev/null)
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') status=$STATUS" >> "$LOGFILE"
# Keep log from growing forever — last 500 lines
tail -500 "$LOGFILE" > "$LOGFILE.tmp" && mv "$LOGFILE.tmp" "$LOGFILE"
`;

// ── The Manifest ──

export const VM_MANIFEST = {
  /** Bump on any manifest change. Continues from CONFIG_SPEC v14.
   *  v64 (2026-04-28): NODE_PINNED_VERSION=22.22.2 + OPENCLAW_PINNED_VERSION
   *  =2026.4.26. Triggers stepNodeUpgrade on every assigned VM (Node 22.22.0
   *  → 22.22.2) followed by openclaw clean-reinstall. See lib/ssh.ts for
   *  HISTORY notes on why both pins moved together.
   * v65 (2026-04-29): Add browser-relay-server.js + systemd user unit.
   *  Bridges the InstaClaw Browser Relay Chrome extension (which still
   *  speaks the OpenClaw 2026.2.24 protocol) to the agent's browser plugin
   *  via emulated CDP on 127.0.0.1:18792. Caddy already proxies /relay/*
   *  here; before this version, port 18792 was unbound and every install
   *  of the published extension hit "Cannot reach relay". v64-then-v65 will
   *  reconcile in one pass for VMs still on v63.
   * v66 (2026-04-29): Bankr skill prelaunch overlay. After cloning the
   *  upstream BankrBot/skills repo, configureOpenClaw now (a) deletes
   *  bankr/clanker (full TS deploy path that requires PRIVATE_KEY env var
   *  the VM doesn't have — agents picking it hung or surfaced confusing
   *  errors) and bankr/base (empty placeholder), and (b) prepends a strong
   *  InstaClaw directive to bankr/bankr/SKILL.md scoping launches to Base
   *  via `bankr launch` only, requiring --fee-type with --fee, and pointing
   *  the agent at our dashboard celebration flow instead of self-promoting.
   *  Idempotent via INSTACLAW_BANKR_PATCH_V1 marker. Triggers reconciler
   *  across the fleet so existing VMs get the overlay.
   * v67 (2026-04-29): Token-launch framing in upfront context. Audit on
   *  vm-780 showed v66's skill directive was on disk but NOT being read
   *  at turn 1 — the agent lazy-loads SKILL.md only when it explicitly
   *  opens the skill, by which point it has already framed the task as
   *  Solana (training-data prior). Fix lives in the always-in-context
   *  surface (SOUL.md routing table + CAPABILITIES.md wallet table):
   *  splits the bankr row to add a dedicated "launch a token" row with
   *  explicit Base-only framing, while preserving every Solana wallet /
   *  trading / swap behavior verbatim. Verified on vm-050 with a 3-prompt
   *  probe — turn 1 of "i want to launch a token" returned Base + bankr
   *  launch with zero Solana mention, while "check my SOL balance" and
   *  "swap 0.1 SOL for USDC on Jupiter" both routed to the Solana scripts
   *  normally. Reconciler rewrites SOUL.md and CAPABILITIES.md (both
   *  `>` overwrite) on next pass — no fleet patch needed.
   *
   * v68 (2026-04-30): Two fleet-wide reliability fixes.
   *  (a) gateway-watchdog.sh: add GW_AGE>600 guard to the FROZEN check.
   *      The check uses LAST_SEND from the daily app log, which survives
   *      across gateway restarts. After a restart, a fresh gateway with no
   *      successful sendMessage today was judged "frozen" within 2 min and
   *      killed — infinite watchdog→cold-start→kill loop affecting any user
   *      resuming after long idle. Confirmed on vm-773 (Lee): 20 SIGTERMs
   *      in 24h. Now mirrors TELEGRAM_DEAD's existing uptime guard.
   *  (b) channels.telegram.streaming.mode = "off". 19/20 sampled VMs had
   *      OpenClaw default "partial" which surfaces tool-call blocks as
   *      separate Telegram messages. Confirmed on vm-729 (Textmaxmax): user
   *      saw "exec run python3 8999", "tool: exec", "http.server" leaking
   *      into chat. "off" sends only final assistant text — drops the
   *      typing-effect partial-stream UX in exchange for never leaking
   *      tool internals. Reversible per-user via openclaw config set.
   *
   * v69 (2026-04-30): Gateway watchdog DISABLED fleet-wide. v68's GW_AGE
   *  guard only delayed the FROZEN kill 10 min instead of fixing it — the
   *  underlying bug is reading LAST_SEND from /tmp/openclaw/openclaw-$DATE.log
   *  which persists across gateway restarts. A restarted gateway with no
   *  successful sendMessage today gets judged "frozen" indefinitely. Same
   *  antipattern in TELEGRAM_DEAD's LAST_TG_SEND. Confirmed kill loops on
   *  vm-773 (Lee) 20 SIGTERMs/24h, vm-780 (edgecitybot) gateway dying 17ms
   *  after [gateway] ready, vm-linode-08 (Telly) 10 restarts/24h. systemd
   *  Restart=on-failure handles real crashes; the watchdog was actively
   *  harmful. Disabled in stepGatewayWatchdogTimer (vm-reconcile.ts) and
   *  configureOpenClaw (ssh.ts). Unit files left in place for easy
   *  re-enable when a properly-rewritten watchdog with "since gateway
   *  start" log filtering ships.
   *
   * v71 (2026-04-30): Two fleet-wide hardening fixes shipped together.
   *  (a) discovery.mdns.mode=off. OpenClaw's default is "minimal" (per
   *      runtime-schema-TpYHXgGk.js: `cfg.discovery?.mdns?.mode ??
   *      "minimal"`). Bonjour mDNS broadcast triggers a CIAO-library
   *      shutdown race when SIGTERM hits an in-flight probe, surfacing as
   *      "Unhandled promise rejection: CIAO PROBING CANCELLED" → exit 1.
   *      Confirmed crashes on vm-435 (YouthWork) + vm-729 (Textmaxmax).
   *      Audit: 29/30 sampled VMs at the default = effectively "minimal"
   *      everywhere. No need for mDNS in our deployment (gateway.bind is
   *      non-loopback; OpenClaw's own audit-lno7WqNt.js recommends "off"
   *      in this scenario). Permanent fix; reconciler enforces with the
   *      verify-after-set hardening from commit bf053e9a.
   *  (b) Weekly cron: prune workspace/backups/ subdirs older than 14 days.
   *      Some power-user agents create custom daily-backup scripts; without
   *      retention they grow linearly. vm-435 hit 1.1 GB. Safety net at
   *      04:30 Sunday: `find ~/.openclaw/workspace/backups -mindepth 1
   *      -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +`. No-op on VMs
   *      without backups/ dir.
   *
   * v72 (2026-04-30): Phase 1 of SOUL.md restructure (PRD-soul-restructure).
   *  Added `<!-- OPENCLAW_CACHE_BOUNDARY -->` marker to WORKSPACE_SOUL_MD,
   *  placed between the persona section (Core Truths/Boundaries/Vibe) and
   *  the agent-editable Learned Preferences. OpenClaw recognizes this marker
   *  (verified in dist/system-prompt-cache-boundary-BWaaicTu.js) and uses it
   *  to split the system prompt into a stable prefix (Anthropic-cached) and
   *  a dynamic suffix. Effect: agent edits to Learned Preferences no longer
   *  invalidate the entire 30K-token system prompt cache — only the suffix
   *  re-prefills. Fleet-wide impact: a Learned Preferences edit costs ~10
   *  cache_write tokens instead of ~14,000 input_tokens. Single highest-
   *  leverage change in the SOUL.md restructure plan. Phase 2 (full file
   *  split) follows in a later manifest bump.
   *
   * v73 (2026-04-30): Memory integrity Phase 1 — MEMORY.md backup + auto-
   *  restore. See PRD instaclaw/docs/prd/memory-integrity-layer.md.
   *  Three pieces:
   *    1. ~/.openclaw/scripts/memory-snapshot.sh script with two modes:
   *       `pre-stop` (copy MEMORY.md → memory/MEMORY.md.bak) and `restore`
   *       (auto-restore from backup if current is template-empty).
   *    2. systemd ExecStopPost wired to `pre-stop` — backup runs after
   *       every gateway shutdown.
   *    3. systemd ExecStartPre extended with `restore` — runs before every
   *       gateway start; restores from backup ONLY if current MEMORY.md is
   *       <50B (template-empty). Never overwrites populated files.
   *  Triggered by 2026-04-30 vm-729 (Textmaxmax) investigation: canary
   *  test proved OpenClaw doesn't wipe MEMORY.md, but a single point of
   *  failure (one file, no backups) is unacceptable. Phase 2 (full
   *  workspace snapshots, retention rotation, restart deferral for
   *  in-flight tasks) follows in a separate PRD pass.
   *
   * v78 (2026-05-02): Maximum Privacy Mode — SSH command bridge deployment
   *  for edge_city VMs only. New reconciler step `stepDeployPrivacyBridge`
   *  writes ~/.openclaw/scripts/privacy-bridge.sh from the canonical
   *  PRIVACY_BRIDGE_SCRIPT constant in lib/privacy-bridge-script.ts. The
   *  bridge is a no-op until the manual cutover script
   *  (instaclaw/scripts/_deploy-privacy-bridge-cutover.ts) wires it into
   *  ~/.ssh/authorized_keys via the OpenSSH `command="..."` directive. Bump
   *  triggers a fleet-wide reconcile so all edge_city VMs get the bridge
   *  staged before cutover; non-edge_city VMs are completely unaffected
   *  (the step early-returns on partner !== "edge_city"). Reminder per
   *  Rule 7: snapshot is now stale — bake a new one before any large
   *  provisioning run.
   *
   * v79 (2026-05-02): Privacy bridge security fixes from QA review. Three
   *  blocker bugs fixed in lib/privacy-bridge.sh — newline injection
   *  bypass, fail-open on missing-env / missing-token / no-state, and
   *  unrestricted openclaw CLI access (memory/session/config could leak
   *  data privacy mode promised to protect). Bridge content SHA changes,
   *  so the bump is required to make the reconciler push the fixed
   *  bridge to the 5 edge_city VMs that already have v78 (their
   *  config_version >= manifest.version filter would otherwise skip
   *  them). Fleet-wide reconcile churns ~200 non-edge VMs through the
   *  bridge step, but it early-returns on partner !== "edge_city" so
   *  net effect there is just a config_version bump. Snapshot stale
   *  reminder per Rule 7 still applies. */
  version: 79,

  // OpenClaw config settings (via `openclaw config set KEY VALUE`)
  // The reconciler pushes these on every health cycle — drift is auto-corrected.
  configSettings: {
    "agents.defaults.heartbeat.every": "3h",
    // v41: Route heartbeats to their own session ("agent:main:heartbeat") instead of
    // polluting the main Telegram conversation. Without this, every 3h heartbeat injects
    // ~24 message exchanges/day into the user's chat context. Schema-verified on vm-379.
    "agents.defaults.heartbeat.session": "heartbeat",
    "agents.defaults.compaction.reserveTokensFloor": "35000",
    // 2026-05-03: bumped from 30000 → 35000.  SOUL.md routinely exceeds 30K
    // on production VMs (median ~32K, max ~39K), causing OpenClaw to silently
    // truncate the tail.  Until 2026-05-03 the truncated tail included the
    // SOUL_MD_MEMORY_FILING_SYSTEM section which names session-log.md and
    // active-tasks.md; the agent literally couldn't see the instructions to
    // write cross-session summaries.  Audit found 84% of fleet had empty
    // session-log.md and 97% empty active-tasks.md as a direct consequence.
    //
    // Trade-off accepted: ~$2.6K/year extra inference cost across the fleet
    // (5K extra chars × every chat completion).  Pales next to the silent
    // churn from "agent forgets you" UX.  Reversible the moment SOUL.md is
    // properly trimmed below 30K (P1 follow-up).
    //
    // CLAUDE.md OpenClaw Upgrade Playbook said "treat any further bump as
    // a hard stop until trimmed" — that calculus assumed silent memory
    // loss wasn't the dominant cost.  It was.  The reorder + bump are the
    // immediate fix; trim is the long-term one.
    "agents.defaults.bootstrapMaxChars": "35000",
    "agents.defaults.compaction.memoryFlush.enabled": "true",
    // v41: Raise softThresholdTokens from default 4000 to 8000 — gives the agent more
    // room to write durable notes before compaction fires. OpenClaw Issue #31435 recommends 8000+.
    "agents.defaults.compaction.memoryFlush.softThresholdTokens": "8000",
    "agents.defaults.memorySearch.enabled": "true",
    "commands.restart": "true",
    // NOTE: gateway.controlUi is version-dependent and handled by
    // upgradeOpenClaw() / restartGateway() — NOT set here statically.
    // v2026.2.24+ REQUIRES dangerouslyAllowHostHeaderOriginFallback=true
    // v2026.2.17–2026.2.23 REJECTS the controlUi key entirely
    "channels.telegram.groupPolicy": "open",
    "channels.telegram.groups.*.requireMention": "false",
    // v68: OpenClaw's default streaming mode "partial" surfaces tool-call
    // blocks as separate Telegram messages — users see internals like
    // "exec run python3 8999", "tool: exec", "http.server" instead of just
    // the agent's final response. Confirmed fleet-wide (19/20 sampled VMs).
    // "off" sends only the final assistant text. Trade-off: no typing-effect
    // partial-stream UX. Reversible per-user.
    "channels.telegram.streaming.mode": "off",
    // v71: OpenClaw's default discovery.mdns.mode is "minimal" (per
    // runtime-schema-TpYHXgGk.js: `cfg.discovery?.mdns?.mode ?? "minimal"`).
    // Bonjour mDNS broadcast triggers a CIAO-library shutdown race when the
    // gateway is SIGTERM'd while a probe is in flight — uncaught promise
    // rejection "CIAO PROBING CANCELLED" → exit 1 → systemd Restart=on-failure
    // → loop. Hits power users with 9+ plugins (acpx/discord/dispatch/etc.)
    // hardest because they have more shutdown-coordination surface.
    // Confirmed crashes on vm-435 (YouthWork) and vm-729 (Textmaxmax).
    // Audit found 96.7% of VMs at the default. We're a server (gateway.bind
    // is non-loopback), so we don't need mDNS local-network discovery anyway —
    // OpenClaw's own audit-lno7WqNt.js even recommends "off" in our scenario.
    "discovery.mdns.mode": "off",
    "commands.useAccessGroups": "false",
    // v41: CRITICAL — Stop the daily 4 AM session wipe. This is the #1 cause of
    // "agent forgetting" complaints. Session now only resets after 7 days (10080 min)
    // of ZERO activity. Active agents never hit this. Schema-verified on vm-379.
    // See: instaclaw/docs/research-session-persistence.md
    "session.reset.mode": "idle",
    "session.reset.idleMinutes": "10080",
    // v41: Actively prune old sessions to prevent disk bloat (vs "warn" which only reports).
    "session.maintenance.mode": "enforce",
    // DO NOT CHANGE — total SKILL.md content is ~405K chars across 17 skills
    // (polymarket removed as duplicate of prediction-markets).
    // Below 500K, skills are silently dropped (alphabetical load order).
    // Caused 3 fleet-wide outages when reverted. See commits 0cad0b7, 9e1e767.
    // Also enforced by reconciler — OpenClaw version updates reset this to default.
    "skills.limits.maxSkillsPromptChars": "500000",
    // v52: Ensure exec tool is available — without this key the gateway may not
    // expose the bash/exec tool to the agent. security=full + ask=off means no
    // approval prompts (agents run autonomously via Telegram, nobody to approve).
    "tools.exec.security": "full",
    "tools.exec.ask": "off",
    // v57: Disable sandbox mode — our VMs don't have Docker installed.
    // OpenClaw's sandbox.mode=all requires Docker for exec; without it, agents
    // get "Sandbox mode requires Docker" on every command. Zilsun's agent was
    // down for a week because of this (reported 2026-04-09).
    "agents.defaults.sandbox.mode": "off",
    // v67: OpenClaw 2026.4.26 has tighter default request timeouts than 2026.4.5.
    // Combined with the v67 SOUL.md (~32KB → ~29K prompt tokens after truncation),
    // chat completions on Haiku 4.5 routinely take 20-45s. The default timeout
    // was firing mid-inference, surfacing "Request timed out before a response
    // was generated" errors and making Telegram bots appear unresponsive.
    // Real incident 2026-04-29: Lee/HotTubLee (vm-773), Samuel/Obare (vm-876),
    // Textmaxmax (vm-729) all reported "agent unresponsive" after the v66→v67
    // upgrade. Samuel was on 2026.4.5 and didn't have the issue; Lee + Textmaxmax
    // got upgraded to 2026.4.26 and started timing out. The gateway's own error
    // message literally suggests "increase agents.defaults.timeoutSeconds".
    // 90s gives Haiku room to finish even on cold-start VMs while still well
    // under any user-perceptible "the bot is dead" threshold (Telegram itself
    // doesn't time out the long-poll; users do).
    "agents.defaults.timeoutSeconds": "90",
    // v61: Enable OpenClaw's OpenAI-compatible POST /v1/chat/completions endpoint.
    // Disabled by default per the runtime schema. Without this, Vercel's three
    // gateway-calling paths all fall back to direct Anthropic (no workspace
    // files, no tools, no agent identity):
    //   - instaclaw.io /api/chat/send (Command Center web chat)
    //   - instaclaw-mini /api/chat/send (World mini-app chat)
    //   - instaclaw-mini /api/tasks/{create,trigger,rerun,refine} (task runner)
    //
    // CORRECTION FROM v59/v60: The earlier config key
    // `gateway.openai.chatCompletionsEnabled` is REJECTED by OpenClaw 2026.4.5's
    // runtime schema with "Unrecognized key: openai". The reconciler's config-set
    // loop had `2>/dev/null || true` which swallowed this error on every VM —
    // DB config_version advanced even though the flag never landed. v61 uses the
    // schema-valid path verified by actual `openclaw config set`:
    //   openclaw config set gateway.http.endpoints.chatCompletions.enabled true
    //   → "Updated gateway.http.endpoints.chatCompletions.enabled. Restart the gateway to apply." (exit 0)
    //   → After restart, POST /v1/chat/completions returns 400 "Invalid `model`"
    //     (endpoint is live; rejects unknown model names — separate fix in the
    //     Vercel chat/send route to pass model="openclaw" + x-openclaw-model header).
    //
    // The silent-failure pattern (config_version advances on failed sets) is
    // being addressed in a separate diff — do NOT trust config_version alone
    // until that lands.
    "gateway.http.endpoints.chatCompletions.enabled": "true",
  } as Record<string, string>,

  // ── Files deployed to VM ──
  files: [
    // --- Exec approvals (always overwrite — platform-controlled) ---
    // v54: Without correct defaults in exec-approvals.json, the gateway's exec
    // approval daemon rejects all commands even when tools.exec.security=full.
    // This caused agents to tell users "exec approvals not enabled" and
    // hallucinate UI instructions for settings that don't exist. Fleet-wide issue
    // affecting 168/170 VMs discovered via Doug Rathell's support ticket.
    {
      remotePath: "~/.openclaw/exec-approvals.json",
      source: "inline",
      content: JSON.stringify({
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "full" },
        agents: {},
      }, null, 2),
      mode: "overwrite",
    },

    // --- Workspace files (always overwrite — platform-controlled) ---
    {
      remotePath: "~/.openclaw/workspace/CAPABILITIES.md",
      source: "template",
      templateKey: "WORKSPACE_CAPABILITIES_MD",
      mode: "overwrite",
    },
    {
      remotePath: "~/.openclaw/workspace/QUICK-REFERENCE.md",
      source: "template",
      templateKey: "WORKSPACE_QUICK_REFERENCE_MD",
      mode: "overwrite",
    },

    // --- Workspace files (create if missing — agent-editable) ---
    {
      remotePath: "~/.openclaw/workspace/TOOLS.md",
      source: "template",
      templateKey: "WORKSPACE_TOOLS_MD_TEMPLATE",
      mode: "create_if_missing",
    },
    {
      remotePath: "~/.openclaw/workspace/MEMORY.md",
      source: "inline",
      content: [
        "# MEMORY.md - Long-Term Memory",
        "",
        "_Start capturing what matters here. Decisions, context, things to remember._",
        "",
        "---",
      ].join("\n"),
      mode: "create_if_missing",
    },
    // --- Cross-session memory files (PRD: cross-session-memory.md) ---
    {
      remotePath: "~/.openclaw/workspace/memory/session-log.md",
      source: "inline",
      content: "# Session Log\n\n_Session summaries are appended here automatically._\n",
      mode: "create_if_missing",
    },
    {
      remotePath: "~/.openclaw/workspace/memory/active-tasks.md",
      source: "inline",
      content: "# Active Tasks\n\n_Tasks are tracked here automatically._\n",
      mode: "create_if_missing",
    },
    {
      remotePath: "~/.openclaw/workspace/EARN.md",
      source: "template",
      templateKey: "WORKSPACE_EARN_MD",
      mode: "create_if_missing",
    },

    // --- Workspace files (append sections if marker absent) ---
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "template",
      templateKey: "SOUL_MD_INTELLIGENCE_SUPPLEMENT",
      mode: "append_if_marker_absent",
      marker: "INTELLIGENCE_INTEGRATED",
    },
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "template",
      templateKey: "SOUL_MD_LEARNED_PREFERENCES",
      mode: "append_if_marker_absent",
      marker: "Learned Preferences",
    },
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "inline",
      content: "## Operating Principles\\n\\n1. **Error handling:** Fix routine errors immediately without bothering the user. For anything involving security, data loss, or money — ask first.\\n\\n2. **Config safety:** Always back up files before modifying them. For unfamiliar systems, read docs first. For routine changes, proceed confidently.\\n\\n3. **Never go silent:** When starting any operation that may take more than 30 seconds (browser navigation, API calls, authentication flows, file generation, trading, etc.), ALWAYS send a quick message to the user FIRST like \"Working on this, give me a minute...\" or \"On it — this might take a sec.\" NEVER go silent for more than 30 seconds without acknowledging what you're doing. The user will think you crashed.\\n\\n4. **NEVER self-restart:** NEVER restart your own gateway (`systemctl restart openclaw-gateway`) to fix browser issues or any other problem. This kills your Telegram connection and creates a crash loop where you go silent, come back, try again, and go silent again. If a website times out in the browser, try a different approach — use curl, API calls, web fetch, or ask the user for help. Do NOT restart yourself.\\n\\n",
      mode: "insert_before_marker",
      marker: "## Boundaries",
    },

    // --- DegenClaw awareness (so agent knows the skill exists and can reference SKILL.md) ---
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "inline",
      content: "\\n<!-- DEGENCLAW_AWARENESS_V1 -->\\n## DegenClaw Trading Competition\\nYou have access to the DegenClaw skill — a $100K weekly perpetuals trading competition on Hyperliquid, run by Virtuals Protocol. If your user mentions trading competitions, Hyperliquid perps, DegenClaw, the $100K challenge, or wanting to compete/trade perps competitively, read and follow the dgclaw SKILL.md for the full setup and trading flow. You can help them join the competition, trade perps, manage their forum, check the leaderboard, and attract subscribers. **Always get explicit user approval before launching tokens or executing trades.**\\n",
      mode: "append_if_marker_absent",
      marker: "DEGENCLAW_AWARENESS",
    },
    {
      remotePath: "~/.openclaw/workspace/SOUL.md",
      source: "template",
      templateKey: "SOUL_MD_MEMORY_FILING_SYSTEM",
      mode: "append_if_marker_absent",
      marker: "MEMORY_FILING_SYSTEM",
    },

    // --- Legacy: AGENTS.md philosophy section (only on VMs that still have AGENTS.md) ---
    {
      remotePath: "~/.openclaw/workspace/AGENTS.md",
      source: "template",
      templateKey: "AGENTS_MD_PHILOSOPHY_SECTION",
      mode: "append_if_marker_absent",
      marker: "Problem-Solving Philosophy",
    },

    // --- Scripts ---
    {
      remotePath: "~/.openclaw/scripts/generate_workspace_index.sh",
      source: "template",
      templateKey: "WORKSPACE_INDEX_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
    {
      // v73 (memory integrity Phase 1): MEMORY.md durability via
      // ExecStopPost backup + ExecStartPre auto-restore. See PRD at
      // instaclaw/docs/prd/memory-integrity-layer.md.
      remotePath: "~/.openclaw/scripts/memory-snapshot.sh",
      source: "template",
      templateKey: "MEMORY_SNAPSHOT_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
    {
      remotePath: "~/.openclaw/scripts/strip-thinking.py",
      source: "template",
      templateKey: "STRIP_THINKING_SCRIPT",
      mode: "overwrite",
      executable: true,
      useSFTP: true,
      // CLAUDE.md Rule 23: refuse to write if any sentinel is missing.
      // Pair each load-bearing fix with both a function-signature sentinel
      // AND a log-line sentinel — robust to refactors that rename one but
      // keep the other.
      //
      //   trim_failed_turns / SESSION TRIMMED:
      //     The 2026-05-02 trim-not-nuke fix.  Replaces force-archive on
      //     empty-response cascades with surgical trim — preserves user
      //     conversation context.  Original incident: vm-780 / Doug.
      //
      //   run_periodic_summary_hook / PERIODIC_SUMMARY_V1
      //     The 2026-05-03 cross-session memory hardening.  Time-driven
      //     summary that fires every 2h regardless of session transition,
      //     writing prose to session-log.md and structured user_facts to
      //     MEMORY.md.  Original incident: 84% of fleet had empty
      //     session-log.md, sessions never transitioned post-v41
      //     persistence fix so the existing event-driven hook never fired.
      //
      //   PRE_ARCHIVE_SUMMARY_V1
      //     The 2026-05-03 pre-archive safety net.  Forces a structured
      //     summary into MEMORY.md before any destructive archival path
      //     (size cap, error_loop) — Rule 22 in spirit: never destroy
      //     state without preserving recovery context.
      requiredSentinels: [
        "def trim_failed_turns",
        "SESSION TRIMMED:",
        "def run_periodic_summary_hook",
        "PERIODIC_SUMMARY_V1",
        "PRE_ARCHIVE_SUMMARY_V1",
      ],
    },
    {
      remotePath: "~/.openclaw/scripts/auto-approve-pairing.py",
      source: "template",
      templateKey: "AUTO_APPROVE_PAIRING_SCRIPT",
      mode: "overwrite",
      executable: true,
      useSFTP: true,
    },
    {
      remotePath: "~/.openclaw/scripts/vm-watchdog.py",
      source: "template",
      templateKey: "VM_WATCHDOG_SCRIPT",
      mode: "overwrite",
      executable: true,
      useSFTP: true,
    },
    {
      remotePath: "~/.openclaw/scripts/push-heartbeat.sh",
      source: "inline",
      content: PUSH_HEARTBEAT_SH,
      mode: "overwrite",
      executable: true,
    },
    {
      remotePath: "~/.openclaw/scripts/silence-watchdog.py",
      source: "inline",
      content: SILENCE_WATCHDOG_SCRIPT,
      mode: "overwrite",
      executable: true,
      useSFTP: true,
    },
    {
      remotePath: "~/scripts/deliver_file.sh",
      source: "template",
      templateKey: "DELIVER_FILE_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
    {
      remotePath: "~/scripts/notify_user.sh",
      source: "template",
      templateKey: "NOTIFY_USER_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
    // #8 — token-price.py — fetch DexScreener price/volume/chart for the
    // agent's Bankr token. Reads BANKR_TOKEN_ADDRESS from ~/.openclaw/.env
    // (populated by configureOpenClaw + tokenize/route.ts after() block).
    // Lays dormant on existing VMs until the next manifest version bump
    // triggers reconciler propagation.
    {
      remotePath: "~/scripts/token-price.py",
      source: "template",
      templateKey: "TOKEN_PRICE_SCRIPT",
      mode: "overwrite",
      executable: true,
    },
  ] as ManifestFileEntry[],

  // ── Skill files ──
  // All SKILL.md files in instaclaw/skills/ are auto-deployed.
  skillsFromRepo: true,

  // Additional non-SKILL.md files in specific skill dirs
  extraSkillFiles: [
    { skillName: "sjinn-video", localPath: "references/sjinn-api.md", remotePath: "references/sjinn-api.md" },
    { skillName: "sjinn-video", localPath: "references/video-prompting.md", remotePath: "references/video-prompting.md" },
    { skillName: "sjinn-video", localPath: "references/video-production-pipeline.md", remotePath: "references/video-production-pipeline.md" },
    // Motion Graphics starter template (must render out of the box — agent only edits MyVideo.tsx)
    { skillName: "motion-graphics", localPath: "assets/template-basic/package.json", remotePath: "assets/template-basic/package.json" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/remotion.config.ts", remotePath: "assets/template-basic/remotion.config.ts" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/tsconfig.json", remotePath: "assets/template-basic/tsconfig.json" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/src/index.ts", remotePath: "assets/template-basic/src/index.ts" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/src/Root.tsx", remotePath: "assets/template-basic/src/Root.tsx" },
    { skillName: "motion-graphics", localPath: "assets/template-basic/src/MyVideo.tsx", remotePath: "assets/template-basic/src/MyVideo.tsx" },
    // DegenClaw trading competition — reference docs
    { skillName: "dgclaw", localPath: "references/api.md", remotePath: "references/api.md" },
    { skillName: "dgclaw", localPath: "references/strategy-playbook.md", remotePath: "references/strategy-playbook.md" },
  ] as ManifestExtraSkillFile[],

  // ── Cron jobs ──
  cronJobs: [
    {
      schedule: "* * * * *",
      command: "python3 ~/.openclaw/scripts/strip-thinking.py > /dev/null 2>&1",
      marker: "strip-thinking.py",
    },
    {
      schedule: "* * * * *",
      command: "python3 ~/.openclaw/scripts/auto-approve-pairing.py > /dev/null 2>&1",
      marker: "auto-approve-pairing.py",
    },
    // v76: vm-watchdog.py + silence-watchdog.py REMOVED from cron schedule.
    //
    // The 5-min stale-session-jsonl heuristic in vm-watchdog.py was actively
    // killing working agents that were just SLOW (we measured p99 chat
    // completion at 69s and max 182s on 2026-05-01; tool-call cycles can run
    // for many minutes). Multiple paying users had their gateways restarted
    // every ~6 minutes, which dropped Telegram polling for ~5s per restart
    // and made messages disappear into the gap.
    //
    // The script files themselves stay deployed in ~/.openclaw/scripts/ so a
    // rewrite can land without re-pushing them — but no cron will run them
    // until that rewrite ships with:
    //   1. AGENT_STALE_MINUTES bumped from 5 → 15-30
    //   2. Real liveness check (active outbound API conn from gateway PID,
    //      OR last_proxy_call_at timestamp from DB) instead of jsonl mtime
    //
    // A fleet-wide one-shot SSH push commented out the cron entries on all
    // existing VMs (2026-05-01); this manifest change ensures new VMs
    // provisioned from a fresh snapshot don't get them either.
    {
      schedule: "0 * * * *",
      command: "bash ~/.openclaw/scripts/push-heartbeat.sh",
      marker: "push-heartbeat.sh",
    },
    {
      schedule: "0 4 * * *",
      command: ". /home/openclaw/.nvm/nvm.sh && openclaw memory index >> /tmp/memory-index.log 2>&1",
      marker: "openclaw memory index",
    },
    {
      // v71: Prune workspace backup dirs older than 14 days. Some power-user
      // agents create custom daily-backup scripts (~/.openclaw/workspace/
      // scripts/daily-backup.sh, ~/scripts/workspace-backup.sh) writing to
      // ~/.openclaw/workspace/backups/<date>/. Without retention, these
      // accumulate linearly: vm-435 (YouthWork) hit 1.1 GB across 32+ daily
      // dirs. Weekly safety-net cron at 04:30 Sunday (after the 04:00 memory
      // index) deletes any subdir of workspace/backups/ older than 14 days.
      // -mindepth 1 ensures the parent dir itself is never deleted.
      // 2>/dev/null swallows "no such file" on VMs without backups (most).
      schedule: "30 4 * * 0",
      command: "find ~/.openclaw/workspace/backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null",
      marker: "workspace/backups",
    },
  ] as ManifestCronJob[],

  // ── System packages (installed via sudo apt-get) ──
  systemPackages: ["ffmpeg", "jq"],

  // ── Python packages (installed via pip3) ──
  pythonPackages: ["openai"],

  // ── Platform env vars that MUST exist in ~/.openclaw/.env ──
  // Actual values come from DB (instaclaw_vms.gateway_token, etc.)
  requiredEnvVars: ["GATEWAY_TOKEN", "POLYGON_RPC_URL", "CLOB_PROXY_URL", "CLOB_PROXY_URL_BACKUP", "AGENT_REGION"],

  // Default values for env vars that don't come from the DB
  envVarDefaults: {
    POLYGON_RPC_URL: "https://1rpc.io/matic",
    CLOB_PROXY_URL: "http://172.105.22.90:8080",
    CLOB_PROXY_URL_BACKUP: "http://172.237.101.206:8080",  // London 2 (gb-lon) backup proxy
  } as Record<string, string>,

  // ── openclaw.json initial settings (written by configureOpenClaw, NOT reconciler) ──
  // NOTE: configSettings above is the authoritative source — the reconciler enforces those.
  // This section is only used during initial VM provisioning via buildOpenClawConfig().
  openclawJsonSettings: {
    "skills.load.extraDirs": ["/home/openclaw/.openclaw/skills"],
    // DO NOT CHANGE — must match configSettings value above. See comments there.
    "skills.limits.maxSkillsPromptChars": 500000,
  } as Record<string, unknown>,

  // ── Systemd unit overrides for openclaw-gateway.service ──
  // Applied by reconciler and configureOpenClaw after `openclaw gateway install`.
  // SPLIT INTO TWO SECTIONS in v75:
  //   - systemdUnitOverrides → emitted into [Unit] block of override.conf
  //   - systemdOverrides     → emitted into [Service] block of override.conf
  //
  // The split is REQUIRED for systemd correctness. StartLimit* directives ONLY
  // work in [Unit] — putting them in [Service] silently emits parse warnings
  // ("Unknown key name 'StartLimitIntervalSec' in section 'Service', ignoring")
  // and the directives themselves get DROPPED, leaving start-limit protection
  // entirely non-functional. Confirmed via journalctl on vm-780 (2026-05-01).
  systemdUnitOverrides: {
    "StartLimitBurst": "10",       // Max 10 restarts in StartLimitIntervalSec window
    "StartLimitIntervalSec": "300", // 5-minute window for burst counting
    "StartLimitAction": "none",    // 'stop' is NOT valid systemd. 'none' = "do nothing extra" — combined with the burst counter, systemd will stop honoring Restart=always once burst is exceeded. (v74 fixed the value, v75 fixes the section.)
  } as Record<string, string>,
  systemdOverrides: {
    "KillMode": "mixed",           // Kill Chrome children when gateway stops (was: process)
    "Delegate": "yes",             // Keep agent-spawned child processes inside the CGroup so KillMode=mixed catches them
    "RestartSec": "10",            // Wait 10s between restarts (was: 5)
    // v73: appended `memory-snapshot.sh restore` to existing ExecStartPre.
    // Runs before each gateway start: if MEMORY.md is empty/template (<50B)
    // but workspace/memory/MEMORY.md.bak has real content, restore from
    // backup + log to memory/restore.log. Safety guards prevent overwriting
    // a non-empty live file. See agent-intelligence.ts MEMORY_SNAPSHOT_SCRIPT.
    "ExecStartPre": "/bin/bash -c 'find /tmp/openclaw/ -name \"*.log\" -mmin +60 -delete 2>/dev/null; find /tmp/openclaw/ -name \"*.log.bak\" -mtime +3 -delete 2>/dev/null; pkill -9 -f \"[c]hrome.*remote-debugging-port\" 2>/dev/null || true; bash /home/openclaw/.openclaw/scripts/memory-snapshot.sh restore 2>/dev/null || true'",
    // v73: ExecStopPost runs after every gateway shutdown. Snapshots
    // MEMORY.md → workspace/memory/MEMORY.md.bak so the restore path above
    // has something to recover from. Runs once per stop event (clean OR
    // signaled). Idempotent + safe (won't overwrite a good backup with
    // an empty file).
    "ExecStopPost": "/bin/bash /home/openclaw/.openclaw/scripts/memory-snapshot.sh pre-stop 2>/dev/null || true",
    "MemoryHigh": "3G",             // Soft limit: kernel throttles at 3GB (gateway slows, doesn't die)
    "MemoryMax": "3500M",           // Hard kill: cgroup OOM at 3.5GB (leaves 500MB for sshd/system)
    "TasksMax": "75",               // Max threads+processes (Node ~11 + Chrome ~50 + small headroom). Was 150 — reduced to prevent runaway agent forks
    "OOMScoreAdjust": "500",        // Higher = killed first. sshd has -900. Gateway dies before sshd.
    "RuntimeMaxSec": "86400",       // Auto-restart gateway after 24h to prevent memory bloat
    "RuntimeRandomizedExtraSec": "3600", // Stagger restarts across fleet by up to 1h
    // Virtuals Protocol partner attribution — ensures ALL child processes (agent tools,
    // npx acp, dgclaw.sh) inherit PARTNER_ID regardless of working directory or dotenv.
    // Confirmed by Mira @ Virtuals 2026-03-30: "inject PARTNER_ID=INSTACLAW to process.env"
    "Environment": "PARTNER_ID=INSTACLAW",
  } as Record<string, string>,

  // ── Session thresholds ──
  // NOTE: These are used by the health cron for alerting only. rotateOversizedSession()
  // was removed in v45 (P3.2). The PRIMARY enforcement is in strip-thinking.py which uses
  // its own hardcoded thresholds: MAX_SESSION_BYTES=200KB, MEMORY_WARN_BYTES=160KB
  // (defined in the STRIP_THINKING_SCRIPT template in ssh.ts:110-111). Those were lowered
  // independently after web fetch blowouts caused sessions to balloon past 512KB between
  // health cron cycles. The values below are the "outer fence" — if strip-thinking misses
  // a session (e.g., cron not running), the health cron catches it at these higher thresholds.
  // See PRD-memory-architecture-overhaul.md Section 2.2 for the full split-brain analysis.
  maxSessionBytes: 512 * 1024,
  sessionAlertBytes: 480 * 1024,
  memoryWarnBytes: 400 * 1024,
} as const;

export type VMManifest = typeof VM_MANIFEST;

// ── Backwards compatibility ──
// CONFIG_SPEC was the old name. Re-export so existing code (upgradeOpenClaw,
// configureOpenClaw, health cron) can keep using it during migration.
export const CONFIG_SPEC = {
  version: VM_MANIFEST.version,
  settings: VM_MANIFEST.configSettings,
  requiredWorkspaceFiles: ["SOUL.md", "CAPABILITIES.md", "MEMORY.md", "EARN.md"],
  maxSessionBytes: VM_MANIFEST.maxSessionBytes,
  sessionAlertBytes: VM_MANIFEST.sessionAlertBytes,
  memoryWarnBytes: VM_MANIFEST.memoryWarnBytes,
};
