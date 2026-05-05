/**
 * Read-only inspection of vm-725's sessions.json before designing a prune.
 * Collects: total size, entry count, top entries by size, oldest/newest by
 * any timestamp field present, key shapes.
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

const PROBE = `set +e
echo === FILE SIZE ===
ls -la ~/.openclaw/agents/main/sessions/sessions.json 2>&1 | head -1
echo === TOP-LEVEL SHAPE ===
python3 -c "
import json, sys
d = json.load(open('/home/openclaw/.openclaw/agents/main/sessions/sessions.json'))
print('top_level_type=' + type(d).__name__)
if isinstance(d, dict):
    print('top_level_keys=' + ','.join(list(d.keys())[:5]) + (' ...' if len(d) > 5 else ''))
    print('top_level_count=' + str(len(d)))
    # If it's a dict with session-like values, sample one
    if d:
        first_k = next(iter(d))
        first_v = d[first_k]
        print('sample_key=' + str(first_k)[:40])
        print('sample_value_type=' + type(first_v).__name__)
        if isinstance(first_v, dict):
            print('sample_value_keys=' + ','.join(list(first_v.keys())[:10]))
            for k in list(first_v.keys())[:8]:
                v = first_v[k]
                vstr = str(v)[:60].replace(chr(10), ' ')
                print('  ' + k + ' = ' + vstr)
elif isinstance(d, list):
    print('top_level_count=' + str(len(d)))
    if d:
        print('sample_first=' + str(d[0])[:200])
" 2>&1
echo === ENTRY SIZE DISTRIBUTION ===
python3 -c "
import json, sys
d = json.load(open('/home/openclaw/.openclaw/agents/main/sessions/sessions.json'))
if isinstance(d, dict):
    items = list(d.items())
elif isinstance(d, list):
    items = list(enumerate(d))
else:
    print('not dict or list')
    sys.exit()
# Compute serialized size per entry
sized = [(k, len(json.dumps(v))) for k, v in items]
sized.sort(key=lambda x: -x[1])
print('total_entries=' + str(len(sized)))
print('avg_entry_bytes=' + str(sum(s for _, s in sized) // max(1, len(sized))))
print('top_5_largest:')
for k, s in sized[:5]:
    print('  ' + str(k)[:40] + ' = ' + str(s) + ' bytes')
print('size_buckets:')
buckets = {'<100': 0, '100-1k': 0, '1k-10k': 0, '10k-100k': 0, '>100k': 0}
for _, s in sized:
    if s < 100: buckets['<100'] += 1
    elif s < 1000: buckets['100-1k'] += 1
    elif s < 10000: buckets['1k-10k'] += 1
    elif s < 100000: buckets['10k-100k'] += 1
    else: buckets['>100k'] += 1
for k, v in buckets.items():
    print('  ' + k + ': ' + str(v))
" 2>&1
echo === TIMESTAMP/ACTIVITY ANALYSIS ===
python3 -c "
import json
from datetime import datetime, timezone
d = json.load(open('/home/openclaw/.openclaw/agents/main/sessions/sessions.json'))
items = list(d.items()) if isinstance(d, dict) else list(enumerate(d))
# Look for any timestamp-like field
ts_fields = ['lastActivity', 'last_activity', 'updatedAt', 'updated_at', 'createdAt', 'created_at', 'lastModifiedAt', 'lastWriteAt', 'lastTurnAt', 'lastUpdated', 'mtime']
ts_field_used = None
for k, v in items[:20]:
    if isinstance(v, dict):
        for f in ts_fields:
            if f in v:
                ts_field_used = f
                break
        if ts_field_used:
            break
print('timestamp_field_detected=' + str(ts_field_used))
if ts_field_used:
    times = []
    for k, v in items:
        if isinstance(v, dict) and ts_field_used in v:
            t = v[ts_field_used]
            if isinstance(t, (int, float)):
                times.append((k, t))
            elif isinstance(t, str):
                try:
                    parsed = datetime.fromisoformat(t.replace('Z', '+00:00'))
                    times.append((k, parsed.timestamp()))
                except:
                    pass
    if times:
        times.sort(key=lambda x: x[1])
        print('with_timestamp_count=' + str(len(times)))
        oldest = datetime.fromtimestamp(times[0][1], tz=timezone.utc)
        newest = datetime.fromtimestamp(times[-1][1], tz=timezone.utc)
        print('oldest_entry=' + oldest.isoformat())
        print('newest_entry=' + newest.isoformat())
        # Bucket by age
        now = datetime.now(timezone.utc).timestamp()
        buckets = {'<1d': 0, '1-7d': 0, '7-30d': 0, '30-90d': 0, '>90d': 0}
        for k, t in times:
            age_d = (now - t) / 86400
            if age_d < 1: buckets['<1d'] += 1
            elif age_d < 7: buckets['1-7d'] += 1
            elif age_d < 30: buckets['7-30d'] += 1
            elif age_d < 90: buckets['30-90d'] += 1
            else: buckets['>90d'] += 1
        print('age_buckets:')
        for k, v in buckets.items():
            print('  ' + k + ': ' + str(v))
" 2>&1
`;

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-725").single();
  const ssh = await connectSSH(vm as any);
  try {
    const r = await ssh.execCommand(PROBE, { execOptions: { pty: false } });
    console.log(r.stdout);
    if (r.stderr) console.log("\nstderr:", r.stderr.slice(0, 500));
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
