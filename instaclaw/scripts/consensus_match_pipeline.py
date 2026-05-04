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
COLD_START_MEMORY_BYTES = 5_000

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
    log(f"layer1_ok elapsed_ms={layer1_ms} pv={profile_version} tier={consent_tier} n_candidates={len(candidates)}")

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

    outcome = "ok_cold_start" if is_cold_start else "ok"
    state_out = {
        "last_run_at": now,
        "last_pv": profile_version,
        "last_outcome": outcome,
        "last_top3": top3,
    }
    write_state(state_out)

    top1 = top3[0] if top3 else None
    print(f"{outcome} n={len(deliberations)} top1={top1}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
