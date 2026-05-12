#!/usr/bin/env python3
"""Unit tests for ack-watchdog's is_turn_stalled() parser.

Tests it against synthetic trajectory fixtures covering every edge case
documented in the PRD §6.2 and §7.3. Pure local — no network, no VM.

Run: python3 scripts/_test-ack-watchdog-parser.py
"""
import json
import os
import sys
import tempfile
import importlib.util

# Import ack-watchdog.py module (it has a hyphen so importlib gymnastics)
HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("ack_watchdog", os.path.join(HERE, "ack-watchdog.py"))
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
is_turn_stalled = mod.is_turn_stalled
has_visible_text = mod.has_visible_text
parse_chat_id = mod.parse_chat_id


def write_jsonl(path, lines):
    """Write a list of JSON-serializable objects as JSONL."""
    with open(path, "w") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


def make_msg(role, content, ts=0):
    """Build a {type:"message"} entry matching OpenClaw 2026.4.26 format."""
    return {
        "type": "message",
        "id": "test",
        "parentId": None,
        "timestamp": "2026-05-12T00:00:00.000Z",
        "message": {"role": role, "content": content, "timestamp": ts},
    }


def make_session_init():
    return {"type": "session", "version": 3, "id": "test", "timestamp": "2026-05-12T00:00:00.000Z"}


def assert_eq(actual, expected, name):
    if actual != expected:
        print(f"✗ {name}: expected {expected!r}, got {actual!r}")
        return False
    print(f"✓ {name}")
    return True


