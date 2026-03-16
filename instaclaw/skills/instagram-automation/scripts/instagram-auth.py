#!/usr/bin/env python3
"""
instagram-auth.py — Shared auth helper for Instagram scripts.

Fetches Instagram credentials (access token + user ID) from the InstaClaw API
using the VM's gateway token. This avoids storing the raw token on disk.

Usage (from other scripts):
    from importlib.machinery import SourceFileLoader
    auth = SourceFileLoader("auth", os.path.expanduser("~/scripts/instagram-auth.py")).load_module()
    creds = auth.get_credentials()
    # creds["access_token"], creds["instagram_user_id"]

Or standalone to test:
    python3 ~/scripts/instagram-auth.py
"""

import json
import os
import sys
import urllib.request
import urllib.error


def get_credentials() -> dict:
    """
    Fetch Instagram credentials from the InstaClaw API.

    Reads GATEWAY_TOKEN from the VM's .env file and calls
    GET /api/instagram/token with X-Gateway-Token header.

    Falls back to INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID env vars
    if the API call fails (for local testing).

    Returns dict with: access_token, instagram_user_id, instagram_username
    """
    # Try env vars first (allows override for testing)
    env_token = os.environ.get("INSTAGRAM_ACCESS_TOKEN")
    env_user_id = os.environ.get("INSTAGRAM_USER_ID")
    if env_token and env_user_id:
        return {
            "access_token": env_token,
            "instagram_user_id": env_user_id,
            "instagram_username": os.environ.get("INSTAGRAM_USERNAME", ""),
        }

    # Read gateway token from .env files
    gateway_token = os.environ.get("GATEWAY_TOKEN")
    if not gateway_token:
        for env_path in [
            os.path.expanduser("~/.openclaw/.env"),
            os.path.expanduser("~/.env"),
        ]:
            if os.path.exists(env_path):
                with open(env_path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("GATEWAY_TOKEN="):
                            gateway_token = line.split("=", 1)[1].strip().strip('"').strip("'")
                            break
            if gateway_token:
                break

    if not gateway_token:
        raise RuntimeError(
            "No Instagram credentials found. Set INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_USER_ID "
            "env vars, or ensure GATEWAY_TOKEN is set (for API fetch)."
        )

    # Fetch from InstaClaw API
    api_url = os.environ.get("INSTACLAW_API_URL", "https://instaclaw.io")
    url = f"{api_url}/api/instagram/token"

    req = urllib.request.Request(
        url,
        headers={"X-Gateway-Token": gateway_token},
        method="GET",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            if "access_token" not in data:
                raise RuntimeError(f"API returned no access_token: {json.dumps(data)[:200]}")
            return data
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"Instagram token API returned {e.code}: {body[:200]}")
    except Exception as e:
        raise RuntimeError(f"Failed to fetch Instagram credentials: {e}")


def main():
    """Test credential fetching."""
    try:
        creds = get_credentials()
        print(f"Instagram User ID: {creds['instagram_user_id']}")
        print(f"Username: {creds.get('instagram_username', '(unknown)')}")
        print(f"Token: {creds['access_token'][:20]}...{creds['access_token'][-10:]}")
        if creds.get("token_expires_at"):
            print(f"Expires: {creds['token_expires_at']}")
        print("OK — credentials fetched successfully")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
