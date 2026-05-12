#!/usr/bin/env python3
"""ack-watchdog.py — Layer 3 of the Agent Acknowledgment UX.

Detects stalled Telegram turns and emits a slow-warning (>30s) or hard-fail
(>180s) message via direct Telegram Bot API call. Runs every minute via
cron. Read-only on OpenClaw session state.

PRD: docs/prd/agent-acknowledgment-ux-2026-05-11.md (§5.4, §6.2)

Sentinels (Rule 23 — required strings checked by manifest):
  "def is_turn_stalled"
  "ACK_WATCHDOG_SLOW_WARNING"

Key invariants:
  1. NEVER writes to a session .jsonl. NEVER deletes sessions.json entries.
     NEVER restarts the gateway. (Rules 22, 30 — preserve user state.)
  2. Per-turn dedup: each turn gets at most ONE slow-warning + ONE hard-fail.
  3. Filters by lastChannel === "telegram". Non-telegram sessions ignored.
  4. Re-verifies stall status immediately before sending (race-window guard).
  5. Idempotent — multiple ticks in quick succession won't double-send.
  6. Bounded work — reads only the last 1MB of any trajectory file
     (covers all observed session shapes on vm-050; ~10ms disk I/O/tick).
  7. Telegram 429s do NOT mark state — next tick will retry naturally.

Trajectory format (OpenClaw 2026.4.26):
  Each line is JSON with a top-level `type`:
    - "session"                — session init (skipped)
    - "model_change"           — model switch (skipped)
    - "thinking_level_change"  — thinking mode toggle (skipped)
    - "custom"                 — runtime context (skipped)
    - "custom_message"         — runtime context (skipped — `display: false`)
    - "message"                — actual conversation
      .message.role: "user" | "assistant" | "toolResult"
      .message.content: list of blocks (text, toolCall, toolResult)
      .message.timestamp: Unix ms

Verified empirically on vm-050 (2026-05-11/12).
"""
import json
import os
import sys
import time
import urllib.request
import urllib.parse
import fcntl
import traceback
from datetime import datetime, timezone

# Dry-run mode: don't actually call Telegram; print what would be sent.
# Useful for canary testing. Pass --dry-run on the CLI.
DRY_RUN = "--dry-run" in sys.argv
# Verbose mode: log a one-line summary per session inspected. Use --verbose
# during canary; not in production cron (would log every minute).
VERBOSE = "--verbose" in sys.argv

# ── Paths ────────────────────────────────────────────────────────────────
OPENCLAW_DIR = os.path.expanduser("~/.openclaw")
SESSIONS_DIR = os.path.join(OPENCLAW_DIR, "agents/main/sessions")
SESSIONS_JSON = os.path.join(SESSIONS_DIR, "sessions.json")
STATE_FILE = os.path.join(SESSIONS_DIR, ".ack-watchdog-state.json")
LOCK_FILE = os.path.join(SESSIONS_DIR, ".ack-watchdog.lock")
CONFIG_FILE = os.path.join(OPENCLAW_DIR, "openclaw.json")
LOG_FILE = os.path.join(OPENCLAW_DIR, "logs/ack-watchdog.log")

# ── Thresholds ──────────────────────────────────────────────────────────
SLOW_WARN_AGE_MS = 30 * 1000           # 30s — emit slow-warning
HARD_FAIL_AGE_MS = 180 * 1000          # 180s (3 min) — emit hard-fail
MAX_TURN_AGE_MS = 30 * 60 * 1000       # 30 min — abandoned turn, never act
# Trajectory tail window. Real session files on vm-050 are 100-300KB.
# A SLOW prompt with 3 web fetches produces ~40-60KB of toolResult+assistant
# entries BETWEEN the last user msg and EOF — the 32KB original tail missed
# the user msg entirely (status=unknown silent skip). Bug found 2026-05-12.
# 1MB covers all observed session shapes with margin. Cost: ~10ms disk I/O
# per watchdog tick (negligible).
TAIL_READ_BYTES = 1024 * 1024          # 1MB tail of trajectory file
PRE_EMIT_RECHECK_MS = 100              # delay between decision and emit (race guard)

