#!/usr/bin/env python3
"""
Agent-to-agent intro outreach (VM-side).

Invoked by consensus_match_pipeline.py after a top-1 change. Composes
an [INSTACLAW_AGENT_INTRO_V1] envelope and sends it over XMTP to the
matched user's agent. The receiver's xmtp-agent.mjs detects the
envelope, verifies via /api/match/v1/identify-agent, and forwards a
human-readable Telegram intro to the receiver's user.

Two-phase ledger:
  1. Reserve via POST /api/match/v1/outreach (rate-limit + idempotency
     check, INSERT pending row, get log_id).
  2. Send the XMTP via the local xmtp-agent.mjs HTTP endpoint
     (127.0.0.1:18790).
  3. Finalize via POST /api/match/v1/outreach with status=sent|failed.

Idempotency anchor: "<profile_version>:<target_user_id>". Same anchor
on a re-run -> reserve returns allowed=false reason=duplicate -> we
exit silently.

Usage:
    python3 consensus_agent_outreach.py < <stdin-json>

stdin payload:
    {
      "target_user_id": "<uuid>",
      "profile_version": <int>,           -- caller's pv, used in top1_anchor
      "rationale": "...",                 -- L3 rationale (prefix-stripped)
      "topic": "...",                     -- conversation_topic
      "window": "...",                    -- meeting_window
      "from_name": "Cooper",              -- caller's user.name
      "from_agent_name": "Edge City Bot", -- caller's vm.agent_name
      "from_telegram_bot_username": "edgecitybot",  -- without @
      "from_identity_wallet": "0x..."     -- bankr first, world fallback
    }

Output (stdout): single JSON line summary
    {"ok": true, "status": "sent|skipped|failed", "log_id": "...", ...}

Exit codes: 0 always (so the calling pipeline never aborts on outreach
issues). All errors are recoded in stdout/stderr and the ledger row.
"""
import json
import os
import sys
import urllib.error
import urllib.request

# ─── Constants ───────────────────────────────────────────────────────

CONTACT_INFO_URL = "https://instaclaw.io/api/match/v1/contact-info"
OUTREACH_URL = "https://instaclaw.io/api/match/v1/outreach"
LOCAL_XMTP_SEND_URL = "http://127.0.0.1:18790/send-intro"

REQUEST_TIMEOUT_SECONDS = 25
LOCAL_TIMEOUT_SECONDS = 30

# Envelope marker — receiver's xmtp-agent.mjs detects this prefix to
# distinguish agent intros from human DMs. Versioned so we can ship
# v2 without breaking v1 receivers (they fall through to gateway).
ENVELOPE_MARKER = "[INSTACLAW_AGENT_INTRO_V1]"
ENVELOPE_SEPARATOR = "---"


# ─── Logging ─────────────────────────────────────────────────────────


def log(msg: str) -> None:
    sys.stderr.write(f"outreach.{msg}\n")
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


# ─── Self XMTP address ───────────────────────────────────────────────


def get_self_xmtp_address() -> str | None:
    """Resolve this VM's own XMTP wallet address. xmtp-agent.mjs writes it
    to ~/.openclaw/xmtp/address on every successful start. We prefer the
    env override (so the pipeline can pass a verified value), but fall
    back to the file so direct invocations from a test or admin script
    still produce a valid envelope."""
    v = (os.environ.get("XMTP_SELF_ADDRESS") or "").strip().lower()
    if v.startswith("0x") and len(v) == 42:
        return v
    addr_path = os.path.expanduser("~/.openclaw/xmtp/address")
    try:
        with open(addr_path) as f:
            v2 = f.read().strip().lower()
            if v2.startswith("0x") and len(v2) == 42:
                return v2
    except (FileNotFoundError, IOError):
        pass
    return None


# ─── HTTP helpers ────────────────────────────────────────────────────


def post_json(url: str, body: dict, token: str, timeout: int = REQUEST_TIMEOUT_SECONDS) -> tuple[int, dict | None]:
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
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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
    except Exception as e:  # noqa: BLE001
        log(f"http_unexpected url={url} err={type(e).__name__}")
        return 0, None


# ─── Envelope ────────────────────────────────────────────────────────


def build_envelope(header: dict, prose: str) -> str:
    """Build the wire format the receiver parses.

    Format:
        [INSTACLAW_AGENT_INTRO_V1]
        <single-line JSON header>
        ---
        <human-readable prose, multi-line ok>

    The prose is what gets shown to the receiver's human via Telegram.
    The JSON header carries structured data the receiver agent needs
    (sender wallet, topic, etc.) without parsing free-form text.
    """
    header_line = json.dumps(header, separators=(",", ":"), ensure_ascii=False)
    return f"{ENVELOPE_MARKER}\n{header_line}\n{ENVELOPE_SEPARATOR}\n{prose.strip()}\n"


