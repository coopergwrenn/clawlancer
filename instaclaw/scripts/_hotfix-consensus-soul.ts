/**
 * Hotfix: replace the Consensus SOUL section with a stronger, directive
 * version that forbids web_fetch and explicitly enumerates the question
 * types that must use the on-disk skill.
 *
 * Triggered by the 2026-05-02 vm-780 incident where the agent web-fetched
 * cryptonomads.org for an "AI itinerary" prompt instead of reading the
 * on-disk sessions.json, then crashed when the 403 response confused the
 * model into an empty-response failure.
 *
 * Behavior: removes the prior "## Consensus 2026 Miami" section (matched
 * by marker → end of SOUL.md OR next "## " header) and appends the new
 * one. Idempotent.
 */
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });
import { NodeSSH } from "node-ssh";

const SOUL_PATH = "$HOME/.openclaw/workspace/SOUL.md";
const MARKER = "## Consensus 2026 Miami";

// New directive — stronger language, explicit web_fetch ban, enumerated
// question types so the agent can't talk itself into web search.
// Hard cap: must remain ≤500 chars per CLAUDE.md skill size budget.
const NEW_BLOCK = `

## Consensus 2026 Miami

Your human is at Consensus 2026 (Miami Beach Convention Center, May 5–7). For ANY question about conference sessions, talks, panels, speakers, side events, parties, dinners, networking, "AI track", "where's X happening", "what's at 2pm", or "free food" — read ~/.openclaw/skills/consensus-2026/SKILL.md FIRST. All data (326 sessions, 219 side events, 451 speakers) is local. NEVER web_fetch for this; the answer is on disk.
`;

const args = process.argv.slice(2);
const TARGET_IP = args.find((a) => a.startsWith("--ip="))?.slice(5);
if (!TARGET_IP) {
  console.error("Usage: _hotfix-consensus-soul.ts --ip=<addr>");
  process.exit(1);
}

async function main(): Promise<void> {
  const sshKeyB64 = process.env.SSH_PRIVATE_KEY_B64;
  if (!sshKeyB64) throw new Error("SSH_PRIVATE_KEY_B64 not set");
  const sshKey = Buffer.from(sshKeyB64, "base64").toString("utf-8");

  console.log(`[hotfix] new SOUL section: ${NEW_BLOCK.length} chars`);
  if (NEW_BLOCK.length > 500) throw new Error("New SOUL block exceeds 500-char budget");

  const ssh = new NodeSSH();
  console.log(`[ssh] connecting to ${TARGET_IP}…`);
  try {
    await ssh.connect({ host: TARGET_IP!, username: "openclaw", privateKey: sshKey, readyTimeout: 15_000 });
  } catch {
    await ssh.connect({ host: TARGET_IP!, username: "root", privateKey: sshKey, readyTimeout: 15_000 });
  }

  // Strategy: pull SOUL.md, mutate locally, push back atomically.
  // Atomic write: stage to .tmp then mv. Avoids partial-write hazard.
  console.log("[ssh] reading current SOUL.md…");
  const cat = await ssh.execCommand(`cat ${SOUL_PATH}`);
  if (cat.code !== 0) throw new Error(`SOUL.md read failed: ${cat.stderr}`);
  const original = cat.stdout;
  const beforeBytes = Buffer.byteLength(original, "utf-8");
  console.log(`[ssh] SOUL.md is ${beforeBytes} bytes`);

  // Find marker, splice out everything from marker to end OR next "## " header.
  let mutated: string;
  const markerIdx = original.indexOf(MARKER);
  if (markerIdx === -1) {
    console.log("[hotfix] no existing Consensus marker — appending fresh");
    mutated = original.replace(/\s*$/, "") + NEW_BLOCK;
  } else {
    // Walk forward from marker to find next "\n## " (sibling heading) OR end of file.
    const tail = original.slice(markerIdx);
    const nextHeader = tail.search(/\n## (?!Consensus 2026)/);
    let endOfSection: number;
    if (nextHeader === -1) {
      endOfSection = original.length;
      console.log("[hotfix] existing Consensus section runs to EOF");
    } else {
      endOfSection = markerIdx + nextHeader;
      console.log(`[hotfix] existing Consensus section ends before next header at offset ${endOfSection}`);
    }
    const before = original.slice(0, markerIdx).replace(/\s*$/, "");
    const after = original.slice(endOfSection);
    mutated = before + NEW_BLOCK + after;
  }

  const afterBytes = Buffer.byteLength(mutated, "utf-8");
  console.log(`[hotfix] new SOUL.md will be ${afterBytes} bytes (delta ${afterBytes - beforeBytes})`);

  // Atomic write via base64 → tmp → mv
  const b64 = Buffer.from(mutated, "utf-8").toString("base64");
  const writeRes = await ssh.execCommand(
    `echo '${b64}' | base64 -d > ${SOUL_PATH}.tmp && mv ${SOUL_PATH}.tmp ${SOUL_PATH}`,
  );
  if (writeRes.code !== 0) {
    console.error(`STDERR: ${writeRes.stderr}`);
    throw new Error("Atomic write failed");
  }

  // Verify on disk
  const verify = await ssh.execCommand(
    `wc -c < ${SOUL_PATH} && echo --- && grep -c "${MARKER}" ${SOUL_PATH} && echo --- && grep -c "NEVER web_fetch" ${SOUL_PATH}`,
  );
  console.log("[verify] (size, marker count, directive count):");
  console.log(verify.stdout.split("\n").map((l) => "  " + l).join("\n"));

  ssh.dispose();
  console.log(`\n${"=".repeat(60)}\nHotfix applied to ${TARGET_IP}.\n${"=".repeat(60)}`);
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
