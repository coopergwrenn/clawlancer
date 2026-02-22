#!/usr/bin/env python3
"""
competitive-intel.py — Competitive intelligence analysis engine

Usage:
    competitive-intel.py digest                                — Generate daily digest
    competitive-intel.py weekly-report                         — Generate weekly report
    competitive-intel.py scan                                  — Run full competitor scan
    competitive-intel.py compare --competitor <name> --category <cat>  — Compare snapshots
    competitive-intel.py init --competitor <name> --domain <domain>    — Add competitor
    competitive-intel.py rate-status                            — Show API usage

Reads from:
    ~/.openclaw/.env                                    — BRAVE_SEARCH_API_KEY
    ~/.openclaw/workspace/competitive-intel/config.json — Competitor config
    ~/.openclaw/workspace/competitive-intel/snapshots/  — Historical data
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ENV_FILE = Path.home() / ".openclaw" / ".env"
WORKSPACE = Path.home() / ".openclaw" / "workspace" / "competitive-intel"
CONFIG_FILE = WORKSPACE / "config.json"
SNAPSHOT_DIR = WORKSPACE / "snapshots"
REPORT_DIR = WORKSPACE / "reports"
CACHE_DIR = Path.home() / ".openclaw" / "cache" / "brave-search"
RATE_FILE = CACHE_DIR / ".rate-log"
DAILY_BUDGET = 200


def load_api_key() -> str:
    """Load Brave Search API key."""
    key = os.environ.get("BRAVE_SEARCH_API_KEY", "")
    if not key and ENV_FILE.exists():
        try:
            for line in ENV_FILE.read_text().splitlines():
                if line.startswith("BRAVE_SEARCH_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except IOError:
            pass
    return key


def load_config() -> dict:
    """Load competitor monitoring configuration."""
    if not CONFIG_FILE.exists():
        return {"competitors": [], "delivery": {"daily_digest": True, "weekly_report": True}}
    try:
        return json.loads(CONFIG_FILE.read_text())
    except (json.JSONDecodeError, IOError):
        return {"competitors": [], "delivery": {}}


def save_config(config: dict):
    """Save competitor config."""
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(config, indent=2))


def get_daily_count() -> int:
    """Get today's API request count."""
    if not RATE_FILE.exists():
        return 0
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        return sum(1 for line in RATE_FILE.read_text().splitlines() if line.startswith(today))
    except IOError:
        return 0


def brave_search(query: str, api_key: str, count: int = 10, freshness: str = "") -> dict:
    """Run a Brave Search query via the shell helper."""
    cmd = [str(Path.home() / "scripts" / "competitive-intel.sh"), "search",
           "--query", query, "--count", str(count)]
    if freshness:
        cmd.extend(["--freshness", freshness])

    env = os.environ.copy()
    env["BRAVE_SEARCH_API_KEY"] = api_key

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
        if result.returncode == 0 and result.stdout:
            return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    return {}


def load_snapshot(competitor: str, category: str, date: str = None) -> dict:
    """Load a stored snapshot."""
    comp_lower = competitor.lower().replace(" ", "-")
    if date:
        filename = f"{date}-{comp_lower}-{category}.json"
    else:
        # Find most recent
        pattern = f"-{comp_lower}-{category}.json"
        candidates = sorted(
            [f for f in SNAPSHOT_DIR.iterdir() if f.name.endswith(pattern)],
            reverse=True
        ) if SNAPSHOT_DIR.exists() else []
        if not candidates:
            return {}
        filename = candidates[0].name

    filepath = SNAPSHOT_DIR / filename
    if filepath.exists():
        try:
            return json.loads(filepath.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def load_previous_snapshot(competitor: str, category: str) -> dict:
    """Load the second-most-recent snapshot (for comparison)."""
    comp_lower = competitor.lower().replace(" ", "-")
    pattern = f"-{comp_lower}-{category}.json"
    candidates = sorted(
        [f for f in SNAPSHOT_DIR.iterdir() if f.name.endswith(pattern)],
        reverse=True
    ) if SNAPSHOT_DIR.exists() else []
    if len(candidates) < 2:
        return {}
    try:
        return json.loads(candidates[1].read_text())
    except (json.JSONDecodeError, IOError):
        return {}


def extract_search_results(data: dict) -> list:
    """Extract results from Brave Search response."""
    results = []
    for item in data.get("web", {}).get("results", []):
        results.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "description": item.get("description", ""),
            "age": item.get("age", ""),
        })
    return results


