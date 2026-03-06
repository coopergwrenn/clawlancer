#!/usr/bin/env python3
"""Higgsfield AI Video — Job tracking and status.

Usage:
  python3 higgsfield-status.py check --id <request_id> [--json]
  python3 higgsfield-status.py active [--json]
  python3 higgsfield-status.py history [--limit N] [--json]

Exit codes: 0=OK, 1=FAIL, 2=BLOCK
"""

import argparse
import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── Constants ──────────────────────────────────────────────────────────────────
ENV_FILE = Path.home() / ".openclaw" / ".env"
WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace" / "higgsfield"
JOBS_FILE = WORKSPACE_DIR / "jobs.json"

# ── Helpers ────────────────────────────────────────────────────────────────────

def _load_env_var(key: str) -> str | None:
    if not ENV_FILE.exists():
        return None
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line.startswith(f"{key}="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            return val if val else None
    return None


def load_gateway_token() -> str | None:
    return _load_env_var("GATEWAY_TOKEN") or _load_env_var("MUAPI_API_KEY")


def get_base_url() -> str:
    proxy = _load_env_var("INSTACLAW_MUAPI_PROXY")
    if proxy:
        return proxy.rstrip("/") + "/api/gateway/muapi"
    return "https://api.muapi.ai"


def muapi_request(endpoint: str, api_key: str, method: str = "GET", timeout: int = 30) -> dict:
    base = get_base_url()
    url = f"{base}{endpoint}"
    if "instaclaw" in base.lower():
        headers = {"x-gateway-token": api_key, "Content-Type": "application/json"}
    else:
        headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    req = Request(url, headers=headers, method=method)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def extract_output_url(resp: dict) -> str | None:
    """5-level fallback for output URL extraction."""
    outputs = resp.get("outputs") or resp.get("data", {}).get("outputs")
    if outputs and isinstance(outputs, list) and len(outputs) > 0:
        item = outputs[0]
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return item.get("url") or item.get("video_url") or item.get("image_url") or item.get("audio_url")
    for key in ("url", "video_url", "image_url", "audio_url"):
        if resp.get(key):
            return resp[key]
    output_obj = resp.get("output") or resp.get("data", {}).get("output")
    if isinstance(output_obj, dict):
        return output_obj.get("url")
    video = resp.get("video")
    if isinstance(video, dict):
        return video.get("url")
    image = resp.get("image")
    if isinstance(image, dict):
        return image.get("url")
    return None


def load_jobs() -> list[dict]:
    if not JOBS_FILE.exists():
        return []
    try:
        return json.loads(JOBS_FILE.read_text())
    except Exception:
        return []


def save_jobs(jobs: list[dict]) -> None:
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_FILE.write_text(json.dumps(jobs, indent=2))


def output(data, as_json: bool = False) -> None:
    if as_json:
        print(json.dumps(data, indent=2))
    elif isinstance(data, dict):
        for k, v in data.items():
            print(f"  {k}: {v}")
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                for k, v in item.items():
                    print(f"  {k}: {v}")
                print()


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_check(args: argparse.Namespace) -> int:
    """Check status of a specific request."""
    api_key = load_gateway_token()
    if not api_key:
        print("ERROR: No gateway token configured.", file=sys.stderr)
        return 2

    try:
        resp = muapi_request(f"/api/v1/predictions/{args.id}/result", api_key)
    except HTTPError as e:
        output({"error": f"Status check failed (HTTP {e.code})", "request_id": args.id}, args.json)
        return 1
    except URLError as e:
        output({"error": f"Network error: {e.reason}", "request_id": args.id}, args.json)
        return 1

    status = (resp.get("status") or "").lower()
    url = extract_output_url(resp)
    result = {"request_id": args.id, "status": status}
    if url:
        result["output_url"] = url
    if resp.get("error"):
        result["error"] = resp["error"]
    if resp.get("created_at"):
        result["created_at"] = resp["created_at"]

    # Update local job record
    jobs = load_jobs()
    for job in jobs:
        if job.get("request_id") == args.id:
            job["status"] = status
            if url:
                job["output_url"] = url
            break
    save_jobs(jobs)

    output(result, args.json)
    return 0 if status in ("completed", "succeeded", "success") else 1


def cmd_active(args: argparse.Namespace) -> int:
    """List active (processing) jobs."""
    api_key = load_gateway_token()
    jobs = load_jobs()
    active = [j for j in jobs if j.get("status") in ("processing", "pending", "submitted", None)]

    if not active:
        output({"status": "none", "message": "No active jobs."}, args.json)
        return 0

    # Check each active job's current status
    updated_active = []
    for job in active:
        rid = job.get("request_id")
        if rid and api_key:
            try:
                resp = muapi_request(f"/api/v1/predictions/{rid}/result", api_key)
                status = (resp.get("status") or "").lower()
                job["status"] = status
                url = extract_output_url(resp)
                if url:
                    job["output_url"] = url
                if status not in ("completed", "succeeded", "success", "failed", "error", "cancelled"):
                    updated_active.append(job)
            except (HTTPError, URLError):
                updated_active.append(job)
        else:
            updated_active.append(job)

    save_jobs(jobs)

    if args.json:
        print(json.dumps(updated_active, indent=2))
    else:
        print(f"Active jobs ({len(updated_active)}):\n")
        for job in updated_active:
            print(f"  ID: {job.get('request_id', 'unknown')}")
            print(f"  Type: {job.get('type', 'unknown')}")
            print(f"  Model: {job.get('model', 'unknown')}")
            print(f"  Status: {job.get('status', 'unknown')}")
            if job.get("prompt"):
                print(f"  Prompt: {job['prompt'][:60]}...")
            print()

    return 0


def cmd_history(args: argparse.Namespace) -> int:
    """Show job history."""
    jobs = load_jobs()
    limit = args.limit or 20
    recent = jobs[-limit:] if len(jobs) > limit else jobs
    recent.reverse()  # Most recent first

    if args.json:
        print(json.dumps(recent, indent=2))
    else:
        if not recent:
            print("No jobs in history.")
            return 0
        print(f"Job history (last {len(recent)}):\n")
        for job in recent:
            status_icon = {"completed": "+", "failed": "X", "processing": "~"}.get(
                job.get("status", ""), "?")
            print(f"  [{status_icon}] {job.get('request_id', 'unknown')[:16]}...")
            print(f"      Type: {job.get('type', '?')} | Model: {job.get('model', '?')}")
            if job.get("output_url"):
                print(f"      URL: {job['output_url'][:60]}...")
            if job.get("submitted_at"):
                print(f"      Time: {job['submitted_at']}")
            print()

    return 0


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — Job Status")
    sub = parser.add_subparsers(dest="command", required=True)

    p_check = sub.add_parser("check", help="Check request status")
    p_check.add_argument("--id", required=True, help="Request ID")
    p_check.add_argument("--json", action="store_true")

    p_active = sub.add_parser("active", help="List active jobs")
    p_active.add_argument("--json", action="store_true")

    p_hist = sub.add_parser("history", help="Show job history")
    p_hist.add_argument("--limit", type=int, help="Number of jobs (default 20)")
    p_hist.add_argument("--json", action="store_true")

    args = parser.parse_args()
    cmd_map = {"check": cmd_check, "active": cmd_active, "history": cmd_history}
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
