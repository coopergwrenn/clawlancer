#!/usr/bin/env python3
"""
Consent helper for the consensus matching engine (VM-side).

Two operations:

  GET (default, no args):
    Print the user's current consent_tier and profile_version as JSON.
    The agent uses this to decide whether to ask the user the privacy
    question, and if so, what default to suggest.

  SET (--set <tier>):
    POST a new consent_tier to /api/match/v1/consent. Tier must be one
    of: hidden | name_only | interests | interests_plus_name | full_profile.
    The endpoint refuses if the user has no matchpool_profile yet — in
    that case, the agent should run intent extraction first.

Auth: same gateway_token resolution as the rest of the consensus skill
(env var GATEWAY_TOKEN or ~/.openclaw/.env).

Usage:
  python3 consensus_match_consent.py                       # GET
  python3 consensus_match_consent.py --set interests       # opt in to interests
  python3 consensus_match_consent.py --set hidden          # opt back out

Exit codes:
  0  → success (read or write)
  1  → transport / auth failure
  2  → invalid usage or invalid tier
  3  → 409 (no profile yet)
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

CONSENT_URL = "https://instaclaw.io/api/match/v1/consent"
TIMEOUT_SECONDS = 15

VALID_TIERS = {
    "hidden",
    "name_only",
    "interests",
    "interests_plus_name",
    "full_profile",
}


def get_gateway_token() -> str | None:
    tok = os.environ.get("GATEWAY_TOKEN", "").strip()
    if tok:
        return tok
    env_path = os.path.expanduser("~/.openclaw/.env")
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("GATEWAY_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except (FileNotFoundError, IOError):
        pass
    return None


def request(method: str, body: dict | None, token: str) -> tuple[int, dict | None]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        CONSENT_URL,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            try:
                return resp.status, json.loads(resp.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return resp.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            return e.code, None
    except urllib.error.URLError as e:
        sys.stderr.write(f"consent.transport_error: {e.reason}\n")
        return 0, None


def main() -> int:
    parser = argparse.ArgumentParser(description="Consensus matching consent helper")
    parser.add_argument("--set", dest="set_tier", help="Set consent tier", default=None)
    args = parser.parse_args()

    token = get_gateway_token()
    if not token:
        sys.stderr.write("consent.fatal no_gateway_token\n")
        return 1

    if args.set_tier is None:
        # GET
        status, body = request("GET", None, token)
        if status != 200 or body is None:
            sys.stderr.write(f"consent.get_failed status={status} body={body}\n")
            return 1 if status != 409 else 3
        print(json.dumps(body))
        return 0

    tier = args.set_tier.strip().lower()
    if tier not in VALID_TIERS:
        sys.stderr.write(f"consent.bad_tier got={tier} expected={sorted(VALID_TIERS)}\n")
        return 2

    status, body = request("POST", {"consent_tier": tier}, token)
    if status == 200 and body and body.get("ok"):
        print(json.dumps(body))
        return 0
    if status == 409:
        sys.stderr.write(f"consent.no_profile body={body}\n")
        return 3
    sys.stderr.write(f"consent.set_failed status={status} body={body}\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
