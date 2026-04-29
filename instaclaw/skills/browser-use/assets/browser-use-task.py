#!/usr/bin/env python3
"""browser-use-task.py — InstaClaw Tier 3.25 browser automation wrapper.

Invoked by agents as:
    python3 ~/scripts/browser-use-task.py --task "..." [options]

Returns single-line JSON on stdout. All log output goes to stderr.

Routes the underlying LLM calls through the local OpenClaw gateway so credits
are metered through the existing pipeline. Reuses the Playwright Chromium
installed on every VM by cloud-init.ts:268-288 (no new binary install).

Phase 0 verification items (per PRD §8):
  - browser-use Python API surface (imports below try multiple paths)
  - Gateway URL/token resolution (env first, auth-profiles.json fallback)
  - Playwright user-data-dir collision behavior
  - Peak RSS, success rate, wall-clock, credit cost vs Tier 3 baseline

See instaclaw/skills/browser-use/SKILL.md for agent-facing docs.
See instaclaw/docs/prd/skill-browser-use-integration.md for the full design.
"""
from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
import resource
import signal
import sys
import time
from pathlib import Path
from typing import Any, NoReturn
from urllib.parse import urlparse

DEFAULT_MAX_STEPS = 25
DEFAULT_BUDGET_USD = 1.00
DEFAULT_TIMEOUT_SEC = 300
DEFAULT_MODEL = os.environ.get("BROWSER_USE_LLM_MODEL", "claude-sonnet-4-6")
DEFAULT_USER_DATA_DIR = Path.home() / ".cache" / "browser-use-profile"
DEFAULT_BLOCKLIST = Path(os.environ.get(
    "BROWSER_USE_BLOCKLIST_FILE",
    str(Path.home() / ".openclaw" / "browser-use-blocklist.txt"),
))
SESSION_LOCK = Path.home() / ".cache" / "browser-use" / "session.lock"
AUTH_PROFILES_PATH = Path.home() / ".openclaw" / "agents" / "main" / "agent" / "auth-profiles.json"

# Belt-and-suspenders: cap virtual address space. Real RSS is policed by
# vm-watchdog.py at 85% RAM. RLIMIT_AS catches runaway allocations in this
# process tree before the watchdog has to act.
RLIMIT_AS_BYTES = int(os.environ.get(
    "BROWSER_USE_RLIMIT_AS",
    str(2 * 1024 * 1024 * 1024),  # 2 GiB
))


# ──────────────────────────────────────────────────────────────────────────
# Output helpers
# ──────────────────────────────────────────────────────────────────────────

def emit(payload: dict[str, Any]) -> None:
    """Print a single-line JSON object on stdout."""
    print(json.dumps(payload, default=str))


def die(message: str, *, code: int = 2) -> NoReturn:
    emit({"ok": False, "error": message})
    sys.exit(code)


def log(message: str) -> None:
    """Log to stderr so it doesn't pollute the JSON output."""
    print(message, file=sys.stderr, flush=True)


# ──────────────────────────────────────────────────────────────────────────
# Gateway credentials (env first, auth-profiles.json fallback)
# ──────────────────────────────────────────────────────────────────────────

def load_gateway_credentials() -> tuple[str, str]:
    """Return (gateway_url, gateway_token).

    Resolution order:
      1. GATEWAY_URL + GATEWAY_TOKEN env vars (if both set).
      2. ~/.openclaw/agents/main/agent/auth-profiles.json → profiles["anthropic:default"].

    Per project memory: auth-profiles.json is THE source of truth for the
    Anthropic SDK on each VM. The env-var path is just a convenience override.
    """
    url = os.environ.get("GATEWAY_URL")
    token = os.environ.get("GATEWAY_TOKEN")

    if not (url and token) and AUTH_PROFILES_PATH.exists():
        try:
            data = json.loads(AUTH_PROFILES_PATH.read_text())
            profiles = data.get("profiles") or {}
            anthropic = profiles.get("anthropic:default") or {}
            url = url or anthropic.get("url") or anthropic.get("baseUrl")
            token = token or anthropic.get("key") or anthropic.get("apiKey")
        except (json.JSONDecodeError, OSError) as exc:
            log(f"warning: could not parse {AUTH_PROFILES_PATH}: {exc}")

    if not url or not token:
        die(
            "could not resolve gateway URL or token. "
            "Set GATEWAY_URL/GATEWAY_TOKEN env or check "
            "~/.openclaw/agents/main/agent/auth-profiles.json"
        )
    return url, token


# ──────────────────────────────────────────────────────────────────────────
# Domain blocklist
# ──────────────────────────────────────────────────────────────────────────

def load_blocklist(path: Path) -> set[str]:
    if not path.exists():
        return set()
    out: set[str] = set()
    for line in path.read_text().splitlines():
        line = line.strip().lower()
        if not line or line.startswith("#"):
            continue
        out.add(line)
    return out


