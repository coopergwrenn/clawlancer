#!/usr/bin/env python3
"""
email-safety-check.py — Pre-send email safety validator

Usage:
    email-safety-check.py --to <addr> --subject <subj> --body <text>
    email-safety-check.py --rate-status
    email-safety-check.py --log-send --to <addr>

Exit codes:
    0  — OK or WARN (safe to send, but review may be recommended)
    2  — BLOCK (must not send)

Data stored in: ~/.openclaw/workspace/email-sends.json
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

WORKSPACE = Path.home() / ".openclaw" / "workspace"
SENDS_FILE = WORKSPACE / "email-sends.json"
EMAIL_CONFIG = Path.home() / ".openclaw" / "email-config.json"

# Credential patterns — NEVER allow these in outbound email
CREDENTIAL_PATTERNS = [
    (r'sk-[a-zA-Z0-9]{32,}', 'OpenAI API key'),
    (r'sk_[a-zA-Z0-9]{20,}', 'ElevenLabs/Stripe key'),
    (r'brv_[a-zA-Z0-9]+', 'Brave API key'),
    (r'ghp_[a-zA-Z0-9]{36}', 'GitHub PAT'),
    (r'gho_[a-zA-Z0-9]{36}', 'GitHub OAuth token'),
    (r'glpat-[a-zA-Z0-9\-]{20,}', 'GitLab PAT'),
    (r'xox[bpoas]-[a-zA-Z0-9\-]+', 'Slack token'),
    (r'Bearer\s+[a-zA-Z0-9\._\-]{20,}', 'Bearer token'),
    (r'AKIA[0-9A-Z]{16}', 'AWS access key'),
    (r'eyJ[a-zA-Z0-9_\-]{50,}\.eyJ', 'JWT token'),
    (r'password\s*[=:]\s*\S{6,}', 'Password value'),
    (r'API[_\-]?KEY\s*[=:]\s*[a-zA-Z0-9]{10,}', 'API key value'),
]

# Sensitive content patterns — require human approval
SENSITIVE_PATTERNS = [
    (r'\$\d{4,}', 'Dollar amount > $999'),
    (r'lawsuit|legal\s+action|attorney|litigation', 'Legal language'),
    (r'confidential|privileged|do\s+not\s+share', 'Confidentiality marker'),
    (r'terminate|fire\s+you|resign', 'Employment action'),
    (r'credit\s+card\s+\d', 'Credit card number'),
    (r'\b\d{3}-\d{2}-\d{4}\b', 'SSN pattern'),
]

# Auto-reply headers to detect
AUTO_REPLY_INDICATORS = [
    'auto-submitted: auto-replied',
    'x-autoreply: yes',
    'x-auto-response-suppress: all',
    'precedence: auto_reply',
    'precedence: bulk',
]

# Spam trigger words for cold outreach
SPAM_TRIGGERS = [
    'free money', 'act now', 'limited time', 'click here',
    'no obligation', 'guaranteed', 'winner', 'congratulations',
    'urgent action required', 'double your', 'make money fast',
]

# Rate limits
RATE_LIMITS = {
    "cold_outreach": 20,
    "known_contacts": 100,
    "total_daily": 200,
}

# Warmup schedule (days since inbox creation)
WARMUP_SCHEDULE = [
    (7, 10),    # Week 1: 10/day
    (14, 25),   # Week 2: 25/day
    (21, 50),   # Week 3: 50/day
]


def load_sends() -> dict:
    """Load send history."""
    if not SENDS_FILE.exists():
        return new_sends()
    try:
        with open(SENDS_FILE) as f:
            data = json.load(f)
        # Reset if day changed
        now = datetime.now(timezone.utc)
        if data.get("today") != now.strftime("%Y-%m-%d"):
            old_total = data.get("total_all_time", 0)
            data = new_sends()
            data["total_all_time"] = old_total
        return data
    except (json.JSONDecodeError, IOError):
        return new_sends()


def new_sends() -> dict:
    now = datetime.now(timezone.utc)
    return {
        "today": now.strftime("%Y-%m-%d"),
        "sends_today": 0,
        "cold_today": 0,
        "recipients_today": [],
        "total_all_time": 0,
        "history": [],
    }


def save_sends(data: dict):
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    with open(SENDS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def get_daily_limit() -> int:
    """Get effective daily limit (may be reduced by warmup schedule)."""
    try:
        with open(EMAIL_CONFIG) as f:
            config = json.load(f)
        created = config.get("created_at", "")
        if created:
            created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
            days_active = (datetime.now(timezone.utc) - created_dt).days
            for threshold_days, limit in WARMUP_SCHEDULE:
                if days_active < threshold_days:
                    return limit
    except (json.JSONDecodeError, IOError, ValueError):
        pass
    return RATE_LIMITS["total_daily"]


def check_credentials(text: str) -> list:
    """Check for credential leaks. Returns list of (pattern_name, match)."""
    findings = []
    for pattern, name in CREDENTIAL_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            findings.append((name, matches[0][:20] + "..."))
    return findings


def check_sensitive(text: str) -> list:
    """Check for sensitive content. Returns list of (pattern_name, match)."""
    findings = []
    for pattern, name in SENSITIVE_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            findings.append((name, matches[0]))
    return findings


def check_spam_triggers(text: str) -> list:
    """Check for spam trigger words."""
    text_lower = text.lower()
    return [word for word in SPAM_TRIGGERS if word in text_lower]


def check_rate_limit() -> tuple:
    """Check if rate limit allows sending. Returns (ok: bool, reason: str)."""
    sends = load_sends()
    daily_limit = get_daily_limit()

    if sends["sends_today"] >= daily_limit:
        return False, f"Daily limit reached ({sends['sends_today']}/{daily_limit})"
    if sends["sends_today"] >= RATE_LIMITS["total_daily"]:
        return False, f"Hard daily cap reached ({RATE_LIMITS['total_daily']})"

    return True, f"{sends['sends_today']}/{daily_limit} sends today"


def cmd_check(to: str, subject: str, body: str):
    """Run all pre-send checks."""
    full_text = f"{subject}\n{body}"
    issues = []
    blocks = []

    # 1. Credential check (BLOCK)
    creds = check_credentials(full_text)
    if creds:
        for name, match in creds:
            blocks.append(f"CREDENTIAL_LEAK: {name} detected ({match})")

    # 2. Sensitive content (WARN — may need approval)
    sensitive = check_sensitive(full_text)
    if sensitive:
        for name, match in sensitive:
            issues.append(f"SENSITIVE: {name} — '{match}'")

    # 3. Spam triggers (WARN)
    spam = check_spam_triggers(full_text)
    if spam:
        issues.append(f"SPAM_TRIGGERS: {', '.join(spam)}")

    # 4. Rate limit (BLOCK if exceeded)
    rate_ok, rate_msg = check_rate_limit()
    if not rate_ok:
        blocks.append(f"RATE_LIMIT: {rate_msg}")

    # 5. Empty recipient or subject (BLOCK)
    if not to or not to.strip():
        blocks.append("NO_RECIPIENT: Missing email recipient")
    if not subject or not subject.strip():
        issues.append("NO_SUBJECT: Email has no subject line")

    # Output result
    if blocks:
        print(f"BLOCK — {len(blocks)} critical issue(s):")
        for b in blocks:
            print(f"  ✗ {b}")
        if issues:
            print(f"\nAlso found {len(issues)} warning(s):")
            for w in issues:
                print(f"  ⚠ {w}")
        sys.exit(2)
    elif issues:
        print(f"WARN — {len(issues)} issue(s) found (review recommended):")
        for w in issues:
            print(f"  ⚠ {w}")
        sys.exit(0)
    else:
        print(f"OK — All checks passed. {rate_ok and rate_msg or ''}")
        sys.exit(0)


def cmd_rate_status():
    """Show current rate limit status."""
    sends = load_sends()
    daily_limit = get_daily_limit()

    print("=== Email Rate Limit Status ===")
    print(f"Date:           {sends['today']}")
    print(f"Sends today:    {sends['sends_today']} / {daily_limit}")
    print(f"Cold today:     {sends['cold_today']} / {RATE_LIMITS['cold_outreach']}")
    print(f"Total all-time: {sends['total_all_time']}")
    print(f"Unique recipients today: {len(sends.get('recipients_today', []))}")

    if daily_limit < RATE_LIMITS["total_daily"]:
        print(f"\nWARMUP ACTIVE: Limit reduced to {daily_limit}/day (full: {RATE_LIMITS['total_daily']})")

    pct = (sends['sends_today'] / daily_limit * 100) if daily_limit > 0 else 0
    if pct >= 90:
        print(f"\nWARNING: At {pct:.0f}% of daily limit!")
    elif pct >= 75:
        print(f"\nNote: At {pct:.0f}% of daily limit")

    # Show last 5 sends
    history = sends.get("history", [])
    if history:
        print("\nRecent sends:")
        for entry in history[-5:]:
            print(f"  {entry.get('timestamp', '')[:19]} → {entry.get('to', 'unknown')}")


def cmd_log_send(to: str):
    """Log a send for rate limiting."""
    sends = load_sends()
    sends["sends_today"] += 1
    sends["total_all_time"] = sends.get("total_all_time", 0) + 1

    if to not in sends.get("recipients_today", []):
        sends.setdefault("recipients_today", []).append(to)

    sends.setdefault("history", []).append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "to": to,
    })
    # Keep last 100 entries
    sends["history"] = sends["history"][-100:]

    save_sends(sends)


def main():
    parser = argparse.ArgumentParser(description="Email pre-send safety checker")
    parser.add_argument("--to", help="Recipient email address")
    parser.add_argument("--subject", help="Email subject")
    parser.add_argument("--body", help="Email body text")
    parser.add_argument("--rate-status", action="store_true", help="Show rate limit status")
    parser.add_argument("--log-send", action="store_true", help="Log a send for rate limiting")
    args = parser.parse_args()

    if args.rate_status:
        cmd_rate_status()
    elif args.log_send:
        if not args.to:
            print("Usage: --log-send --to <addr>")
            sys.exit(1)
        cmd_log_send(args.to)
    elif args.to and args.body:
        cmd_check(args.to, args.subject or "", args.body)
    else:
        print("Usage:")
        print("  email-safety-check.py --to <addr> --subject <subj> --body <text>")
        print("  email-safety-check.py --rate-status")
        print("  email-safety-check.py --log-send --to <addr>")
        sys.exit(1)


if __name__ == "__main__":
    main()
