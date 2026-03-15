#!/usr/bin/env python3
"""
instagram-rate-check.py — Check remaining rate limit budget for the current hour.

Usage:
  python3 ~/scripts/instagram-rate-check.py
  python3 ~/scripts/instagram-rate-check.py --json

This reads the local rate limit tracking file maintained by the send scripts.
The file is updated every time a DM is sent.

Rate limit: 200 automated DMs per hour per account.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

RATE_LIMIT_PER_HOUR = 200
RATE_FILE = os.path.expanduser("~/.openclaw/instagram/rate-limit.json")


def get_current_hour_bucket() -> str:
    """Get the current hour bucket as ISO string (truncated to hour)."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:00:00Z")


def read_rate_data() -> dict:
    """Read the rate limit tracking file."""
    if not os.path.exists(RATE_FILE):
        return {}
    try:
        with open(RATE_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def main():
    parser = argparse.ArgumentParser(description="Check Instagram DM rate limit budget")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    bucket = get_current_hour_bucket()
    rate_data = read_rate_data()

    sent_this_hour = rate_data.get(bucket, 0)
    remaining = max(0, RATE_LIMIT_PER_HOUR - sent_this_hour)

    result = {
        "success": True,
        "hour_bucket": bucket,
        "sent_this_hour": sent_this_hour,
        "remaining": remaining,
        "limit": RATE_LIMIT_PER_HOUR,
        "can_send": remaining > 0,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Instagram DM Rate Limit ({bucket})")
        print(f"  Sent this hour: {sent_this_hour}/{RATE_LIMIT_PER_HOUR}")
        print(f"  Remaining: {remaining}")
        if remaining == 0:
            print("  STATUS: RATE LIMITED — wait for next hour")
        elif remaining < 20:
            print("  STATUS: LOW — pace your messages")
        else:
            print("  STATUS: OK")


if __name__ == "__main__":
    main()