def blocklist_match(url: str | None, blocklist: set[str]) -> str | None:
    if not url or not blocklist:
        return None
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    if not host:
        return None
    for entry in blocklist:
        if host == entry or host.endswith("." + entry):
            return entry
    return None


# ──────────────────────────────────────────────────────────────────────────
# Single-session lock
# ──────────────────────────────────────────────────────────────────────────

def acquire_session_lock() -> int:
    SESSION_LOCK.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(SESSION_LOCK), os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        die(
            "Another browser-use task is already running on this VM. "
            "Only one session at a time (cgroup MemoryMax=3500M; concurrent Chromium would OOM)."
        )
    os.write(fd, str(os.getpid()).encode())
    return fd


# ──────────────────────────────────────────────────────────────────────────
# Resource limits
# ──────────────────────────────────────────────────────────────────────────

def set_resource_limits() -> None:
    try:
        resource.setrlimit(resource.RLIMIT_AS, (RLIMIT_AS_BYTES, RLIMIT_AS_BYTES))
    except (ValueError, OSError) as exc:
        log(f"warning: could not set RLIMIT_AS: {exc}")


# ──────────────────────────────────────────────────────────────────────────
# Signal handling
# ──────────────────────────────────────────────────────────────────────────

def install_signal_handlers(cleanup: list) -> None:
    def _handle(signum, _frame):
        for cb in cleanup:
            try:
                cb()
            except Exception:  # noqa: BLE001 — best-effort cleanup
                pass
        emit({"ok": False, "error": f"interrupted by signal {signum}"})
        sys.exit(130)

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)


# ──────────────────────────────────────────────────────────────────────────
# JSON coercion helper for browser-use's result objects (varies by version)
# ──────────────────────────────────────────────────────────────────────────

def coerce_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [coerce_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): coerce_jsonable(v) for k, v in value.items()}
    if hasattr(value, "model_dump"):
        try:
            return value.model_dump()
        except Exception:  # noqa: BLE001
            pass
    if hasattr(value, "dict"):
        try:
            return value.dict()
        except Exception:  # noqa: BLE001
            pass
    return repr(value)


# ──────────────────────────────────────────────────────────────────────────
# Core task runner
# ──────────────────────────────────────────────────────────────────────────

async def run_task(
    *,
    task: str,
    start_url: str | None,
    max_steps: int,
    timeout_sec: int,
    headless: bool,
    user_data_dir: Path,
    model: str,
    gateway_url: str,
    gateway_token: str,
) -> dict[str, Any]:
    """Run a browser-use task and return a structured result dict.

    Phase 0 note: browser-use's exact import paths and constructor signature
    are verified during canary testing. The discovery loop below is intentional
    — fail loudly with a clear message rather than silently swallowing import
    drift.
    """
    # ── browser-use Agent import ─────────────────────────────────────────
    try:
        from browser_use import Agent  # type: ignore
    except ImportError as exc:
        return {
            "ok": False,
            "error": (
                f"browser-use not importable: {exc}. "
                "Run: pip3 install --break-system-packages 'browser-use>=0.1.0,<1.0.0'"
            ),
        }

    # ── LLM client construction (try browser-use's bundled wrapper, then langchain) ──
    llm = None
    construction_errors: list[str] = []
    for module_name, class_name in (
        ("browser_use.llm", "ChatAnthropic"),
        ("langchain_anthropic", "ChatAnthropic"),
    ):
        try:
            module = __import__(module_name, fromlist=[class_name])
            klass = getattr(module, class_name)
            llm = klass(model=model, base_url=gateway_url, api_key=gateway_token)
            log(f"using LLM client {module_name}.{class_name} via gateway {gateway_url}")
            break
        except Exception as exc:  # noqa: BLE001 — best-effort discovery
            construction_errors.append(f"{module_name}.{class_name}: {type(exc).__name__}: {exc}")
            continue

    if llm is None:
        return {
            "ok": False,
            "error": "could not construct LLM client. Tried: " + "; ".join(construction_errors),
        }

    user_data_dir.mkdir(parents=True, exist_ok=True)

    # ── Agent construction (kwargs vary by browser-use version; try then strip) ──
    agent_kwargs: dict[str, Any] = {
        "task": task,
        "llm": llm,
        "max_steps": max_steps,
    }
    if start_url:
        agent_kwargs["start_url"] = start_url
    # Older versions accept "headless"; newer ones nest it under a browser config.
    # Try the simple kwarg first, fall back if rejected.
    agent_kwargs.setdefault("headless", headless)

    agent = None
    last_error: Exception | None = None
    for attempt_kwargs in (
        agent_kwargs,
        {k: v for k, v in agent_kwargs.items() if k not in ("start_url",)},
        {k: v for k, v in agent_kwargs.items() if k not in ("start_url", "headless")},
        {"task": task, "llm": llm},  # bare-minimum fallback
    ):
        try:
            agent = Agent(**attempt_kwargs)  # type: ignore[arg-type]
            log(f"Agent constructed with kwargs: {sorted(attempt_kwargs.keys())}")
            break
        except TypeError as exc:
            last_error = exc
            continue
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "error": f"Agent constructor raised: {type(exc).__name__}: {exc}",
            }

    if agent is None:
        return {
            "ok": False,
            "error": f"Agent constructor rejected all kwarg shapes (last: {last_error})",
        }

    # ── Run the agent under a wall-clock cap ─────────────────────────────
    started_at = time.monotonic()
    run_result: Any = None
    run_error: str | None = None
    try:
        run_coro = agent.run()
        if not asyncio.iscoroutine(run_coro):
            return {"ok": False, "error": "agent.run() did not return a coroutine — incompatible browser-use version"}
        run_result = await asyncio.wait_for(run_coro, timeout=timeout_sec)
    except asyncio.TimeoutError:
        run_error = f"task exceeded --timeout-sec={timeout_sec}"
    except Exception as exc:  # noqa: BLE001
        run_error = f"agent.run() raised: {type(exc).__name__}: {exc}"
    finally:
        # Best-effort browser teardown — try common method names across versions.
        for closer in ("close", "stop", "cleanup", "shutdown"):
            fn = getattr(agent, closer, None)
            if not callable(fn):
                continue
            try:
                maybe = fn()
                if asyncio.iscoroutine(maybe):
                    await maybe
                break
            except Exception:  # noqa: BLE001
                continue

    wall_ms = int((time.monotonic() - started_at) * 1000)

    if run_error is not None:
        return {"ok": False, "error": run_error, "wall_time_ms": wall_ms}

    # ── Result extraction (browser-use exposes various result shapes) ────
    out: dict[str, Any] = {"ok": True, "wall_time_ms": wall_ms}
    if hasattr(run_result, "final_result") and callable(run_result.final_result):
        try:
            out["result"] = coerce_jsonable(run_result.final_result())
        except Exception as exc:  # noqa: BLE001
            out["result"] = coerce_jsonable(run_result)
            log(f"final_result() raised: {exc}; falling back to repr")
    elif hasattr(run_result, "result"):
        out["result"] = coerce_jsonable(run_result.result)
    else:
        out["result"] = coerce_jsonable(run_result)

    for attr, key in (
        ("history", "steps"),
        ("screenshots", "screenshots"),
        ("total_cost", "cost_usd"),
        ("cost_usd", "cost_usd"),
    ):
        if hasattr(run_result, attr):
            try:
                out[key] = coerce_jsonable(getattr(run_result, attr))
            except Exception as exc:  # noqa: BLE001
                log(f"could not coerce {attr}: {exc}")

    return out


