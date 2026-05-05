export interface Limits { perMinute: number; perDay: number; }
export interface Result { ok: boolean; reason?: "per_minute" | "per_day"; retryAfterSec?: number; }

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function currentMinute(): string {
  const d = new Date();
  return `${d.toISOString().slice(0, 16)}`; // YYYY-MM-DDTHH:MM
}

async function incrCounter(kv: KVNamespace, key: string, ttlSec: number): Promise<number> {
  const cur = parseInt((await kv.get(key)) ?? "0", 10);
  const next = cur + 1;
  await kv.put(key, String(next), { expirationTtl: ttlSec });
  return next;
}

export async function checkAndIncrement(
  kv: KVNamespace,
  ip: string,
  limits: Limits,
): Promise<Result> {
  const day = todayUtc();
  const min = currentMinute();
  const dayKey = `rl:day:${ip}:${day}`;
  const minKey = `rl:min:${ip}:${min}`;

  // Increment both counters atomically-enough for our purposes.
  // KV is eventually consistent; we accept small over-shoots in exchange for simplicity.
  const minCount = await incrCounter(kv, minKey, 70);            // 70s TTL covers the minute bucket
  if (minCount > limits.perMinute) {
    return { ok: false, reason: "per_minute", retryAfterSec: 60 };
  }
  const dayCount = await incrCounter(kv, dayKey, 60 * 60 * 26);  // 26h TTL spans UTC day
  if (dayCount > limits.perDay) {
    return { ok: false, reason: "per_day", retryAfterSec: 60 * 60 };
  }
  return { ok: true };
}
