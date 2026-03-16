#!/usr/bin/env python3
"""
cron-guard.py — VM-side cron job guardrail monitor.

Watches ~/.openclaw/cron/jobs.json for changes and reports cron configs
to the InstaClaw API. Applies guardrail actions returned by the server:
  - suppress: disables high-frequency crons until user confirms
  - warn: logs a warning (notification sent server-side)
  - ok: no action needed

Also checks for an active circuit breaker (server-side flag) and
disables all cron jobs when it fires.

Runs every 60 seconds via cron (one-shot mode).

Usage:
  python3 ~/scripts/cron-guard.py           # one-shot check
  python3 ~/scripts/cron-guard.py --watch   # continuous (60s interval)
"""

import fcntl
import hashlib
import json
import os
import sys
import tempfile
import time
import urllib.request
import urllib.error

JOBS_PATH = os.path.expanduser("~/.openclaw/cron/jobs.json")
STATE_PATH = os.path.expanduser("~/.openclaw/cron/.cron-guard-state")
LOCK_PATH = os.path.expanduser("~/.openclaw/cron/.cron-guard.lock")
API_URL = os.environ.get("INSTACLAW_API_URL", "https://instaclaw.io")
REPORT_ENDPOINT = f"{API_URL}/api/gateway/cron-report"
CHECK_INTERVAL = 60  # seconds


def acquire_lock():
    """Acquire an exclusive lock to prevent concurrent runs. Returns lock fd or None."""
    try:
        os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
        fd = open(LOCK_PATH, "w")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (IOError, OSError):
        return None


def release_lock(fd):
    """Release the exclusive lock."""
    if fd:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()
        except (IOError, OSError):
            pass


def read_gateway_token():
    """Read GATEWAY_TOKEN from .env files."""
    token = os.environ.get("GATEWAY_TOKEN")
    if token:
        return token

    for env_path in [
        os.path.expanduser("~/.openclaw/.env"),
        os.path.expanduser("~/.env"),
    ]:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("GATEWAY_TOKEN="):
                            return line.split("=", 1)[1].strip().strip('"').strip("'")
            except IOError:
                pass
    return None


def read_cron_jobs():
    """Read and parse ~/.openclaw/cron/jobs.json. Returns list or None."""
    if not os.path.exists(JOBS_PATH):
        return None

    try:
        with open(JOBS_PATH, "r") as f:
            raw = f.read()

        if not raw.strip():
            return []

        data = json.loads(raw)

        if isinstance(data, list):
            jobs = data
        elif isinstance(data, dict) and "jobs" in data:
            jobs = data["jobs"]
        elif isinstance(data, dict):
            return []
        else:
            return []

        result = []
        for job in jobs:
            if not isinstance(job, dict):
                continue
            name = job.get("name", job.get("id", "unknown"))
            enabled = job.get("enabled", True)

            # Parse interval
            interval_ms = 0
            schedule = job.get("schedule", {})
            if isinstance(schedule, dict):
                interval_ms = schedule.get("everyMs", 0)
            elif isinstance(schedule, str):
                # cron expression — estimate interval
                interval_ms = estimate_cron_interval(schedule)

            # Also check top-level everyMs
            if interval_ms == 0 and "everyMs" in job:
                interval_ms = job["everyMs"]

            schedule_expr = None
            if isinstance(schedule, dict) and "expr" in schedule:
                schedule_expr = schedule["expr"]
            elif isinstance(schedule, str):
                schedule_expr = schedule

            result.append({
                "name": str(name),
                "intervalMs": int(interval_ms) if interval_ms else 0,
                "scheduleExpr": schedule_expr,
                "enabled": bool(enabled),
            })

        return result
    except json.JSONDecodeError as e:
        print(f"[cron-guard] Corrupt jobs.json: {e}", file=sys.stderr)
        return None
    except IOError as e:
        print(f"[cron-guard] Failed to read jobs.json: {e}", file=sys.stderr)
        return None


