#!/usr/bin/env python3
"""
Consensus matching pipeline orchestrator (VM-side).

Glues the four pieces of the Tuesday-9am ship:
  1. POST /api/match/v1/route_intent → get top-50 from Layer 1 (server)
  2. Run consensus_match_rerank.py → Layer 2 (this VM, full memory anchor)
  3. Take top 12 → run consensus_match_deliberate.py → Layer 3 (this VM)
  4. POST /api/match/v1/results → server upserts deliberations + top3

Cron: every 30 min (configurable via /etc/cron entry on the VM, set up
during the consensus skill install).

Throttling: state file at ~/.openclaw/.consensus_match_state.json
  - last_run_at: epoch seconds
  - last_pv: caller's profile_version at last run
  - last_top3: previous top-3 candidate user_ids
  - last_outcome: "ok" | "no_profile" | "no_candidates" | "error_*"

Skip rules:
  - If profile_version unchanged AND last_outcome=="ok" AND
    (now - last_run_at) < MIN_INTERVAL_S → skip (caller's intent hasn't
    moved; new candidates would be picked up by the reactive cascade,
    not by this cron's polling).
  - --force flag bypasses throttle.
  - --dry-run runs the pipeline but skips the final POST to /results
    AND does not persist state.

Output:
  - stdout: brief one-line summary on success ("ok n=12 top1=<uuid>")
  - stderr: telemetry lines (pipeline.<event> ...)
  - exit 0 on success, 1 on error, 2 on usage error

PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §5
     ("USER ASKS AGENT 'find me my people'" + cascade flow)
"""
import argparse
import fcntl
import hashlib
import json
import os
import random
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# ─── Constants ───────────────────────────────────────────────────────

ROUTE_INTENT_URL = "https://instaclaw.io/api/match/v1/route_intent"
RESULTS_URL = "https://instaclaw.io/api/match/v1/results"

STATE_FILE = os.path.expanduser("~/.openclaw/.consensus_match_state.json")
LOCK_FILE = os.path.expanduser("~/.openclaw/.consensus_match.lock")

# Match state retention. Cron runs every 30 min; we throttle out repeats.
MIN_INTERVAL_SECONDS = 25 * 60  # 25 min — gives a small headroom under cron tick

# Cold-start gating: a thin MEMORY.md cannot honestly support per-candidate
# deliberation (the agent has no specific signals to reference, and Layer 3
# would be tempted to fabricate). Below this threshold we ship Layer 2 only
# and label the matches as preliminary.
#
# Sizing: the default MEMORY.md template is ~120 bytes. The periodic_summary
# cron grows it to 1-2 KB after the first real conversation by writing a
# USER_FACTS section. By 2 KB the file typically contains: onboarding
# blurb (~700 B) + at least one user-facts extraction (~500 B) + at least
# one recent-session summary (~500 B). That's enough specific signal for
# honest deliberation. Below 2 KB: cold-start, ship preliminary L2-only.
#
# Empirically: vm-780 has 3.5 KB after weeks of use; new VMs from snapshot
# are at 0.1 KB. The 2 KB cut cleanly separates these populations.
COLD_START_MEMORY_BYTES = 2_000

# Fallback abort: if more than this fraction of Layer 3 deliberations come
# back as fallbacks (LLM call failed, parse failed, batch dropped), the
# whole cycle is aborted — better to surface stale matches than fresh
# garbage. Trust > freshness.
FALLBACK_ABORT_THRESHOLD = 0.25

# Burst de-thunder: when 200 VMs hit the same cron tick, we don't all
# start at second 0. Random offset 0..MAX_JITTER_SECONDS keeps Anthropic
# rate limits and Vercel function concurrency comfortable.
MAX_JITTER_SECONDS = 240

# Co-located scripts: same dir as this orchestrator.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RERANK_SCRIPT = os.path.join(SCRIPT_DIR, "consensus_match_rerank.py")
DELIBERATE_SCRIPT = os.path.join(SCRIPT_DIR, "consensus_match_deliberate.py")
MEMORY_MD = os.path.expanduser("~/.openclaw/workspace/MEMORY.md")
SOUL_MD = os.path.expanduser("~/.openclaw/workspace/SOUL.md")

# Output cap into Layer 3
TOP_N_FOR_DELIBERATION = 12

REQUEST_TIMEOUT_SECONDS = 30
SUBPROCESS_TIMEOUT_SECONDS = 90  # rerank ~12s, deliberate ~18s, headroom

# Magic prefixes for downstream rendering. The /consensus/my-matches page
# detects these to label matches that aren't full agent deliberation.
RATIONALE_PREFIX_L2_ONLY = "<l2-only> "
RATIONALE_PREFIX_FALLBACK = "<fallback: "
RATIONALE_PREFIX_DELIB_FAIL = "<deliberation unavailable: "

# Notification: shell out to the existing notify_user.sh which sends a
# Telegram message via the agent's bot. The script is deployed to every
# VM by the manifest (NOTIFY_USER_SCRIPT entry) and reads BOT_TOKEN +
# CHAT_ID from ~/.openclaw/.env. We don't reinvent Telegram delivery.
NOTIFY_SCRIPT = os.path.expanduser("~/scripts/notify_user.sh")

# Agent-to-agent intro outreach. Fires after a top-1 change so the
# matched user's agent receives an XMTP DM (forwarded to their human
# via Telegram). Co-located with the other consensus scripts.
OUTREACH_SCRIPT = os.path.join(SCRIPT_DIR, "consensus_agent_outreach.py")
OUTREACH_TIMEOUT_SECONDS = 45  # contact-info + reserve + xmtp-send + finalize
CONTACT_INFO_URL = "https://instaclaw.io/api/match/v1/contact-info"
XMTP_ADDRESS_FILE = os.path.expanduser("~/.openclaw/xmtp/address")

