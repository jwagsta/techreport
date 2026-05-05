export function makeMockKV() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    async get(key: string) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt && Date.now() > e.expiresAt) { store.delete(key); return null; }
      return e.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, {
        value,
        expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
      });
    },
    async delete(key: string) { store.delete(key); },
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, any> };
}
