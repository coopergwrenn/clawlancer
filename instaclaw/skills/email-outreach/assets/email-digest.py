#!/usr/bin/env python3
"""
email-digest.py — Daily email digest generator

Usage:
    email-digest.py generate              — Generate and print daily digest
    email-digest.py generate --json       — Output as JSON for programmatic use

Reads from:
    ~/.openclaw/email-config.json  — Agent email config
    ~/.openclaw/.env               — AGENTMAIL_API_KEY
    ~/.openclaw/workspace/USER.md  — VIP sender list

Output: Formatted digest message (Telegram-friendly) or JSON
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

EMAIL_CONFIG = Path.home() / ".openclaw" / "email-config.json"
WORKSPACE = Path.home() / ".openclaw" / "workspace"
ENV_FILE = Path.home() / ".openclaw" / ".env"


def load_env(key: str) -> str:
    """Load env var from environment or .env file."""
    val = os.environ.get(key, "")
    if not val and ENV_FILE.exists():
        try:
            for line in ENV_FILE.read_text().splitlines():
                if line.startswith(f"{key}="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except IOError:
            pass
    return val


def load_email_config() -> dict:
    """Load email configuration."""
    if not EMAIL_CONFIG.exists():
        return {}
    try:
        with open(EMAIL_CONFIG) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}


def load_vip_senders() -> list:
    """Extract VIP sender emails from USER.md."""
    user_md = WORKSPACE / "USER.md"
    if not user_md.exists():
        return []
    try:
        content = user_md.read_text()
        # Look for email addresses in VIP-related sections
        emails = re.findall(r'[\w.+-]+@[\w-]+\.[\w.]+', content)
        return list(set(emails))
    except IOError:
        return []


def api_call(method: str, endpoint: str, api_key: str, data: dict = None) -> dict:
    """Make an API call to AgentMail."""
    config = load_email_config()
    base_url = config.get("api_base", "https://api.agentmail.to/v0")
    url = f"{base_url}{endpoint}"

    cmd = ["curl", "-s", "-X", method, url,
           "-H", f"Authorization: Bearer {api_key}",
           "-H", "Content-Type: application/json"]

    if data:
        cmd.extend(["-d", json.dumps(data)])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0 and result.stdout:
            return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    return {}


def classify_email(email: dict, vip_senders: list) -> str:
    """Classify email priority."""
    sender = email.get("from", "")
    subject = (email.get("subject", "") or "").lower()

    # VIP check
    if any(vip in sender for vip in vip_senders):
        return "CRITICAL"

    # Urgent keywords
    urgent_words = ["urgent", "asap", "deadline", "important", "time-sensitive",
                    "action required", "respond immediately"]
    if any(w in subject for w in urgent_words):
        return "HIGH"

    # Verification / OTP
    otp_words = ["verification", "verify", "confirm", "one-time", "otp", "code"]
    if any(w in subject for w in otp_words):
        return "AUTO"

    # Newsletter / marketing
    marketing_words = ["unsubscribe", "newsletter", "weekly digest", "promotion"]
    body_text = (email.get("body", "") or "").lower()
    if any(w in body_text for w in marketing_words):
        return "LOW"

    return "NORMAL"


def is_auto_reply(email: dict) -> bool:
    """Check if email is an auto-reply."""
    headers = email.get("headers", {})
    if isinstance(headers, dict):
        for key, val in headers.items():
            check = f"{key.lower()}: {str(val).lower()}"
            if any(indicator in check for indicator in [
                "auto-submitted: auto-replied",
                "x-autoreply: yes",
                "x-auto-response-suppress",
                "precedence: auto_reply",
                "precedence: bulk"
            ]):
                return True
    return False


def extract_otp(body: str) -> str:
    """Try to extract OTP/verification code from email body."""
    # 6-digit code
    match = re.search(r'\b(\d{6})\b', body)
    if match:
        return match.group(1)
    # 4-digit code
    match = re.search(r'\b(\d{4})\b', body)
    if match:
        return match.group(1)
    # Magic link
    match = re.search(r'(https?://\S*verify\S*)', body, re.IGNORECASE)
    if match:
        return f"[link: {match.group(1)[:60]}...]"
    return ""


def generate_digest(as_json: bool = False):
    """Generate the daily email digest."""
    api_key = load_env("AGENTMAIL_API_KEY")
    if not api_key:
        print("Error: AGENTMAIL_API_KEY not set")
        sys.exit(1)

    config = load_email_config()
    inbox_id = config.get("inbox_id", "")
    email_addr = config.get("address", "unknown@instaclaw.io")

    if not inbox_id:
        print("Error: No inbox configured (email-config.json missing or empty)")
        sys.exit(1)

    vip_senders = load_vip_senders()

    # Fetch recent messages (last 24 hours)
    messages = api_call("GET", f"/inboxes/{inbox_id}/messages?limit=100", api_key)
    if not isinstance(messages, list):
        messages = messages.get("messages", messages.get("data", []))

    now = datetime.now(timezone.utc)
    today = now.strftime("%b %d, %Y")

    # Classify messages
    urgent = []
    needs_response = []
    auto_handled = []
    spam_filtered = 0
    otps_extracted = []
    total_received = 0
    total_sent = 0

    for msg in messages:
        direction = msg.get("direction", "inbound")

        if direction == "outbound":
            total_sent += 1
            continue

        total_received += 1
        priority = classify_email(msg, vip_senders)

        if is_auto_reply(msg):
            auto_handled.append({"type": "auto-reply skipped", "from": msg.get("from", "")})
            continue

        if priority == "LOW":
            spam_filtered += 1
            continue

        if priority == "AUTO":
            otp = extract_otp(msg.get("body", ""))
            if otp:
                otps_extracted.append({"from": msg.get("from", ""), "code": otp})
            auto_handled.append({"type": "OTP/verification", "from": msg.get("from", "")})
            continue

        if priority in ("CRITICAL", "HIGH"):
            urgent.append({
                "from": msg.get("from", ""),
                "subject": msg.get("subject", "(no subject)"),
                "priority": priority,
                "received": msg.get("created_at", ""),
            })
        else:
            needs_response.append({
                "from": msg.get("from", ""),
                "subject": msg.get("subject", "(no subject)"),
                "received": msg.get("created_at", ""),
            })

    if as_json:
        print(json.dumps({
            "date": today,
            "email": email_addr,
            "urgent": urgent,
            "needs_response": needs_response,
            "auto_handled": auto_handled,
            "otps_extracted": otps_extracted,
            "stats": {
                "received": total_received,
                "sent": total_sent,
                "spam_filtered": spam_filtered,
            }
        }, indent=2))
        return

    # Format as Telegram-friendly text
    lines = [f"Daily Email Digest — {today}", ""]

    if urgent:
        lines.append("URGENT (Action Needed):")
        for u in urgent:
            lines.append(f"  [{u['priority']}] From: {u['from']}")
            lines.append(f"    Subject: {u['subject']}")
        lines.append("")

    if needs_response:
        lines.append("NEW (May Need Response):")
        for n in needs_response[:5]:  # Top 5
            lines.append(f"  From: {n['from']}")
            lines.append(f"    Subject: {n['subject']}")
        if len(needs_response) > 5:
            lines.append(f"  ... and {len(needs_response) - 5} more")
        lines.append("")

    if auto_handled or otps_extracted:
        lines.append("HANDLED AUTONOMOUSLY:")
        if otps_extracted:
            lines.append(f"  {len(otps_extracted)} OTP code(s) extracted")
        for ah in auto_handled[:3]:
            lines.append(f"  {ah['type']} from {ah['from']}")
        lines.append("")

    lines.append("INBOX STATS:")
    lines.append(f"  Agent inbox: {total_received} received, {total_sent} sent")
    lines.append(f"  Spam filtered: {spam_filtered}")
    if urgent:
        lines.append(f"  Priority emails: {len(urgent)}")

    print("\n".join(lines))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "generate":
        as_json = "--json" in sys.argv
        generate_digest(as_json)
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
