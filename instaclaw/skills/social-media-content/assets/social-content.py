#!/usr/bin/env python3
"""
social-content.py — Social media content engine for AI agents

Usage:
    social-content.py generate  --platform <p> --topic <t> [--type thread|update|post] [--subreddit <r>]
    social-content.py calendar  --action show|add|draft [--platform <p>] [--topic <t>] [--day <d>] [--time <t>] [--id <n>]
    social-content.py humanize  --input <text>
    social-content.py trends    --industry <text>

Reads from:
    ~/.openclaw/workspace/USER.md                        — Voice profile
    ~/.openclaw/workspace/social-content/calendar.json   — Content calendar
    ~/.openclaw/.env                                     — BRAVE_SEARCH_API_KEY (optional, for trends)
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

WORKSPACE = Path.home() / ".openclaw" / "workspace"
SOCIAL_DIR = WORKSPACE / "social-content"
CALENDAR_FILE = SOCIAL_DIR / "calendar.json"
ENV_FILE = Path.home() / ".openclaw" / ".env"

# Anti-ChatGPT filter
AI_BANNED_OPENINGS = [
    "in today's fast-paced world",
    "it's no secret that",
    "as we all know",
    "in the ever-evolving landscape",
    "in an era of",
    "it goes without saying",
    "now more than ever",
]

AI_WORD_REPLACEMENTS = {
    "game-changer": "shift",
    "game changer": "shift",
    "unlock": "find",
    "leverage": "use",
    "synergy": "",
    "synergies": "",
    "paradigm": "",
    "paradigm shift": "change",
    "utilize": "use",
    "utilizes": "uses",
    "utilizing": "using",
    "facilitate": "help",
    "facilitates": "helps",
    "groundbreaking": "new",
    "cutting-edge": "modern",
    "cutting edge": "modern",
    "revolutionize": "change",
    "revolutionizing": "changing",
    "seamlessly": "",
    "seamless": "smooth",
    "robust": "solid",
    "innovative": "new",
    "empower": "help",
    "empowering": "helping",
    "holistic": "complete",
    "scalable": "flexible",
    "ecosystem": "system",
    "disruptive": "new",
    "best-in-class": "top",
    "thought leader": "expert",
    "deep dive": "look",
    "move the needle": "make progress",
    "low-hanging fruit": "easy wins",
    "circle back": "revisit",
    "align on": "agree on",
}

CONTRACTION_MAP = {
    "do not": "don't",
    "does not": "doesn't",
    "did not": "didn't",
    "is not": "isn't",
    "are not": "aren't",
    "was not": "wasn't",
    "were not": "weren't",
    "have not": "haven't",
    "has not": "hasn't",
    "had not": "hadn't",
    "will not": "won't",
    "would not": "wouldn't",
    "could not": "couldn't",
    "should not": "shouldn't",
    "cannot": "can't",
    "can not": "can't",
    "it is": "it's",
    "it has": "it's",
    "I am": "I'm",
    "I have": "I've",
    "I will": "I'll",
    "I would": "I'd",
    "we are": "we're",
    "we have": "we've",
    "we will": "we'll",
    "they are": "they're",
    "they have": "they've",
    "that is": "that's",
    "there is": "there's",
    "who is": "who's",
    "what is": "what's",
    "let us": "let's",
}

OPTIMAL_TIMES = {
    "twitter": ["9:00", "12:00", "17:00"],
    "linkedin": ["8:00", "12:00", "16:00"],
    "reddit": ["10:00", "14:00", "20:00"],
    "instagram": ["11:00", "14:00", "19:00"],
}

PLATFORM_TEMPLATES = {
    "twitter_thread": """1/ [Hook — surprising stat or controversial take about {topic}]

