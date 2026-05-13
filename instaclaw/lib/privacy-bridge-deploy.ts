import { createHash } from "crypto";
import type { NodeSSH } from "node-ssh";

/**
 * Single-source-of-truth bridge deployer for edge_city VMs.
 *
 * Why this exists: the vm-354 lockout (2026-05-13) was caused by issuing
 * the bridge update as SEPARATE `ssh.execCommand` calls. Each separate
 * SSH session goes through the bridge wrapper (post-cutover), and the
 * bridge's stage-1 self-integrity check sees the unlocked state and
 * panic-blocks. We never get past the unlock-then-write phase because
 * the next SSH session never starts cleanly.
 *
 * Fix: issue the WHOLE deploy (unlock → write tmp → SHA-verify tmp →
 * atomic mv → chattr +i → rollback-on-failure) as ONE bash command in
 * ONE ssh.execCommand. The unlock window still exists, but it's now
 * inside a single bash process — no separate SSH session can race
 * because sshd hasn't released the channel.
 *
 * The bash body also includes a rollback: if the final `chattr +i`
 * fails (sudo broken, transient kernel error), restore the OLD bridge
 * content from a same-shell backup AND chattr +i THAT. The OLD content
 * is necessarily +i-able (we just removed +i from it moments ago), so
 * the rollback succeeds even when the fresh deploy fails.
 *
 * If there's NO old bridge to roll back to (first-ever deploy on a new
 * VM), and chattr +i fails twice, we exit with a clear status code so
 * the caller can flag operator-bypass-recovery-needed. On a NON-cutover
 * VM this is harmless — deploy-key SSH still works because authorized_keys
 * doesn't wrap deploy keys with command=. The lockout-on-failure case
 * only matters on cutover VMs.
 *
 * Status codes (mapped from bash exit codes, parsed from STATUS=... line):
 *   already_correct     — file content + chattr +i both match; no-op
 *   deployed            — content updated + chattr +i set + verified
 *   chattr_failed_rolled_back  — chattr +i failed twice; OLD bridge
 *                                restored + locked. Caller should retry.
 *   chattr_failed_no_backup    — chattr +i failed twice and no backup
 *                                existed (first deploy). LOCKOUT RISK
 *                                if this is a cutover VM.
 *   sha_mismatch_pre_swap      — written tmp content didn't match
 *                                expected SHA. Aborted before mv. Safe.
 *   mkdir_failed | write_failed | mv_failed | chmod_failed | unlock_failed
 *                              — pre-swap failures. Bridge unchanged.
 *   sha_unreadable_pre        — couldn't read existing bridge sha (file
 *                                missing OR unreadable; first deploy is
 *                                the common case)
 *   lsattr_unreadable_pre     — couldn't read lsattr on existing bridge
 */

export type DeployStatus =
  | "already_correct"
  | "deployed"
  | "chattr_failed_rolled_back"
  | "chattr_failed_no_backup"
  | "sha_mismatch_pre_swap"
  | "mkdir_failed"
  | "write_failed"
  | "mv_failed"
  | "chmod_failed"
  | "unlock_failed"
  | "sha_unreadable_pre"
  | "lsattr_unreadable_pre"
  | "exec_failed";

export interface DeployResult {
  ok: boolean;
  status: DeployStatus;
  finalSha?: string;
  finalAttrs?: string;
  expectedSha: string;
  rawOutput?: string;
  error?: string;
}

interface DeployOptions {
  /** Absolute path on the VM where the bridge lives. */
  remotePath?: string;
  /** Skip actual writes; report what would happen. */
  dryRun?: boolean;
}

const DEFAULT_BRIDGE_PATH = "/home/openclaw/.openclaw/scripts/privacy-bridge.sh";

/**
 * Deploy the privacy bridge to a single VM via ONE ssh.execCommand.
 *
 * Caller responsibilities:
 *   - The SSH connection is alive
 *   - The VM is partner=edge_city (this helper does NOT check)
 *   - `content` is the canonical bridge content (the helper hashes it
 *     to compute expectedSha)
 */
