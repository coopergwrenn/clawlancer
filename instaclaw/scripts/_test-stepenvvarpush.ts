/**
 * Smoke test stepEnvVarPush against vm-050.
 *
 * vm-050 already has GBRAIN_ANTHROPIC_API_KEY in its .env (from today's
 * _apply-gbrain-path-a.ts run). Expected outcome: STEPENV_OK action=no_op.
 *
 * Also tests with a fake KEY_NAME (FAKE_KEY_FOR_TEST) that doesn\'t exist on
 * vm-050 → expected outcome: STEPENV_OK action=appended (then we clean up).
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

function ssh(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 10_000 });
  });
}

function exec(c: Client, cmd: string, stdinData: string, timeoutMs: number):
    Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", code = -1;
    let resolved = false;
    const tt = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ stdout: stdout + "\n[TIMEOUT]", stderr, code: -1 }); }
    }, timeoutMs);
    c.exec(cmd, (err, stream) => {
      if (err) {
        if (!resolved) { resolved = true; clearTimeout(tt); resolve({ stdout, stderr: String(err), code: -2 }); }
        return;
      }
      stream.on("data", (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      stream.on("exit", (c: number) => { code = c; });
      stream.on("close", () => {
        if (!resolved) { resolved = true; clearTimeout(tt); resolve({ stdout, stderr, code }); }
      });
      stream.stdin.write(stdinData);
      stream.stdin.end();
    });
  });
}

const ENV_VAR_PUSH_BASH = [
  'set +e',
  'read -r KEY_VALUE < /dev/stdin',
  '[ -z "$KEY_VALUE" ] && { echo "STEPENV_FAIL no_stdin_value"; exit 1; }',
  '[ ${#KEY_VALUE} -lt 20 ] && { echo "STEPENV_FAIL short_value len=${#KEY_VALUE}"; exit 1; }',
  '',
  'KEY_NAME="$1"',
  '[ -z "$KEY_NAME" ] && { echo "STEPENV_FAIL no_key_name_arg"; exit 1; }',
  '',
  'ENV_FILE="$HOME/.openclaw/.env"',
  'TS=$(date -u +%Y%m%dT%H%M%SZ)',
  '',
  '[ ! -f "$ENV_FILE" ] && { echo "STEPENV_FAIL no_env_file path=$ENV_FILE"; exit 2; }',
  '',
  'CURRENT=$(grep "^${KEY_NAME}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\')',
  '',
  'if [ "$CURRENT" = "$KEY_VALUE" ]; then',
  '  echo "STEPENV_OK action=no_op"',
  '  exit 0',
  'fi',
  '',
  'BACKUP="$ENV_FILE.bak.envpush.$TS"',
  'cp "$ENV_FILE" "$BACKUP" || { echo "STEPENV_FAIL backup_failed"; exit 3; }',
  '',
  'if [ -n "$CURRENT" ]; then',
  '  ESCAPED=$(printf \'%s\' "$KEY_VALUE" | sed -e \'s/[&#]/\\\\&/g\')',
  '  sed -i "s#^${KEY_NAME}=.*#${KEY_NAME}=\\"$ESCAPED\\"#" "$ENV_FILE"',
  '  ACTION="replaced"',
  'else',
  '  [ -n "$(tail -c 1 "$ENV_FILE")" ] && echo "" >> "$ENV_FILE"',
  '  printf \'%s="%s"\\n\' "$KEY_NAME" "$KEY_VALUE" >> "$ENV_FILE"',
  '  ACTION="appended"',
  'fi',
  '',
  'NEW=$(grep "^${KEY_NAME}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\')',
  'if [ "$NEW" != "$KEY_VALUE" ]; then',
  '  cp "$BACKUP" "$ENV_FILE"',
  '  echo "STEPENV_FAIL verify_after_set expected_len=${#KEY_VALUE} actual_len=${#NEW}"',
  '  exit 4',
  'fi',
  '',
  'chmod 600 "$ENV_FILE" 2>/dev/null || true',
  '',
  'echo "STEPENV_OK action=$ACTION"',
  'exit 0',
].join('\n');

(async () => {
  const c = await ssh("172.239.36.76");
  const escaped = ENV_VAR_PUSH_BASH.replace(/'/g, "'\\''");

  // ── Test 1: vm-050 already has GBRAIN_ANTHROPIC_API_KEY → expect no_op ──
  console.log("══ Test 1: idempotent no-op (vm-050 already has the key) ══");
  const realKey = process.env.GBRAIN_ANTHROPIC_API_KEY;
  if (!realKey) { console.error("GBRAIN_ANTHROPIC_API_KEY missing from .env.local"); c.end(); process.exit(1); }
  const r1 = await exec(c, `bash -c '${escaped}' _ 'GBRAIN_ANTHROPIC_API_KEY'`, realKey + '\n', 15_000);
  console.log(`  exit=${r1.code}  stdout=${r1.stdout.trim()}  stderr=${r1.stderr.trim()}`);
  const ok1 = r1.stdout.includes("STEPENV_OK action=no_op");
  console.log(`  ${ok1 ? "✓ PASS" : "✗ FAIL"}: expected STEPENV_OK action=no_op\n`);

  // ── Test 2: append a fake test key, then clean up ──
  const fakeName = `__STEPENV_TEST_${Date.now()}`;
  const fakeValue = `test-value-${"x".repeat(40)}`;
  console.log(`══ Test 2: append fake key ${fakeName} ══`);
  const r2 = await exec(c, `bash -c '${escaped}' _ '${fakeName}'`, fakeValue + '\n', 15_000);
  console.log(`  exit=${r2.code}  stdout=${r2.stdout.trim()}  stderr=${r2.stderr.trim()}`);
  const ok2 = r2.stdout.includes("STEPENV_OK action=appended");
  console.log(`  ${ok2 ? "✓ PASS" : "✗ FAIL"}: expected STEPENV_OK action=appended\n`);

  // ── Test 3: same key/value → no_op (idempotency) ──
  console.log(`══ Test 3: re-apply same key/value → no_op ══`);
  const r3 = await exec(c, `bash -c '${escaped}' _ '${fakeName}'`, fakeValue + '\n', 15_000);
  console.log(`  exit=${r3.code}  stdout=${r3.stdout.trim()}`);
  const ok3 = r3.stdout.includes("STEPENV_OK action=no_op");
  console.log(`  ${ok3 ? "✓ PASS" : "✗ FAIL"}: expected STEPENV_OK action=no_op\n`);

  // ── Test 4: replace with different value ──
  const newFakeValue = `replaced-value-${"y".repeat(40)}`;
  console.log(`══ Test 4: replace with different value → replaced ══`);
  const r4 = await exec(c, `bash -c '${escaped}' _ '${fakeName}'`, newFakeValue + '\n', 15_000);
  console.log(`  exit=${r4.code}  stdout=${r4.stdout.trim()}`);
  const ok4 = r4.stdout.includes("STEPENV_OK action=replaced");
  console.log(`  ${ok4 ? "✓ PASS" : "✗ FAIL"}: expected STEPENV_OK action=replaced\n`);

  // ── Cleanup: remove the fake test key from .env ──
  console.log(`══ Cleanup: removing fake test key ${fakeName} ══`);
  const cleanupCmd = `sed -i "/^${fakeName}=/d" "$HOME/.openclaw/.env" && grep -c "^${fakeName}=" "$HOME/.openclaw/.env" 2>/dev/null || true`;
  const rC = await exec(c, cleanupCmd, '', 5_000);
  console.log(`  exit=${rC.code}  count_after_delete=${rC.stdout.trim()}`);

  c.end();

  // ── Verdict ──
  const allPass = ok1 && ok2 && ok3 && ok4;
  console.log("══ FINAL ══");
  console.log(`  Test 1 (idempotent no-op):       ${ok1 ? "✓" : "✗"}`);
  console.log(`  Test 2 (append new key):         ${ok2 ? "✓" : "✗"}`);
  console.log(`  Test 3 (re-apply same → no-op):  ${ok3 ? "✓" : "✗"}`);
  console.log(`  Test 4 (replace different):      ${ok4 ? "✓" : "✗"}`);
  console.log(`\n${allPass ? "✅ All paths verified" : "❌ One or more paths failed"}`);
  process.exit(allPass ? 0 : 1);
})();