# Application-layer delivery guarantees (sender retry + receiver poll).
# Every cycle:
#   1. Pull intros targeting me that haven't been acked → surface them.
#   2. Pull my outbound rows that haven't been acked → re-fire XMTP.
# Together with the receiver's mjs ACK on successful surface, this
# bounds worst-case delivery latency to one cron tick (30 min) even
# when XMTP store-and-forward drops the message entirely.
MY_INTROS_URL = "https://instaclaw.io/api/match/v1/my-intros"
MY_PENDING_RETRIES_URL = "https://instaclaw.io/api/match/v1/my-pending-retries"
OUTREACH_URL = "https://instaclaw.io/api/match/v1/outreach"
LOCAL_XMTP_SEND_URL = "http://127.0.0.1:18790/send-intro"
PENDING_INTROS_FILE = os.path.expanduser("~/.openclaw/xmtp/pending-intros.jsonl")
PENDING_INTROS_SEEN_FILE = os.path.expanduser("~/.openclaw/xmtp/pending-intros-seen.jsonl")
RETRY_BUDGET_PER_CYCLE = 5  # cap the redelivery work in any one tick


def log(msg: str) -> None:
    sys.stderr.write(f"pipeline.{msg}\n")
    sys.stderr.flush()


# ─── Auth ────────────────────────────────────────────────────────────


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


# ─── State ───────────────────────────────────────────────────────────


def read_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


# ─── HTTP helpers ────────────────────────────────────────────────────