# ── User-facing copy ────────────────────────────────────────────────────
# Per PRD §13.4 Appendix D — variant A, Cooper-approved:
ACK_WATCHDOG_SLOW_WARNING = "_Thinking through this one — give me ~30s._"
ACK_WATCHDOG_HARD_FAIL = (
    "Hit my limit on this one — taking too long. "
    "Mind retrying or rephrasing?"
)
# v1 ships text-only. Inline keyboard with [Try again] is v1.1 per PRD §11.3.

# ── Telegram API ────────────────────────────────────────────────────────
TELEGRAM_API_TIMEOUT_S = 10

def log(msg):
    """Append a single timestamped line to the log file."""
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat()
        with open(LOG_FILE, "a") as f:
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass  # logging failures must not crash the watchdog

def acquire_lock():
    """flock-based single-instance guard. Returns fd or None."""
    try:
        fd = os.open(LOCK_FILE, os.O_WRONLY | os.O_CREAT, 0o644)
    except OSError as e:
        log(f"lock open failed: {e}")
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        log("another ack-watchdog instance is running; exiting")
        os.close(fd)
        return None

def release_lock(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    except OSError:
        pass

def read_json_safe(path):
    """Read a JSON file, returning None on any error."""
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

def write_state_atomic(state):
    """Atomic write — tmp + os.replace."""
    tmp = STATE_FILE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, STATE_FILE)
    except OSError as e:
        log(f"state write failed: {e}")

def get_telegram_token():
    """Read bot token from openclaw.json."""
    cfg = read_json_safe(CONFIG_FILE)
    if not cfg:
        return None
    return (
        cfg.get("channels", {})
           .get("telegram", {})
           .get("botToken")
    )

def read_trajectory_tail(session_file, max_bytes=TAIL_READ_BYTES):
    """Read the last N bytes of a trajectory file. Returns text or None.

    Reading from the end ensures we have the most recent messages without
    parsing the entire (potentially 200KB) file every tick.
    """
    if not session_file or not os.path.exists(session_file):
        return None
    try:
        size = os.path.getsize(session_file)
        with open(session_file, "rb") as f:
            f.seek(max(0, size - max_bytes))
            data = f.read()
        return data.decode("utf-8", errors="ignore")
    except OSError:
        return None

def has_visible_text(content):
    """True if assistant content (list of blocks) contains a non-empty text block."""
    if isinstance(content, str):
        return bool(content.strip())
    if not isinstance(content, list):
        return False
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = block.get("text") or ""
            if text.strip():
                return True
    return False

def is_turn_stalled(session_file):
    """Determine the status of the most recent turn.

    Returns one of:
      "stalled"  — most recent user message has NO subsequent assistant text
      "served"   — assistant has emitted text after the last user message
      "unknown"  — file missing, unreadable, or no user message in tail

    Algorithm (walk trajectory from END backwards):
      1. Read last 32KB of file.
      2. Split into lines; iterate in REVERSE (newest first).
      3. Track `found_assistant_text` flag.
      4. For each `type:"message"` entry:
         - role == "assistant" with visible text → set found_assistant_text=True
         - role == "user" → STOP; return "served" if flag set, "stalled" otherwise
         - role == "toolResult" → skip (doesn't affect decision)
      5. If we never find a user message in the tail → "unknown".

    Edge cases:
      - tool_use without intermediate text: keeps walking until user msg
      - thinking blocks: not "text" type, ignored
      - empty assistant text ("" or whitespace): ignored
      - custom_message / model_change / session: type != "message", skipped
    """
    tail = read_trajectory_tail(session_file)
    if tail is None:
        return "unknown"

    lines = tail.split("\n")
    found_assistant_text = False

    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            # Could be a truncated line at the start of our tail window.
            continue

        if obj.get("type") != "message":
            continue

        msg = obj.get("message", {})
        if not isinstance(msg, dict):
            continue

        role = msg.get("role")
        if role == "assistant":
            if has_visible_text(msg.get("content")):
                found_assistant_text = True
            # Keep walking — we want the most recent USER message
            continue
        if role == "user":
            return "served" if found_assistant_text else "stalled"
        # role == "toolResult" or other — skip
        continue

    return "unknown"