2/ [Context — what's happening and why it matters]

3/ [Your experience — specific examples with numbers]
• [Data point 1]
• [Data point 2]
• [Data point 3]

4/ [Insight — what you learned that others haven't]

5/ [Question that drives engagement]

What would you do? 👇""",

    "twitter_single": """[One punchy take about {topic} — under 280 chars]

[Optional: 1 specific number or example]

[CTA or question]""",

    "linkedin_update": """[Bold opening statement about {topic} — 1 line, no fluff]

[2-3 sentence context paragraph with specific numbers]

Here's what I've learned:

→ [Insight 1 with specific number]
→ [Insight 2 with specific number]
→ [Insight 3 with specific number]

[1-2 sentence takeaway]

[Question for engagement]

#Hashtag1 #Hashtag2 #Hashtag3""",

    "reddit_post": """Title: [Specific, descriptive title about {topic} — no clickbait]

Hey r/{subreddit},

[1 paragraph: who you are, what you built, why you're posting]

[2-3 paragraphs: substance — details, numbers, lessons learned]

[What went wrong / what surprised you — be honest]

[Ask for community input — genuine question]

---
Disclosure: This post was drafted by an AI agent and reviewed by a human.""",

    "instagram_caption": """[Attention-grabbing first line about {topic}]

[2-3 sentences with personality and emoji]

[CTA: Save this, share with someone who needs it, link in bio]

.
.
.
[20-30 niche hashtags — research actual community tags, not generic ones]""",
}


def humanize(text: str) -> str:
    """Apply anti-ChatGPT filter to content."""
    result = text

    # Kill generic openings
    lower = result.lower()
    for opening in AI_BANNED_OPENINGS:
        if lower.startswith(opening):
            # Remove the opening phrase and capitalize next word
            result = result[len(opening):].lstrip(" ,.\n")
            if result:
                result = result[0].upper() + result[1:]

    # Replace AI words
    for ai_word, replacement in AI_WORD_REPLACEMENTS.items():
        pattern = re.compile(re.escape(ai_word), re.IGNORECASE)
        if replacement:
            result = pattern.sub(replacement, result)
        else:
            # Delete the word and clean up extra spaces
            result = pattern.sub("", result)

    # Apply contractions
    for formal, contraction in CONTRACTION_MAP.items():
        pattern = re.compile(r'\b' + re.escape(formal) + r'\b', re.IGNORECASE)
        result = pattern.sub(contraction, result)

    # Clean up double spaces
    result = re.sub(r'  +', ' ', result)
    result = re.sub(r'\n +', '\n', result)

    return result.strip()


def load_voice_profile() -> dict:
    """Load voice profile from USER.md."""
    user_md = WORKSPACE / "USER.md"
    if not user_md.exists():
        return {}
    try:
        content = user_md.read_text()
        # Look for voice_profile section
        profile = {}
        in_voice = False
        for line in content.splitlines():
            if "voice_profile" in line.lower():
                in_voice = True
                continue
            if in_voice:
                if line.strip().startswith("-") or ":" in line:
                    parts = line.strip().lstrip("- ").split(":", 1)
                    if len(parts) == 2:
                        profile[parts[0].strip()] = parts[1].strip().strip('"').strip("'")
                elif line.strip() == "" or (not line.startswith(" ") and not line.startswith("\t")):
                    in_voice = False
        return profile
    except IOError:
        return {}


def load_calendar() -> dict:
    """Load content calendar."""
    if not CALENDAR_FILE.exists():
        return {"week_of": "", "posts": []}
    try:
        return json.loads(CALENDAR_FILE.read_text())
    except (json.JSONDecodeError, IOError):
        return {"week_of": "", "posts": []}


def save_calendar(cal: dict):
    """Save content calendar."""
    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)
    CALENDAR_FILE.write_text(json.dumps(cal, indent=2))


def generate_content(platform: str, topic: str, content_type: str = "", subreddit: str = ""):
    """Generate platform-native content."""
    voice = load_voice_profile()

    # Select template
    if platform == "twitter" and content_type == "thread":
        template_key = "twitter_thread"
    elif platform == "twitter":
        template_key = "twitter_single"
    elif platform == "linkedin":
        template_key = "linkedin_update"
    elif platform == "reddit":
        template_key = "reddit_post"
    elif platform == "instagram":
        template_key = "instagram_caption"
    else:
        template_key = "twitter_single"

    template = PLATFORM_TEMPLATES.get(template_key, PLATFORM_TEMPLATES["twitter_single"])
    content = template.format(topic=topic, subreddit=subreddit or "subreddit")

    # Output
    print(f"=== {platform.upper()} Content — {content_type or 'post'} ===")
    print(f"Topic: {topic}")
    if subreddit:
        print(f"Subreddit: r/{subreddit}")
    if voice:
        print(f"Voice profile: {voice.get('tone', 'default')}")
    print()
    print("--- TEMPLATE (fill in brackets) ---")
    print()
    print(content)
    print()
    print("--- INSTRUCTIONS ---")
    print()
    print("1. Fill in every bracketed section with specifics (numbers, examples, real data)")
    print("2. Run the result through: social-content.py humanize --input '<content>'")
    print("3. Review for platform-native feel — does it sound human?")
    print("4. Add to calendar: social-content.py calendar --action add ...")
    print()

    # Platform-specific tips
    if platform == "twitter":
        print("Twitter tips: Keep sentences short. Use line breaks. Emoji okay but not every line.")
        print("Thread hooks that work: surprising stat, controversial take, 'I spent X doing Y'")
    elif platform == "linkedin":
        print("LinkedIn tips: Professional-warm tone. 3-5 hashtags max. Open with bold claim.")
        print("Avoid: exclamation marks, emoji overuse, generic inspiration quotes.")
    elif platform == "reddit":
        print(f"Reddit tips: Be conversational. Self-deprecating humor works. Include failures.")
        print("MANDATORY: Include AI disclosure in footer. Reddit detects and punishes non-disclosure.")
    elif platform == "instagram":
        print("Instagram tips: First line is everything (it's what shows before 'more'). 20-30 hashtags.")
        print("Research actual hashtags your niche uses — generic ones hurt reach.")


