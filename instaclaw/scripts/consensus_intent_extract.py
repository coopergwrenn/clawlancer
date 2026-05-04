#!/usr/bin/env python3
"""
consensus_intent_extract.py — runs on user VMs.

Reads MEMORY.md + recent agent conversation, extracts a structured intent
profile via Haiku 4.5 (routed through instaclaw.io gateway proxy with the
user's gateway_token).

Output is the structured profile that gets POSTed to /api/match/v1/profile,
where the platform embeds offering_summary + seeking_summary and writes the
matchpool_profiles row.

PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.1

Design notes:
  - Pure stdlib Python. No pip install required on VM.
  - Routes Haiku via the existing gateway proxy (matches strip-thinking.py
    pattern in lib/ssh.ts).
  - Cold-start gate: confidence floor of 0.2 if MEMORY.md is too thin.
  - Strict JSON schema validation. One retry with stricter prompt on parse fail.
  - Voice: first-person, no AI-flavored phrasing (no "passionate about",
    "leveraging", "synergies"). The summary becomes other users' view.

Usage on a VM:
  python3 consensus_intent_extract.py
  # reads MEMORY.md + recent session, POSTs to /api/match/v1/profile
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

# ─── Config ─────────────────────────────────────────────────────────

WORKSPACE_DIR = os.path.expanduser("~/.openclaw/workspace")
MEMORY_MD = os.path.join(WORKSPACE_DIR, "MEMORY.md")
SOUL_MD = os.path.join(WORKSPACE_DIR, "SOUL.md")
SESSIONS_DIR = os.path.expanduser("~/.openclaw/agents/main/sessions")
SESSIONS_JSON = os.path.join(SESSIONS_DIR, "sessions.json")

GATEWAY_PROXY_URL = "https://instaclaw.io/api/gateway/proxy"
PROFILE_ENDPOINT = "https://instaclaw.io/api/match/v1/profile"

HAIKU_MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 800
HAIKU_TIMEOUT_SECONDS = 30

# Cold-start gating thresholds
MIN_MEMORY_CHARS = 5000
MIN_MEMORY_NONEMPTY_LINES = 30
COLD_START_CONFIDENCE = 0.2

# Recent-session inclusion (last N user messages from active session)
MAX_RECENT_MESSAGES = 30

# Valid format_preferences values
VALID_FORMATS = {"1on1", "small_group", "session"}


# ─── Logging (telemetry-style, stderr) ──────────────────────────────

def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{stamp}] consensus_intent_extract: {msg}", file=sys.stderr, flush=True)


# ─── Auth / token resolution ────────────────────────────────────────

def get_gateway_token() -> str:
    """GATEWAY_TOKEN from env or ~/.openclaw/.env.  Cron doesn't source .env."""
    tok = os.environ.get("GATEWAY_TOKEN", "")
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
    return ""


# ─── Memory + session readers ───────────────────────────────────────

def read_memory_md() -> str:
    """Full MEMORY.md text. Returns empty string if missing."""
    try:
        with open(MEMORY_MD) as f:
            return f.read()
    except (FileNotFoundError, IOError):
        return ""


def read_recent_session_text(max_msgs: int = MAX_RECENT_MESSAGES) -> str:
    """Tail of the active session's user/assistant text content.

    Returns plain-text rendering, newest first, capped to max_msgs.
    Used to give the extractor freshness over MEMORY.md alone.
    """
    sid = _get_main_session_id()
    if not sid:
        return ""
    sess_file = os.path.join(SESSIONS_DIR, sid + ".jsonl")
    if not os.path.exists(sess_file):
        return ""

    msgs: list[tuple[str, str]] = []
    try:
        with open(sess_file) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    msg = entry.get("message", {})
                    role = msg.get("role", "")
                    if role not in ("user", "assistant"):
                        continue
                    content = msg.get("content", "")
                    if isinstance(content, str):
                        text = content
                    elif isinstance(content, list):
                        text = " ".join(
                            b.get("text", "")
                            for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        )
                    else:
                        continue
                    text = text.strip()
                    if text and not text.startswith("Conversation info"):
                        msgs.append((role, text[:800]))
                except json.JSONDecodeError:
                    pass
    except (IOError, OSError):
        return ""

    # Take the last max_msgs turns
    tail = msgs[-max_msgs:]
    rendered = []
    for role, text in tail:
        label = "USER" if role == "user" else "AGENT"
        rendered.append(f"{label}: {text}")
    return "\n".join(rendered)


