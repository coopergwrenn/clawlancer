#!/usr/bin/env python3
"""
gbrain MCP runtime verification — the load-bearing post-install gate.

Spawns ``gbrain serve`` as a subprocess, drives a JSON-RPC ``put_page`` →
``query`` round-trip, and exits non-zero on any structural failure. Emits a
single ``RESULT_OK ...`` line on success or ``RESULT_FAIL <code> ...`` on
failure, consumable by parent shell / TS wrappers.

Why this exists
---------------
Phase F in install-gbrain.sh was just a "did the process print a banner"
probe. It missed three categories of bug that DID happen on real VMs:

1. **Dimension mismatch** (vm-050, 2026-05-11): ``GBRAIN_EMBEDDING_DIMENSIONS=1024``
   in the MCP env, but PGLite schema hardcodes ``vector(1536)``. ``put_page``
   threw "expected 1536 dimensions, not 1024" on every call. Banner probe
   passed; real writes failed silently.
2. **Missing ANTHROPIC_API_KEY**: ``gateway.ts:304`` silently returns the
   original query without expansion when the key is absent. Search still works,
   just at degraded quality. Banner probe doesn't catch this.
3. **PGLite write failure**: disk full, permission issue, schema migration
   stalled. Banner probe doesn't exercise the write path.

This script catches all three by doing what an agent actually does: spawn the
MCP server, list tools, write a marker page, query for it, verify round-trip.

Lifecycle
---------
1. Validate required env vars are set (caller is responsible for sourcing them).
2. Spawn ``gbrain serve`` with the resolved env.
3. JSON-RPC ``initialize`` (protocol 2024-11-05).
4. Send ``notifications/initialized``.
5. ``tools/list`` — discover the actual put/query tool names (defensive against
   gbrain version renames).
6. ``tools/call`` ``put_page`` (or detected equivalent) with a stable marker
   slug ``_gbrain-install-verify`` and a timestamped body.
7. ``tools/call`` ``query`` (or detected equivalent), substring-match the
   timestamp in the response.
8. Inspect stderr for ``expansion disabled`` warnings (non-fatal — signals
   Anthropic expansion is broken but other paths are fine).
9. SIGTERM the subprocess, wait, SIGKILL on timeout.

Idempotency / pollution
-----------------------
Marker slug ``_gbrain-install-verify`` is stable across runs (overwrites itself
on every install). Leading underscore is gbrain's convention for hidden /
system pages so it doesn't pollute default queries.

Required environment
--------------------
- ``OPENAI_API_KEY`` — for embedding (text-embedding-3-large)
- ``ANTHROPIC_API_KEY`` — for query expansion (Haiku) + chat (Sonnet)
- ``GBRAIN_DATABASE_URL`` — pglite:///path/to/brain.pglite

Optional environment
--------------------
- ``MARKER_TS`` — override marker timestamp (default: current unix epoch).
  Useful for correlating with parent script logs.
- ``GBRAIN_BIN`` — override gbrain binary path (default: ``~/.bun/bin/gbrain``).
- ``VERIFY_TIMEOUT_S`` — total wall-clock budget (default: 180s).

Exit codes
----------
0   RESULT_OK    — round-trip succeeded
1   RESULT_FAIL  — any failure; diagnostic code in the FAIL line
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────
MCP_PROTOCOL_VERSION = "2024-11-05"
MARKER_SLUG = "_gbrain-install-verify"

# Per-step JSON-RPC timeouts (server-side: embedding + query both call out)
TIMEOUT_INIT = 30
TIMEOUT_TOOLS_LIST = 15
TIMEOUT_PUT_PAGE = 60   # OpenAI embedding adds 1-3s typical latency
TIMEOUT_QUERY = 60      # Anthropic expansion adds 1-3s typical latency

# Defensive tool-name aliases — gbrain's tool names have been stable but we
# tolerate renames so this gate doesn't break on a version bump alone.
PUT_TOOL_CANDIDATES = ("put_page", "page_put", "write_page", "import_page")
QUERY_TOOL_CANDIDATES = ("query", "search", "query_brain")


# ─────────────────────────────────────────────────────────────────────────────
# Output helpers
# ─────────────────────────────────────────────────────────────────────────────
def emit_fail(code: str, **details) -> "NoReturn":  # type: ignore[name-defined]
    """Print a structured RESULT_FAIL line and exit 1.

    Parent scripts grep for the leading token to classify the failure. Detail
    values are JSON-encoded so callers can extract structured fields.
    """
    parts = [code]
    for k, v in details.items():
        encoded = v if isinstance(v, str) and " " not in v and "\n" not in v else json.dumps(v)
        parts.append(f"{k}={encoded}")
    print("RESULT_FAIL " + " ".join(parts), flush=True)
    sys.exit(1)


def emit_ok(**details) -> None:
    parts = []
    for k, v in details.items():
        encoded = v if isinstance(v, str) and " " not in v and "\n" not in v else json.dumps(v)
        parts.append(f"{k}={encoded}")
    print("RESULT_OK " + " ".join(parts), flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# Subprocess I/O plumbing
# ─────────────────────────────────────────────────────────────────────────────
def _reader_thread(stream, line_q) -> None:
    """Drain a subprocess stdout/stderr stream into a queue.

    Posting ``None`` signals EOF so the consumer can stop waiting.
    """
    try:
        for raw in iter(stream.readline, b""):
            line_q.put(raw.decode("utf-8", errors="replace"))
    except Exception as e:
        line_q.put(f"__READER_ERROR__:{e}\n")
    finally:
        line_q.put(None)


def _send(proc, payload, lock) -> None:
    """Write one JSON-RPC line to the subprocess stdin under a lock."""
    encoded = (json.dumps(payload) + "\n").encode()
    with lock:
        proc.stdin.write(encoded)
        proc.stdin.flush()


def _recv_with_id(line_q, target_id: int, timeout_s: int, recent_log: list) -> dict:
    """Drain queued stdout lines until we find a response with matching id."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            line = line_q.get(timeout=0.5)
        except queue.Empty:
            continue
        if line is None:
            emit_fail("FATAL_SERVER_EOF", target_id=target_id, recent=recent_log[-5:])
        if line.startswith("__READER_ERROR__"):
            emit_fail("FATAL_READER_ERROR", err=line.strip())
        stripped = line.strip()
        if not stripped:
            continue
        try:
            msg = json.loads(stripped)
        except json.JSONDecodeError:
            # gbrain serve may emit non-JSON banner/log lines; preserve for forensics
            recent_log.append(stripped[:200])
            continue
        if msg.get("id") == target_id:
            return msg
        # Notifications / other-id responses — store and keep looking
        recent_log.append(stripped[:120])
    emit_fail("FATAL_TIMEOUT", target_id=target_id, timeout_s=timeout_s, recent=recent_log[-5:])