def analyze_sentiment(results: list) -> dict:
    """Basic sentiment analysis on search results."""
    positive_words = ["love", "amazing", "great", "best", "excellent", "impressed",
                      "recommend", "fantastic", "innovative", "gem", "bullish", "moon"]
    negative_words = ["hate", "terrible", "worst", "disappointed", "broken", "scam",
                      "switching", "leaving", "frustrating", "rug", "bearish", "dead"]

    pos = neg = neu = 0
    for r in results:
        text = (r.get("title", "") + " " + r.get("description", "")).lower()
        has_pos = any(w in text for w in positive_words)
        has_neg = any(w in text for w in negative_words)
        if has_pos and not has_neg:
            pos += 1
        elif has_neg and not has_pos:
            neg += 1
        else:
            neu += 1

    total = pos + neg + neu
    return {
        "total": total,
        "positive": pos,
        "negative": neg,
        "neutral": neu,
        "positive_pct": round(pos / total * 100) if total > 0 else 0,
        "negative_pct": round(neg / total * 100) if total > 0 else 0,
    }


def generate_digest(api_key: str):
    """Generate daily competitive intelligence digest."""
    config = load_config()
    competitors = config.get("competitors", [])

    if not competitors:
        print("No competitors configured. Run: competitive-intel.py init --competitor <name> --domain <domain>")
        return

    now = datetime.now(timezone.utc)
    today = now.strftime("%b %d, %Y")

    urgent = []
    pricing = []
    mentions = []
    content = []

    for comp in competitors:
        name = comp["name"]
        domain = comp.get("domain", "")

        # Pricing change detection via snapshot comparison
        try:
            snapshot_changes = compare_snapshots(name, "pricing")
            if snapshot_changes:
                for change in snapshot_changes:
                    if change.get("type") == "pricing":
                        plan = change.get("plan", "unknown")
                        old_p = change.get("old", "?")
                        new_p = change.get("new", "?")
                        pct = change.get("pct")
                        pct_str = f" ({pct:+.1f}%)" if pct else ""
                        pricing.append(f"{name}: {plan} {old_p} → {new_p}{pct_str}")
                        # Pricing changes >10% are urgent
                        if pct and abs(pct) > 10:
                            urgent.append({"competitor": name,
                                           "title": f"Pricing change: {plan} {old_p} → {new_p} ({pct:+.1f}%)",
                                           "url": comp.get("urls", {}).get("pricing", ""), "age": "today"})
        except Exception:
            pass  # No snapshots available yet — skip pricing comparison

        # Content scan — new blog/changelog posts
        if domain:
            results = brave_search(f"site:{domain}/blog OR site:{domain}/changelog", api_key, count=5, freshness="pd")
            posts = extract_search_results(results)
            for post in posts:
                content.append({"competitor": name, "title": post["title"], "url": post["url"]})

        # Funding/major news check
        news_results = brave_search(f'"{name}" funding OR raised OR launch OR acquired', api_key, count=5, freshness="pd")
        news_items = extract_search_results(news_results)
        for item in news_items:
            title_lower = item["title"].lower()
            if any(w in title_lower for w in ["funding", "raised", "series", "acquired", "acquisition", "launch"]):
                urgent.append({"competitor": name, "title": item["title"], "url": item["url"], "age": item.get("age", "")})

        # Social mentions
        mention_results = brave_search(f'"{name}"', api_key, count=10, freshness="pd")
        mention_items = extract_search_results(mention_results)
        sentiment = analyze_sentiment(mention_items)
        if sentiment["total"] > 0:
            mentions.append({
                "competitor": name,
                "count": sentiment["total"],
                "positive_pct": sentiment["positive_pct"],
                "negative_pct": sentiment["negative_pct"],
            })

    # Format digest
    lines = [f"Daily Competitive Intel — {today}", ""]

    if urgent:
        lines.append("URGENT:")
        for u in urgent:
            age_str = f" — {u['age']}" if u.get("age") else ""
            lines.append(f"  * {u['competitor']}: {u['title']}{age_str}")
        lines.append("")

    lines.append("PRICING:")
    if pricing:
        for p in pricing:
            lines.append(f"  * {p}")
    else:
        lines.append("  No changes detected")
    lines.append("")

    if mentions:
        lines.append("MENTIONS (24h):")
        for m in mentions:
            lines.append(f"  * {m['competitor']}: {m['count']} mentions")
            lines.append(f"    Positive: {m['positive_pct']}% | Negative: {m['negative_pct']}%")
        lines.append("")

    if content:
        lines.append("CONTENT:")
        for c in content[:5]:
            lines.append(f"  * {c['competitor']}: {c['title']}")
        lines.append("")

    print("\n".join(lines))

    # Save report
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_file = REPORT_DIR / f"daily-{now.strftime('%Y-%m-%d')}.txt"
    report_file.write_text("\n".join(lines))


