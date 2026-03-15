#!/usr/bin/env python3
"""
instagram-private-reply.py — Send a private DM reply to someone who commented on a post.

This is the "comment-to-DM" flow — the most common Instagram automation pattern.
A user comments a keyword (e.g., "LINK") and the agent sends them a DM with the content.

Usage:
  python3 ~/scripts/instagram-private-reply.py --comment-id <ID> --text "Here's your link: ..."

Environment:
  INSTAGRAM_ACCESS_TOKEN — Long-lived access token
  INSTAGRAM_USER_ID      — Instagram Business/Creator account ID

Constraints:
  - The comment must be on a post owned by the connected Instagram account
  - The commenter must not have opted out of DMs from the business
  - Rate limit: 200 DMs/hour
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

API_VERSION = "v21.0"
BASE_URL = f"https://graph.instagram.com/{API_VERSION}"


def private_reply(access_token: str, ig_user_id: str, comment_id: str, text: str) -> dict:
    """Send a private DM reply to a commenter."""
    url = f"{BASE_URL}/{ig_user_id}/messages"

    payload = {
        "recipient": {"comment_id": comment_id},
        "message": {"text": text},
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {access_token}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
            return {
                "success": True,
                "message_id": result.get("message_id"),
                "comment_id": comment_id,
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
                "error_subcode": meta_error.get("error_subcode"),
                "http_status": e.code,
            }
        except json.JSONDecodeError:
            return {"success": False, "error": str(e), "http_status": e.code}
    except Exception as e:
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Send a private DM reply to an Instagram commenter")
    parser.add_argument("--comment-id", required=True, help="ID of the comment that triggered this reply")
    parser.add_argument("--text", required=True, help="DM message text")
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

    result = private_reply(access_token, ig_user_id, args.comment_id, args.text)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"Private reply sent for comment {args.comment_id} (message_id: {result.get('message_id')})")
        else:
            print(f"ERROR: {result['error']}")
            sys.exit(1)


if __name__ == "__main__":
    main()
