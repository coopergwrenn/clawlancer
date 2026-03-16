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

Runs as a systemd timer every 60 seconds.

Usage:
  python3 ~/scripts/cron-guard.py           # one-shot check
  python3 ~/scripts/cron-guard.py --watch   # continuous (60s interval)
"""

import hashlib
import json
import os
import sys
import time
import urllib.request
import urllib.error

JOBS_PATH = os.path.expanduser("~/.openclaw/cron/jobs.json")
STATE_PATH = os.path.expanduser("~/.openclaw/cron/.cron-guard-state")
API_URL = os.environ.get("INSTACLAW_API_URL", "https://instaclaw.io")
REPORT_ENDPOINT = f"{API_URL}/api/gateway/cron-report"
CHECK_INTERVAL = 60  # seconds


def read_gateway_token() -> str | None:
    """Read GATEWAY_TOKEN from .env files."""
    token = os.environ.get("GATEWAY_TOKEN")
    if token:
        return token

    for env_path in [
        os.path.expanduser("~/.openclaw/.env"),
        os.path.expanduser("~/.env"),
    ]:
        if os.path.exists(env_path):
            with open(env_path, "r") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GATEWAY_TOKEN="):
                        return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def read_cron_jobs() -> list[dict] | None:
    """Read and parse ~/.openclaw/cron/jobs.json."""
    if not os.path.exists(JOBS_PATH):
        return None

    try:
        with open(JOBS_PATH, "r") as f:
            data = json.load(f)

        if isinstance(data, list):
            jobs = data
        elif isinstance(data, dict) and "jobs" in data:
            jobs = data["jobs"]
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
                "name": name,
                "intervalMs": interval_ms,
                "scheduleExpr": schedule_expr,
                "enabled": enabled,
            })

        return result
    except (json.JSONDecodeError, IOError) as e:
        print(f"[cron-guard] Failed to read jobs.json: {e}", file=sys.stderr)
        return None


def estimate_cron_interval(expr: str) -> int:
    """Rough estimate of cron expression interval in ms."""
    parts = expr.strip().split()
    if len(parts) < 5:
        return 3600000  # default 1h if can't parse

    minute_part = parts[0]
    if minute_part == "*":
        return 60000  # every minute
    if "/" in minute_part:
        try:
            step = int(minute_part.split("/")[1])
            return step * 60000
        except (ValueError, IndexError):
            pass
    return 3600000  # default 1h


def compute_jobs_hash(jobs: list[dict]) -> str:
    """Compute a hash of job configs for change detection."""
    normalized = json.dumps(sorted(jobs, key=lambda j: j["name"]), sort_keys=True)
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def read_last_hash() -> str | None:
    """Read the last reported jobs hash."""
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH, "r") as f:
                return f.read().strip()
        except IOError:
            pass
    return None


def write_hash(h: str):
    """Write the current jobs hash."""
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w") as f:
            f.write(h)
    except IOError as e:
        print(f"[cron-guard] Failed to write state: {e}", file=sys.stderr)


def report_to_server(gateway_token: str, jobs: list[dict]) -> dict | None:
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


def apply_actions(actions: list[dict], circuit_breaker_active: bool):
    """Apply server-returned actions to jobs.json."""
    if not os.path.exists(JOBS_PATH):
        return

    try:
        with open(JOBS_PATH, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        return

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

    if modified:
        try:
            with open(JOBS_PATH, "w") as f:
                json.dump(data if not is_list else jobs, f, indent=2)
            print(f"[cron-guard] Updated jobs.json")
        except IOError as e:
            print(f"[cron-guard] Failed to write jobs.json: {e}", file=sys.stderr)


def run_once():
    """Run one guard check cycle."""
    gateway_token = read_gateway_token()
    if not gateway_token:
        print("[cron-guard] No GATEWAY_TOKEN found, skipping", file=sys.stderr)
        return

    jobs = read_cron_jobs()
    if jobs is None:
        return  # No jobs file
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

    apply_actions(actions, circuit_breaker)
    write_hash(current_hash)

    # Summary
    suppressed = sum(1 for a in actions if a.get("action") == "suppress")
    warned = sum(1 for a in actions if a.get("action") == "warn")
    if suppressed or warned or circuit_breaker:
        print(
            f"[cron-guard] Result: {suppressed} suppressed, {warned} warned, "
            f"circuit_breaker={'ACTIVE' if circuit_breaker else 'off'}"
        )


def main():
    import argparse

    parser = argparse.ArgumentParser(description="InstaClaw cron job guardrail monitor")
    parser.add_argument("--watch", action="store_true", help="Run continuously")
    args = parser.parse_args()

    if args.watch:
        print(f"[cron-guard] Watching {JOBS_PATH} (every {CHECK_INTERVAL}s)")
        while True:
            try:
                run_once()
            except Exception as e:
                print(f"[cron-guard] Error: {e}", file=sys.stderr)
            time.sleep(CHECK_INTERVAL)
    else:
        run_once()


if __name__ == "__main__":
    main()
