#!/usr/bin/env python3
"""Higgsfield AI Video — Core generation (text-to-video, image-to-video, text-to-image).

Usage:
  python3 higgsfield-generate.py text-to-video --prompt "..." --model kling-3.0 [--json]
  python3 higgsfield-generate.py image-to-video --image <url> --prompt "..." [--json]
  python3 higgsfield-generate.py text-to-image --prompt "..." --model flux-schnell [--json]
  python3 higgsfield-generate.py status --id <request_id> [--json]
  python3 higgsfield-generate.py upload-file --file <path> [--json]

Exit codes: 0=OK, 1=FAIL, 2=BLOCK
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
import base64

# ── Constants ──────────────────────────────────────────────────────────────────
ENV_FILE = Path.home() / ".openclaw" / ".env"
WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace" / "higgsfield"
JOBS_FILE = WORKSPACE_DIR / "jobs.json"
MUAPI_BASE = "https://api.muapi.ai"

# Endpoint map for each generation type
VIDEO_ENDPOINTS = {
    "kling-3.0": "/api/v1/generate/video/kling/v3",
    "kling-2.0": "/api/v1/generate/video/kling/v2",
    "kling-1.6": "/api/v1/generate/video/kling",
    "wan-2.2": "/api/v1/generate/video/wan",
    "wan-2.1": "/api/v1/generate/video/wan/2.1",
    "sora-2": "/api/v1/generate/video/sora",
    "veo-3": "/api/v1/generate/video/veo3",
    "veo-3.1": "/api/v1/generate/video/veo3.1",
    "veo-2": "/api/v1/generate/video/veo2",
    "seedance-2.0": "/api/v1/generate/video/seedance",
    "hailuo": "/api/v1/generate/video/hailuo",
    "hailuo-i2v": "/api/v1/generate/video/hailuo/i2v",
    "luma": "/api/v1/generate/video/luma",
    "runway-gen4": "/api/v1/generate/video/runway/gen4",
    "pika-2.2": "/api/v1/generate/video/pika",
    "pixverse-v4": "/api/v1/generate/video/pixverse",
    "hunyuan": "/api/v1/generate/video/hunyuan",
}

I2V_ENDPOINTS = {
    "kling-3.0": "/api/v1/generate/video/kling/v3/img2video",
    "kling-2.0": "/api/v1/generate/video/kling/v2/img2video",
    "wan-2.2": "/api/v1/generate/video/wan/img2video",
    "sora-2": "/api/v1/generate/video/sora/img2video",
    "veo-3": "/api/v1/generate/video/veo3/img2video",
    "seedance-2.0": "/api/v1/generate/video/seedance/img2video",
    "hailuo-i2v": "/api/v1/generate/video/hailuo/i2v",
    "runway-gen4": "/api/v1/generate/video/runway/gen4/img2video",
    "pika-2.2": "/api/v1/generate/video/pika/img2video",
    "pixverse-v4": "/api/v1/generate/video/pixverse/img2video",
}

IMAGE_ENDPOINTS = {
    "flux-schnell": "/api/v1/generate/image/flux/schnell",
    "flux-dev": "/api/v1/generate/image/flux/dev",
    "flux-pro": "/api/v1/generate/image/flux/pro",
    "ideogram-3": "/api/v1/generate/image/ideogram/v3",
    "recraft-v3": "/api/v1/generate/image/recraft/v3",
    "seedream-4.5": "/api/v1/generate/image/seedream",
    "gpt-image-1": "/api/v1/generate/image/gpt-image-1",
}

# Polling config
VIDEO_POLL_MAX = 120   # 120 × 2s = 4 min
IMAGE_POLL_MAX = 60    # 60 × 2s = 2 min
POLL_INTERVAL = 2

# Retry config
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
            return item.get("url") or item.get("video_url") or item.get("image_url")
    for key in ("url", "video_url", "image_url"):
        if resp.get(key):
            return resp[key]
    output_obj = resp.get("output") or resp.get("data", {}).get("output")
    if isinstance(output_obj, dict):
        return output_obj.get("url") or output_obj.get("video_url") or output_obj.get("image_url")
    video = resp.get("video")
    if isinstance(video, dict):
        return video.get("url")
    return None


def save_job(job: dict) -> None:
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    jobs = []
    if JOBS_FILE.exists():
        try:
            jobs = json.loads(JOBS_FILE.read_text())
        except Exception:
            jobs = []
    jobs.append(job)
    # Keep last 200 jobs
    if len(jobs) > 200:
        jobs = jobs[-200:]
    JOBS_FILE.write_text(json.dumps(jobs, indent=2))


def output(data: dict, as_json: bool = False) -> None:
    if as_json:
        print(json.dumps(data, indent=2))
    else:
        for k, v in data.items():
            print(f"  {k}: {v}")


def submit_with_retry(endpoint: str, api_key: str, payload: dict) -> dict:
    """Submit with retry logic."""
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            return muapi_request(endpoint, api_key, payload)
        except HTTPError as e:
            last_error = e
            if e.code in (401, 403):
                raise  # Don't retry auth errors
            if e.code == 429 or e.code >= 500:
                if attempt < MAX_RETRIES - 1:
                    delay = RETRY_DELAYS[attempt]
                    print(f"  Retry {attempt+1}/{MAX_RETRIES} in {delay}s (HTTP {e.code})...",
                          file=sys.stderr)
                    time.sleep(delay)
                continue
            raise
        except URLError as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                delay = RETRY_DELAYS[attempt]
                print(f"  Retry {attempt+1}/{MAX_RETRIES} in {delay}s ({e.reason})...",
                      file=sys.stderr)
                time.sleep(delay)
    raise last_error


def poll_for_result(request_id: str, api_key: str, max_polls: int,
                    as_json: bool = False) -> dict:
    """Poll until completion or failure."""
    poll_endpoint = f"/api/v1/requests/{request_id}"
    for i in range(max_polls):
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
            return {
                "status": status,
                "request_id": request_id,
                "error": resp.get("error") or resp.get("message") or "Generation failed",
            }
        else:
            if not as_json and i % 5 == 0:
                elapsed = (i + 1) * POLL_INTERVAL
                print(f"  [{elapsed}s] Status: {status or 'processing'}...")

    return {"status": "timeout", "request_id": request_id, "error": "Timed out waiting for result"}


# ── Commands ───────────────────────────────────────────────────────────────────

def cmd_text_to_video(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key. Run: python3 higgsfield-setup.py setup --key YOUR_KEY",
              file=sys.stderr)
        return 2

    model = args.model or "kling-3.0"
    endpoint = VIDEO_ENDPOINTS.get(model)
    if not endpoint:
        print(f"ERROR: Unknown video model '{model}'. Available: {', '.join(VIDEO_ENDPOINTS.keys())}",
              file=sys.stderr)
        return 1

    payload: dict = {"prompt": args.prompt}
    if args.negative_prompt:
        payload["negative_prompt"] = args.negative_prompt
    if args.duration:
        payload["duration"] = args.duration
    if args.aspect_ratio:
        payload["aspect_ratio"] = args.aspect_ratio
    if args.resolution:
        payload["resolution"] = args.resolution
    if args.camera:
        payload["camera"] = args.camera
    if args.seed is not None:
        payload["seed"] = args.seed
    if args.cfg_scale is not None:
        payload["cfg_scale"] = args.cfg_scale
    if args.elements_ref:
        payload["elements"] = [{"ref": r} for r in args.elements_ref]

    if not args.json:
        print(f"Submitting text-to-video ({model})...")

    try:
        resp = submit_with_retry(endpoint, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, args.json)
        return 1
    except URLError as e:
        output({"error": f"Network error: {e.reason}"}, args.json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id in response", "raw": str(resp)[:500]}, args.json)
        return 1

    job = {
        "request_id": rid, "type": "text-to-video", "model": model,
        "prompt": args.prompt, "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "processing",
    }
    save_job(job)

    if not args.json:
        print(f"Request ID: {rid}")
        print("Polling for result...")

    result = poll_for_result(rid, api_key, VIDEO_POLL_MAX, args.json)
    result["model"] = model
    result["type"] = "text-to-video"
    output(result, args.json)
    return 0 if result["status"] == "completed" else 1


def cmd_image_to_video(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    model = args.model or "kling-3.0"
    endpoint = I2V_ENDPOINTS.get(model)
    if not endpoint:
        print(f"ERROR: Unknown I2V model '{model}'. Available: {', '.join(I2V_ENDPOINTS.keys())}",
              file=sys.stderr)
        return 1

    payload: dict = {"image_url": args.image}
    if args.prompt:
        payload["prompt"] = args.prompt
    if args.duration:
        payload["duration"] = args.duration
    if args.aspect_ratio:
        payload["aspect_ratio"] = args.aspect_ratio
    if args.elements_ref:
        payload["elements"] = [{"ref": r} for r in args.elements_ref]

    if not args.json:
        print(f"Submitting image-to-video ({model})...")

    try:
        resp = submit_with_retry(endpoint, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, args.json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id in response", "raw": str(resp)[:500]}, args.json)
        return 1

    job = {
        "request_id": rid, "type": "image-to-video", "model": model,
        "image_url": args.image,
        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "processing",
    }
    save_job(job)

    if not args.json:
        print(f"Request ID: {rid}")

    result = poll_for_result(rid, api_key, VIDEO_POLL_MAX, args.json)
    result["model"] = model
    result["type"] = "image-to-video"
    output(result, args.json)
    return 0 if result["status"] == "completed" else 1


def cmd_text_to_image(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    model = args.model or "flux-schnell"
    endpoint = IMAGE_ENDPOINTS.get(model)
    if not endpoint:
        print(f"ERROR: Unknown image model '{model}'. Available: {', '.join(IMAGE_ENDPOINTS.keys())}",
              file=sys.stderr)
        return 1

    payload: dict = {"prompt": args.prompt}
    if args.image_size:
        payload["image_size"] = args.image_size
    if args.negative_prompt:
        payload["negative_prompt"] = args.negative_prompt
    if args.seed is not None:
        payload["seed"] = args.seed
    if args.num_images:
        payload["num_images"] = args.num_images
    if args.style:
        payload["style"] = args.style

    if not args.json:
        print(f"Submitting text-to-image ({model})...")

    try:
        resp = submit_with_retry(endpoint, api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Submit failed (HTTP {e.code})", "details": body}, args.json)
        return 1

    rid = extract_request_id(resp)
    if not rid:
        output({"error": "No request_id in response", "raw": str(resp)[:500]}, args.json)
        return 1

    job = {
        "request_id": rid, "type": "text-to-image", "model": model,
        "prompt": args.prompt,
        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "processing",
    }
    save_job(job)

    if not args.json:
        print(f"Request ID: {rid}")

    result = poll_for_result(rid, api_key, IMAGE_POLL_MAX, args.json)
    result["model"] = model
    result["type"] = "text-to-image"
    output(result, args.json)
    return 0 if result["status"] == "completed" else 1


def cmd_status(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    poll_endpoint = f"/api/v1/requests/{args.id}"
    try:
        resp = muapi_request(poll_endpoint, api_key, method="GET")
    except HTTPError as e:
        output({"error": f"Status check failed (HTTP {e.code})"}, args.json)
        return 1

    status = (resp.get("status") or "").lower()
    url = extract_output_url(resp)
    result = {"request_id": args.id, "status": status}
    if url:
        result["output_url"] = url
    if resp.get("error"):
        result["error"] = resp["error"]
    output(result, args.json)
    return 0 if status in ("completed", "succeeded", "done") else 1


def cmd_upload_file(args: argparse.Namespace) -> int:
    api_key = load_api_key()
    if not api_key:
        print("ERROR: No API key.", file=sys.stderr)
        return 2

    file_path = Path(args.file)
    if not file_path.exists():
        print(f"ERROR: File not found: {file_path}", file=sys.stderr)
        return 1

    # Read file and base64 encode for upload
    file_data = file_path.read_bytes()
    b64_data = base64.b64encode(file_data).decode()

    # Determine MIME type from extension
    ext = file_path.suffix.lower()
    mime_map = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
        ".mov": "video/quicktime", ".avi": "video/x-msvideo",
    }
    mime_type = mime_map.get(ext, "application/octet-stream")

    payload = {
        "file": f"data:{mime_type};base64,{b64_data}",
        "filename": file_path.name,
    }

    try:
        resp = muapi_request("/api/v1/files/upload", api_key, payload)
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Upload failed (HTTP {e.code})", "details": body}, args.json)
        return 1

    file_url = resp.get("url") or resp.get("file_url") or resp.get("data", {}).get("url")
    result = {"status": "uploaded", "file_url": file_url, "filename": file_path.name}
    output(result, args.json)
    return 0


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Higgsfield AI Video — Core Generation")
    sub = parser.add_subparsers(dest="command", required=True)

    # text-to-video
    p_t2v = sub.add_parser("text-to-video", help="Generate video from text prompt")
    p_t2v.add_argument("--prompt", required=True, help="Text prompt")
    p_t2v.add_argument("--model", default="kling-3.0", help="Model name")
    p_t2v.add_argument("--negative-prompt", help="Negative prompt")
    p_t2v.add_argument("--duration", help="Duration (e.g., 5, 10)")
    p_t2v.add_argument("--aspect-ratio", help="Aspect ratio (e.g., 16:9, 9:16, 1:1)")
    p_t2v.add_argument("--resolution", help="Resolution (e.g., 1080p)")
    p_t2v.add_argument("--camera", help="Camera movement JSON")
    p_t2v.add_argument("--seed", type=int, help="Random seed")
    p_t2v.add_argument("--cfg-scale", type=float, help="CFG scale")
    p_t2v.add_argument("--elements-ref", nargs="*", help="Kling Elements references")
    p_t2v.add_argument("--json", action="store_true", help="JSON output")

    # image-to-video
    p_i2v = sub.add_parser("image-to-video", help="Animate an image")
    p_i2v.add_argument("--image", required=True, help="Image URL")
    p_i2v.add_argument("--prompt", help="Motion prompt")
    p_i2v.add_argument("--model", default="kling-3.0", help="Model name")
    p_i2v.add_argument("--duration", help="Duration")
    p_i2v.add_argument("--aspect-ratio", help="Aspect ratio")
    p_i2v.add_argument("--elements-ref", nargs="*", help="Kling Elements references")
    p_i2v.add_argument("--json", action="store_true", help="JSON output")

    # text-to-image
    p_t2i = sub.add_parser("text-to-image", help="Generate image from text prompt")
    p_t2i.add_argument("--prompt", required=True, help="Text prompt")
    p_t2i.add_argument("--model", default="flux-schnell", help="Model name")
    p_t2i.add_argument("--image-size", help="Size (square, landscape, portrait)")
    p_t2i.add_argument("--negative-prompt", help="Negative prompt")
    p_t2i.add_argument("--seed", type=int, help="Random seed")
    p_t2i.add_argument("--num-images", type=int, help="Number of images")
    p_t2i.add_argument("--style", help="Style preset")
    p_t2i.add_argument("--json", action="store_true", help="JSON output")

    # status
    p_st = sub.add_parser("status", help="Check generation status")
    p_st.add_argument("--id", required=True, help="Request ID")
    p_st.add_argument("--json", action="store_true", help="JSON output")

    # upload-file
    p_up = sub.add_parser("upload-file", help="Upload a file for I2V/editing")
    p_up.add_argument("--file", required=True, help="Local file path")
    p_up.add_argument("--json", action="store_true", help="JSON output")

    args = parser.parse_args()
    cmd_map = {
        "text-to-video": cmd_text_to_video,
        "image-to-video": cmd_image_to_video,
        "text-to-image": cmd_text_to_image,
        "status": cmd_status,
        "upload-file": cmd_upload_file,
    }
    sys.exit(cmd_map[args.command](args))


if __name__ == "__main__":
    main()
