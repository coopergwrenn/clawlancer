#!/usr/bin/env python3
"""
Layer 2 — Listwise rerank for the consensus matching engine.

Runs on the user's own VM. Takes a JSON list of ~50 candidates (the output
of Layer 1, fetched via /api/match/v1/route_intent) and reranks them using
a single Sonnet call with the user's full SOUL.md + MEMORY.md as the
prompt-cached anchor.

Why on the VM (the architectural commitment): the user's memory anchor
never leaves their VM. The matching service ships only public summaries
to the VM; the rerank judgment ships back as scores + rationale. Same
architectural posture as the deliberation step (Layer 3), and the same
posture across the rest of the InstaClaw moat.

Why prompt caching: SOUL.md (~32 KB) + MEMORY.md (variable, capped to
30 KB here) is the load-bearing input. Anthropic's prompt cache makes the
4 follow-on Layer 3 calls 90% cheaper if they reuse the same anchor.
We construct the system message in cacheable-block form so the same
anchor is reused across Layer 2 and Layer 3 within one cycle.

PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.5
("3-Layer Pipeline" — Layer 2)

Usage:
  python3 consensus_match_rerank.py <candidates.json>
  # reads candidates from the given path; emits ranked output on stdout

Or via stdin:
  cat candidates.json | python3 consensus_match_rerank.py -

Input shape (matches MatchCandidate from lib/match-scoring.ts):
  [
    {
      "user_id": "...",
      "agent_id": "...",
      "offering_summary": "...",
      "seeking_summary": "...",
      "interests": [...],
      "looking_for": [...],
      "format_preferences": [...],
      "consent_tier": "...",
      "mutual_score": 0.7
    },
    ...
  ]

Output shape (stdout — JSON array sorted by rank):
  [
    {
      "user_id": "...",
      "rank": 1,
      "rerank_score": 0.92,
      "brief_reason": "1-2 sentence rationale referencing user's specific history"
    },
    ...
  ]

Error modes (graceful degradation, important):
  - Sonnet call fails → fall back to Layer 1's mutual_score order with
    rerank_score = mutual_score and brief_reason = "<fallback: layer1>"
  - Sonnet output not JSON → same fallback. Don't crash the pipeline.
  - Missing MEMORY.md → use SOUL.md alone, log warning.
  - Both missing → fall back to Layer 1 order without calling LLM.

The point of graceful degradation: Layer 2 is a quality booster, not a
correctness gate. If it fails, the user still gets matches — just less
agent-flavored.

Telemetry on stderr (cron-friendly):
  rerank.start candidates=50
  rerank.cache_hit anchor_chars=58432
  rerank.success ranked=50 elapsed_ms=3200
  rerank.fallback reason=<...>

Design notes:
  - Pure stdlib Python. No pip install required on the VM.
  - Routes Sonnet via the same gateway proxy as strip-thinking + intent extract.
  - GATEWAY_TOKEN resolution mirrors consensus_intent_extract.py.
  - x-model-override is the same lever — flagged P1 for routing instability;
    if Sonnet doesn't route, we accept whichever model the gateway picks.
"""
import hashlib
import json
import os
import random
import subprocess
import sys
import time

# ─── Constants ───────────────────────────────────────────────────────

GATEWAY_PROXY_URL = "https://instaclaw.io/api/gateway/proxy"

SONNET_MODEL = "claude-sonnet-4-6"
SONNET_TIMEOUT_SECONDS = 30
MAX_TOKENS = 2500  # rerank ~50 candidates → ~50 entries × 30 tokens = 1500 + headroom

# Anchor paths. The orchestrator (consensus_match_pipeline.py) snapshots
# MEMORY.md + SOUL.md to tempfiles before running L2/L3 to guarantee
# byte-identical anchor across calls (otherwise the periodic_summary cron
# could rewrite MEMORY.md mid-cycle and bust the prompt cache). Honor the
# env-var override when set; fall back to the live workspace files.
MEMORY_MD = os.environ.get("CONSENSUS_MEMORY_PATH") or os.path.expanduser("~/.openclaw/workspace/MEMORY.md")
SOUL_MD = os.environ.get("CONSENSUS_SOUL_PATH") or os.path.expanduser("~/.openclaw/workspace/SOUL.md")

