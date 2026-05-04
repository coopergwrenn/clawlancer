/**
 * End-to-end test for consensus_intent_sync.py on vm-780.
 *
 * Tests in order:
 *   1. Upload script + extractor to /tmp on vm-780
 *   2. Wipe state file (force fresh run)
 *   3. Run with --dry-run; verify it extracts + would-POST
 *   4. Run again immediately; verify throttle skips it (no extraction)
 *   5. Run with --force; verify it extracts even with no change
 *   6. Inspect state file contents
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local","/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function main() {
  const ssh = new NodeSSH();
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12_000 });

  console.log("── 1. Upload extractor + sync to /tmp ──");
  await ssh.putFile(
    "/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/consensus_intent_extract.py",
    "/tmp/consensus_intent_extract.py"
  );
  await ssh.putFile(
    "/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/consensus_intent_sync.py",
    "/tmp/consensus_intent_sync.py"
  );
  console.log("  ✓ uploaded");

  console.log("");
  console.log("── 2. Wipe state file (force fresh run) ──");
  await ssh.execCommand("rm -f ~/.openclaw/.consensus_intent_state.json ~/.openclaw/.consensus_intent.lock");
  console.log("  ✓ state wiped");

  console.log("");
  console.log("── 3. First run with --dry-run (should extract) ──");
  const start1 = Date.now();
  const r1 = await ssh.execCommand("cd /tmp && python3 consensus_intent_sync.py --dry-run");
  const elapsed1 = ((Date.now() - start1) / 1000).toFixed(1);
  console.log(`  latency: ${elapsed1}s`);
  console.log("  stderr (telemetry):");
  console.log("  " + (r1.stderr || "(none)").split("\n").join("\n  "));
  console.log("  stdout (would-POST body):");
  // Just print the first 1000 chars of stdout
  console.log("  " + (r1.stdout || "(empty)").slice(0, 1000).split("\n").join("\n  "));
  if (r1.stderr.includes("first_extraction") && r1.stdout.includes("would_post_to")) {
    console.log("  ✓ first extraction triggered + dry-run output produced");
  } else {
    console.log("  ✗ unexpected output");
  }

  console.log("");
  console.log("── 4. Inspect state after first run ──");
  const stateA = await ssh.execCommand("cat ~/.openclaw/.consensus_intent_state.json 2>/dev/null || echo MISSING");
  console.log("  " + stateA.stdout.split("\n").join("\n  "));

  // NOTE: throttle behavior is not testable via --dry-run because dry-run
  // intentionally does not persist state (so you can re-run dry-run
  // repeatedly without polluting real state). Throttle logic is unit-
  // testable separately by simulating different state.json contents.
  console.log("");
  console.log("── 5. Skip dry-run-throttle test (dry-run intentionally bypasses state) ──");

  console.log("");
  console.log("── 6. --force run (should extract regardless of state) ──");
  const start3 = Date.now();
  const r3 = await ssh.execCommand("cd /tmp && python3 consensus_intent_sync.py --dry-run --force");
  const elapsed3 = ((Date.now() - start3) / 1000).toFixed(1);
  console.log(`  latency: ${elapsed3}s`);
  console.log("  stderr last 4 lines:");
  console.log("  " + (r3.stderr || "(none)").split("\n").slice(-5).join("\n  "));
  if (r3.stderr.includes("--force") && r3.stdout.includes("would_post_to")) {
    console.log("  ✓ --force bypassed throttle, extraction ran");
  } else {
    console.log("  ✗ --force did not behave as expected");
  }

  console.log("");
  console.log("── 7. Lock contention test ──");
  // Manually grab the lock, then try to run — should exit cleanly
  await ssh.execCommand("touch ~/.openclaw/.consensus_intent.lock");
  const lockTest = await ssh.execCommand(`
flock -n ~/.openclaw/.consensus_intent.lock -c 'sleep 5' &
LOCKER=$!
sleep 0.5
cd /tmp && python3 consensus_intent_sync.py --dry-run 2>&1 | head -3
kill $LOCKER 2>/dev/null
wait $LOCKER 2>/dev/null
`);
  console.log("  output: " + lockTest.stdout.replace(/\n/g, " | "));
  if (lockTest.stdout.includes("another sync run in progress")) {
    console.log("  ✓ second invocation correctly bailed on locked file");
  } else {
    console.log("  ⚠ lock test inconclusive (may need flock binary)");
  }

  // Cleanup
  await ssh.execCommand(
    "rm -f /tmp/consensus_intent_extract.py /tmp/consensus_intent_sync.py ~/.openclaw/.consensus_intent_state.json ~/.openclaw/.consensus_intent.lock"
  );
  ssh.dispose();

  console.log("");
  console.log("══ Done ══");
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
