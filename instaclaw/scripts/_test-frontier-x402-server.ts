#!/usr/bin/env tsx
/**
 * Frontier earn server — core unit tests (the money-correctness net for §6.1.1).
 *
 * Proves the deterministic heart of the per-VM x402 SELL server before any VM
 * deploy or real settlement: handler_path re-validation, payTo-from-env (never
 * the request), the privacy-mode gate, the Attack-II idempotency dedup, the
 * offerings cache serve-last-known-good policy, and the x402 v2 PaymentRequirements
 * shape. Pure — no network, no VM, no real payment.
 *
 * Run: npx tsx scripts/_test-frontier-x402-server.ts   (exit 0 = all pass)
 */
import {
  validateHandlerPath,
  validateSlug,
  resolvePayTo,
  isPrivacyOn,
  atomicUsdc,
  buildPaymentRequirements,
  buildHandlerEnv,
  HANDLER_ENV_ALLOWLIST,
  buildHandlerSandboxArgs,
  IdempotencyStore,
  OfferingsCache,
} from "../skills/frontier/scripts/x402-server-core.mjs";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ───────────────────────── handler_path re-validation ─────────────────────────
check("handler: skills/handlers .mjs ok", validateHandlerPath("~/.openclaw/skills/frontier/scripts/handlers/summarize.mjs"));
check("handler: scripts/handlers .py ok", validateHandlerPath("~/scripts/handlers/price.py"));
check("handler: .ts + .sh ok", validateHandlerPath("~/scripts/handlers/x.ts") && validateHandlerPath("~/scripts/handlers/y.sh"));
check("handler: reject path traversal (..)", !validateHandlerPath("~/scripts/handlers/../../etc/passwd.sh"));
check("handler: reject outside allow-list dir", !validateHandlerPath("~/evil/run.sh"));
check("handler: reject absolute /etc", !validateHandlerPath("/etc/passwd"));
check("handler: reject bad extension", !validateHandlerPath("~/scripts/handlers/run.exe"));
check("handler: reject uppercase/space in name", !validateHandlerPath("~/scripts/handlers/Run Me.sh"));
check("handler: reject empty / non-string", !validateHandlerPath("") && !validateHandlerPath(undefined as unknown as string));
check("handler: reject >200 chars", !validateHandlerPath("~/scripts/handlers/" + "a".repeat(220) + ".sh"));
check("slug: valid", validateSlug("price-feed") && validateSlug("a"));
check("slug: reject uppercase / leading dash / dot", !validateSlug("Price") && !validateSlug("-x") && !validateSlug("a.b"));

// ───────────────────────── payTo: env only, never request ─────────────────────────
{
  const ok = resolvePayTo({ BANKR_WALLET_ADDRESS: "0xd5cd83eb795c69186ee0ccee7fd4b53624bb771c" });
  check("payTo: valid env addr → {payTo}", "payTo" in ok && (ok as any).payTo === "0xd5cd83eb795c69186ee0ccee7fd4b53624bb771c");
  check("payTo: missing env → error", "error" in resolvePayTo({}));
  check("payTo: non-addr env → error", "error" in resolvePayTo({ BANKR_WALLET_ADDRESS: "not-an-address" }));
  check("payTo: wrong length → error", "error" in resolvePayTo({ BANKR_WALLET_ADDRESS: "0x1234" }));
  // Structural guarantee: resolvePayTo's ONLY input is env — there is no request param path to payTo.
  check("payTo: arity is (env) only — no request channel", resolvePayTo.length === 1);
}