def estimate_cron_interval(expr):
    """Estimate cron expression interval in ms. Conservative (errs toward longer intervals)."""
    parts = expr.strip().split()
    if len(parts) < 5:
        return 3600000  # default 1h if can't parse

    minute_part = parts[0]
    hour_part = parts[1]
    dom_part = parts[2]
    month_part = parts[3]
    dow_part = parts[4]

    # If specific days of week → at least daily
    if dow_part not in ("*", "*/1"):
        return 86400000  # daily (conservative)

    # If specific day of month → at least daily
    if dom_part not in ("*", "*/1"):
        return 86400000

    # If specific month → very infrequent
    if month_part not in ("*", "*/1"):
        return 86400000 * 30

    # Hour field
    if hour_part == "*":
        # Runs every hour (at least), check minute field
        if minute_part == "*":
            return 60000  # every minute
        if "/" in minute_part:
            try:
                step = int(minute_part.split("/")[1])
                return step * 60000
            except (ValueError, IndexError):
                pass
        # Specific minute(s) — runs once per hour at that minute
        return 3600000
    elif "/" in hour_part:
        try:
            step = int(hour_part.split("/")[1])
            return step * 3600000
        except (ValueError, IndexError):
            return 3600000
    else:
        # Specific hour(s) — count them
        hours = [h for h in hour_part.split(",") if h.strip()]
        if len(hours) <= 1:
            return 86400000  # once a day
        return 86400000 // len(hours)  # rough estimate


def compute_jobs_hash(jobs):
    """Compute a hash of job configs for change detection."""
    normalized = json.dumps(
        sorted(jobs, key=lambda j: j.get("name", "")), sort_keys=True
    )
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def read_last_hash():
    """Read the last reported jobs hash."""
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH, "r") as f:
                return f.read().strip()
        except IOError:
            pass
    return None


def write_hash(h):
    """Write the current jobs hash."""
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w") as f:
            f.write(h)
    except IOError as e:
        print(f"[cron-guard] Failed to write state: {e}", file=sys.stderr)


