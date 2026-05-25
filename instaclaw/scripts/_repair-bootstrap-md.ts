/**
 * scripts/_repair-bootstrap-md.ts
 *
 * One-shot SSH-write tool for VMs missing BOOTSTRAP.md from the
 * 2026-05-25 "quirky greeting silent-failure" bug. Imports the
 * canonical WORKSPACE_BOOTSTRAP_SHORT constant so the deployed
 * content is byte-identical to what configureOpenClaw is supposed
 * to write — no risk of hand-copy drift.
 *
 * Usage:
 *   npx tsx scripts/_repair-bootstrap-md.ts <ip>          # safe-by-default
 *   npx tsx scripts/_repair-bootstrap-md.ts <ip> --force  # operator override
 *
 * Three-gate refusal (safe-by-default):
 *   1. `.bootstrap_consumed` is present → REFUSE (marker = post-greeting
 *      state; re-writing would re-trigger quirky greeting mid-relationship).
 *      Cannot be overridden by --force — marker is a hard signal.
 *   2. BOOTSTRAP.md already present → check sha256 vs canonical, skip if
 *      match (idempotent) or skip if differs (preserve user variant).
 *   3. ANY assistant message in sessions (>0 chars after strip) → REFUSE
 *      (any existing agent-user interaction means re-writing would
 *      re-trigger quirky greeting mid-relationship). STRICTER than
 *      stepBootstrapMissing's ≥100-char threshold — for an operator tool,
 *      we want zero risk of mid-conversation re-greet. Pass --force to
 *      override this gate when the operator KNOWS the agent state should
 *      be reset to first-run despite existing conversation (e.g., a
 *      controlled test scenario where the agent should be re-introduced).
 *
 * Read-only-on-success: prints SHA-256 of the written content so the
 * operator can cross-check against the canonical template.
 *
 * Why the --force flag exists (and why it's narrowly scoped):
 *   The 2026-05-25 vm-1028 incident — operator (me) ran this script
 *   against a VM whose agent had already responded to two user messages
 *   (51 + 36 chars, below Layer 2's 100-char threshold but real
 *   interactions). Re-introducing BOOTSTRAP.md retroactively would have
 *   triggered the quirky greeting on the next /reset. Without a stricter
 *   gate, the script silently shipped a footgun. Stricter gate closes
 *   the default-path footgun; --force preserves the controlled-override
 *   use case (test loops, intentional first-run resets).
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { NodeSSH } from "node-ssh";
import { WORKSPACE_BOOTSTRAP_SHORT } from "../lib/ssh";

function loadEnvFiles() {
  for (const f of [
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
  ]) {
    try {
      const env = readFileSync(f, "utf-8");
      for (const l of env.split("\n")) {
        const m = l.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) {
          process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      // best-effort
    }
  }
}

async function main() {
  // Order-agnostic arg parsing: find IP via regex, look for --force token.
  // Accepts: `<ip>`, `<ip> --force`, `--force <ip>`.
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const ip = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ip) {
    console.error("Usage: npx tsx scripts/_repair-bootstrap-md.ts <ip> [--force]");
    console.error("");
    console.error("  <ip>     IPv4 address of the target VM (openclaw@<ip>)");
    console.error("  --force  Override the substantive-convo refusal gate.");
    console.error("           Does NOT override the .bootstrap_consumed marker check.");
    process.exit(1);
  }

  loadEnvFiles();
  const keyB64 = process.env.SSH_PRIVATE_KEY_B64;
  if (!keyB64) {
    console.error("FATAL: SSH_PRIVATE_KEY_B64 not loaded");
    process.exit(1);
  }
  const privateKey = Buffer.from(keyB64, "base64").toString("utf-8");

  const canonicalSha = createHash("sha256")
    .update(WORKSPACE_BOOTSTRAP_SHORT, "utf-8")
    .digest("hex");
  // Disk sizes are UTF-8 bytes; JS .length is UTF-16 code units. Use
  // Buffer.byteLength for the canonical size comparison so em-dashes and
  // other multi-byte UTF-8 sequences match correctly.
  const canonicalBytes = Buffer.byteLength(WORKSPACE_BOOTSTRAP_SHORT, "utf-8");

  console.log(`Target: openclaw@${ip}`);
  console.log(`Canonical WORKSPACE_BOOTSTRAP_SHORT: ${canonicalBytes} bytes (${WORKSPACE_BOOTSTRAP_SHORT.length} UTF-16 code units), sha256=${canonicalSha}`);

  const ssh = new NodeSSH();
  await ssh.connect({
    host: ip,
    username: "openclaw",
    privateKey,
    readyTimeout: 15_000,
  });

  try {
    const probe = await ssh.execCommand(
      `ws=$HOME/.openclaw/workspace; ` +
        `bs=$(test -f "$ws/BOOTSTRAP.md" && [ -s "$ws/BOOTSTRAP.md" ] && echo yes || echo no); ` +
        `mk=$(test -f "$ws/.bootstrap_consumed" && echo yes || echo no); ` +
        `echo "bootstrap=$bs marker=$mk"`
    );
    console.log(`Pre-write state: ${probe.stdout.trim()}`);

    const bootstrapPresent = /bootstrap=yes/.test(probe.stdout);
    const markerPresent = /marker=yes/.test(probe.stdout);

    if (markerPresent) {
      console.error("REFUSING: .bootstrap_consumed is present. User has already greeted; re-writing would re-trigger quirky greeting mid-relationship.");
      process.exit(2);
    }

    if (bootstrapPresent) {
      console.log("BOOTSTRAP.md already present — checking content matches canonical...");
      const cmpResult = await ssh.execCommand(
        `sha256sum "$HOME/.openclaw/workspace/BOOTSTRAP.md" | awk '{print $1}'`
      );
      const remoteSha = cmpResult.stdout.trim();
      if (remoteSha === canonicalSha) {
        console.log("Content matches canonical — no action needed.");
        process.exit(0);
      } else {
        console.log(`Remote sha=${remoteSha.slice(0, 16)}... DIFFERS from canonical (possibly Gmail-personalized variant). Skipping rewrite to preserve user variant.`);
        process.exit(0);
      }
    }

    // ── Gate 3: substantive-convo check (NEW — closes vm-1028 footgun) ──
    //
    // Even with file AND marker absent, the agent may still have had a
    // conversation with the user (brief replies under Layer 2's 100-char
    // "substantive" threshold). Re-writing BOOTSTRAP.md retroactively
    // would trigger the quirky "first moment awake" greeting on the
    // user's next /reset — mid-relationship re-greet, the exact failure
    // mode Layer 2's marker check exists to prevent.
    //
    // Stricter than stepBootstrapMissing's gate (≥100 chars): ANY
    // assistant message with >0 chars after strip blocks the write. For
    // an operator tool, default to zero risk of re-greeting.
    //
    // Operator override: --force skips this check. Marker check (Gate 1)
    // is NOT overridable — marker presence is a hard "post-greeting"
    // signal that should never be casually reset.
    //
    // open() uses encoding='utf-8', errors='ignore' to handle hypothetical
    // C-locale VMs gracefully (UnicodeDecodeError on non-ASCII bytes in
    // jsonl files would otherwise crash the Python script).
    if (!force) {
      const convoCheck = await ssh.execCommand(`python3 - <<'REPAIR_CONVO_CHECK_PY'
import json, os, glob
sessions_dir = os.path.expanduser('~/.openclaw/agents/main/sessions')
for f in glob.glob(os.path.join(sessions_dir, '*.jsonl')):
    if 'trajectory' in f or 'checkpoint' in f:
        continue
    try:
        with open(f, encoding='utf-8', errors='ignore') as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                msg = e.get('message') or {}
                if not isinstance(msg, dict):
                    continue
                if msg.get('role') != 'assistant':
                    continue
                content = msg.get('content')
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    for b in content:
                        if isinstance(b, dict) and b.get('type') == 'text':
                            t = b.get('text')
                            if isinstance(t, str):
                                parts.append(t)
                    text = ''.join(parts)
                else:
                    text = ''
                if len(text.strip()) > 0:
                    print('USED')
                    raise SystemExit(0)
    except (OSError, IOError):
        continue
print('NOT_USED')
REPAIR_CONVO_CHECK_PY`);
      const verdict = convoCheck.stdout.trim();
      // Fail-safe: anything not exactly NOT_USED is treated as USED.
      // Unexpected output (Python crash, non-zero exit) defaults to
      // refuse — never write speculatively when convo state is uncertain.
      if (verdict !== "NOT_USED") {
        console.error("");
        console.error("REFUSING: agent has existing assistant messages in sessions.");
        console.error("");
        console.error("Re-writing BOOTSTRAP.md now would trigger the quirky 'first moment");
        console.error("awake' greeting on the user's next session start — mid-relationship");
        console.error("re-greet, which is exactly the failure mode Layer 2's marker check");
        console.error("is designed to prevent.");
        console.error("");
        console.error(`Convo probe verdict: ${verdict.slice(0, 80)}`);
        console.error("");
        console.error("If you're sure (e.g., a controlled test where the agent state should");
        console.error("be reset to first-run despite existing conversation), re-run with");
        console.error("--force to override this check:");
        console.error("");
        console.error(`  npx tsx scripts/_repair-bootstrap-md.ts ${ip} --force`);
        console.error("");
        console.error("The --force flag does NOT override the .bootstrap_consumed marker");
        console.error("check — if the marker exists, this script will always refuse.");
        process.exit(2);
      }
    } else {
      console.log(
        "WARN: --force enabled — skipping substantive-convo check. " +
          "Writing BOOTSTRAP.md despite potential existing conversation. " +
          "Operator has explicitly opted in."
      );
    }

    // Gates 1, 2, 3 cleared (or --force overrode Gate 3). Safe to write.
    const b64 = Buffer.from(WORKSPACE_BOOTSTRAP_SHORT, "utf-8").toString("base64");
    const writeResult = await ssh.execCommand(
      `echo '${b64}' | base64 -d > $HOME/.openclaw/workspace/BOOTSTRAP.md`
    );
    if (writeResult.code !== 0) {
      console.error(`FATAL: write failed: ${writeResult.stderr}`);
      process.exit(1);
    }

    const verify = await ssh.execCommand(
      `f=$HOME/.openclaw/workspace/BOOTSTRAP.md; ` +
        `if test -f "$f" && [ -s "$f" ]; then ` +
        `  printf "size=%s sha=%s" $(stat -c%s "$f") $(sha256sum "$f" | awk '{print $1}'); ` +
        `else echo FAILED; fi`
    );
    console.log(`Post-write verify: ${verify.stdout.trim()}`);

    const m = verify.stdout.match(/size=(\d+)\s+sha=([0-9a-f]+)/);
    if (!m) {
      console.error("FATAL: post-write verify did not parse cleanly");
      process.exit(1);
    }
    const writtenSize = parseInt(m[1], 10);
    const writtenSha = m[2];

    // SHA-256 is the authoritative content check. Size is informational only
    // (UTF-8 bytes; matches canonicalBytes when content is identical).
    if (writtenSha !== canonicalSha) {
      console.error(
        `FATAL: written content sha256 does not match canonical. ` +
          `expected sha=${canonicalSha}, got sha=${writtenSha} ` +
          `(canonical=${canonicalBytes} bytes, on-disk=${writtenSize} bytes)`
      );
      process.exit(1);
    }
    if (writtenSize !== canonicalBytes) {
      // Should never trigger if sha matches; defense in depth.
      console.error(
        `FATAL: size mismatch despite sha match — expected ${canonicalBytes} bytes, got ${writtenSize}`
      );
      process.exit(1);
    }

    console.log("SUCCESS: BOOTSTRAP.md written + verified. Quirky greeting will fire on next user message.");
  } finally {
    ssh.dispose();
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
