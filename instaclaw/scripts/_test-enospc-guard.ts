/**
 * Synthetic tests for lib/enospc-guard.ts — Rule 37.
 *
 * Run: npx tsx scripts/_test-enospc-guard.ts
 *
 * No live VM is harmed. We stub `ssh.execCommand` / `ssh.putFile` with
 * canned outputs that mimic real ENOSPC scenarios:
 *
 *   1. openclaw config set returning the canonical Node fs error.
 *   2. bash echo > path with the "No space left" stderr.
 *   3. npm install with ENOSPC in the npm output.
 *   4. putFile rejecting with an ENOSPC-bearing error message.
 *   5. Healthy command (no ENOSPC) — verify the wrapper passes through.
 *   6. Two consecutive ENOSPC commands in one reconcile — verify the
 *      fire-once invariant (only one error pushed, only one alert).
 *
 * For each scenario we check:
 *   - result.errors got exactly one [ENOSPC] entry on first detection
 *   - the wrapper threw EnospcDetectedError to short-circuit
 *   - path extraction matches the input (when extractable)
 *   - subsequent calls after detection don't double-fire
 *
 * The admin alert is NOT actually sent — `sendAdminAlertEmail` reads
 * ADMIN_ALERT_EMAIL from env and returns early if unset. We just need the
 * dedup-table insert to not crash; this test runs without a Supabase
 * connection, so any failure to insert is swallowed by the helper's
 * try/catch (matches sendVMReadyEmail pattern).
 *
 * This isolates the WRAPPER logic. Live-VM verification of the alert
 * delivery + dedup is documented in the PRD as Tier 3 manual procedure.
 */

import {
  wrapSSHForEnospcDetection,
  scanForEnospc,
  isEnospcDetectedError,
  EnospcDetectedError,
} from "../lib/enospc-guard";
import type { VMRecord } from "../lib/ssh";
import type { ReconcileResult } from "../lib/vm-reconcile";

// ── Test harness ─────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function freshResult(): ReconcileResult {
  return {
    fixed: [],
    alreadyCorrect: [],
    errors: [],
    warnings: [],
    gatewayRestartNeeded: false,
    gatewayRestarted: false,
    gatewayHealthy: true,
    strictErrors: [],
    canaryHealthy: null,
    canarySkippedBudget: false,
    envPushSucceeded: true,
  };
}

const MOCK_VM: VMRecord & { name: string } = {
  id: "test-vm-id",
  name: "instaclaw-vm-test",
  ip_address: "127.0.0.1",
  ssh_port: 22,
  ssh_user: "openclaw",
};

// Build a stub ssh object whose `execCommand` returns a scripted sequence
// of canned responses (one per call). `putFile` is similarly scripted.
type ExecRes = { stdout: string; stderr: string; code: number | null };
function makeStubSSH(execScript: Array<ExecRes | Error>, putScript: Array<void | Error> = []) {
  let execIdx = 0;
  let putIdx = 0;
  return {
    execCommand: async (_cmd: string): Promise<ExecRes> => {
      const next = execScript[execIdx++];
      if (next instanceof Error) throw next;
      return next ?? { stdout: "", stderr: "", code: 0 };
    },
    putFile: async (_local: string, _remote: string): Promise<void> => {
      const next = putScript[putIdx++];
      if (next instanceof Error) throw next;
    },
    dispose: () => undefined,
    getExecCalls: () => execIdx,
    getPutCalls: () => putIdx,
  };
}

// ── scanForEnospc unit tests ─────────────────────────────────────────

console.log("Section 1: scanForEnospc — pattern matching\n");

(() => {
  // Node fs error format
  const nodeErr =
    `Error: ENOSPC: no space left on device, open '/home/openclaw/.openclaw/openclaw.json.1234.tmp'`;
  const r = scanForEnospc("", nodeErr);
  assert(r !== null, "scan-node-fs: ENOSPC pattern matched");
  assert(
    r?.path === "/home/openclaw/.openclaw/openclaw.json.1234.tmp",
    `scan-node-fs: path extracted (got: ${r?.path})`,
  );
})();