def generate_weekly_report(api_key: str):
    """Generate weekly deep-dive report."""
    config = load_config()
    competitors = config.get("competitors", [])

    if not competitors:
        print("No competitors configured.")
        return

    now = datetime.now(timezone.utc)
    week_start = (now - timedelta(days=7)).strftime("%b %d")
    week_end = now.strftime("%b %d, %Y")

    lines = [
        f"Weekly Competitive Intelligence Report",
        f"Week of {week_start} - {week_end}",
        "",
        "=" * 50,
    ]

    # Collect data for all competitors first
    competitor_data = []
    key_developments = []
    pricing_matrix = []

    for comp in competitors:
        name = comp["name"]
        domain = comp.get("domain", "")
        priority = comp.get("priority", "secondary")

        comp_info = {"name": name, "priority": priority, "news": [], "sentiment": {}, "jobs": 0, "pricing_changes": []}

        # Search for week's news
        news = brave_search(f'"{name}" announcement OR launch OR funding', api_key, count=10, freshness="pw")
        news_items = extract_search_results(news)
        comp_info["news"] = news_items[:5]
        for item in news_items[:2]:
            key_developments.append(f"{name}: {item['title']}")

        # Mentions sentiment
        mention_data = brave_search(f'"{name}"', api_key, count=20, freshness="pw")
        mention_items = extract_search_results(mention_data)
        comp_info["sentiment"] = analyze_sentiment(mention_items)

        # Hiring
        jobs = brave_search(f'site:linkedin.com/jobs "{name}"', api_key, count=5, freshness="pw")
        job_items = extract_search_results(jobs)
        comp_info["jobs"] = len(job_items)
        comp_info["job_titles"] = [j["title"] for j in job_items[:3]]
        if len(job_items) >= 5:
            key_developments.append(f"{name}: Major hiring push ({len(job_items)}+ openings)")

        # Pricing snapshot comparison
        try:
            snapshot_changes = compare_snapshots(name, "pricing")
            if snapshot_changes:
                for c in snapshot_changes:
                    if c.get("type") == "pricing":
                        pricing_matrix.append({"competitor": name, **c})
                        comp_info["pricing_changes"].append(c)
        except Exception:
            pass

        competitor_data.append(comp_info)

    # ── EXECUTIVE SUMMARY ──
    lines.extend([
        "",
        "EXECUTIVE SUMMARY",
        "-" * 30,
    ])

    if key_developments:
        lines.append(f"Top {min(3, len(key_developments))} developments this week:")
        for dev in key_developments[:3]:
            lines.append(f"  1. {dev}")
    else:
        lines.append("  No major developments this week.")
    lines.append("")

    # ── PRICING MATRIX ──
    lines.extend([
        "=" * 50,
        "",
        "PRICING MATRIX",
        "-" * 30,
    ])

    if pricing_matrix:
        for pm in pricing_matrix:
            plan = pm.get("plan", "?")
            old_p = pm.get("old", "?")
            new_p = pm.get("new", "?")
            pct = pm.get("pct")
            pct_str = f" ({pct:+.1f}%)" if pct else ""
            lines.append(f"  {pm['competitor']} — {plan}: {old_p} → {new_p}{pct_str}")
    else:
        lines.append("  No pricing changes detected across competitors this week.")
    lines.append("")

    # ── COMPETITOR DEEP-DIVES ──
    lines.extend([
        "=" * 50,
        "",
        "COMPETITOR DEEP-DIVES",
        "",
    ])

    for comp_info in competitor_data:
        name = comp_info["name"]
        priority = comp_info["priority"]
        sentiment = comp_info["sentiment"]
        news_items = comp_info["news"]

        lines.append(f"{name} ({priority.title()} Threat)")

        if news_items:
            for item in news_items[:3]:
                lines.append(f"  * {item['title']}")
        else:
            lines.append("  No major news this week")

        lines.append(f"  Mentions: {sentiment.get('total', 0)} | Positive: {sentiment.get('positive_pct', 0)}% | Negative: {sentiment.get('negative_pct', 0)}%")

        if comp_info["jobs"] > 0:
            lines.append(f"  Hiring: {comp_info['jobs']} new job postings found")
            for j in comp_info["job_titles"]:
                lines.append(f"    - {j}")

        if comp_info["pricing_changes"]:
            lines.append(f"  Pricing: {len(comp_info['pricing_changes'])} change(s) detected")

        lines.append("")

    # ── STRATEGIC RECOMMENDATIONS ──
    lines.extend([
        "=" * 50,
        "",
        "STRATEGIC RECOMMENDATIONS",
        "-" * 30,
    ])

    rec_num = 1
    for comp_info in competitor_data:
        name = comp_info["name"]
        sentiment = comp_info["sentiment"]
        neg_pct = sentiment.get("negative_pct", 0)
        jobs = comp_info["jobs"]
        pricing_changes = comp_info["pricing_changes"]

        our_play = []
        if neg_pct > 30:
            our_play.append(f"High negative sentiment ({neg_pct}%) — opportunity to capture dissatisfied users")
        if jobs >= 5:
            our_play.append(f"Aggressive hiring ({jobs} posts) — likely expanding; monitor for new product launches")
        if pricing_changes:
            increases = [c for c in pricing_changes if c.get("pct", 0) > 0]
            decreases = [c for c in pricing_changes if c.get("pct", 0) < 0]
            if increases:
                our_play.append(f"Price increases detected — opportunity to position as more affordable")
            if decreases:
                our_play.append(f"Price decreases — may be responding to churn; watch for quality cuts")
        if not our_play:
            our_play.append("No actionable signals — maintain current monitoring cadence")

        lines.append(f"  {rec_num}. {name}:")
        for play in our_play:
            lines.append(f"     Our play: {play}")
        rec_num += 1

    lines.append("")

    # ── MARKET TRENDS ──
    lines.extend([
        "=" * 50,
        "",
        "MARKET TRENDS",
        "",
    ])

    trends = brave_search("AI agent platform trends 2026", api_key, count=5, freshness="pw")
    trend_items = extract_search_results(trends)
    for t in trend_items[:3]:
        lines.append(f"  * {t['title']}")

    lines.extend([
        "",
        "=" * 50,
        "",
        f"Next report: {(now + timedelta(days=7)).strftime('%A, %B %d, %Y')}",
    ])

    print("\n".join(lines))

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_file = REPORT_DIR / f"weekly-{now.strftime('%Y-%m-%d')}.txt"
    report_file.write_text("\n".join(lines))


