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
import mimetypes
import os
import re
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── Constants ──────────────────────────────────────────────────────────────────
ENV_FILE = Path.home() / ".openclaw" / ".env"
WORKSPACE_DIR = Path.home() / ".openclaw" / "workspace" / "higgsfield"
JOBS_FILE = WORKSPACE_DIR / "jobs.json"

# Verified endpoint map — flat model names at /api/v1/{endpoint}
# Source: Open-Higgsfield-AI models.js (endpoint = model.endpoint || model.id)
VIDEO_ENDPOINTS = {
    "kling-3.0": "kling-v3.0-pro-text-to-video",
    "kling-2.0": "kling-v2.5-turbo-pro-t2v",
    "wan-2.2": "wan2.2-text-to-video",
    "wan-2.5": "wan2.5-text-to-video",
    "sora": "openai-sora-2-text-to-video",
    "sora-2": "openai-sora-2-text-to-video",
    "veo-3": "veo3-text-to-video",
    "veo3": "veo3-text-to-video",
    "veo-3.1": "veo3.1-text-to-video",
    "veo3.1": "veo3.1-text-to-video",
    "seedance-2.0": "seedance-v2.0-t2v",
    "seedance-lite": "seedance-lite-t2v",
    "seedance-pro": "seedance-pro-t2v",
    "seedance-pro-fast": "seedance-pro-t2v-fast",
    "seedance-1.5-pro": "seedance-v1.5-pro-t2v",
    "seedance-1.5-pro-fast": "seedance-v1.5-pro-t2v-fast",
    "hailuo": "minimax-hailuo-2.3-pro-t2v",
    "luma": "ltx-2-pro-text-to-video",
    "runway": "runway-text-to-video",
    "runway-gen4": "runway-text-to-video",
    "pixverse": "pixverse-v5.5-t2v",
    "pixverse-v4": "pixverse-v5.5-t2v",
    "hunyuan": "hunyuan-text-to-video",
}

# I2V endpoints with per-model imageField (some use images_list, some image_url)
I2V_ENDPOINTS = {
    "kling-3.0": {"endpoint": "kling-v3.0-pro-image-to-video", "image_field": "image_url"},
    "kling-2.0": {"endpoint": "kling-v2.5-turbo-pro-i2v", "image_field": "image_url"},
    "wan-2.2": {"endpoint": "wan2.2-image-to-video", "image_field": "image_url"},
    "veo-3": {"endpoint": "veo3-image-to-video", "image_field": "images_list"},
    "veo3": {"endpoint": "veo3-image-to-video", "image_field": "images_list"},
    "runway": {"endpoint": "runway-image-to-video", "image_field": "image_url"},
    "runway-gen4": {"endpoint": "runway-image-to-video", "image_field": "image_url"},
    "hailuo": {"endpoint": "minimax-hailuo-2.3-pro-i2v", "image_field": "image_url"},
    "hailuo-i2v": {"endpoint": "minimax-hailuo-2.3-pro-i2v", "image_field": "image_url"},
    "seedance-2.0": {"endpoint": "seedance-v2.0-i2v", "image_field": "images_list"},
    "seedance-lite": {"endpoint": "seedance-lite-i2v", "image_field": "image_url"},
    "seedance-pro": {"endpoint": "seedance-pro-i2v", "image_field": "image_url"},
    "seedance-pro-fast": {"endpoint": "seedance-pro-i2v-fast", "image_field": "image_url"},
    "seedance-1.5-pro": {"endpoint": "seedance-v1.5-pro-i2v", "image_field": "image_url"},
    "seedance-1.5-pro-fast": {"endpoint": "seedance-v1.5-pro-i2v-fast", "image_field": "image_url"},
    "sora": {"endpoint": "openai-sora-2-image-to-video", "image_field": "images_list"},
    "sora-2": {"endpoint": "openai-sora-2-image-to-video", "image_field": "images_list"},
    "hunyuan": {"endpoint": "hunyuan-image-to-video", "image_field": "image_url"},
}

IMAGE_ENDPOINTS = {
    "flux-schnell": "flux-schnell-image",
    "flux-dev": "flux-dev-image",
    "flux-pro": "flux-dev-image",
    "ideogram-3": "ideogram-v3-t2i",
    "ideogram-v3": "ideogram-v3-t2i",
    "gpt-image-1": "gpt4o-text-to-image",
    "gpt-image-1.5": "gpt-image-1.5",
    "seedream-4.5": "bytedance-seedream-v4.5",
    "midjourney-v7": "midjourney-v7-text-to-image",
    "recraft-v3": "reve-text-to-image",
    "google-imagen4": "google-imagen4",
    "hunyuan-image": "hunyuan-image-3.0",
    "wan-image": "wan2.5-text-to-image",
}

# Polling config
VIDEO_POLL_MAX = 120   # 120 x 2s = 4 min
IMAGE_POLL_MAX = 60    # 60 x 2s = 2 min
POLL_INTERVAL = 2