export async function deployPrivacyBridge(
  ssh: NodeSSH,
  content: string,
  opts: DeployOptions = {}
): Promise<DeployResult> {
  const remotePath = opts.remotePath ?? DEFAULT_BRIDGE_PATH;
  const expectedSha = createHash("sha256").update(content).digest("hex");
  const b64 = Buffer.from(content, "utf-8").toString("base64");

  if (opts.dryRun) {
    // Dry-run: read pre-state via separate commands. This is safe even
    // on cutover VMs because we're not writing anything.
    const preSha = await ssh.execCommand(
      `[ -f ${remotePath} ] && sha256sum ${remotePath} 2>/dev/null | awk '{print $1}' || echo MISSING`
    );
    const onDiskSha = (preSha.stdout || "").trim();
    const preAttrs = await ssh.execCommand(`lsattr -- ${remotePath} 2>/dev/null | awk '{print $1}'`);
    const attrs = (preAttrs.stdout || "").trim();
    if (onDiskSha === expectedSha && /i/.test(attrs)) {
      return {
        ok: true,
        status: "already_correct",
        finalSha: onDiskSha,
        finalAttrs: attrs,
        expectedSha,
      };
    }
    return {
      ok: true,
      status: "deployed",
      finalSha: onDiskSha,
      finalAttrs: attrs,
      expectedSha,
      rawOutput: "[dry-run] would deploy + chattr +i",
    };
  }

  // ── The one-shot bash body ─────────────────────────────────────────────
  //
  // Critical design: single ssh.execCommand. Between any two phases of
  // this bash body, no external SSH session can hit the bridge because
  // sshd hasn't released the channel. The chattr -i ↔ chattr +i window
  // is irreducible on ext4 but is now bounded to ONE process.
  //
  // Failure modes handled inside bash:
  //   - unlock fails → log + continue (might be a fresh-deploy path)
  //   - mkdir fails → exit non-zero, no writes happened
  //   - write tmp fails → exit, no swap happened
  //   - tmp SHA mismatch (corruption in transit) → exit, no swap
  //   - mv fails → exit, no swap (rare; usually filesystem error)
  //   - chattr +i fails twice → ROLLBACK to old bridge from $BAK
  //     - If $BAK doesn't exist (first deploy) → exit with no_backup status
  //
  // We intentionally do NOT `set -e` because we need fine-grained error
  // handling per phase. Each command is checked explicitly.

  const bashBody = `
set -u
BR=${remotePath}
TMP=$BR.tmp.$$
BAK=$BR.bak.deploy.$$
EXPECTED='${expectedSha}'

# Phase 1: pre-state
if [ -f "$BR" ]; then
  PRE_SHA=$(sha256sum "$BR" 2>/dev/null | awk '{print $1}')
  PRE_ATTRS=$(lsattr -- "$BR" 2>/dev/null | awk '{print $1}')
else
  PRE_SHA="MISSING"
  PRE_ATTRS=""
fi

# Phase 2: idempotency — exit early if content matches and +i is set
if [ "$PRE_SHA" = "$EXPECTED" ] && echo "$PRE_ATTRS" | grep -q i; then
  echo "STATUS=already_correct"
  echo "FINAL_SHA=$PRE_SHA"
  echo "FINAL_ATTRS=$PRE_ATTRS"
  exit 0
fi

# Phase 3: backup current bridge if present (for rollback path)
if [ "$PRE_SHA" != "MISSING" ]; then
  # Unlock first so we can copy. cp will succeed even on +i'd files (cp
  # only reads source) but we unlock anyway to allow subsequent mv.
  sudo -n chattr -i "$BR" 2>/dev/null
  cp -p "$BR" "$BAK" 2>/dev/null || true
fi

# Phase 4: mkdir parent + decode new content to tmp + chmod
mkdir -p "$(dirname "$BR")" || { echo "STATUS=mkdir_failed"; exit 10; }
echo '${b64}' | base64 -d > "$TMP" || { echo "STATUS=write_failed"; rm -f "$TMP" "$BAK"; exit 11; }
chmod 0755 "$TMP" || { echo "STATUS=chmod_failed"; rm -f "$TMP" "$BAK"; exit 12; }

# Phase 5: SHA-verify tmp BEFORE swap (catches base64 corruption etc.)
TMP_SHA=$(sha256sum "$TMP" 2>/dev/null | awk '{print $1}')
if [ "$TMP_SHA" != "$EXPECTED" ]; then
  rm -f "$TMP" "$BAK"
  echo "STATUS=sha_mismatch_pre_swap"
  echo "TMP_SHA=$TMP_SHA"
  echo "EXPECTED=$EXPECTED"
  exit 13
fi

# Phase 6: atomic swap (mv into final path). $BR is now mutable (unlocked
# in phase 3 if it existed). After this, the file is at the canonical path
# with new content, but +i is NOT set yet.
mv "$TMP" "$BR" || { echo "STATUS=mv_failed"; rm -f "$TMP" "$BAK"; exit 14; }
chmod 0755 "$BR"

# Phase 7: chattr +i — RETRY ONCE on failure (transient errors are
# rare but cheap to recover from)
if ! sudo -n chattr +i "$BR" 2>/dev/null; then
  sleep 1
  if ! sudo -n chattr +i "$BR" 2>/dev/null; then
    # Phase 8: ROLLBACK — restore old bridge from $BAK + chattr +i
    if [ -f "$BAK" ]; then
      # mv backup to canonical path. $BR is mutable (we just confirmed
      # we can't chattr +i it; rare, but means kernel/sudo issue).
      mv "$BAK" "$BR" 2>/dev/null
      sudo -n chattr +i "$BR" 2>/dev/null
      ROLLBACK_SHA=$(sha256sum "$BR" 2>/dev/null | awk '{print $1}')
      ROLLBACK_ATTRS=$(lsattr -- "$BR" 2>/dev/null | awk '{print $1}')
      echo "STATUS=chattr_failed_rolled_back"
      echo "FINAL_SHA=$ROLLBACK_SHA"
      echo "FINAL_ATTRS=$ROLLBACK_ATTRS"
      echo "NOTE=restored old bridge; new content NOT deployed"
      exit 20
    fi
    # No backup — bridge has NEW content but NO +i. Lockout risk on
    # cutover VMs. Caller must use bypass key to recover.
    FAIL_SHA=$(sha256sum "$BR" 2>/dev/null | awk '{print $1}')
    FAIL_ATTRS=$(lsattr -- "$BR" 2>/dev/null | awk '{print $1}')
    echo "STATUS=chattr_failed_no_backup"
    echo "FINAL_SHA=$FAIL_SHA"
    echo "FINAL_ATTRS=$FAIL_ATTRS"
    echo "NOTE=BRIDGE_UNLOCKED bypass-key recovery needed if VM is cutover"
    exit 21
  fi
fi

# Phase 9: success path — verify final state, cleanup backup
rm -f "$BAK"
FINAL_SHA=$(sha256sum "$BR" 2>/dev/null | awk '{print $1}')
FINAL_ATTRS=$(lsattr -- "$BR" 2>/dev/null | awk '{print $1}')
if [ "$FINAL_SHA" != "$EXPECTED" ]; then
  # Should never happen — we just SHA-verified $TMP and mv'd it. But
  # belt-and-suspenders: report so caller knows something is weird.
  echo "STATUS=sha_mismatch_post_swap_paradox"
  echo "FINAL_SHA=$FINAL_SHA"
  echo "FINAL_ATTRS=$FINAL_ATTRS"
  exit 30
fi
if ! echo "$FINAL_ATTRS" | grep -q i; then
  echo "STATUS=chattr_unset_post_lock_paradox"
  echo "FINAL_SHA=$FINAL_SHA"
  echo "FINAL_ATTRS=$FINAL_ATTRS"
  exit 31
fi
echo "STATUS=deployed"
echo "FINAL_SHA=$FINAL_SHA"
echo "FINAL_ATTRS=$FINAL_ATTRS"
exit 0
`;

  let res;
  try {
    res = await ssh.execCommand(bashBody);
  } catch (err) {
    return {
      ok: false,
      status: "exec_failed",
      expectedSha,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const stdout = res.stdout || "";
  const stderr = res.stderr || "";
  const combined = stdout + "\n" + stderr;

  // Parse STATUS line + FINAL_SHA + FINAL_ATTRS
  const statusMatch = stdout.match(/^STATUS=(\S+)/m);
  const finalShaMatch = stdout.match(/^FINAL_SHA=(\S+)/m);
  const finalAttrsMatch = stdout.match(/^FINAL_ATTRS=(\S+)/m);

  const status = (statusMatch?.[1] || "exec_failed") as DeployStatus;
  const finalSha = finalShaMatch?.[1];
  const finalAttrs = finalAttrsMatch?.[1];

  const ok =
    status === "already_correct" ||
    status === "deployed" ||
    status === "chattr_failed_rolled_back";

  return {
    ok,
    status,
    finalSha,
    finalAttrs,
    expectedSha,
    rawOutput: combined.slice(0, 2000),
    error: ok ? undefined : `bridge deploy ${status}: ${stderr.slice(0, 200)}`,
  };
}