def compare_snapshots(competitor: str, category: str):
    """Compare latest vs previous snapshot for a competitor with structured diff analysis."""
    current = load_snapshot(competitor, category)
    previous = load_previous_snapshot(competitor, category)

    if not current:
        print(f"No current snapshot for {competitor}/{category}")
        return
    if not previous:
        print(f"No previous snapshot for comparison. Only 1 snapshot exists for {competitor}/{category}")
        print(f"Current snapshot from {current.get('date', 'unknown')}")
        return

    changes = []

    print(f"{'='*60}")
    print(f"Snapshot Comparison: {competitor} — {category}")
    print(f"{'='*60}")
    print(f"  Current:  {current.get('date', '?')}")
    print(f"  Previous: {previous.get('date', '?')}")
    print()

    # Pricing changes (if pricing category or pricing data exists)
    cur_pricing = current.get("pricing", {})
    prev_pricing = previous.get("pricing", {})
    if cur_pricing or prev_pricing:
        print("PRICING CHANGES:")
        all_plans = set(list(cur_pricing.keys()) + list(prev_pricing.keys()))
        for plan in sorted(all_plans):
            cur_price = cur_pricing.get(plan, {}).get("price")
            prev_price = prev_pricing.get(plan, {}).get("price")
            if cur_price and prev_price and cur_price != prev_price:
                try:
                    diff_pct = (float(cur_price) - float(prev_price)) / float(prev_price) * 100
                    changes.append({"type": "pricing", "plan": plan, "old": prev_price, "new": cur_price, "pct": diff_pct})
                    print(f"  {plan}: {prev_price} → {cur_price} ({diff_pct:+.1f}%)")
                except (ValueError, ZeroDivisionError):
                    changes.append({"type": "pricing", "plan": plan, "old": prev_price, "new": cur_price})
                    print(f"  {plan}: {prev_price} → {cur_price}")
            elif cur_price and not prev_price:
                changes.append({"type": "pricing", "plan": plan, "new": cur_price, "action": "added"})
                print(f"  {plan}: NEW — {cur_price}")
            elif prev_price and not cur_price:
                changes.append({"type": "pricing", "plan": plan, "old": prev_price, "action": "removed"})
                print(f"  {plan}: REMOVED (was {prev_price})")
        if not any(c["type"] == "pricing" for c in changes):
            print("  No pricing changes detected")
        print()

    # Feature changes (compare feature lists or content sections)
    cur_features = set(current.get("features", []))
    prev_features = set(previous.get("features", []))
    if cur_features or prev_features:
        added = cur_features - prev_features
        removed = prev_features - cur_features
        print("FEATURE CHANGES:")
        if added:
            for f in sorted(added):
                changes.append({"type": "feature", "action": "added", "feature": f})
                print(f"  + ADDED: {f}")
        if removed:
            for f in sorted(removed):
                changes.append({"type": "feature", "action": "removed", "feature": f})
                print(f"  - REMOVED: {f}")
        if not added and not removed:
            print("  No feature changes detected")
        print()

    # Hiring signal changes
    cur_jobs = current.get("job_count", current.get("hiring", {}).get("count", 0))
    prev_jobs = previous.get("job_count", previous.get("hiring", {}).get("count", 0))
    if cur_jobs or prev_jobs:
        job_diff = cur_jobs - prev_jobs
        if job_diff != 0:
            changes.append({"type": "hiring", "old": prev_jobs, "new": cur_jobs, "diff": job_diff})
            print(f"HIRING SIGNAL:")
            print(f"  Job postings: {prev_jobs} → {cur_jobs} ({job_diff:+d})")
            if job_diff > 5:
                print(f"  ⚠️  Significant hiring ramp — possible expansion")
            print()

    # Social/mention changes
    cur_social = current.get("social", {})
    prev_social = previous.get("social", {})
    if cur_social or prev_social:
        print("SOCIAL/MENTION CHANGES:")
        for metric in ("followers", "mentions", "sentiment_score"):
            cur_val = cur_social.get(metric, 0)
            prev_val = prev_social.get(metric, 0)
            if cur_val != prev_val:
                changes.append({"type": "social", "metric": metric, "old": prev_val, "new": cur_val})
                print(f"  {metric}: {prev_val} → {cur_val}")
        if not any(c["type"] == "social" for c in changes):
            print("  No social changes detected")
        print()

    # Content/size changes (fallback if no structured data)
    cur_content = current.get("content", "")
    prev_content = previous.get("content", "")
    if cur_content and prev_content and not changes:
        size_diff = len(cur_content) - len(prev_content)
        # Check for new sections/keywords
        cur_lines = set(cur_content.lower().split("\n"))
        prev_lines = set(prev_content.lower().split("\n"))
        new_lines = cur_lines - prev_lines
        significant = [l.strip() for l in new_lines if len(l.strip()) > 20][:5]
        print("CONTENT CHANGES:")
        print(f"  Size: {len(prev_content):,} → {len(cur_content):,} chars ({size_diff:+,d})")
        if significant:
            print(f"  New content detected ({len(significant)} significant lines):")
            for line in significant:
                print(f"    \"{line[:80]}...\"" if len(line) > 80 else f"    \"{line}\"")
        print()

    # Summary
    print(f"SUMMARY: {len(changes)} change(s) detected")
    if not changes:
        print("  No significant structural changes between snapshots.")

    return changes


