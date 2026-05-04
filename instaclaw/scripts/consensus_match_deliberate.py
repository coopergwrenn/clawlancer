#!/usr/bin/env python3
"""
Layer 3 — Per-candidate deliberation for the consensus matching engine.

This is the central moat: each candidate gets judged by the user's own
agent with full SOUL.md + MEMORY.md context. The output is rich, specific
rationale that no embedding could produce ("you mentioned wanting to talk
to agentic-commerce builders last Tuesday"; "you said you're not raising
right now — investor candidates suppressed").

Pipeline position: runs AFTER Layer 2 (consensus_match_rerank.py). Takes
the top N (default 12) candidates from Layer 2 and batches them into
groups of 3 for parallel calls. Same anchor as Layer 2, so the prompt
cache from the rerank call is reused — 4 calls × 90% discount on the
~2K-token anchor.

Per the PRD §2.5:
  ~5 LLM calls per refresh, ~$0.035/user/cycle, ~5s end-to-end with
  parallel execution.

Output (one entry per candidate, JSON-serializable):

  {
    "user_id": "...",
    "agent_id": "...",
    "match_score": 0.0-1.0,
    "rationale": "1-2 sentences. References specific user history.",
    "conversation_topic": "the specific thing they should discuss",
    "meeting_window": "Tue 11am during the agentic-commerce panel break",
    "skip_reason": null or string if match_score < 0.5
  }

Input shape: same as Layer 2 output OR Layer 1 output. Required fields:
user_id, agent_id, offering_summary, seeking_summary, interests,
looking_for, format_preferences. Optional: rerank_score, brief_reason
(Layer 2 carry-over).

Usage:
  python3 consensus_match_deliberate.py <ranked.json>     # path
  cat ranked.json | python3 consensus_match_deliberate.py -

Env (optional):
  DELIBERATION_MODEL  — override model (default: claude-sonnet-4-6)
  DELIBERATION_BATCH  — candidates per call (default: 3, max: 5)

Error modes (graceful degradation, important):
  - A batch call fails → its 3 candidates get fallback deliberations
    with match_score = rerank_score (or mutual_score, or 0.5),
    rationale = "<deliberation unavailable: {reason}>", everything else
    null. The pipeline still produces a complete output set.
  - JSON parse failure on a batch → same fallback, batch-level
  - Missing anchor → fall back to Layer-2-score order without LLM.
  - Top-level catastrophic failure → exit 2 with stderr message; the
    server-side caller can apply its own fallback.

PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.5

Design notes:
  - Pure stdlib Python.
  - Routes through gateway proxy with the user's gateway_token, matches
    consensus_intent_extract.py / consensus_match_rerank.py pattern.
  - Parallel batches via concurrent.futures.ThreadPoolExecutor.
  - Same prompt-cached anchor as Layer 2 — zero rebuild cost.
  - Reuses MAX_MEMORY_CHARS / MAX_SOUL_CHARS so anchor is byte-identical
    to Layer 2's (cache hit requires byte-identical content).
"""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

# ─── Constants (must match consensus_match_rerank.py for cache hit) ──

GATEWAY_PROXY_URL = "https://instaclaw.io/api/gateway/proxy"

DELIBERATION_MODEL = os.environ.get("DELIBERATION_MODEL", "claude-sonnet-4-6")
DELIBERATION_TIMEOUT_SECONDS = 35
MAX_TOKENS = 2200  # 3 candidates × ~600-char rationale + topic + window + skip

# Anchor paths. Honor env-var override (set by the orchestrator's
# anchor snapshot) so L2 and L3 read byte-identical content within
# a single cycle and share the prompt cache.
MEMORY_MD = os.environ.get("CONSENSUS_MEMORY_PATH") or os.path.expanduser("~/.openclaw/workspace/MEMORY.md")
SOUL_MD = os.environ.get("CONSENSUS_SOUL_PATH") or os.path.expanduser("~/.openclaw/workspace/SOUL.md")

# CRITICAL: byte-identical to Layer 2 caps for prompt cache hit
MAX_MEMORY_CHARS = 30_000
MAX_SOUL_CHARS = 32_000

DEFAULT_TOP_N = 12          # how many candidates Layer 3 considers
DEFAULT_BATCH_SIZE = 3      # candidates per LLM call
MAX_BATCH_SIZE = 5
MAX_PARALLEL_BATCHES = 4    # matches PRD: 4 batched calls in parallel


def log(msg: str) -> None:
    sys.stderr.write(f"deliberate.{msg}\n")
    sys.stderr.flush()


# ─── Auth + anchor (mirror of consensus_match_rerank.py) ──────────────


def get_gateway_token() -> str:
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


