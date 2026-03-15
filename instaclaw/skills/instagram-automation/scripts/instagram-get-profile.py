#!/usr/bin/env python3
"""
instagram-get-profile.py — Get the connected Instagram account's profile info.

Usage:
  python3 ~/scripts/instagram-get-profile.py
  python3 ~/scripts/instagram-get-profile.py --json

Environment:
  INSTAGRAM_ACCESS_TOKEN — Long-lived access token
  INSTAGRAM_USER_ID      — Instagram Business/Creator account ID
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

API_VERSION = "v21.0"
BASE_URL = f"https://graph.instagram.com/{API_VERSION}"

PROFILE_FIELDS = "user_id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count"


def get_profile(access_token: str, ig_user_id: str) -> dict:
    """Fetch the Instagram user's profile."""
    url = f"{BASE_URL}/{ig_user_id}?fields={PROFILE_FIELDS}&access_token={access_token}"

    req = urllib.request.Request(url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            profile = json.loads(resp.read().decode())
            return {
                "success": True,
                "profile": profile,
            }
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        try:
            error_data = json.loads(error_body)
            meta_error = error_data.get("error", {})
            return {
                "success": False,
                "error": meta_error.get("message", str(e)),
                "error_code": meta_error.get("code"),
                "http_status": e.code,
            }
        except json.JSONDecodeError:
            return {"success": False, "error": str(e), "http_status": e.code}
    except Exception as e:
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Get Instagram profile info")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    access_token = os.environ.get("INSTAGRAM_ACCESS_TOKEN")
    ig_user_id = os.environ.get("INSTAGRAM_USER_ID")

    if not access_token:
        result = {"success": False, "error": "INSTAGRAM_ACCESS_TOKEN not set"}
        print(json.dumps(result) if args.json else result["error"])
        sys.exit(1)

    if not ig_user_id:
        result = {"success": False, "error": "INSTAGRAM_USER_ID not set"}
        print(json.dumps(result) if args.json else result["error"])
        sys.exit(1)

    result = get_profile(access_token, ig_user_id)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            p = result["profile"]
            print(f"@{p.get('username', '?')}")
            if p.get("name"):
                print(f"  Name: {p['name']}")
            if p.get("biography"):
                print(f"  Bio: {p['biography']}")
            if p.get("website"):
                print(f"  Website: {p['website']}")
            print(f"  Followers: {p.get('followers_count', '?')}")
            print(f"  Following: {p.get('follows_count', '?')}")
            print(f"  Posts: {p.get('media_count', '?')}")
        else:
            print(f"ERROR: {result['error']}")
            sys.exit(1)


if __name__ == "__main__":
    main()
