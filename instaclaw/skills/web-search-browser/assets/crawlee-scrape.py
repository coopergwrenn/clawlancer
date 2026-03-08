#!/usr/bin/env python3
"""Crawlee stealth scraper — wrapper for agents.

Usage:
  python3 ~/scripts/crawlee-scrape.py --url "https://target.com"
  python3 ~/scripts/crawlee-scrape.py --url "https://spa.com" --mode browser
  python3 ~/scripts/crawlee-scrape.py --urls "https://a.com" "https://b.com"
  python3 ~/scripts/crawlee-scrape.py --url "https://target.com" --selector ".price,.title"
  python3 ~/scripts/crawlee-scrape.py --url "https://target.com" --output text

Exit codes: 0=success (even partial), 1=total failure
"""

import argparse
import asyncio
import json
import signal
import sys
import tempfile
import shutil
import time
from datetime import timedelta
from pathlib import Path

# ── Hard kill timeout ────────────────────────────────────────────────────────
TOTAL_TIMEOUT = 120

def _alarm_handler(signum, frame):
    print(json.dumps({"success": False, "results": [], "stats": {}, "errors": ["Total timeout exceeded"]}))
    sys.exit(1)

signal.signal(signal.SIGALRM, _alarm_handler)

# ── Imports (after signal setup so timeout works even during slow imports) ───
from crawlee.crawlers import BeautifulSoupCrawler, BeautifulSoupCrawlingContext
from crawlee.crawlers import PlaywrightCrawler, PlaywrightCrawlingContext
from crawlee.configuration import Configuration
from crawlee.http_clients import ImpitHttpClient
from crawlee._types import ConcurrencySettings
from crawlee.sessions import SessionPool
from crawlee.storage_clients import MemoryStorageClient

# ── Constants ────────────────────────────────────────────────────────────────
LIGHT_CONCURRENCY = ConcurrencySettings(min_concurrency=1, max_concurrency=5, desired_concurrency=3)
BROWSER_CONCURRENCY = ConcurrencySettings(min_concurrency=1, max_concurrency=1, desired_concurrency=1)
BROWSER_LAUNCH_OPTS = {"args": ["--no-sandbox", "--disable-setuid-sandbox"]}

# ── Shared state ─────────────────────────────────────────────────────────────
results: list[dict] = []
errors: list[str] = []


def make_config(tmpdir: str) -> Configuration:
    return Configuration(
        memory_mbytes=1024,
        storage_dir=tmpdir,
        purge_on_start=True,
        log_level="ERROR",
    )