def read_truncated(path: str, max_chars: int) -> str:
    try:
        with open(path) as f:
            return f.read()[:max_chars]
    except (FileNotFoundError, IOError):
        return ""


def build_anchor() -> str | None:
    """Build the same anchor as Layer 2 — byte-identical for cache reuse."""
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
    if arg == "-":
        raw = sys.stdin.read()
    else:
        with open(arg) as f:
            raw = f.read()
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError(f"candidates must be a JSON array, got {type(parsed)}")
    return parsed


def format_batch_for_prompt(batch: list[dict], offset: int) -> str:
    """Render a batch of candidates with positional IDs starting at offset+1."""
    lines = []
    for i, c in enumerate(batch, offset + 1):
        offering = (c.get("offering_summary") or "").strip()
        seeking = (c.get("seeking_summary") or "").strip()
        interests = ", ".join(c.get("interests") or [])
        looking_for = ", ".join(c.get("looking_for") or [])
        formats = ", ".join(c.get("format_preferences") or [])
        l1 = c.get("mutual_score")
        l2 = c.get("rerank_score")
        l1_str = f"{l1:.3f}" if isinstance(l1, (int, float)) else "—"
        l2_str = f"{l2:.3f}" if isinstance(l2, (int, float)) else "—"
        l2_reason = (c.get("brief_reason") or "").strip()
        layer_carryover = f"L1_mutual={l1_str} L2_rerank={l2_str}"
        if l2_reason and not l2_reason.startswith("<fallback"):
            layer_carryover += f"\n    L2_brief: {l2_reason[:200]}"
        lines.append(
            f"[{i}]  ({layer_carryover})\n"
            f"    Offering: {offering}\n"
            f"    Seeking:  {seeking}\n"
            f"    Interests: {interests or '—'}\n"
            f"    Looking for: {looking_for or '—'}\n"
            f"    Formats: {formats or '—'}"
        )
    return "\n\n".join(lines)


# ─── Deliberation prompt ─────────────────────────────────────────────

DELIBERATION_INSTRUCTIONS = """\
You are this user's personal AI agent. The system message above is your
full identity (SOUL.md) and your memory of them (MEMORY.md) — weeks of
context, projects, throwaway lines, things they've ruled out.

For each candidate below, deliberate honestly whether a 30-minute
meeting at Consensus 2026 (May 5-7, Miami) would be genuinely valuable.
This rationale is what your user reads in their feed and decides on. It
must sound like an agent who actually knows them.

Layer 2 ranked these and you see its score and brief in each candidate
header. Layer 2 is informational, not binding — your full memory makes
the call.

═══ Calibration ═══

Score 0.0 to 1.0:

  0.9-1.0  Drop-everything. You can name the SPECIFIC moment in your
           memory that makes this meeting matter NOW.
  0.7-0.9  Strong. You have a real specific signal supporting it.
  0.5-0.7  Relevant by profile. NO specific user signal — "yes if
           asked, no if seeking out."
  0.3-0.5  Tangential. Set skip_reason.
  0.0-0.3  Active suppression — something the user said rules this
           out. Set skip_reason.

Most candidates land 0.3-0.5. Reserve 0.9+ for the rare specific-
signal hit.

Calibration test before scoring 0.7+: "Could the user fact-check the
rationale by searching their own MEMORY.md for what I cited?" If no,
downscore.

═══ The fabrication rule (highest priority) ═══

If you cannot point to a specific moment in your user's history that
supports score > 0.5, the score MUST be ≤ 0.5. Public profile data
alone is insufficient.

When you don't have a signal: write the rationale as "no specific
signal in your history; based on profile fit alone" or similar
transparent statement. Your user trusts you BECAUSE you tell them when
you don't know.

NEVER write "you mentioned X" unless you saw them mention X. NEVER
write "you've been working on Y" unless that's in your memory. Confused
attribution destroys the trust this product depends on. ONE fabricated
rationale and the user mutes the bot forever.

═══ The skip-reason discipline ═══

When match_score < 0.5, ALWAYS set skip_reason — one sentence
explaining what your user would say "no" to. Make it concrete:
  Good: "they want capital, you're not raising"
  Good: "their offering is consumer NFTs on Solana, nothing in your
         work touches that"
  Bad:  "intent mismatch"
  Bad:  "limited overlap"

═══ Voice (load-bearing) ═══

First person about your user. "You" / "your" / "you've" — NEVER
their name, NEVER "he" / "she" / "they," NEVER "the user."

CRITICAL: your memory above (MEMORY.md) is written in third person
ABOUT your user. You will be tempted to mirror that voice. Don't.
You're talking TO your user. If MEMORY.md says "Cooper launched
$TESTER," you write "you launched $TESTER." Your user is reading
this — speak to them, not about them.

Plain spoken English, the way you'd speak to someone you've known for
weeks.

Banned phrases (these mark generic AI matchmakers):
  leveraging · synergistic · synergy · aligned with · passionate about
  exciting · compelling · great fit · strong fit · strong match · amazing
  world-class · thought leader · innovator · disruptor
  perfectly positioned · take it to the next level
  interesting (as a positive) · potentially (as a hedge)
  could be valuable · valuable connection

Specific verbs, concrete nouns. The conversation_topic is the
load-bearing field for action — make it concrete:
  Good: "compare your stripe-payouts approach with their per-VM
         credit accounting"
  Bad:  "discuss agent platforms"

═══ Output schema (strict JSON ARRAY of objects, one per candidate) ═══

{
  "id":                 <int matching [N] in candidate list>,
  "match_score":        <0.0-1.0, calibrated per the table above>,
  "rationale":          "<1-2 sentences. First-person about your user.
                         Reference a specific signal if you have one;
                         acknowledge profile-only fit if you don't.
                         Under 350 chars.>",
  "conversation_topic": "<one sentence — the specific thing they
                         should discuss. Empty string if score < 0.5.>",
  "meeting_window":     "<one phrase — realistic time during the
                         conference. Empty string if score < 0.5.>",
  "skip_reason":        <null, OR one concrete sentence if
                         match_score < 0.5>
}

No prose, no code fences. JSON array only.

Final read-back test: "does this rationale sound like a generic AI, or
does this sound like an agent who actually knows this person?" If
generic, rewrite or downscore.
"""


