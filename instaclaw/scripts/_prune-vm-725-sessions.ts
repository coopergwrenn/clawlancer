/**
 * Prune vm-725's sessions.json (currently 2.6MB; 49 entries × ~43KB each).
 *
 * Bloat source: every entry caches a ~43KB `skillsSnapshot.prompt` field
 * containing the full skill manifest. Duplicated 49 times.
 *
 * Strategy (Rule 22 spirit — trim, never nuke):
 *   1. Backup sessions.json to ~/.openclaw/session-backups/sessions-<ts>.json
 *   2. Read in Python, partition by status:
 *        - "active": KEEP ALL (agent might resume)
 *        - everything else: keep top 20 by updatedAt
 *   3. Atomic write via tmp + os.replace
 *   4. Verify size dropped and JSON parseable
 *
 * Idempotent — safe to re-run. Reports before/after sizes.
 */
import { readFileSync } from "fs";
import { connectSSH } from "../lib/ssh";
import { createClient } from "@supabase/supabase-js";

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

const PRUNE_SCRIPT = `python3 - <<'PYEOF'
import json
import os
import shutil
from datetime import datetime, timezone

PATH = '/home/openclaw/.openclaw/agents/main/sessions/sessions.json'
BACKUP_DIR = '/home/openclaw/.openclaw/session-backups'
KEEP_RECENT_NON_ACTIVE = 20

os.makedirs(BACKUP_DIR, exist_ok=True)
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')
backup = os.path.join(BACKUP_DIR, f'sessions-{stamp}.json')

# Read original
size_before = os.path.getsize(PATH)
with open(PATH, 'r') as f:
    data = json.load(f)
entries_before = len(data) if isinstance(data, dict) else 0

# Backup ORIGINAL atomically (cp)
shutil.copy2(PATH, backup)
print(f'BACKUP_WRITTEN: {backup} ({size_before} bytes)')

# Partition
active = {}
non_active = []  # list of (key, entry, updatedAt)
for k, v in data.items():
    if not isinstance(v, dict):
        active[k] = v  # preserve unknown structures
        continue
    status = v.get('status', 'unknown')
    if status == 'active':
        active[k] = v
    else:
        ts = v.get('updatedAt') or v.get('lastInteractionAt') or v.get('endedAt') or 0
        non_active.append((k, v, ts))

# Sort non-active by updatedAt desc, keep top N
non_active.sort(key=lambda x: x[2], reverse=True)
kept_non_active = non_active[:KEEP_RECENT_NON_ACTIVE]
dropped_non_active = non_active[KEEP_RECENT_NON_ACTIVE:]

# Build pruned dict
pruned = dict(active)
for k, v, _ in kept_non_active:
    pruned[k] = v

print(f'PARTITION: active={len(active)} kept_non_active={len(kept_non_active)} dropped={len(dropped_non_active)}')

# Atomic write
tmp = PATH + '.tmp'
with open(tmp, 'w') as f:
    json.dump(pruned, f, indent=2)
os.replace(tmp, PATH)

size_after = os.path.getsize(PATH)
print(f'SIZE_BEFORE: {size_before} bytes')
print(f'SIZE_AFTER:  {size_after} bytes')
print(f'REDUCTION:   {size_before - size_after} bytes ({100 * (size_before - size_after) / size_before:.1f}%)')
print(f'ENTRIES_BEFORE: {entries_before}')
print(f'ENTRIES_AFTER:  {len(pruned)}')

# Re-validate
with open(PATH, 'r') as f:
    json.load(f)
print('VERIFY: re-read parses cleanly')
PYEOF
echo === POST-WRITE FILE STATE ===
ls -la /home/openclaw/.openclaw/agents/main/sessions/sessions.json
echo === LATEST BACKUP ===
ls -la /home/openclaw/.openclaw/session-backups/sessions-*.json 2>/dev/null | tail -3
`;

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-725").single();
  if (!vm) { console.error("not found"); process.exit(1); }
  console.log(`Target: ${vm.name} (Doug)\n`);

  const ssh = await connectSSH(vm as any);
  try {
    const r = await ssh.execCommand(PRUNE_SCRIPT, { execOptions: { pty: false } });
    console.log(r.stdout);
    if (r.stderr) console.log("\nstderr:", r.stderr.slice(0, 500));
    if (r.code !== 0) {
      console.log(`✗ exit code ${r.code} — investigate`);
      process.exit(1);
    }
    console.log("\n✓ Prune successful");
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
