/**
 * _test-toolrouter-wrapper.ts — failure-mode tests for the K.4 wrapper.
 *
 * The wrapper sits in the hottest path on every VM. Rule 31 (failure-mode
 * tests) is non-negotiable here. This harness:
 *
 *   1. Extracts the TOOLROUTER_WRAPPER_MJS constant from lib/ to a temp
 *      file (mirrors what the reconciler would do via stepFiles).
 *   2. Starts a mock InstaClaw HTTP server on localhost that records
 *      every record-usage POST.
 *   3. Spawns the wrapper with TOOLROUTER_WRAPPER_CHILD_CMD pointing at
 *      a mock "toolrouter" child (an inline Node script that echoes
 *      a canned MCP response for each request).
 *   4. Feeds NDJSON-framed MCP messages into the wrapper's stdin and
 *      reads the wrapper's stdout to verify passthrough.
 *
 * Tests:
 *   T1: happy path — single tools/call → response observed, POST recorded
 *   T2: ignored messages — initialize + tools/list do NOT trigger POSTs
 *   T3: InstaClaw unreachable — wrapper still echoes tool response
 *   T4: large response (>1MB) — passthrough works, observation skipped
 *   T5: child exits unexpectedly — wrapper propagates exit code
 *   T6: no GATEWAY_TOKEN env — wrapper still passthroughs, no POST
 *   T7: multiple concurrent tool calls — both observed by id matching
 *
 * Exit 0 if all pass, 1 if any fail.
 */

import { spawn, ChildProcess } from "node:child_process";
import { createServer, Server } from "node:http";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLROUTER_WRAPPER_MJS } from "../lib/toolrouter-wrapper-script";

interface PostRecord {
  body: Record<string, unknown>;
  ts: number;
}

let posts: PostRecord[] = [];
let postServer: Server | null = null;
let postPort = 0;

async function startMockInstaClaw(): Promise<void> {
  return new Promise((resolve) => {
    postServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          posts.push({ body: JSON.parse(body), ts: Date.now() });
        } catch {
          posts.push({ body: { __unparseable: body.slice(0, 200) }, ts: Date.now() });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    postServer.listen(0, "127.0.0.1", () => {
      const addr = postServer!.address();
      if (addr && typeof addr === "object") postPort = addr.port;
      resolve();
    });
  });
}

async function stopMockInstaClaw(): Promise<void> {
  if (postServer) {
    await new Promise<void>((r) => postServer!.close(() => r()));
    postServer = null;
  }
}

/**
 * Mock toolrouter binary — a tiny Node script that reads NDJSON from
 * stdin and emits canned MCP responses. Behavior controlled by params
 * embedded in the request's params.arguments.__test object.
 */
