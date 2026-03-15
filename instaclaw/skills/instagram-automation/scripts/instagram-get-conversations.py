#!/usr/bin/env python3
"""
instagram-get-conversations.py — List recent DM conversations.

Usage:
  python3 ~/scripts/instagram-get-conversations.py
  python3 ~/scripts/instagram-get-conversations.py --limit 5 --json

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


def get_conversations(access_token: str, ig_user_id: str, limit: int = 20) -> dict:
    """Fetch recent DM conversations for the connected Instagram account."""
    url = (
        f"{BASE_URL}/{ig_user_id}/conversations"
        f"?fields=participants,messages{{id,created_time,from,to,message}}"
        f"&limit={limit}"
        f"&access_token={access_token}"
    )

    req = urllib.request.Request(url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
            conversations = result.get("data", [])
            return {
                "success": True,
                "count": len(conversations),
                "conversations": conversations,
                "paging": result.get("paging"),
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
    parser = argparse.ArgumentParser(description="List Instagram DM conversations")
    parser.add_argument("--limit", type=int, default=20, help="Number of conversations to fetch (default: 20)")
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

    result = get_conversations(access_token, ig_user_id, args.limit)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"Found {result['count']} conversations:")
            for conv in result["conversations"]:
                participants = conv.get("participants", {}).get("data", [])
                names = [p.get("name", p.get("id", "?")) for p in participants]
                messages = conv.get("messages", {}).get("data", [])
                latest = messages[0] if messages else {}
                preview = (latest.get("message", "")[:60] + "...") if latest.get("message") else "(no messages)"
                print(f"  [{conv.get('id', '?')[:12]}...] {', '.join(names)} — {preview}")
        else:
            print(f"ERROR: {result['error']}")
            sys.exit(1)


if __name__ == "__main__":
    main()