def _get_main_session_id() -> str | None:
    """Look up the agent:main:main session ID, with telegram-direct fallback."""
    try:
        with open(SESSIONS_JSON) as f:
            sj = json.load(f)
        if "agent:main:main" in sj:
            return sj["agent:main:main"].get("sessionId")
        for key, val in sj.items():
            if "telegram" in key and "group" not in key and "cron" not in key:
                return val.get("sessionId")
    except (FileNotFoundError, IOError, json.JSONDecodeError):
        pass
    return None


# ─── Cold-start gate ────────────────────────────────────────────────

def is_cold_start(memory_text: str) -> bool:
    """True if MEMORY.md is too thin to extract a confident intent profile."""
    if len(memory_text) < MIN_MEMORY_CHARS:
        return True
    nonempty = sum(1 for line in memory_text.splitlines() if line.strip())
    if nonempty < MIN_MEMORY_NONEMPTY_LINES:
        return True
    return False


# ─── The extractor prompt ───────────────────────────────────────────

EXTRACTOR_SYSTEM_PROMPT = """You are extracting structured intent from a user's conversation history with their AI agent. The output will be used to match this user with other people at Consensus 2026 (a crypto industry conference, May 5-7, Miami).

Output STRICT JSON with exactly these fields:

{
  "offering_summary": "1-3 sentences. What the user brings to a meeting: capital, advice, deal flow, technical knowledge, intros, partnerships, time. Be specific. Use the user's actual project names, stacks, and stages. Write in FIRST PERSON, as if the user wrote it themselves.",
  "seeking_summary": "1-3 sentences. What the user is hoping to find at the conference. Be specific. FIRST PERSON.",
  "interests": ["3-7 short topic tags, lowercase, single word or hyphenated"],
  "looking_for": ["1-5 short role tags like 'biotech-founder', 'ai-investor', 'rust-engineer'"],
  "format_preferences": ["subset of: 1on1, small_group, session"],
  "confidence": 0.0-1.0
}

CRITICAL RULES:

- Write the offering and seeking summaries in FIRST PERSON, as if the user is speaking. Never third-person ("the user is..."), never agent-style ("they are working on...").

- Be SPECIFIC. Use actual project names, technical terms, and stages from the user's history. "Building agentic AI" is bad. "Building InstaClaw, a per-user AI agent platform with crypto wallets" is good.

- DO NOT use AI-flavored business jargon. Banned phrases: "passionate about", "leveraging", "synergies", "navigating the landscape", "ecosystem", "innovating", "seamless", "robust", "scalable solutions". The output sounds like a human wrote it about themselves, not like marketing copy.

- DO NOT fabricate. If the user's history doesn't mention something specific (e.g., what they're seeking), output a less specific summary or set lower confidence. Better to say "looking for technical conversations on AI infrastructure" than to invent "looking for Series A investors".

- If the user's history is thin (very few details about their project or goals), output lower confidence (0.2-0.4) and brief, generic summaries. The system handles cold-start cases via a Telegram follow-up question.

- The output MUST be valid JSON. No prose, no markdown code fences, no explanations. JSON object only."""


def build_extractor_user_prompt(memory_text: str, recent_text: str) -> str:
    """Assemble the user-facing portion of the prompt."""
    parts = ["USER'S CONVERSATION HISTORY (MEMORY.md):", memory_text or "(empty)"]
    if recent_text:
        parts.extend(["", "RECENT AGENT CONVERSATION (most recent turns):", recent_text])
    parts.extend(["", "Output: JSON object with the schema described in your instructions."])
    return "\n".join(parts)


