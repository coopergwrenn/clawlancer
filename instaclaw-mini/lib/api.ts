import { signProxyToken } from "./auth";

const INSTACLAW_API =
  process.env.INSTACLAW_API_URL || "https://instaclaw.io";

/**
 * Proxy a request to instaclaw.io with per-user auth.
 * Used for write operations (provisioning, config changes, credit additions).
 * Read operations go directly to Supabase for instant response.
 */
export async function proxyToInstaclaw(
  path: string,
  userId: string,
  options: RequestInit = {}
): Promise<Response> {
  const proxyToken = await signProxyToken(userId);

  return fetch(`${INSTACLAW_API}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      "X-Mini-App-Token": proxyToken,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Fetch current WLD/USD price from CoinGecko. Cached for 5 minutes.
 */
let wldPriceCache: { price: number; fetchedAt: number } | null = null;

export async function getWldUsdPrice(): Promise<number> {
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  if (wldPriceCache && Date.now() - wldPriceCache.fetchedAt < CACHE_TTL) {
    return wldPriceCache.price;
  }

  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=worldcoin-wld&vs_currencies=usd",
      { next: { revalidate: 300 } }
    );
    const data = await res.json();
    const price = data?.["worldcoin-wld"]?.usd ?? 0.3;
    wldPriceCache = { price, fetchedAt: Date.now() };
    return price;
  } catch {
    return wldPriceCache?.price ?? 0.3; // fallback
  }
}