def call_deliberation(
    token: str, anchor: str, candidates_text: str, batch_idx: int
) -> tuple[int, str | None, dict]:
    """One Sonnet call for one batch. Returns (batch_idx, raw_text, usage_dict)."""
    payload = {
        "model": DELIBERATION_MODEL,
        "max_tokens": MAX_TOKENS,
        "system": [
            {
                "type": "text",
                "text": anchor,
                "cache_control": {"type": "ephemeral"},
            },
            {
                "type": "text",
                "text": DELIBERATION_INSTRUCTIONS,
                "cache_control": {"type": "ephemeral"},
            },
        ],
        "messages": [
            {
                "role": "user",
                "content": "Deliberate on these candidates:\n\n" + candidates_text,
            }
        ],
    }

    usage_info: dict = {}

    try:
        result = subprocess.run(
            [
                "curl", "-s",
                "--max-time", str(DELIBERATION_TIMEOUT_SECONDS),
                "-H", f"Authorization: Bearer {token}",
                "-H", "Content-Type: application/json",
                "-H", f"x-model-override: {DELIBERATION_MODEL}",
                # Bypass heartbeat reclassification — see proxy/route.ts
                # matchPipelineBypass. Without this, calls during the
                # 5-min post-heartbeat window get force-routed to MiniMax
                # and return silentEmptyResponse on cap.
                "-H", "x-call-kind: match-pipeline",
                "-d", json.dumps(payload),
                GATEWAY_PROXY_URL,
            ],
            capture_output=True,
            text=True,
            timeout=DELIBERATION_TIMEOUT_SECONDS + 5,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"batch={batch_idx} call_failed transport={type(e).__name__}")
        return batch_idx, None, usage_info

    if result.returncode != 0:
        log(f"batch={batch_idx} call_failed exit={result.returncode}")
        return batch_idx, None, usage_info

    try:
        resp = json.loads(result.stdout)
        usage_info = resp.get("usage") or {}

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
                return batch_idx, "".join(text_parts).strip(), usage_info

        choices = resp.get("choices", [])
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message", {})
            return batch_idx, msg.get("content", "").strip() or None, usage_info

        log(f"batch={batch_idx} no_text_in_response keys={list(resp.keys())}")
    except (json.JSONDecodeError, KeyError, IndexError, AttributeError) as e:
        log(f"batch={batch_idx} parse_error {type(e).__name__}: {str(e)[:100]}")

    return batch_idx, None, usage_info


# ─── Output parsing ──────────────────────────────────────────────────


