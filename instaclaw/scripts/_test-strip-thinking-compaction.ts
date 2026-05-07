/**
 * Local correctness test for the new Layer 1+3+4 strip-thinking.py compaction.
 *
 * Renders STRIP_THINKING_SCRIPT to /tmp, runs syntax check, then constructs
 * synthetic jsonl test cases and exercises:
 *   1. compact_session_in_place_lines preserves first user message
 *   2. compact_session_in_place_lines keeps last 5 turn pairs minimum
 *   3. _find_safe_turn_starts never returns a boundary while a tool_use is
 *      unfulfilled (no orphan tool_use/tool_result after drop)
 *   4. _extract_large_tool_results_to_cache replaces >20KB inline content
 *      with a reference and writes the cache file
 *
 * Runs entirely on the local mac via python3 — no SSH, no fleet impact.
 */
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { STRIP_THINKING_SCRIPT } from "../lib/ssh";

const TMP_DIR = "/tmp/strip-thinking-test";
mkdirSync(TMP_DIR, { recursive: true });

// Step 1: render Python and syntax-check
const PY_PATH = `${TMP_DIR}/strip-thinking.py`;
writeFileSync(PY_PATH, STRIP_THINKING_SCRIPT, "utf-8");
console.log(`Rendered Python: ${PY_PATH} (${STRIP_THINKING_SCRIPT.length} bytes)`);

try {
  execSync(`python3 -m py_compile ${PY_PATH}`, { stdio: "pipe" });
  console.log("✓ Python syntax OK");
} catch (e: any) {
  console.error("✗ Python syntax error:");
  console.error(e.stderr?.toString() ?? e.message);
  process.exit(1);
}