def parse_chat_id(last_to):
    """Extract numeric chat_id from `telegram:<id>` string.

    Returns int or None.
    """
    if not isinstance(last_to, str):
        return None
    if not last_to.startswith("telegram:"):
        return None
    raw = last_to.split(":", 1)[1]
    try:
        return int(raw)
    except (ValueError, TypeError):
        return None

def send_telegram_message(token, chat_id, text, parse_mode="MarkdownV2"):
    """POST to Telegram Bot API sendMessage. Returns (ok, message_id_or_error_msg)."""
    if DRY_RUN:
        log(f"[DRY-RUN] would send to chat_id={chat_id} parse_mode={parse_mode}: {text!r}")
        print(f"[DRY-RUN] would send: chat_id={chat_id} text={text!r}")
        return True, "dry-run"
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": str(chat_id),
        "text": text,
        "disable_notification": "false",  # user expects feedback
    }
    if parse_mode:
        payload["parse_mode"] = parse_mode
    body = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TELEGRAM_API_TIMEOUT_S) as resp:
            try:
                data = json.load(resp)
            except json.JSONDecodeError:
                return False, "non-json response"
            if data.get("ok"):
                return True, data.get("result", {}).get("message_id")
            desc = data.get("description", "unknown")
            return False, f"API error: {desc}"
    except urllib.error.HTTPError as e:
        # Read response body for error details (especially 429 retry_after).
        try:
            body = json.load(e)
            return False, f"HTTP {e.code}: {body.get('description','?')}"
        except Exception:
            return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, f"URL error: {e}"
    except Exception as e:
        return False, f"send failed: {e}"