(() => {
  // bash redirect format
  const bashErr =
    `bash: line 1: /home/openclaw/.openclaw/.env: No space left on device`;
  const r = scanForEnospc("", bashErr);
  assert(r !== null, "scan-bash-redirect: pattern matched");
  assert(
    r?.path === "/home/openclaw/.openclaw/.env",
    `scan-bash-redirect: path extracted (got: ${r?.path})`,
  );
})();

(() => {
  // npm/general "No space left on device"
  const npmErr = `npm ERR! code ENOSPC\nnpm ERR! syscall write\nnpm ERR! errno -28\nnpm ERR! nospc ENOSPC: no space left on device, write`;
  const r = scanForEnospc(npmErr, "");
  assert(r !== null, "scan-npm-stdout: ENOSPC in stdout matched");
})();

(() => {
  // No match — healthy command
  const stdout = "configuration updated successfully";
  const stderr = "";
  const r = scanForEnospc(stdout, stderr);
  assert(r === null, "scan-healthy: returns null for non-ENOSPC output");
})();

(() => {
  // Match in stdout (some commands write errors there)
  const stdout = "Working...\nFatal: ENOSPC: no space left on device\nAborting.";
  const r = scanForEnospc(stdout, "");
  assert(r !== null, "scan-stdout-match: ENOSPC detected in stdout");
})();

(() => {
  // Path-extraction fallback — no extractable path
  const r = scanForEnospc("", "Some weird format: No space left on device");
  assert(r !== null, "scan-no-path: still matches even without path");
  assert(r?.path === null, "scan-no-path: path is null when no extractable format");
})();

(() => {
  // Case sensitivity — both upper and lowercase should match
  const r1 = scanForEnospc("", "No space left on device");
  const r2 = scanForEnospc("", "no space left on device");
  assert(r1 !== null, "scan-case-1: 'No space left on device' matched");
  assert(r2 !== null, "scan-case-2: 'no space left on device' matched");
})();

// ── wrapSSHForEnospcDetection — integration scenarios ───────────────

console.log("\nSection 2: wrapSSHForEnospcDetection — execCommand interception\n");

(async () => {
  // Scenario 1: openclaw config set returning Node fs error.
  const stub = makeStubSSH([
    {
      stdout: "",
      stderr:
        "Error: ENOSPC: no space left on device, open '/home/openclaw/.openclaw/openclaw.json.abc123.tmp'\n    at writeSync (fs.js:594:3)",
      code: 1,
    },
  ]);
  const result = freshResult();
  const wrapped = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  let caught: unknown = null;
  try {
    await wrapped.execCommand("openclaw config set foo bar");
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, "exec-scenario-1: wrapper threw on ENOSPC");
  assert(isEnospcDetectedError(caught), "exec-scenario-1: thrown error is EnospcDetectedError");
  assert(result.errors.length === 1, `exec-scenario-1: exactly 1 error pushed (got ${result.errors.length})`);
  assert(
    result.errors[0].includes("[ENOSPC]"),
    `exec-scenario-1: error starts with [ENOSPC] (got: ${result.errors[0].slice(0, 60)})`,
  );
  assert(
    result.errors[0].includes("openclaw.json.abc123.tmp"),
    "exec-scenario-1: error includes the failed path",
  );
})();

(async () => {
  // Scenario 2: bash echo > with No space left
  const stub = makeStubSSH([
    {
      stdout: "",
      stderr: "bash: line 1: /home/openclaw/.openclaw/.env: No space left on device",
      code: 1,
    },
  ]);
  const result = freshResult();
  const wrapped = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  let caught: unknown = null;
  try {
    await wrapped.execCommand("echo 'GATEWAY_TOKEN=foo' >> ~/.openclaw/.env");
  } catch (err) {
    caught = err;
  }
  assert(isEnospcDetectedError(caught), "exec-scenario-2: thrown EnospcDetectedError");
  assert(
    result.errors[0].includes("/home/openclaw/.openclaw/.env"),
    "exec-scenario-2: error includes the .env path",
  );
})();

(async () => {
  // Scenario 3: npm install with ENOSPC in tail
  const stub = makeStubSSH([
    {
      stdout:
        "npm ERR! code ENOSPC\nnpm ERR! errno -28\nnpm ERR! ENOSPC: no space left on device, write",
      stderr: "",
      code: 1,
    },
  ]);
  const result = freshResult();
  const wrapped = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  let caught: unknown = null;
  try {
    await wrapped.execCommand("npm install -g openclaw@2026.4.26");
  } catch (err) {
    caught = err;
  }
  assert(isEnospcDetectedError(caught), "exec-scenario-3: npm ENOSPC caught from stdout");
})();

