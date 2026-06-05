#!/usr/bin/env node
/**
 * Frontier earn server — the per-VM x402 SELL server (§6.1.1). Thin I/O shell
 * over x402-server-core.mjs; the wire schema (verify/settle) is delegated to
 * @x402/core's HTTPFacilitatorClient (schema-correct, the same package the buyer
 * speaks), pointed at OUR facilitator proxy. The SECURITY ORDERING is owned here,
 * not the middleware's default:
 *
 *   POST /v1/<slug>:
 *     1. privacy gate (Rule 22)            → 503 if privacy mode on
 *     2. resolve offering from cache       → 404 if unknown/inactive (serve-stale ok)
 *     3. no X-PAYMENT                      → 402 + accepts[] (PaymentRequirements)
 *     4. read + size-check body            → 413 if >256KB (validate input BEFORE money;
 *                                            verify never reads it, so this is safe + cheap-first)
 *     5. verify(payload, requirements)     → 502 throw / 402 if !isValid
 *     6. idempotency claim(nonce, slug)    → 409 if duplicate (Attack II, concurrency gate)
 *     7. settle(payload, requirements)     → release+502/402 on fail; commit on success
 *                                            (settle-BEFORE-serve, Attack I-A)
 *     8. run handler (timeout + caps)      → 200 result + tx hash, Cache-Control:no-store (Attack III)
 *
 * payTo is env-only (never request — x402 V2 redirection guard). The handler_path
 * is re-validated against the allow-list before exec (defense in depth). The
 * server holds NO signing key (the BUYER signs via Bankr); it only has a public
 * payTo + the proxy secret. Non-blocking per Rule 62 (async http + spawned handler).
 *
 * Env: BANKR_WALLET_ADDRESS, X402_PROXY_SECRET, X402_FACILITATOR_URL,
 *      GATEWAY_TOKEN, INSTACLAW_APP_URL, X402_SERVER_PORT (default 8402),
 *      X402_NETWORK (default "eip155:8453", CAIP-2), X402_USDC_ASSET (Base USDC default).
 *
 * Start-closed: bind is irrelevant to exposure — iptables restricts ingress to the
 * buyer VM IP (deploy step), persisted via netfilter-persistent. Fleet follow-ups
 * (NOT here): full systemd sandbox battery, per-handler rlimit/systemd-run jail,
 * durable idempotency store, per-VM proxy secret (W9), audit-log infra.
 */
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { HTTPFacilitatorClient } from "@x402/core/http";
import {
  resolvePayTo,
  isPrivacyOn,
  validateHandlerPath,
  buildPaymentRequirements,
  buildHandlerEnv,
  buildHandlerSandboxArgs,
  IdempotencyStore,
  OfferingsCache,
} from "./x402-server-core.mjs";

const PORT = Number(process.env.X402_SERVER_PORT || 8402);
const APP = (process.env.INSTACLAW_APP_URL || "https://instaclaw.io").replace(/\/$/, "");
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || `${APP}/api/x402/facilitator`;
const PROXY_SECRET = process.env.X402_PROXY_SECRET || "";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const NETWORK = process.env.X402_NETWORK || "eip155:8453"; // CAIP-2 — x402 v2 + CDP require it (NOT "base")
const USDC_ASSET = process.env.X402_USDC_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const HOME = process.env.HOME || "";
const OFFERINGS_FILE = `${HOME}/.openclaw/workspace/frontier-offerings.json`;
const PRIVACY_FILE = `${HOME}/.openclaw/.privacy-state`;
const REFRESH_MS = 60_000;
const HANDLER_TIMEOUT_MS = 20_000;
const HANDLER_OUTPUT_CAP = 256 * 1024; // 256KB
const BODY_CAP = 256 * 1024;

