#!/usr/bin/env python3
"""
audio-usage-tracker.py — Track TTS usage against monthly limits

Usage:
    audio-usage-tracker.py track <chars> <provider>   — Log a generation
    audio-usage-tracker.py check <chars>              — Check if budget allows
    audio-usage-tracker.py status                     — Show current usage
    audio-usage-tracker.py reset                      — Reset monthly counters

Data stored in: ~/.openclaw/workspace/audio-usage.json
Config loaded from: ~/.openclaw/audio-config.json
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

WORKSPACE = Path.home() / ".openclaw" / "workspace"
USAGE_FILE = WORKSPACE / "audio-usage.json"
CONFIG_FILE = Path.home() / ".openclaw" / "audio-config.json"

# Default config (overridden by audio-config.json if present)
DEFAULT_CONFIG = {
    "tier": "free_starter",
    "primary_provider": "openai",
    "fallback_provider": "openai",
    "monthly_chars": 450000,       # ~30 min at 150 wpm
    "daily_max_requests": 10,
    "max_single_request": 5000,    # chars
    "alert_at_percent": 80,
    "overage_action": "fallback_to_openai"
}

TIER_LIMITS = {
    "free_starter": {
        "monthly_chars": 450000,
        "daily_max_requests": 10,
        "max_single_request": 5000,
        "primary_provider": "openai"
    },
    "pro": {
        "monthly_chars": 1800000,
        "daily_max_requests": 50,
        "max_single_request": 15000,
        "primary_provider": "elevenlabs"
    },
    "power": {
        "monthly_chars": 7200000,
        "daily_max_requests": 200,
        "max_single_request": 50000,
        "primary_provider": "elevenlabs"
    },
    "byok": {
        "monthly_chars": 999999999,  # Unlimited
        "daily_max_requests": 999999,
        "max_single_request": 999999,
        "primary_provider": "user_choice"
    }
}

# Cost per 1000 characters (approximate)
COST_PER_1K = {
    "openai": 0.015,
    "elevenlabs": 0.30   # Creator plan: $22/100k chars
}


def load_config() -> dict:
    """Load tier config from audio-config.json or use defaults."""
    config = DEFAULT_CONFIG.copy()
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                user_config = json.load(f)
            config.update(user_config)
            # Apply tier limits if tier is specified
            tier = config.get("tier", "free_starter")
            if tier in TIER_LIMITS:
                for k, v in TIER_LIMITS[tier].items():
                    if k not in user_config:  # Don't override explicit overrides
                        config[k] = v
        except (json.JSONDecodeError, IOError):
            pass
    return config


def load_usage() -> dict:
    """Load current usage data."""
    if not USAGE_FILE.exists():
        return new_usage()
    try:
        with open(USAGE_FILE) as f:
            data = json.load(f)
        # Check if month rolled over
        now = datetime.now(timezone.utc)
        if data.get("month") != now.strftime("%Y-%m"):
            return new_usage()
        # Check if day rolled over
        if data.get("today") != now.strftime("%Y-%m-%d"):
            data["chars_today"] = 0
            data["requests_today"] = 0
            data["today"] = now.strftime("%Y-%m-%d")
        return data
    except (json.JSONDecodeError, IOError):
        return new_usage()


def new_usage() -> dict:
    """Create fresh usage tracking data."""
    now = datetime.now(timezone.utc)
    return {
        "month": now.strftime("%Y-%m"),
        "today": now.strftime("%Y-%m-%d"),
        "chars_this_month": 0,
        "chars_today": 0,
        "requests_this_month": 0,
        "requests_today": 0,
        "estimated_cost_this_month": 0.0,
        "history": []
    }


def save_usage(data: dict):
    """Save usage data."""
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    with open(USAGE_FILE, "w") as f:
        json.dump(data, f, indent=2)


def cmd_track(chars: int, provider: str):
    """Log a TTS generation."""
    config = load_config()
    usage = load_usage()

    cost = (chars / 1000) * COST_PER_1K.get(provider, 0.015)

    usage["chars_this_month"] += chars
    usage["chars_today"] += chars
    usage["requests_this_month"] += 1
    usage["requests_today"] += 1
    usage["estimated_cost_this_month"] += cost

    # Keep last 50 entries in history
    usage["history"] = usage.get("history", [])[-49:] + [{
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "chars": chars,
        "provider": provider,
        "cost": round(cost, 4)
    }]

    save_usage(usage)

    pct = (usage["chars_this_month"] / config["monthly_chars"]) * 100
    print(f"Tracked: {chars} chars via {provider} (${cost:.4f})")
    print(f"Monthly: {usage['chars_this_month']:,}/{config['monthly_chars']:,} chars ({pct:.1f}%)")

    if pct >= config["alert_at_percent"]:
        print(f"WARNING: At {pct:.0f}% of monthly limit!")
        if pct >= 100:
            print(f"Action: {config['overage_action']}")


def cmd_check(chars: int):
    """Check if budget allows generating this many characters."""
    config = load_config()
    usage = load_usage()

    monthly_remaining = config["monthly_chars"] - usage["chars_this_month"]
    daily_requests_remaining = config["daily_max_requests"] - usage["requests_today"]
    pct = (usage["chars_this_month"] / config["monthly_chars"]) * 100

    # Check single request limit
    if chars > config["max_single_request"]:
        print(f"SPLIT — {chars} chars exceeds single request limit of {config['max_single_request']}. Split into segments.")
        # Don't exit — splitting is handled by the TTS scripts

    # Check daily request limit
    if daily_requests_remaining <= 0:
        print(f"WAIT — Daily request limit reached ({config['daily_max_requests']}). Try again tomorrow.")
        sys.exit(2)

    # Check monthly budget
    if chars > monthly_remaining:
        if config["overage_action"] == "fallback_to_openai":
            print(f"FALLBACK — Monthly limit exceeded ({pct:.0f}%). Use OpenAI TTS instead of ElevenLabs.")
            sys.exit(0)  # Exit 0 — fallback is OK
        else:
            print(f"OVER — Monthly limit exceeded. {usage['chars_this_month']:,}/{config['monthly_chars']:,} chars used.")
            sys.exit(2)

    # Budget OK
    if pct >= config["alert_at_percent"]:
        print(f"WARN — {usage['chars_this_month']:,}/{config['monthly_chars']:,} chars used ({pct:.1f}%), {monthly_remaining:,} remaining")
    else:
        print(f"OK — {usage['chars_this_month']:,}/{config['monthly_chars']:,} chars used ({pct:.1f}%), {monthly_remaining:,} remaining")

    # Suggest provider
    provider = config.get("primary_provider", "openai")
    if pct >= 90 and provider == "elevenlabs":
        print(f"Suggestion: Consider OpenAI TTS to preserve ElevenLabs budget")


def cmd_status():
    """Show current usage status."""
    config = load_config()
    usage = load_usage()
    pct = (usage["chars_this_month"] / config["monthly_chars"]) * 100

    print(f"=== Audio Usage Status ===")
    print(f"Tier:           {config['tier']}")
    print(f"Provider:       {config.get('primary_provider', 'openai')}")
    print(f"Month:          {usage['month']}")
    print(f"")
    print(f"Monthly chars:  {usage['chars_this_month']:,} / {config['monthly_chars']:,} ({pct:.1f}%)")
    print(f"Today chars:    {usage['chars_today']:,}")
    print(f"Monthly reqs:   {usage['requests_this_month']}")
    print(f"Today reqs:     {usage['requests_today']} / {config['daily_max_requests']}")
    print(f"Est. cost:      ${usage['estimated_cost_this_month']:.2f}")
    print(f"")

    if pct >= 100:
        print(f"STATUS: OVER LIMIT — {config['overage_action']}")
    elif pct >= config["alert_at_percent"]:
        print(f"STATUS: WARNING — approaching limit")
    else:
        print(f"STATUS: OK")

    # Show last 5 entries
    history = usage.get("history", [])
    if history:
        print(f"\nRecent generations:")
        for entry in history[-5:]:
            ts = entry.get("timestamp", "")[:19]
            print(f"  {ts} — {entry['chars']:,} chars via {entry['provider']} (${entry['cost']:.4f})")


def cmd_reset():
    """Reset monthly counters."""
    usage = new_usage()
    save_usage(usage)
    print("Usage counters reset.")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "track":
        if len(sys.argv) < 4:
            print("Usage: audio-usage-tracker.py track <chars> <provider>")
            sys.exit(1)
        cmd_track(int(sys.argv[2]), sys.argv[3])

    elif cmd == "check":
        if len(sys.argv) < 3:
            print("Usage: audio-usage-tracker.py check <chars>")
            sys.exit(1)
        cmd_check(int(sys.argv[2]))

    elif cmd == "status":
        cmd_status()

    elif cmd == "reset":
        cmd_reset()

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