def post_json(url: str, body: dict, token: str) -> tuple[int, dict | None]:
    """POST json body, return (status, parsed_body_or_None)."""
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            try:
                return resp.status, json.loads(resp.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return resp.status, None
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:  # noqa: BLE001 — best effort
            return e.code, None
    except urllib.error.URLError as e:
        log(f"http_url_error url={url} reason={e.reason}")
        return 0, None


# ─── Subprocess helpers ──────────────────────────────────────────────


def run_subprocess_json(
    script: str, input_json: str, env_overrides: dict | None = None
) -> tuple[int, str, str]:
    """Run a python script with stdin = '-' arg, piping JSON in. Return
    (returncode, stdout, stderr). env_overrides extends os.environ for
    the child (used to pass CONSENSUS_MEMORY_PATH / CONSENSUS_SOUL_PATH
    so L2 and L3 read from a frozen anchor snapshot)."""
    if not os.path.isfile(script):
        return 127, "", f"missing script: {script}"
    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    try:
        proc = subprocess.run(
            ["python3", script, "-"],
            input=input_json,
            text=True,
            capture_output=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
            env=env,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "subprocess timed out"


# ─── Anchor snapshot ─────────────────────────────────────────────────


def snapshot_anchor() -> tuple[str | None, int]:
    """Snapshot MEMORY.md + SOUL.md into a tempdir. Returns (tempdir,
    memory_bytes). The orchestrator passes the tempdir paths to L2 and
    L3 via env vars so both subprocesses see byte-identical anchor —
    otherwise periodic_summary cron could rewrite MEMORY.md mid-cycle
    and bust the prompt cache, AND the two layers could disagree about
    user state.

    Returns (None, 0) if neither anchor file exists.
    """
    has_memory = os.path.isfile(MEMORY_MD)
    has_soul = os.path.isfile(SOUL_MD)
    if not has_memory and not has_soul:
        return None, 0
    tempdir = tempfile.mkdtemp(prefix="consensus_anchor_")
    snap_memory = os.path.join(tempdir, "MEMORY.md")
    snap_soul = os.path.join(tempdir, "SOUL.md")
    memory_bytes = 0
    if has_memory:
        with open(MEMORY_MD, "rb") as src, open(snap_memory, "wb") as dst:
            data = src.read()
            dst.write(data)
            memory_bytes = len(data)
    else:
        # Touch an empty file so env-var path always resolves
        open(snap_memory, "w").close()
    if has_soul:
        with open(SOUL_MD, "rb") as src, open(snap_soul, "wb") as dst:
            dst.write(src.read())
    else:
        open(snap_soul, "w").close()
    return tempdir, memory_bytes


def cleanup_snapshot(tempdir: str | None) -> None:
    if not tempdir:
        return
    try:
        for name in ("MEMORY.md", "SOUL.md"):
            p = os.path.join(tempdir, name)
            if os.path.isfile(p):
                os.unlink(p)
        os.rmdir(tempdir)
    except OSError:
        pass  # best-effort; tempdir cleanup is not load-bearing


# ─── Cold-start passthrough ──────────────────────────────────────────


def build_l2_passthrough_deliberations(merged_top: list[dict]) -> list[dict]:
    """Cold-start path: too little memory for honest per-candidate
    deliberation. Convert L2 ranked output into a Layer-3-shaped result
    where the rationale is L2's brief, the score is L2's rerank_score,
    and the rationale is prefixed with our l2-only marker so the UI can
    render it as 'preliminary' — not as the agent's full deliberation.

    The fabrication rule says: when in doubt, downscore and tell the
    truth. This passthrough is the truth at cold start.
    """
    out: list[dict] = []
    for c in merged_top:
        rerank = c.get("rerank_score")
        score = float(rerank) if isinstance(rerank, (int, float)) else 0.5
        # Cap cold-start scores at 0.6 — without specific signal we
        # CANNOT honestly claim "drop everything" relevance.
        score = min(score, 0.6)
        brief = (c.get("brief_reason") or "").strip() or "no specific signal in your history; profile fit only"
        out.append({
            "user_id": c.get("user_id"),
            "agent_id": c.get("agent_id"),
            "match_score": score,
            "rationale": RATIONALE_PREFIX_L2_ONLY + brief,
            "conversation_topic": "",
            "meeting_window": "",
            "skip_reason": None,
        })
    return out


# ─── Fallback rate detection ─────────────────────────────────────────


def count_fallbacks(deliberations: list[dict]) -> int:
    """Count entries whose rationale carries a hard-failure marker.
    L2-only is NOT counted as a fallback — it's intentional cold-start
    behavior, not failure."""
    n = 0
    for d in deliberations:
        rationale = (d.get("rationale") or "").lstrip()
        if rationale.startswith(RATIONALE_PREFIX_FALLBACK) or rationale.startswith(RATIONALE_PREFIX_DELIB_FAIL):
            n += 1
    return n


# ─── Telegram notification (cheap path) ─────────────────────────────


def strip_rationale_prefix(s: str) -> str:
    """Drop our internal labels before user-facing display. Keeps the
    notification clean: 'You're actively pushing a fix...' not
    '<l2-only> You're actively pushing...'"""
    s = s.lstrip()
    for prefix in (RATIONALE_PREFIX_L2_ONLY, RATIONALE_PREFIX_FALLBACK, RATIONALE_PREFIX_DELIB_FAIL):
        if s.startswith(prefix):
            close = s.find(">")
            if close > 0:
                return s[close + 1:].lstrip()
            return s[len(prefix):].lstrip()
    return s


def _build_sender_cta_line(target_name: str, target_handle: str | None,
                           outreach_status: str | None,
                           outreach_reason: str | None) -> str:
    """The action line in the sender-side notification — varies by what
    the agent actually did. The pipeline reorders so outreach fires
    BEFORE notification, which means we can be honest here ('I sent
    the intro') instead of speculating ('I'll send shortly')."""
    handle_part = f"@{target_handle}" if target_handle else None

    if outreach_status == "sent":
        if handle_part:
            return (
                f"I just sent {target_name}'s agent an intro on your behalf. "
                f"You can also DM them directly: {handle_part}."
            )
        return f"I just sent {target_name}'s agent an intro on your behalf."

    if outreach_status == "skipped" and outreach_reason in ("rate_limited",):
        if handle_part:
            return f"Hit my daily intro cap so I didn't reach out. DM {target_name} directly: {handle_part}."
        return "Hit my daily intro cap so I didn't reach out."

    if outreach_status == "skipped" and outreach_reason == "target_inbox_full":
        if handle_part:
            return f"{target_name} is at their daily intro cap. DM them directly: {handle_part}."
        return f"{target_name} is at their daily intro cap."

    if outreach_status == "skipped" and outreach_reason == "no_contact_resolved":
        return f"{target_name} isn't in our matchpool yet, so I couldn't reach their agent. See the match details below."

    if outreach_status == "skipped" and outreach_reason == "duplicate":
        if handle_part:
            return f"Already sent an intro about this match. DM {target_name} directly: {handle_part}."
        return "Already sent an intro about this match earlier."

    if outreach_status == "skipped" and outreach_reason == "cold_start":
        # Cold-start path: outreach intentionally not fired.
        if handle_part:
            return f"DM {target_name} directly: {handle_part}."
        return "Match details below."

    if outreach_status == "send_failed" or outreach_status == "failed":
        if handle_part:
            return f"My intro to {target_name} didn't go through. Try DMing them: {handle_part}."
        return "My intro send didn't go through. See match details below."

    # Default fallback (outreach didn't run, error state, etc.)
    if handle_part:
        return f"DM {target_name} directly: {handle_part}."
    return "See match details below."


def format_match_notification(
    top_delib: dict,
    kind: str,
    target_name: str,
    target_handle: str | None,
    outreach_status: str | None,
    outreach_reason: str | None,
    intro_cap: int,
) -> str:
    """Sender-side Telegram message when the user's pipeline finds them
    a top-1 match.

    Refreshed 2026-05-05 (Cooper). Cleaner structure with similar
    energy to Draft C receiver-side intros, but from the perspective
    of 'here's who I found for you' rather than 'someone's agent
    reached out.' Uses outreach_status to truthfully report whether
    the cross-agent intro fired.

    Structure:
      1. Header: 'Found one for you at Consensus: {name}' (+ preliminary tag)
      2. Rationale (agent voice, verbatim)
      3. Topic + Window labeled
      4. CTA line — varies by outreach result (see _build_sender_cta_line)
      5. 'All your matches: ...' link
      6. Cap-controls footer
    """
    rationale = strip_rationale_prefix(top_delib.get("rationale", "")).strip()
    topic = (top_delib.get("conversation_topic") or "").strip()
    window = (top_delib.get("meeting_window") or "").strip()

    # Cap each piece so the total stays mobile-friendly.
    rationale = rationale[:380]
    topic = topic[:200]
    window = window[:120]

    name_for_header = target_name or "someone"
    if kind == "preliminary":
        header = f"Found one for you at Consensus: {name_for_header} (preliminary, will sharpen as I learn more about you)."
    else:
        header = f"Found one for you at Consensus: {name_for_header}."

    parts: list[str] = [header]
    if rationale:
        parts.extend(["", rationale])
    if topic:
        parts.extend(["", f"Topic: {topic}"])
    if window:
        parts.append(f"Window: {window}")

    parts.append("")
    parts.append(_build_sender_cta_line(
        name_for_header, target_handle, outreach_status, outreach_reason,
    ))

    parts.append("")
    parts.append("All your matches: https://instaclaw.io/consensus/my-matches")

    if intro_cap > 0:
        parts.append("")
        unit = "intro" if intro_cap == 1 else "intros"
        parts.append(
            f"(Set to {intro_cap} {unit}/day. Tell me 'pause intros' or 'change to N/day' anytime.)"
        )

    return "\n".join(parts)


def telegram_safe(s: str) -> str:
    """Sanitize a message for ~/scripts/notify_user.sh.

    The script sends with parse_mode=Markdown AND builds the JSON via
    shell-string interpolation (not python json.dumps), which means:
      1. A literal " in the message breaks the JSON before Telegram
         even sees it → curl posts malformed JSON → 400 Bad Request.
      2. Unbalanced * _ [ ] or ` characters break Markdown parsing →
         Telegram returns "Bad Request: can't parse entities."

    Either failure exits the script with rc=1, with the error in stdout
    (json_error). We sanitize defensively here so the message always
    survives both layers. Lossy but reliable.

    Follow-up (manifest v82): notify_user.sh should accept a parse_mode
    flag and build JSON via python json.dumps so this sanitization
    isn't needed — but for tonight, defense in depth wins.
    """
    return (
        s.replace("\\", "")     # ditch backslashes outright
         .replace('"', "'")      # quotes break JSON; swap to apostrophe
         .replace("_", " ")      # markdown italic
         .replace("*", "")       # markdown bold
         .replace("[", "(")      # markdown link bracket
         .replace("]", ")")      # markdown link bracket
         .replace("`", "'")      # markdown code
    )


def send_telegram_notification(message: str) -> bool:
    """Shell out to ~/scripts/notify_user.sh. Returns True on success.
    Never raises — notification failure does not abort the pipeline."""
    if not os.path.isfile(NOTIFY_SCRIPT):
        log("notify_skipped no_notify_script")
        return False
    safe_message = telegram_safe(message)
    try:
        proc = subprocess.run(
            [NOTIFY_SCRIPT, safe_message],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0:
            log("notify_sent")
            return True
        # Log BOTH stderr and stdout — notify_user.sh writes its
        # json_error to stdout, which we'd otherwise lose.
        out_blob = (proc.stdout or "").strip()[:240]
        err_blob = (proc.stderr or "").strip()[:240]
        log(f"notify_failed rc={proc.returncode} stdout={out_blob} stderr={err_blob}")
        return False
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"notify_failed transport={type(e).__name__}")
        return False


# ─── Application-layer delivery guarantees ───────────────────────────


def get_request(url: str, token: str) -> tuple[int, dict | None]:
    """GET helper for the my-intros / my-pending-retries endpoints."""
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
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
        log(f"http_url_error url={url} reason={e.reason}")
        return 0, None


def read_seen_log_ids() -> set:
    """Union of every log_id ever written to pending-intros{,-seen}.jsonl
    so the receiver poll dedupes against XMTP arrivals (and vice versa).
    log_id is the universal idempotency key — same row in the server
    ledger always produces one on-disk entry regardless of channel."""
    seen: set = set()
    for p in (PENDING_INTROS_FILE, PENDING_INTROS_SEEN_FILE):
        if not os.path.isfile(p):
            continue
        try:
            with open(p) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                        lid = row.get("log_id")
                        if lid:
                            seen.add(str(lid))
                    except (json.JSONDecodeError, ValueError):
                        continue
        except OSError:
            continue
    return seen


def append_pending_intro_from_poll(intro: dict) -> bool:
    """Write a poll-discovered intro to pending-intros.jsonl in the
    same row shape the xmtp-agent.mjs receiver writes. Caller has
    already deduped by log_id; we just append."""
    os.makedirs(os.path.dirname(PENDING_INTROS_FILE), exist_ok=True)
    row = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "log_id": intro.get("log_id"),
        "sender_user_id": intro.get("sender_user_id"),
        "sender_name": intro.get("sender_name"),
        "sender_bot": intro.get("sender_telegram_bot_username"),
        "sender_xmtp": intro.get("sender_xmtp_address"),
        "sender_identity_wallet": intro.get("sender_identity_wallet"),
        "topic": "",  # not stored on the row; reconstructed from prose
        "window": "",
        "prose": intro.get("message_preview") or "",
        "source": "polled",
    }
    try:
        with open(PENDING_INTROS_FILE, "a") as f:
            f.write(json.dumps(row) + "\n")
        return True
    except OSError as e:
        log(f"pending_append_failed: {e}")
        return False


def ack_outreach(log_id: str, channel: str, token: str) -> None:
    """Best-effort ACK so the sender's retry loop stops. Idempotent
    on the server side. Failure here is logged but never aborts the
    pipeline — the intro is already on disk for the agent to surface.
    """
    try:
        post_json(OUTREACH_URL, {"phase": "ack", "log_id": log_id, "channel": channel}, token)
    except Exception as e:  # noqa: BLE001
        log(f"ack_failed log_id={log_id[:8]} err={type(e).__name__}")


def poll_my_intros(token: str) -> dict:
    """Pull unacked intros targeting me from the server ledger and
    write any new ones to pending-intros.jsonl. The XMTP envelope is
    the fast path; this is the at-most-30-min fallback. Returns a
    summary dict for the cycle log."""
    summary = {"polled": 0, "new": 0, "dup": 0, "appended": 0, "errors": 0}
    status, resp = get_request(MY_INTROS_URL, token)
    if status != 200 or not resp:
        summary["errors"] += 1
        return summary
    intros = resp.get("intros") or []
    summary["polled"] = len(intros)
    if not intros:
        return summary
    seen = read_seen_log_ids()
    for intro in intros:
        log_id = intro.get("log_id")
        if not log_id:
            continue
        if str(log_id) in seen:
            summary["dup"] += 1
            # Still ACK in case the prior surface didn't successfully ack
            # (network blip, etc). Idempotent.
            ack_outreach(log_id, "polled", token)
            continue
        if append_pending_intro_from_poll(intro):
            summary["appended"] += 1
            summary["new"] += 1
            ack_outreach(log_id, "polled", token)
        else:
            summary["errors"] += 1
    return summary


def retry_unacked_outreach(token: str) -> dict:
    """Pull my outbound rows that lack ACK and re-fire the XMTP send
    via the local listener. POST phase=retry to bump retry_count and
    last_retry_at. Hard-capped at RETRY_BUDGET_PER_CYCLE so a fleet
    incident can't fan out into a ledger-replay storm."""
    summary = {"pending": 0, "retried": 0, "skipped": 0, "errors": 0}
    status, resp = get_request(MY_PENDING_RETRIES_URL, token)
    if status != 200 or not resp:
        summary["errors"] += 1
        return summary
    pending = resp.get("pending") or []
    summary["pending"] = len(pending)
    if not pending:
        return summary

    # Build the envelope using whatever info we have on the row. The
    # original prose is in message_preview. We can't reconstruct the
    # envelope JSON header exactly (the receiver doesn't strictly
    # need every field — only from_xmtp + log_id are load-bearing).
    self_xmtp = read_self_xmtp_address()
    if not self_xmtp:
        log("retry_skipped no_self_xmtp")
        summary["skipped"] = len(pending)
        return summary

    fired = 0
    for row in pending:
        if fired >= RETRY_BUDGET_PER_CYCLE:
            summary["skipped"] += 1
            continue
        log_id = row.get("log_id")
        target_xmtp = row.get("target_xmtp_address")
        prose = row.get("message_preview") or ""
        if not (log_id and target_xmtp and prose):
            summary["errors"] += 1
            continue
        # Wire format mirrors consensus_agent_outreach.build_envelope.
        header = {"v": 1, "from_xmtp": self_xmtp, "log_id": log_id}
        envelope = (
            "[INSTACLAW_AGENT_INTRO_V1]\n"
            + json.dumps(header, separators=(",", ":"))
            + "\n---\n"
            + prose.strip()
            + "\n"
        )
        # Send via local mjs listener.
        try:
            req = urllib.request.Request(
                LOCAL_XMTP_SEND_URL,
                data=json.dumps({"target_xmtp_address": target_xmtp, "body": envelope}).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                code = r.status
                _ = r.read()
        except Exception as e:  # noqa: BLE001
            log(f"retry_send_failed log_id={str(log_id)[:8]} err={type(e).__name__}")
            summary["errors"] += 1
            continue
        if code == 200:
            # Bump retry_count via API
            post_json(OUTREACH_URL, {"phase": "retry", "log_id": log_id}, token)
            summary["retried"] += 1
            fired += 1
        else:
            summary["errors"] += 1
    return summary


def read_self_xmtp_address() -> str | None:
    """Read this VM's own XMTP wallet address. Written at agent start by
    xmtp-agent.mjs to ~/.openclaw/xmtp/address. Used to populate the
    `from_xmtp` envelope field so the receiver can verify the sender via
    /api/match/v1/identify-agent."""
    try:
        with open(XMTP_ADDRESS_FILE) as f:
            v = f.read().strip()
            return v if v.startswith("0x") and len(v) == 42 else None
    except (FileNotFoundError, IOError):
        return None


def fetch_target_contact(token: str, target_user_id: str) -> dict | None:
    """Lightweight contact-info fetch for a single target — populates
    target_name + telegram_handle + intro_per_receiver_cap so the
    user-facing notification has these fields even on early-skip
    outreach paths (cold_start, no_outreach_script).

    The anti-harvest gate in /contact-info passes because the caller's
    pipeline has just deliberated against this target.
    """
    body = {"user_ids": [target_user_id]}
    status, resp = post_json(CONTACT_INFO_URL, body, token)
    if status != 200 or not resp:
        return None
    contacts = resp.get("contacts") or []
    return contacts[0] if contacts else None


def fetch_self_info(token: str) -> dict | None:
    """Resolve the caller's own display fields (name, agent_name,
    telegram_bot_username, identity_wallet) via /api/match/v1/contact-info
    with include_self=true. We need self-info on the VM to compose the
    intro envelope locally without bundling user-record reads into every
    pipeline tick."""
    # We need our own user_id to ask for it. The route_intent response
    # carries user_id, but we don't keep it across this function call —
    # so we ask contact-info to include self by looking up via gateway
    # token alone. Trick: pass a dummy user_id list with include_self.
    # The endpoint takes the caller's user_id from gateway_token auth.
    body = {"user_ids": ["00000000-0000-0000-0000-000000000000"], "include_self": True}
    status, resp = post_json(CONTACT_INFO_URL, body, token)
    if status != 200 or not resp:
        return None
    contacts = resp.get("contacts") or []
    if not contacts:
        return None
    # Find the contact whose user_id is NOT the dummy. include_self
    # appends caller's own contact regardless of the deliberation gate.
    for c in contacts:
        if c.get("user_id") != "00000000-0000-0000-0000-000000000000":
            return c
    return None


def maybe_send_agent_outreach(
    new_top1: str | None,
    last_top1: str | None,
    deliberations: list[dict],
    profile_version: int,
    is_cold_start: bool,
    token: str,
) -> dict:
    """Fire an agent-to-agent intro DM iff the top-1 changed since last
    successful cycle AND the current top-1 is a full deliberation (not
    cold-start L2-only, not a fallback). Mirrors the gating in
    maybe_send_match_notification — same change events, different
    delivery channel.

    Returns a dict summarizing what happened (for the pipeline log).
    Never raises. The pipeline's try/except wrapper would catch anything
    anyway; defensive belt-and-suspenders.
    """
    if not new_top1:
        return {"status": "skipped", "reason": "no_top1"}
    if last_top1 == new_top1:
        return {"status": "skipped", "reason": "no_top1_change"}

    # Resolve target identity early so EVERY return path carries
    # target_name + handle + cap. The user-facing notification
    # (maybe_send_match_notification) needs these regardless of
    # whether the outreach itself fired.
    target_contact = fetch_target_contact(token, new_top1) or {}
    target_enrich = {
        "target_name": target_contact.get("name") or "someone",
        "target_handle": target_contact.get("telegram_handle") or None,
        "intro_cap": int(target_contact.get("intro_per_receiver_cap") or 3),
    }

    if is_cold_start:
        # L2-only rationales are too thin for agent-to-agent intros.
        # Notify the user via Telegram (preliminary) but DO NOT spam
        # the matched person's agent based on profile-fit alone.
        return {**target_enrich, "status": "skipped", "reason": "cold_start"}
    if not os.path.isfile(OUTREACH_SCRIPT):
        return {**target_enrich, "status": "skipped", "reason": "no_outreach_script"}

    # Find the deliberation for new_top1.
    top_delib = next((d for d in deliberations if d.get("user_id") == new_top1), None)
    if not top_delib:
        return {**target_enrich, "status": "skipped", "reason": "no_delib_for_top1"}
    rationale_raw = (top_delib.get("rationale") or "").lstrip()
    if (
        rationale_raw.startswith(RATIONALE_PREFIX_FALLBACK)
        or rationale_raw.startswith(RATIONALE_PREFIX_DELIB_FAIL)
        or rationale_raw.startswith(RATIONALE_PREFIX_L2_ONLY)
    ):
        return {**target_enrich, "status": "skipped", "reason": "top1_not_full_deliberation"}

    # Resolve self info for the envelope.
    self_info = fetch_self_info(token)
    if not self_info:
        return {**target_enrich, "status": "skipped", "reason": "self_info_unresolved"}

    self_xmtp = read_self_xmtp_address()
    payload = {
        "target_user_id": new_top1,
        "profile_version": profile_version,
        "rationale": strip_rationale_prefix(rationale_raw),
        "topic": top_delib.get("conversation_topic") or "",
        "window": top_delib.get("meeting_window") or "",
        "from_user_id": self_info.get("user_id"),
        "from_name": self_info.get("name"),
        "from_agent_name": self_info.get("agent_name"),
        # Personal handle is the user-facing CTA target (e.g. "@cooperwrenn").
        # The bot username (e.g. "@edgecitybot") goes on the envelope for
        # forensics but is NOT used in the receiver-facing prose CTA —
        # routing humans to chat with someone else's AI bot is a UX
        # dead end. When the personal handle is unknown, the prose
        # falls back to the /consensus/my-matches link.
        "from_telegram_handle": self_info.get("telegram_handle"),
        "from_telegram_bot_username": self_info.get("telegram_bot_username"),
        "from_identity_wallet": self_info.get("identity_wallet"),
    }
    env = os.environ.copy()
    if self_xmtp:
        env["XMTP_SELF_ADDRESS"] = self_xmtp
    try:
        proc = subprocess.run(
            ["python3", OUTREACH_SCRIPT],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=OUTREACH_TIMEOUT_SECONDS,
            env=env,
        )
        if proc.returncode != 0:
            return {**target_enrich, "status": "error", "reason": f"rc={proc.returncode}", "stderr": (proc.stderr or "")[:240]}
        try:
            # Script's JSON output already carries target_name/handle/cap.
            # Merging target_enrich first means script values win on
            # collision (script's contact-info call is the more recent
            # read).
            parsed = json.loads((proc.stdout or "").strip().split("\n")[-1])
            return {**target_enrich, **parsed}
        except (json.JSONDecodeError, ValueError):
            return {**target_enrich, "status": "error", "reason": "parse_failed", "stdout": (proc.stdout or "")[:240]}
    except subprocess.TimeoutExpired:
        return {**target_enrich, "status": "error", "reason": "timeout"}
    except Exception as e:  # noqa: BLE001
        return {**target_enrich, "status": "error", "reason": f"exception_{type(e).__name__}"}


def maybe_send_match_notification(
    deliberations: list[dict],
    top3: list[str],
    last_top1: str | None,
    is_cold_start: bool,
    outreach_result: dict | None = None,
) -> str | None:
    """Send a Telegram notification iff the top1 candidate changed since
    last successful cycle (or this is the first successful cycle).
    Returns the new top1 user_id (so caller can persist to state) or
    None if no notification was sent.

    Material-change gate avoids spamming the user every 30 minutes when
    the same person sits at top. Per PRD §2.4 cadence rules:
    notifications fire ONLY on top-3 material shifts.

    `outreach_result` is the dict returned by maybe_send_agent_outreach
    when called BEFORE this function (pipeline now reorders so the
    outreach attempt completes first, allowing the notification to
    truthfully report what the agent did). Carries: status, reason,
    target_name, target_handle, intro_cap.
    """
    if not top3:
        return None
    new_top1 = top3[0]
    if last_top1 == new_top1:
        log("notify_skipped no_top1_change")
        return new_top1  # state still records but no message

    # Find the deliberation for this top1
    top_delib = next((d for d in deliberations if d.get("user_id") == new_top1), None)
    if not top_delib:
        log(f"notify_skipped no_delib_for_top1={new_top1[:8]}")
        return new_top1

    # Check if the rationale is actually surfaceable (not a hard fallback).
    # L2-only (cold start) is fine to surface — it's labeled in the message.
    rationale = (top_delib.get("rationale") or "").lstrip()
    if rationale.startswith(RATIONALE_PREFIX_FALLBACK) or rationale.startswith(RATIONALE_PREFIX_DELIB_FAIL):
        log("notify_skipped top1_is_fallback")
        return new_top1

    kind = "preliminary" if is_cold_start else "full"
    or_ = outreach_result or {}
    message = format_match_notification(
        top_delib=top_delib,
        kind=kind,
        target_name=(or_.get("target_name") or "").strip() or "someone",
        target_handle=(or_.get("target_handle") or None),
        outreach_status=or_.get("status"),
        outreach_reason=or_.get("reason"),
        intro_cap=int(or_.get("intro_cap") or 3),
    )
    send_telegram_notification(message)
    return new_top1


# ─── Pipeline ────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description="Consensus matching pipeline orchestrator")
    parser.add_argument("--force", action="store_true", help="bypass throttle + jitter")
    parser.add_argument("--dry-run", action="store_true", help="run pipeline but don't POST results or persist state")
    parser.add_argument("--no-jitter", action="store_true", help="skip startup jitter (for testing)")
    args = parser.parse_args()

    token = get_gateway_token()
    if not token:
        log("fatal no_gateway_token")
        return 1

    # Single-instance lock
    os.makedirs(os.path.dirname(LOCK_FILE), exist_ok=True)
    lock_fp = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("skip another_run_in_progress")
        return 0

    state = read_state()
    now = int(time.time())

    # ─ Receiver-side delivery fallback (runs every cycle) ─
    # Pull intros targeting me that have not been acked yet and write
    # them to pending-intros.jsonl. Independent of the skill-disabled
    # gate below — even users who haven't opted in to matching can
    # receive intros from others. Worst-case delivery latency is one
    # cron tick (30 min) when XMTP V3 store-and-forward drops the
    # original envelope.
    poll_summary = poll_my_intros(token)
    if poll_summary["polled"] > 0 or poll_summary["errors"] > 0:
        log(
            f"intros_poll polled={poll_summary['polled']} new={poll_summary['new']} "
            f"dup={poll_summary['dup']} appended={poll_summary['appended']} errors={poll_summary['errors']}"
        )

    # Time-only throttle. We deliberately DO NOT short-circuit on pv
    # unchanged: a new candidate can opt in without my pv changing, and
    # my pipeline must pick that up. Trust the cron tick to be the
    # heartbeat.
    last_run_at = state.get("last_run_at", 0)
    if (
        not args.force
        and not args.dry_run
        and (now - last_run_at) < MIN_INTERVAL_SECONDS
    ):
        log(f"skip throttle delta={now - last_run_at}s min={MIN_INTERVAL_SECONDS}s")
        return 0

    # Burst jitter: when 200 VMs hit the cron tick simultaneously,
    # randomized 0..MAX_JITTER_SECONDS offset spreads load. Seed by
    # PID so the same VM doesn't always get the same jitter.
    if not args.force and not args.dry_run and not args.no_jitter:
        # Deterministic-per-VM-per-cycle seed: PID + last_run_at
        seed_src = f"{os.getpid()}:{last_run_at}".encode()
        seed = int(hashlib.sha256(seed_src).hexdigest()[:8], 16)
        rng = random.Random(seed)
        jitter = rng.randint(0, MAX_JITTER_SECONDS)
        log(f"jitter sleep={jitter}s")
        time.sleep(jitter)

    # ─ Step 1: Layer 1 ─
    log("step=1 layer1_request")
    t0 = time.time()
    status, body = post_json(ROUTE_INTENT_URL, {}, token)
    layer1_ms = int((time.time() - t0) * 1000)

    if status != 200 or not body:
        err = (body or {}).get("error", "") if body else ""
        log(f"layer1_failed status={status} body={str(err)[:160]}")
        if not args.dry_run:
            write_state({**state, "last_run_at": now, "last_outcome": f"error_layer1_{status}"})
        return 1

    profile_version = body.get("profile_version")
    consent_tier = body.get("consent_tier")
    candidates = body.get("candidates") or []
    reason = body.get("reason")  # "skill_disabled" when consensus-2026 skill is off
    log(f"layer1_ok elapsed_ms={layer1_ms} pv={profile_version} tier={consent_tier} n_candidates={len(candidates)} reason={reason}")

    # ─ Skill gate (route_intent returns reason=skill_disabled when off) ─
    # The user has not enabled the consensus-2026 skill — either they're
    # not attending Consensus, or they declined the agent's organic-
    # activation offer. Either way: exit silently. The agent on this VM
    # may still detect strong Consensus signals and offer to enable the
    # skill (see SKILL.md §Organic Activation); enabling flips the state
    # via /api/match/v1/skill-toggle and the next cron tick proceeds.
    if reason == "skill_disabled":
        log(f"skip skill_disabled slug={body.get('skill_slug', 'consensus-2026')}")
        if not args.dry_run:
            write_state({**state, "last_run_at": now, "last_outcome": "skill_disabled"})
        return 0

    if profile_version is None:
        log("skip no_profile")
        if not args.dry_run:
            write_state({**state, "last_run_at": now, "last_outcome": "no_profile"})
        return 0

    if not candidates:
        log("skip no_candidates")
        if not args.dry_run:
            write_state({
                **state,
                "last_run_at": now,
                "last_pv": profile_version,
                "last_outcome": "no_candidates",
            })
        return 0

    # ─ Anchor snapshot — must happen BEFORE any subprocess call ─
    snap_dir, memory_bytes = snapshot_anchor()
    if snap_dir is None:
        log("fatal no_anchor (no SOUL.md or MEMORY.md found)")
        if not args.dry_run:
            write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": "error_no_anchor"})
        return 1
    log(f"anchor_snapshot dir={snap_dir} memory_bytes={memory_bytes}")

    # Env vars for both subprocess calls — guarantees byte-identical
    # anchor between L2 and L3, even if periodic_summary cron rewrites
    # MEMORY.md mid-cycle.
    snap_env = {
        "CONSENSUS_MEMORY_PATH": os.path.join(snap_dir, "MEMORY.md"),
        "CONSENSUS_SOUL_PATH": os.path.join(snap_dir, "SOUL.md"),
    }

    is_cold_start = memory_bytes < COLD_START_MEMORY_BYTES
    if is_cold_start:
        log(f"cold_start memory_bytes={memory_bytes} threshold={COLD_START_MEMORY_BYTES}")

    try:
        # ─ Step 2: Layer 2 (rerank) ─
        log("step=2 layer2_rerank")
        t0 = time.time()
        rc, l2_stdout, l2_stderr = run_subprocess_json(
            RERANK_SCRIPT, json.dumps(candidates), env_overrides=snap_env
        )
        layer2_ms = int((time.time() - t0) * 1000)
        if rc != 0:
            log(f"layer2_failed rc={rc} stderr={l2_stderr[:200]}")
            if not args.dry_run:
                write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": "error_layer2"})
            return 1
        try:
            ranked = json.loads(l2_stdout)
            if not isinstance(ranked, list):
                raise ValueError("not a list")
        except (json.JSONDecodeError, ValueError) as e:
            log(f"layer2_parse_failed: {e}")
            if not args.dry_run:
                write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": "error_layer2_parse"})
            return 1
        log(f"layer2_ok elapsed_ms={layer2_ms} n_ranked={len(ranked)}")

        # Merge L1 structured fields back into top-N for Layer 3 context.
        l1_by_uid = {c.get("user_id"): c for c in candidates if c.get("user_id")}
        merged_top: list[dict] = []
        for r in ranked[:TOP_N_FOR_DELIBERATION]:
            uid = r.get("user_id")
            if not uid or uid not in l1_by_uid:
                continue
            c = dict(l1_by_uid[uid])
            c["rerank_score"] = r.get("rerank_score")
            c["brief_reason"] = r.get("brief_reason")
            merged_top.append(c)

        if not merged_top:
            log("skip layer2_returned_empty_or_unmappable")
            if not args.dry_run:
                write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": "error_layer2_empty"})
            return 1

        # ─ Step 3: Layer 3 (deliberate) — OR cold-start passthrough ─
        if is_cold_start:
            log(f"step=3 layer3_skipped cold_start n={len(merged_top)}")
            deliberations = build_l2_passthrough_deliberations(merged_top)
        else:
            log(f"step=3 layer3_deliberate top_n={len(merged_top)}")
            t0 = time.time()
            rc, l3_stdout, l3_stderr = run_subprocess_json(
                DELIBERATE_SCRIPT, json.dumps(merged_top), env_overrides=snap_env
            )
            layer3_ms = int((time.time() - t0) * 1000)
            if rc != 0:
                log(f"layer3_failed rc={rc} stderr={l3_stderr[:200]}")
                if not args.dry_run:
                    write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": "error_layer3"})
                return 1
            try:
                deliberations = json.loads(l3_stdout)
                if not isinstance(deliberations, list):
                    raise ValueError("not a list")
            except (json.JSONDecodeError, ValueError) as e:
                log(f"layer3_parse_failed: {e}")
                if not args.dry_run:
                    write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": "error_layer3_parse"})
                return 1
            log(f"layer3_ok elapsed_ms={layer3_ms} n_delib={len(deliberations)}")

            # ─ Fallback abort: better stale than fresh-and-wrong ─
            n_fallback = count_fallbacks(deliberations)
            n_total = max(1, len(deliberations))
            fallback_rate = n_fallback / n_total
            if fallback_rate > FALLBACK_ABORT_THRESHOLD:
                log(f"abort high_fallback_rate {n_fallback}/{n_total} threshold={FALLBACK_ABORT_THRESHOLD}")
                # Don't write fresh garbage to cached_top3. Keep last
                # cycle's results. Bump last_run_at so the throttle
                # respects this attempt; mark outcome so observers see it.
                if not args.dry_run:
                    write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": f"abort_fallback_{n_fallback}_of_{n_total}"})
                return 0

    finally:
        cleanup_snapshot(snap_dir)

    # ─ Step 4: POST results ─
    cpv_by_uid = {c.get("user_id"): c.get("candidate_profile_version") for c in candidates}
    results_body = {
        "user_profile_version": profile_version,
        "match_kind": "intent",
        "deliberations": [
            {
                "candidate_user_id": d.get("user_id"),
                "candidate_profile_version": cpv_by_uid.get(d.get("user_id"), 1),
                "match_score": d.get("match_score", 0.0),
                "rationale": d.get("rationale", ""),
                "conversation_topic": d.get("conversation_topic") or None,
                "meeting_window": d.get("meeting_window") or None,
                "skip_reason": d.get("skip_reason") or None,
            }
            for d in deliberations
            if d.get("user_id")
        ],
    }

    if args.dry_run:
        print(json.dumps({
            "would_post_to": RESULTS_URL,
            "body_summary": {
                "user_profile_version": results_body["user_profile_version"],
                "n_deliberations": len(results_body["deliberations"]),
                "top1_score": results_body["deliberations"][0]["match_score"] if results_body["deliberations"] else None,
                "cold_start": is_cold_start,
            },
        }))
        log("dry_run_complete")
        return 0

    log("step=4 post_results")
    t0 = time.time()
    status, body = post_json(RESULTS_URL, results_body, token)
    post_ms = int((time.time() - t0) * 1000)

    if status != 200 or not body or not body.get("ok"):
        log(f"post_results_failed status={status} elapsed_ms={post_ms} body={str(body)[:200]}")
        write_state({**state, "last_run_at": now, "last_pv": profile_version, "last_outcome": "error_post"})
        return 1

    top3 = body.get("top3", [])
    log(f"post_results_ok elapsed_ms={post_ms} written={body.get('written')} top3_n={len(top3)}")

    # ─ Material-change gate (top1 changed since last successful cycle) ─
    # Reordered 2026-05-05: outreach now fires BEFORE the user-facing
    # Telegram notification so the message can truthfully say "I sent
    # the intro" vs "I hit my cap" vs "their inbox was full." Both
    # functions remain idempotent and safe to call independently;
    # this just sequences them so the notification gets the outreach
    # result as input.
    last_top3 = state.get("last_top3") or []
    last_top1: str | None = last_top3[0] if last_top3 else None
    candidate_top1: str | None = top3[0] if top3 else None

    # ─ 1. Agent-to-agent intro DM (XMTP) on material change ─
    # Wrapped in try/except so an outreach hiccup never tanks the
    # pipeline. Returns a dict with status, reason, target_name,
    # target_handle, intro_cap — consumed by the notification step.
    outreach_result: dict = {}
    if candidate_top1 is not None and last_top1 != candidate_top1:
        try:
            outreach_result = maybe_send_agent_outreach(
                new_top1=candidate_top1,
                last_top1=last_top1,
                deliberations=deliberations,
                profile_version=profile_version,
                is_cold_start=is_cold_start,
                token=token,
            )
            log(f"outreach status={outreach_result.get('status')} reason={outreach_result.get('reason', '')}")
        except Exception as e:  # noqa: BLE001
            log(f"outreach exception {type(e).__name__}")
            outreach_result = {"status": "error", "reason": f"exception_{type(e).__name__}"}

    # ─ 2. Telegram notification on material change (with outreach context) ─
    new_top1 = maybe_send_match_notification(
        deliberations, top3, last_top1, is_cold_start, outreach_result,
    )

    outcome = "ok_cold_start" if is_cold_start else "ok"
    state_out = {
        "last_run_at": now,
        "last_pv": profile_version,
        "last_outcome": outcome,
        "last_top3": top3,
        "last_notified_top1": new_top1,
    }
    write_state(state_out)

    # ─ Sender-side delivery retry (end of cycle) ─
    # XMTP V3 store-and-forward is opportunistic; if the receiver's
    # peer was offline when the original envelope went out, the
    # message can be lost. Re-fire any of MY outbound rows that are
    # >15 min old, status=sent, ack_received_at IS NULL, and
    # retry_count < 3. The receiver's mjs ACKs on successful surface
    # so this naturally stops once delivery completes via any channel.
    try:
        retry_summary = retry_unacked_outreach(token)
        if retry_summary["pending"] > 0 or retry_summary["errors"] > 0:
            log(
                f"retry_unacked pending={retry_summary['pending']} retried={retry_summary['retried']} "
                f"skipped={retry_summary['skipped']} errors={retry_summary['errors']}"
            )
    except Exception as e:  # noqa: BLE001
        log(f"retry_unacked_exception {type(e).__name__}")

    top1 = top3[0] if top3 else None
    print(f"{outcome} n={len(deliberations)} top1={top1}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