// ───────── handler env boundary (🟡-1 — default-deny, secrets NEVER pass) ─────────
{
  const parent = {
    BANKR_API_KEY: "bk_secret", GATEWAY_TOKEN: "gt_secret", X402_PROXY_SECRET: "px_secret",
    BANKR_WALLET_ADDRESS: "0xdead", RANDOM_SECRET: "nope", NODE_OPTIONS: "--require evil",
    HOME: "/home/openclaw", LANG: "C.UTF-8", TZ: "UTC", PATH: "/parent/leaky:/usr/bin",
  };
  const env = buildHandlerEnv(parent, { path: "/node/bin:/usr/local/bin:/usr/bin:/bin" });
  // every secret-shaped parent var is structurally ABSENT (built from {}, not spread)
  for (const k of ["BANKR_API_KEY", "GATEWAY_TOKEN", "X402_PROXY_SECRET", "BANKR_WALLET_ADDRESS", "RANDOM_SECRET", "NODE_OPTIONS"]) {
    check(`handler-env: ${k} absent`, env[k] === undefined);
  }
  // PATH is the curated opt (NOT the parent's leaky PATH)
  check("handler-env: PATH is the curated opt, not parent's", env.PATH === "/node/bin:/usr/local/bin:/usr/bin:/bin");
  check("handler-env: HOME passed through", env.HOME === "/home/openclaw");
  check("handler-env: allow-listed locale passed (LANG, TZ)", env.LANG === "C.UTF-8" && env.TZ === "UTC");
  // output key set ⊆ {PATH, HOME} ∪ allow-list — nothing else can ride along
  const allowed = new Set(["PATH", "HOME", ...HANDLER_ENV_ALLOWLIST]);
  check("handler-env: NO key outside {PATH,HOME}∪allowlist", Object.keys(env).every((k) => allowed.has(k)));
  // defaults: no parent HOME → /tmp; no opts.path → standard dirs
  const d = buildHandlerEnv({}, {});
  check("handler-env: default HOME=/tmp when parent has none", d.HOME === "/tmp");
  check("handler-env: default PATH = standard dirs", d.PATH === "/usr/local/bin:/usr/bin:/bin");
  // opts.home (the sandbox jail hook) overrides
  check("handler-env: opts.home overrides (foreign-code jail hook)", buildHandlerEnv(parent, { home: "/jail/h" }).HOME === "/jail/h");
  // null/undefined parent is safe
  check("handler-env: null parent → safe (PATH+HOME only)", (() => { const e = buildHandlerEnv(undefined, {}); return e.PATH && e.HOME === "/tmp" && e.BANKR_API_KEY === undefined; })());
}

// ───────── resource jail (rlimit — systemd-run argv builder) ─────────
{
  const env = { PATH: "/node/bin:/usr/bin:/bin", HOME: "/home/openclaw", LANG: "C.UTF-8" };
  const a = buildHandlerSandboxArgs("/abs/node", "/home/openclaw/.openclaw/skills/x/scripts/handlers/h.mjs", env);
  const joined = a.join(" ");
  check("jail: --user transient service (NOT --scope)", a.includes("--user") && !a.includes("--scope"));
  check("jail: --pipe --quiet --wait --collect", a.includes("--pipe") && a.includes("--quiet") && a.includes("--wait") && a.includes("--collect"));
  check("jail: MemoryMax=256M (measured: 6× node's 42MB RSS)", a.includes("--property=MemoryMax=256M"));
  check("jail: TasksMax=64 (caps fork-bomb)", a.includes("--property=TasksMax=64"));
  check("jail: CPUQuota=100% (1 core; bounds spinner)", a.includes("--property=CPUQuota=100%"));
  check("jail: RuntimeMaxSec=20 (systemd wall-time)", a.includes("--property=RuntimeMaxSec=20"));
  check("jail: env -i then ONLY the minimal env (🟡-1 preserved under the wrap)", joined.includes("/usr/bin/env -i PATH=/node/bin:/usr/bin:/bin HOME=/home/openclaw LANG=C.UTF-8"));
  check("jail: NO secret env in the args", !/BANKR_API_KEY|GATEWAY_TOKEN|X402_PROXY_SECRET/.test(joined));
  check("jail: '--' separates opts from the command", a.includes("--"));
  check("jail: interp + handler are the final two args", a[a.length - 2] === "/abs/node" && a[a.length - 1] === "/home/openclaw/.openclaw/skills/x/scripts/handlers/h.mjs");
  // designed-OUT: footguns + this-kernel no-ops
  check("jail: NO MemoryDenyWriteExecute (would break node's V8 JIT)", !/MemoryDenyWriteExecute/.test(joined));
  check("jail: NO InaccessiblePaths/ProtectHome (silently no-op for --user here → §7 Landlock)", !/InaccessiblePaths|ProtectHome/.test(joined));
}