def process_session(session_key, session, state, token, now_ms):
    """Inspect one session; emit warning/hard-fail if stalled.

    Mutates `state` (in-memory dict) — caller persists to disk at end.
    """
    if session.get("lastChannel") != "telegram":
        if VERBOSE: log(f"[verbose] {session_key}: skip (lastChannel={session.get('lastChannel')})")
        return

    last_at = session.get("lastInteractionAt", 0)
    if not isinstance(last_at, (int, float)) or last_at <= 0:
        if VERBOSE: log(f"[verbose] {session_key}: skip (no lastInteractionAt)")
        return

    age_ms = now_ms - int(last_at)
    if age_ms < SLOW_WARN_AGE_MS:
        # Turn still in normal stream window — not our concern.
        if VERBOSE: log(f"[verbose] {session_key}: skip (age={age_ms/1000:.1f}s < 30s)")
        if session_key in state:
            del state[session_key]
        return

    if age_ms > MAX_TURN_AGE_MS:
        if VERBOSE: log(f"[verbose] {session_key}: skip (age={age_ms/1000:.1f}s > 30min abandoned)")
        if session_key in state:
            del state[session_key]
        return

    chat_id = parse_chat_id(session.get("lastTo"))
    if chat_id is None:
        if VERBOSE: log(f"[verbose] {session_key}: skip (chat_id unparseable from lastTo={session.get('lastTo')})")
        return

    session_file = session.get("sessionFile")
    if not session_file:
        if VERBOSE: log(f"[verbose] {session_key}: skip (no sessionFile)")
        return

    # Determine status by walking trajectory tail
    status = is_turn_stalled(session_file)
    if VERBOSE: log(f"[verbose] {session_key}: age={age_ms/1000:.1f}s status={status} chat={chat_id}")
    if status != "stalled":
        # Either served (assistant has responded) or unknown (file missing).
        # Either way, no warning needed. Clean up stale state.
        if session_key in state:
            del state[session_key]
        return

    # Compute turnId — stable identifier for the current turn
    turn_id = str(int(last_at))

    existing = state.get(session_key, {})
    if existing.get("turnId") != turn_id:
        # New turn — reset state
        state[session_key] = {"turnId": turn_id}
        existing = state[session_key]

    if existing.get("hardFailEmittedAt"):
        return  # already hard-failed this turn
    warning_emitted = existing.get("warningEmittedAt") is not None

    # Decision: hard-fail vs warning vs no-op
    should_hard_fail = age_ms >= HARD_FAIL_AGE_MS
    should_warn = (not warning_emitted) and (age_ms >= SLOW_WARN_AGE_MS)

    if not should_hard_fail and not should_warn:
        return

    # Pre-emit race-guard: re-check trajectory IMMEDIATELY before sending.
    # Tight window where the gateway might have just finished the turn.
    time.sleep(PRE_EMIT_RECHECK_MS / 1000.0)
    recheck_status = is_turn_stalled(session_file)
    if recheck_status != "stalled":
        log(f"pre-emit race aborted: session={session_key} now={recheck_status}")
        if session_key in state:
            del state[session_key]
        return

    # Pick message + emit
    if should_hard_fail:
        text = ACK_WATCHDOG_HARD_FAIL
        # Hard-fail uses plain text (no MarkdownV2 escaping needed for this copy)
        # The dashes ("—") and punctuation are safe outside MarkdownV2 mode.
        ok, result = send_telegram_message(token, chat_id, text, parse_mode=None)
        if ok:
            existing["hardFailEmittedAt"] = now_ms
            log(f"hard-fail emitted: session={session_key} chat={chat_id} age={age_ms/1000:.1f}s msg_id={result}")
        else:
            log(f"hard-fail send failed: session={session_key} chat={chat_id} {result}")
    else:
        # Warning: MarkdownV2 italic via underscores. Text is pre-escaped.
        text = ACK_WATCHDOG_SLOW_WARNING
        ok, result = send_telegram_message(token, chat_id, text, parse_mode="MarkdownV2")
        if ok:
            existing["warningEmittedAt"] = now_ms
            log(f"slow-warning emitted: session={session_key} chat={chat_id} age={age_ms/1000:.1f}s msg_id={result}")
        else:
            # Fall back to plain text if MarkdownV2 parsing failed
            if "can't parse entities" in str(result).lower():
                ok2, result2 = send_telegram_message(token, chat_id, text.strip("_"), parse_mode=None)
                if ok2:
                    existing["warningEmittedAt"] = now_ms
                    log(f"slow-warning emitted (plain fallback): session={session_key} chat={chat_id} age={age_ms/1000:.1f}s msg_id={result2}")
                else:
                    log(f"slow-warning send failed (both modes): session={session_key} chat={chat_id} {result} / {result2}")
            else:
                log(f"slow-warning send failed: session={session_key} chat={chat_id} {result}")
                # Do NOT mark warningEmittedAt — next tick will retry.

def main():
    """Top-level: lock, read state, iterate sessions, write state."""
    lock_fd = acquire_lock()
    if lock_fd is None:
        return

    try:
        token = get_telegram_token()
        if not token:
            log("no telegram bot token in openclaw.json; exiting")
            return

        sessions_obj = read_json_safe(SESSIONS_JSON)
        if not isinstance(sessions_obj, dict):
            log("sessions.json missing or unreadable; exiting")
            return

        state = read_json_safe(STATE_FILE) or {}
        if not isinstance(state, dict):
            state = {}

        now_ms = int(time.time() * 1000)
        sessions_processed = 0

        for session_key, session in sessions_obj.items():
            if not isinstance(session, dict):
                continue
            try:
                process_session(session_key, session, state, token, now_ms)
                sessions_processed += 1
            except Exception as e:
                log(f"process_session failed: key={session_key} err={e}\n{traceback.format_exc()}")

        write_state_atomic(state)
    finally:
        release_lock(lock_fd)

if __name__ == "__main__":
    main()
