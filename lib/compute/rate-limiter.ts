/**
 * Rate Limiting for Heartbeats
 *
 * Prevents system overload by limiting heartbeats per minute.
 * Uses Upstash Redis if available, falls back to in-memory for development.
 */

// In-memory fallback for development (resets on server restart)
const memoryStore: Map<string, { count: number; expiresAt: number }> = new Map();

const MAX_HEARTBEATS_PER_MINUTE = parseInt(process.env.MAX_HEARTBEATS_PER_MINUTE || '500');

/**
 * Check if a heartbeat can be processed (rate limit not exceeded)
 */
export async function canProcessHeartbeat(): Promise<boolean> {
  const key = `heartbeats:${Math.floor(Date.now() / 60000)}`; // Per-minute bucket

  // Try Upstash Redis first
  if (process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_URL,
        token: process.env.UPSTASH_REDIS_TOKEN,
      });

      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, 120); // Expire after 2 minutes
      }

      return count <= MAX_HEARTBEATS_PER_MINUTE;
    } catch (error) {
      console.error('Redis rate limiting failed, falling back to memory:', error);
      // Fall through to memory store
    }
  }

  // In-memory fallback
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || entry.expiresAt < now) {
    memoryStore.set(key, { count: 1, expiresAt: now + 120000 });
    return true;
  }

  entry.count++;
  return entry.count <= MAX_HEARTBEATS_PER_MINUTE;
}

/**
 * Get current heartbeat count for this minute
 */
export async function getHeartbeatCount(): Promise<number> {
  const key = `heartbeats:${Math.floor(Date.now() / 60000)}`;

  if (process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_URL,
        token: process.env.UPSTASH_REDIS_TOKEN,
      });

      const count = await redis.get(key);
      return typeof count === 'number' ? count : 0;
    } catch {
      // Fall through to memory store
    }
  }

  const entry = memoryStore.get(key);
  return entry?.count || 0;
}

/**
 * Get rate limit status
 */
export async function getRateLimitStatus(): Promise<{
  current: number;
  limit: number;
  remaining: number;
  resetInSeconds: number;
}> {
  const current = await getHeartbeatCount();
  const remaining = Math.max(0, MAX_HEARTBEATS_PER_MINUTE - current);
  const resetInSeconds = 60 - (Math.floor(Date.now() / 1000) % 60);

  return {
    current,
    limit: MAX_HEARTBEATS_PER_MINUTE,
    remaining,
    resetInSeconds,
  };
}

/**
 * Rate limit for specific agent (prevent single agent from dominating)
 */
export async function canAgentProcess(agentId: string, maxPerMinute: number = 6): Promise<boolean> {
  const key = `agent:${agentId}:${Math.floor(Date.now() / 60000)}`;

  if (process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) {
    try {
      const { Redis } = await import('@upstash/redis');
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_URL,
        token: process.env.UPSTASH_REDIS_TOKEN,
      });

      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, 120);
      }

      return count <= maxPerMinute;
    } catch {
      // Fall through to memory store
    }
  }

  // In-memory fallback
  const now = Date.now();
  const entry = memoryStore.get(key);

  if (!entry || entry.expiresAt < now) {
    memoryStore.set(key, { count: 1, expiresAt: now + 120000 });
    return true;
  }

  entry.count++;
  return entry.count <= maxPerMinute;
}

/**
 * Clean up expired entries from memory store (call periodically)
 */
export function cleanupMemoryStore(): void {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt < now) {
      memoryStore.delete(key);
    }
  }
}

// Clean up every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupMemoryStore, 5 * 60 * 1000);
}
