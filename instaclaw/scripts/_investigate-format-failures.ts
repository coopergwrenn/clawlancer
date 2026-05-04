/**
 * Investigate "reason=format" Sonnet candidate failures on vm-748.
 *
 * Goal: understand what's actually happening when the model-fallback
 * orchestrator decides "incomplete terminal response".  Hypotheses:
 *   - tool-only termination (model emitted tool_use, no terminal text)
 *   - empty content / refusal
 *   - 400 from Anthropic with "messages: at least one message is required"
 *     (we already saw one of these in vm-867)
 *   - mid-stream truncation
 *   - context-window pressure (>200KB session, big SOUL.md, etc)
 *
 * Approach:
 *   1. Pull the 24h journal.
 *   2. For every `reason=format` line, capture ±15 lines of surrounding
 *      context (so we get the embedded run init, the user message preview,
 *      tool calls, etc).
 *   3. For 5 representative failures, also pull session.jsonl tail and
 *      report file size, line count, last 3 events.
 *   4. List session files by size (which chat is heaviest?).
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

const TARGETS = ["instaclaw-vm-748", "instaclaw-vm-867", "instaclaw-vm-855", "instaclaw-vm-725", "instaclaw-vm-linode-06"];

async function main() {
  const { data, error } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .in("name", TARGETS);
  if (error || !data) { console.log("DB error:", error?.message); return; }

  const probeScript = String.raw`
LOG=/tmp/oc-24h.log
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null > $LOG

echo "══════ FORMAT FAILURE BREAKDOWN ══════"
echo ""
echo "── all 'reason=format' lines (deduped by detail) ──"
grep 'reason=format' $LOG | sed -E 's/^[^[]*\[/[/' | head -40
echo ""

echo "── distinct 'reason=format' detail strings (top 10 by count) ──"
grep 'reason=format' $LOG | sed -E 's/.*detail=//' | sort | uniq -c | sort -rn | head -10
echo ""

echo "── distinct rawError 'message' values (probable Anthropic API errors) ──"
grep 'reason=format' $LOG | grep -oE 'message":"[^"]*"' | sort | uniq -c | sort -rn | head -10
echo ""

echo "── 5 sample format failures with ±10 lines of context ──"
for ts in $(grep 'reason=format' $LOG | head -5 | awk '{print $1" "$2" "$3}'); do
  echo "[no-op marker]"
done
# Extract by line number
grep -n 'reason=format' $LOG | head -5 | while IFS=: read lineno _; do
  echo ""
  echo "──── failure @ line $lineno ────"
  start=$((lineno - 10))
  end=$((lineno + 5))
  if [ $start -lt 1 ]; then start=1; fi
  sed -n "$start,$end p" $LOG | sed -E 's/^[^[]*node\[[0-9]+\]: //' | cut -c1-300
done

echo ""
echo "══════ SESSION FILE SIZES ══════"
echo ""
ls -la ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | sort -k5 -rn | head -10 | awk '{print $5"\t"$9}'
echo ""
echo "── total sessions: $(ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l) ──"
echo "── session.json index size: $(stat -c %s ~/.openclaw/agents/main/sessions.json 2>/dev/null) ──"
echo ""

echo "══════ LARGEST SESSION FILE — last 3 message types ══════"
LARGEST=$(ls -S ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -1)
if [ -n "$LARGEST" ]; then
  echo "file: $LARGEST"
  echo "size: $(stat -c %s "$LARGEST") bytes"
  echo "lines: $(wc -l < "$LARGEST")"
  echo "── last 3 entries (truncated to 200 chars) ──"
  tail -3 "$LARGEST" | python3 -c '
import sys, json
for line in sys.stdin:
  try:
    o = json.loads(line)
    role = o.get("type") or o.get("role") or "?"
    content = o.get("message", {}).get("content") if "message" in o else o.get("content")
    s = json.dumps(content)[:300] if content else "(empty)"
    print(f"  {role}: {s}")
  except Exception as e:
    print(f"  PARSE_ERR: {str(e)[:80]}")
' 2>/dev/null || echo "(python parse failed)"
fi

echo ""
echo "══════ BOOTSTRAP CONTEXT ON DISK (size pressure?) ══════"
echo "── SOUL.md ──"
wc -c ~/.openclaw/workspace/SOUL.md 2>/dev/null
echo "── CAPABILITIES.md ──"
wc -c ~/.openclaw/workspace/CAPABILITIES.md 2>/dev/null
echo "── TOOLS.md ──"
wc -c ~/.openclaw/workspace/TOOLS.md 2>/dev/null
echo "── MEMORY.md ──"
wc -c ~/.openclaw/workspace/MEMORY.md 2>/dev/null
echo "── EARN.md ──"
wc -c ~/.openclaw/workspace/EARN.md 2>/dev/null
echo "── all skills SKILL.md ──"
find ~/.openclaw/skills -name SKILL.md 2>/dev/null | xargs wc -c 2>/dev/null | tail -1
echo ""

echo "══════ BOOTSTRAP MAX CHARS CONFIG ══════"
grep -E '"bootstrapMaxChars|"timeoutSeconds' ~/.openclaw/openclaw.json 2>/dev/null

rm -f $LOG
`;

  for (const v of data as { name: string; ip_address: string; ssh_user: string }[]) {
    if (!v.ip_address) continue;
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`           ${v.name}  (${v.ip_address})`);
    console.log(`══════════════════════════════════════════════`);
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host: v.ip_address, username: v.ssh_user || "openclaw", privateKey: sshKey, readyTimeout: 12_000 });
      const out = await ssh.execCommand(probeScript);
      console.log(out.stdout);
      if (out.stderr) console.log("[stderr]", out.stderr.slice(0, 600));
    } catch (e) {
      console.log("ERR:", (e as Error).message);
    } finally {
      try { ssh.dispose(); } catch {}
    }
  }
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