async def run_light(urls: list[str], selector: str | None, timeout: int,
                    max_pages: int) -> None:
    tmpdir = tempfile.mkdtemp(prefix="crawlee-")
    try:
        storage_client = MemoryStorageClient()
        crawler = BeautifulSoupCrawler(
            configuration=make_config(tmpdir),
            storage_client=storage_client,
            http_client=ImpitHttpClient(),
            session_pool=SessionPool(max_pool_size=50),
            concurrency_settings=LIGHT_CONCURRENCY,
            max_requests_per_crawl=max_pages,
            max_request_retries=1,
            request_handler_timeout=timedelta(seconds=timeout),
        )

        @crawler.router.default_handler
        async def handler(ctx: BeautifulSoupCrawlingContext) -> None:
            title = ctx.soup.title.string if ctx.soup.title else None
            text = ctx.soup.get_text(separator="\n", strip=True)
            links = [a.get("href") for a in ctx.soup.find_all("a", href=True)]
            selected = []
            if selector:
                for sel in selector.split(","):
                    for el in ctx.soup.select(sel.strip()):
                        selected.append(el.get_text(strip=True))
            results.append({
                "url": ctx.request.url,
                "status_code": 200,
                "title": title,
                "text_content": text,
                "html_content": str(ctx.soup),
                "links": links,
                "selected_elements": selected,
                "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })

        await crawler.run(urls)
    except Exception as e:
        errors.append(f"light crawl error: {e}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def run_browser(urls: list[str], selector: str | None, timeout: int,
                      max_pages: int) -> None:
    tmpdir = tempfile.mkdtemp(prefix="crawlee-")
    try:
        storage_client = MemoryStorageClient()
        crawler = PlaywrightCrawler(
            configuration=make_config(tmpdir),
            storage_client=storage_client,
            headless=True,
            browser_type="chromium",
            browser_launch_options=BROWSER_LAUNCH_OPTS,
            session_pool=SessionPool(max_pool_size=50),
            concurrency_settings=BROWSER_CONCURRENCY,
            max_requests_per_crawl=max_pages,
            max_request_retries=1,
            request_handler_timeout=timedelta(seconds=timeout),
        )

        @crawler.router.default_handler
        async def handler(ctx: PlaywrightCrawlingContext) -> None:
            title = await ctx.page.title()
            text = await ctx.page.inner_text("body")
            html = await ctx.page.content()
            links = await ctx.page.eval_on_selector_all(
                "a[href]", "els => els.map(e => e.href)"
            )
            selected = []
            if selector:
                for sel in selector.split(","):
                    els = await ctx.page.query_selector_all(sel.strip())
                    for el in els:
                        selected.append(await el.inner_text())
            results.append({
                "url": ctx.request.url,
                "status_code": 200,
                "title": title,
                "text_content": text,
                "html_content": html,
                "links": links,
                "selected_elements": selected,
                "scraped_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })

        await crawler.run(urls)
    except Exception as e:
        errors.append(f"browser crawl error: {e}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def format_output(output_mode: str) -> str:
    if output_mode == "json":
        succeeded = [r for r in results if r.get("status_code") == 200]
        failed_count = len(urls_global) - len(succeeded)
        payload = {
            "success": len(succeeded) > 0,
            "results": results,
            "stats": {
                "total_urls": len(urls_global),
                "successful": len(succeeded),
                "failed": failed_count,
                "mode_used": mode_global,
                "duration_seconds": round(time.time() - start_time, 2),
                "retries": 0,
            },
            "errors": errors,
        }
        return json.dumps(payload, indent=2, default=str)
    elif output_mode == "text":
        parts = []
        for r in results:
            parts.append(f"URL: {r['url']}\nTitle: {r.get('title', '')}\n\n{r.get('text_content', '')}\n")
        return "\n---\n".join(parts) if parts else "No results."
    elif output_mode == "html":
        return "\n".join(r.get("html_content", "") for r in results) or "No results."
    elif output_mode == "markdown":
        parts = []
        for r in results:
            title = r.get("title", r["url"])
            parts.append(f"# {title}\n\n{r.get('text_content', '')}\n")
        return "\n---\n".join(parts) if parts else "No results."
    return ""


# ── Globals set in main ──────────────────────────────────────────────────────
urls_global: list[str] = []
mode_global: str = "light"
start_time: float = 0


async def main() -> int:
    global urls_global, mode_global, start_time

    parser = argparse.ArgumentParser(description="Crawlee stealth scraper")
    parser.add_argument("--url", help="Single URL to scrape")
    parser.add_argument("--urls", nargs="+", help="Multiple URLs to scrape")
    parser.add_argument("--mode", choices=["light", "browser"], default="light")
    parser.add_argument("--output", choices=["json", "text", "html", "markdown"], default="json")
    parser.add_argument("--selector", help="CSS selector(s) to extract, comma-separated")
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=30, help="Per-request timeout")
    parser.add_argument("--total-timeout", type=int, default=TOTAL_TIMEOUT)
    args = parser.parse_args()

    urls = args.urls or ([args.url] if args.url else [])
    if not urls:
        print(json.dumps({"success": False, "results": [], "errors": ["No URLs provided"]}))
        return 1

    urls_global = urls
    mode_global = args.mode
    start_time = time.time()
    signal.alarm(args.total_timeout)

    if args.mode == "light":
        await run_light(urls, args.selector, args.timeout, args.max_pages)
    else:
        await run_browser(urls, args.selector, args.timeout, args.max_pages)

    signal.alarm(0)
    print(format_output(args.output))
    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
