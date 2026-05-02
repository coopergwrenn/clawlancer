import { connectSSH, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

/**
 * Clear stale Anthropic-SDK auth cache from the VM's auth-profiles.json.
 *
 * Why this exists:
 *
 * The Anthropic SDK caches billing failures to disk in
 * `~/.openclaw/agents/main/agent/auth-profiles.json` under per-profile
 * `failureState` and `disabledUntil` keys. When a customer's billing
 * fails (Stripe past_due, etc.), the SDK records the failure. When the
 * customer's billing recovers — webhook fires, our DB updates, our
 * wake path restarts the gateway — the cache on disk is STILL STALE.
 *
 * The stale cache then triggers cron/health-check's billing-cache cleaner,
 * which does `systemctl --user restart openclaw-gateway`. That restart's
 * start half can fail silently (start-limit-hit, etc.), leaving the
 * gateway dead. This is what killed Doug Rathell's vm-725 on 2026-05-02
 * 30 seconds after our wake brought it back.
 *
 * The fix: PROACTIVELY clear the stale cache the moment we know billing
 * has recovered, BEFORE the asynchronous cleaner can race with it.
 *
 * Layered defense (this is layer 1; layers 2 + 3 are separate PRs):
 *   1. Proactive clear on every billing-recovered event (THIS HELPER)
 *   2. Fix the health-check cleaner's restart to verify gateway came back
 *   3. Periodic audit detecting any user with active billing AND stale cache
 *
 * Behavior:
 *   - Best-effort. Never throws. Logs on failure.
 *   - Atomic write (tmp + mv) — never leaves the file half-written.
 *   - Removes ONLY `failureState` and `disabledUntil` from each profile.
 *     DOES NOT touch `usageStats` or any other key.
 *   - If the file doesn't exist (fresh VM, never written) → returns clean.
 *   - JSON-validates the rewritten content before installing it.
 */
export interface ClearAuthCacheResult {
  ok: boolean;
  cleared: number;     // count of profiles where keys were removed
  reason?: string;     // populated when !ok
  fileExisted: boolean;
}

const AUTH_PROFILES_PATH = "~/.openclaw/agents/main/agent/auth-profiles.json";

export async function clearStaleAuthCache(vm: VMRecord, source: string): Promise<ClearAuthCacheResult> {
  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (err) {
    logger.warn("clearStaleAuthCache: SSH connect failed — skipping (best-effort)", {
      vmId: vm.id, source, error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, cleared: 0, fileExisted: false, reason: "ssh_connect_failed" };
  }

  try {
    // Run the entire clear operation in a single python3 invocation to
    // avoid race windows between read and write. Returns a one-line summary
    // we can parse: "RESULT existed=<bool> cleared=<int>" OR "ERROR <msg>".
    const script = `python3 - <<'PY' 2>&1
import json, os, tempfile, sys
PATH = os.path.expanduser("${AUTH_PROFILES_PATH}")
if not os.path.exists(PATH):
    print("RESULT existed=false cleared=0")
    sys.exit(0)
try:
    with open(PATH) as f:
        data = json.load(f)
except Exception as e:
    print(f"ERROR parse:{type(e).__name__}:{e}")
    sys.exit(1)

cleared = 0
profiles = data.get("profiles", {}) if isinstance(data, dict) else {}
for key in list(profiles.keys()):
    prof = profiles[key]
    if not isinstance(prof, dict):
        continue
    touched = False
    if "failureState" in prof:
        del prof["failureState"]
        touched = True
    if "disabledUntil" in prof:
        del prof["disabledUntil"]
        touched = True
    if touched:
        cleared += 1

if cleared == 0:
    print("RESULT existed=true cleared=0")
    sys.exit(0)

# Atomic write: tmp file in same dir, then os.replace
try:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(PATH), prefix=".auth-profiles-clear-")
    with os.fdopen(fd, "w") as out:
        json.dump(data, out, indent=2)
    # Sanity check the tmp file parses before installing
    with open(tmp) as verify:
        json.load(verify)
    os.replace(tmp, PATH)
    print(f"RESULT existed=true cleared={cleared}")
except Exception as e:
    # Try to clean up the tmp file if it's still around
    try: os.unlink(tmp)
    except Exception: pass
    print(f"ERROR write:{type(e).__name__}:{e}")
    sys.exit(1)
PY`;

    const result = await ssh.execCommand(script);
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();

    // ─── Parse ───
    const okMatch = stdout.match(/^RESULT existed=(true|false) cleared=(\d+)/);
    if (okMatch) {
      const existed = okMatch[1] === "true";
      const cleared = parseInt(okMatch[2], 10);
      if (cleared > 0) {
        logger.info("clearStaleAuthCache: cleared", { vmId: vm.id, source, cleared });
      }
      return { ok: true, cleared, fileExisted: existed };
    }

    const errMatch = stdout.match(/^ERROR (.+)/);
    const reason = errMatch ? errMatch[1] : (stdout || stderr || "unknown_output").slice(0, 200);
    logger.error("clearStaleAuthCache: script failed", { vmId: vm.id, source, reason, code: result.code });
    return { ok: false, cleared: 0, fileExisted: false, reason };
  } catch (err) {
    logger.error("clearStaleAuthCache: threw", {
      vmId: vm.id, source, error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, cleared: 0, fileExisted: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    ssh.dispose();
  }
}

/**
 * Convenience: clear stale cache for every VM owned by a user. Used by the
 * webhook handlers — pair with wakeIfHibernating so post-wake the gateway
 * has a clean cache.
 */
export async function clearStaleAuthCacheForUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  source: string,
): Promise<ClearAuthCacheResult[]> {
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("assigned_to", userId)
    // Skip VMs that aren't reachable (frozen) or aren't ours to manage
    .neq("status", "frozen");

  if (error) {
    logger.error("clearStaleAuthCacheForUser: lookup failed", { userId, source, error: error.message });
    return [];
  }
  if (!vms?.length) return [];

  const results: ClearAuthCacheResult[] = [];
  for (const row of vms) {
    if (!row.id || !row.ip_address || !row.ssh_port || !row.ssh_user) continue;
    const vm: VMRecord = {
      id: row.id,
      ip_address: row.ip_address,
      ssh_port: row.ssh_port,
      ssh_user: row.ssh_user,
      assigned_to: row.assigned_to,
      region: row.region ?? undefined,
    };
    results.push(await clearStaleAuthCache(vm, source));
  }
  return results;
}
