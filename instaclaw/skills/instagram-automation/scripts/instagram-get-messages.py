#!/usr/bin/env python3
"""
instagram-get-messages.py — Read messages in a specific DM conversation.

Usage:
  python3 ~/scripts/instagram-get-messages.py --conversation-id <ID>
  python3 ~/scripts/instagram-get-messages.py --conversation-id <ID> --limit 10 --json

Environment:
  INSTAGRAM_ACCESS_TOKEN — Long-lived access token
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

API_VERSION = "v21.0"
BASE_URL = f"https://graph.instagram.com/{API_VERSION}"


def get_messages(access_token: str, conversation_id: str, limit: int = 20) -> dict:
    """Fetch messages in a specific conversation."""
    url = (
        f"{BASE_URL}/{conversation_id}/messages"
        f"?fields=id,created_time,from,to,message,attachments"
        f"&limit={limit}"
        f"&access_token={access_token}"
    )

    req = urllib.request.Request(url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
            messages = result.get("data", [])
            return {
                "success": True,
                "count": len(messages),
                "messages": messages,
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
    parser = argparse.ArgumentParser(description="Read messages in an Instagram DM conversation")
    parser.add_argument("--conversation-id", required=True, help="Conversation ID to read messages from")
    parser.add_argument("--limit", type=int, default=20, help="Number of messages to fetch (default: 20)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    try:
        from importlib.machinery import SourceFileLoader
        auth = SourceFileLoader("auth", os.path.expanduser("~/scripts/instagram-auth.py")).load_module()
        creds = auth.get_credentials()
        access_token = creds["access_token"]
    except Exception as e:
        result = {"success": False, "error": f"Auth failed: {e}"}
        print(json.dumps(result) if args.json else result["error"])
        sys.exit(1)

    result = get_messages(access_token, args.conversation_id, args.limit)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"Messages ({result['count']}):")
            for msg in result["messages"]:
                sender = msg.get("from", {}).get("name", msg.get("from", {}).get("id", "?"))
                text = msg.get("message", "(attachment)")
                time = msg.get("created_time", "")
                print(f"  [{time}] {sender}: {text}")
        else:
            print(f"ERROR: {result['error']}")
            sys.exit(1)


if __name__ == "__main__":
    main()