def build_intro_prose(payload: dict, target_name: str) -> str:
    """The text that shows up in the receiver's Telegram. First-person,
    polite, factual. The sender's agent voice — same conventions as the
    L3 rationale prompt (no banned phrases).
    """
    from_name = payload.get("from_name", "An InstaClaw user").strip() or "An InstaClaw user"
    from_bot = (payload.get("from_telegram_bot_username") or "").strip().lstrip("@")
    rationale = (payload.get("rationale") or "").strip()
    topic = (payload.get("topic") or "").strip()
    window = (payload.get("window") or "").strip()

    parts: list[str] = []
    parts.append(
        f"Hi {target_name}, this is {from_name}'s agent reaching out via Consensus 2026 matching."
    )
    if rationale:
        parts.append("")
        parts.append(rationale)
    if topic:
        parts.append("")
        parts.append(f"Worth talking about: {topic}")
    if window:
        parts.append(f"Possible window: {window}")
    parts.append("")
    if from_bot:
        parts.append(
            f"If you want to follow up, message @{from_bot} on Telegram and {from_name}'s agent will relay."
        )
    else:
        parts.append(f"Reply here on XMTP if you want to coordinate.")
    return "\n".join(parts)


# ─── Local XMTP send ─────────────────────────────────────────────────


def send_via_local_xmtp(target_xmtp: str, body: str, token: str) -> tuple[bool, str | None]:
    """POST to the localhost XMTP send endpoint exposed by xmtp-agent.mjs.
    Returns (success, error_message).
    """
    payload = {"target_xmtp_address": target_xmtp, "body": body}
    status, resp = post_json(LOCAL_XMTP_SEND_URL, payload, token, timeout=LOCAL_TIMEOUT_SECONDS)
    if status == 200 and resp and resp.get("ok"):
        return True, None
    err = (resp or {}).get("error") if isinstance(resp, dict) else None
    return False, err or f"status={status}"


# ─── Main ────────────────────────────────────────────────────────────


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        print(json.dumps({"ok": False, "status": "bad_input", "error": str(e)}))
        return 0

    target_user_id = payload.get("target_user_id")
    profile_version = payload.get("profile_version")
    if not target_user_id or profile_version is None:
        print(json.dumps({"ok": False, "status": "bad_input", "error": "missing target_user_id or profile_version"}))
        return 0

    token = get_gateway_token()
    if not token:
        print(json.dumps({"ok": False, "status": "no_gateway_token"}))
        return 0

    top1_anchor = f"{profile_version}:{target_user_id}"

    # 1. Resolve target contact info.
    log(f"contact_info user_id={str(target_user_id)[:8]}")
    status, resp = post_json(CONTACT_INFO_URL, {"user_ids": [target_user_id]}, token)
    if status != 200 or not resp:
        print(json.dumps({"ok": False, "status": "contact_info_failed", "http_status": status}))
        return 0
    contacts = resp.get("contacts") or []
    if not contacts:
        log("no_contact_resolved (target may be unhealthy or not in your recent deliberations)")
        print(json.dumps({"ok": True, "status": "skipped", "reason": "no_contact_resolved"}))
        return 0
    target = contacts[0]
    target_xmtp = target.get("xmtp_address")
    target_name = target.get("name") or "there"
    if not target_xmtp:
        print(json.dumps({"ok": True, "status": "skipped", "reason": "no_xmtp_address"}))
        return 0

    # 2. Reserve outreach (rate limit + idempotency).
    prose = build_intro_prose(payload, target_name)
    preview = prose[:280]
    log(f"reserve target={str(target_user_id)[:8]} anchor={top1_anchor[:24]}")
    status, resp = post_json(
        OUTREACH_URL,
        {
            "phase": "reserve",
            "target_user_id": target_user_id,
            "target_xmtp_address": target_xmtp,
            "top1_anchor": top1_anchor,
            "message_preview": preview,
        },
        token,
    )
    if status != 200 or not resp:
        print(json.dumps({"ok": False, "status": "reserve_failed", "http_status": status}))
        return 0
    if not resp.get("allowed"):
        reason = resp.get("reason", "denied")
        log(f"skip {reason}")
        print(json.dumps({"ok": True, "status": "skipped", "reason": reason}))
        return 0
    log_id = resp.get("log_id")

    # 3. Build envelope and send.
    header = {
        "v": 1,
        "from_xmtp": get_self_xmtp_address(),
        "from_user_id": payload.get("from_user_id"),
        "from_name": payload.get("from_name"),
        "from_agent_name": payload.get("from_agent_name"),
        "from_telegram_bot_username": payload.get("from_telegram_bot_username"),
        "from_identity_wallet": payload.get("from_identity_wallet"),
        "topic": payload.get("topic") or "",
        "window": payload.get("window") or "",
        "rationale": payload.get("rationale") or "",
        "log_id": log_id,
    }
    envelope = build_envelope(header, prose)

    log(f"send_xmtp target={target_xmtp[:10]}...")
    sent, err = send_via_local_xmtp(target_xmtp, envelope, token)

    # 4. Finalize the ledger row.
    final_status = "sent" if sent else "failed"
    finalize_body: dict = {
        "phase": "finalize",
        "log_id": log_id,
        "status": final_status,
    }
    if not sent and err:
        finalize_body["error_message"] = err
    post_json(OUTREACH_URL, finalize_body, token)

    if sent:
        log(f"sent log_id={log_id}")
        print(json.dumps({"ok": True, "status": "sent", "log_id": log_id, "target_xmtp": target_xmtp}))
    else:
        log(f"send_failed err={err}")
        print(json.dumps({"ok": False, "status": "send_failed", "log_id": log_id, "error": err}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