def init_competitor(name: str, domain: str):
    """Initialize monitoring for a new competitor."""
    config = load_config()

    # Check if already exists
    existing = [c for c in config["competitors"] if c["name"].lower() == name.lower()]
    if existing:
        print(f"Competitor '{name}' already configured.")
        return

    competitor = {
        "name": name,
        "domain": domain,
        "urls": {
            "pricing": f"https://{domain}/pricing",
            "blog": f"https://{domain}/blog",
            "changelog": f"https://{domain}/changelog",
            "careers": f"https://{domain}/careers",
        },
        "search_queries": [
            f'"{name}" announcement',
            f'site:twitter.com "{name}"',
            f'"{name}" funding OR raised OR series',
        ],
        "priority": "primary" if len(config["competitors"]) == 0 else "secondary",
        "added_at": datetime.now(timezone.utc).isoformat(),
    }

    config["competitors"].append(competitor)
    save_config(config)

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Added competitor: {name} ({domain})")
    print(f"Config saved to: {CONFIG_FILE}")
    print(f"Run 'competitive-intel.py scan' to create baseline snapshots.")


def run_scan(api_key: str):
    """Run full competitor scan (all workflows)."""
    config = load_config()
    competitors = config.get("competitors", [])

    if not competitors:
        print("No competitors configured. Run: competitive-intel.py init --competitor <name> --domain <domain>")
        return

    print(f"Scanning {len(competitors)} competitor(s)...")
    print()

    for comp in competitors:
        name = comp["name"]
        domain = comp.get("domain", "")
        print(f"--- {name} ({domain}) ---")

        # Snapshot pricing page
        if domain:
            pricing_url = comp.get("urls", {}).get("pricing", f"https://{domain}/pricing")
            cmd = [str(Path.home() / "scripts" / "competitive-intel.sh"), "snapshot",
                   "--url", pricing_url, "--competitor", name, "--category", "pricing"]
            env = os.environ.copy()
            env["BRAVE_SEARCH_API_KEY"] = api_key
            try:
                subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env)
                print(f"  Pricing snapshot saved")
            except subprocess.TimeoutExpired:
                print(f"  Pricing snapshot timeout", file=sys.stderr)

        # Search for news
        news = brave_search(f'"{name}"', api_key, count=10, freshness="pw")
        items = extract_search_results(news)
        print(f"  Found {len(items)} mentions this week")

        sentiment = analyze_sentiment(items)
        print(f"  Sentiment: +{sentiment['positive_pct']}% / -{sentiment['negative_pct']}% ({sentiment['total']} items)")
        print()

    print("Scan complete. Run 'competitive-intel.py digest' for formatted output.")