// Handler exec (🟡-1): absolute interpreter paths (deterministic — no dependency on
// the child's PATH to resolve the interpreter), and a minimal allow-listed env built
// once. The spawned handler NEVER sees the server's secrets (process.env is not
// passed). node = the server's own binary; python3/bash = standard fleet paths.
const PYTHON3_BIN = "/usr/bin/python3";
const BASH_BIN = "/bin/bash";
const HANDLER_ENV = buildHandlerEnv(process.env, {
  path: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
});
// Resource jail (rlimit): the handler runs in its own transient cgroup via systemd-run
// --user (sibling of this unit), so its OOM/fork-bomb/spin can't starve the server.
// systemd-run itself (the trusted wrapper) needs XDG_RUNTIME_DIR to reach the user
// manager — ensure it's present even if the service env somehow lacks it.
const SYSTEMD_RUN_BIN = "/usr/bin/systemd-run";
const SYSTEMD_RUN_ENV = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

const payToRes = resolvePayTo(process.env);
if ("error" in payToRes) {
  console.error(`X402_SERVER_FATAL payTo: ${payToRes.error}`);
  process.exit(1);
}
const PAY_TO = payToRes.payTo;

// Fail-fast on missing transactional env (like payTo above): a server that boots
// without these returns /health=200 but can NEVER settle (proxy 403→502) or load
// offerings (gateway-token 401 → empty cache → all 404). A loud restart-loop beats
// a silent healthy-but-broken server. (🟡-5)
const missingEnv = [];
if (!PROXY_SECRET) missingEnv.push("X402_PROXY_SECRET");
if (!GATEWAY_TOKEN) missingEnv.push("GATEWAY_TOKEN");
if (missingEnv.length) {
  console.error(`X402_SERVER_FATAL missing required env: ${missingEnv.join(", ")}`);
  process.exit(1);
}

// Facilitator client → OUR proxy, authenticating with the shared proxy secret
// (per-op headers, matching the proxy's X-X402-Proxy-Secret gate). CDP creds stay
// backend-side; the VM only holds this shared secret (W9 makes it per-VM later).
const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  createAuthHeaders: async () => {
    const h = { "X-X402-Proxy-Secret": PROXY_SECRET };
    return { verify: h, settle: h, supported: h, list: h };
  },
});

const offerings = new OfferingsCache();
const idem = new IdempotencyStore();

