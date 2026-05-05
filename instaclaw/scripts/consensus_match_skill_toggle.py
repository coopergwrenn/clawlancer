#!/usr/bin/env python3
"""
Skill toggle helper for the consensus-2026 matching skill.

Used by the agent during the §Organic Activation flow (consensus-2026
SKILL.md): when a user mentions a strong Consensus signal in chat AND
the skill is currently OFF, the agent offers to enable it. If the user
agrees, the agent calls this helper to flip the skill ON.

The helper POSTs to /api/match/v1/skill-toggle (gateway_token auth,
restricted to live-events category), which upserts the per-VM state
in instaclaw_vm_skills. The matching pipeline picks up the new state
at the next cron tick (≤30 min for matches, ≤15 min for intent sync).

Usage:
  python3 consensus_match_skill_toggle.py --enable     # turn ON
  python3 consensus_match_skill_toggle.py --disable    # turn OFF (rare)
  python3 consensus_match_skill_toggle.py              # error: must specify

Exit codes:
  0  → success (toggle applied)
  1  → transport / auth failure
  2  → invalid usage
  3  → 403 (skill not in allow-list — should not happen for consensus-2026)

Output (stdout, JSON on success):
  {"ok": true, "slug": "consensus-2026", "enabled": true,
   "previous_enabled": false, "changed": true}

Telemetry on stderr (toggle.<event> ...).

Pure stdlib Python. No pip install required on the VM.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

TOGGLE_ENDPOINT = "https://instaclaw.io/api/match/v1/skill-toggle"
TIMEOUT_SECONDS = 15
SLUG = "consensus-2026"


def log(msg: str) -> None:
    """Telemetry-friendly stderr logger. Picked up via journald by cron."""
    sys.stderr.write(f"toggle.{msg}\n")
    sys.stderr.flush()


def get_gateway_token() -> str | None:
    """Mirror of the resolution path used by the other VM-side scripts."""
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


def post_toggle(token: str, enabled: bool) -> tuple[int, dict | None]:
    """POST {slug, enabled} to the toggle endpoint."""
    body = {"slug": SLUG, "enabled": enabled}
    req = urllib.request.Request(
        TOGGLE_ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
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
        log(f"transport_error: {e.reason}")
        return 0, None


def main() -> int:
    parser = argparse.ArgumentParser(description="Toggle the consensus-2026 matching skill")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--enable", action="store_true", help="Turn the skill ON")
    group.add_argument("--disable", action="store_true", help="Turn the skill OFF")
    args = parser.parse_args()

    enabled = bool(args.enable)

    token = get_gateway_token()
    if not token:
        log("fatal no_gateway_token")
        return 1

    status, body = post_toggle(token, enabled)
    if status == 200 and body and body.get("ok"):
        log(f"ok slug={body.get('slug')} enabled={body.get('enabled')} changed={body.get('changed')}")
        print(json.dumps(body))
        return 0

    if status == 403:
        log(f"forbidden body={body}")
        return 3

    log(f"failed status={status} body={body}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
