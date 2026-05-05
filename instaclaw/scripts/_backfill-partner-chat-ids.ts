/**
 * Backfill telegram_chat_id for the 5 Consensus 2026 partner VMs.
 *
 * The partner cohort signed up via /edge-city or /consensus and many
 * have never DM'd their bot via Telegram, so their telegram_chat_id
 * column is NULL. Without it, the receiver-side notify_user.sh path
 * can't discover where to send Telegram intros, and intros fall through
 * to the pending-intros.jsonl recovery path. That's not real-time.
 *
 * For each partner VM:
 *   1. SSH and read the bot token (openclaw.json: channels.telegram.botToken)
 *   2. Call Telegram getUpdates to look for any private-chat the bot
 *      has had recent traffic with
 *   3. ALSO check ~/.openclaw/agents/main/sessions/sessions.json for
 *      a `telegram:<chat_id>` origin entry (long-lived even after
 *      getUpdates' 24h retention)
 *   4. Write the discovered chat_id to instaclaw_vms.telegram_chat_id
 *   5. Per-VM report: discovered? from where? written?
 *
 * Idempotent — re-running with already-populated rows is a no-op.
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TARGET_PARTNERS = ["edge_city", "consensus_2026"];

interface VM {
  id: string;
  name: string;
  ip_address: string;
  ssh_user: string | null;
  partner: string;
  telegram_chat_id: string | null;
  telegram_bot_username: string | null;
}

interface Result {
  name: string;
  bot_username: string | null;
  pre_chat_id: string | null;
  source: "getUpdates" | "sessions.json" | "already_set" | "none";
  new_chat_id: string | null;
  written: boolean;
  detail?: string;
}

async function discoverChatIdForVM(vm: VM): Promise<Result> {
  const result: Result = {
    name: vm.name,
    bot_username: vm.telegram_bot_username,
    pre_chat_id: vm.telegram_chat_id,
    source: "none",
    new_chat_id: null,
    written: false,
  };

  if (vm.telegram_chat_id) {
    result.source = "already_set";
    result.new_chat_id = vm.telegram_chat_id;
    return result;
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: vm.ssh_user || "openclaw",
      privateKey: sshKey,
      readyTimeout: 12000,
    });

    // 1. Read bot token from openclaw.json
    const tokenCmd = await ssh.execCommand(
      `python3 -c "import json; d = json.load(open('/home/openclaw/.openclaw/openclaw.json')); print(d.get('channels', {}).get('telegram', {}).get('botToken', ''))" 2>/dev/null`,
    );
    const botToken = tokenCmd.stdout.trim();
    if (!botToken) {
      result.detail = "no botToken in openclaw.json";
      return result;
    }

    // 2. Try getUpdates first (most recent private chat). The Telegram
    //    API caches updates for ~24h. If the bot is in long-poll mode
    //    by the gateway, getUpdates may return [] because the gateway
    //    has already consumed the queue — we fall through to step 3.
    const guCmd = await ssh.execCommand(
      `curl -s --max-time 10 "https://api.telegram.org/bot${botToken}/getUpdates?timeout=0&limit=20" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if data.get('ok') and data.get('result'):
        # Iterate from most recent backward
        for u in reversed(data['result']):
            chat = (u.get('message') or u.get('edited_message') or {}).get('chat')
            if chat and chat.get('type') == 'private':
                print(chat['id']); sys.exit(0)
        # Any private chat in any update
        for u in data['result']:
            chat = (u.get('message') or u.get('edited_message') or {}).get('chat')
            if chat and chat.get('type') == 'private':
                print(chat['id']); sys.exit(0)
except Exception as e:
    sys.stderr.write(f'parse error: {e}\\n')
" 2>/dev/null`,
    );
    const fromGetUpdates = guCmd.stdout.trim();
    if (fromGetUpdates && /^-?\d+$/.test(fromGetUpdates)) {
      result.source = "getUpdates";
      result.new_chat_id = fromGetUpdates;
    }

    // 3. Fall back to sessions.json (origin: "telegram:<chat_id>")
    if (!result.new_chat_id) {
      const sessCmd = await ssh.execCommand(
        `python3 -c "
import json, sys, re, os
p = os.path.expanduser('~/.openclaw/agents/main/sessions/sessions.json')
if not os.path.isfile(p):
    sys.exit(0)
try:
    d = json.load(open(p))
    for k, v in (d or {}).items():
        origin = (v or {}).get('origin', {}) or {}
        f = origin.get('from', '') or v.get('lastTo', '')
        m = re.search(r'telegram:(\\d+)', f)
        if m:
            print(m.group(1)); sys.exit(0)
except Exception as e:
    sys.stderr.write(f'parse error: {e}\\n')
" 2>/dev/null`,
      );
      const fromSessions = sessCmd.stdout.trim();
      if (fromSessions && /^-?\d+$/.test(fromSessions)) {
        result.source = "sessions.json";
        result.new_chat_id = fromSessions;
      }
    }

    // 4. Fall back to notification-log.jsonl — past successful
    //    notify_user.sh runs append a row with the resolved chat_id.
    //    If the user has EVER been Telegram-notified, this finds it.
    //    More resilient than getUpdates (24h retention) and
    //    sessions.json (origin format may not include `telegram:`).
    if (!result.new_chat_id) {
      const logCmd = await ssh.execCommand(
        `python3 -c "
import json, sys, os
p = os.path.expanduser('~/.openclaw/workspace/notification-log.jsonl')
if not os.path.isfile(p):
    sys.exit(0)
try:
    last = None
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                cid = row.get('chat_id')
                if cid:
                    last = str(cid)
            except Exception:
                continue
    if last:
        print(last)
except Exception as e:
    sys.stderr.write(f'parse error: {e}\\n')
" 2>/dev/null`,
      );
      const fromLog = logCmd.stdout.trim();
      if (fromLog && /^-?\d+$/.test(fromLog)) {
        result.source = "notification-log";
        result.new_chat_id = fromLog;
      }
    }

    if (!result.new_chat_id) {
      result.detail = "no chat_id discoverable (user may have never DM'd the bot)";
      return result;
    }

    // 4. Smoke-test the chat_id by sending a no-op getChat call. If the
    //    bot doesn't have access to that chat, the API returns 400. We
    //    refuse to write a chat_id that fails this check.
    const verifyCmd = await ssh.execCommand(
      `curl -s --max-time 8 "https://api.telegram.org/bot${botToken}/getChat?chat_id=${result.new_chat_id}" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print('OK' if data.get('ok') else f\\\"FAIL: {data.get('description', 'unknown')}\\\")
except Exception as e:
    print(f'PARSE_FAIL: {e}')
" 2>/dev/null`,
    );
    const verify = verifyCmd.stdout.trim();
    if (!verify.startsWith("OK")) {
      result.detail = `getChat verify failed: ${verify}`;
      result.new_chat_id = null;
      return result;
    }

    // 5. Write to DB
    const { error: updErr } = await sb
      .from("instaclaw_vms")
      .update({ telegram_chat_id: result.new_chat_id })
      .eq("id", vm.id);
    if (updErr) {
      result.detail = `db update failed: ${updErr.message}`;
      return result;
    }
    result.written = true;
    return result;
  } catch (e) {
    result.detail = e instanceof Error ? e.message : String(e);
    return result;
  } finally {
    ssh.dispose();
  }
}

async function main() {
  console.log("══ Backfill telegram_chat_id on partner VMs ══\n");

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_user, partner, telegram_chat_id, telegram_bot_username")
    .in("partner", TARGET_PARTNERS)
    .eq("health_status", "healthy")
    .order("name");

  if (error) throw new Error(`vm query: ${error.message}`);
  if (!vms || vms.length === 0) {
    console.log("No partner VMs found.");
    process.exit(0);
  }

  console.log(`Target VMs: ${vms.length}`);
  for (const v of vms) console.log(`  ${v.name} (${v.partner}) bot=@${v.telegram_bot_username || "?"} pre=${v.telegram_chat_id ? "Y" : "N"}`);
  console.log("");

  const results: Result[] = [];
  for (const v of vms as VM[]) {
    const r = await discoverChatIdForVM(v);
    const tag = r.written ? "✓" : (r.source === "already_set" ? "·" : "✗");
    console.log(`  ${tag} ${r.name.padEnd(22)} source=${r.source} chat_id=${r.new_chat_id || "—"}${r.detail ? ` (${r.detail})` : ""}`);
    results.push(r);
  }

  const wrote = results.filter((r) => r.written).length;
  const already = results.filter((r) => r.source === "already_set").length;
  const missing = results.filter((r) => !r.new_chat_id).length;

  console.log(`\n══ ${wrote} written, ${already} already-set, ${missing} undiscoverable ══`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
