#!/usr/bin/env python3
"""
instagram-get-media.py — List recent posts/reels for the connected account.

Usage:
  python3 ~/scripts/instagram-get-media.py
  python3 ~/scripts/instagram-get-media.py --limit 10 --json

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

MEDIA_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count"


def get_media(access_token: str, ig_user_id: str, limit: int = 25) -> dict:
    """Fetch recent media for the Instagram account."""
    url = (
        f"{BASE_URL}/{ig_user_id}/media"
        f"?fields={MEDIA_FIELDS}"
        f"&limit={limit}"
        f"&access_token={access_token}"
    )

    req = urllib.request.Request(url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
            media = result.get("data", [])
            return {
                "success": True,
                "count": len(media),
                "media": media,
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
    parser = argparse.ArgumentParser(description="List recent Instagram posts/reels")
    parser.add_argument("--limit", type=int, default=25, help="Number of media items to fetch (default: 25)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    try:
        from importlib.machinery import SourceFileLoader
        auth = SourceFileLoader("auth", os.path.expanduser("~/scripts/instagram-auth.py")).load_module()
        creds = auth.get_credentials()
        access_token = creds["access_token"]
        ig_user_id = creds["instagram_user_id"]
    except Exception as e:
        result = {"success": False, "error": f"Auth failed: {e}"}
        print(json.dumps(result) if args.json else result["error"])
        sys.exit(1)

    result = get_media(access_token, ig_user_id, args.limit)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"Recent media ({result['count']}):")
            for m in result["media"]:
                media_type = m.get("media_type", "?")
                caption = (m.get("caption", "")[:50] + "...") if m.get("caption") else "(no caption)"
                likes = m.get("like_count", 0)
                comments = m.get("comments_count", 0)
                permalink = m.get("permalink", "")
                print(f"  [{media_type}] {caption}")
                print(f"    Likes: {likes} | Comments: {comments} | {permalink}")
        else:
            print(f"ERROR: {result['error']}")
            sys.exit(1)


if __name__ == "__main__":
    main()
