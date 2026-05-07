function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function key(): string { return `spend:${todayUtc()}`; }

export async function getDailySpend(kv: KVNamespace): Promise<number> {
  const v = await kv.get(key());
  return v ? parseFloat(v) : 0;
}

export async function recordSpend(kv: KVNamespace, costUsd: number): Promise<number> {
  const cur = await getDailySpend(kv);
  const next = cur + costUsd;
  await kv.put(key(), String(next), { expirationTtl: 60 * 60 * 26 });
  return next;
}

export async function isOverCeiling(kv: KVNamespace, ceilingUsd: number): Promise<boolean> {
  return (await getDailySpend(kv)) > ceilingUsd;
}