# ─── Haiku call (via gateway proxy) ─────────────────────────────────

def call_haiku(system_prompt: str, user_prompt: str, stricter_retry: bool = False) -> str | None:
    """POST to gateway proxy with Haiku model override. Returns raw response text or None.

    Uses Anthropic Messages API format: 'system' is a top-level parameter,
    not a role in the messages array. (OpenAI-style {role:'system', content:...}
    works on some backends but is rejected when the gateway routes to
    Anthropic Claude. Anthropic format is the canonical format for claude-*
    model names; downstream gateway adapters should translate as needed.)
    """
    token = get_gateway_token()
    if not token:
        log("ERROR: no GATEWAY_TOKEN found; cannot call Haiku")
        return None

    user_content = user_prompt
    if stricter_retry:
        # On retry, prepend a stricter "JSON only" instruction
        user_content = (
            "Your previous response was not valid JSON. Try again. "
            "Output STRICT JSON object ONLY. No prose, no code fences, no commentary. "
            "Just the JSON object.\n\n"
            + user_prompt
        )

    payload = {
        "model": HAIKU_MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": user_content},
        ],
    }

    try:
        result = subprocess.run(
            [
                "curl", "-s",
                "--max-time", str(HAIKU_TIMEOUT_SECONDS),
                "-H", f"Authorization: Bearer {token}",
                "-H", "Content-Type: application/json",
                "-H", f"x-model-override: {HAIKU_MODEL}",
                "-d", json.dumps(payload),
                GATEWAY_PROXY_URL,
            ],
            capture_output=True,
            text=True,
            timeout=HAIKU_TIMEOUT_SECONDS + 5,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"Haiku call failed (transport): {e}")
        return None

    if result.returncode != 0:
        log(f"Haiku call non-zero exit {result.returncode}: {result.stderr[:200]}")
        return None

    try:
        resp = json.loads(result.stdout)

        # Anthropic-shaped: content is a list of blocks. Some are 'thinking'
        # (no 'text' key), some are 'text'. We want the text. The gateway
        # proxy may route to MiniMax-M2.5 or other thinking models, so the
        # first block is often a thinking block — skip past those.
        content = resp.get("content", [])
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                # type='text' blocks: take 'text'. type='thinking' blocks: skip.
                btype = block.get("type", "")
                if btype == "text" and "text" in block:
                    text_parts.append(block["text"])
                # Some models put text in unlabeled blocks; if no 'type' field
                # but 'text' is present, accept it.
                elif btype == "" and "text" in block and "thinking" not in block:
                    text_parts.append(block["text"])
            if text_parts:
                return "".join(text_parts).strip()

        # OpenAI-shaped fallback
        choices = resp.get("choices", [])
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message", {})
            return msg.get("content", "").strip()

        log(f"Haiku response had no extractable text. resp keys={list(resp.keys())}")
    except (json.JSONDecodeError, KeyError, IndexError, AttributeError) as e:
        log(f"Haiku response parse error: {e} — raw: {result.stdout[:300]}")

    return None


# ─── JSON schema validation ─────────────────────────────────────────