# ─────────────────────────────────────────────────────────────────────────────
# Tool-name detection
# ─────────────────────────────────────────────────────────────────────────────
def pick_tool(tool_names: list, candidates: tuple) -> str | None:
    """Return the first candidate that appears in tool_names, else None."""
    for c in candidates:
        if c in tool_names:
            return c
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Main flow
# ─────────────────────────────────────────────────────────────────────────────
def main() -> None:
    # Validate env. Caller (install-gbrain.sh or _apply-gbrain-path-a.ts wrapper)
    # is responsible for sourcing these from the VM's ~/.openclaw/.env.
    required = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GBRAIN_DATABASE_URL")
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        emit_fail("FATAL_MISSING_ENV", missing=missing)

    marker_ts = os.environ.get("MARKER_TS") or str(int(time.time()))
    marker_title = f"gbrain install verify {marker_ts}"
    marker_unique = f"gbrain-verify-marker-{marker_ts}"
    marker_body = (
        f"Marker page written by gbrain install verification at ts={marker_ts}. "
        f"Tag: {marker_unique}. This page is overwritten on every re-run. "
        f"Safe to ignore — it's a system page used to assert put/query work."
    )

    gbrain_bin = os.environ.get("GBRAIN_BIN") or os.path.expanduser("~/.bun/bin/gbrain")
    if not os.path.exists(gbrain_bin):
        emit_fail("FATAL_GBRAIN_BIN_MISSING", path=gbrain_bin)

    # Spawn gbrain serve with the resolved env. We use the parent env wholesale
    # (so PATH, NVM, etc. propagate) and overlay just the things gbrain reads.
    child_env = os.environ.copy()
    proc = subprocess.Popen(
        [gbrain_bin, "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=child_env,
        bufsize=0,
    )

    stdout_q: queue.Queue = queue.Queue()
    stderr_chunks: list = []
    send_lock = threading.Lock()
    recent_lines: list = []

    threading.Thread(target=_reader_thread, args=(proc.stdout, stdout_q), daemon=True).start()

    def _stderr_collector() -> None:
        try:
            for raw in iter(proc.stderr.readline, b""):
                stderr_chunks.append(raw.decode("utf-8", errors="replace"))
        except Exception:
            pass

    threading.Thread(target=_stderr_collector, daemon=True).start()

    try:
        # 1. initialize handshake
        _send(proc, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "gbrain-install-verify", "version": "1.0"},
            },
        }, send_lock)
        init_resp = _recv_with_id(stdout_q, 1, TIMEOUT_INIT, recent_lines)
        if "error" in init_resp:
            emit_fail("FATAL_INIT_ERROR", error=init_resp["error"])

        # 2. initialized notification (no response expected)
        _send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"}, send_lock)
        time.sleep(0.2)  # let the server settle into tool-routing mode

        # 3. tools/list — discover real names
        _send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, send_lock)
        tools_resp = _recv_with_id(stdout_q, 2, TIMEOUT_TOOLS_LIST, recent_lines)
        if "error" in tools_resp:
            emit_fail("FATAL_TOOLS_LIST_ERROR", error=tools_resp["error"])
        tools = (tools_resp.get("result") or {}).get("tools") or []
        tool_names = [t.get("name", "") for t in tools]
        if not tool_names:
            emit_fail("FATAL_NO_TOOLS", resp=tools_resp)

        put_name = pick_tool(tool_names, PUT_TOOL_CANDIDATES)
        query_name = pick_tool(tool_names, QUERY_TOOL_CANDIDATES)
        if not put_name or not query_name:
            emit_fail("FATAL_TOOL_NAMES_NOT_FOUND",
                      put_name=put_name or "",
                      query_name=query_name or "",
                      available=tool_names[:30])

        # 4. put_page (will exercise embedding → catches dim mismatch)
        _send(proc, {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {
                "name": put_name,
                "arguments": {
                    "slug": MARKER_SLUG,
                    "title": marker_title,
                    "content": marker_body,
                },
            },
        }, send_lock)
        put_resp = _recv_with_id(stdout_q, 3, TIMEOUT_PUT_PAGE, recent_lines)
        if "error" in put_resp:
            emit_fail("FATAL_PUT_ERROR",
                      error=put_resp["error"],
                      hint="dim mismatch (schema is vector(1536)) or OPENAI_API_KEY invalid")
        put_result = put_resp.get("result") or {}
        if put_result.get("isError"):
            tool_err = "".join(
                b.get("text", "") for b in put_result.get("content", []) if b.get("type") == "text"
            )
            emit_fail("FATAL_PUT_ISERROR", text=tool_err[:500])

        # 5. query — must find the unique marker.
        # gbrain's query tool accepts `query` (not `q` — confirmed empirically
        # on v0.28.1 where `{"q": ...}` returns
        # `invalid_params: Missing required parameter: query`). We also send `q`
        # as a defensive alias in case a future gbrain version renames it.
        query_args = {"query": marker_unique, "q": marker_unique}
        # If the tool's inputSchema declares specific required params, prefer those
        for t in tools:
            if t.get("name") == query_name:
                schema = (t.get("inputSchema") or {})
                req = schema.get("required") or []
                props = schema.get("properties") or {}
                # If schema says required field is 'query', drop the alias.
                # If schema says 'q' is required and 'query' isn't, swap.
                if "query" in req and "q" not in req:
                    query_args = {"query": marker_unique}
                elif "q" in req and "query" not in req:
                    query_args = {"q": marker_unique}
                # Otherwise leave both — MCP servers typically ignore unknown params.
                _ = props  # currently unused; placeholder for future schema-driven param mapping
                break
        _send(proc, {
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": query_name, "arguments": query_args},
        }, send_lock)
        query_resp = _recv_with_id(stdout_q, 4, TIMEOUT_QUERY, recent_lines)
        if "error" in query_resp:
            emit_fail("FATAL_QUERY_ERROR", error=query_resp["error"])
        query_result = query_resp.get("result") or {}
        if query_result.get("isError"):
            tool_err = "".join(
                b.get("text", "") for b in query_result.get("content", []) if b.get("type") == "text"
            )
            emit_fail("FATAL_QUERY_ISERROR", text=tool_err[:500])

        # 6. Substring-verify the marker appears in the query response. Query
        # results are typically wrapped as JSON text blocks; we serialize the
        # full result and look for the marker string.
        result_blob = json.dumps(query_result)
        if marker_ts not in result_blob and marker_unique not in result_blob:
            emit_fail("FATAL_MARKER_NOT_FOUND",
                      marker_ts=marker_ts,
                      marker_unique=marker_unique,
                      first_chars=result_blob[:400])

        # 7. Inspect stderr for the expansion-disabled warning (gateway.ts:334).
        # This is non-fatal — query still works without expansion — but we
        # surface it so the operator knows the Anthropic path didn't engage.
        stderr_text = "".join(stderr_chunks).lower()
        expansion_disabled = "expansion disabled" in stderr_text
        # Also detect "anthropic" errors (auth failure, etc.) — surface them
        anthropic_auth_err = (
            "anthropic" in stderr_text and ("401" in stderr_text or "unauthor" in stderr_text)
        )

        emit_ok(
            marker_ts=marker_ts,
            put_tool=put_name,
            query_tool=query_name,
            tools_count=len(tool_names),
            expansion_ok="no" if expansion_disabled else "yes",
            anthropic_auth_warn="yes" if anthropic_auth_err else "no",
        )

    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=2)
            except Exception:
                pass
        # Surface stderr tail for forensics (parent script captures stdout for
        # the RESULT line, stderr separately).
        if stderr_chunks:
            sys.stderr.write("--- gbrain stderr (tail) ---\n")
            sys.stderr.write("".join(stderr_chunks)[-2000:])
            if not stderr_chunks[-1].endswith("\n"):
                sys.stderr.write("\n")


if __name__ == "__main__":
    main()
