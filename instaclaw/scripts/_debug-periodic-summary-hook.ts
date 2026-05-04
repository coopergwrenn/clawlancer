/**
 * Debug why run_periodic_summary_hook never fires on real VMs.
 *
 * Cooper: 5/5 active VMs have zero session-log updates post-deploy.
 * Sentinels present, exit code 0 — function silently skipping.
 *
 * Approach: SSH into 5 active VMs and run a Python probe that checks each
 * early-return gate inline:
 *   1. _load_summary_state() contents
 *   2. _get_main_session_id() result  +  dump sessions.json keys
 *   3. throttle check (now - last_ts vs 7200)
 *   4. dedup check (session-log.md mtime age)
 *   5. session_file exists?
 *   6. _extract_conversation message count vs last_msg_count
 *   7. recent telemetry related to PERIODIC_SUMMARY_V1
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const TARGETS = (process.env.DEBUG_VMS || "instaclaw-vm-748,instaclaw-vm-867,instaclaw-vm-855,instaclaw-vm-linode-06").split(",");

const probePy = String.raw`#!/usr/bin/env python3
import json, os, time, glob

SESSIONS_DIR = os.path.expanduser("~/.openclaw/agents/main/sessions")
SESSIONS_JSON = os.path.join(SESSIONS_DIR, "sessions.json")
WORKSPACE_DIR = os.path.expanduser("~/.openclaw/workspace")
SESSION_LOG = os.path.join(WORKSPACE_DIR, "memory", "session-log.md")
SUMMARY_STATE = os.path.expanduser("~/.openclaw/.session-summary-state.json")
PERIODIC_SUMMARY_INTERVAL = 7200
PERIODIC_RECENT_DEDUPE_SECONDS = 1800
PERIODIC_SUMMARY_MIN_NEW_MSGS = 3

print("══════════════════════════════════════════════")
print("STATE FILE")
print("══════════════════════════════════════════════")
if os.path.exists(SUMMARY_STATE):
    print("path:", SUMMARY_STATE)
    print("size:", os.path.getsize(SUMMARY_STATE), "bytes")
    print("mtime:", time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(os.path.getmtime(SUMMARY_STATE))))
    try:
        with open(SUMMARY_STATE) as f:
            state = json.load(f)
        print("contents:", json.dumps(state, indent=2))
    except Exception as e:
        print("parse error:", str(e))
        state = {}
else:
    print("STATE FILE DOES NOT EXIST — first-run defaults will be used")
    state = {}

print("")
print("══════════════════════════════════════════════")
print("sessions.json keys")
print("══════════════════════════════════════════════")
if os.path.exists(SESSIONS_JSON):
    print("path:", SESSIONS_JSON, "size:", os.path.getsize(SESSIONS_JSON))
    try:
        with open(SESSIONS_JSON) as f:
            sj = json.load(f)
        print("total keys:", len(sj))
        for k, v in sj.items():
            sid = v.get("sessionId", "?") if isinstance(v, dict) else "?"
            print("  key=" + k + "  sessionId=" + str(sid))
    except Exception as e:
        print("parse error:", str(e))
        sj = {}
else:
    print("sessions.json DOES NOT EXIST")
    sj = {}

print("")
print("══════════════════════════════════════════════")
print("_get_main_session_id() result")
print("══════════════════════════════════════════════")
result = None
result_via = None
if isinstance(sj, dict):
    if "agent:main:main" in sj:
        result = sj["agent:main:main"].get("sessionId")
        result_via = "exact match key='agent:main:main'"
    if result is None:
        for key, val in sj.items():
            if "telegram" in key and "group" not in key and "cron" not in key:
                result = val.get("sessionId")
                result_via = "fallback: 'telegram' in key (key=" + key + ")"
                break
print("returns:", result, "(via", result_via, ")")

if not result:
    print("")
    print(">>> GATE 1 (current_main is None) — function returns immediately. NO SUMMARY WRITTEN.")
    print("")

# Show what other strip-thinking gating signals look like
now = int(time.time())
print("")
print("══════════════════════════════════════════════")
print("THROTTLE CHECK (gate 2)")
print("══════════════════════════════════════════════")
last_ts = int(state.get("last_periodic_summary_ts", 0))
last_sid = state.get("last_periodic_session_id", "")
delta = now - last_ts
print("now =", now)
print("last_periodic_summary_ts =", last_ts)
print("last_periodic_session_id =", last_sid)
print("delta =", delta, "(threshold:", PERIODIC_SUMMARY_INTERVAL, ")")
print("WOULD GATE FIRE? ", delta < PERIODIC_SUMMARY_INTERVAL)

print("")
print("══════════════════════════════════════════════")
print("DEDUP CHECK (gate 3)")
print("══════════════════════════════════════════════")
if os.path.exists(SESSION_LOG):
    age = time.time() - os.path.getmtime(SESSION_LOG)
    print("session-log.md mtime age =", int(age), "s  (threshold:", PERIODIC_RECENT_DEDUPE_SECONDS, ")")
    print("WOULD GATE FIRE? ", age < PERIODIC_RECENT_DEDUPE_SECONDS)
    print("session-log.md size:", os.path.getsize(SESSION_LOG))
    print("session-log.md mtime:", time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(os.path.getmtime(SESSION_LOG))))
else:
    print("session-log.md does not exist")

print("")
print("══════════════════════════════════════════════")
print("SESSION FILE & MESSAGE COUNT (gates 4-5)")
print("══════════════════════════════════════════════")
if result:
    sf = os.path.join(SESSIONS_DIR, result + ".jsonl")
    print("session_file:", sf)
    print("exists?", os.path.exists(sf))
    if os.path.exists(sf):
        # Count user/assistant text-content messages
        msgs = 0
        try:
            with open(sf) as f:
                for line in f:
                    line = line.strip()
                    if not line: continue
                    try:
                        entry = json.loads(line)
                        msg = entry.get("message", {})
                        role = msg.get("role", "")
                        if role not in ("user", "assistant"): continue
                        content = msg.get("content", "")
                        if isinstance(content, str): text = content
                        elif isinstance(content, list):
                            text = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
                        else: continue
                        text = text.strip()
                        if text and not text.startswith("Conversation info"):
                            msgs += 1
                    except Exception: pass
        except Exception as e:
            print("read error:", str(e))
        last_msg_count = int(state.get("last_periodic_msg_count", 0))
        new_msgs = msgs - last_msg_count
        print("user/assistant msgs:", msgs)
        print("last_periodic_msg_count:", last_msg_count)
        print("new_msgs:", new_msgs, "(threshold:", PERIODIC_SUMMARY_MIN_NEW_MSGS, ")")
        print("WOULD GATE FIRE? ", new_msgs < PERIODIC_SUMMARY_MIN_NEW_MSGS)

print("")
print("══════════════════════════════════════════════")
print("STRIP-THINKING.PY DEPLOYMENT (sentinels)")
print("══════════════════════════════════════════════")
strip = os.path.expanduser("~/.openclaw/scripts/strip-thinking.py")
if os.path.exists(strip):
    with open(strip) as f:
        contents = f.read()
    sentinels = ["def trim_failed_turns", "SESSION TRIMMED:", "def run_periodic_summary_hook", "PERIODIC_SUMMARY_V1", "PRE_ARCHIVE_SUMMARY_V1"]
    for s in sentinels:
        print("  " + s + ": " + ("FOUND" if s in contents else "MISSING"))
    print("size:", os.path.getsize(strip), "bytes")
    print("mtime:", time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(os.path.getmtime(strip))))
else:
    print("strip-thinking.py MISSING")

print("")
print("══════════════════════════════════════════════")
print("RECENT PERIODIC TELEMETRY (last 50 lines)")
print("══════════════════════════════════════════════")
import subprocess
try:
    r = subprocess.run(["journalctl", "--user", "-u", "openclaw-gateway", "--since", "12 hours ago", "--no-pager"],
                       capture_output=True, text=True, timeout=20)
    out = r.stdout or ""
    lines = [l for l in out.split("\n") if "PERIODIC_SUMMARY" in l or "PRE_ARCHIVE_SUMMARY" in l or "session-end-hook" in l]
    print("matched lines:", len(lines))
    for l in lines[-30:]:
        print(l[:300])
except Exception as e:
    print("journalctl error:", str(e))

print("")
print("══════════════════════════════════════════════")
print("CRON OUTPUT FROM strip-thinking.py (any errors?)")
print("══════════════════════════════════════════════")
err_log = "/tmp/session-summary-error.log"
if os.path.exists(err_log):
    print("ERROR LOG EXISTS:", err_log, "size:", os.path.getsize(err_log))
    with open(err_log) as f:
        print(f.read()[-2000:])
else:
    print("no error log at", err_log)

# Last actual cron run output
print("")
print("Look for cron stderr/stdout from strip-thinking.py via syslog (last 30):")
try:
    r = subprocess.run(["bash", "-c", "grep 'CRON' /var/log/syslog 2>/dev/null | grep -i 'strip-thinking' | tail -10"], capture_output=True, text=True, timeout=10)
    print(r.stdout[:1000] or "(empty)")
except Exception: pass

# Try running the function manually right now and capture output
print("")
print("══════════════════════════════════════════════")
print("MANUAL INVOCATION (run hook in current process)")
print("══════════════════════════════════════════════")
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location("strip_thinking", strip)
    mod = importlib.util.module_from_spec(spec)
    # Don't actually load it (would run main block). Just inspect symbols.
    print("(skipping module load — would run main block via top-level code)")
except Exception as e:
    print("import error:", str(e))
`;

async function main() {
  const { data, error } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .in("name", TARGETS);
  if (error || !data) { console.log("DB error:", error?.message); return; }
  for (const v of data as { name: string; ip_address: string; ssh_user: string }[]) {
    if (!v.ip_address) continue;
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`           ${v.name}  (${v.ip_address})`);
    console.log(`══════════════════════════════════════════════`);
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host: v.ip_address, username: v.ssh_user || "openclaw", privateKey: sshKey, readyTimeout: 12_000 });
      // Upload the probe script
      await ssh.execCommand(`mkdir -p /tmp && cat > /tmp/probe-periodic.py << 'PYEOF'
${probePy}
PYEOF`);
      const out = await ssh.execCommand("python3 /tmp/probe-periodic.py 2>&1");
      console.log(out.stdout);
      if (out.stderr) console.log("[stderr]", out.stderr.slice(0, 500));
      await ssh.execCommand("rm -f /tmp/probe-periodic.py");
    } catch (e) {
      console.log("ERR:", (e as Error).message);
    } finally {
      try { ssh.dispose(); } catch {}
    }
  }
}
main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
