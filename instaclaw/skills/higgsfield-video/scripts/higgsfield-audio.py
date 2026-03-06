#!/usr/bin/env python3
"""Higgsfield AI Video — Audio generation (music, SFX, sync, lip-sync).

Usage:
  python3 higgsfield-audio.py music --prompt "..." [--model suno] [--json]
  python3 higgsfield-audio.py sfx --prompt "..." [--json]
  python3 higgsfield-audio.py sync --video <url> [--json]
  python3 higgsfield-audio.py lipsync --video <url> --audio <url> [--json]

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

MUSIC_ENDPOINTS = {
    "suno": "/api/v1/generate/audio/suno",
    "suno-v4": "/api/v1/generate/audio/suno/v4",
}

SFX_ENDPOINT = "/api/v1/generate/audio/mmaudio"
SYNC_ENDPOINT = "/api/v1/generate/audio/video-to-audio"
LIPSYNC_ENDPOINT = "/api/v1/generate/video/lipsync"

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
            return item.get("url") or item.get("audio_url") or item.get("video_url")
    for key in ("url", "audio_url", "video_url"):
        if resp.get(key):
            return resp[key]
    output_obj = resp.get("output") or resp.get("data", {}).get("output")
    if isinstance(output_obj, dict):
        return output_obj.get("url") or output_obj.get("audio_url")
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
                    delay = RETRY_DELAYS[attempt]
                    print(f"  Retry {attempt+1}/{MAX_RETRIES} in {delay}s...", file=sys.stderr)
                    time.sleep(delay)
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


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_music(args: argparse.Namespace) -> int:
    """Generate music from prompt."""
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    model = args.model or "suno"
    endpoint = MUSIC_ENDPOINTS.get(model)
    if not endpoint:
        print(f"ERROR: Unknown music model '{model}'. Available: {', '.join(MUSIC_ENDPOINTS.keys())}",
              file=sys.stderr)
        return 1

    payload: dict = {"prompt": args.prompt}
    if args.duration:
        payload["duration"] = args.duration
    if args.instrumental:
        payload["instrumental"] = True
    if args.style:
        payload["style"] = args.style

    if not args.json:
        print(f"Generating music ({model})...")

    try:
        resp = submit_with_retry(endpoint, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, args.json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id", "raw": str(resp)[:500]}, args.json)
        return 1

    save_job({"request_id": rid, "type": "music", "model": model, "prompt": args.prompt,
              "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    result = poll_for_result(rid, api_key, args.json)
    result["type"] = "music"
    result["model"] = model
    output(result, args.json)
    return 0 if result["status"] == "completed" else 1


def cmd_sfx(args: argparse.Namespace) -> int:
    """Generate sound effects."""
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    payload: dict = {"prompt": args.prompt}
    if args.duration:
        payload["duration"] = args.duration

    if not args.json:
        print("Generating sound effect (MMAudio)...")

    try:
        resp = submit_with_retry(SFX_ENDPOINT, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, args.json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id", "raw": str(resp)[:500]}, args.json)
        return 1

    save_job({"request_id": rid, "type": "sfx", "prompt": args.prompt,
              "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    result = poll_for_result(rid, api_key, args.json)
    result["type"] = "sfx"
    output(result, args.json)
    return 0 if result["status"] == "completed" else 1


def cmd_sync(args: argparse.Namespace) -> int:
    """Generate audio synchronized to video content."""
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    payload: dict = {"video_url": args.video}
    if args.prompt:
        payload["prompt"] = args.prompt

    if not args.json:
        print("Generating synchronized audio...")

    try:
        resp = submit_with_retry(SYNC_ENDPOINT, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, args.json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id", "raw": str(resp)[:500]}, args.json)
        return 1

    save_job({"request_id": rid, "type": "video-to-audio", "video_url": args.video,
              "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    result = poll_for_result(rid, api_key, args.json)
    result["type"] = "video-to-audio"
    output(result, args.json)
    return 0 if result["status"] == "completed" else 1


def cmd_lipsync(args: argparse.Namespace) -> int:
    """Lip-sync audio to video."""
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    payload: dict = {"video_url": args.video, "audio_url": args.audio}

    if not args.json:
        print("Generating lip-sync...")

    try:
        resp = submit_with_retry(LIPSYNC_ENDPOINT, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, args.json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id", "raw": str(resp)[:500]}, args.json)
        return 1

    save_job({"request_id": rid, "type": "lipsync", "video_url": args.video,
              "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})

    result = poll_for_result(rid, api_key, args.json)
    result["type"] = "lipsync"
    output(result, args.json)
    return 0 if result["status"] == "completed" else 1


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — Audio Generation")
    sub = parser.add_subparsers(dest="command", required=True)

    p_music = sub.add_parser("music", help="Generate music")
    p_music.add_argument("--prompt", required=True, help="Music prompt/description")
    p_music.add_argument("--model", default="suno", help="Music model")
    p_music.add_argument("--duration", help="Duration in seconds")
    p_music.add_argument("--instrumental", action="store_true", help="Instrumental only")
    p_music.add_argument("--style", help="Music style")
    p_music.add_argument("--json", action="store_true", help="JSON output")

    p_sfx = sub.add_parser("sfx", help="Generate sound effects")
    p_sfx.add_argument("--prompt", required=True, help="SFX description")
    p_sfx.add_argument("--duration", help="Duration in seconds")
    p_sfx.add_argument("--json", action="store_true", help="JSON output")

    p_sync = sub.add_parser("sync", help="Video-to-audio sync")
    p_sync.add_argument("--video", required=True, help="Video URL")
    p_sync.add_argument("--prompt", help="Audio style hint")
    p_sync.add_argument("--json", action="store_true", help="JSON output")

    p_lip = sub.add_parser("lipsync", help="Lip-sync audio to video")
    p_lip.add_argument("--video", required=True, help="Video URL")
    p_lip.add_argument("--audio", required=True, help="Audio URL")
    p_lip.add_argument("--json", action="store_true", help="JSON output")

    args = parser.parse_args()
    cmd_map = {"music": cmd_music, "sfx": cmd_sfx, "sync": cmd_sync, "lipsync": cmd_lipsync}
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
