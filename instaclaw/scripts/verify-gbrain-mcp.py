#!/usr/bin/env python3
"""
verify-gbrain-mcp.py — Load-bearing post-install gate for HTTP sidecar (Rule 35).

Drives a real put_page → get_page round-trip via the running gbrain sidecar at
http://127.0.0.1:3131/mcp with Bearer auth. Emits a single ``RESULT_OK <kvpairs>``
line on success or ``RESULT_FAIL <code> <kvpairs>`` on any failure, consumable
by install-gbrain.sh Phase H + the stepGbrain output parser in vm-reconcile.ts.

Why this exists (the THREE bug classes Phase F-G can miss):

1. **Embedding-dimension mismatch** — gbrain's PGLite schema hardcodes
   ``vector(1536)``. If GBRAIN_EMBEDDING_DIMENSIONS is set to a different
   value (or if a future schema migration introduces drift), every put_page
   fails at embed time. The HTTP smoke test in Phase F2/F3 doesn't exercise
   the write path; only Phase H does.

2. **PGLite write failure** — disk full, file permission, schema migration
   stalled. /health may return 200 (lightweight stat query) but put_page
   triggers an actual INSERT that catches these.

3. **Bearer-token mismatch** — the sidecar may be running with a token
   minted against an OLD PGLite (e.g., a re-mint that didn't propagate to
   the token file). Phase F2's initialize call would catch a complete
   mismatch (401), but a partial mismatch (e.g., a stale token that's still
   recognized but maps to wrong scope) is only caught by a real tools/call
   that exercises the full auth + scope path.

Lifecycle (no subprocess management — sidecar runs separately):
    1. Validate required env vars (GBRAIN_BEARER_TOKEN, MARKER_TS).
    2. GET /health (no auth) — fail fast if sidecar unreachable.
    3. POST /mcp initialize (with bearer) — confirms auth + server identity.
    4. POST /mcp tools/list (with bearer) — discovers put + retrieve tool names
       defensively (so a future gbrain rename doesn't false-fail us).
    5. POST /mcp tools/call put_page — writes a marker page with MARKER_TS body.
    6. POST /mcp tools/call get_page — reads by slug, asserts MARKER_TS present.
    7. Print RESULT_OK <kvpairs>.

Idempotency: marker slug ``_gbrain-install-verify`` is stable across runs (overwrites
itself on every install). Leading underscore = gbrain convention for hidden/system
pages — does not pollute default queries.

Required env (caller responsibility — install-gbrain.sh Phase H sets these):
    GBRAIN_BEARER_TOKEN  — bearer for /mcp (from ~/.gbrain/openclaw-bearer-token.txt)
    MARKER_TS            — unique timestamp string for round-trip correlation

Optional env (passed-through for diagnostic; this script doesn't use them
directly — they're consumed by the sidecar's gbrain process via its own env):
    OPENAI_API_KEY       — embedding (text-embedding-3-large)
    ANTHROPIC_API_KEY    — query expansion (not used by our retrieval path)

Output contract (PARSED by parent shell — DO NOT change shape):
    RESULT_OK marker_ts=... put_tool=put_page retrieve_tool=get_page tools_count=N server_version=...
    RESULT_FAIL <CODE> <kvpairs>

Exit codes:
    0    RESULT_OK printed (round-trip succeeded)
    1    RESULT_FAIL printed (any failure mode)

Failure codes (the catalog the install script's exit 20 rolls up):
    NO_TOKEN                — GBRAIN_BEARER_TOKEN missing/empty
    HEALTH_UNREACHABLE      — /health connect failure (sidecar down)
    HEALTH_NOT_OK           — /health 200 but status != "ok" (PGLite broken)
    AUTH_401                — bearer rejected on /mcp (token mismatch)
    INIT_HTTP_ERROR         — /mcp initialize non-401 HTTP error
    INIT_ERROR              — /mcp initialize socket/parse error
    INIT_UNEXPECTED_SERVER  — serverInfo.name != "gbrain" (wrong server on port)
    INIT_MCP_ERROR          — JSON-RPC error in initialize response
    TOOLS_LIST_ERROR        — tools/list HTTP or parse error
    NO_PUT_PAGE             — put_page not in tools list
    NO_RETRIEVE_TOOL        — neither get_page nor search in tools list
    PUT_ISERROR             — put_page returned isError=true (PGLite write fail)
    PUT_UNEXPECTED          — put_page response shape unexpected
    RETRIEVE_ISERROR        — get_page returned isError=true
    MARKER_NOT_FOUND        — page written but MARKER_TS missing in retrieved body

Design notes for future readers:
- Stdlib only (urllib, json) so this runs on any bare Ubuntu VM without pip.
- Per-call timeouts are tight by purpose (5-30s); the parent shell wraps us
  in a 180s outer timeout but we want to fail fast at the right layer.
- We use get_page (slug lookup) not search (semantic) so the verify doesn't
  depend on Anthropic expansion — a missing/invalid Anthropic key
  shouldn't FATAL the install (per the May-12 PRD §5.5 cost/risk profile).
- SSE response parsing handles both `event: message\ndata: {...}` and plain
  JSON. The MCP SDK on the server side wraps single-shot responses in SSE.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

SIDECAR_BASE = "http://127.0.0.1:3131"
HEALTH_URL = f"{SIDECAR_BASE}/health"
MCP_URL = f"{SIDECAR_BASE}/mcp"

# Per-call timeouts (seconds). Tight enough that we fail at the right layer
# without burning the parent's 180s outer budget. Loose enough that a real
# put_page (which does an OpenAI embed call) has headroom.
TIMEOUT_HEALTH = 5
TIMEOUT_INIT = 30
TIMEOUT_TOOLS_LIST = 10
TIMEOUT_PUT_PAGE = 30  # includes OpenAI embedding round-trip
TIMEOUT_GET_PAGE = 10

# Idempotent marker slug. Leading underscore = gbrain hidden/system page
# convention; overwrites itself on every verify run.
MARKER_SLUG = "_gbrain-install-verify"


# ─────────────────────────────────────────────────────────────────────────────
# Output helpers
# ─────────────────────────────────────────────────────────────────────────────

def fail(code: str, **kw: object) -> "te.NoReturn":  # type: ignore[name-defined]
    """Print RESULT_FAIL line and exit non-zero.

    Format: ``RESULT_FAIL <CODE> key1=value1 key2=value2 ...``
    Values are truncated to keep the line under 1000 chars (operator-readable;
    full stderr is captured by parent shell for forensics).
    """
    parts = [f"RESULT_FAIL {code}"]
    for k, v in kw.items():
        # Truncate long values + strip newlines so the RESULT line stays single-line
        s = str(v).replace("\n", "\\n").replace("\r", "\\r")
        if len(s) > 200:
            s = s[:200] + "...[truncated]"
        parts.append(f"{k}={s}")
    print(" ".join(parts))
    sys.exit(1)


def ok(**kw: object) -> "te.NoReturn":  # type: ignore[name-defined]
    """Print RESULT_OK line and exit 0."""
    parts = ["RESULT_OK"]
    for k, v in kw.items():
        s = str(v).replace("\n", "\\n").replace("\r", "\\r")
        if len(s) > 200:
            s = s[:200] + "...[truncated]"
        parts.append(f"{k}={s}")
    print(" ".join(parts))
    sys.exit(0)


# ─────────────────────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────────────────────

def parse_mcp_response(body: bytes) -> dict:
    """Parse an MCP HTTP response body, handling both SSE and plain JSON.

    The MCP SDK on the server wraps single-shot responses in SSE format:
        event: message
        data: {"jsonrpc":"2.0",...}

    For pure JSON responses (e.g., from a non-SSE-capable client view), we
    also fall through to a plain json.loads.

    Raises:
        ValueError: if neither SSE-data line nor plain JSON parses.
    """
    text = body.decode("utf-8", errors="replace")
    # SSE format: scan for first "data: " line
    for line in text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    # Plain JSON fallback
    return json.loads(text)


def post_mcp(token: str, payload: dict, timeout: int) -> dict:
    """POST a JSON-RPC payload to /mcp with Bearer auth.

    Returns the parsed response dict (from SSE or plain JSON).

    Raises:
        urllib.error.HTTPError: on 4xx/5xx — caller maps 401 to AUTH_401.
        urllib.error.URLError / TimeoutError: on socket-level failure.
        ValueError / json.JSONDecodeError: on response body parse failure.
    """
    req = urllib.request.Request(
        MCP_URL,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {token}",
        },
        data=json.dumps(payload).encode("utf-8"),
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return parse_mcp_response(resp.read())


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    # ── Step 1: validate caller-supplied env ──
    token = os.environ.get("GBRAIN_BEARER_TOKEN", "").strip()
    if not token:
        fail("NO_TOKEN", hint="caller must export GBRAIN_BEARER_TOKEN from ~/.gbrain/openclaw-bearer-token.txt")

    marker_ts = os.environ.get("MARKER_TS", "").strip()
    if not marker_ts:
        # Fall back to current epoch — not fatal, just less useful for correlation.
        marker_ts = str(int(time.time()))

    # ── Step 2: /health (no auth) — fail fast if sidecar unreachable ──
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=TIMEOUT_HEALTH) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            try:
                health = json.loads(body)
            except json.JSONDecodeError as e:
                fail("HEALTH_NOT_OK", reason="non_json_body", err=str(e), body=body[:120])
            if health.get("status") != "ok":
                fail("HEALTH_NOT_OK", status=health.get("status"), engine=health.get("engine"), body=body[:120])
            server_version = health.get("version", "unknown")
    except urllib.error.HTTPError as e:
        # /health shouldn't error — if it does, the sidecar is misconfigured at a
        # deep level. Surface the code.
        fail("HEALTH_UNREACHABLE", reason="http_error", code=e.code, msg=str(e)[:120])
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        fail("HEALTH_UNREACHABLE", reason="socket", err=str(e)[:120])

    # ── Step 3: /mcp initialize (with bearer) ──
    try:
        init = post_mcp(token, {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "verify-gbrain-mcp", "version": "1.0"},
            },
        }, timeout=TIMEOUT_INIT)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            fail("AUTH_401", hint="bearer token rejected — file/DB hash mismatch?")
        fail("INIT_HTTP_ERROR", code=e.code, msg=str(e)[:120])
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        fail("INIT_ERROR", reason="socket", err=str(e)[:120])
    except (ValueError, json.JSONDecodeError) as e:
        fail("INIT_ERROR", reason="parse", err=str(e)[:120])

    # MCP-level error (JSON-RPC error response)
    if init.get("error"):
        err = init["error"]
        fail("INIT_MCP_ERROR", code=err.get("code"), msg=str(err.get("message"))[:120])

    server_info = init.get("result", {}).get("serverInfo", {})
    if server_info.get("name") != "gbrain":
        # Some other MCP server is bound to port 3131 — operator must investigate.
        fail("INIT_UNEXPECTED_SERVER", got=server_info.get("name"), expected="gbrain")

    server_mcp_version = server_info.get("version", "unknown")

    # ── Step 4: /mcp tools/list — defensive tool-name discovery ──
    try:
        tools_resp = post_mcp(token, {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        }, timeout=TIMEOUT_TOOLS_LIST)
    except urllib.error.HTTPError as e:
        fail("TOOLS_LIST_ERROR", reason="http", code=e.code, msg=str(e)[:120])
    except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError, json.JSONDecodeError) as e:
        fail("TOOLS_LIST_ERROR", reason="socket_or_parse", err=str(e)[:120])

    if tools_resp.get("error"):
        err = tools_resp["error"]
        fail("TOOLS_LIST_ERROR", reason="mcp_error", code=err.get("code"), msg=str(err.get("message"))[:120])

    tool_names = [t.get("name") for t in tools_resp.get("result", {}).get("tools", [])]

    if "put_page" not in tool_names:
        fail("NO_PUT_PAGE", tool_count=len(tool_names), sample=",".join(tool_names[:10]))

    # Prefer get_page (slug lookup — no Anthropic expansion needed). Fall back
    # to search or query if get_page isn't present. This lets a future gbrain
    # rename or removal of get_page still pass the verify if a working
    # alternative exists.
    if "get_page" in tool_names:
        retrieve_tool = "get_page"
    elif "search" in tool_names:
        retrieve_tool = "search"
    elif "query" in tool_names:
        retrieve_tool = "query"
    else:
        fail("NO_RETRIEVE_TOOL", tool_count=len(tool_names), sample=",".join(tool_names[:10]))

    # ── Step 5: tools/call put_page — write the marker page ──
    marker_body = f"gbrain HTTP sidecar install verify — marker_ts={marker_ts}"
    try:
        put_resp = post_mcp(token, {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "put_page",
                "arguments": {"slug": MARKER_SLUG, "content": marker_body},
            },
        }, timeout=TIMEOUT_PUT_PAGE)
    except urllib.error.HTTPError as e:
        fail("PUT_HTTP_ERROR", code=e.code, msg=str(e)[:120])
    except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError, json.JSONDecodeError) as e:
        fail("PUT_HTTP_ERROR", reason="socket_or_parse", err=str(e)[:120])

    if put_resp.get("error"):
        err = put_resp["error"]
        fail("PUT_ISERROR", reason="mcp_error", code=err.get("code"), msg=str(err.get("message"))[:120])

    put_result = put_resp.get("result", {})
    if put_result.get("isError"):
        # tools/call returned a domain-level error — extract the text content
        content = put_result.get("content", [])
        text = content[0].get("text", "") if content else ""
        fail("PUT_ISERROR", body=text[:200])

    # Confirm the response shape is what we expect — the tool result text
    # should be JSON with a status field. If the shape changed (gbrain
    # version upgrade), we want to know.
    put_content = put_result.get("content", [])
    put_text = put_content[0].get("text", "") if put_content else ""
    try:
        put_payload = json.loads(put_text)
    except (json.JSONDecodeError, TypeError):
        fail("PUT_UNEXPECTED", reason="non_json_content", body=put_text[:200])

    if put_payload.get("status") not in ("created_or_updated", "created", "updated"):
        fail("PUT_UNEXPECTED", reason="status_unexpected", status=put_payload.get("status"), body=put_text[:200])

    chunks = put_payload.get("chunks", 0)
    if not isinstance(chunks, int) or chunks < 1:
        fail("PUT_UNEXPECTED", reason="no_chunks", chunks=chunks)

    # ── Step 6: tools/call get_page — retrieve by slug, confirm marker present ──
    if retrieve_tool == "get_page":
        retrieve_args = {"slug": MARKER_SLUG}
    elif retrieve_tool == "search":
        # search needs a query — use the marker_ts itself
        retrieve_args = {"query": marker_ts}
    else:  # query
        retrieve_args = {"query": marker_ts}

    try:
        get_resp = post_mcp(token, {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": retrieve_tool, "arguments": retrieve_args},
        }, timeout=TIMEOUT_GET_PAGE)
    except urllib.error.HTTPError as e:
        fail("RETRIEVE_HTTP_ERROR", code=e.code, msg=str(e)[:120])
    except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError, json.JSONDecodeError) as e:
        fail("RETRIEVE_HTTP_ERROR", reason="socket_or_parse", err=str(e)[:120])

    if get_resp.get("error"):
        err = get_resp["error"]
        fail("RETRIEVE_ISERROR", reason="mcp_error", code=err.get("code"), msg=str(err.get("message"))[:120])

    get_result = get_resp.get("result", {})
    if get_result.get("isError"):
        content = get_result.get("content", [])
        text = content[0].get("text", "") if content else ""
        fail("RETRIEVE_ISERROR", reason="domain_error", body=text[:200])

    get_content = get_result.get("content", [])
    get_text = get_content[0].get("text", "") if get_content else ""

    # The marker_ts must appear in the retrieved content. For get_page this
    # is the page's compiled_truth field; for search/query this is the
    # match snippet. String search is sufficient — we wrote MARKER_TS into
    # the body in Step 5, so it should be retrievable verbatim.
    if marker_ts not in get_text:
        fail(
            "MARKER_NOT_FOUND",
            retrieve_tool=retrieve_tool,
            marker_ts=marker_ts,
            body=get_text[:200],
        )

    # ── Success ──
    ok(
        marker_ts=marker_ts,
        put_tool="put_page",
        retrieve_tool=retrieve_tool,
        tools_count=len(tool_names),
        server_version=server_mcp_version,
        sidecar_version=server_version,
        chunks=chunks,
    )


if __name__ == "__main__":
    main()