def rate_status():
    """Show API rate limit status."""
    count = get_daily_count()
    remaining = DAILY_BUDGET - count
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    status = "WARNING" if count >= 160 else "EXHAUSTED" if count >= DAILY_BUDGET else "OK"

    print(f"Brave Search API Usage")
    print(f"  Date:      {today}")
    print(f"  Requests:  {count} / {DAILY_BUDGET}")
    print(f"  Remaining: {remaining}")
    print(f"  Status:    {status}")


def main():
    parser = argparse.ArgumentParser(description="Competitive intelligence engine")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("digest")
    subparsers.add_parser("weekly-report")
    subparsers.add_parser("scan")
    subparsers.add_parser("rate-status")

    p_compare = subparsers.add_parser("compare")
    p_compare.add_argument("--competitor", required=True)
    p_compare.add_argument("--category", required=True)

    p_init = subparsers.add_parser("init")
    p_init.add_argument("--competitor", required=True)
    p_init.add_argument("--domain", required=True)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    api_key = load_api_key()

    if args.command == "rate-status":
        rate_status()
    elif args.command == "init":
        init_competitor(args.competitor, args.domain)
    elif args.command == "compare":
        compare_snapshots(args.competitor, args.category)
    elif not api_key:
        print("Error: BRAVE_SEARCH_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    elif args.command == "digest":
        generate_digest(api_key)
    elif args.command == "weekly-report":
        generate_weekly_report(api_key)
    elif args.command == "scan":
        run_scan(api_key)


if __name__ == "__main__":
    main()