# Caps to keep the prompt under Sonnet's 200K context with margin.
# Anchor cap: ~60 KB combined (SOUL.md is ~32 KB; MEMORY.md may grow large).
MAX_MEMORY_CHARS = 30_000
MAX_SOUL_CHARS = 32_000

# Defensive cap on candidates pumped into the listwise prompt. Layer 1
# returns up to 50; we don't accept more than that to keep prompt bounded.
MAX_CANDIDATES = 50


def log(msg: str) -> None:
    """Telemetry-friendly stderr logger. Cron picks these up via journald."""
    sys.stderr.write(f"rerank.{msg}\n")
    sys.stderr.flush()


# ─── Auth ────────────────────────────────────────────────────────────


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


# ─── Anchor (memory + identity) ──────────────────────────────────────


def read_truncated(path: str, max_chars: int) -> str:
    """Return file contents capped at max_chars. Returns empty string if missing."""
    try:
        with open(path) as f:
            return f.read()[:max_chars]
    except (FileNotFoundError, IOError):
        return ""


def build_anchor() -> str | None:
    """SOUL.md + MEMORY.md, concatenated. Returns None if both missing."""
    soul = read_truncated(SOUL_MD, MAX_SOUL_CHARS)
    memory = read_truncated(MEMORY_MD, MAX_MEMORY_CHARS)

    if not soul and not memory:
        return None

    parts: list[str] = []
    if soul:
        parts.append(
            "# YOUR USER'S SOUL.md (your identity, behavior, values)\n\n" + soul
        )
    if memory:
        parts.append(
            "# YOUR USER'S MEMORY.md (recent context, projects, "
            "conversation themes)\n\n" + memory
        )
    return "\n\n---\n\n".join(parts)


# ─── Candidate loading ───────────────────────────────────────────────


def load_candidates(arg: str) -> list[dict]:
    """Load JSON candidate list from path or stdin ('-')."""
    if arg == "-":
        raw = sys.stdin.read()
    else:
        with open(arg) as f:
            raw = f.read()
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError(f"candidates must be a JSON array, got {type(parsed)}")
    if len(parsed) > MAX_CANDIDATES:
        log(f"truncate candidates {len(parsed)}->{MAX_CANDIDATES}")
        parsed = parsed[:MAX_CANDIDATES]
    return parsed


def shuffle_candidates(candidates: list[dict]) -> list[dict]:
    """De-bias positional rank by shuffling before the listwise call.

    Listwise rerank with N=50 has documented position bias — earlier
    candidates score higher. Layer 1 hands us candidates in mutual_score
    DESC order; if we send them through unchanged, the model amplifies
    Layer 1 rather than challenging it. Shuffle so position carries no
    signal; the model must score from MEMORY, not from order.

    Use a hash-derived seed for log-debuggability (same input → same
    shuffle), but include time so successive calls within the same
    cycle aren't identical. We don't need cross-run stability: the model
    output is keyed on user_id, not position.
    """
    if len(candidates) <= 1:
        return list(candidates)
    digest = hashlib.sha256(
        (str(time.time()) + "".join(str(c.get("user_id")) for c in candidates)).encode()
    ).hexdigest()
    rng = random.Random(int(digest[:16], 16))
    out = list(candidates)
    rng.shuffle(out)
    return out