def strip_code_fences(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        if nl > 0:
            s = s[nl + 1:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def parse_batch_output(
    raw: str, batch: list[dict], offset: int
) -> list[dict] | None:
    """Parse one batch's output. Returns list of deliberation entries
    keyed by user_id, or None on parse failure."""
    cleaned = strip_code_fences(raw)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return None

    if not isinstance(parsed, list):
        return None

    entries_by_id: dict[int, dict] = {}
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        cid = entry.get("id")
        if not isinstance(cid, int) or cid < offset + 1 or cid > offset + len(batch):
            continue
        entries_by_id[cid] = entry

    if not entries_by_id:
        return None

    out: list[dict] = []
    for i, candidate in enumerate(batch, offset + 1):
        entry = entries_by_id.get(i)
        if entry is None:
            # Model dropped this one — fallback for just this candidate
            out.append(make_fallback(candidate, "model dropped this candidate"))
            continue

        score = entry.get("match_score")
        if not isinstance(score, (int, float)):
            score = candidate.get("rerank_score") or candidate.get("mutual_score") or 0.0
        score = float(max(0.0, min(1.0, score)))

        rationale = (entry.get("rationale") or "").strip()
        topic = (entry.get("conversation_topic") or "").strip()
        window = (entry.get("meeting_window") or "").strip()
        skip = entry.get("skip_reason")
        if isinstance(skip, str):
            skip = skip.strip() or None
        elif skip is not None:
            skip = None

        out.append({
            "user_id": candidate.get("user_id"),
            "agent_id": candidate.get("agent_id"),
            "match_score": score,
            "rationale": rationale[:600],
            "conversation_topic": topic[:300],
            "meeting_window": window[:200],
            "skip_reason": skip[:300] if isinstance(skip, str) else None,
        })

    return out


def make_fallback(candidate: dict, reason: str) -> dict:
    fallback_score = (
        candidate.get("rerank_score")
        if isinstance(candidate.get("rerank_score"), (int, float))
        else candidate.get("mutual_score") or 0.5
    )
    return {
        "user_id": candidate.get("user_id"),
        "agent_id": candidate.get("agent_id"),
        "match_score": float(fallback_score),
        "rationale": f"<deliberation unavailable: {reason}>",
        "conversation_topic": "",
        "meeting_window": "",
        "skip_reason": None,
    }


# ─── Main pipeline ────────────────────────────────────────────────────


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: consensus_match_deliberate.py <ranked.json|->\n")
        return 2

    arg = sys.argv[1]

    try:
        candidates = load_candidates(arg)
    except (FileNotFoundError, json.JSONDecodeError, ValueError) as e:
        sys.stderr.write(f"deliberate.fatal load_candidates: {e}\n")
        return 2

    # Cap to top-N. Caller is expected to pass already-ranked input
    # (output of Layer 2) but we cap defensively in case they don't.
    if len(candidates) > DEFAULT_TOP_N:
        log(f"truncate {len(candidates)}->{DEFAULT_TOP_N}")
        candidates = candidates[:DEFAULT_TOP_N]

    log(f"start candidates={len(candidates)}")

    if not candidates:
        print("[]")
        return 0

    token = get_gateway_token()
    if not token:
        out = [make_fallback(c, "no_gateway_token") for c in candidates]
        print(json.dumps(out))
        return 0

    anchor = build_anchor()
    if anchor is None:
        out = [make_fallback(c, "no_memory_or_soul") for c in candidates]
        print(json.dumps(out))
        return 0

    log(f"anchor_chars={len(anchor)}")

    batch_size = max(1, min(MAX_BATCH_SIZE, int(os.environ.get("DELIBERATION_BATCH", DEFAULT_BATCH_SIZE))))

    # Slice candidates into batches
    batches: list[tuple[int, list[dict]]] = []
    for i in range(0, len(candidates), batch_size):
        batches.append((i, candidates[i:i + batch_size]))

    log(f"batches={len(batches)} batch_size={batch_size}")

    # Each batch builds its own candidates_text using its offset for IDs.
    # We submit all batches to the thread pool in parallel. The first
    # batch will create the cache; later batches will hit it.
    t0 = time.time()
    results: dict[int, tuple[str | None, dict]] = {}

    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_BATCHES) as pool:
        futures = []
        for offset, batch in batches:
            text = format_batch_for_prompt(batch, offset)
            futures.append(
                pool.submit(call_deliberation, token, anchor, text, offset)
            )
        for fut in futures:
            batch_idx, raw, usage = fut.result()
            results[batch_idx] = (raw, usage)

    elapsed_ms = int((time.time() - t0) * 1000)

    # Aggregate cache stats
    total_cache_create = sum((u.get("cache_creation_input_tokens") or 0) for _, u in results.values())
    total_cache_read = sum((u.get("cache_read_input_tokens") or 0) for _, u in results.values())
    log(f"cache_create_total={total_cache_create} cache_read_total={total_cache_read}")

    # Stitch deliberations from batches into a single output array,
    # preserving the input order of `candidates`.
    out: list[dict] = []
    for offset, batch in batches:
        raw, _ = results.get(offset, (None, {}))
        parsed: list[dict] | None = None
        if raw:
            parsed = parse_batch_output(raw, batch, offset)
        if parsed is None:
            log(f"batch={offset} fallback parse_or_call_failure")
            parsed = [make_fallback(c, "batch parse/call failure") for c in batch]
        out.extend(parsed)

    log(f"success n={len(out)} elapsed_ms={elapsed_ms}")
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