# Retry config
MAX_RETRIES = 3
RETRY_DELAYS = [5, 15, 45]

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
    """Get proxy base URL. Platform-provided via INSTACLAW_MUAPI_PROXY, fallback to direct Muapi."""
    proxy = _load_env_var("INSTACLAW_MUAPI_PROXY")
    if proxy:
        return proxy.rstrip("/") + "/api/gateway/muapi"
    return "https://api.muapi.ai"


def muapi_request(endpoint: str, api_key: str, payload: dict | None = None,
                  method: str = "POST", timeout: int = 30) -> dict:
    base = get_base_url()
    url = f"{base}/api/v1/{endpoint}" if not endpoint.startswith("/") else f"{base}{endpoint}"
    # Use x-gateway-token for proxy, x-api-key for direct Muapi
    if "instaclaw" in base.lower():
        headers = {"x-gateway-token": api_key, "Content-Type": "application/json"}
    else:
        headers = {"x-api-key": api_key, "Content-Type": "application/json"}
    data = json.dumps(payload).encode() if payload else None
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def extract_request_id(resp: dict) -> str | None:
    return resp.get("request_id") or resp.get("id") or resp.get("data", {}).get("request_id")


def extract_output_url(resp: dict) -> str | None:
    """5-level fallback for output URL extraction (verified from muapi.js)."""
    # Level 1: outputs array
    outputs = resp.get("outputs") or resp.get("data", {}).get("outputs")
    if outputs and isinstance(outputs, list) and len(outputs) > 0:
        item = outputs[0]
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return item.get("url") or item.get("video_url") or item.get("image_url")
    # Level 2: top-level url fields
    for key in ("url", "video_url", "image_url"):
        if resp.get(key):
            return resp[key]
    # Level 3: output.url
    output_obj = resp.get("output") or resp.get("data", {}).get("output")
    if isinstance(output_obj, dict):
        return output_obj.get("url") or output_obj.get("video_url") or output_obj.get("image_url")
    # Level 4: video.url (effects endpoints)
    video = resp.get("video")
    if isinstance(video, dict):
        return video.get("url")
    # Level 5: image.url
    image = resp.get("image")
    if isinstance(image, dict):
        return image.get("url")
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


def is_telegram_file_id(value: str) -> bool:
    """Detect Telegram file_id patterns. They are base64-like strings, NOT URLs or file paths."""
    if value.startswith(("http://", "https://", "/", "~", "./")):
        return False
    # Telegram file_ids are typically 30-120 chars of alphanumerics, hyphens, underscores
    return bool(re.match(r'^[A-Za-z0-9_-]{20,}$', value))


def is_local_file(value: str) -> bool:
    """Check if value looks like a local file path that exists."""
    if value.startswith(("http://", "https://")):
        return False
    return Path(os.path.expanduser(value)).exists()


def resolve_image_to_url(image_value: str, api_key: str, as_json: bool = False) -> str:
    """Auto-resolve Telegram file_ids and local paths to public CDN URLs.

    If `image_value` is already an HTTPS URL, returns it unchanged.
    If it's a Telegram file_id, downloads from Telegram and uploads to Muapi CDN.
    If it's a local file path, uploads to Muapi CDN.
    """
    # Already an HTTP(S) URL — pass through
    if image_value.startswith(("http://", "https://")):
        return image_value

    # Telegram file_id — download from Telegram, upload to Muapi
    if is_telegram_file_id(image_value):
        bot_token = _load_env_var("TELEGRAM_BOT_TOKEN")
        if not bot_token:
            raise RuntimeError(
                "Got a Telegram file_id but TELEGRAM_BOT_TOKEN is not configured. "
                "Cannot download the image from Telegram."
            )
        if not as_json:
            print(f"  Detected Telegram file_id — downloading from Telegram...")

        # Step 1: getFile
        url = f"https://api.telegram.org/bot{bot_token}/getFile?file_id={image_value}"
        req = Request(url, method="GET")
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        if not data.get("ok"):
            raise RuntimeError(f"Telegram getFile failed: {data.get('description', 'unknown')}")
        file_path = data["result"]["file_path"]
        filename = file_path.split("/")[-1] if "/" in file_path else file_path

        # Step 2: Download bytes
        dl_url = f"https://api.telegram.org/file/bot{bot_token}/{file_path}"
        req = Request(dl_url, method="GET")
        with urlopen(req, timeout=60) as resp:
            file_bytes = resp.read()

        if not as_json:
            print(f"  Downloaded {len(file_bytes)} bytes — uploading to CDN...")

        return _upload_bytes_to_muapi(file_bytes, filename, api_key)

    # Local file path
    expanded = Path(os.path.expanduser(image_value))
    if expanded.exists():
        if not as_json:
            print(f"  Detected local file — uploading to CDN...")
        file_bytes = expanded.read_bytes()
        return _upload_bytes_to_muapi(file_bytes, expanded.name, api_key)

    # Unknown format — return as-is and let Muapi handle the error
    return image_value