def format_candidates_for_prompt(candidates: list[dict]) -> str:
    """Render the candidate list as a numbered enumeration.

    Note: we use 1-based positional IDs in the prompt body so the ranker
    can refer to them concisely; we map back to user_id afterwards.

    Layer 1's mutual_score is intentionally omitted — exposing it would
    anchor the model to L1's existing ranking, defeating the rerank's
    purpose. The model must score from MEMORY alone.
    """
    lines = []
    for i, c in enumerate(candidates, 1):
        offering = (c.get("offering_summary") or "").strip()
        seeking = (c.get("seeking_summary") or "").strip()
        interests = ", ".join(c.get("interests") or [])
        looking_for = ", ".join(c.get("looking_for") or [])
        formats = ", ".join(c.get("format_preferences") or [])
        lines.append(
            f"[{i}]\n"
            f"    Offering: {offering}\n"
            f"    Seeking:  {seeking}\n"
            f"    Interests: {interests or '—'}\n"
            f"    Looking for: {looking_for or '—'}\n"
            f"    Formats: {formats or '—'}"
        )
    return "\n\n".join(lines)


# ─── Rerank prompt ───────────────────────────────────────────────────

RERANK_INSTRUCTIONS = """\
You are this user's personal AI agent. The system message above is your
full identity (SOUL.md) and your memory of them (MEMORY.md) — weeks of
context: what they're building right now, what they care about, what
they've ruled out, throwaway lines they've dropped.

Rerank the candidates below for a 30-minute meeting at Consensus 2026
(May 5-7, Miami). Layer 1 already filtered to profiles whose intent
complements your user's. You apply the agent-with-memory filter — the
thing no embedding could capture.

═══ Calibration ═══

Score 0.0 to 1.0. The score is the input to a meeting decision your
user trusts. Be honest.

  0.9-1.0   Drop-everything. Your memory contains a SPECIFIC moment
            (a frustration, a stated goal, a name they brought up,
            a recent pivot) that says this meeting matters NOW.
  0.7-0.9   Strong, not urgent. Real specific signal supports it.
  0.5-0.7   Relevant by profile. NO specific user signal — would say
            "yes if asked," would not seek out.
  0.3-0.5   Tangentially relevant. Profile fit only.
  0.0-0.3   Active suppression. Something the user said rules this
            out (e.g., "not raising right now" → suppress investors).

Most candidates land 0.3-0.5. The top 12 should clear 0.5. Reserve 0.9+
for the rare specific-signal hit. If you DON'T have a specific signal,
don't fake it — cluster lower.

═══ The fabrication rule (highest priority) ═══

If you cannot quote or paraphrase a SPECIFIC moment from your user's
history that justifies a score above 0.5, the score MUST be ≤ 0.5.
Public profile data alone is insufficient to claim agent-with-memory
advantage.

When you don't have a specific signal: score 0.3-0.5 and write the
reason as "no specific signal in your history; profile fit only" or
similar transparent statement. Your user trusts you BECAUSE you tell
them when you don't know.

DO NOT invent user history. DO NOT write "you mentioned X" if you
didn't see them mention X. ONE fabricated rationale and the user
mutes the bot forever. The product depends on this rule.

═══ Voice (load-bearing) ═══

First person about the user. "You" / "your" / "you've" — NEVER their
name, NEVER "he" / "she" / "they," NEVER "the user."

CRITICAL: your memory above (MEMORY.md) is written in third person
ABOUT your user. You will be tempted to mirror that voice. Don't.
You're talking TO your user, not about them. If MEMORY.md says "Cooper
launched $TESTER," you write "you launched $TESTER." Your user is
reading the rationale — speak to them.

Plain spoken English, the way you'd speak to someone you've known for
weeks.

Banned phrases (these mark generic AI matchmakers):
  leveraging · synergistic · synergy · aligned with · passionate about
  exciting · compelling · great fit · strong fit · strong match · amazing
  world-class · thought leader · innovator · disruptor
  perfectly positioned · take it to the next level
  interesting (as a positive) · potentially (as a hedge)
  could be valuable · valuable connection

Use specific verbs and concrete nouns. Reference what your user is
actually doing right now, not abstract topics.

═══ Output ═══

STRICT JSON ARRAY ONLY, no prose, no code fences:

  [
    {"id": <int>, "score": <0.0-1.0>, "reason": "<1-2 sentences>"}
  ]

The id matches [N] in the candidate list. Include EVERY candidate.
Sort by score descending. Reason ≤ 280 chars; longer rationales are
suspicious — usually padding.
"""


