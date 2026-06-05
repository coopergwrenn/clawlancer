#!/usr/bin/env node
/**
 * Frontier canary handler — proves the pay→serve loop end to end. Reads the
 * buyer's request body (DATA, not code) from stdin, returns a deterministic
 * result. Trivial by design: the canary proves the x402 settlement + dispatch,
 * not a real service. Real offerings ship their own handlers under handlers/.
 */
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  let body = {};
  try { body = JSON.parse(input || "{}"); } catch { body = { raw: input.slice(0, 500) }; }
  process.stdout.write(JSON.stringify({
    service: "frontier-canary-echo",
    echoed: body,
    served_at: new Date().toISOString(),
  }));
});
