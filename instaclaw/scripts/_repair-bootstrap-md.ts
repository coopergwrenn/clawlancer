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
 *   npx tsx scripts/_repair-bootstrap-md.ts <ip>
 *
 * Skips the write if BOOTSTRAP.md is already present (idempotent).
 * Refuses to overwrite if `.bootstrap_consumed` exists (user has
 * already greeted; re-writing would re-trigger the quirky greeting
 * mid-relationship, which is the exact bug the marker prevents).
 *
 * Read-only-on-success: prints SHA-256 of the written content so
 * the operator can cross-check against the canonical template.
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
  const ip = process.argv[2];
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    console.error("Usage: npx tsx scripts/_repair-bootstrap-md.ts <ip>");
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

    // BOOTSTRAP.md absent AND .bootstrap_consumed absent — this is the
    // bug state. Safe to write.
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