def call_sonnet_rerank(token: str, anchor: str, candidates_text: str) -> str | None:
    """Single Sonnet call with the cacheable anchor + rerank instructions.

    Uses Anthropic prompt-caching block format so the (large) anchor is
    cached and reused by the 4 Layer 3 calls in the same cycle.
    """
    payload = {
        "model": SONNET_MODEL,
        "max_tokens": MAX_TOKENS,
        # Block-form system message with cache_control on the anchor.
        # Instructions go in their own block (no cache_control) since they
        # differ between Layer 2 and Layer 3.
        "system": [
            {
                "type": "text",
                "text": anchor,
                "cache_control": {"type": "ephemeral"},
            },
            {
                "type": "text",
                "text": RERANK_INSTRUCTIONS,
                "cache_control": {"type": "ephemeral"},
            },
        ],
        "messages": [
            {
                "role": "user",
                "content": "Rerank these candidates:\n\n" + candidates_text,
            }
        ],
    }

    try:
        result = subprocess.run(
            [
                "curl", "-s",
                "--max-time", str(SONNET_TIMEOUT_SECONDS),
                "-H", f"Authorization: Bearer {token}",
                "-H", "Content-Type: application/json",
                "-H", f"x-model-override: {SONNET_MODEL}",
                "-d", json.dumps(payload),
                GATEWAY_PROXY_URL,
            ],
            capture_output=True,
            text=True,
            timeout=SONNET_TIMEOUT_SECONDS + 5,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"call_failed transport={type(e).__name__}")
        return None

    if result.returncode != 0:
        log(f"call_failed exit={result.returncode} stderr={result.stderr[:200]}")
        return None

    try:
        resp = json.loads(result.stdout)

        # Telemetry: log cache stats if available
        usage = resp.get("usage", {})
        if usage:
            cache_read = usage.get("cache_read_input_tokens", 0)
            cache_create = usage.get("cache_creation_input_tokens", 0)
            log(f"usage cache_read={cache_read} cache_create={cache_create}")

        # Anthropic-shaped: content is a list of blocks. Skip thinking blocks.
        content = resp.get("content", [])
        if isinstance(content, list):
            text_parts = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type", "")
                if btype == "text" and "text" in block:
                    text_parts.append(block["text"])
                elif btype == "" and "text" in block and "thinking" not in block:
                    text_parts.append(block["text"])
            if text_parts:
                return "".join(text_parts).strip()

        # OpenAI-shaped fallback (gateway routing instability — see P1)
        choices = resp.get("choices", [])
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message", {})
            return msg.get("content", "").strip()

        log(f"no_text_in_response keys={list(resp.keys())}")
    except (json.JSONDecodeError, KeyError, IndexError, AttributeError) as e:
        log(f"parse_error {type(e).__name__}: {str(e)[:120]}")

    return None


# ─── Output parsing ──────────────────────────────────────────────────


