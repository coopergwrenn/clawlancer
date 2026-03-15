#!/usr/bin/env python3
"""
instagram-reply-comment.py — Reply to a comment on an Instagram post.

Usage:
  python3 ~/scripts/instagram-reply-comment.py --comment-id <ID> --text "Thanks!"

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


def reply_to_comment(access_token: str, comment_id: str, text: str) -> dict:
    """Post a reply to an Instagram comment."""
    url = f"{BASE_URL}/{comment_id}/replies"

    payload = {"message": text}
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
                "reply_id": result.get("id"),
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
                "http_status": e.code,
            }
        except json.JSONDecodeError:
            return {"success": False, "error": str(e), "http_status": e.code}
    except Exception as e:
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Reply to an Instagram comment")
    parser.add_argument("--comment-id", required=True, help="ID of the comment to reply to")
    parser.add_argument("--text", required=True, help="Reply text")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    access_token = os.environ.get("INSTAGRAM_ACCESS_TOKEN")
    if not access_token:
        result = {"success": False, "error": "INSTAGRAM_ACCESS_TOKEN not set"}
        print(json.dumps(result) if args.json else result["error"])
        sys.exit(1)

    result = reply_to_comment(access_token, args.comment_id, args.text)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"Reply posted (id: {result.get('reply_id')})")
        else:
            print(f"ERROR: {result['error']}")
            sys.exit(1)


if __name__ == "__main__":
    main()