// ───────────────────────── privacy gate (Rule 22) ─────────────────────────
check("privacy: 'on' → true", isPrivacyOn("on"));
check("privacy: 'privacy: on\\n' → true", isPrivacyOn("privacy: on\n"));
check("privacy: 'off' → false", !isPrivacyOn("off"));
check("privacy: empty → false", !isPrivacyOn(""));
check("privacy: non-string → false", !isPrivacyOn(undefined as unknown as string));
check("privacy: 'onward' does NOT match (word-boundary)", !isPrivacyOn("onward"));

// ───────────────────────── atomic USDC + PaymentRequirements shape ─────────────────────────
check("atomic: 0.001 → '1000'", atomicUsdc(0.001) === "1000");
check("atomic: 1 → '1000000'", atomicUsdc(1) === "1000000");
check("atomic: 0.01 → '10000'", atomicUsdc(0.01) === "10000");
check("atomic: reject <= 0 / NaN", (() => { try { atomicUsdc(0); return false; } catch { return true; } })() && (() => { try { atomicUsdc(NaN); return false; } catch { return true; } })());
{
  const pr = buildPaymentRequirements(
    { slug: "price-feed", description: "ETH price", price_usdc: 0.001 },
    { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xSELLER".padEnd(42, "0"), resource: "https://1.2.3.4:8402/v1/price-feed", maxTimeoutSeconds: 60 },
  );
  check("pr: scheme exact", pr.scheme === "exact");
  check("pr: network passthrough", pr.network === "base");
  check("pr: amount AND maxAmountRequired both atomic '1000'", pr.amount === "1000" && pr.maxAmountRequired === "1000");
  check("pr: payTo is the ctx (env) value, not from offering", pr.payTo === "0xSELLER".padEnd(42, "0"));
  check("pr: asset = Base USDC", pr.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  check("pr: resource is the full endpoint url", pr.resource === "https://1.2.3.4:8402/v1/price-feed");
  check("pr: maxTimeoutSeconds present", pr.maxTimeoutSeconds === 60);
  check("pr: extra name/version (USDC EIP-712, on-chain-verified)", eq(pr.extra, { name: "USD Coin", version: "2" }));
}

// ───────────────────────── idempotency (Attack II — replay dedup) ─────────────────────────
{
  const store = new IdempotencyStore(1000); // 1s ttl
  const NONCE = "0xnonce-aaa";
  check("idem: first claim → fresh", store.claim(NONCE, "price-feed", 0) === "fresh");
  check("idem: SAME nonce+slug replay → duplicate", store.claim(NONCE, "price-feed", 5) === "duplicate");
  check("idem: same nonce DIFFERENT slug → fresh (resource-scoped)", store.claim(NONCE, "other", 5) === "fresh");
  check("idem: different nonce → fresh", store.claim("0xnonce-bbb", "price-feed", 5) === "fresh");
  check("idem: replay after TTL expiry → fresh (pruned)", store.claim(NONCE, "price-feed", 2000) === "fresh");
}

// ───────── idempotency lifecycle (🟡-3 — claim / commit / release) ─────────
{
  const s = new IdempotencyStore(1000);
  // commit keeps the nonce blocked (settle SUCCEEDED → replay must be rejected)
  check("idem-lc: claim n1 → fresh", s.claim("n1", "svc", 0) === "fresh");
  s.commit("n1", "svc", 0);
  check("idem-lc: after commit, replay → duplicate", s.claim("n1", "svc", 1) === "duplicate");

  // release frees a PENDING nonce (settle FAILED → retry allowed)
  check("idem-lc: claim n2 → fresh", s.claim("n2", "svc", 0) === "fresh");
  check("idem-lc: n2 pending, replay → duplicate", s.claim("n2", "svc", 1) === "duplicate");
  s.release("n2", "svc");
  check("idem-lc: after release, n2 → fresh (reusable)", s.claim("n2", "svc", 2) === "fresh");

  // release REFUSES to delete a COMMITTED entry (a settled nonce must stay blocked)
  check("idem-lc: claim n3 → fresh", s.claim("n3", "svc", 0) === "fresh");
  s.commit("n3", "svc", 0);
  s.release("n3", "svc"); // must be a no-op on committed
  check("idem-lc: release does NOT free a committed nonce", s.claim("n3", "svc", 1) === "duplicate");

  // release of an absent nonce is a safe no-op (no throw)
  s.release("n-absent", "svc");
  check("idem-lc: release(absent) is a safe no-op", s.size() >= 1);

  // committed entry still expires at TTL (then the on-chain nonce backstops)
  const s2 = new IdempotencyStore(1000);
  s2.claim("n4", "svc", 0);
  s2.commit("n4", "svc", 0);
  check("idem-lc: committed entry pruned after TTL → fresh", s2.claim("n4", "svc", 2000) === "fresh");

  // commit on an absent entry (e.g. pruned mid-flight) is a safe no-op
  const s3 = new IdempotencyStore(1000);
  s3.commit("n5", "svc", 0);
  check("idem-lc: commit(absent) is a safe no-op", s3.size() === 0);
}

// ───────────────────────── offerings cache: hydrate / refresh / SERVE-STALE ─────────────────────────
(async () => {
  const cache = new OfferingsCache();
  check("cache: empty before hydrate", eq(cache.current(), {}) && cache.hasData() === false);

  // hydrate ok
  const v1 = [
    { slug: "price-feed", active: true, price_usdc: 0.001, description: "v1" },
    { slug: "paused-one", active: false, price_usdc: 0.001, description: "paused" },
  ];
  check("cache: hydrate ok", (await cache.refresh(async () => v1, 100)) === "ok");
  check("cache: current() returns ACTIVE only, by slug", eq(Object.keys(cache.current()), ["price-feed"]));
  check("cache: hasData true", cache.hasData() === true);

  // successful refresh replaces
  const v2 = [{ slug: "price-feed", active: true, price_usdc: 0.002, description: "v2" }];
  check("cache: refresh replaces", (await cache.refresh(async () => v2, 200)) === "ok");
  check("cache: new price visible", cache.current()["price-feed"].price_usdc === 0.002);

  // FAILED refresh → SERVE LAST-KNOWN-GOOD (the fail-open guard)
  const res = await cache.refresh(async () => { throw new Error("API 503"); }, 300);
  check("cache: failed refresh → 'stale' (kept last-good)", res === "stale");
  check("cache: still serves last-known-good v2 after failed refresh", cache.current()["price-feed"].price_usdc === 0.002);
  check("cache: status records lastError", cache.status().lastError === "API 503");

  // failure BEFORE any successful hydrate → 'empty' (no last-good), serves {}
  const fresh = new OfferingsCache();
  check("cache: failure before hydrate → 'empty'", (await fresh.refresh(async () => { throw new Error("down"); }, 0)) === "empty");
  check("cache: empty cache serves {}", eq(fresh.current(), {}));

  // non-array response is a failure (not a poisoning)
  const c2 = new OfferingsCache();
  await c2.refresh(async () => v1, 0);
  check("cache: non-array refresh → stale, keeps good", (await c2.refresh(async () => (null as unknown as any[]), 1)) === "stale" && Object.keys(c2.current()).length === 1);

  console.log(`\nfrontier-x402-server: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