// Step 2: construct synthetic jsonl + exercise the helpers via a test harness
// We import the strip-thinking module dynamically and call its functions.
const HARNESS = `
import sys, json, os, tempfile
sys.path.insert(0, "${TMP_DIR}")

# Load helpers without running the main loop body (which expects real session dirs)
# We monkey-patch sys.argv and skip the ${'='.repeat(8)} hot-loop section by
# reading just the helper definitions before the main loop.
import importlib.util
spec = importlib.util.spec_from_file_location("strip_thinking_helpers", "${PY_PATH}")
mod = importlib.util.module_from_spec(spec)

# Stub out the LOCK acquire that exits if can't lock
import fcntl as _fcntl
_orig_flock = _fcntl.flock
def _noop_flock(*a, **kw): return None
_fcntl.flock = _noop_flock

# Run the module — the main loop will hit the lock-acquire and exit(0)
# before touching real sessions. We catch SystemExit to recover.
try:
    spec.loader.exec_module(mod)
except SystemExit:
    pass

# Now verify helper functions exist
assert hasattr(mod, "_classify_jsonl_line"), "_classify_jsonl_line missing"
assert hasattr(mod, "_find_safe_turn_starts"), "_find_safe_turn_starts missing"
assert hasattr(mod, "_aggressive_truncate_old_tool_results"), "_aggressive_truncate_old_tool_results missing"
assert hasattr(mod, "_extract_large_tool_results_to_cache"), "_extract_large_tool_results_to_cache missing"
assert hasattr(mod, "compact_session_in_place_lines"), "compact_session_in_place_lines missing"
print("✓ All Layer 1+3 helpers loaded")

# ── Test 1: classify_jsonl_line ──
def make_user_text(text):
    return json.dumps({"type": "user_message", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})

def make_assistant_text(text):
    return json.dumps({"type": "assistant_message", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})

def make_assistant_tool_use(tu_id, name="test"):
    return json.dumps({"type": "assistant_message", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "calling tool"},
        {"type": "tool_use", "id": tu_id, "name": name, "input": {}}
    ]}})

def make_tool_result(tu_id, content="result"):
    return json.dumps({"type": "tool_result", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tu_id, "content": content}
    ]}})

def make_metadata(t):
    return json.dumps({"type": t})

c = mod._classify_jsonl_line(make_user_text("hi"))
assert c["ok"] and c["role"] == "user" and c["is_user_text_only"], f"user-text classify wrong: {c}"

c = mod._classify_jsonl_line(make_assistant_tool_use("tu_1"))
assert c["ok"] and c["role"] == "assistant" and c["tool_use_ids"] == ["tu_1"], f"asst tool_use classify wrong: {c}"

c = mod._classify_jsonl_line(make_tool_result("tu_1"))
assert c["ok"] and c["role"] == "user" and c["tool_result_ids"] == ["tu_1"] and not c["is_user_text_only"], f"tool_result classify wrong: {c}"

c = mod._classify_jsonl_line(make_metadata("model.completed"))
assert c["ok"] and c["is_metadata"], f"metadata classify wrong: {c}"

c = mod._classify_jsonl_line("not json")
assert not c["ok"] and c["is_metadata"], f"malformed classify wrong: {c}"

print("✓ Test 1: _classify_jsonl_line — 5/5 cases")

# ── Test 2: _find_safe_turn_starts honors tool_use pairing ──
# Sequence: user_text(0), asst_tool_use(1, tu_a), tool_result(2, tu_a), asst_text(3),
#           user_text(4), asst_text(5), user_text(6)
# Expected safe boundaries: indices 0, 4, 6 (NOT 2 — that's a tool_result, not pure text)
lines = [
    make_user_text("hello"),       # 0 — boundary
    make_assistant_tool_use("tu_a"),  # 1
    make_tool_result("tu_a"),      # 2 — NOT a boundary (tool_result)
    make_assistant_text("done"),   # 3
    make_user_text("question 2"),  # 4 — boundary (pending now empty)
    make_assistant_text("answer"), # 5
    make_user_text("question 3"),  # 6 — boundary
]
starts = mod._find_safe_turn_starts(lines)
assert starts == [0, 4, 6], f"safe boundaries wrong: {starts}"
print(f"✓ Test 2: safe turn starts = {starts}")

# ── Test 3: never returns boundary while tool_use unfulfilled ──
# Sequence: user_text(0), asst_tool_use(1, tu_x), user_text(2) without tool_result
# Expected: only 0 (because tu_x is unfulfilled at line 2 — would orphan)
lines = [
    make_user_text("start"),
    make_assistant_tool_use("tu_x"),
    make_user_text("interrupting before tool resolved"),  # would orphan tu_x
]
starts = mod._find_safe_turn_starts(lines)
assert starts == [0], f"unfulfilled tool_use boundary wrong: {starts}"
print(f"✓ Test 3: unfulfilled tool_use blocks boundary; starts = {starts}")

# ── Test 4: compact preserves first user message + last 5 turn pairs ──
# Build 10 turn pairs of small messages, hit max_bytes well under total
lines = []
for i in range(10):
    lines.append(make_user_text(f"user msg {i} " + ("padding " * 200)))
    lines.append(make_assistant_text(f"asst msg {i} " + ("padding " * 200)))
total_bytes = sum(len(l) for l in lines)
print(f"  test session: {len(lines)} lines, {total_bytes} bytes, {total_bytes // 10} bytes/turn")
result = mod.compact_session_in_place_lines(lines, max_bytes=total_bytes // 2, min_turn_pairs=5)

# After compaction: first user msg present, last 5 turn pairs present
new_lines = result["lines"]
assert make_user_text(f"user msg 0 " + ("padding " * 200)) == new_lines[0], "first user msg dropped"
print(f"  ✓ first user message preserved (line 0)")

# Find user_text turn starts in result
new_starts = mod._find_safe_turn_starts(new_lines)
assert len(new_starts) >= 1 + 5, f"min_turn_pairs not honored: {len(new_starts)} starts"
# Last 5 should be turns 5,6,7,8,9 (since we drop from index 1 onward)
last_5_user_msgs = [json.loads(new_lines[idx])["message"]["content"][0]["text"] for idx in new_starts[-5:]]
print(f"  last 5 user msgs after compact: {[m[:20] for m in last_5_user_msgs]}")
assert "user msg 9" in last_5_user_msgs[-1], f"most recent user msg not preserved: {last_5_user_msgs[-1][:20]}"
assert "user msg 5" in last_5_user_msgs[0] or "user msg 4" in last_5_user_msgs[0], f"unexpected oldest of last-5: {last_5_user_msgs[0][:20]}"
print(f"  ✓ last 5 turn pairs preserved")

print(f"  ✓ dropped_turns={result['dropped_turns']}, final={result['final_bytes']} bytes")
print("✓ Test 4: compact_session_in_place_lines preserves first + last-5")

# ── Test 5: large tool_result extraction to cache ──
LARGE_TR = "X" * 25000  # 25KB > LARGE_TOOL_RESULT_BYTES (20KB)
SMALL_TR = "Y" * 5000   # 5KB < threshold
lines = [
    make_user_text("hi"),
    make_assistant_tool_use("tu_big"),
    make_tool_result("tu_big", LARGE_TR),
    make_assistant_tool_use("tu_small"),
    make_tool_result("tu_small", SMALL_TR),
]
new_lines, ext_count, bytes_saved = mod._extract_large_tool_results_to_cache(lines)
assert ext_count == 1, f"expected 1 extract, got {ext_count}"
print(f"  ✓ Layer 3 extracted {ext_count} large tool_result, saved {bytes_saved} bytes")
# Verify the extracted line now contains a reference (not the full content)
big_line_parsed = json.loads(new_lines[2])
big_content = big_line_parsed["message"]["content"][0]["content"]
assert "Tool output cached" in big_content, f"reference not present: {big_content[:80]}"
assert "X" * 1000 not in big_content, "large content still inline"
print(f"  ✓ tool_result replaced with reference: {big_content[:90]}...")
# Verify cache file exists
import glob
cache_files = glob.glob(os.path.expanduser("~/.openclaw/workspace/tool-cache/*.txt"))
assert any(os.path.getsize(f) == len(LARGE_TR) for f in cache_files), f"cache file with right size not found among {cache_files}"
print("  ✓ cache file written with correct size")
print("✓ Test 5: Layer 3 memory-pointer extraction")

# ── Test 6: aggressive truncation of older tool_results ──
SMALL_VALID_TR = "Z" * 800  # > 500 chars
lines = []
for i in range(15):  # 15 tool_results — older 5 should be aggressively truncated
    lines.append(make_assistant_tool_use(f"tu_{i}"))
    lines.append(make_tool_result(f"tu_{i}", SMALL_VALID_TR))
new_lines, count, bytes_saved = mod._aggressive_truncate_old_tool_results(lines, keep_recent_n=10, max_chars_old=500)
assert count == 5, f"expected 5 aggressive truncations, got {count}"
print(f"✓ Test 6: aggressive truncation — {count} truncations, {bytes_saved} bytes saved")

print("\\n✓✓✓ ALL TESTS PASSED ✓✓✓")
`;

const HARNESS_PATH = `${TMP_DIR}/harness.py`;
writeFileSync(HARNESS_PATH, HARNESS, "utf-8");

// Pre-clean any prior test cache to avoid test contamination
const TEST_CACHE = `${process.env.HOME}/.openclaw/workspace/tool-cache`;
if (existsSync(TEST_CACHE)) {
  // Don't nuke real cache files; just verify dir exists. Tests will dedupe by sha.
}

console.log("Running test harness...\n");
try {
  const out = execSync(`python3 ${HARNESS_PATH}`, { encoding: "utf-8", stdio: "pipe" });
  console.log(out);
  console.log("✓ ALL TESTS PASSED");
} catch (e: any) {
  console.error("✗ Test harness failed:");
  console.error("STDOUT:", e.stdout?.toString());
  console.error("STDERR:", e.stderr?.toString());
  process.exit(1);
}
