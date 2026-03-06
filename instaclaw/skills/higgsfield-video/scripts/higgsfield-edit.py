#!/usr/bin/env python3
"""Higgsfield AI Video — Video editing tools.

Usage:
  python3 higgsfield-edit.py effects --video <url> --effect <name> [--json]
  python3 higgsfield-edit.py extend --video <url> --prompt "..." [--json]
  python3 higgsfield-edit.py translate --video <url> --target-lang <lang> [--json]
  python3 higgsfield-edit.py style --video <url> --style "..." [--json]
  python3 higgsfield-edit.py upscale --video <url> [--json]
  python3 higgsfield-edit.py face-swap --video <url> --face-image <url> [--json]

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
MUAPI_BASE = "https://api.muapi.ai"

EFFECTS_ENDPOINT = "/api/v1/generate/video/effects"
EXTEND_ENDPOINT = "/api/v1/generate/video/extend"
TRANSLATE_ENDPOINT = "/api/v1/generate/video/translate"
STYLE_ENDPOINT = "/api/v1/generate/video/style-transfer"
UPSCALE_ENDPOINT = "/api/v1/generate/video/upscale"
FACE_SWAP_ENDPOINT = "/api/v1/generate/video/face-swap"

POLL_MAX = 120
POLL_INTERVAL = 2
MAX_RETRIES = 3
RETRY_DELAYS = [5, 15, 45]

# ── Helpers ────────────────────────────────────────────────────────────────────

def load_api_key() -> str | None:
    if not ENV_FILE.exists():
        return None
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line.startswith("MUAPI_API_KEY="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            return val if val else None
    return None


def muapi_request(endpoint: str, api_key: str, payload: dict | None = None,
                  method: str = "POST", timeout: int = 30) -> dict:
    url = f"{MUAPI_BASE}{endpoint}"
    headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    data = json.dumps(payload).encode() if payload else None
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def extract_request_id(resp: dict) -> str | None:
    return resp.get("request_id") or resp.get("id") or resp.get("data", {}).get("request_id")


def extract_output_url(resp: dict) -> str | None:
    outputs = resp.get("outputs") or resp.get("data", {}).get("outputs")
    if outputs and isinstance(outputs, list) and len(outputs) > 0:
        item = outputs[0]
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return item.get("url") or item.get("video_url")
    for key in ("url", "video_url"):
        if resp.get(key):
            return resp[key]
    output_obj = resp.get("output") or resp.get("data", {}).get("output")
    if isinstance(output_obj, dict):
        return output_obj.get("url") or output_obj.get("video_url")
    video = resp.get("video")
    if isinstance(video, dict):
        return video.get("url")
    return None


def submit_with_retry(endpoint: str, api_key: str, payload: dict) -> dict:
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            return muapi_request(endpoint, api_key, payload)
        except HTTPError as e:
            last_error = e
            if e.code in (401, 403):
                raise
            if e.code == 429 or e.code >= 500:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAYS[attempt])
                continue
            raise
        except URLError as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAYS[attempt])
    raise last_error


def poll_for_result(request_id: str, api_key: str, as_json: bool = False) -> dict:
    poll_endpoint = f"/api/v1/requests/{request_id}"
    for i in range(POLL_MAX):
        time.sleep(POLL_INTERVAL)
        try:
            resp = muapi_request(poll_endpoint, api_key, method="GET")
        except (HTTPError, URLError):
            continue
        status = (resp.get("status") or "").lower()
        if status in ("completed", "succeeded", "done"):
            url = extract_output_url(resp)
            return {"status": "completed", "request_id": request_id, "output_url": url}
        elif status in ("failed", "error", "cancelled"):
            return {"status": status, "request_id": request_id,
                    "error": resp.get("error") or resp.get("message") or "Failed"}
        elif not as_json and i % 5 == 0:
            print(f"  [{(i+1)*POLL_INTERVAL}s] Status: {status or 'processing'}...")
    return {"status": "timeout", "request_id": request_id, "error": "Timed out"}


def save_job(job: dict) -> None:
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    jobs = []
    if JOBS_FILE.exists():
        try:
            jobs = json.loads(JOBS_FILE.read_text())
        except Exception:
            pass
    jobs.append(job)
    if len(jobs) > 200:
        jobs = jobs[-200:]
    JOBS_FILE.write_text(json.dumps(jobs, indent=2))


def output(data: dict, as_json: bool = False) -> None:
    if as_json:
        print(json.dumps(data, indent=2))
    else:
        for k, v in data.items():
            print(f"  {k}: {v}")


def generic_edit_cmd(endpoint: str, edit_type: str, payload: dict,
                     api_key: str, as_json: bool) -> int:
    """Shared submit → poll → output flow for edit commands."""
    if not as_json:
        print(f"Submitting {edit_type}...")

    try:
        resp = submit_with_retry(endpoint, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, as_json)
        return 1
    except URLError as e:
        output({"error": f"Network error: {e.reason}"}, as_json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id", "raw": str(resp)[:500]}, as_json)
        return 1

    save_job({"request_id": rid, "type": edit_type,
              "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    result = poll_for_result(rid, api_key, as_json)
    result["type"] = edit_type
    output(result, as_json)
    return 0 if result["status"] == "completed" else 1


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_effects(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2
    payload = {"video_url": args.video, "effect": args.effect}
    if args.intensity:
        payload["intensity"] = args.intensity
    return generic_edit_cmd(EFFECTS_ENDPOINT, "effects", payload, api_key, args.json)


def cmd_extend(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2
    payload: dict = {"video_url": args.video}
    if args.prompt:
        payload["prompt"] = args.prompt
    if args.duration:
        payload["duration"] = args.duration
    return generic_edit_cmd(EXTEND_ENDPOINT, "extend", payload, api_key, args.json)


def cmd_translate(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2
    payload = {"video_url": args.video, "target_language": args.target_lang}
    return generic_edit_cmd(TRANSLATE_ENDPOINT, "translate", payload, api_key, args.json)


def cmd_style(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2
    payload: dict = {"video_url": args.video, "style": args.style}
    if args.ref_image:
        payload["ref_image_url"] = args.ref_image
    return generic_edit_cmd(STYLE_ENDPOINT, "style-transfer", payload, api_key, args.json)


def cmd_upscale(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2
    payload: dict = {"video_url": args.video}
    if args.target_resolution:
        payload["target_resolution"] = args.target_resolution
    return generic_edit_cmd(UPSCALE_ENDPOINT, "upscale", payload, api_key, args.json)


def cmd_face_swap(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2
    payload = {"video_url": args.video, "face_image_url": args.face_image}
    return generic_edit_cmd(FACE_SWAP_ENDPOINT, "face-swap", payload, api_key, args.json)


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — Editing Tools")
    sub = parser.add_subparsers(dest="command", required=True)

    p_fx = sub.add_parser("effects", help="Apply video effects")
    p_fx.add_argument("--video", required=True, help="Video URL")
    p_fx.add_argument("--effect", required=True, help="Effect name")
    p_fx.add_argument("--intensity", help="Effect intensity (0-1)")
    p_fx.add_argument("--json", action="store_true")

    p_ext = sub.add_parser("extend", help="Extend video duration")
    p_ext.add_argument("--video", required=True, help="Video URL")
    p_ext.add_argument("--prompt", help="Continuation prompt")
    p_ext.add_argument("--duration", help="Additional duration")
    p_ext.add_argument("--json", action="store_true")

    p_tr = sub.add_parser("translate", help="Translate video dialogue")
    p_tr.add_argument("--video", required=True, help="Video URL")
    p_tr.add_argument("--target-lang", required=True, help="Target language")
    p_tr.add_argument("--json", action="store_true")

    p_st = sub.add_parser("style", help="Style transfer on video")
    p_st.add_argument("--video", required=True, help="Video URL")
    p_st.add_argument("--style", required=True, help="Style description")
    p_st.add_argument("--ref-image", help="Style reference image URL")
    p_st.add_argument("--json", action="store_true")

    p_up = sub.add_parser("upscale", help="Upscale video resolution")
    p_up.add_argument("--video", required=True, help="Video URL")
    p_up.add_argument("--target-resolution", help="Target resolution (e.g., 4k)")
    p_up.add_argument("--json", action="store_true")

    p_fs = sub.add_parser("face-swap", help="Swap face in video")
    p_fs.add_argument("--video", required=True, help="Video URL")
    p_fs.add_argument("--face-image", required=True, help="Face image URL")
    p_fs.add_argument("--json", action="store_true")

    args = parser.parse_args()
    cmd_map = {
        "effects": cmd_effects, "extend": cmd_extend, "translate": cmd_translate,
        "style": cmd_style, "upscale": cmd_upscale, "face-swap": cmd_face_swap,
    }
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