def parse_and_validate(raw: str) -> dict | None:
    """Parse raw LLM output. Strip code fences if present. Validate schema.
    Returns the validated dict, or None on any failure."""
    if not raw:
        return None

    # Strip optional markdown code fences
    text = raw.strip()
    if text.startswith("```"):
        # Remove first line (```json or ```) and last line (```)
        lines = text.split("\n")
        if len(lines) >= 2:
            lines = lines[1:]
            if lines[-1].strip() == "```":
                lines = lines[:-1]
            text = "\n".join(lines)

    # Try direct parse
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        # Salvage: try to find the first {...} block
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            log(f"parse_and_validate: no JSON object found. raw[:300]={text[:300]!r}")
            return None
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError as e:
            log(f"parse_and_validate: salvage failed: {e}. raw[:300]={text[:300]!r}")
            return None

    # Schema check
    required_str = ["offering_summary", "seeking_summary"]
    required_list = ["interests", "looking_for", "format_preferences"]
    for k in required_str:
        if not isinstance(obj.get(k), str) or not obj[k].strip():
            log(f"parse_and_validate: missing or empty {k!r}")
            return None
    for k in required_list:
        if not isinstance(obj.get(k), list):
            log(f"parse_and_validate: {k!r} not a list")
            return None
        for item in obj[k]:
            if not isinstance(item, str):
                log(f"parse_and_validate: {k!r} contains non-string item {item!r}")
                return None
    if not isinstance(obj.get("confidence"), (int, float)):
        log("parse_and_validate: confidence not a number")
        return None
    obj["confidence"] = float(obj["confidence"])
    if not 0.0 <= obj["confidence"] <= 1.0:
        log(f"parse_and_validate: confidence out of range: {obj['confidence']}")
        return None

    # format_preferences whitelist
    obj["format_preferences"] = [
        f for f in obj["format_preferences"] if f in VALID_FORMATS
    ]

    # Tag normalization: lowercase, trim, dedupe, length cap
    for k in ("interests", "looking_for"):
        seen = set()
        normalized = []
        for tag in obj[k]:
            t = tag.strip().lower()
            if not t or t in seen or len(t) > 50:
                continue
            seen.add(t)
            normalized.append(t)
        obj[k] = normalized

    # Length-cap summaries (defensive — Haiku usually respects this but cap anyway)
    obj["offering_summary"] = obj["offering_summary"].strip()[:800]
    obj["seeking_summary"] = obj["seeking_summary"].strip()[:800]

    return obj


# ─── Main extraction entry point ────────────────────────────────────

def extract_intent(memory_text: str | None = None,
                   recent_text: str | None = None) -> dict | None:
    """Extract structured intent from memory + recent session.

    Returns:
      dict with {offering_summary, seeking_summary, interests, looking_for,
                 format_preferences, confidence} on success.
      None on failure (no memory, Haiku unreachable, parse fail twice).
    """
    if memory_text is None:
        memory_text = read_memory_md()
    if recent_text is None:
        recent_text = read_recent_session_text()

    if not memory_text and not recent_text:
        log("extract_intent: no memory or recent text — cannot extract")
        return None

    cold = is_cold_start(memory_text)
    if cold:
        log(f"extract_intent: cold-start (memory={len(memory_text)} chars); will floor confidence")

    user_prompt = build_extractor_user_prompt(memory_text, recent_text)

    # First attempt
    raw = call_haiku(EXTRACTOR_SYSTEM_PROMPT, user_prompt, stricter_retry=False)
    obj = parse_and_validate(raw or "")
    if obj is None:
        log("extract_intent: first attempt failed; retrying with stricter prompt")
        time.sleep(1.0)
        raw = call_haiku(EXTRACTOR_SYSTEM_PROMPT, user_prompt, stricter_retry=True)
        obj = parse_and_validate(raw or "")
        if obj is None:
            log("extract_intent: second attempt also failed; returning None")
            return None

    # Cold-start floor
    if cold:
        obj["confidence"] = min(obj["confidence"], COLD_START_CONFIDENCE)
        log(f"extract_intent: cold-start floored confidence to {obj['confidence']}")

    log(
        f"extract_intent: success. offering={len(obj['offering_summary'])}c "
        f"seeking={len(obj['seeking_summary'])}c "
        f"interests={len(obj['interests'])} looking_for={len(obj['looking_for'])} "
        f"confidence={obj['confidence']:.2f}"
    )
    return obj


# ─── Module test (when run directly) ────────────────────────────────

if __name__ == "__main__":
    # Standalone mode: read memory + recent, extract, print result.
    # Component 4 (VM-side script) will call extract_intent() and POST to platform.
    log("running in standalone test mode")
    result = extract_intent()
    if result is None:
        log("FAILED — no extraction result")
        sys.exit(1)
    print(json.dumps(result, indent=2))
    sys.exit(0)
