/**
 * Pull SILENCE_WATCHDOG_SCRIPT out of vm-manifest, write to a temp file,
 * and run python3 -m py_compile on it to confirm syntactic validity.
 */
import { SILENCE_WATCHDOG_SCRIPT } from "../lib/vm-manifest.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

const tmp = path.join(os.tmpdir(), `silence-watchdog-${Date.now()}.py`);
fs.writeFileSync(tmp, SILENCE_WATCHDOG_SCRIPT);
console.log(`wrote ${tmp} (${SILENCE_WATCHDOG_SCRIPT.length} chars)`);

try {
  execSync(`python3 -m py_compile ${tmp}`, { stdio: "inherit" });
  console.log("✅ python3 -m py_compile: OK");
} catch (e) {
  console.error("❌ python compile failed");
  process.exit(1);
}

// Quick sanity grep for the new symbols
for (const sym of ["get_telegram_session_info", 'origin.get("provider") != "telegram"', "get_latest_session_timing(session_file=None)"]) {
  if (!SILENCE_WATCHDOG_SCRIPT.includes(sym)) {
    console.error(`❌ missing expected symbol in script: ${sym}`);
    process.exit(1);
  }
}
console.log("✅ expected symbols present");

fs.unlinkSync(tmp);