// ── offerings fetch: GET /api/agent-economy/offerings (gateway token) → core shape ──
async function fetchOfferings() {
  const res = await fetch(`${APP}/api/agent-economy/offerings`, {
    headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`offerings fetch HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.offerings) ? body.offerings : [];
}

async function refreshLoop() {
  const r = await offerings.refresh(fetchOfferings, Date.now());
  if (r === "ok") {
    // persist last-good as the RESTART cache (not source of truth)
    try {
      await writeFile(OFFERINGS_FILE, JSON.stringify(offerings.current()), "utf8");
    } catch (e) {
      log("OFFERINGS_PERSIST_WARN", String(e).slice(0, 120));
    }
  } else {
    log(`OFFERINGS_REFRESH_${r.toUpperCase()}`, offerings.status().lastError || "");
  }
}

// Hydrate from disk first (instant restart), then refresh from the API.
async function hydrate() {
  try {
    const disk = JSON.parse(await readFile(OFFERINGS_FILE, "utf8"));
    const list = Object.values(disk);
    if (Array.isArray(list) && list.length) {
      await offerings.refresh(async () => list, Date.now());
      log("OFFERINGS_HYDRATED_FROM_DISK", list.length);
    }
  } catch {
    /* no disk cache yet — fine */
  }
  await refreshLoop();
  setInterval(() => { refreshLoop().catch((e) => log("REFRESH_LOOP_ERR", String(e).slice(0, 120))); }, REFRESH_MS);
}

async function privacyOn() {
  try {
    return isPrivacyOn(await readFile(PRIVACY_FILE, "utf8"));
  } catch {
    return false; // no marker file → not in privacy mode
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > BODY_CAP) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function decodeXPayment(header) {
  try {
    return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// EIP-3009 nonce is the idempotency key (one nonce = one settlement on-chain).
function paymentNonce(payload) {
  return payload?.payload?.authorization?.nonce || payload?.payload?.signature || null;
}

// Run the agent's OWN handler on the buyer's DATA (not buyer code — that's the
// compute marketplace). Re-validate the path, then run it RESOURCE-JAILED in its own
// transient cgroup via systemd-run --user (sibling of this unit → its OOM/fork-bomb/
// spin can't starve the server), with env -i preserving the 🟡-1 minimal env.
// Channels closed: env (🟡-1) ✓ + resources (cgroup) ✓. Still open: filesystem (§7,
// Landlock — mount-ns sandboxing no-ops on this kernel) + network (§7).
// KNOWN canary trade (note for the §7 fleet pass): the systemd-run wrap adds a
// transient-unit dependency + ~50-200ms per serve; a systemd-run failure is post-settle
// → {ok:false} paid-but-not-served (recorded by idempotency, not money-loss).
function runHandler(handlerPath, inputBuf) {
  return new Promise((resolve) => {
    if (!validateHandlerPath(handlerPath)) {
      resolve({ ok: false, error: "handler_path failed allow-list re-validation" });
      return;
    }
    const abs = handlerPath.replace(/^~/, HOME);
    const ext = abs.split(".").pop();
    const interp = ext === "py" ? PYTHON3_BIN : ext === "sh" ? BASH_BIN : process.execPath;
    const args = buildHandlerSandboxArgs(interp, abs, HANDLER_ENV);
    const child = spawn(SYSTEMD_RUN_BIN, args, { stdio: ["pipe", "pipe", "pipe"], env: SYSTEMD_RUN_ENV });
    let out = Buffer.alloc(0);
    let capped = false;
    // RuntimeMaxSec (in the jail) is the primary wall-time limit — systemd kills the
    // unit, no orphan. This setTimeout is a +5s backstop only if systemd-run itself hangs.
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ ok: false, error: "handler timeout (backstop)" }); }, HANDLER_TIMEOUT_MS + 5000);
    child.stdout.on("data", (c) => {
      if (out.length + c.length > HANDLER_OUTPUT_CAP) { capped = true; child.kill("SIGKILL"); return; }
      out = Buffer.concat([out, c]);
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: `handler spawn: ${String(e).slice(0, 80)}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (capped) return resolve({ ok: false, error: "handler output exceeded cap" });
      if (code !== 0) return resolve({ ok: false, error: `handler exit ${code}` }); // incl. OOM/RuntimeMaxSec kill
      resolve({ ok: true, output: out.toString("utf8") });
    });
    // Swallow async EPIPE if the handler closes stdin before reading — the sync
    // try below only catches a synchronous throw; the stream 'error' is async and
    // would otherwise be an uncaught exception that crashes the server. (🟡-4)
    child.stdin.on("error", () => {});
    try { child.stdin.end(inputBuf); } catch { /* handler may ignore stdin */ }
  });
}

