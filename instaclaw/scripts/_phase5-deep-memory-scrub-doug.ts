/**
 * Phase 5 — deep memory hygiene scrub on Doug's VM (vm-725).
 *
 * Phase 1 did a minimal scrub of 4 specific phrases. This phase:
 *   - sweeps the broader memory directory (memory/*.md, MEMORY.md, plus any
 *     other memory-related files)
 *   - replaces a wider phrase set
 *   - prepends a single corrective marker (idempotent — won't duplicate)
 *   - verifies zero residue post-scrub
 *
 * Strategy: replace bad phrases with a neutral [scrubbed] tag rather than
 * deleting. Preserves the audit trail and length so the agent's session
 * structure isn't disrupted, but neutralizes the wrong-diagnosis loop.
 */

import { NodeSSH } from "node-ssh";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.production.local"), override: false });

const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const VM_IP = "45.33.74.65";

const SCRUB_PY = `import os, re

# Files to scrub. Includes the standard workspace memory locations and
# any older memory backups (.bak files) so we don't leave residue that
# could be re-read on a workspace-restore path.
PATHS = [
  "~/.openclaw/workspace/MEMORY.md",
  "~/.openclaw/workspace/MEMORY.md.bak",
  "~/.openclaw/workspace/memory/session-log.md",
  "~/.openclaw/workspace/memory/session-log.md.bak",
  "~/.openclaw/workspace/memory/active-tasks.md",
  "~/.openclaw/workspace/memory/active-tasks.md.bak",
  "~/.openclaw/memory/active-tasks.md",
  "~/.openclaw/memory/session-log.md",
]

# Phrases that propagated the wrong diagnosis. Case-insensitive.
PATTERNS = [
  r"VM fork limits",
  r"VM fork limit",
  r"fork limit issues",
  r"VM resource constraints",
  r"VM resource limits",
  r"InstaClaw support restart",
  r"contact InstaClaw support",
  r"needs InstaClaw support",
  r"EAGAIN/core dump errors",
  r"recurring fork limit",
  # Surrounding sentence cleanup that explicitly references the wrong diagnosis
  r"blocked by VM[^.\\n]*",
  r"hitting (?:recurring )?VM[^.\\n]*",
]

REPLACEMENT = "[scrubbed: was-wrong-diagnosis — see 2026-05-07 marker]"
MARKER = "<!-- SCRUBBED 2026-05-07 by InstaClaw: bankr-launch issue resolved by provisioning the InstaClaw-managed wallet. The VM-fork-limits diagnosis was incorrect; the actual issue was missing BANKR_API_KEY in .env. The scrubs below are old session text replaced with this marker so the agent stops re-applying the wrong diagnosis. -->"

changed = []
total_replacements = 0
for raw in PATHS:
  p = os.path.expanduser(raw)
  if not os.path.exists(p):
    continue
  with open(p, "r") as f:
    content = f.read()
  hits_in_file = 0
  for pat in PATTERNS:
    hits_in_file += len(re.findall(pat, content, flags=re.IGNORECASE))
  if hits_in_file == 0 and MARKER in content:
    # already-scrubbed file — no-op
    continue
  if hits_in_file == 0:
    continue
  if MARKER not in content:
    content = MARKER + "\\n\\n" + content
  for pat in PATTERNS:
    content = re.sub(pat, REPLACEMENT, content, flags=re.IGNORECASE)
  with open(p, "w") as f:
    f.write(content)
  changed.append((raw, hits_in_file))
  total_replacements += hits_in_file

# Verify residue: any remaining matches?
residue = 0
sample = []
for raw in PATHS:
  p = os.path.expanduser(raw)
  if not os.path.exists(p):
    continue
  with open(p, "r") as f:
    content = f.read()
  for pat in PATTERNS:
    matches = re.findall(pat, content, flags=re.IGNORECASE)
    residue += len(matches)
    if matches and len(sample) < 5:
      sample.append(f"  {raw}: {matches[0][:80]!r}")

print(f"FILES_CHANGED: {len(changed)}")
print(f"TOTAL_REPLACEMENTS: {total_replacements}")
for path, hits in changed:
  print(f"  CHANGED: {path}  hits={hits}")
print(f"RESIDUE: {residue}")
for s in sample:
  print(f"  RESIDUE_SAMPLE: {s}")
`;

(async () => {
  const ssh = new NodeSSH();
  await ssh.connect({ host: VM_IP, username: "openclaw", privateKey, readyTimeout: 10_000 });
  console.log(`Connected to ${VM_IP} (vm-725).\n`);

  const scrubB64 = Buffer.from(SCRUB_PY, "utf-8").toString("base64");
  const r = await ssh.execCommand(`echo '${scrubB64}' | base64 -d | python3`);
  console.log("--- scrub output ---");
  console.log(r.stdout);
  if (r.stderr) console.error("STDERR:", r.stderr);

  // Sanity-check the new MEMORY.md isn't broken
  const sanity = await ssh.execCommand(
    'wc -c ~/.openclaw/workspace/MEMORY.md ~/.openclaw/workspace/memory/session-log.md 2>&1'
  );
  console.log("--- post-scrub file sizes ---");
  console.log(sanity.stdout);

  ssh.dispose();
})();