def show_calendar():
    """Display the content calendar."""
    cal = load_calendar()
    now = datetime.now(timezone.utc)

    if not cal.get("posts"):
        print(f"Content Calendar — Empty")
        print()
        print("No posts scheduled. Add one:")
        print("  social-content.py calendar --action add --platform twitter --topic 'Topic' --day Monday --time '10:00'")
        return

    print(f"Content Calendar — Week of {cal.get('week_of', now.strftime('%Y-%m-%d'))}")
    print()

    by_status = {"drafted": 0, "approved": 0, "pending_draft": 0, "posted": 0}

    for post in cal["posts"]:
        status_icon = {
            "pending_draft": "📝",
            "drafted": "✏️",
            "approved": "✅",
            "posted": "📤",
            "failed": "❌",
        }.get(post.get("status", ""), "❓")

        platform = post.get("platform", "?")
        day_time = f"{post.get('scheduled', '?')}"
        topic = post.get("topic", "No topic")
        status = post.get("status", "unknown")
        approval = " [Needs Approval]" if post.get("approval_required") else " [Auto]"

        print(f"  {status_icon} #{post.get('id', '?')} | {day_time} — {platform.title()}")
        print(f"     {topic}")
        print(f"     Status: {status}{approval}")
        print()

        by_status[status] = by_status.get(status, 0) + 1

    total = len(cal["posts"])
    approval_needed = sum(1 for p in cal["posts"] if p.get("approval_required") and p.get("status") != "posted")
    print(f"Total: {total} | Needs approval: {approval_needed} | Drafted: {by_status.get('drafted', 0)} | Posted: {by_status.get('posted', 0)}")


def add_to_calendar(platform: str, topic: str, day: str, time: str):
    """Add a post to the content calendar."""
    cal = load_calendar()
    now = datetime.now(timezone.utc)

    if not cal.get("week_of"):
        # Set to current week's Monday
        monday = now - timedelta(days=now.weekday())
        cal["week_of"] = monday.strftime("%Y-%m-%d")

    # Auto-increment ID
    max_id = max([p.get("id", 0) for p in cal.get("posts", [])] or [0])
    new_id = max_id + 1

    # Determine approval requirement
    needs_approval = platform != "reddit"

    post = {
        "id": new_id,
        "platform": platform,
        "scheduled": f"{day} {time}",
        "type": "post",
        "topic": topic,
        "status": "pending_draft",
        "content": "",
        "approval_required": needs_approval,
        "created_at": now.isoformat(),
    }

    cal["posts"].append(post)
    save_calendar(cal)

    print(f"Added to calendar: #{new_id}")
    print(f"  Platform: {platform}")
    print(f"  Scheduled: {day} {time}")
    print(f"  Topic: {topic}")
    print(f"  Approval: {'Required' if needs_approval else 'Auto (Reddit)'}")
    print()
    print(f"Generate draft: social-content.py calendar --action draft --id {new_id}")


