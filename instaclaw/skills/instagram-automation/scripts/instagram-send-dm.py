#!/usr/bin/env python3
"""
instagram-send-dm.py — Send a DM to an Instagram user.

Usage:
  python3 ~/scripts/instagram-send-dm.py --recipient <IGSID> --text "Hello!"
  python3 ~/scripts/instagram-send-dm.py --recipient <IGSID> --image <URL>
  python3 ~/scripts/instagram-send-dm.py --recipient <IGSID> --text "Check this" --image <URL>

Environment:
  INSTAGRAM_ACCESS_TOKEN — Long-lived access token (injected by gateway)
  INSTAGRAM_USER_ID      — Instagram Business/Creator account ID

Constraints:
  - 24-hour messaging window: can only reply within 24hr of user's last message
  - 200 DMs per hour rate limit
  - No unsolicited DMs — user must have initiated contact
  - GIFs and stickers are NOT supported by the API
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

API_VERSION = "v21.0"
BASE_URL = f"https://graph.instagram.com/{API_VERSION}"
RATE_LIMIT_PER_HOUR = 200


def send_message(access_token: str, ig_user_id: str, recipient_id: str,
                 text: str | None = None, image_url: str | None = None) -> dict:
    """Send a DM via the Instagram Messaging API."""
    if not text and not image_url:
        return {"success": False, "error": "Either --text or --image is required"}

    url = f"{BASE_URL}/{ig_user_id}/messages"

    message_payload: dict = {}
    if text:
        message_payload["text"] = text
    if image_url:
        message_payload["attachment"] = {
            "type": "image",
            "payload": {"url": image_url}
        }

    payload = {
        "recipient": {"id": recipient_id},
        "message": message_payload,
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
                "recipient_id": recipient_id,
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
    parser = argparse.ArgumentParser(description="Send an Instagram DM")
    parser.add_argument("--recipient", required=True, help="Instagram-scoped user ID (IGSID) of the recipient")
    parser.add_argument("--text", help="Text message to send")
    parser.add_argument("--image", help="URL of an image to send")
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

    if not args.text and not args.image:
        result = {"success": False, "error": "Either --text or --image is required"}
        print(json.dumps(result) if args.json else result["error"])
        sys.exit(1)

    result = send_message(access_token, ig_user_id, args.recipient, args.text, args.image)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"DM sent to {args.recipient} (message_id: {result.get('message_id')})")
        else:
            print(f"ERROR: {result['error']}")
            if result.get("error_code"):
                print(f"  Meta error code: {result['error_code']}")
            sys.exit(1)


if __name__ == "__main__":
    main()
