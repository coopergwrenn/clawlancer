#!/usr/bin/env python3
"""
consensus_intent_sync.py — VM-side cron bridge for the matching engine.

Runs every 15 minutes on each user's VM (cron). Self-throttles internally:
extracts intent only when MEMORY.md has materially changed AND the last
extraction was at least 2 hours ago, OR when the last extraction is more
than 24 hours stale.

When extraction is needed, calls extract_intent() (consensus_intent_extract.py)
and POSTs the structured profile to https://instaclaw.io/api/match/v1/profile
with the user's GATEWAY_TOKEN.

PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.1
Component 4 of 16.

Design (per ultrathink session before write):

  - Self-throttling avoids redundant work: hash + char-delta gate filters
    out whitespace-only changes. ~$0 cost when MEMORY.md hasn't shifted.
  - Always POSTs even when consent_tier='hidden' on the platform side. The
    platform stores the profile but doesn't surface it for matching until
    the user opts in. This way opt-in is instant, not lagging.
  - Locks via fcntl.LOCK_EX | LOCK_NB matching strip-thinking.py pattern.
  - Tier 2 (Telegram cold-start question) is a SEPARATE concern handled by
    component 10. This script just extracts what it can and POSTs.
  - --dry-run for local testing without component 5 endpoint live yet.

Cron entry (added by component 4 deploy):
  */15 * * * * python3 ~/.openclaw/scripts/consensus_intent_sync.py 2>> /tmp/consensus_intent_sync.log
"""
import argparse
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# Same dir as the extractor, by convention. Both ship via the same deploy.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import extractor functions. The script is colocated.
from consensus_intent_extract import (
    extract_intent,
    read_memory_md,
    read_recent_session_text,
    get_gateway_token,
    log as extract_log,
)

# ─── Config ─────────────────────────────────────────────────────────

STATE_PATH = os.path.expanduser("~/.openclaw/.consensus_intent_state.json")
LOCK_PATH = os.path.expanduser("~/.openclaw/.consensus_intent.lock")

PROFILE_ENDPOINT = "https://instaclaw.io/api/match/v1/profile"
CONSENT_ENDPOINT = "https://instaclaw.io/api/match/v1/consent"
SKILL_CHECK_TIMEOUT_SECONDS = 8
POST_TIMEOUT_SECONDS = 20
MAX_POST_RETRIES = 3
RETRY_BACKOFFS = [1.0, 3.0, 8.0]   # seconds

# Self-throttle thresholds
MIN_EXTRACT_INTERVAL_SECONDS = 2 * 60 * 60   # 2 hours
STALE_EXTRACT_INTERVAL_SECONDS = 24 * 60 * 60 # 24 hours
MIN_CHAR_DELTA_FOR_RE_EXTRACT = 200          # ~1 sentence

EXTRACTOR_VERSION = "v1"


# ─── Logging ────────────────────────────────────────────────────────

def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] consensus_intent_sync: {msg}", file=sys.stderr, flush=True)


# ─── State management ───────────────────────────────────────────────

def load_state() -> dict:
    """Load sync state. Returns sane defaults if missing or corrupt."""
    try:
        with open(STATE_PATH) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        return data
    except (FileNotFoundError, json.JSONDecodeError, IOError):
        return {}


def save_state(state: dict) -> None:
    """Atomic state write."""
    tmp = STATE_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, STATE_PATH)
    except IOError as e:
        log(f"save_state failed: {e}")
        try:
            os.remove(tmp)
        except IOError:
            pass


# ─── Material-change detection ──────────────────────────────────────