def run_tests():
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:

        # Test 1: served — user → assistant text
        p1 = os.path.join(tmp, "t1.jsonl")
        write_jsonl(p1, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "hello"}], 1000),
            make_msg("assistant", [{"type": "text", "text": "hi there"}], 1500),
        ])
        failures += not assert_eq(is_turn_stalled(p1), "served", "served: user→assistant text")

        # Test 2: stalled — user with no response
        p2 = os.path.join(tmp, "t2.jsonl")
        write_jsonl(p2, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "hello"}], 1000),
        ])
        failures += not assert_eq(is_turn_stalled(p2), "stalled", "stalled: user with no assistant response")

        # Test 3: stalled — user → assistant only tool_use (no text)
        p3 = os.path.join(tmp, "t3.jsonl")
        write_jsonl(p3, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "search for x"}], 1000),
            make_msg("assistant", [{"type": "toolCall", "name": "web_search", "arguments": {}}], 1500),
            make_msg("toolResult", [{"type": "text", "text": "results"}], 2000),
        ])
        failures += not assert_eq(is_turn_stalled(p3), "stalled", "stalled: assistant only tool_use, no text")

        # Test 4: served — user → assistant text+tool_use → toolResult
        # Even though there's a tool_use after the text, the user has SEEN text so not stalled.
        p4 = os.path.join(tmp, "t4.jsonl")
        write_jsonl(p4, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "search for x"}], 1000),
            make_msg("assistant", [
                {"type": "text", "text": "I'll search the web..."},
                {"type": "toolCall", "name": "web_search", "arguments": {}},
            ], 1500),
            make_msg("toolResult", [{"type": "text", "text": "results"}], 2000),
        ])
        failures += not assert_eq(is_turn_stalled(p4), "served", "served: assistant text+tool_use")

        # Test 5: served — multi-turn, only most-recent user → assistant matters
        p5 = os.path.join(tmp, "t5.jsonl")
        write_jsonl(p5, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "first"}], 1000),
            make_msg("assistant", [{"type": "text", "text": "first reply"}], 1500),
            make_msg("user", [{"type": "text", "text": "second"}], 2000),
            make_msg("assistant", [{"type": "text", "text": "second reply"}], 2500),
        ])
        failures += not assert_eq(is_turn_stalled(p5), "served", "served: multi-turn all served")

        # Test 6: stalled — multi-turn, second user has no reply yet
        p6 = os.path.join(tmp, "t6.jsonl")
        write_jsonl(p6, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "first"}], 1000),
            make_msg("assistant", [{"type": "text", "text": "first reply"}], 1500),
            make_msg("user", [{"type": "text", "text": "second"}], 2000),
        ])
        failures += not assert_eq(is_turn_stalled(p6), "stalled", "stalled: multi-turn, second user unanswered")

        # Test 7: stalled — assistant text is empty string
        p7 = os.path.join(tmp, "t7.jsonl")
        write_jsonl(p7, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "hello"}], 1000),
            make_msg("assistant", [{"type": "text", "text": ""}], 1500),
        ])
        failures += not assert_eq(is_turn_stalled(p7), "stalled", "stalled: assistant text is empty")

        # Test 8: stalled — assistant text is whitespace only
        p8 = os.path.join(tmp, "t8.jsonl")
        write_jsonl(p8, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "hello"}], 1000),
            make_msg("assistant", [{"type": "text", "text": "   \n  "}], 1500),
        ])
        failures += not assert_eq(is_turn_stalled(p8), "stalled", "stalled: assistant text whitespace only")

        # Test 9: served — assistant has thinking block but no text
        # Per OpenClaw 2026.4.26, "thinking" blocks aren't "text" blocks.
        # Without a text block, this is a stalled turn from user's POV.
        p9 = os.path.join(tmp, "t9.jsonl")
        write_jsonl(p9, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "hello"}], 1000),
            make_msg("assistant", [{"type": "thinking", "thinking": "let me think..."}], 1500),
        ])
        failures += not assert_eq(is_turn_stalled(p9), "stalled", "stalled: assistant only thinking block")

        # Test 10: unknown — missing file
        p10 = os.path.join(tmp, "nonexistent.jsonl")
        failures += not assert_eq(is_turn_stalled(p10), "unknown", "unknown: missing file")

        # Test 11: unknown — empty file
        p11 = os.path.join(tmp, "t11.jsonl")
        write_jsonl(p11, [])
        failures += not assert_eq(is_turn_stalled(p11), "unknown", "unknown: empty file")

        # Test 12: unknown — file with no message-type entries
        p12 = os.path.join(tmp, "t12.jsonl")
        write_jsonl(p12, [
            make_session_init(),
            {"type": "model_change", "modelId": "claude-sonnet-4-6"},
        ])
        failures += not assert_eq(is_turn_stalled(p12), "unknown", "unknown: no message entries")

        # Test 13: served — custom_message entries between user & assistant
        # (verifying we ignore the runtime-context noise lines)
        p13 = os.path.join(tmp, "t13.jsonl")
        write_jsonl(p13, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "hello"}], 1000),
            {"type": "custom_message", "customType": "openclaw.runtime-context", "display": False, "timestamp": "2026-05-12T00:00:00.000Z"},
            make_msg("assistant", [{"type": "text", "text": "hi"}], 1500),
        ])
        failures += not assert_eq(is_turn_stalled(p13), "served", "served: custom_message between user+assistant")

        # Test 14: stalled — handles malformed lines (truncated JSON at start of tail)
        # When we read from byte offset, the first line may be partial JSON.
        # The parser should skip it.
        p14 = os.path.join(tmp, "t14.jsonl")
        with open(p14, "w") as f:
            f.write('id":"partial-truncated-line"}\n')  # Bad first line (no opening brace)
            f.write(json.dumps(make_msg("user", [{"type": "text", "text": "hello"}], 1000)) + "\n")
        failures += not assert_eq(is_turn_stalled(p14), "stalled", "stalled: malformed first line skipped")

        # Test 15: served — long content with text after tool calls
        # Mimics a real turn: text → toolCall → toolResult → text → toolCall → toolResult → final text
        p15 = os.path.join(tmp, "t15.jsonl")
        write_jsonl(p15, [
            make_session_init(),
            make_msg("user", [{"type": "text", "text": "complex task"}], 1000),
            make_msg("assistant", [
                {"type": "text", "text": "I'll search..."},
                {"type": "toolCall", "name": "web_search", "arguments": {}},
            ], 1500),
            make_msg("toolResult", [{"type": "text", "text": "results"}], 2000),
            make_msg("assistant", [
                {"type": "text", "text": "Now let me analyze..."},
                {"type": "toolCall", "name": "exec", "arguments": {}},
            ], 2500),
            make_msg("toolResult", [{"type": "text", "text": "output"}], 3000),
            make_msg("assistant", [{"type": "text", "text": "Final answer: ..."}], 3500),
        ])
        failures += not assert_eq(is_turn_stalled(p15), "served", "served: complex multi-tool with final text")

    # Tests for has_visible_text helper
    print()
    failures += not assert_eq(has_visible_text("hi"), True, "has_visible_text: non-empty string")
    failures += not assert_eq(has_visible_text(""), False, "has_visible_text: empty string")
    failures += not assert_eq(has_visible_text("  "), False, "has_visible_text: whitespace string")
    failures += not assert_eq(has_visible_text(None), False, "has_visible_text: None")
    failures += not assert_eq(has_visible_text([{"type": "text", "text": "hi"}]), True, "has_visible_text: list with text")
    failures += not assert_eq(has_visible_text([{"type": "text", "text": ""}]), False, "has_visible_text: list with empty text")
    failures += not assert_eq(has_visible_text([{"type": "toolCall"}]), False, "has_visible_text: list with only toolCall")
    failures += not assert_eq(has_visible_text([{"type": "text", "text": "  "}]), False, "has_visible_text: list with whitespace text")

    # Tests for parse_chat_id helper
    print()
    failures += not assert_eq(parse_chat_id("telegram:5918081163"), 5918081163, "parse_chat_id: positive id")
    failures += not assert_eq(parse_chat_id("telegram:-1001234567"), -1001234567, "parse_chat_id: negative supergroup id")
    failures += not assert_eq(parse_chat_id("whatsapp:abc"), None, "parse_chat_id: wrong prefix")
    failures += not assert_eq(parse_chat_id(""), None, "parse_chat_id: empty string")
    failures += not assert_eq(parse_chat_id(None), None, "parse_chat_id: None")
    failures += not assert_eq(parse_chat_id("telegram:abc"), None, "parse_chat_id: non-numeric")
    failures += not assert_eq(parse_chat_id("telegram:"), None, "parse_chat_id: empty after colon")

    print()
    if failures == 0:
        print(f"✓ All tests passed.")
        sys.exit(0)
    else:
        print(f"✗ {failures} failure(s).")
        sys.exit(1)


if __name__ == "__main__":
    run_tests()