def draft_calendar_item(item_id: int):
    """Generate a draft for a calendar item."""
    cal = load_calendar()

    post = None
    for p in cal.get("posts", []):
        if p.get("id") == item_id:
            post = p
            break

    if not post:
        print(f"Calendar item #{item_id} not found")
        return

    print(f"Generating draft for #{item_id}: {post.get('topic', '?')}")
    print()
    generate_content(
        platform=post.get("platform", "twitter"),
        topic=post.get("topic", ""),
        content_type=post.get("type", "post"),
    )

    # Update status
    post["status"] = "drafted"
    save_calendar(cal)
    print()
    print(f"Calendar item #{item_id} marked as 'drafted'")


def detect_trends(industry: str):
    """Detect trending topics using Brave Search."""
    api_key = ""
    if ENV_FILE.exists():
        try:
            for line in ENV_FILE.read_text().splitlines():
                if line.startswith("BRAVE_SEARCH_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except IOError:
            pass

    if not api_key:
        print("Trend detection requires BRAVE_SEARCH_API_KEY.")
        print("Without it, here are default content angles for your industry:")
        print()
        print(f"Industry: {industry}")
        print()
        print("Evergreen content angles:")
        print("  1. 'How I built X' — behind-the-scenes technical posts")
        print("  2. 'X days of Y' — progress updates with real numbers")
        print("  3. 'What went wrong' — failure stories (high engagement)")
        print("  4. 'Surprising thing about X' — counterintuitive insights")
        print("  5. 'X vs Y' — comparison content drives debate")
        return

    # Use Brave Search via competitive-intel.sh (already deployed)
    intel_script = Path.home() / "scripts" / "competitive-intel.sh"
    if not intel_script.exists():
        print("competitive-intel.sh not found. Install competitive-intelligence skill first.")
        return

    env = os.environ.copy()
    env["BRAVE_SEARCH_API_KEY"] = api_key

    try:
        result = subprocess.run(
            [str(intel_script), "search", "--query", f"{industry} trends 2026", "--count", "20", "--freshness", "pw"],
            capture_output=True, text=True, timeout=30, env=env,
        )
        if result.returncode == 0 and result.stdout:
            data = json.loads(result.stdout)
            results = data.get("web", {}).get("results", [])

            print(f"Trending in '{industry}' (past week):")
            print()
            for i, r in enumerate(results[:10], 1):
                print(f"  {i}. {r.get('title', 'No title')}")
                print(f"     {r.get('url', '')}")
                if r.get("age"):
                    print(f"     Age: {r['age']}")
                print()

            print("Content opportunities:")
            print("  - React to the top trending story with your unique angle")
            print("  - Create a thread summarizing the top 3 developments")
            print("  - Write a contrarian take on the most popular narrative")
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(f"Trend detection failed: {e}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Social media content engine")
    subparsers = parser.add_subparsers(dest="command")

    # generate
    p_gen = subparsers.add_parser("generate")
    p_gen.add_argument("--platform", required=True, choices=["twitter", "linkedin", "reddit", "instagram", "tiktok"])
    p_gen.add_argument("--topic", required=True)
    p_gen.add_argument("--type", default="post", choices=["thread", "update", "post", "caption"])
    p_gen.add_argument("--subreddit", default="")

    # calendar
    p_cal = subparsers.add_parser("calendar")
    p_cal.add_argument("--action", required=True, choices=["show", "add", "draft"])
    p_cal.add_argument("--platform", default="twitter")
    p_cal.add_argument("--topic", default="")
    p_cal.add_argument("--day", default="Monday")
    p_cal.add_argument("--time", default="10:00")
    p_cal.add_argument("--id", type=int, default=0)

    # humanize
    p_hum = subparsers.add_parser("humanize")
    p_hum.add_argument("--input", required=True)

    # trends
    p_trends = subparsers.add_parser("trends")
    p_trends.add_argument("--industry", required=True)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    SOCIAL_DIR.mkdir(parents=True, exist_ok=True)

    if args.command == "generate":
        generate_content(args.platform, args.topic, args.type, args.subreddit)
    elif args.command == "calendar":
        if args.action == "show":
            show_calendar()
        elif args.action == "add":
            if not args.topic:
                print("--topic required for calendar add")
                sys.exit(1)
            add_to_calendar(args.platform, args.topic, args.day, args.time)
        elif args.action == "draft":
            if not args.id:
                print("--id required for calendar draft")
                sys.exit(1)
            draft_calendar_item(args.id)
    elif args.command == "humanize":
        result = humanize(args.input)
        print(result)
    elif args.command == "trends":
        detect_trends(args.industry)


if __name__ == "__main__":
    main()
