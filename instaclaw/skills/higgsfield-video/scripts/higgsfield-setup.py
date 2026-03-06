#!/usr/bin/env python3
"""Higgsfield AI Video — API key management via Muapi.ai.

Usage:
  python3 higgsfield-setup.py setup --key <MUAPI_API_KEY>
  python3 higgsfield-setup.py status [--json]
  python3 higgsfield-setup.py test [--json]

Exit codes: 0=OK, 1=FAIL, 2=BLOCK (missing key)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── Constants ──────────────────────────────────────────────────────────────────
ENV_FILE = Path.home() / ".openclaw" / ".env"
WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace" / "higgsfield"
JOBS_FILE = WORKSPACE_DIR / "jobs.json"
CHARACTERS_FILE = WORKSPACE_DIR / "characters.json"
MUAPI_BASE = "https://api.muapi.ai"
TEST_ENDPOINT = "/api/v1/generate/image/flux/schnell"

# ── Helpers ────────────────────────────────────────────────────────────────────

def load_api_key() -> str | None:
    """Read MUAPI_API_KEY from ~/.openclaw/.env."""
    if not ENV_FILE.exists():
        return None
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line.startswith("MUAPI_API_KEY="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            return val if val else None
    return None


def save_api_key(key: str) -> None:
    """Write or update MUAPI_API_KEY in ~/.openclaw/.env."""
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    found = False
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.strip().startswith("MUAPI_API_KEY="):
                lines.append(f"MUAPI_API_KEY={key}")
                found = True
            else:
                lines.append(line)
    if not found:
        lines.append(f"MUAPI_API_KEY={key}")
    ENV_FILE.write_text("\n".join(lines) + "\n")


def muapi_request(endpoint: str, api_key: str, payload: dict | None = None,
                  method: str = "POST", timeout: int = 30) -> dict:
    """Make a request to Muapi.ai with x-api-key header."""
    url = f"{MUAPI_BASE}{endpoint}"
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }
    data = json.dumps(payload).encode() if payload else None
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def extract_request_id(resp: dict) -> str | None:
    """Normalize request ID from submit response."""
    return resp.get("request_id") or resp.get("id") or resp.get("data", {}).get("request_id")


def extract_output_url(resp: dict) -> str | None:
    """Normalize output URL from poll response."""
    # Try outputs array first
    outputs = resp.get("outputs") or resp.get("data", {}).get("outputs")
    if outputs and isinstance(outputs, list) and len(outputs) > 0:
        item = outputs[0]
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return item.get("url") or item.get("video_url") or item.get("image_url")
    # Try direct url fields
    for key in ("url", "video_url", "image_url"):
        if resp.get(key):
            return resp[key]
    # Try nested output
    output = resp.get("output") or resp.get("data", {}).get("output")
    if isinstance(output, dict):
        return output.get("url") or output.get("video_url") or output.get("image_url")
    # Try video.url
    video = resp.get("video")
    if isinstance(video, dict):
        return video.get("url")
    return None


def output(data: dict, as_json: bool = False) -> None:
    """Dual-mode output."""
    if as_json:
        print(json.dumps(data, indent=2))
    else:
        for k, v in data.items():
            print(f"  {k}: {v}")


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_setup(args: argparse.Namespace) -> int:
    """Store Muapi API key."""
    key = args.key.strip()
    if not key:
        print("ERROR: API key cannot be empty", file=sys.stderr)
        return 1

    # Validate the key by hitting the test endpoint
    print("Validating API key...")
    try:
        resp = muapi_request(TEST_ENDPOINT, key, {
            "prompt": "test validation",
            "image_size": "square",
        })
        rid = extract_request_id(resp)
        if not rid:
            print("WARNING: Key accepted but no request_id returned. Saving anyway.")
    except HTTPError as e:
        if e.code in (401, 403):
            print(f"ERROR: Invalid API key (HTTP {e.code})", file=sys.stderr)
            return 1
        # Other errors might be rate limits or server issues — key format may still be valid
        print(f"WARNING: Validation request failed (HTTP {e.code}), saving key anyway.")
    except URLError as e:
        print(f"WARNING: Could not reach Muapi.ai ({e.reason}), saving key anyway.")

    save_api_key(key)

    # Create workspace directories
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"API key saved to {ENV_FILE}")
    print("Higgsfield AI Video is ready. Restart your gateway to activate.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """Check API key status and validate."""
    key = load_api_key()
    result: dict = {
        "skill": "higgsfield-video",
        "api_key_configured": key is not None,
        "api_key_valid": False,
        "workspace_exists": WORKSPACE_DIR.exists(),
        "jobs_file_exists": JOBS_FILE.exists(),
        "characters_file_exists": CHARACTERS_FILE.exists(),
    }

    if not key:
        result["error"] = "MUAPI_API_KEY not found in ~/.openclaw/.env"
        output(result, args.json)
        return 2

    result["api_key_preview"] = f"{key[:8]}...{key[-4:]}" if len(key) > 12 else "***"

    # Validate key
    try:
        resp = muapi_request(TEST_ENDPOINT, key, {
            "prompt": "status check",
            "image_size": "square",
        })
        rid = extract_request_id(resp)
        result["api_key_valid"] = True
        if rid:
            result["test_request_id"] = rid
    except HTTPError as e:
        if e.code in (401, 403):
            result["api_key_valid"] = False
            result["error"] = f"API key rejected (HTTP {e.code})"
        else:
            result["api_key_valid"] = "unknown"
            result["warning"] = f"Could not validate (HTTP {e.code})"
    except URLError as e:
        result["api_key_valid"] = "unknown"
        result["warning"] = f"Could not reach Muapi.ai: {e.reason}"

    # Count jobs and characters
    if JOBS_FILE.exists():
        try:
            jobs = json.loads(JOBS_FILE.read_text())
            result["total_jobs"] = len(jobs)
        except Exception:
            result["total_jobs"] = "error reading file"
    if CHARACTERS_FILE.exists():
        try:
            chars = json.loads(CHARACTERS_FILE.read_text())
            result["total_characters"] = len(chars)
        except Exception:
            result["total_characters"] = "error reading file"

    output(result, args.json)
    return 0 if result.get("api_key_valid") is True else 1


def cmd_test(args: argparse.Namespace) -> int:
    """Quick test: generate a Flux Schnell image."""
    key = load_api_key()
    if not key:
        print("ERROR: No API key configured. Run: python3 higgsfield-setup.py setup --key YOUR_KEY",
              file=sys.stderr)
        return 2

    print("Submitting test image (Flux Schnell)...")
    try:
        resp = muapi_request(TEST_ENDPOINT, key, {
            "prompt": "a tiny cactus wearing a cowboy hat, pixel art style",
            "image_size": "square",
        })
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, 'read') else ""
        print(f"ERROR: Submit failed (HTTP {e.code}): {body}", file=sys.stderr)
        return 1
    except URLError as e:
        print(f"ERROR: Network error: {e.reason}", file=sys.stderr)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id in response", "raw": resp}, args.json)
        return 1

    print(f"Request ID: {rid}")
    print("Polling for result...")

    # Poll up to 60 attempts × 2s = 2 min
    poll_endpoint = f"/api/v1/requests/{rid}"
    for i in range(60):
        time.sleep(2)
        try:
            status_resp = muapi_request(poll_endpoint, key, method="GET")
        except HTTPError:
            continue
        except URLError:
            continue

        status = status_resp.get("status", "").lower()
        if status in ("completed", "succeeded", "done"):
            url = extract_output_url(status_resp)
            result = {
                "status": "completed",
                "request_id": rid,
                "output_url": url,
                "model": "flux-schnell",
            }
            output(result, args.json)
            print(f"\nTest passed! Image URL: {url}")
            return 0
        elif status in ("failed", "error", "cancelled"):
            result = {
                "status": status,
                "request_id": rid,
                "error": status_resp.get("error") or status_resp.get("message") or "Unknown error",
            }
            output(result, args.json)
            return 1
        else:
            if not args.json:
                print(f"  [{i+1}/60] Status: {status or 'processing'}...")

    print("ERROR: Timed out after 2 minutes", file=sys.stderr)
    return 1


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — API Key Management")
    sub = parser.add_subparsers(dest="command", required=True)

    p_setup = sub.add_parser("setup", help="Store Muapi API key")
    p_setup.add_argument("--key", required=True, help="Your Muapi.ai API key")

    p_status = sub.add_parser("status", help="Check API key status")
    p_status.add_argument("--json", action="store_true", help="JSON output")

    p_test = sub.add_parser("test", help="Quick test (Flux Schnell image)")
    p_test.add_argument("--json", action="store_true", help="JSON output")

    args = parser.parse_args()
    cmd_map = {"setup": cmd_setup, "status": cmd_status, "test": cmd_test}
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
