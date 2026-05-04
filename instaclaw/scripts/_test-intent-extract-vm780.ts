/**
 * End-to-end test of consensus_intent_extract.py against vm-780's real MEMORY.md.
 *
 * Verifies:
 *   - script copies to VM cleanly
 *   - gateway token resolution works
 *   - Haiku call succeeds
 *   - JSON parse + schema validation works
 *   - cold-start gate doesn't false-positive on rich memory
 *   - output is well-formed and useful
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local","/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function main() {
  const ssh = new NodeSSH();
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12_000 });

  console.log("── 1. Copy extractor to vm-780 ──");
  await ssh.putFile(
    "/Users/cooperwrenn/wild-west-bots/instaclaw/scripts/consensus_intent_extract.py",
    "/tmp/consensus_intent_extract.py"
  );
  console.log("  ✓ uploaded");

  console.log("");
  console.log("── 2. MEMORY.md size on vm-780 ──");
  const memCheck = await ssh.execCommand("wc -c ~/.openclaw/workspace/MEMORY.md && wc -l ~/.openclaw/workspace/MEMORY.md");
  console.log("  " + memCheck.stdout.split("\n").join("\n  "));

  console.log("── 3. Gateway token check ──");
  const tokCheck = await ssh.execCommand(
    'grep -c "^GATEWAY_TOKEN=" ~/.openclaw/.env || echo "missing"'
  );
  console.log("  GATEWAY_TOKEN entries: " + tokCheck.stdout.trim());

  console.log("");
  console.log("── 4. Run extractor (this hits real Haiku) ──");
  console.log("    note: routed via instaclaw.io gateway proxy; user pays from credits");
  const start = Date.now();
  const out = await ssh.execCommand("python3 /tmp/consensus_intent_extract.py");
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`  latency: ${elapsed}s`);
  console.log("");
  console.log("── stderr (telemetry from script) ──");
  console.log(out.stderr || "(none)");
  console.log("");
  console.log("── stdout (the extracted JSON) ──");
  console.log(out.stdout);

  // Bonus diagnostic: ALSO directly call Haiku with a known-simple prompt
  // to confirm gateway path works at all
  console.log("");
  console.log("── 4b. Direct gateway-proxy probe (sanity check) ──");
  const probe = await ssh.execCommand(String.raw`
TOKEN=$(grep "^GATEWAY_TOKEN=" ~/.openclaw/.env | cut -d= -f2 | tr -d '"' | tr -d "'")
curl -s -m 15 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-model-override: claude-haiku-4-5-20251001" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"messages":[{"role":"user","content":"Reply with the literal text: PROBE_OK"}]}' \
  https://instaclaw.io/api/gateway/proxy
`);
  console.log("  raw response (first 500 chars):");
  console.log("  " + probe.stdout.slice(0, 500).replace(/\n/g, "\n  "));

  // Try to parse + validate the extracted JSON
  console.log("");
  console.log("── 5. Schema validation (host-side) ──");
  try {
    const parsed = JSON.parse(out.stdout);
    const checks: Array<[string, boolean]> = [
      ["offering_summary present + non-empty", typeof parsed.offering_summary === "string" && parsed.offering_summary.trim().length > 0],
      ["seeking_summary present + non-empty", typeof parsed.seeking_summary === "string" && parsed.seeking_summary.trim().length > 0],
      ["interests is array of strings", Array.isArray(parsed.interests) && parsed.interests.every((x: unknown) => typeof x === "string")],
      ["looking_for is array of strings", Array.isArray(parsed.looking_for) && parsed.looking_for.every((x: unknown) => typeof x === "string")],
      ["format_preferences is array of valid values", Array.isArray(parsed.format_preferences) && parsed.format_preferences.every((x: unknown) => ["1on1", "small_group", "session"].includes(x as string))],
      ["confidence is number in [0,1]", typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1],
    ];
    let pass = 0;
    for (const [name, ok] of checks) {
      console.log(`  ${ok ? "✓" : "✗"} ${name}`);
      if (ok) pass++;
    }
    console.log("");
    console.log(`══ Schema: ${pass}/${checks.length} passed ══`);

    // Voice + quality smell-test
    console.log("");
    console.log("── 6. Voice / quality smell-test ──");
    const fluff = ["passionate about", "leveraging", "synergies", "navigating the landscape", "ecosystem", "innovating", "seamless", "robust", "scalable"];
    const both = (parsed.offering_summary + " " + parsed.seeking_summary).toLowerCase();
    let foundFluff = false;
    for (const f of fluff) {
      if (both.includes(f)) {
        console.log(`  ✗ found banned phrase: "${f}"`);
        foundFluff = true;
      }
    }
    if (!foundFluff) console.log("  ✓ no AI-flavored fluff phrases");
    if (parsed.offering_summary.match(/^(the user|they|this person)/i)) {
      console.log("  ✗ offering_summary in third person (should be first-person)");
    } else {
      console.log("  ✓ offering_summary appears first-person");
    }
    console.log(`  · offering: ${parsed.offering_summary.length} chars`);
    console.log(`  · seeking:  ${parsed.seeking_summary.length} chars`);
    console.log(`  · interests: [${parsed.interests.slice(0, 8).join(", ")}]`);
    console.log(`  · looking_for: [${parsed.looking_for.join(", ")}]`);
    console.log(`  · confidence: ${parsed.confidence}`);
  } catch (e) {
    console.log("  ✗ JSON parse failed:", e instanceof Error ? e.message : e);
  }

  // Cleanup
  await ssh.execCommand("rm -f /tmp/consensus_intent_extract.py");
  ssh.dispose();
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