# ──────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="browser-use-task.py",
        description="browser-use task runner (InstaClaw Tier 3.25)",
    )
    p.add_argument("--task", required=True, help="Natural-language task description")
    p.add_argument("--start-url", default=None, help="Optional starting URL")
    p.add_argument("--max-steps", type=int, default=DEFAULT_MAX_STEPS,
                   help=f"Hard cap on agent iterations (default {DEFAULT_MAX_STEPS})")
    p.add_argument("--budget-usd", type=float, default=DEFAULT_BUDGET_USD,
                   help=("Soft cost budget (reported in output, not pre-enforced per LLM call in v1; "
                         "use --max-steps as the primary cost lever)"))
    p.add_argument("--timeout-sec", type=int, default=DEFAULT_TIMEOUT_SEC,
                   help=f"Hard wall-clock cap (default {DEFAULT_TIMEOUT_SEC})")
    p.add_argument("--headless", dest="headless", action="store_true", default=True)
    p.add_argument("--no-headless", dest="headless", action="store_false")
    p.add_argument("--user-data-dir", default=str(DEFAULT_USER_DATA_DIR))
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--blocklist", default=str(DEFAULT_BLOCKLIST))
    p.add_argument("--output-format", choices=("json",), default="json")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    set_resource_limits()

    blocklist = load_blocklist(Path(args.blocklist))
    blocked = blocklist_match(args.start_url, blocklist)
    if blocked:
        die(f"start-url is on the blocklist: {blocked}")

    gateway_url, gateway_token = load_gateway_credentials()

    lock_fd = acquire_session_lock()
    cleanup: list = [lambda: os.close(lock_fd)]
    install_signal_handlers(cleanup)

    try:
        result = asyncio.run(run_task(
            task=args.task,
            start_url=args.start_url,
            max_steps=args.max_steps,
            timeout_sec=args.timeout_sec,
            headless=args.headless,
            user_data_dir=Path(args.user_data_dir),
            model=args.model,
            gateway_url=gateway_url,
            gateway_token=gateway_token,
        ))
    finally:
        try:
            os.close(lock_fd)
        except OSError:
            pass

    # Surface budget vs spend mismatch as a soft warning in the JSON
    if result.get("ok") and isinstance(result.get("cost_usd"), (int, float)):
        if result["cost_usd"] > args.budget_usd:
            result["budget_exceeded"] = True
            result["budget_usd"] = args.budget_usd

    emit(result)
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