def report_to_server(gateway_token, jobs):
    """POST cron job configs to InstaClaw API and get back actions."""
    payload = json.dumps({"jobs": jobs}).encode()

    req = urllib.request.Request(
        REPORT_ENDPOINT,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Gateway-Token": gateway_token,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"[cron-guard] API error {e.code}: {body[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[cron-guard] API request failed: {e}", file=sys.stderr)
        return None


def write_jobs_atomic(data, is_list, jobs):
    """Atomically write jobs.json using temp file + rename."""
    content = data if not is_list else jobs
    jobs_dir = os.path.dirname(JOBS_PATH)
    try:
        fd, tmp_path = tempfile.mkstemp(dir=jobs_dir, suffix=".tmp", prefix=".cron-guard-")
        with os.fdopen(fd, "w") as f:
            json.dump(content, f, indent=2)
        os.replace(tmp_path, JOBS_PATH)
        return True
    except (IOError, OSError) as e:
        print(f"[cron-guard] Failed to write jobs.json: {e}", file=sys.stderr)
        # Clean up temp file if it exists
        try:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except OSError:
            pass
        return False


def apply_actions(actions, circuit_breaker_active):
    """Apply server-returned actions to jobs.json. Returns True if write succeeded."""
    if not os.path.exists(JOBS_PATH):
        return True  # nothing to do

    try:
        with open(JOBS_PATH, "r") as f:
            raw = f.read()
        if not raw.strip():
            return True
        data = json.loads(raw)
    except (json.JSONDecodeError, IOError):
        return False

    is_list = isinstance(data, list)
    jobs = data if is_list else data.get("jobs", [])
    modified = False

    # Build action map
    action_map = {a["name"]: a for a in actions}

    # Circuit breaker: disable ALL cron jobs
    if circuit_breaker_active:
        for job in jobs:
            name = job.get("name", job.get("id", ""))
            if job.get("enabled", True):
                job["enabled"] = False
                job["_cron_guard_paused"] = True
                modified = True
                print(f"[cron-guard] Circuit breaker: paused '{name}'")
    else:
        for job in jobs:
            name = job.get("name", job.get("id", ""))
            action = action_map.get(name)

            if action and action.get("action") == "suppress":
                # Disable this job until user confirms
                if job.get("enabled", True):
                    job["enabled"] = False
                    job["_cron_guard_suppressed"] = True
                    modified = True
                    print(f"[cron-guard] Suppressed '{name}': {action.get('reason', '')}")
            elif job.get("_cron_guard_paused"):
                # Circuit breaker was cleared — re-enable previously paused jobs
                job["enabled"] = True
                del job["_cron_guard_paused"]
                modified = True
                print(f"[cron-guard] Resumed '{name}' (circuit breaker cleared)")
            elif job.get("_cron_guard_suppressed") and action and action.get("action") == "ok":
                # Job was suppressed but is now confirmed — re-enable
                job["enabled"] = True
                del job["_cron_guard_suppressed"]
                modified = True
                print(f"[cron-guard] Re-enabled '{name}' (confirmed)")

    # Cleanup pass: remove stale _cron_guard_* markers from jobs that are
    # in a clean state. Don't leave internal markers in the user's config file.
    for job in jobs:
        if job.get("enabled", True):
            # Job is enabled — no markers should remain
            if "_cron_guard_suppressed" in job:
                del job["_cron_guard_suppressed"]
                modified = True
            if "_cron_guard_paused" in job:
                del job["_cron_guard_paused"]
                modified = True

    if modified:
        return write_jobs_atomic(data, is_list, jobs)
    return True


def run_once():
    """Run one guard check cycle."""
    gateway_token = read_gateway_token()
    if not gateway_token:
        return

    jobs = read_cron_jobs()
    if jobs is None:
        return  # No jobs file or corrupt
    if len(jobs) == 0:
        return  # No cron jobs configured

    # Check if jobs changed since last report
    current_hash = compute_jobs_hash(jobs)
    last_hash = read_last_hash()

    # Always report on first run or when jobs change
    # Also report every 10 minutes even if unchanged (circuit breaker check)
    should_report = (
        current_hash != last_hash
        or last_hash is None
        or not os.path.exists(STATE_PATH)
    )

    if not should_report:
        # Check file age for periodic re-report
        try:
            age = time.time() - os.path.getmtime(STATE_PATH)
            if age > 600:  # 10 minutes
                should_report = True
        except OSError:
            should_report = True

    if not should_report:
        return

    print(f"[cron-guard] Reporting {len(jobs)} cron jobs to server")
    response = report_to_server(gateway_token, jobs)
    if not response:
        return

    actions = response.get("actions", [])
    circuit_breaker = response.get("circuitBreakerActive", False)

    write_ok = apply_actions(actions, circuit_breaker)

    # Only save hash if apply succeeded — retry on next cycle otherwise
    if write_ok:
        write_hash(current_hash)

    # Summary
    suppressed = sum(1 for a in actions if a.get("action") == "suppress")
    warned = sum(1 for a in actions if a.get("action") == "warn")
    if suppressed or warned or circuit_breaker:
        print(
            f"[cron-guard] Result: {suppressed} suppressed, {warned} warned, "
            f"circuit_breaker={'ACTIVE' if circuit_breaker else 'off'}"
        )
    else:
        print(f"[cron-guard] All {len(actions)} jobs OK")


def main():
    import argparse

    parser = argparse.ArgumentParser(description="InstaClaw cron job guardrail monitor")
    parser.add_argument("--watch", action="store_true", help="Run continuously")
    args = parser.parse_args()

    if args.watch:
        print(f"[cron-guard] Watching {JOBS_PATH} (every {CHECK_INTERVAL}s)")
        while True:
            lock_fd = acquire_lock()
            if lock_fd is None:
                print("[cron-guard] Another instance running, skipping", file=sys.stderr)
                time.sleep(CHECK_INTERVAL)
                continue
            try:
                run_once()
            except Exception as e:
                print(f"[cron-guard] Error: {e}", file=sys.stderr)
            finally:
                release_lock(lock_fd)
            time.sleep(CHECK_INTERVAL)
    else:
        # One-shot mode via cron — acquire lock to prevent overlap
        lock_fd = acquire_lock()
        if lock_fd is None:
            sys.exit(0)  # Another instance running, silently exit
        try:
            run_once()
        except Exception as e:
            print(f"[cron-guard] Error: {e}", file=sys.stderr)
        finally:
            release_lock(lock_fd)


if __name__ == "__main__":
    main()