def _upload_bytes_to_muapi(file_bytes: bytes, filename: str, api_key: str) -> str:
    """Upload raw bytes to Muapi CDN via multipart FormData. Returns CDN URL."""
    base = get_base_url()
    boundary = f"----FormBoundary{int(time.time() * 1000)}"
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + file_bytes + f"\r\n--{boundary}--\r\n".encode()

    url = f"{base}/api/v1/upload_file"
    if "instaclaw" in base.lower():
        headers = {"x-gateway-token": api_key, "Content-Type": f"multipart/form-data; boundary={boundary}"}
    else:
        headers = {"x-api-key": api_key, "Content-Type": f"multipart/form-data; boundary={boundary}"}

    req = Request(url, data=body, headers=headers, method="POST")
    with urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())

    cdn_url = data.get("url") or data.get("file_url") or data.get("data", {}).get("url")
    if not cdn_url:
        raise RuntimeError(f"No URL in upload response: {json.dumps(data)[:300]}")
    return cdn_url


def poll_for_result(request_id: str, api_key: str, max_polls: int,
                    as_json: bool = False) -> dict:
    """Poll at /api/v1/predictions/{id}/result until completion or failure."""
    poll_endpoint = f"/api/v1/predictions/{request_id}/result"
    for i in range(max_polls):
        time.sleep(POLL_INTERVAL)
        try:
            resp = muapi_request(poll_endpoint, api_key, method="GET")
        except (HTTPError, URLError):
            continue

        status = (resp.get("status") or "").lower()
        if status in ("completed", "succeeded", "success"):
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
    api_key = load_gateway_token()
    if not api_key:
        print("ERROR: No gateway token configured. Check higgsfield-setup.py status",
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
    api_key = load_gateway_token()
    if not api_key:
        print("ERROR: No gateway token configured.", file=sys.stderr)
        return 2

    model = args.model or "kling-3.0"
    model_info = I2V_ENDPOINTS.get(model)
    if not model_info:
        print(f"ERROR: Unknown I2V model '{model}'. Available: {', '.join(I2V_ENDPOINTS.keys())}",
              file=sys.stderr)
        return 1

    endpoint = model_info["endpoint"]
    image_field = model_info.get("image_field", "image_url")

    # Auto-resolve Telegram file_ids and local paths to public CDN URLs
    try:
        image_url = resolve_image_to_url(args.image, api_key, args.json)
    except (HTTPError, URLError, RuntimeError) as e:
        output({"error": f"Failed to resolve image: {e}"}, args.json)
        return 1

    payload: dict = {}
    # Respect per-model imageField
    if image_field == "images_list":
        payload["images_list"] = [image_url]
    else:
        payload[image_field] = image_url

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
    api_key = load_gateway_token()
    if not api_key:
        print("ERROR: No gateway token configured.", file=sys.stderr)
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
    api_key = load_gateway_token()
    if not api_key:
        print("ERROR: No gateway token configured.", file=sys.stderr)
        return 2

    poll_endpoint = f"/api/v1/predictions/{args.id}/result"
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
    return 0 if status in ("completed", "succeeded", "success") else 1


def cmd_upload_file(args: argparse.Namespace) -> int:
    api_key = load_gateway_token()
    if not api_key:
        print("ERROR: No gateway token configured.", file=sys.stderr)
        return 2

    file_path = Path(args.file)
    if not file_path.exists():
        print(f"ERROR: File not found: {file_path}", file=sys.stderr)
        return 1

    # Multipart FormData upload at /api/v1/upload_file
    base = get_base_url()
    boundary = f"----FormBoundary{int(time.time() * 1000)}"
    filename = file_path.name
    mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    file_data = file_path.read_bytes()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + file_data + f"\r\n--{boundary}--\r\n".encode()

    url = f"{base}/api/v1/upload_file"
    if "instaclaw" in base.lower():
        headers = {"x-gateway-token": api_key, "Content-Type": f"multipart/form-data; boundary={boundary}"}
    else:
        headers = {"x-api-key": api_key, "Content-Type": f"multipart/form-data; boundary={boundary}"}

    try:
        req = Request(url, data=body, headers=headers, method="POST")
        with urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
    except HTTPError as e:
        body_text = e.read().decode() if hasattr(e, "read") else ""
        output({"error": f"Upload failed (HTTP {e.code})", "details": body_text}, args.json)
        return 1

    file_url = data.get("url") or data.get("file_url") or data.get("data", {}).get("url")
    result = {"status": "uploaded", "file_url": file_url, "filename": filename}
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
    p_t2v.add_argument("--duration", type=int, help="Duration (e.g., 5, 10)")
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
    p_i2v.add_argument("--duration", type=int, help="Duration")
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