def strip_code_fences(s: str) -> str:
    """Some models wrap JSON in ```json ... ```. Strip if present."""
    s = s.strip()
    if s.startswith("```"):
        # Remove first fence line
        nl = s.find("\n")
        if nl > 0:
            s = s[nl + 1:]
        # Remove trailing fence
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def parse_rerank_output(raw: str, candidates: list[dict]) -> list[dict] | None:
    """Parse model output, validate IDs against candidate count, return ranked list.

    Returns None on any structural failure (caller falls back to L1 order).
    """
    cleaned = strip_code_fences(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        log(f"parse_failed_json {type(e).__name__}: {str(e)[:100]}")
        return None

    if not isinstance(parsed, list):
        log(f"parse_failed not_array got={type(parsed).__name__}")
        return None

    n = len(candidates)
    seen_ids: set[int] = set()
    out: list[dict] = []

    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        cid = entry.get("id")
        score = entry.get("score")
        reason = entry.get("reason", "")
        if not isinstance(cid, int) or cid < 1 or cid > n:
            continue
        if not isinstance(score, (int, float)):
            continue
        if cid in seen_ids:
            continue  # ignore duplicate id entries
        seen_ids.add(cid)

        candidate = candidates[cid - 1]
        out.append({
            "user_id": candidate.get("user_id"),
            "agent_id": candidate.get("agent_id"),
            "rerank_score": float(max(0.0, min(1.0, score))),
            "brief_reason": (reason or "").strip()[:400],
        })

    if not out:
        log("parse_failed empty_after_validation")
        return None

    # Sort by rerank_score desc; assign ranks 1..N
    out.sort(key=lambda x: -x["rerank_score"])
    for i, entry in enumerate(out, 1):
        entry["rank"] = i

    # If the model dropped some candidates, append them at the end in
    # Layer-1 order with score=0 and a fallback reason. Important so
    # downstream Layer 3 batching doesn't lose candidates entirely.
    if len(out) < n:
        log(f"model_dropped {n - len(out)} candidates — appending in L1 order")
        for i, c in enumerate(candidates, 1):
            if i in seen_ids:
                continue
            out.append({
                "user_id": c.get("user_id"),
                "agent_id": c.get("agent_id"),
                "rerank_score": 0.0,
                "brief_reason": "<fallback: model dropped this candidate>",
                "rank": len(out) + 1,
            })

    return out


def fallback_to_l1(candidates: list[dict], reason: str) -> list[dict]:
    """Layer-1-mutual-score order with rank, when Layer 2 can't deliver."""
    log(f"fallback reason={reason}")
    sorted_l1 = sorted(
        candidates,
        key=lambda c: -(c.get("mutual_score") or 0.0),
    )
    out: list[dict] = []
    for i, c in enumerate(sorted_l1, 1):
        out.append({
            "user_id": c.get("user_id"),
            "agent_id": c.get("agent_id"),
            "rank": i,
            "rerank_score": float(c.get("mutual_score") or 0.0),
            "brief_reason": f"<fallback: {reason}>",
        })
    return out


# ─── Main ────────────────────────────────────────────────────────────


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: consensus_match_rerank.py <candidates.json|->\n")
        return 2

    arg = sys.argv[1]

    try:
        candidates = load_candidates(arg)
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as e:
        sys.stderr.write(f"rerank.fatal load_candidates: {e}\n")
        return 2

    log(f"start candidates={len(candidates)}")

    if not candidates:
        # Vacuously valid — emit empty ranking
        print("[]")
        return 0

    token = get_gateway_token()
    if not token:
        ranked = fallback_to_l1(candidates, "no_gateway_token")
        print(json.dumps(ranked))
        return 0

    anchor = build_anchor()
    if anchor is None:
        ranked = fallback_to_l1(candidates, "no_memory_or_soul")
        print(json.dumps(ranked))
        return 0

    log(f"anchor_chars={len(anchor)}")

    # P1-8: shuffle to break listwise positional bias before formatting
    shuffled = shuffle_candidates(candidates)
    candidates_text = format_candidates_for_prompt(shuffled)

    t0 = time.time()
    raw = call_sonnet_rerank(token, anchor, candidates_text)
    elapsed_ms = int((time.time() - t0) * 1000)

    if raw is None:
        ranked = fallback_to_l1(candidates, "sonnet_call_failed")
        print(json.dumps(ranked))
        return 0

    # IDs in the model's output match the SHUFFLED list (that's what we
    # sent), so parse against shuffled. Fallbacks still use the original
    # mutual_score-sorted list.
    ranked = parse_rerank_output(raw, shuffled)
    if ranked is None:
        ranked = fallback_to_l1(candidates, "parse_failed")
        print(json.dumps(ranked))
        return 0

    log(f"success ranked={len(ranked)} elapsed_ms={elapsed_ms}")
    print(json.dumps(ranked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
