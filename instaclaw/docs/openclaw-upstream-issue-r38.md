# OpenClaw Upstream Issue Draft — `openclaw config set` leaves orphaned `.tmp` files on ENOSPC

**To file at:** the openclaw GitHub repo (issues tab)
**Author context:** Cooper Wrenn (InstaClaw / instaclaw.io) — operating ~150 OpenClaw 2026.4.26 VMs in production. Found 2026-05-14 during InstaClaw's Rule 38 fleet-side mitigation work.
**Status:** Drafted but not yet filed (awaiting Cooper's review of the issue text before posting publicly).

---

## Title

`openclaw config set` leaves orphaned `.tmp` files on ENOSPC — inode burn on long-lived disk-full hosts

## Body

### Summary

On a host with disk usage at ~100%, `openclaw config set <key> <value>` exits non-zero with an ENOSPC stderr but leaves a zero-byte file at `~/.openclaw/openclaw.json.<pid>.<uuid>.tmp` (the atomic-write staging file). Repeated retries by the caller accumulate these orphan files indefinitely. Even after bytes are freed elsewhere, the surviving inodes can eventually exhaust the host's inode budget — and the openclaw config write path then fails on inode exhaustion instead of disk-space exhaustion, which is a confusing diagnostic surface.

### Reproduction

```bash
# Pre-condition: disk near full
dd if=/dev/zero of=/tmp/fill bs=1M count=$(($(df -m / | awk 'NR==2{print $4}') - 10))

# Repeatedly attempt to write a non-trivial config value:
for i in $(seq 1 50); do
  openclaw config set agents.defaults.bootstrapMaxChars 40000 || true
done

# Observe accumulation:
ls -la ~/.openclaw/openclaw.json.*.tmp | wc -l   # ~50 zero-byte files
```

### Observed in production

InstaClaw's vm-788 accumulated **40+ zero-byte `openclaw.json.*.tmp` files** between 2026-05-08 and 2026-05-14. Forensic dump:

```
$ ls -la ~/.openclaw/openclaw.json.*.tmp | wc -l
42
$ stat -c '%s' ~/.openclaw/openclaw.json.*.tmp | sort -u
0
$ ls -la ~/.openclaw/openclaw.json.*.tmp | head -3
-rw-rw-r-- 1 openclaw openclaw 0 May 8 19:34 ~/.openclaw/openclaw.json.123456.5a7b8c9d.tmp
-rw-rw-r-- 1 openclaw openclaw 0 May 8 19:35 ~/.openclaw/openclaw.json.123457.6b8c9d0e.tmp
...
```

The `~/.openclaw/openclaw.json.<pid>.<uuid>.tmp` naming pattern is consistent with the atomic-write-via-rename idiom (write tmp → fsync → rename over target). On ENOSPC, the rename never happens, but the tmp is left in place.

### Expected behavior

`openclaw config set` should clean up its `.tmp` staging file on any exit path that doesn't end in a successful rename. A POSIX-portable pattern:

```bash
TMP=$(mktemp ...)
trap 'rm -f "$TMP"' EXIT
# ... write to $TMP, attempt rename, etc.
```

Or, in the equivalent JS/TS:

```ts
let tmpPath: string | null = null;
try {
  tmpPath = await openTmpForWrite(target);
  await writeAtomic(tmpPath, content);
  await fs.rename(tmpPath, target);
  tmpPath = null;  // success — don't unlink in finally
} finally {
  if (tmpPath !== null) {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}
```

### Why this matters

For platforms that retry config writes on transient ENOSPC (InstaClaw's reconciler retries every 3 min via Vercel cron), each retry creates a new orphan. Over weeks, the orphan count grows linearly. Best case: harmless directory bloat. Worst case: inode exhaustion on small inode-budget filesystems, which surfaces as a NEW class of "config write failure" with a different error message and a confused operator.

### Fleet-side mitigation (InstaClaw)

We've deployed a reconciler-side cleanup as defense-in-depth: `find ~/.openclaw/ -maxdepth 1 -name "openclaw.json.*.tmp" -mmin +60 -delete` runs on every reconcile + file-drift cron tick. 60-min mtime bound to avoid racing in-flight atomic writes. This keeps the fleet bounded but doesn't fix the canonical bug in the openclaw CLI.

### Severity & priority

- **Severity**: Low-impact under normal conditions (bytes freed eventually clear the ENOSPC). High-impact in the tail where inode-budget VMs accumulate orphans past the inode cap.
- **Priority**: Suggest "good first issue" — straightforward `try/finally` (or `defer` / `trap`) addition in whichever module owns the atomic-write helper.

### Versions affected

Observed on `OpenClaw 2026.4.26` (be8c246). Presumed present in earlier versions too since the atomic-write pattern is long-standing.

### Additional context

If a maintainer wants to coordinate on a fix, happy to share the InstaClaw-side mitigation code as a reference. Files: `lib/vm-reconcile.ts:stepDiskGuard` (the unconditional cleanup site) and `lib/enospc-guard.ts` (the ENOSPC-detection wrapper that surfaces the original failure visibly). Both linked from CLAUDE.md Rule 37 + Rule 38 entries.