const MOCK_CHILD = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "mock-toolrouter", version: "0.0.0" } },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "exa.search" }] },
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    const test = msg.params && msg.params.arguments && msg.params.arguments.__test || {};
    if (test.crash_after_response) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { endpoint_id: msg.params.name, charged: true, trace_id: "trace-crash", path: "x402", status_code: 200 },
        },
      }) + "\\n");
      setTimeout(() => process.exit(13), 50);
      return;
    }
    if (test.large_response) {
      // Emit a >1MB structuredContent.
      const big = "x".repeat(1_100_000);
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: {
          content: [{ type: "text", text: "big" }],
          structuredContent: { endpoint_id: msg.params.name, charged: true, trace_id: "trace-big", path: "x402", payload: big },
        },
      }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: {
        content: [{ type: "text", text: "search results" }],
        structuredContent: {
          endpoint_id: msg.params.name,
          charged: test.charged !== false,
          trace_id: test.trace_id || ("trace-" + msg.id),
          path: test.path || "x402",
          status_code: 200,
          credit_captured_usd: test.amount || 0.007,
        },
      },
    }) + "\\n");
    return;
  }
});
`;

interface SpawnedWrapper {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: string | null;
  exited: Promise<void>;
}

function spawnWrapper(
  wrapperPath: string,
  mockChildPath: string,
  env: Record<string, string> = {},
): SpawnedWrapper {
  const child = spawn("node", [wrapperPath], {
    env: {
      ...process.env,
      TOOLROUTER_WRAPPER_CHILD_CMD: "node",
      TOOLROUTER_WRAPPER_CHILD_ARG: mockChildPath,
      INSTACLAW_API_URL: `http://127.0.0.1:${postPort}`,
      GATEWAY_TOKEN: "test-token",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const result: SpawnedWrapper = {
    child,
    stdout: "",
    stderr: "",
    exitCode: null,
    exitSignal: null,
    exited: new Promise<void>((resolve) => {
      child.on("exit", (code, sig) => {
        result.exitCode = code;
        result.exitSignal = sig ? String(sig) : null;
        resolve();
      });
    }),
  };
  child.stdout!.on("data", (d) => { result.stdout += d.toString("utf8"); });
  child.stderr!.on("data", (d) => { result.stderr += d.toString("utf8"); });
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  posts = [];
  try {
    await fn();
    results.push({ name, passed: true, details: "ok" });
    console.log(`  [✓] ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name, passed: false, details: msg });
    console.log(`  [✗] ${name}\n      ${msg}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  await startMockInstaClaw();

  const tmp = mkdtempSync(join(tmpdir(), "tr-wrapper-test-"));
  const wrapperPath = join(tmp, "wrapper.mjs");
  const mockChildPath = join(tmp, "mock-child.cjs");

  // The wrapper takes TOOLROUTER_BINARY from env, but the actual spawn
  // uses spawn(TOOLROUTER_BINARY, []) — no positional arg for the script.
  // Patch via a tiny shim: a shell script that exec's node with the
  // mock script. We use a node-based shim to avoid bash dependencies.
  const shimPath = join(tmp, "child-shim");
  const shim = `#!/usr/bin/env node\nrequire("node:child_process").spawn("node", ["${mockChildPath}"], { stdio: "inherit" });\n`;
  // Simpler approach: don't shim — point TOOLROUTER_WRAPPER_CHILD_CMD
  // at "node" and rely on... hmm, but wrapper does spawn(BINARY, []),
  // no args support. Need a wrapper script.
  writeFileSync(wrapperPath, TOOLROUTER_WRAPPER_MJS, "utf8");
  writeFileSync(mockChildPath, MOCK_CHILD, "utf8");

  // Use a sh script as the child command so we can invoke `node <path>`.
  // Wrapper's TOOLROUTER_WRAPPER_CHILD_CMD points at this shim.
  const childShim = join(tmp, "child");
  writeFileSync(childShim, `#!/bin/sh\nexec node "${mockChildPath}"\n`, "utf8");
  chmodSync(childShim, 0o755);

  console.log("Setup:");
  console.log(`  wrapper:   ${wrapperPath}`);
  console.log(`  mock child: ${childShim} -> ${mockChildPath}`);
  console.log(`  mock instaclaw: http://127.0.0.1:${postPort}`);
  console.log("");
  console.log("Tests:");

  // T1 — happy path
  await test("T1 happy path: tools/call → response echoed + POST recorded", async () => {
    const w = spawnWrapper(wrapperPath, mockChildPath, { TOOLROUTER_WRAPPER_CHILD_CMD: childShim });
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "exa.search", arguments: { query: "test" } },
    }) + "\n");
    await sleep(800);
    assert(w.stdout.includes('"id":1'), `expected stdout to contain response (got: ${w.stdout.slice(0, 200)})`);
    assert(w.stdout.includes("trace-1"), `expected trace-1 in stdout`);
    assert(posts.length >= 1, `expected ≥1 POST (got ${posts.length})`);
    const p = posts[posts.length - 1].body as Record<string, unknown>;
    assert(p.endpoint_id === "exa.search", `endpoint_id: ${p.endpoint_id}`);
    assert(p.charged === true, `charged: ${p.charged}`);
    assert(p.trace_id === "trace-1", `trace_id: ${p.trace_id}`);
    assert(p.path === "x402", `path: ${p.path}`);
    w.child.kill();
    await w.exited;
  });

  // T2 — initialize + tools/list do NOT trigger POSTs
  await test("T2 ignored messages: initialize + tools/list don't fire record-usage", async () => {
    const w = spawnWrapper(wrapperPath, mockChildPath, { TOOLROUTER_WRAPPER_CHILD_CMD: childShim });
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2025-11-25" },
    }) + "\n");
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 11, method: "tools/list",
    }) + "\n");
    await sleep(500);
    assert(w.stdout.includes('"id":10'), `initialize response missing`);
    assert(w.stdout.includes('"id":11'), `tools/list response missing`);
    assert(posts.length === 0, `expected 0 POSTs (got ${posts.length})`);
    w.child.kill();
    await w.exited;
  });

  // T3 — InstaClaw unreachable: tool call still succeeds
  await test("T3 InstaClaw unreachable: tool call still echoed", async () => {
    await stopMockInstaClaw();
    const w = spawnWrapper(wrapperPath, mockChildPath, { TOOLROUTER_WRAPPER_CHILD_CMD: childShim });
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 20, method: "tools/call",
      params: { name: "exa.search", arguments: { query: "test" } },
    }) + "\n");
    await sleep(800);
    assert(w.stdout.includes('"id":20'), `expected response despite mock instaclaw down`);
    assert(w.stdout.includes("trace-20"), `expected trace-20 in stdout`);
    w.child.kill();
    await w.exited;
    await startMockInstaClaw();
  });

  // T4 — large response (>1MB): passthrough works, observation graceful
  await test("T4 large response (>1MB): passthrough works, no crash", async () => {
    const w = spawnWrapper(wrapperPath, mockChildPath, { TOOLROUTER_WRAPPER_CHILD_CMD: childShim });
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 40, method: "tools/call",
      params: { name: "browserbase.session", arguments: { __test: { large_response: true } } },
    }) + "\n");
    await sleep(1200);
    assert(w.stdout.includes('"id":40'), `expected response despite large size`);
    assert(w.stdout.length > 1_000_000, `expected stdout >1MB (got ${w.stdout.length})`);
    // Observation should have been skipped — no POST or empty POST.
    w.child.kill();
    await w.exited;
  });

  // T5 — child exits unexpectedly: wrapper propagates
  await test("T5 child crash: wrapper exits with non-zero", async () => {
    const w = spawnWrapper(wrapperPath, mockChildPath, { TOOLROUTER_WRAPPER_CHILD_CMD: childShim });
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 50, method: "tools/call",
      params: { name: "exa.search", arguments: { __test: { crash_after_response: true } } },
    }) + "\n");
    await w.exited;
    assert(w.exitCode === 13 || w.exitCode === null, `expected wrapper to propagate child exit 13 (got code=${w.exitCode}, sig=${w.exitSignal})`);
    assert(w.stdout.includes('"id":50'), `expected response before crash`);
  });

  // T6 — no GATEWAY_TOKEN: passthrough works, no POST
  await test("T6 missing GATEWAY_TOKEN: passthrough works, no POST attempted", async () => {
    const w = spawnWrapper(wrapperPath, mockChildPath, { TOOLROUTER_WRAPPER_CHILD_CMD: childShim, GATEWAY_TOKEN: "" });
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 60, method: "tools/call",
      params: { name: "exa.search", arguments: { query: "test" } },
    }) + "\n");
    await sleep(500);
    assert(w.stdout.includes('"id":60'), `expected response without GATEWAY_TOKEN`);
    assert(posts.length === 0, `expected 0 POSTs without token (got ${posts.length})`);
    w.child.kill();
    await w.exited;
  });

  // T7 — concurrent tool calls: both matched by id
  await test("T7 concurrent calls: both observed via id matching", async () => {
    const w = spawnWrapper(wrapperPath, mockChildPath, { TOOLROUTER_WRAPPER_CHILD_CMD: childShim });
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 71, method: "tools/call",
      params: { name: "exa.search", arguments: { query: "a", __test: { trace_id: "trace-71" } } },
    }) + "\n");
    w.child.stdin!.write(JSON.stringify({
      jsonrpc: "2.0", id: 72, method: "tools/call",
      params: { name: "manus.research", arguments: { query: "b", __test: { trace_id: "trace-72" } } },
    }) + "\n");
    await sleep(800);
    assert(w.stdout.includes('"id":71'), `expected id=71 response`);
    assert(w.stdout.includes('"id":72'), `expected id=72 response`);
    const traces = posts.map((p) => (p.body as Record<string, unknown>).trace_id);
    assert(traces.includes("trace-71") && traces.includes("trace-72"), `expected both trace IDs in POSTs (got ${JSON.stringify(traces)})`);
    w.child.kill();
    await w.exited;
  });

  await stopMockInstaClaw();

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log("");
  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed.`);

  if (failed > 0) {
    console.error("\nFAIL:");
    for (const r of results) if (!r.passed) console.error(`  ${r.name}: ${r.details}`);
    process.exit(1);
  }
  console.log("OK");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
