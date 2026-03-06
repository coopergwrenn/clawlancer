#!/usr/bin/env python3
"""Higgsfield AI Video — Setup & credit management (platform-provided).

Usage:
  python3 higgsfield-setup.py status [--json]
  python3 higgsfield-setup.py credits --type video --model kling-3.0 --duration 5 [--json]
  python3 higgsfield-setup.py test [--json]

Exit codes: 0=OK, 1=FAIL, 2=BLOCK (no gateway token)
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
CHARACTERS_FILE = WORKSPACE_DIR / "characters.json"

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
    """Read GATEWAY_TOKEN (preferred) or legacy MUAPI_API_KEY from ~/.openclaw/.env."""
    return _load_env_var("GATEWAY_TOKEN") or _load_env_var("MUAPI_API_KEY")


def get_base_url() -> str:
    """Get proxy base URL. Platform-provided via INSTACLAW_MUAPI_PROXY."""
    proxy = _load_env_var("INSTACLAW_MUAPI_PROXY")
    if proxy:
        return proxy.rstrip("/") + "/api/gateway/muapi"
    return "https://api.muapi.ai"


def get_credits_url() -> str:
    """Get credits check URL."""
    proxy = _load_env_var("INSTACLAW_MUAPI_PROXY")
    if proxy:
        return proxy.rstrip("/") + "/api/gateway/muapi/credits"
    return None


def proxy_request(url: str, token: str, method: str = "GET", payload: dict | None = None,
                  timeout: int = 30) -> dict:
    """Make a request using gateway token auth."""
    headers = {"x-gateway-token": token, "Content-Type": "application/json"}
    data = json.dumps(payload).encode() if payload else None
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def output(data: dict, as_json: bool = False) -> None:
    if as_json:
        print(json.dumps(data, indent=2))
    else:
        for k, v in data.items():
            print(f"  {k}: {v}")


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_status(args: argparse.Namespace) -> int:
    """Check gateway token status and proxy connectivity."""
    token = load_gateway_token()
    proxy_url = _load_env_var("INSTACLAW_MUAPI_PROXY")
    base = get_base_url()

    result: dict = {
        "skill": "higgsfield-video",
        "mode": "platform-provided",
        "gateway_token_configured": token is not None,
        "proxy_url": proxy_url or "(not set — using direct Muapi)",
        "base_url": base,
        "workspace_exists": WORKSPACE_DIR.exists(),
        "jobs_file_exists": JOBS_FILE.exists(),
        "characters_file_exists": CHARACTERS_FILE.exists(),
    }

    if not token:
        result["error"] = "GATEWAY_TOKEN not found in ~/.openclaw/.env"
        output(result, args.json)
        return 2

    result["gateway_token_preview"] = f"{token[:8]}...{token[-4:]}" if len(token) > 12 else "***"

    # Test proxy connectivity
    credits_url = get_credits_url()
    if credits_url:
        try:
            resp = proxy_request(f"{credits_url}?type=image&model=flux-schnell", token)
            result["proxy_connected"] = True
            result["credits_available"] = resp.get("credits_available", "unknown")
            result["can_generate"] = resp.get("can_generate", "unknown")
        except HTTPError as e:
            result["proxy_connected"] = False
            result["error"] = f"Proxy returned HTTP {e.code}"
        except URLError as e:
            result["proxy_connected"] = False
            result["error"] = f"Cannot reach proxy: {e.reason}"
    else:
        result["proxy_connected"] = "skipped (no proxy URL)"

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
    return 0 if result.get("gateway_token_configured") else 1


def cmd_credits(args: argparse.Namespace) -> int:
    """Pre-generation credit check."""
    token = load_gateway_token()
    if not token:
        print("ERROR: No gateway token configured.", file=sys.stderr)
        return 2

    credits_url = get_credits_url()
    if not credits_url:
        output({"error": "No proxy URL configured — credit checks require platform proxy"}, args.json)
        return 1

    params = f"?type={args.type}"
    if args.model:
        params += f"&model={args.model}"
    if args.duration:
        params += f"&duration={args.duration}"

    try:
        resp = proxy_request(f"{credits_url}{params}", token)
    except HTTPError as e:
        body = ""
        try:
            body = e.read().decode()
        except Exception:
            pass
        output({"error": f"Credit check failed (HTTP {e.code})", "details": body}, args.json)
        return 1
    except URLError as e:
        output({"error": f"Cannot reach proxy: {e.reason}"}, args.json)
        return 1

    output(resp, args.json)
    return 0 if resp.get("can_generate") else 1


def cmd_test(args: argparse.Namespace) -> int:
    """Quick test: generate a Flux Schnell image via proxy."""
    token = load_gateway_token()
    if not token:
        print("ERROR: No gateway token configured.", file=sys.stderr)
        return 2

    base = get_base_url()
    test_endpoint = "/api/v1/generate/image/flux/schnell"
    url = f"{base}{test_endpoint}"

    print("Submitting test image (Flux Schnell) via proxy...")
    try:
        resp = proxy_request(url, token, method="POST", payload={
            "prompt": "a tiny cactus wearing a cowboy hat, pixel art style",
            "image_size": "square",
        })
    except HTTPError as e:
        body = ""
        try:
            body = e.read().decode()
        except Exception:
            pass
        print(f"ERROR: Submit failed (HTTP {e.code}): {body}", file=sys.stderr)
        return 1
    except URLError as e:
        print(f"ERROR: Network error: {e.reason}", file=sys.stderr)
        return 1

    rid = resp.get("request_id") or resp.get("id") or resp.get("data", {}).get("request_id")
    if not rid:
        output({"error": "No request_id in response", "raw": resp}, args.json)
        return 1

    print(f"Request ID: {rid}")
    print("Polling for result...")

    poll_url = f"{base}/api/v1/requests/{rid}"
    for i in range(60):
        time.sleep(2)
        try:
            status_resp = proxy_request(poll_url, token)
        except (HTTPError, URLError):
            continue

        status = (status_resp.get("status") or "").lower()
        if status in ("completed", "succeeded", "done"):
            # Extract output URL
            outputs = status_resp.get("outputs") or status_resp.get("data", {}).get("outputs")
            out_url = None
            if outputs and isinstance(outputs, list) and len(outputs) > 0:
                item = outputs[0]
                out_url = item if isinstance(item, str) else (item.get("url") if isinstance(item, dict) else None)
            if not out_url:
                for key in ("url", "image_url", "video_url"):
                    if status_resp.get(key):
                        out_url = status_resp[key]
                        break

            result = {
                "status": "completed",
                "request_id": rid,
                "output_url": out_url,
                "model": "flux-schnell",
            }
            output(result, args.json)
            print(f"\nTest passed! Image URL: {out_url}")
            return 0
        elif status in ("failed", "error", "cancelled"):
            result = {
                "status": status,
                "request_id": rid,
                "error": status_resp.get("error") or status_resp.get("message") or "Unknown error",
            }
            output(result, args.json)
            return 1
        elif not args.json:
            print(f"  [{i+1}/60] Status: {status or 'processing'}...")

    print("ERROR: Timed out after 2 minutes", file=sys.stderr)
    return 1


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — Setup & Credits")
    sub = parser.add_subparsers(dest="command", required=True)

    p_status = sub.add_parser("status", help="Check gateway token and proxy status")
    p_status.add_argument("--json", action="store_true", help="JSON output")

    p_credits = sub.add_parser("credits", help="Pre-generation credit check")
    p_credits.add_argument("--type", required=True,
                           help="Generation type (video, image, music, sfx, lipsync, effects, extend, upscale, face-swap, translate, style, sync, story)")
    p_credits.add_argument("--model", help="Model name (e.g., kling-3.0, flux-schnell)")
    p_credits.add_argument("--duration", help="Duration in seconds (e.g., 5, 10, 20)")
    p_credits.add_argument("--json", action="store_true", help="JSON output")

    p_test = sub.add_parser("test", help="Quick test (Flux Schnell image via proxy)")
    p_test.add_argument("--json", action="store_true", help="JSON output")

    args = parser.parse_args()
    cmd_map = {"status": cmd_status, "credits": cmd_credits, "test": cmd_test}
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
