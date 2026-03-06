#!/usr/bin/env python3
"""Higgsfield — Upload a Telegram image (or local file) to Muapi CDN.

Bridges Telegram file_ids → public HTTPS URLs for I2V/editing endpoints.

Usage:
  python3 higgsfield-upload-telegram-image.py --telegram-file-id <file_id> [--json]
  python3 higgsfield-upload-telegram-image.py --file <local_path> [--json]

Flow for Telegram images:
  1. GET https://api.telegram.org/bot{token}/getFile?file_id={id}  → file_path
  2. GET https://api.telegram.org/file/bot{token}/{file_path}       → raw bytes
  3. POST /api/v1/upload_file (multipart FormData) via proxy        → CDN URL

Output (JSON):  { "status": "uploaded", "url": "https://cdn.muapi.ai/..." }
Exit codes: 0=OK, 1=FAIL, 2=BLOCK (missing config)
"""

import argparse
import json
import mimetypes
import os
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ENV_FILE = Path.home() / ".openclaw" / ".env"


def _load_env_var(key: str) -> str | None:
    if not ENV_FILE.exists():
        return None
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line.startswith(f"{key}="):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            return val if val else None
    return None


def get_base_url() -> str:
    proxy = _load_env_var("INSTACLAW_MUAPI_PROXY")
    if proxy:
        return proxy.rstrip("/") + "/api/gateway/muapi"
    return "https://api.muapi.ai"


def download_telegram_file(bot_token: str, file_id: str) -> tuple[bytes, str]:
    """Download a file from Telegram Bot API. Returns (bytes, filename)."""
    # Step 1: getFile → file_path
    url = f"https://api.telegram.org/bot{bot_token}/getFile?file_id={file_id}"
    req = Request(url, method="GET")
    with urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())

    if not data.get("ok"):
        raise RuntimeError(f"Telegram getFile failed: {data.get('description', 'unknown error')}")

    file_path = data["result"]["file_path"]
    file_size = data["result"].get("file_size", 0)

    # Telegram Bot API file size limit is 20MB
    if file_size > 20 * 1024 * 1024:
        raise RuntimeError(f"File too large ({file_size} bytes). Telegram Bot API limit is 20MB.")

    filename = file_path.split("/")[-1] if "/" in file_path else file_path

    # Step 2: Download the actual file bytes
    download_url = f"https://api.telegram.org/file/bot{bot_token}/{file_path}"
    req = Request(download_url, method="GET")
    with urlopen(req, timeout=60) as resp:
        file_bytes = resp.read()

    return file_bytes, filename


def upload_to_muapi(file_bytes: bytes, filename: str, gateway_token: str) -> str:
    """Upload file bytes to Muapi CDN via multipart FormData. Returns CDN URL."""
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
        headers = {"x-gateway-token": gateway_token, "Content-Type": f"multipart/form-data; boundary={boundary}"}
    else:
        headers = {"x-api-key": gateway_token, "Content-Type": f"multipart/form-data; boundary={boundary}"}

    req = Request(url, data=body, headers=headers, method="POST")
    with urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())

    cdn_url = data.get("url") or data.get("file_url") or data.get("data", {}).get("url")
    if not cdn_url:
        raise RuntimeError(f"No URL in upload response: {json.dumps(data)[:300]}")
    return cdn_url


def main():
    parser = argparse.ArgumentParser(description="Upload Telegram image to Muapi CDN")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--telegram-file-id", help="Telegram file_id to download and upload")
    group.add_argument("--file", help="Local file path to upload")
    parser.add_argument("--json", action="store_true", help="JSON output")
    args = parser.parse_args()

    gateway_token = _load_env_var("GATEWAY_TOKEN") or _load_env_var("MUAPI_API_KEY")
    if not gateway_token:
        msg = "No gateway token configured. Run higgsfield-setup.py status"
        if args.json:
            print(json.dumps({"error": msg}))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 2

    try:
        if args.telegram_file_id:
            bot_token = _load_env_var("TELEGRAM_BOT_TOKEN")
            if not bot_token:
                msg = "No TELEGRAM_BOT_TOKEN in ~/.openclaw/.env. Telegram not configured on this VM."
                if args.json:
                    print(json.dumps({"error": msg}))
                else:
                    print(f"ERROR: {msg}", file=sys.stderr)
                return 2

            if not args.json:
                print(f"Downloading from Telegram (file_id: {args.telegram_file_id[:20]}...)...")

            file_bytes, filename = download_telegram_file(bot_token, args.telegram_file_id)

            if not args.json:
                print(f"Downloaded {len(file_bytes)} bytes ({filename})")
                print("Uploading to Muapi CDN...")

            cdn_url = upload_to_muapi(file_bytes, filename, gateway_token)

        else:
            # Local file path
            file_path = Path(args.file)
            if not file_path.exists():
                msg = f"File not found: {file_path}"
                if args.json:
                    print(json.dumps({"error": msg}))
                else:
                    print(f"ERROR: {msg}", file=sys.stderr)
                return 1

            if not args.json:
                print(f"Uploading {file_path.name} to Muapi CDN...")

            file_bytes = file_path.read_bytes()
            cdn_url = upload_to_muapi(file_bytes, file_path.name, gateway_token)

        result = {"status": "uploaded", "url": cdn_url}
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f"Upload complete!")
            print(f"  url: {cdn_url}")
        return 0

    except HTTPError as e:
        body = e.read().decode() if hasattr(e, "read") else ""
        msg = f"HTTP {e.code}: {body[:300]}"
        if args.json:
            print(json.dumps({"error": msg}))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 1
    except (URLError, RuntimeError) as e:
        msg = str(e)
        if args.json:
            print(json.dumps({"error": msg}))
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