(async () => {
  // Scenario 4: putFile rejecting with ENOSPC error
  const stub = makeStubSSH(
    [],
    [new Error("SFTP write failed: ENOSPC: no space left on device, write '/tmp/ic-manifest-foo'")],
  );
  const result = freshResult();
  const wrapped = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  let caught: unknown = null;
  try {
    await wrapped.putFile("/tmp/local-foo", "/tmp/ic-manifest-foo");
  } catch (err) {
    caught = err;
  }
  assert(isEnospcDetectedError(caught), "exec-scenario-4: putFile ENOSPC caught from thrown error");
  assert(result.errors.length === 1, "exec-scenario-4: error pushed");
})();

(async () => {
  // Scenario 5: healthy command passes through cleanly
  const stub = makeStubSSH([
    { stdout: "Settings: foo=bar", stderr: "", code: 0 },
  ]);
  const result = freshResult();
  const wrapped = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  let caught: unknown = null;
  let returned: { stdout: string; stderr: string; code: number | null } | null = null;
  try {
    returned = await wrapped.execCommand("openclaw config get foo");
  } catch (err) {
    caught = err;
  }
  assert(caught === null, "exec-scenario-5: healthy command did NOT throw");
  assert(returned?.stdout === "Settings: foo=bar", "exec-scenario-5: result passed through");
  assert(result.errors.length === 0, "exec-scenario-5: no errors pushed for healthy command");
})();

(async () => {
  // Scenario 6: Two ENOSPC events in one reconcile — only the FIRST fires
  // the side effects (result.errors push, alert, throw). The second one
  // also throws but should NOT double-push.
  const stub = makeStubSSH([
    { stdout: "", stderr: "ENOSPC: no space left on device, open '/path1'", code: 1 },
    { stdout: "", stderr: "ENOSPC: no space left on device, open '/path2'", code: 1 },
  ]);
  const result = freshResult();
  const wrapped = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  // First call — should throw and push
  try {
    await wrapped.execCommand("cmd1");
    assert(false, "exec-scenario-6: first call should have thrown");
  } catch (err) {
    assert(isEnospcDetectedError(err), "exec-scenario-6: first call threw EnospcDetectedError");
  }
  // Second call — should also throw, but no extra side effects
  try {
    await wrapped.execCommand("cmd2");
    assert(false, "exec-scenario-6: second call should have thrown");
  } catch (err) {
    assert(isEnospcDetectedError(err), "exec-scenario-6: second call threw EnospcDetectedError");
  }
  assert(result.errors.length === 1, `exec-scenario-6: only 1 error pushed across 2 ENOSPC hits (got ${result.errors.length})`);
  assert(
    result.errors[0].includes("/path1"),
    "exec-scenario-6: first-hit path retained",
  );
})();

(async () => {
  // Scenario 7: Non-ENOSPC throw passes through (don't false-positive)
  const stub = makeStubSSH([new Error("Connection refused")]);
  const result = freshResult();
  const wrapped = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  let caught: unknown = null;
  try {
    await wrapped.execCommand("ssh-cmd");
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, "exec-scenario-7: non-ENOSPC error thrown");
  assert(
    !isEnospcDetectedError(caught),
    "exec-scenario-7: NOT classified as ENOSPC",
  );
  assert(result.errors.length === 0, "exec-scenario-7: no error pushed for non-ENOSPC throw");
})();

(async () => {
  // Scenario 8: prototype passthrough — dispose() still works on wrapped
  const stub = makeStubSSH([]);
  const result = freshResult();
  const wrapped: unknown = wrapSSHForEnospcDetection(stub, MOCK_VM, result);
  const w = wrapped as { dispose?: () => unknown };
  assert(typeof w.dispose === "function", "passthrough: dispose() is callable via prototype");
})();

// ── Summary ──────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n══════════════════════════════════════════`);
  console.log(`Tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("All scanForEnospc + wrapSSHForEnospcDetection scenarios pass.");
    process.exit(0);
  }
}, 200); // Wait for all async tests to settle
