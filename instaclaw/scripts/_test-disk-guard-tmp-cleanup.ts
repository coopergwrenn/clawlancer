/**
 * Synthetic test for Rule 38 — stepDiskGuard's unconditional .tmp cleanup.
 *
 * Run: npx tsx scripts/_test-disk-guard-tmp-cleanup.ts
 *
 * Why this test exists:
 *   stepDiskGuard's pre-fix behavior gated the openclaw.json.*.tmp cleanup
 *   inside the `if (diskPct >= 90)` block — so it never fired on VMs with
 *   healthy disk. Rule 38 says the cleanup must fire on every reconcile
 *   regardless of disk%, so a slow accumulation of zero-byte .tmp files
 *   (from openclaw config set hitting transient ENOSPC) can't pile up to
 *   the inode-exhaustion point that hit vm-788 (40+ files).
 *
 * What this verifies:
 *   At every disk-percent level (50%, 80%, 85%, 91%, 95%, and dryRun),
 *   stepDiskGuard issues the `find ~/.openclaw/ -name 'openclaw.json.*.tmp'
 *   -mmin +60 -delete` command BEFORE any of the disk-pressure-gated paths
 *   return. Dry-run honors the gate (skips the actual find -delete).
 *
 * We use a recording-stub SSH that captures every execCommand. The first
 * call (df /) is canned to return the test's target disk percentage. All
 * other commands return success without side effects.
 *
 * The fact that we're testing via `__test_stepDiskGuard` means the test
 * exercises the real reconciler code path — no shadow re-implementation
 * to drift out of sync.
 */
import { __test_stepDiskGuard } from "../lib/vm-reconcile";
import type { VMRecord } from "../lib/ssh";
import type { ReconcileResult } from "../lib/vm-reconcile";

// ── Test harness ──────────────────────────────────────────────────────

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

const TMP_CLEANUP_PATTERN = /openclaw\.json\.\*\.tmp.*-mmin\s*\+60.*-delete/;

// Recording stub. df / returns `diskPct`, all other commands succeed silently.
function makeRecordingSsh(diskPct: number) {
  const calls: string[] = [];
  return {
    calls,
    execCommand: async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("df /")) return { stdout: String(diskPct), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    putFile: async () => undefined,
    dispose: () => undefined,
  };
}

function hasTmpCleanupCall(calls: string[]): boolean {
  return calls.some((c) => TMP_CLEANUP_PATTERN.test(c));
}

// ── Tests — disk-pct sweep ────────────────────────────────────────────

(async () => {
  console.log("Rule 38 — stepDiskGuard unconditional .tmp cleanup\n");

  for (const [pct, label] of [
    [50, "50% (healthy — should fire .tmp cleanup before early-return)"],
    [70, "70% (healthy)"],
    [79, "79% (just under threshold)"],
    [80, "80% (between thresholds — warning path)"],
    [85, "85% (warning)"],
    [89, "89% (just under emergency)"],
    [91, "91% (≥90% purge path)"],
    [95, "95% (≥95% — critical)"],
    [100, "100% (full disk)"],
  ] as Array<[number, string]>) {
    const stub = makeRecordingSsh(pct);
    const result = freshResult();
    await __test_stepDiskGuard(stub as unknown as never, MOCK_VM, result, false);
    assert(
      hasTmpCleanupCall(stub.calls),
      `disk=${pct}% (${label}): .tmp cleanup issued`,
    );
  }

  // Dry-run gate: cleanup must NOT fire in dryRun mode.
  {
    const stub = makeRecordingSsh(50);
    const result = freshResult();
    await __test_stepDiskGuard(stub as unknown as never, MOCK_VM, result, true);
    assert(
      !hasTmpCleanupCall(stub.calls),
      "dryRun=true: .tmp cleanup is gated, no find -delete issued",
    );
  }

  // Probe parse failure: when df returns garbage, stepDiskGuard pushes a
  // warning and returns early — the .tmp cleanup also should NOT fire because
  // we have no signal that the disk is healthy enough for write-side ops.
  //
  // This is the conservative bet: a probe-parse failure usually means SSH is
  // transient-flaky; better to skip a non-critical cleanup than retry on a
  // possibly-broken connection.
  {
    const stub = {
      calls: [] as string[],
      execCommand: async (cmd: string) => {
        stub.calls.push(cmd);
        // df returns un-parseable output
        if (cmd.includes("df /")) return { stdout: "WAT", stderr: "", code: 1 };
        return { stdout: "", stderr: "", code: 0 };
      },
      putFile: async () => undefined,
      dispose: () => undefined,
    };
    const result = freshResult();
    await __test_stepDiskGuard(stub as unknown as never, MOCK_VM, result, false);
    assert(
      !hasTmpCleanupCall(stub.calls),
      "probe-parse fail: .tmp cleanup NOT issued (conservative early-return)",
    );
    assert(
      result.warnings.some((w) => w.includes("probe parse failed")),
      "probe-parse fail: warning pushed",
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════`);
  console.log(`Tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("Rule 38 .tmp cleanup fires unconditionally at every disk level.");
    process.exit(0);
  }
})();