def memory_hash(text: str) -> str:
    """SHA-256 of memory content. Stable across runs."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def should_extract(state: dict, current_text: str, current_hash: str) -> tuple[bool, str]:
    """Return (should_extract, reason).

    Triggers:
      - last extraction > 24h ago (staleness floor): always extract
      - hash differs AND char-delta > 200 AND last extraction > 2h ago
      - never extracted before: always extract

    Returns False with a reason for telemetry when skipping.
    """
    now = int(time.time())
    last_extracted_at = int(state.get("last_extracted_at", 0))
    last_hash = state.get("last_memory_hash")
    last_chars = int(state.get("last_memory_chars", 0))

    # Never extracted: always go.
    if last_extracted_at == 0:
        return True, "first_extraction"

    age = now - last_extracted_at

    # Staleness floor: 24h since last extraction.
    if age >= STALE_EXTRACT_INTERVAL_SECONDS:
        return True, f"staleness_floor (last={age}s ago)"

    # Same content: skip.
    if last_hash == current_hash:
        return False, "no_change_in_memory"

    # Hash differs but it's been < 2h: throttle.
    if age < MIN_EXTRACT_INTERVAL_SECONDS:
        return False, f"throttled (last extraction {age}s ago, threshold {MIN_EXTRACT_INTERVAL_SECONDS}s)"

    # Hash differs, age > 2h: check char-delta.
    char_delta = abs(len(current_text) - last_chars)
    if char_delta < MIN_CHAR_DELTA_FOR_RE_EXTRACT:
        return False, f"char_delta_too_small (Δ={char_delta} < {MIN_CHAR_DELTA_FOR_RE_EXTRACT})"

    return True, f"material_change (Δ={char_delta} chars, age={age}s)"


# ─── Skill-state check ──────────────────────────────────────────────

def check_skill_enabled(gateway_token: str) -> tuple[bool, str]:
    """Hit /api/match/v1/consent GET to read the skill_enabled flag.

    Returns (enabled, reason). Reason is informational telemetry text.

    Failure modes — defaults to "off" so we never accidentally extract
    intent for a non-attending user when the network is glitchy:
      - HTTP error (4xx/5xx)            → (False, "http_error_<status>")
      - Network failure (DNS, timeout)  → (False, "network_error")
      - JSON parse failure              → (False, "parse_error")
      - Field missing (skill_enabled)   → (False, "field_missing")

    Cost: ~1 round trip per cron tick (4/hr). Negligible.
    """
    req = urllib.request.Request(
        CONSENT_ENDPOINT,
        method="GET",
        headers={
            "Authorization": f"Bearer {gateway_token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=SKILL_CHECK_TIMEOUT_SECONDS) as resp:
            try:
                body = json.loads(resp.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                return False, f"parse_error: {type(e).__name__}"
            enabled = body.get("skill_enabled")
            if enabled is None:
                # Older server (pre-v82.5) didn't return the field. Treat as
                # "off" — the cron tick is cheap; better to no-op than
                # extract for an indeterminate user.
                return False, "field_missing"
            return bool(enabled), f"ok ({body.get('skill_slug', '?')}={'on' if enabled else 'off'})"
    except urllib.error.HTTPError as e:
        return False, f"http_error_{e.code}"
    except urllib.error.URLError as e:
        return False, f"network_error: {e.reason}"


# ─── HTTP POST to platform ──────────────────────────────────────────

def post_profile(profile: dict, gateway_token: str, memory_chars: int,
                 is_cold_start: bool) -> tuple[bool, dict]:
    """POST the extracted profile to the platform. Returns (ok, response_dict)."""
    body = {
        **profile,
        "metadata": {
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "extractor_version": EXTRACTOR_VERSION,
            "memory_chars": memory_chars,
            "is_cold_start": is_cold_start,
        },
    }

    last_err = None
    for attempt in range(MAX_POST_RETRIES):
        try:
            result = subprocess.run(
                [
                    "curl", "-s",
                    "-w", "\n___HTTP_STATUS___%{http_code}",
                    "--max-time", str(POST_TIMEOUT_SECONDS),
                    "-H", f"Authorization: Bearer {gateway_token}",
                    "-H", "Content-Type: application/json",
                    "-d", json.dumps(body),
                    PROFILE_ENDPOINT,
                ],
                capture_output=True,
                text=True,
                timeout=POST_TIMEOUT_SECONDS + 5,
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            last_err = f"transport: {e}"
            log(f"POST attempt {attempt + 1}/{MAX_POST_RETRIES} failed transport: {e}")
            if attempt < MAX_POST_RETRIES - 1:
                time.sleep(RETRY_BACKOFFS[attempt])
            continue

        # Parse the response. We append "___HTTP_STATUS___NNN" to capture
        # the HTTP code without needing a separate request.
        out = result.stdout
        sentinel = "\n___HTTP_STATUS___"
        idx = out.rfind(sentinel)
        if idx < 0:
            last_err = f"malformed curl output: {out[:200]}"
            log(f"POST attempt {attempt + 1}/{MAX_POST_RETRIES} {last_err}")
            if attempt < MAX_POST_RETRIES - 1:
                time.sleep(RETRY_BACKOFFS[attempt])
            continue

        body_text = out[:idx]
        try:
            status = int(out[idx + len(sentinel):])
        except ValueError:
            last_err = f"unparseable status code: {out[idx + len(sentinel):]}"
            log(f"POST attempt {attempt + 1}/{MAX_POST_RETRIES} {last_err}")
            if attempt < MAX_POST_RETRIES - 1:
                time.sleep(RETRY_BACKOFFS[attempt])
            continue

        # 2xx — success
        if 200 <= status < 300:
            try:
                resp = json.loads(body_text) if body_text.strip() else {}
            except json.JSONDecodeError:
                resp = {"raw": body_text[:200]}
            log(f"POST ok (HTTP {status}): {json.dumps(resp)[:200]}")
            return True, resp

        # 4xx — caller bug; don't retry
        if 400 <= status < 500:
            log(f"POST {status} (no retry): {body_text[:200]}")
            return False, {"http_status": status, "body": body_text[:500]}

        # 5xx or unexpected — retry
        last_err = f"HTTP {status}: {body_text[:200]}"
        log(f"POST attempt {attempt + 1}/{MAX_POST_RETRIES} got {last_err}")
        if attempt < MAX_POST_RETRIES - 1:
            time.sleep(RETRY_BACKOFFS[attempt])

    log(f"POST failed after {MAX_POST_RETRIES} attempts: {last_err}")
    return False, {"error": last_err}


# ─── Lock acquisition ───────────────────────────────────────────────

def acquire_lock_or_exit() -> int:
    """Acquire exclusive lock. Returns fd to keep open. Exits 0 if locked."""
    try:
        fd = open(LOCK_PATH, "w")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (IOError, OSError):
        log("another sync run in progress; exiting cleanly")
        sys.exit(0)


# ─── Main ───────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="VM-side intent sync for matching engine")
    parser.add_argument("--dry-run", action="store_true",
                        help="Extract but don't POST. For local testing.")
    parser.add_argument("--force", action="store_true",
                        help="Bypass throttle/hash checks. Always extract + POST.")
    args = parser.parse_args()

    lock_fd = acquire_lock_or_exit()

    try:
        # ─ Skill gate: don't burn Haiku tokens on non-attending users ─
        # Get token first; without it we'd fail anyway when POSTing.
        # Then check whether the consensus-2026 skill is enabled. If off:
        # silently exit. The user either isn't attending Consensus or has
        # explicitly disabled matching. The agent on this VM may still
        # offer to enable the skill via the organic-activation flow when
        # strong Consensus signals appear in chat.
        #
        # --force bypasses this check too — useful for operator/test paths
        # that want to force an extraction regardless of skill state.
        if not args.force and not args.dry_run:
            gateway_token = get_gateway_token()
            if not gateway_token:
                log("no GATEWAY_TOKEN; cannot check skill state, exiting cleanly")
                return 0
            enabled, reason = check_skill_enabled(gateway_token)
            log(f"skill_check: enabled={enabled} reason={reason}")
            if not enabled:
                log("skip skill_disabled")
                return 0

        # Load current state
        state = load_state()
        memory_text = read_memory_md()
        if not memory_text:
            log("no MEMORY.md found; nothing to sync")
            return 0

        current_hash = memory_hash(memory_text)
        current_chars = len(memory_text)

        # Self-throttle gate
        if not args.force:
            should, reason = should_extract(state, memory_text, current_hash)
            log(f"should_extract = {should} ({reason})")
            if not should:
                return 0
        else:
            log("--force: bypassing throttle/hash checks")

        # Extract
        recent_text = read_recent_session_text()
        log(f"extracting (memory={current_chars}c, recent={len(recent_text)}c)")
        profile = extract_intent(memory_text, recent_text)
        if profile is None:
            log("extract_intent returned None; saving state and exiting")
            # Update state's "last_attempted_at" so we don't retry instantly
            state["last_extraction_attempt_at"] = int(time.time())
            state["last_extraction_failed"] = True
            save_state(state)
            return 1

        is_cold_start = profile.get("confidence", 1.0) <= 0.2

        # Dry run path
        if args.dry_run:
            print(json.dumps({
                "would_post_to": PROFILE_ENDPOINT,
                "body": {
                    **profile,
                    "metadata": {
                        "extracted_at": datetime.now(timezone.utc).isoformat(),
                        "extractor_version": EXTRACTOR_VERSION,
                        "memory_chars": current_chars,
                        "is_cold_start": is_cold_start,
                    },
                },
            }, indent=2))
            log("--dry-run: skipping POST")
            return 0

        # POST
        gateway_token = get_gateway_token()
        if not gateway_token:
            log("ERROR: no GATEWAY_TOKEN; cannot POST")
            return 1

        ok, resp = post_profile(
            profile,
            gateway_token,
            memory_chars=current_chars,
            is_cold_start=is_cold_start,
        )

        # Update state regardless of POST outcome
        now = int(time.time())
        state["last_extracted_at"] = now
        state["last_memory_hash"] = current_hash
        state["last_memory_chars"] = current_chars
        state["last_extraction_confidence"] = profile.get("confidence")
        state["last_extraction_failed"] = False

        if ok:
            state["last_post_succeeded_at"] = now
            state["consecutive_post_failures"] = 0
            if isinstance(resp, dict):
                if "profile_version" in resp:
                    state["last_profile_version"] = resp["profile_version"]
                if "consent_tier" in resp:
                    state["last_known_consent_tier"] = resp["consent_tier"]
        else:
            state["consecutive_post_failures"] = int(
                state.get("consecutive_post_failures", 0)
            ) + 1
            state["last_post_failed_at"] = now
            state["last_post_error"] = json.dumps(resp)[:500]

        save_state(state)
        log(f"sync complete (ok={ok}, confidence={profile.get('confidence')})")
        return 0 if ok else 2

    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            lock_fd.close()
        except (IOError, OSError):
            pass


if __name__ == "__main__":
    sys.exit(main())