function send(res, status, obj, paid = false) {
  const headers = { "content-type": "application/json" };
  if (paid) headers["cache-control"] = "no-store, private"; // Attack III
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      const s = offerings.status();
      return send(res, 200, { ok: true, offerings: Object.keys(offerings.current()).length, cache: s });
    }
    const m = url.pathname.match(/^\/v1\/([a-z0-9][a-z0-9-]{0,63})$/);
    if (req.method !== "POST" || !m) return send(res, 404, { error: "not found" });
    const slug = m[1];

    // 1. privacy gate
    if (await privacyOn()) return send(res, 503, { error: "privacy_mode" });

    // 2. resolve offering (serve-stale ok)
    const offering = offerings.current()[slug];
    if (!offering) return send(res, 404, { error: "unknown or inactive offering" });

    const resource = `${(req.headers["x-forwarded-proto"] || "http")}://${req.headers.host}/v1/${slug}`;
    const requirements = buildPaymentRequirements(offering, {
      network: NETWORK, asset: USDC_ASSET, payTo: PAY_TO, resource, maxTimeoutSeconds: 60,
    });

    // 3. no X-PAYMENT → 402 challenge (probe path: body intentionally NOT read)
    const xpay = req.headers["x-payment"];
    if (!xpay) return send(res, 402, { x402Version: 2, accepts: [requirements], error: "payment required" }); // no top-level resource (schema wants an object; accepts[0].resource carries the URL)
    const payload = decodeXPayment(xpay);
    if (!payload) return send(res, 402, { x402Version: 2, accepts: [requirements], error: "invalid X-PAYMENT" });

    // 4. read + size-check the body BEFORE any money step (🟡-2). Cheap local buffer
    //    (≤256KB) ahead of the verify network call; verify never reads the body, so
    //    this reorder breaks nothing it depends on. No money can move for a body we
    //    can't process, and oversized junk is rejected with no CDP round-trip. Sits
    //    before the claim, so a 413 needs no claim cleanup.
    let body;
    try { body = await readBody(req); }
    catch { return send(res, 413, { error: "request body too large or unreadable" }); }

    // 5. verify (schema-correct, via @x402/core → our proxy → CDP)
    let verify;
    try { verify = await facilitator.verify(payload, requirements); }
    catch (e) { log("VERIFY_ERR", String(e).slice(0, 800)); return send(res, 502, { error: "facilitator verify failed" }); }
    if (!verify?.isValid) return send(res, 402, { x402Version: 2, accepts: [requirements], error: `payment invalid: ${verify?.invalidReason || "unknown"}` });

    // 6. idempotency claim (Attack II — concurrency gate + replay dedup). Synchronous,
    //    so concurrent same-nonce requests serialize to exactly one "fresh" → one settle.
    const nonce = paymentNonce(payload);
    if (!nonce) return send(res, 400, { error: "payment missing nonce" });
    if (idem.claim(nonce, slug, Date.now()) === "duplicate") {
      return send(res, 409, { error: "payment already claimed (replay)" }, true);
    }

    // 7. settle BEFORE serving (Attack I-A). On failure (throw OR !success) RELEASE the
    //    claim — the on-chain nonce, not this store, is the double-spend guard, so a
    //    freed nonce that ambiguously settled is caught by a later verify. On success
    //    COMMIT so replays are rejected. (🟡-3)
    let settle;
    try { settle = await facilitator.settle(payload, requirements); }
    catch (e) {
      idem.release(nonce, slug);
      log("SETTLE_ERR", String(e).slice(0, 800));
      return send(res, 502, { error: "facilitator settle failed" });
    }
    if (!settle?.success) {
      idem.release(nonce, slug);
      return send(res, 402, { x402Version: 2, accepts: [requirements], error: `settlement failed: ${settle?.errorReason || "unknown"}` });
    }
    idem.commit(nonce, slug, Date.now());
    const txHash = settle.transaction || settle.txHash || null;

    // 8. run the handler on the already-read body, return result + tx hash (no-store)
    const result = await runHandler(offering.handler_path, body);
    log("PAID_SERVE", slug, "tx", txHash, "handler", result.ok ? "ok" : result.error);
    // x402 settlement echo — the buyer reads the tx hash from this header (v2:
    // payment-response, v1: x-payment-response), base64(JSON(SettleResponse)).
    const settleHeader = Buffer.from(JSON.stringify({
      success: true, transaction: txHash, network: settle.network || NETWORK, payer: settle.payer || verify.payer || null,
    })).toString("base64");
    res.setHeader("payment-response", settleHeader);
    res.setHeader("x-payment-response", settleHeader);
    return send(res, 200, {
      ok: result.ok, slug, tx_hash: txHash, network: settle.network || NETWORK,
      payer: settle.payer || verify.payer || null,
      result: result.ok ? safeJson(result.output) : null,
      error: result.ok ? undefined : result.error,
    }, true);
  } catch (e) {
    log("SERVER_ERR", String(e).slice(0, 200));
    try { return send(res, 500, { error: "internal error" }); } catch { /* res already sent */ }
  }
});

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

await hydrate();
server.listen(PORT, () => log(`X402_SERVER_LISTENING port=${PORT} payTo=${PAY_TO} facilitator=${FACILITATOR_URL}`));
